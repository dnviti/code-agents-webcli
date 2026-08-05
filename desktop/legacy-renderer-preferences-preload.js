'use strict';

// Runs before the document's early theme script and does not expose an IPC API.
// `additionalArguments` is supplied only by the main process after it has
// whitelisted the legacy LevelDB values.
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
