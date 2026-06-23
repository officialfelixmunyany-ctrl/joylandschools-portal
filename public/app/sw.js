const CACHE = 'daraja-shell-v12';
const SHELL_ASSETS = [
  '/app/',
  '/app/index.html',
  '/app/offline.html',
  '/app/daraja.css',
  '/app/daraja.js',
  '/vendor/lucide/lucide.min.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/uploads/')) return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response && response.ok && SHELL_ASSETS.includes(url.pathname)) {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() => {
        const fallback = event.request.mode === 'navigate' ? '/app/offline.html' : '/app/index.html';
        return caches.match(event.request).then(match => match || caches.match(fallback));
      })
  );
});

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {}

  event.waitUntil(self.registration.showNotification(data.title || 'Daraja', {
    body: data.body || '',
    icon: '/uploads/joyland/school/logo.jpg',
    badge: '/uploads/joyland/school/logo.jpg',
    tag: data.tag || 'daraja',
    renotify: true
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.openWindow('/app/'));
});
