'use strict';

const CHANNELS = Object.freeze({
  snapshot: 'desktop-update:get-snapshot',
  state: 'desktop-update:state',
  defer: 'desktop-update:defer',
  install: 'desktop-update:install',
  retry: 'desktop-update:retry',
  rendererReady: 'desktop-update:renderer-ready',
  promptDelivered: 'desktop-update:prompt-delivered',
});

function normalizedOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
}

function isTrustedDesktopUpdateSender(event, window, expectedOrigin) {
  if (!window || window.isDestroyed?.()) return false;
  if (!event?.sender || event.sender !== window.webContents) return false;
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) return false;
  return normalizedOrigin(frame.url) === expectedOrigin;
}

function validateExpectedVersion(value) {
  if (typeof value !== 'string'
    || value.length < 1
    || value.length > 128
    || !/^[0-9A-Za-z.+_-]+$/.test(value)) {
    const error = new Error('Invalid update version.');
    error.code = 'INVALID_UPDATE_VERSION';
    throw error;
  }
  return value;
}

function registerDesktopUpdateIpc({ ipcMain, service, getWindow, getOrigin, onRendererReady }) {
  const trusted = (event) => {
    if (!isTrustedDesktopUpdateSender(event, getWindow(), getOrigin())) {
      const error = new Error('Desktop update access was denied.');
      error.code = 'DESKTOP_UPDATE_FORBIDDEN';
      throw error;
    }
  };
  const handle = (channel, action) => {
    ipcMain.handle(channel, async (event, version) => {
      trusted(event);
      return action(version);
    });
  };

  ipcMain.handle(CHANNELS.snapshot, async (event) => {
    trusted(event);
    return service.snapshot();
  });
  handle(CHANNELS.defer, (version) => service.defer(validateExpectedVersion(version)));
  handle(CHANNELS.install, (version) => service.install(validateExpectedVersion(version)));
  handle(CHANNELS.retry, (version) => service.retry(validateExpectedVersion(version)));

  const rendererReady = (event) => {
    try {
      trusted(event);
      onRendererReady?.();
    } catch (error) {
      // Fire-and-forget IPC has no rejected invocation promise to contain an
      // authorization failure. Ignore the event after a bounded code-only log
      // instead of letting a navigation race become an uncaught main error.
      console.warn('Ignored untrusted desktop renderer-ready event:', error?.code || 'forbidden');
    }
  };
  ipcMain.on(CHANNELS.rendererReady, rendererReady);

  const promptDelivered = (event, version) => {
    try {
      trusted(event);
      service.markAutomaticPromptDelivered?.(validateExpectedVersion(version));
    } catch (error) {
      // Like renderer-ready, this is a deliberately one-way acknowledgement.
      // A navigation race or untrusted frame must be contained in main.
      console.warn('Ignored untrusted desktop update prompt acknowledgement:', error?.code || 'forbidden');
    }
  };
  ipcMain.on(CHANNELS.promptDelivered, promptDelivered);

  const sendState = (state) => {
    const window = getWindow();
    if (!window || window.isDestroyed()) return;
    if (normalizedOrigin(window.webContents.getURL()) !== getOrigin()) return;
    window.webContents.send(CHANNELS.state, state);
  };
  service.on('state', sendState);

  return () => {
    service.off('state', sendState);
    ipcMain.removeListener(CHANNELS.rendererReady, rendererReady);
    ipcMain.removeListener(CHANNELS.promptDelivered, promptDelivered);
    for (const channel of [CHANNELS.snapshot, CHANNELS.defer, CHANNELS.install, CHANNELS.retry]) {
      ipcMain.removeHandler(channel);
    }
  };
}

module.exports = {
  CHANNELS,
  isTrustedDesktopUpdateSender,
  normalizedOrigin,
  registerDesktopUpdateIpc,
  validateExpectedVersion,
};
