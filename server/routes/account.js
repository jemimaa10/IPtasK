import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { one, all, run } from '../db.js';
import crypto from 'node:crypto';
import {
  createSession, destroySession, destroyAllSessions, sessionToken, requireAuth, publicUser,
} from '../auth.js';
import { avatarUpload, removeFile, AVATAR_DIR } from '../uploads.js';
import { attemptLimiter, tooManyAttempts } from '../security.js';
import { userStats } from '../stats.js';

const router = Router();
const USERNAME_RE = /^[a-zA-Z0-9_.]{3,20}$/;

// Failed logins: 5 per username+IP and 30 per IP every 15 minutes. Sign-ups: 10 per IP per hour.
const loginByAccount = attemptLimiter({ max: 5, windowMs: 15 * 60_000 });
const loginByIp = attemptLimiter({ max: 30, windowMs: 15 * 60_000 });
const signupByIp = attemptLimiter({ max: 10, windowMs: 60 * 60_000 });

// No 0/O/1/I/L so the code is easy to copy by hand.
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newRecoveryCode() {
  const chars = Array.from(crypto.randomBytes(12), (b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8).join('')}`;
}
const normalizeRecovery = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

router.post('/auth/register', (req, res) => {
  const wait = signupByIp.blockedFor(req.ip);
  if (wait) return tooManyAttempts(res, wait);
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Username must be 3–20 characters: letters, numbers, _ or .' });
  }
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (one('SELECT 1 FROM users WHERE username = ?', username)) {
    return res.status(409).json({ error: 'That username is already taken.' });
  }
  const info = run(
    'INSERT INTO users (username, password_hash, display_name, created_at) VALUES (?, ?, ?, ?)',
    username, bcrypt.hashSync(password, 10), username, Date.now()
  );
  signupByIp.fail(req.ip); // counts every sign-up, not only failures
  const user = one('SELECT * FROM users WHERE id = ?', info.lastInsertRowid);
  createSession(res, user.id);
  res.json({ user: publicUser(user) });
});

router.post('/auth/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const accountKey = `${username.toLowerCase()}|${req.ip}`;
  const wait = Math.max(loginByAccount.blockedFor(accountKey), loginByIp.blockedFor(req.ip));
  if (wait) return tooManyAttempts(res, wait);

  const user = one('SELECT * FROM users WHERE username = ?', username);
  if (!user || !bcrypt.compareSync(String(req.body.password || ''), user.password_hash)) {
    loginByAccount.fail(accountKey);
    loginByIp.fail(req.ip);
    return res.status(401).json({ error: 'Wrong username or password.' });
  }
  loginByAccount.reset(accountKey);
  createSession(res, user.id);
  res.json({ user: publicUser(user) });
});

router.post('/auth/logout', (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

// Forgot password: username + the recovery code the user saved from their profile.
router.post('/auth/recover', (req, res) => {
  const username = String(req.body.username || '').trim();
  const accountKey = `recover|${username.toLowerCase()}|${req.ip}`;
  const wait = Math.max(loginByAccount.blockedFor(accountKey), loginByIp.blockedFor(req.ip));
  if (wait) return tooManyAttempts(res, wait);

  const next = String(req.body.password || '');
  if (next.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  const user = one('SELECT * FROM users WHERE username = ?', username);
  if (!user?.recovery_hash || !bcrypt.compareSync(normalizeRecovery(req.body.code), user.recovery_hash)) {
    loginByAccount.fail(accountKey);
    loginByIp.fail(req.ip);
    return res.status(400).json({ error: 'That username and recovery code do not match.' });
  }
  loginByAccount.reset(accountKey);
  // The code is single-use: the user makes a new one from their profile afterwards.
  run('UPDATE users SET password_hash = ?, recovery_hash = NULL WHERE id = ?', bcrypt.hashSync(next, 10), user.id);
  destroyAllSessions(user.id);
  createSession(res, user.id);
  res.json({ user: publicUser(user) });
});

router.get('/auth/me', requireAuth, (req, res) =>
  res.json({ user: publicUser(req.user), hasRecoveryCode: Boolean(req.user.recovery_hash) })
);

router.post('/me/recovery-code', requireAuth, (req, res) => {
  if (!bcrypt.compareSync(String(req.body.password || ''), req.user.password_hash)) {
    return res.status(400).json({ error: 'Password is wrong.' });
  }
  const code = newRecoveryCode();
  run('UPDATE users SET recovery_hash = ? WHERE id = ?', bcrypt.hashSync(normalizeRecovery(code), 10), req.user.id);
  res.json({ code });
});

router.get('/me/stats', requireAuth, (req, res) => res.json(userStats(req.user.id)));

router.patch('/me', requireAuth, (req, res) => {
  const displayName = String(req.body.displayName || '').trim();
  if (displayName.length < 1 || displayName.length > 40) {
    return res.status(400).json({ error: 'Display name must be 1–40 characters.' });
  }
  run('UPDATE users SET display_name = ? WHERE id = ?', displayName, req.user.id);
  res.json({ user: publicUser(one('SELECT * FROM users WHERE id = ?', req.user.id)) });
});

router.patch('/me/password', requireAuth, (req, res) => {
  if (!bcrypt.compareSync(String(req.body.current || ''), req.user.password_hash)) {
    return res.status(400).json({ error: 'Current password is wrong.' });
  }
  const next = String(req.body.next || '');
  if (next.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  run('UPDATE users SET password_hash = ? WHERE id = ?', bcrypt.hashSync(next, 10), req.user.id);
  destroyAllSessions(req.user.id, sessionToken(req)); // other devices are logged out
  res.json({ ok: true });
});

router.post('/me/avatar', requireAuth, avatarUpload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose an image first.' });
  removeFile(AVATAR_DIR, req.user.avatar_path);
  run('UPDATE users SET avatar_path = ? WHERE id = ?', req.file.filename, req.user.id);
  res.json({ user: publicUser(one('SELECT * FROM users WHERE id = ?', req.user.id)) });
});

router.delete('/me/avatar', requireAuth, (req, res) => {
  removeFile(AVATAR_DIR, req.user.avatar_path);
  run('UPDATE users SET avatar_path = NULL WHERE id = ?', req.user.id);
  res.json({ user: publicUser(one('SELECT * FROM users WHERE id = ?', req.user.id)) });
});

router.get('/users/search', requireAuth, (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ users: [] });
  const rows = all(
    `SELECT * FROM users WHERE (username LIKE ? OR display_name LIKE ?) AND id != ? ORDER BY username LIMIT 8`,
    `%${q}%`, `%${q}%`, req.user.id
  );
  res.json({ users: rows.map(publicUser) });
});

// ---------- notifications ----------

router.get('/notifications', requireAuth, (req, res) => {
  const rows = all(
    `SELECT n.*, u.username, u.display_name, u.avatar_path FROM notifications n
     LEFT JOIN users u ON u.id = n.actor_id
     WHERE n.user_id = ? ORDER BY n.id DESC LIMIT 60`,
    req.user.id
  );
  const unread = one('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND is_read = 0', req.user.id).c;
  res.json({
    unread,
    notifications: rows.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      link: n.link,
      isRead: Boolean(n.is_read),
      createdAt: n.created_at,
      actor: n.actor_id ? publicUser({ ...n, id: n.actor_id }) : null,
    })),
  });
});

router.post('/notifications/read-all', requireAuth, (req, res) => {
  run('UPDATE notifications SET is_read = 1 WHERE user_id = ?', req.user.id);
  res.json({ ok: true });
});

router.post('/notifications/:id/read', requireAuth, (req, res) => {
  run('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?', Number(req.params.id), req.user.id);
  res.json({ ok: true });
});

export default router;
