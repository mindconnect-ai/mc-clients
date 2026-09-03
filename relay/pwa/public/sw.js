// App-shell cache plus a generic push handler. FCM's own background
// delivery arrives as a `push` event here once firebase-config.js is
// filled in — the connector sends `notification` payloads, which the
// browser shows on its own; this handler covers data-only messages.
const CACHE = 'mc-shell-v4';
const SHELL = ['./', 'index.html', 'app.css', 'app.js', 'relay-client.js',
  'rtdb-client.js', 'client-common.js', 'push-setup.js', 'firebase-config.js',
  'md.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-180.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
});

// Network first, cache as the dead-spot fallback.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request)));
});

self.addEventListener('push', (e) => {
  const payload = e.data?.json() ?? {};
  if (payload.notification) return; // browser shows these itself
  e.waitUntil(self.registration.showNotification(
      payload.data?.title ?? 'MindConnect',
      { body: payload.data?.body ?? '', data: payload.data ?? {} }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(clients.openWindow('./'));
});
