// Service Worker do Wonner Sols — recebe push notifications do servidor
// e exibe para o usuário mesmo com o app fechado.

self.addEventListener('push', function (e) {
  var data = {};
  try { data = e.data ? e.data.json() : {}; } catch (x) {}
  e.waitUntil(
    self.registration.showNotification(data.title || 'Wonner Sols', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'wonner-aviso',
      renotify: true,
      data: { url: '/' },
    })
  );
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (cs) {
      for (var i = 0; i < cs.length; i++) {
        if ('focus' in cs[i]) return cs[i].focus();
      }
      if (clients.openWindow) return clients.openWindow('/');
    })
  );
});
