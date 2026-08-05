'use strict';

/**
 * Permissions granted to the desktop renderer.
 *
 * Native file inputs, drag-and-drop, and a user-triggered paste event do not
 * need a Chromium permission grant. Keeping them out of this allow-list is
 * intentional: it lets those gestures work without giving the renderer
 * programmatic clipboard access or a general filesystem capability.
 */
function rendererPermissionAllowed(permission, requestingOrigin, trustedOrigin) {
  let origin = '';
  try {
    origin = requestingOrigin ? new URL(requestingOrigin).origin : '';
  } catch {
    return false;
  }
  return permission === 'notifications' && origin === trustedOrigin;
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
