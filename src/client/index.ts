// Entry point for the Code Agents Web CLI frontend bundle
// esbuild bundles this into dist/public/app.bundle.js

import { App } from './app';
import { registerServiceWorker } from './ui/service-worker';
import { purgeLegacySessionBrowserState } from './session-browser-storage';

document.addEventListener('DOMContentLoaded', () => {
  purgeLegacySessionBrowserState();
  const app = new App();
  (window as any).app = app;
  app.startHeartbeat();
});

// Outside the DOMContentLoaded handler on purpose: it waits for `load` itself,
// and registering must not depend on the app having constructed successfully.
registerServiceWorker();
