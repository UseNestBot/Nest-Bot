/** Makes Nest's web app installable ("Add to Home Screen"), which iOS requires for push notifications. */
export function webManifest(): string {
  return JSON.stringify({
    name: 'Nest',
    short_name: 'Nest',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#ffffff',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  });
}

/**
 * Shows pushes from the PC and opens the conversation when one is tapped. It
 * caches nothing: the app only works while the PC is reachable anyway.
 */
export const SERVICE_WORKER = `
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'Nest', body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(data.title || 'Nest', {
    body: data.body || '',
    tag: data.conversationId || 'nest',
    renotify: true,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { conversationId: data.conversationId || null },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const id = event.notification.data && event.notification.data.conversationId;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = all.find((c) => new URL(c.url).origin === self.location.origin);
    if (client) {
      await client.focus();
      if (id) client.postMessage({ type: 'open-conversation', conversationId: id });
      return;
    }
    await self.clients.openWindow(id ? '/?c=' + encodeURIComponent(id) : '/');
  })());
});
`;
