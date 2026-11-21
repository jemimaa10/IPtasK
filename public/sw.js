// IPtasK service worker: makes the app installable, keeps the shell available offline,
// and opens the right screen when a notification is clicked.
const CACHE = 'iptask-v2';
const SHELL = ['/app', '/css/base.css', '/css/app.css', '/favicon.svg', '/icon.svg', '/manifest.webmanifest', '/brand/mascot.svg', '/brand/mascot-dark.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== location.origin) return;
  // Live data and private files always go to the network.
  if (/^\/(api|socket\.io|uploads)\//.test(url.pathname)) return;

  // Network first, so a deploy shows up on the next load; cache is the offline fallback.
  event.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      })
      .catch(async () => (await caches.match(request)) || (request.mode === 'navigate' ? caches.match('/app') : Response.error()))
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = event.notification.data?.link || '#/home';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const client = list.find((c) => new URL(c.url).pathname === '/app');
      if (client) {
        client.postMessage({ type: 'navigate', link });
        return client.focus();
      }
      return self.clients.openWindow(`/app${link}`);
    })
  );
});
