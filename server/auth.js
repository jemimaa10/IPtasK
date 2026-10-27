import crypto from 'node:crypto';
import { one, run } from './db.js';
import { SESSION_DAYS } from './config.js';

export const COOKIE = 'iptask_session';

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const maxAge = SESSION_DAYS * 24 * 3600 * 1000;
  run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', token, userId, Date.now() + maxAge);
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', maxAge });
}

export function destroySession(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) run('DELETE FROM sessions WHERE token = ?', token);
  res.clearCookie(COOKIE);
}

export function userFromCookieHeader(header) {
  const token = parseCookies(header)[COOKIE];
  if (!token) return null;
  const row = one(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > ?`,
    token, Date.now()
  );
  return row || null;
}

export function requireAuth(req, res, next) {
  const user = userFromCookieHeader(req.headers.cookie);
  if (!user) return res.status(401).json({ error: 'Please log in first.' });
  req.user = user;
  next();
}

export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    avatarUrl: u.avatar_path ? `/uploads/avatars/${u.avatar_path}` : null,
  };
}

export function getUser(id) {
  return publicUser(one('SELECT * FROM users WHERE id = ?', id));
}
