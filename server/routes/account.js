import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { one, all, run } from '../db.js';
import { createSession, destroySession, requireAuth, publicUser } from '../auth.js';
import { avatarUpload, removeFile, AVATAR_DIR } from '../uploads.js';

const router = Router();
const USERNAME_RE = /^[a-zA-Z0-9_.]{3,20}$/;

router.post('/auth/register', (req, res) => {
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
  const user = one('SELECT * FROM users WHERE id = ?', info.lastInsertRowid);
  createSession(res, user.id);
  res.json({ user: publicUser(user) });
});

router.post('/auth/login', (req, res) => {
  const user = one('SELECT * FROM users WHERE username = ?', String(req.body.username || '').trim());
  if (!user || !bcrypt.compareSync(String(req.body.password || ''), user.password_hash)) {
    return res.status(401).json({ error: 'Wrong username or password.' });
  }
  createSession(res, user.id);
  res.json({ user: publicUser(user) });
});

router.post('/auth/logout', (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

router.get('/auth/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

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
