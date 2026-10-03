// The board's service worker: it only shows pings as notifications (docs/specs/IDEA-12-agent-pings.md).
// It caches nothing, not even the shell, and has no fetch handler, so /api/* and every other request
// go straight to the network.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = null;
  try {
    data = event.data?.json() ?? null;
  } catch {
    /* not ours: show nothing we can't read */
  }
  if (!data || typeof data.title !== 'string') return;
  event.waitUntil(
    (async () => {
      // While the board is open and visible, it shows a toast instead of a second notification.
      const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const visible = open.filter((c) => c.visibilityState === 'visible');
      if (visible.length) {
        for (const client of visible) client.postMessage({ type: 'ping', body: data.body, url: data.url });
        return;
      }
      await self.registration.showNotification(data.title, {
        body: data.body,
        // One task is one notification: a second ping on it replaces the first.
        tag: data.tag,
        renotify: true,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-monochrome-512.png',
        data: { url: data.url },
      });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url ?? '/', self.location.origin);
  if (target.origin !== self.location.origin) return;
  event.waitUntil(
    (async () => {
      const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const client = open[0];
      if (client) {
        await client.focus();
        await client.navigate(target.href);
      } else {
        await self.clients.openWindow(target.href);
      }
    })(),
  );
});
