'use strict';

/**
 * Electron Builder calls this after macOS signing.  The release workflow
 * supplies a short-lived API-key file in APPLE_API_KEY; local builds remain
 * possible without credentials. Release CI requests notarization only when a
 * complete macOS signing identity is configured.
 */
exports.default = async function notarizeAfterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const required = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    if (process.env.CODE_AGENTS_WEBCLI_REQUIRE_NOTARIZATION === 'true') {
      throw new Error(`macOS notarization requires ${missing.join(', ')}`);
    }
    console.warn('Skipping macOS notarization for this non-release build.');
    return;
  }

  const { notarize } = require('@electron/notarize');
  await notarize({
    appPath: `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`,
    appleApiKey: process.env.APPLE_API_KEY,
    appleApiKeyId: process.env.APPLE_API_KEY_ID,
    appleApiIssuer: process.env.APPLE_API_ISSUER,
  });
};
