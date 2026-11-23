import { Router } from '../router.js';
import bcrypt from 'bcryptjs';
import { one, all, run } from '../db.js';
import crypto from 'node:crypto';
import {
  createSession, destroySession, destroyAllSessions, sessionToken, requireAuth, publicUser, forgetUser,
} from '../auth.js';
import { avatarUpload, saveUploads, removeFile, AVATARS } from '../uploads.js';
import { attemptLimiter, tooManyAttempts } from '../security.js';
import { userStats } from '../stats.js';

const router = Router();
const USERNAME_RE = /^[a-zA-Z0-9_.]{3,30}$/;

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

router.post('/auth/register', async (req, res) => {
  const wait = signupByIp.blockedFor(req.ip);
  if (wait) return tooManyAttempts(res, wait);
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Username must be 3–30 characters: letters, numbers, _ or .' });
  }
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (await one('SELECT 1 FROM users WHERE LOWER(username) = LOWER(?)', username)) {
    return res.status(409).json({ error: 'That username is already taken.' });
  }
  const { row: user } = await run(
    'INSERT INTO users (username, password_hash, display_name, created_at) VALUES (?, ?, ?, ?)',
    username, await bcrypt.hash(password, 10), username, Date.now()
  );
  signupByIp.fail(req.ip); // counts every sign-up, not only failures
  await createSession(res, user.id);
  res.json({ user: publicUser(user) });
});

router.post('/auth/login', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const accountKey = `${username.toLowerCase()}|${req.ip}`;
  const wait = Math.max(loginByAccount.blockedFor(accountKey), loginByIp.blockedFor(req.ip));
  if (wait) return tooManyAttempts(res, wait);

  const user = await one('SELECT * FROM users WHERE LOWER(username) = LOWER(?)', username);
  // Google-only accounts have no password (''), which never matches.
  if (!user?.password_hash || !(await bcrypt.compare(String(req.body.password || ''), user.password_hash))) {
    loginByAccount.fail(accountKey);
    loginByIp.fail(req.ip);
    return res.status(401).json({ error: 'Wrong username or password.' });
  }
  loginByAccount.reset(accountKey);
  await createSession(res, user.id);
  res.json({ user: publicUser(user) });
});

router.post('/auth/logout', async (req, res) => {
  await destroySession(req, res);
  res.json({ ok: true });
});

// Forgot password: username + the recovery code the user saved from their profile.
router.post('/auth/recover', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const accountKey = `recover|${username.toLowerCase()}|${req.ip}`;
  const wait = Math.max(loginByAccount.blockedFor(accountKey), loginByIp.blockedFor(req.ip));
  if (wait) return tooManyAttempts(res, wait);

  const next = String(req.body.password || '');
  if (next.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  const user = await one('SELECT * FROM users WHERE LOWER(username) = LOWER(?)', username);
  if (!user?.recovery_hash || !(await bcrypt.compare(normalizeRecovery(req.body.code), user.recovery_hash))) {
    loginByAccount.fail(accountKey);
    loginByIp.fail(req.ip);
    return res.status(400).json({ error: 'That username and recovery code do not match.' });
  }
  loginByAccount.reset(accountKey);
  // The code is single-use: the user makes a new one from their profile afterwards.
  await run('UPDATE users SET password_hash = ?, recovery_hash = NULL WHERE id = ?', await bcrypt.hash(next, 10), user.id);
  await destroyAllSessions(user.id);
  await createSession(res, user.id);
  res.json({ user: publicUser(user) });
});

router.get('/auth/me', requireAuth, (req, res) =>
  res.json({
    user: publicUser(req.user),
    hasRecoveryCode: Boolean(req.user.recovery_hash),
    hasPassword: Boolean(req.user.password_hash),
    google: req.user.google_sub ? { email: req.user.email } : null,
  })
);

router.post('/me/recovery-code', requireAuth, async (req, res) => {
  if (!req.user.password_hash) return res.status(400).json({ error: 'You log in with Google. Set a password first.' });
  if (!(await bcrypt.compare(String(req.body.password || ''), req.user.password_hash))) {
    return res.status(400).json({ error: 'Password is wrong.' });
  }
  const code = newRecoveryCode();
  await run('UPDATE users SET recovery_hash = ? WHERE id = ?', await bcrypt.hash(normalizeRecovery(code), 10), req.user.id);
  res.json({ code });
});

router.get('/me/stats', requireAuth, async (req, res) => res.json(await userStats(req.user.id)));

router.patch('/me', requireAuth, async (req, res) => {
  const displayName = String(req.body.displayName || '').trim();
  if (displayName.length < 1 || displayName.length > 40) {
    return res.status(400).json({ error: 'Display name must be 1–40 characters.' });
  }
  await run('UPDATE users SET display_name = ? WHERE id = ?', displayName, req.user.id);
  forgetUser(req.user.id);
  res.json({ user: publicUser(await one('SELECT * FROM users WHERE id = ?', req.user.id)) });
});

router.patch('/me/password', requireAuth, async (req, res) => {
  // Google-only accounts have no password yet, so there is nothing to confirm.
  if (req.user.password_hash && !(await bcrypt.compare(String(req.body.current || ''), req.user.password_hash))) {
    return res.status(400).json({ error: 'Current password is wrong.' });
  }
  const next = String(req.body.next || '');
  if (next.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  await run('UPDATE users SET password_hash = ? WHERE id = ?', await bcrypt.hash(next, 10), req.user.id);
  await destroyAllSessions(req.user.id, sessionToken(req)); // other devices are logged out
  res.json({ ok: true });
});

router.post('/me/avatar', requireAuth, avatarUpload.single('avatar'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose an image first.' });
  await saveUploads(AVATARS, [req.file]);
  await run('UPDATE users SET avatar_path = ? WHERE id = ?', req.file.filename, req.user.id);
  removeFile(AVATARS, req.user.avatar_path);
  forgetUser(req.user.id);
  res.json({ user: publicUser(await one('SELECT * FROM users WHERE id = ?', req.user.id)) });
});

router.delete('/me/avatar', requireAuth, async (req, res) => {
  await run('UPDATE users SET avatar_path = NULL WHERE id = ?', req.user.id);
  removeFile(AVATARS, req.user.avatar_path);
  forgetUser(req.user.id);
  res.json({ user: publicUser(await one('SELECT * FROM users WHERE id = ?', req.user.id)) });
});

router.get('/users/search', requireAuth, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ users: [] });
  const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`; // a typed % or _ matches itself
  const rows = await all(
    `SELECT * FROM users WHERE (username ILIKE ? OR display_name ILIKE ?) AND id != ? ORDER BY username LIMIT 8`,
    like, like, req.user.id
  );
  res.json({ users: rows.map(publicUser) });
});

// ---------- notifications ----------

router.get('/notifications', requireAuth, async (req, res) => {
  const rows = await all(
    `SELECT n.*, u.username, u.display_name, u.avatar_path FROM notifications n
     LEFT JOIN users u ON u.id = n.actor_id
     WHERE n.user_id = ? ORDER BY n.id DESC LIMIT 60`,
    req.user.id
  );
  const unread = (await one('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND is_read = 0', req.user.id)).c;
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

router.post('/notifications/read-all', requireAuth, async (req, res) => {
  await run('UPDATE notifications SET is_read = 1 WHERE user_id = ?', req.user.id);
  res.json({ ok: true });
});

router.post('/notifications/:id/read', requireAuth, async (req, res) => {
  await run('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?', Number(req.params.id), req.user.id);
  res.json({ ok: true });
});

export default router;
