'use strict';

const { desktopPermissionAllowed } = require('./lib.js');

/**
 * Permissions granted to the desktop renderer.
 *
 * Native file inputs and drag-and-drop do not need a Chromium permission
 * grant, so general filesystem access stays out of this allow-list. Clipboard
 * access is scoped to the exact controller origin for xterm's explicit
 * copy/paste shortcuts; remote or embedded content remains denied.
 */
function rendererPermissionAllowed(permission, requestingOrigin, trustedOrigin) {
  return desktopPermissionAllowed(permission, requestingOrigin, trustedOrigin);
}

function installRendererSessionPolicy(ses, trustedOrigin) {
  ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin) =>
    rendererPermissionAllowed(permission, requestingOrigin, trustedOrigin));
  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestingOrigin = details?.requestingUrl || webContents.getURL();
    callback(rendererPermissionAllowed(permission, requestingOrigin, trustedOrigin));
  });
}

module.exports = {
  installRendererSessionPolicy,
  rendererPermissionAllowed,
};
