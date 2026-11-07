/* Service Worker — Marges (Notifications & Rappels multi-appareils) */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/marges/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          if ('navigate' in client && targetUrl) {
            return client.navigate(targetUrl).catch(() => client);
          }
          return client;
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'MARGES_SHOW_NOTIFICATION') return;

  const title = data.title || 'Marges';
  const options = {
    body: data.body || '',
    icon: data.icon || '/marges/icon-192.png',
    badge: data.badge || '/marges/favicon-32x32.png',
    tag: data.tag || 'marges-reminder-' + Date.now(),
    renotify: true,
    data: {
      url: data.url || '/marges/',
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});
