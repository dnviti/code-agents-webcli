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
            `<!doctype html><html lang="en"><head><meta charset="utf-8">
              <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
              <meta name="theme-color" content="#0a0a0a"><title>Offline · Code Agents</title>
              <style>
                :root{color-scheme:dark;--x:env(titlebar-area-x,0px);--y:env(titlebar-area-y,0px);--w:env(titlebar-area-width,100%);--h:env(titlebar-area-height,38px)}
                *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:64px 24px 24px;background:#0a0a0a;color:#fafafa;font:14px system-ui,sans-serif}
                .title{display:none;position:fixed;inset:0 0 auto;height:calc(var(--y) + var(--h));border-bottom:1px solid #262626;background:#0a0a0a}
                .brand{position:absolute;left:var(--x);top:var(--y);width:var(--w);height:var(--h);display:flex;align-items:center;padding:0 12px;font:12px ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;color:#a3a3a3;-webkit-app-region:drag;app-region:drag}
                main{width:min(420px,100%);padding:24px;border:1px solid #262626;background:#111}h1{margin:0 0 10px;font-size:22px}p{margin:0;color:#a3a3a3;line-height:1.5}
                @media(display-mode:window-controls-overlay){.title{display:block}}
              </style></head><body><div class="title" aria-hidden="true"><div class="brand">Code Agents</div></div>
              <main><h1>Offline</h1><p>Code Agents cannot reach the server. Check the connection, then reload this window.</p></main>
              <script>(function(){var o=navigator.windowControlsOverlay;if(!o)return;function s(e){var v=o.visible===true,t=document.querySelector('.title');t.style.display=v?'block':'none';if(!v)return;var r=(e&&e.titlebarAreaRect)||o.getTitlebarAreaRect(),d=document.documentElement.style;d.setProperty('--x',r.x+'px');d.setProperty('--y',r.y+'px');d.setProperty('--w',r.width+'px');d.setProperty('--h',r.height+'px')}try{o.addEventListener('geometrychange',s);s()}catch(e){}})()<\/script></body></html>`,
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
