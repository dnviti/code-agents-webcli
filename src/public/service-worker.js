// The placeholder below is substituted by scripts/build.js with the commit
// this bundle was built from. Without it the cache name never changes, so
// after a self-update the activate handler would go on serving the previous
// client against the new server.
const CACHE_NAME = 'code-agents-webcli-__BUILD_ID__';
const urlsToCache = [
  '/',
  '/index.html',
  '/app.bundle.js',
  '/css/main.css',
  '/manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(urlsToCache))
      .catch((error) => {
        console.error('Failed to cache resources:', error);
      }),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => Promise.all(
      cacheNames.map((cacheName) => {
        if (cacheName !== CACHE_NAME) {
          return caches.delete(cacheName);
        }
        return Promise.resolve();
      }),
    )),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (
    url.pathname.startsWith('/api/')
    || url.pathname.startsWith('/auth/')
    || url.pathname.startsWith('/login')
    || request.headers.get('upgrade') === 'websocket'
  ) {
    event.respondWith(
      fetch(request).catch(() => new Response(
        JSON.stringify({ error: 'Offline - please check your connection' }),
        {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        },
      )),
    );
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.status === 200 && request.method === 'GET') {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, responseToCache);
          });
        }
        return response;
      })
      .catch(() => caches.match(request).then(async (response) => {
        if (response) {
          return response;
        }

        if (request.mode === 'navigate') {
          // caches.match resolves to undefined on a miss, and respondWith()
          // with undefined surfaces as a network error rather than the shell.
          const shell = await caches.match('/index.html');
          if (shell) {
            return shell;
          }
          return new Response(
            '<h1>Offline</h1><p>This app is not available offline yet.</p>',
            { status: 503, headers: { 'Content-Type': 'text/html' } },
          );
        }

        return new Response('Resource not available offline', { status: 404 });
      })),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

/**
 * Acting on a conversation notification.
 *
 * The page shows these through this worker rather than through its own
 * `new Notification`, because that constructor throws outright on Android
 * Chrome — the phone case the feature exists for. The cost is that the click
 * arrives here, in a worker that cannot switch tabs and may have no page at
 * all, so this does the two things only a worker can: bring an existing window
 * forward and tell it which conversation to open, or open one at a URL that
 * says the same thing.
 *
 * `includeUncontrolled` matters on the first load after an update, when the
 * page that raised the notification is not yet claimed by this worker and would
 * otherwise be invisible here — the click would open a second window over the
 * one already showing the conversation.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const sessionId = (event.notification.data && event.notification.data.sessionId) || '';

  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      try {
        await client.focus();
      } catch {
        // Some platforms refuse to focus without a very recent gesture; the
        // message below still puts the right conversation on screen.
      }
      client.postMessage({ type: 'cc-web-open-conversation', sessionId });
      return;
    }

    await self.clients.openWindow(
      sessionId ? `/?conversation=${encodeURIComponent(sessionId)}` : '/',
    );
  })());
});
