// Avatars and proof files. Stored in Supabase Storage when SUPABASE_URL + SUPABASE_SERVICE_KEY are set
// (one private bucket; the server streams files so it can keep checking who may see them),
// otherwise in the local uploads/ folder.
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { UPLOAD_DIR, SUPABASE_URL, SUPABASE_SERVICE_KEY, STORAGE_BUCKET } from './config.js';

export const AVATARS = 'avatars';
export const PROOFS = 'proofs';
export const storageMode = SUPABASE_URL && SUPABASE_SERVICE_KEY ? 'supabase' : 'disk';

const dirFor = (kind) => path.join(UPLOAD_DIR, kind);
if (storageMode === 'disk') for (const kind of [AVATARS, PROOFS]) fs.mkdirSync(dirFor(kind), { recursive: true });

const BLOCKED_EXT = /\.(exe|bat|cmd|sh|msi|com|scr|js|html?|svg)$/i;
const rejected = (message) => Object.assign(new Error(message), { status: 400 });

/** A random, unguessable file name that keeps a safe extension. */
export function newFileName(originalName) {
  const ext = path.extname(originalName).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
  return `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
}

// Files are held in memory until the request is validated, then saved with saveUploads().
export const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    cb(/^image\/(png|jpe?g|webp|gif)$/.test(file.mimetype) ? null : rejected('Avatar must be a PNG, JPG, WEBP or GIF image.'), true),
});

export const proofUpload = multer({
  storage: multer.memoryStorage(),
  // 4 MB: serverless hosts reject request bodies over ~4.5 MB. The app shrinks photos before uploading.
  limits: { fileSize: 4 * 1024 * 1024, files: 6 },
  fileFilter: (_req, file, cb) =>
    cb(BLOCKED_EXT.test(file.originalname) ? rejected(`"${file.originalname}" is not an allowed file type.`) : null, true),
});

// ---------- Supabase Storage (REST API) ----------

function supabaseHeaders(extra = {}) {
  // Legacy service_role keys are JWTs and also go in Authorization; the newer sb_secret_… keys only use apikey.
  const auth = SUPABASE_SERVICE_KEY.startsWith('eyJ') ? { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } : {};
  return { apikey: SUPABASE_SERVICE_KEY, ...auth, ...extra };
}
const objectUrl = (kind, name) => `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${kind}/${encodeURIComponent(name)}`;

/** Creates the private bucket on first start. */
export async function initStorage() {
  if (storageMode !== 'supabase') return;
  const resp = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
    method: 'POST',
    headers: supabaseHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: STORAGE_BUCKET, name: STORAGE_BUCKET, public: false }),
  });
  if (resp.ok) return console.log(`[storage] created bucket "${STORAGE_BUCKET}"`);
  const text = await resp.text();
  if (/already exists|Duplicate/i.test(text)) return;
  throw new Error(`Supabase Storage: could not create bucket "${STORAGE_BUCKET}" (${resp.status}): ${text}`);
}

// ---------- shared API ----------

/** Saves one file's bytes under kind/name. */
export async function saveFile(kind, name, buffer, mime) {
  if (storageMode === 'disk') {
    await fs.promises.writeFile(path.join(dirFor(kind), name), buffer);
    return;
  }
  const resp = await fetch(objectUrl(kind, name), {
    method: 'POST',
    headers: supabaseHeaders({ 'Content-Type': mime || 'application/octet-stream', 'x-upsert': 'true' }),
    body: buffer,
  });
  if (!resp.ok) throw new Error(`Upload to storage failed (${resp.status}): ${await resp.text()}`);
}

/** Saves multer's in-memory files and sets file.filename on each. Removes what was saved if one fails. */
export async function saveUploads(kind, files) {
  const saved = [];
  try {
    for (const f of files) {
      f.filename = newFileName(f.originalname);
      await saveFile(kind, f.filename, f.buffer, f.mimetype);
      saved.push(f.filename);
    }
  } catch (err) {
    saved.forEach((name) => removeFile(kind, name));
    throw err;
  }
}

/** Deletes a file in the background; a missing file is fine. */
export function removeFile(kind, name) {
  if (!name) return;
  const safe = path.basename(name);
  if (storageMode === 'disk') {
    fs.rm(path.join(dirFor(kind), safe), { force: true }, () => {});
    return;
  }
  fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}`, {
    method: 'DELETE',
    headers: supabaseHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ prefixes: [`${kind}/${safe}`] }),
  }).catch((err) => console.error('[storage] delete failed:', err.message));
}

/**
 * Streams kind/name to the response (with Range support for video), after the caller has set
 * Content-Type / Content-Disposition. Sends 404 if the file is gone.
 */
export async function sendStoredFile(req, res, kind, name, { maxAge = 0 } = {}) {
  const safe = path.basename(name);
  if (maxAge) res.setHeader('Cache-Control', `private, max-age=${maxAge}`);
  if (storageMode === 'disk') {
    return res.sendFile(path.join(dirFor(kind), safe), { cacheControl: false }, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  }
  const range = req.headers.range;
  const upstream = await fetch(objectUrl(kind, safe), { headers: supabaseHeaders(range ? { Range: range } : {}) });
  if (!upstream.ok || !upstream.body) {
    if (upstream.status >= 500) console.error('[storage] read failed:', upstream.status, await upstream.text().catch(() => ''));
    return res.status(upstream.status === 416 ? 416 : 404).end();
  }
  res.status(upstream.status === 206 ? 206 : 200);
  for (const h of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const v = upstream.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
  Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
}
