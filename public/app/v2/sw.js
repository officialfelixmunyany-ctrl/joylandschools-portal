self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/app/v2')) {
    event.respondWith(Response.redirect('/app/', 302));
  }
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.openWindow('/app/'));
});
