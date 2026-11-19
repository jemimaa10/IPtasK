import { IS_PROD } from './config.js';

/**
 * In-memory limiter for failed attempts (login, password reset).
 * Fine for a single server process; resets on restart.
 */
export function attemptLimiter({ max, windowMs }) {
  const hits = new Map(); // key -> { count, resetAt }

  setInterval(() => {
    const now = Date.now();
    for (const [key, h] of hits) if (h.resetAt <= now) hits.delete(key);
  }, windowMs).unref();

  return {
    /** Milliseconds until the key may try again, or 0 if allowed. */
    blockedFor(key) {
      const h = hits.get(key);
      if (!h || h.resetAt <= Date.now()) return 0;
      return h.count >= max ? h.resetAt - Date.now() : 0;
    },
    fail(key) {
      const now = Date.now();
      const h = hits.get(key);
      if (!h || h.resetAt <= now) hits.set(key, { count: 1, resetAt: now + windowMs });
      else h.count++;
    },
    reset(key) {
      hits.delete(key);
    },
  };
}

export function tooManyAttempts(res, ms) {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  res.setHeader('Retry-After', Math.ceil(ms / 1000));
  return res.status(429).json({ error: `Too many attempts. Try again in ${minutes} minute${minutes > 1 ? 's' : ''}.` });
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // Views build markup with inline style attributes.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' ws: wss:",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function securityHeaders(_req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (IS_PROD) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
}
