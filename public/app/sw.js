const CACHE = 'daraja-f7-app-v1';

self.addEventListener('install', event => {
  self.skipWaiting();
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

  event.respondWith(
    fetch(event.request, { cache: 'no-store' })
      .then(response => response)
      .catch(() => caches.match(event.request))
  );
});

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {}

  event.waitUntil(self.registration.showNotification(data.title || 'Daraja', {
    body: data.body || '',
    icon: '/uploads/school/logo.jpg',
    badge: '/uploads/school/logo.jpg',
    tag: data.tag || 'daraja',
    renotify: true
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.openWindow('/app/'));
});
