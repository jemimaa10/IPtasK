import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  process.loadEnvFile(path.join(ROOT, '.env'));
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
export const SESSION_DAYS = 30;
export const SCHEDULER_INTERVAL_MS = 60_000;
