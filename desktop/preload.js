'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Runs before the document's early theme script. `additionalArguments` is
// supplied only by the main process after it has whitelisted the legacy
// LevelDB values.
const argument = process.argv.find((value) => value.startsWith('--cc-web-legacy-preferences='));
if (argument) {
  try {
    const encoded = argument.slice('--cc-web-legacy-preferences='.length);
    const preferences = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    for (const [key, value] of Object.entries(preferences)) {
      if (typeof value === 'string' && localStorage.getItem(key) === null) localStorage.setItem(key, value);
    }
  } catch {
    // A corrupt or unavailable legacy store must never prevent startup.
  }
}

const CHANNELS = Object.freeze({
  snapshot: 'desktop-update:get-snapshot',
  state: 'desktop-update:state',
  defer: 'desktop-update:defer',
  install: 'desktop-update:install',
  retry: 'desktop-update:retry',
  rendererReady: 'desktop-update:renderer-ready',
  promptDelivered: 'desktop-update:prompt-delivered',
});

// This is intentionally not another renderer capability. The trusted app
// bundle emits the event only after React has committed and updater hydration
// has settled; main uses it to prove a Flatpak relaunch reached a usable UI.
let rendererUsable = false;
let pendingAutomaticPrompt = null;

function automaticPromptVersion(state) {
  if (!state || typeof state !== 'object' || state.prompt !== 'automatic'
    || state.phase !== 'available' || typeof state.targetVersion !== 'string') return null;
  return state.targetVersion;
}

function acknowledgeObservedState(state) {
  pendingAutomaticPrompt = automaticPromptVersion(state);
  if (!rendererUsable || !pendingAutomaticPrompt) return;
  ipcRenderer.send(CHANNELS.promptDelivered, pendingAutomaticPrompt);
  pendingAutomaticPrompt = null;
}

window.addEventListener('cc-web:desktop-renderer-ready', () => {
  rendererUsable = true;
  ipcRenderer.send(CHANNELS.rendererReady);
  if (pendingAutomaticPrompt) {
    ipcRenderer.send(CHANNELS.promptDelivered, pendingAutomaticPrompt);
    pendingAutomaticPrompt = null;
  }
}, { once: true });

const desktopUpdates = Object.freeze({
  getSnapshot: async () => {
    const state = await ipcRenderer.invoke(CHANNELS.snapshot);
    acknowledgeObservedState(state);
    return state;
  },
  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('Desktop update listener must be a function.');
    const receive = (_event, state) => {
      listener(state);
      // A bare webContents.send() has no delivery acknowledgement. Record the
      // once-per-version prompt only after the trusted renderer callback has
      // actually observed it, and after React has committed at least once.
      acknowledgeObservedState(state);
    };
    ipcRenderer.on(CHANNELS.state, receive);
    return () => ipcRenderer.removeListener(CHANNELS.state, receive);
  },
  defer: (expectedVersion) => ipcRenderer.invoke(CHANNELS.defer, expectedVersion),
  install: (expectedVersion) => ipcRenderer.invoke(CHANNELS.install, expectedVersion),
  retry: (expectedVersion) => ipcRenderer.invoke(CHANNELS.retry, expectedVersion),
});

contextBridge.exposeInMainWorld('desktopUpdates', desktopUpdates);
