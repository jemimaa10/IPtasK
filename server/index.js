import express from 'express';
import http from 'node:http';
import path from 'node:path';
import multer from 'multer';
import { ROOT, PORT, SCHEDULER_INTERVAL_MS, GEMINI_MODELS, TRUST_PROXY, IS_PROD } from './config.js';
import { securityHeaders } from './security.js';
import { driver, one } from './db.js';
import { initStorage, storageMode, sendStoredFile, AVATARS } from './uploads.js';
import { handle } from './router.js';
import { initRealtime } from './realtime.js';
import { runScheduler } from './missions.js';
import { aiEnabled } from './gemini.js';
import accountRoutes from './routes/account.js';
import groupRoutes from './routes/groups.js';
import missionRoutes from './routes/missions.js';
import labelRoutes from './routes/labels.js';
import googleRoutes from './routes/google.js';

await initStorage();

const app = express();
app.disable('x-powered-by');
if (TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY);
app.use(securityHeaders);
app.use(express.json({ limit: '1mb' }));

// For uptime pings (keeps a free host awake) and the host's health check. Touches the database too.
app.get('/healthz', handle(async (_req, res) => {
  await one('SELECT 1 AS ok');
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true });
}));

const PUBLIC = path.join(ROOT, 'public');
// Avatar names are random, so anyone with the URL may see it (same as before).
app.get('/uploads/avatars/:name', handle(async (req, res) => {
  const ext = path.extname(req.params.name).toLowerCase();
  const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
  if (!types[ext]) return res.status(404).end();
  res.setHeader('Content-Type', types[ext]);
  await sendStoredFile(req, res, AVATARS, req.params.name, { maxAge: 7 * 24 * 3600 });
}));
app.get('/app', (_req, res) => res.sendFile(path.join(PUBLIC, 'app.html')));
// The service worker must never be served stale, or app updates never reach installed clients.
app.get('/sw.js', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC, 'sw.js'));
});
app.use(express.static(PUBLIC));

app.use('/api', googleRoutes, accountRoutes, groupRoutes, missionRoutes, labelRoutes);
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

const server = http.createServer(app);
initRealtime(server);

server.listen(PORT, () => {
  console.log(`\n  IPtasK running at http://localhost:${PORT}`);
  console.log(`  Database: ${driver}   Files: ${storageMode === 'supabase' ? 'Supabase Storage' : 'uploads/ folder'}`);
  console.log(`  Gemini AI: ${aiEnabled() ? `enabled (${GEMINI_MODELS.join(' → ')})` : 'disabled — add GEMINI_API_KEY to .env'}\n`);
  if (IS_PROD && !driver.startsWith('postgres')) {
    console.warn('  ⚠ No DATABASE_URL: data is kept in data/pglite on local disk. On hosts without a persistent disk (Render free) it vanishes on restart.\n');
  }
  if (IS_PROD && storageMode === 'disk') {
    console.warn('  ⚠ Files are stored on local disk. On hosts without a persistent disk (Render free) they vanish on restart: set SUPABASE_URL and SUPABASE_SERVICE_KEY.\n');
  }
  runScheduler();
  setInterval(runScheduler, SCHEDULER_INTERVAL_MS);
});
