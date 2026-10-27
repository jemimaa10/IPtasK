import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { UPLOAD_DIR } from './config.js';

export const AVATAR_DIR = path.join(UPLOAD_DIR, 'avatars');
export const PROOF_DIR = path.join(UPLOAD_DIR, 'proofs');
fs.mkdirSync(AVATAR_DIR, { recursive: true });
fs.mkdirSync(PROOF_DIR, { recursive: true });

const storage = (dir) =>
  multer.diskStorage({
    destination: dir,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
      cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
    },
  });

const BLOCKED_EXT = /\.(exe|bat|cmd|sh|msi|com|scr|js|html?|svg)$/i;
const rejected = (message) => Object.assign(new Error(message), { status: 400 });

export const avatarUpload = multer({
  storage: storage(AVATAR_DIR),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    cb(/^image\/(png|jpe?g|webp|gif)$/.test(file.mimetype) ? null : rejected('Avatar must be a PNG, JPG, WEBP or GIF image.'), true),
});

export const proofUpload = multer({
  storage: storage(PROOF_DIR),
  limits: { fileSize: 15 * 1024 * 1024, files: 6 },
  fileFilter: (_req, file, cb) =>
    cb(BLOCKED_EXT.test(file.originalname) ? rejected(`"${file.originalname}" is not an allowed file type.`) : null, true),
});

export function removeFile(dir, name) {
  if (!name) return;
  fs.rm(path.join(dir, path.basename(name)), { force: true }, () => {});
}
