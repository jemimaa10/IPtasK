// "Continue with Google" (OAuth 2.0 authorization code flow, no extra dependencies).
//   GET /api/auth/google              → sign in / sign up
//   GET /api/auth/google?mode=link    → connect Google to the logged-in account (from Profile)
//   GET /api/auth/google/callback     → Google sends the user back here
import { Router } from '../router.js';
import crypto from 'node:crypto';
import { one, run } from '../db.js';
import { createSession, parseCookies, userFromCookieHeader, requireAuth } from '../auth.js';
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, PUBLIC_URL, IS_PROD } from '../config.js';

const router = Router();
const STATE_COOKIE = 'iptask_oauth';
const STATE_PATH = '/api/auth/google';
const enabled = () => Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);

const redirectUri = (req) => `${PUBLIC_URL || `${req.protocol}://${req.get('host')}`}/api/auth/google/callback`;

/** Back to the SPA, with an error the login/profile page shows once. */
function back(res, hash, error) {
  res.redirect(error ? `/app?auth_error=${encodeURIComponent(error)}${hash}` : `/app${hash}`);
}

router.get('/auth/providers', (_req, res) => res.json({ google: enabled() }));

router.get('/auth/google', async (req, res) => {
  if (!enabled()) return back(res, '#/login', 'Google sign-in is not set up on this server.');
  const mode = req.query.mode === 'link' ? 'link' : 'login';
  if (mode === 'link' && !(await userFromCookieHeader(req.headers.cookie))) return back(res, '#/login', 'Log in first.');

  const state = crypto.randomBytes(24).toString('hex');
  res.cookie(STATE_COOKIE, `${state}.${mode}`, {
    httpOnly: true, sameSite: 'lax', secure: IS_PROD, maxAge: 10 * 60_000, path: STATE_PATH,
  });
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

/** Exchanges the code for tokens and returns the verified ID token claims. */
async function googleProfile(req, code) {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(req),
      grant_type: 'authorization_code',
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.id_token) throw new Error(data.error_description || 'Google did not accept the sign-in.');
  // The ID token came straight from Google's token endpoint over TLS, so its signature need not be re-checked
  // (OpenID Connect Core 3.1.3.7); the audience, issuer and expiry still are.
  const claims = JSON.parse(Buffer.from(data.id_token.split('.')[1], 'base64url').toString('utf8'));
  if (claims.aud !== GOOGLE_CLIENT_ID) throw new Error('Google sign-in was meant for another app.');
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss)) throw new Error('Unexpected sign-in issuer.');
  if (!claims.sub || claims.exp * 1000 < Date.now()) throw new Error('Google sign-in expired. Try again.');
  return claims;
}

/** A free username from the email (or name): letters, numbers, _ and . only, 3–20 characters. */
async function freeUsername(claims) {
  let base = String(claims.email || claims.name || 'user').split('@')[0]
    .replace(/[^a-zA-Z0-9_.]/g, '').slice(0, 16);
  if (base.length < 3) base = `user${base}`;
  const taken = async (name) => Boolean(await one('SELECT 1 FROM users WHERE LOWER(username) = LOWER(?)', name));
  if (!(await taken(base))) return base;
  for (let i = 0; i < 50; i++) {
    const candidate = `${base}${crypto.randomInt(10, 9999)}`;
    if (!(await taken(candidate))) return candidate;
  }
  return `user${crypto.randomBytes(6).toString('hex')}`;
}

router.get('/auth/google/callback', async (req, res) => {
  const [state, mode] = String(parseCookies(req.headers.cookie)[STATE_COOKIE] || '').split('.');
  res.clearCookie(STATE_COOKIE, { path: STATE_PATH });
  const failTo = mode === 'link' ? '#/profile' : '#/login';
  if (req.query.error) return back(res, failTo, req.query.error === 'access_denied' ? 'Google sign-in was cancelled.' : 'Google sign-in failed.');
  const given = String(req.query.state || '');
  if (!state || given.length !== state.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(state))) {
    return back(res, failTo, 'Sign-in session expired. Try again.');
  }

  let claims;
  try {
    claims = await googleProfile(req, String(req.query.code || ''));
  } catch (err) {
    console.error('[google]', err.message);
    return back(res, failTo, err.message);
  }
  const owner = await one('SELECT * FROM users WHERE google_sub = ?', claims.sub);

  if (mode === 'link') {
    const me = await userFromCookieHeader(req.headers.cookie);
    if (!me) return back(res, '#/login', 'Log in first.');
    if (owner && owner.id !== me.id) {
      return back(res, '#/profile', `That Google account is already used by @${owner.username}.`);
    }
    await run('UPDATE users SET google_sub = ?, email = ? WHERE id = ?', claims.sub, claims.email || null, me.id);
    return back(res, '#/profile');
  }

  if (owner) {
    await createSession(res, owner.id);
    return back(res, '#/home');
  }
  // First time: make an account. They can set a password later from Profile.
  const name = String(claims.name || claims.email?.split('@')[0] || 'New user').trim().slice(0, 40);
  const info = await run(
    "INSERT INTO users (username, password_hash, display_name, google_sub, email, created_at) VALUES (?, '', ?, ?, ?, ?)",
    await freeUsername(claims), name, claims.sub, claims.email || null, Date.now()
  );
  await createSession(res, Number(info.lastInsertRowid));
  back(res, '#/profile');
});

router.post('/me/google/unlink', requireAuth, async (req, res) => {
  if (!req.user.password_hash) {
    return res.status(400).json({ error: 'Set a password first, or you will have no way to log in.' });
  }
  await run('UPDATE users SET google_sub = NULL, email = NULL WHERE id = ?', req.user.id);
  res.json({ ok: true });
});

export default router;
