// Local / always-on server: `npm start`. On Vercel, api/index.js serves the same app instead.
import http from 'node:http';
import { PORT, SCHEDULER_INTERVAL_MS, GEMINI_MODELS, IS_PROD } from './config.js';
import { driver } from './db.js';
import { initStorage, storageMode } from './uploads.js';
import { runScheduler } from './missions.js';
import { aiEnabled } from './gemini.js';
import app from './app.js';

await initStorage();

http.createServer(app).listen(PORT, () => {
  console.log(`\n  IPtasK running at http://localhost:${PORT}`);
  console.log(`  Database: ${driver}   Files: ${storageMode === 'supabase' ? 'Supabase Storage' : 'uploads/ folder'}`);
  console.log(`  Gemini AI: ${aiEnabled() ? `enabled (${GEMINI_MODELS.join(' → ')})` : 'disabled — add GEMINI_API_KEY to .env'}\n`);
  if (IS_PROD && !driver.startsWith('postgres')) {
    console.warn('  ⚠ No DATABASE_URL: data is kept in data/pglite on local disk.\n');
  }
  if (IS_PROD && storageMode === 'disk') {
    console.warn('  ⚠ Files are stored on local disk: set SUPABASE_URL and SUPABASE_SERVICE_KEY to keep them in Supabase.\n');
  }
  runScheduler();
  setInterval(runScheduler, SCHEDULER_INTERVAL_MS);
});
