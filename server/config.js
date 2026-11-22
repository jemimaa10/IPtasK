import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  // Tests run with their own env (in-memory DB, no Gemini key), never the developer's .env.
  if (process.env.NODE_ENV !== 'test') process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // .env is optional; Gemini features fall back to built-in text without a key.
}

export const PORT = Number(process.env.PORT) || 3000;
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
// Comma-separated, tried in order: the first is preferred, the rest are fallbacks when it is busy or slow.
export const GEMINI_MODELS = (process.env.GEMINI_MODEL || 'gemini-3.5-flash,gemini-flash-lite-latest,gemini-3.1-flash-lite')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
export const UPLOAD_DIR = path.join(ROOT, 'uploads');
// Postgres connection string (Supabase → Connect → Session pooler). Without it, a local PGlite database is used.
export const DATABASE_URL = process.env.DATABASE_URL || '';
// Local PGlite data folder; ':memory:' is handy for tests.
export const DB_PATH = process.env.IPTASK_DB_PATH || path.join(ROOT, 'data', 'pglite');
// Supabase Storage for avatars and proof files. Without these, files go to the uploads/ folder.
export const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
export const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
export const STORAGE_BUCKET = process.env.STORAGE_BUCKET || 'iptask';
export const IS_PROD = process.env.NODE_ENV === 'production';
// Set when running behind a reverse proxy (nginx, Railway, Render…) so req.ip and HTTPS detection work.
export const TRUST_PROXY = process.env.TRUST_PROXY || (IS_PROD ? '1' : '');
// "Continue with Google" shows up only when both are set (Google Cloud Console → Credentials → OAuth client ID, Web application).
export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
// Public address of the app, e.g. https://iptask.example.com. Used for the Google redirect URI; defaults to the request's host.
export const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
// Secret for GET /api/cron/tick (serverless hosts call the scheduler from outside). Any long random string.
export const CRON_SECRET = process.env.CRON_SECRET || '';
export const SESSION_DAYS = 30;
export const SCHEDULER_INTERVAL_MS = 60_000;
