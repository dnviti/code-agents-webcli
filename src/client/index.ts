// Entry point for the Code Agents Web CLI frontend bundle
// esbuild bundles this into dist/public/app.bundle.js

import { App } from './app';

document.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  (window as any).app = app;
  app.startHeartbeat();
});
