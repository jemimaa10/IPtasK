// Phone photos are often 3–8 MB; the server accepts 4 MB per file and ~4 MB per upload.
// Big JPEG/PNG/WEBP images are scaled down to 1920 px and re-saved as JPEG before uploading.
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024; // whole request, all files together

const SHRINK_ABOVE = 1024 * 1024;
const MAX_SIDE = 1920;

export async function shrinkImage(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size <= SHRINK_ABOVE) return file;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return file;
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; // transparent PNG areas
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
  if (!blob || blob.size >= file.size) return file;
  return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg', lastModified: file.lastModified });
}

/** Shrinks what can be shrunk; returns { files } or { error } when it is still too big. */
export async function prepareUploads(files) {
  const out = await Promise.all(files.map(shrinkImage));
  const tooBig = out.find((f) => f.size > MAX_FILE_BYTES);
  if (tooBig) return { error: `"${tooBig.name}" is larger than 4 MB. Compress it or upload a smaller file.` };
  const total = out.reduce((n, f) => n + f.size, 0);
  if (total > MAX_UPLOAD_BYTES) {
    return { error: `These files add up to ${(total / 1048576).toFixed(1)} MB. The limit is 4 MB per upload: remove some, or post them in two proofs.` };
  }
  return { files: out };
}
