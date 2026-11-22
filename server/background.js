// Work that may finish after the response (AI hints, roast captions).
// On Vercel the function is frozen once the response is sent unless the promise is handed to waitUntil.
let waitUntil = null;
if (process.env.VERCEL) {
  try {
    ({ waitUntil } = await import('@vercel/functions'));
  } catch {
    // package missing: fall back to best effort
  }
}

export function background(promise, label = 'background') {
  const safe = Promise.resolve(promise).catch((err) => console.error(`[${label}]`, err?.message || err));
  waitUntil?.(safe);
  return safe;
}
