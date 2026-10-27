import express from 'express';
import http from 'node:http';
import path from 'node:path';
import multer from 'multer';
import { ROOT, PORT, SCHEDULER_INTERVAL_MS, GEMINI_MODELS } from './config.js';
import './db.js';
import { AVATAR_DIR } from './uploads.js';
import { initRealtime } from './realtime.js';
import { runScheduler } from './missions.js';
import { aiEnabled } from './gemini.js';
import accountRoutes from './routes/account.js';
import groupRoutes from './routes/groups.js';
import missionRoutes from './routes/missions.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

const PUBLIC = path.join(ROOT, 'public');
app.use('/uploads/avatars', express.static(AVATAR_DIR, { maxAge: '7d' }));
app.get('/app', (_req, res) => res.sendFile(path.join(PUBLIC, 'app.html')));
app.use(express.static(PUBLIC));

app.use('/api', accountRoutes, groupRoutes, missionRoutes);
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
  res.status(500).json({ error: 'Something went wrong.' });
});

const server = http.createServer(app);
initRealtime(server);

server.listen(PORT, () => {
  console.log(`\n  IPtasK running at http://localhost:${PORT}`);
  console.log(`  Gemini AI: ${aiEnabled() ? `enabled (${GEMINI_MODELS.join(' → ')})` : 'disabled — add GEMINI_API_KEY to .env'}\n`);
  runScheduler();
  setInterval(runScheduler, SCHEDULER_INTERVAL_MS);
});
