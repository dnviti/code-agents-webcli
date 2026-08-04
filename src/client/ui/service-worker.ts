import { showConfirm } from './confirm';

/**
 * Service-worker registration and the "a new build is waiting" prompt.
 *
 * This lived as an inline script in index.html, where the only way to ask a
 * question was `window.confirm` — the browser's own dialog, in the browser's
 * colours, which on an installed PWA looks like the page has been taken over by
 * something else. Moving it into the bundle is what lets it ask with the app's
 * own dialog instead; there is nothing here that needed to run before the
 * bundle loaded.
 */

const UPDATE_CHECK_INTERVAL_MS = 60000;

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/service-worker.js')
      .then((registration) => {
        setInterval(() => {
          void registration.update();
        }, UPDATE_CHECK_INTERVAL_MS);

        registration.addEventListener('updatefound', () => {
          const installing = registration.installing;
          if (!installing) return;

          installing.addEventListener('statechange', () => {
            // `controller` is null on the very first install, when there is no
            // previous version to replace and so nothing to ask about.
            if (installing.state !== 'installed' || !navigator.serviceWorker.controller) {
              return;
            }
            void promptForUpdate(installing);
          });
        });
      })
      .catch((error: unknown) => {
        // Registration failing costs offline support, not the app. Logged
        // rather than surfaced: there is nothing the user could do about it.
        console.warn('ServiceWorker registration failed:', error);
      });
  });
}

async function promptForUpdate(worker: ServiceWorker): Promise<void> {
  const accepted = await showConfirm({
    title: 'A new version is available',
    description:
      'Reload to update Code Agents Web CLI. Running agent sessions keep going on the server and will still be here afterwards.',
    confirmLabel: 'Reload',
    scope: 'desktop',
    cancelLabel: 'Not now',
  });

  if (!accepted) return;

  worker.postMessage({ type: 'SKIP_WAITING' });
  window.location.reload();
}
