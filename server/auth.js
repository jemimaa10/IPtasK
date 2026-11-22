import crypto from 'node:crypto';
import { one, run } from './db.js';
import { SESSION_DAYS, IS_PROD } from './config.js';

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

export async function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const maxAge = SESSION_DAYS * 24 * 3600 * 1000;
  await run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', token, userId, Date.now() + maxAge);
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: IS_PROD, maxAge });
}

export async function destroySession(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) await run('DELETE FROM sessions WHERE token = ?', token);
  res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'lax', secure: IS_PROD });
}

/** Log a user out everywhere (after a password change or reset), optionally keeping one session. */
export async function destroyAllSessions(userId, exceptToken = null) {
  await run('DELETE FROM sessions WHERE user_id = ? AND token IS DISTINCT FROM ?', userId, exceptToken);
}

export function sessionToken(req) {
  return parseCookies(req.headers.cookie)[COOKIE] || null;
}

export async function userFromCookieHeader(header) {
  const token = parseCookies(header)[COOKIE];
  if (!token) return null;
  const row = await one(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > ?`,
    token, Date.now()
  );
  return row || null;
}

export async function requireAuth(req, res, next) {
  const user = await userFromCookieHeader(req.headers.cookie);
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

// Views look up the same few users many times per request; keep their public info for a few seconds.
const userCache = new Map(); // id -> { at, user }
const USER_CACHE_MS = 10_000;

export async function getUser(id) {
  const hit = userCache.get(id);
  if (hit && Date.now() - hit.at < USER_CACHE_MS) return hit.user;
  const user = publicUser(await one('SELECT * FROM users WHERE id = ?', id));
  if (userCache.size > 5000) userCache.clear();
  userCache.set(id, { at: Date.now(), user });
  return user;
}

/** Call after changing a user's name or photo. */
export function forgetUser(id) {
  userCache.delete(id);
}
