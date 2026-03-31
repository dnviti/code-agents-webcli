const CACHE_NAME = 'code-agents-webcli-v1';
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
      .catch(() => caches.match(request).then((response) => {
        if (response) {
          return response;
        }

        if (request.mode === 'navigate') {
          return caches.match('/index.html');
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
