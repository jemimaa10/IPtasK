// The Express app, shared by the local server (server/index.js) and Vercel (api/index.js).
import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { ROOT, TRUST_PROXY, CRON_SECRET } from './config.js';
import { securityHeaders } from './security.js';
import { one } from './db.js';
import { sendStoredFile, AVATARS } from './uploads.js';
import { handle } from './router.js';
import { runScheduler } from './missions.js';
import accountRoutes from './routes/account.js';
import groupRoutes from './routes/groups.js';
import missionRoutes from './routes/missions.js';
import labelRoutes from './routes/labels.js';
import googleRoutes from './routes/google.js';
import eventRoutes from './routes/events.js';

const app = express();
app.disable('x-powered-by');
if (TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY);
app.use(securityHeaders);
app.use(express.json({ limit: '1mb' }));

// For uptime pings and the host's health check. Touches the database too.
app.get('/healthz', handle(async (_req, res) => {
  await one('SELECT 1 AS ok');
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true });
}));

/** Constant-time check of the cron secret, from "Authorization: Bearer …" (Vercel Cron) or ?key=… (cron-job.org). */
function cronAllowed(req) {
  if (!CRON_SECRET) return false;
  const given = String(req.headers.authorization?.replace(/^Bearer\s+/i, '') || req.query.key || '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(CRON_SECRET).digest();
  return crypto.timingSafeEqual(a, b);
}

// Serverless hosts have no always-running process: an outside cron calls this every few minutes
// to send reminders, close deadlines and post confessions. The local server runs it every minute by itself.
app.get('/api/cron/tick', handle(async (req, res) => {
  if (!cronAllowed(req)) return res.status(401).json({ error: 'Wrong or missing cron key.' });
  const started = Date.now();
  await runScheduler();
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, ms: Date.now() - started });
}));

const PUBLIC = path.join(ROOT, 'public');
// Avatar names are random, so anyone with the URL may see it.
app.get('/uploads/avatars/:name', handle(async (req, res) => {
  const ext = path.extname(req.params.name).toLowerCase();
  const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
  if (!types[ext]) return res.status(404).end();
  res.setHeader('Content-Type', types[ext]);
  await sendStoredFile(req, res, AVATARS, req.params.name, { maxAge: 7 * 24 * 3600 });
}));
// On Vercel these files come straight from the CDN (vercel.json); locally Express serves them.
app.get('/app', (_req, res) => res.sendFile(path.join(PUBLIC, 'app.html')));
// The service worker must never be served stale, or app updates never reach installed clients.
app.get('/sw.js', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC, 'sw.js'));
});
app.use(express.static(PUBLIC));

app.use('/api', googleRoutes, accountRoutes, groupRoutes, missionRoutes, labelRoutes, eventRoutes);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large.' : err.code === 'LIMIT_FILE_COUNT' ? 'Too many files.' : err.message;
    return res.status(400).json({ error: msg });
  }
  if (err?.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ error: err.expose === false ? 'Bad request.' : err.message });
  }
  console.error(err);
  if (res.headersSent) return res.end();
  res.status(500).json({ error: 'Something went wrong.' });
});

export default app;
