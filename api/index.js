// Vercel serverless entry: every request that is not a static file in public/ lands here (see vercel.json).
import { initStorage } from '../server/uploads.js';
import app from '../server/app.js';

await initStorage().catch((err) => console.error('[storage]', err.message));

export default app;
