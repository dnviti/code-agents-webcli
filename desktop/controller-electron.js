'use strict';

const crypto = require('node:crypto');

const CHROMIUM_DEFAULT = -3;
const CERTIFICATE_REJECTED = -2;
const CERTIFICATE_ACCEPTED = 0;
const GITHUB_ORIGIN = 'https://github.com';
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function canonicalOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('A remote HTTPS origin is required');
  let parsed;
  try { parsed = new URL(value.trim()); } catch { throw new TypeError('A remote HTTPS origin is required'); }
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
  ) {
    throw new TypeError('A remote server must be an exact HTTPS origin');
  }
  return parsed.origin;
}

function normalizeFingerprint(value) {
  if (value === undefined || value === null || value === '') return null;
  const compact = String(value).trim().replaceAll(':', '').toUpperCase();
  if (!/^[A-F0-9]{64}$/.test(compact)) throw new TypeError('Certificate approval requires a SHA-256 fingerprint');
  return compact.match(/.{2}/g).join(':');
}

function partitionForServer(serverId) {
  if (typeof serverId !== 'string' || !serverId || serverId === 'local') {
    throw new TypeError('A stable remote server id is required');
  }
  // Hashing keeps attacker-controlled ids out of Chromium partition paths while
  // retaining a deterministic, collision-resistant account boundary.
  const digest = crypto.createHash('sha256').update(serverId, 'utf8').digest('hex');
  return `persist:code-agents-controller-${digest}`;
}

function targetConfiguration(target) {
  if (!target || typeof target !== 'object') throw new TypeError('A remote server target is required');
  const id = target.id;
  const origin = canonicalOrigin(target.origin || target.address);
  const approval = target.certificateApproval || target.certificateOverride || null;
  let approvedFingerprint = null;
  if (approval && approval.enabled !== false) {
    if (!approval.origin || canonicalOrigin(approval.origin) !== origin) {
      throw new TypeError('Certificate approval must belong to the exact target origin');
    }
    approvedFingerprint = normalizeFingerprint(
      approval.fingerprint256 || approval.fingerprint,
    );
    if (!approvedFingerprint) throw new TypeError('Certificate approval requires a SHA-256 fingerprint');
  }
  return { id, origin, approvedFingerprint, target: { ...target, id, origin } };
}

function hostnameForOrigin(origin) {
  return normalizeHostname(new URL(origin).hostname);
}

function normalizeHostname(value) {
  const hostname = String(value || '').toLowerCase();
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function requestFingerprint(request) {
  const value = request?.certificate?.fingerprint256
    || request?.certificate?.fingerprint
    || request?.validatedCertificate?.fingerprint256
    || request?.validatedCertificate?.fingerprint;
  try { return normalizeFingerprint(value); } catch { return null; }
}

function createCertificateVerifyProc(getConfiguration) {
  if (typeof getConfiguration !== 'function') throw new TypeError('A certificate configuration provider is required');
  return (request, callback) => {
    const configuration = getConfiguration();
    const requestedHostname = normalizeHostname(request?.hostname);

    // Preserve Chromium validation (including Certificate Transparency) for valid
    // target certificates and for every other hostname in the partition. In
    // particular, the target pin can never make github.com trusted.
    if (requestedHostname !== hostnameForOrigin(configuration.origin)) {
      callback(CHROMIUM_DEFAULT);
      return;
    }
    if (configuration.transitioning) {
      callback(CERTIFICATE_REJECTED);
      return;
    }
    if (request.verificationResult === 'OK') {
      callback(CHROMIUM_DEFAULT);
      return;
    }

    const presented = requestFingerprint(request);
    if (
      configuration.approvedFingerprint
      && presented
      && presented === configuration.approvedFingerprint
    ) {
      callback(CERTIFICATE_ACCEPTED);
      return;
    }
    // A changed invalid certificate is rejected explicitly instead of relying on
    // its particular Chromium error. This also makes approval replacement atomic.
    callback(CERTIFICATE_REJECTED);
  };
}

function installExactTargetNetworkGuard(ses, getConfiguration) {
  if (!ses.webRequest || typeof ses.webRequest.onBeforeRequest !== 'function') return;
  ses.webRequest.onBeforeRequest((details, callback) => {
    let blocked = false;
    try {
      const parsed = new URL(details.url);
      const configuration = getConfiguration();
      const comparableOrigin = parsed.protocol === 'wss:'
        ? `https://${parsed.host}` : parsed.origin;
      blocked = (
        (parsed.protocol === 'https:' || parsed.protocol === 'wss:')
        && normalizeHostname(parsed.hostname) === hostnameForOrigin(configuration.origin)
        && (configuration.transitioning || comparableOrigin !== configuration.origin)
      );
    } catch {
      // Chromium handles malformed and non-network URLs normally.
    }
    callback(blocked ? { cancel: true } : {});
  });
}

function defaultCookiePath(pathname) {
  if (!pathname || pathname[0] !== '/' || pathname === '/') return '/';
  const lastSlash = pathname.lastIndexOf('/');
  return lastSlash <= 0 ? '/' : pathname.slice(0, lastSlash);
}

function parseSetCookie(header, requestUrl, nowSeconds = Date.now() / 1000) {
  if (typeof header !== 'string' || /[\r\n\0]/.test(header)) return null;
  let source;
  try { source = new URL(requestUrl); } catch { return null; }
  if (source.protocol !== 'https:') return null;

  const fields = header.split(';');
  const pair = fields.shift();
  const separator = pair.indexOf('=');
  if (separator <= 0) return null;
  const name = pair.slice(0, separator).trim();
  let value = pair.slice(separator + 1).trim();
  if (!COOKIE_NAME.test(name)) return null;
  if (value.startsWith('"') || value.endsWith('"')) {
    if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return null;
    value = value.slice(1, -1);
  }
  // RFC 6265 cookie-octet: printable ASCII excluding quote, comma, semicolon,
  // and backslash. Servers must percent/base64 encode other bytes.
  if (!/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/.test(value)) return null;

  const attributes = new Map();
  for (const field of fields) {
    const index = field.indexOf('=');
    const key = (index < 0 ? field : field.slice(0, index)).trim().toLowerCase();
    if (!key) continue;
    attributes.set(key, index < 0 ? true : field.slice(index + 1).trim());
  }

  let path = attributes.get('path');
  if (typeof path !== 'string' || !path.startsWith('/')) path = defaultCookiePath(source.pathname);

  // Electron turns every supplied Domain into a subdomain-capable cookie. Accept an
  // exact host spelling but intentionally omit it so the result remains host-only;
  // reject parent/sibling domains rather than widening target credentials.
  if (attributes.has('domain')) {
    const domain = String(attributes.get('domain')).trim().toLowerCase().replace(/^\.+/, '');
    if (!domain || domain.endsWith('.') || domain !== source.hostname.toLowerCase()) return null;
  }

  let expirationDate;
  let remove = false;
  if (attributes.has('max-age')) {
    const maxAgeText = String(attributes.get('max-age')).trim();
    if (!/^-?\d+$/.test(maxAgeText)) return null;
    const maxAge = Number(maxAgeText);
    if (!Number.isSafeInteger(maxAge)) return null;
    if (maxAge <= 0) remove = true;
    else expirationDate = nowSeconds + maxAge;
  } else if (attributes.has('expires')) {
    const milliseconds = Date.parse(String(attributes.get('expires')));
    if (Number.isFinite(milliseconds)) {
      expirationDate = milliseconds / 1000;
      if (expirationDate <= nowSeconds) remove = true;
    }
  }

  let sameSite;
  if (attributes.has('samesite')) {
    const normalized = String(attributes.get('samesite')).toLowerCase();
    if (normalized === 'strict') sameSite = 'strict';
    else if (normalized === 'lax') sameSite = 'lax';
    else if (normalized === 'none') sameSite = 'no_restriction';
    else return null;
  }
  if (sameSite === 'no_restriction' && !attributes.has('secure')) return null;
  if (name.startsWith('__Secure-') && !attributes.has('secure')) return null;
  if (
    name.startsWith('__Host-')
    && (!attributes.has('secure') || attributes.has('domain') || path !== '/')
  ) return null;

  const cookieUrl = new URL(source.origin);
  cookieUrl.pathname = path;
  const details = {
    url: cookieUrl.href,
    name,
    value,
    path,
    secure: attributes.has('secure'),
    httpOnly: attributes.has('httponly'),
  };
  if (expirationDate !== undefined) details.expirationDate = expirationDate;
  if (sameSite !== undefined) details.sameSite = sameSite;
  return { details, remove };
}

function exactTargetUrl(configuration, origin, url) {
  if (origin !== configuration.origin) throw new TypeError('Cookie access crossed its server boundary');
  let parsed;
  try { parsed = new URL(url); } catch { throw new TypeError('Cookie access requires a valid target URL'); }
  const comparableOrigin = parsed.protocol === 'wss:' ? `https://${parsed.host}` : parsed.origin;
  if (comparableOrigin !== configuration.origin || parsed.username || parsed.password) {
    throw new TypeError('Cookie access crossed its server boundary');
  }
  // Chromium's cookie API is HTTP(S)-URL based; WebSocket handshakes use the
  // equivalent HTTPS cookie scope.
  if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
  return parsed;
}

function createCookieAdapters(ses, getConfiguration, options = {}) {
  if (!ses?.cookies || typeof ses.cookies.get !== 'function') throw new TypeError('An Electron session cookie store is required');
  const now = options.now || (() => Date.now() / 1000);

  async function cookieProvider(origin, url) {
    const parsed = exactTargetUrl(getConfiguration(), origin, url);
    const cookies = await ses.cookies.get({ url: parsed.href });
    return cookies
      .filter((cookie) => cookie && typeof cookie.name === 'string' && typeof cookie.value === 'string')
      .map(({ name, value }) => ({ name, value }));
  }

  async function cookieSink(origin, headers, url) {
    const configuration = getConfiguration();
    const parsedUrl = exactTargetUrl(configuration, origin, url);
    const values = Array.isArray(headers) ? headers : [headers];
    const result = { set: 0, removed: 0, ignored: 0 };
    for (const value of values) {
      const parsed = parseSetCookie(value, parsedUrl.href, now());
      if (!parsed) {
        result.ignored += 1;
        continue;
      }
      if (parsed.remove) {
        try {
          await ses.cookies.remove(parsed.details.url, parsed.details.name);
          result.removed += 1;
        } catch {
          result.ignored += 1;
        }
      } else {
        try {
          await ses.cookies.set(parsed.details);
          result.set += 1;
        } catch {
          result.ignored += 1;
        }
      }
    }
    await ses.cookies.flushStore?.();
    return result;
  }

  return { cookieProvider, cookieSink };
}

function isAllowedOAuthNavigation(value, targetOrigin) {
  let parsed;
  try { parsed = new URL(value); } catch { return false; }
  if (parsed.username || parsed.password) return false;
  if (parsed.origin === targetOrigin) return true;
  // OAuth challenges may add organization/enterprise SSO, device verification,
  // WebAuthn, or abuse checks. Keep the boundary at GitHub's exact HTTPS origin;
  // popup denial still prevents it from opening arbitrary destinations.
  return parsed.origin === GITHUB_ORIGIN;
}

function navigationUrl(eventOrDetails, legacyUrl) {
  if (eventOrDetails && typeof eventOrDetails.url === 'string') return eventOrDetails.url;
  return typeof legacyUrl === 'string' ? legacyUrl : '';
}

function hardenOAuthWebContents(win, targetOrigin) {
  const contents = win.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const guardNavigation = (event, legacyUrl) => {
    const url = navigationUrl(event, legacyUrl);
    if (isAllowedOAuthNavigation(url, targetOrigin)) return;
    event.preventDefault();
  };
  contents.on('will-navigate', guardNavigation);
  contents.on('will-frame-navigate', guardNavigation);
  contents.on('will-redirect', guardNavigation);
  contents.on('will-attach-webview', (event) => event.preventDefault());
  return win;
}

function createHardenedOAuthWindow(options = {}) {
  const targetOrigin = canonicalOrigin(options.targetOrigin || options.origin);
  const BrowserWindow = options.BrowserWindow || options.electron?.BrowserWindow;
  if (typeof BrowserWindow !== 'function') throw new TypeError('An Electron BrowserWindow constructor is required');
  const partition = options.partition;
  if (typeof partition !== 'string' || !partition.startsWith('persist:')) {
    throw new TypeError('OAuth requires a persistent server partition');
  }
  const requested = options.browserWindowOptions || {};
  // Do not accept an existing WebContents or a preload from the caller: either one
  // would bypass the remote-content boundary before these handlers are attached.
  const { webPreferences: _ignoredWebPreferences, webContents: _ignoredWebContents, ...safeRequested } = requested;
  const win = new BrowserWindow({
    width: 560,
    height: 720,
    show: false,
    title: 'Sign in to remote server',
    ...safeRequested,
    webPreferences: {
      partition,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      devTools: false,
      experimentalFeatures: false,
      spellcheck: false,
    },
  });
  hardenOAuthWebContents(win, targetOrigin);
  return win;
}

function safeCallback(callback, value) {
  if (typeof callback !== 'function') return;
  try { callback(value); } catch { /* callback reporting must not corrupt flow state */ }
}

function createElectronControllerSessions(options = {}) {
  const electron = options.electron || null;
  const sessionModule = options.session || electron?.session;
  const BrowserWindow = options.BrowserWindow || electron?.BrowserWindow;
  if (!sessionModule || typeof sessionModule.fromPartition !== 'function') {
    throw new TypeError('Electron session.fromPartition is required');
  }
  const adapters = new Map();

  async function clearSessionData(ses) {
    await ses.closeAllConnections();
    try {
      if (typeof ses.clearData === 'function') await ses.clearData();
      else await ses.clearStorageData();
      await Promise.all([
        ses.clearAuthCache(),
        typeof ses.clearCache === 'function' ? ses.clearCache() : Promise.resolve(),
      ]);
    } finally {
      await ses.closeAllConnections();
    }
  }

  function forServer(initialTarget) {
    const initial = targetConfiguration(initialTarget);
    const existing = adapters.get(initial.id);
    if (existing) {
      if (
        existing.target.origin !== initial.origin
        || existing.approvedFingerprint !== initial.approvedFingerprint
      ) {
        throw new TypeError('Use refreshCertificateApproval(updatedTarget) to replace server trust state');
      }
      existing.updateTargetMetadata(initialTarget);
      return existing;
    }

    let configuration = initial;
    let transitioning = false;
    let revoked = false;
    const activeOAuthCancels = new Set();
    const assertActive = () => {
      if (revoked) throw new Error('This removed server session is no longer usable');
    };
    const partition = partitionForServer(initial.id);
    const ses = sessionModule.fromPartition(partition, { cache: true });
    const liveConfiguration = () => ({ ...configuration, transitioning });
    const certificateProc = createCertificateVerifyProc(liveConfiguration);
    ses.setCertificateVerifyProc(certificateProc);
    installExactTargetNetworkGuard(ses, liveConfiguration);
    ses.setPermissionCheckHandler?.(() => false);
    ses.setPermissionRequestHandler?.((_contents, _permission, callback) => callback(false));
    ses.on?.('will-download', (event) => event.preventDefault());

    const cookies = createCookieAdapters(ses, () => configuration, { now: options.now });

    async function clearServerData() {
      assertActive();
      if (transitioning) throw new Error('The server session is already changing');
      transitioning = true;
      for (const cancel of [...activeOAuthCancels]) cancel(new Error('The server session was cleared'));
      try { await clearSessionData(ses); } finally { transitioning = false; }
    }

    function updateTargetMetadata(updatedTarget) {
      assertActive();
      const updated = targetConfiguration(updatedTarget);
      if (
        updated.id !== configuration.id
        || updated.origin !== configuration.origin
        || updated.approvedFingerprint !== configuration.approvedFingerprint
      ) throw new TypeError('Target metadata cannot change server trust state');
      configuration = { ...configuration, target: updated.target };
      return api;
    }

    async function refreshCertificateApproval(updatedTarget) {
      assertActive();
      const updated = targetConfiguration(updatedTarget);
      if (updated.id !== configuration.id) throw new TypeError('Cannot replace a server partition identity');
      if (transitioning) throw new Error('The server session is already changing');
      transitioning = true;
      for (const cancel of [...activeOAuthCancels]) cancel(new Error('Server trust changed during sign-in'));
      const addressChanged = updated.origin !== configuration.origin;
      try {
        if (addressChanged) await clearSessionData(ses);
        else await ses.closeAllConnections();
        // Reset the verifier while the per-origin request guard is closed, then
        // close again before installing the new generation. Electron documents
        // verifier results as network-service cached, so replacing only the callback
        // is not a sufficient refresh boundary.
        ses.setCertificateVerifyProc(null);
        await ses.closeAllConnections();
        configuration = updated;
        // Replacing the per-session proc plus closing pooled connections avoids both a
        // process-wide certificate switch and reuse of Electron's cached connection.
        ses.setCertificateVerifyProc(createCertificateVerifyProc(liveConfiguration));
        await ses.closeAllConnections();
        return api;
      } finally {
        transitioning = false;
      }
    }

    function createOAuthWindow(windowOptions = {}) {
      assertActive();
      if (transitioning) throw new Error('Cannot sign in while the server session is changing');
      return createHardenedOAuthWindow({
        BrowserWindow: windowOptions.BrowserWindow || BrowserWindow,
        targetOrigin: configuration.origin,
        partition,
        browserWindowOptions: windowOptions.browserWindowOptions,
      });
    }

    function runOAuthFlow(flowOptions = {}) {
      assertActive();
      const checkAuthenticated = flowOptions.checkAuthenticated || options.checkAuthenticated;
      if (typeof checkAuthenticated !== 'function') {
        throw new TypeError('OAuth requires an injected checkAuthenticated(target, session) function');
      }
      const startUrl = flowOptions.url || flowOptions.startUrl || `${configuration.origin}/login`;
      const flowConfiguration = configuration;
      const parsedStartUrl = new URL(startUrl);
      if (
        parsedStartUrl.origin !== flowConfiguration.origin
        || parsedStartUrl.username
        || parsedStartUrl.password
      ) throw new TypeError('OAuth must start at the target server');
      if (flowOptions.window) throw new TypeError('Inject a BrowserWindow constructor, not an existing window');
      const win = createOAuthWindow(flowOptions);
      const contents = win.webContents;
      let sawGitHub = false;
      let checking = false;
      let settled = false;

      return new Promise((resolve) => {
        const finish = (status, value) => {
          if (settled) return;
          settled = true;
          const result = status === 'signed-in'
            ? { status, target: flowConfiguration.target, authentication: value }
            : status === 'error'
              ? { status, error: value }
              : { status };
          if (status === 'signed-in') safeCallback(flowOptions.onSignedIn, result);
          else if (status === 'error') safeCallback(flowOptions.onError, value);
          else safeCallback(flowOptions.onCancel, result);
          activeOAuthCancels.delete(cancelForTransition);
          if (!win.isDestroyed?.()) win.close?.();
          resolve(result);
        };

        const observeCommitted = async (eventOrDetails, legacyUrl) => {
          const url = navigationUrl(eventOrDetails, legacyUrl);
          let parsed;
          try { parsed = new URL(url); } catch { return; }
          if (parsed.origin === GITHUB_ORIGIN) {
            sawGitHub = true;
            return;
          }
          if (parsed.origin !== flowConfiguration.origin || !sawGitHub || checking || settled) return;
          checking = true;
          try {
            const authentication = await checkAuthenticated(flowConfiguration.target, ses);
            if (!authentication) throw new Error('The target server did not confirm authentication');
            finish('signed-in', authentication);
          } catch (error) {
            finish('error', error);
          } finally {
            checking = false;
          }
        };
        const observeRedirect = (details) => {
          let parsed;
          try { parsed = new URL(navigationUrl(details)); } catch { return; }
          if (parsed.origin === GITHUB_ORIGIN) sawGitHub = true;
        };
        const cancelForTransition = (error) => finish('error', error);
        activeOAuthCancels.add(cancelForTransition);

        contents.on('did-navigate', observeCommitted);
        // Redirect announcements can establish that the flow reached GitHub, but
        // authentication is checked only after a target navigation commits and its
        // response cookies are available.
        contents.on('did-redirect-navigation', observeRedirect);
        contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
          if (isMainFrame === false || settled || errorCode === -3) return;
          const error = Object.assign(
            new Error(errorDescription || 'The OAuth page failed to load'),
            { code: errorCode, url: validatedURL },
          );
          finish('error', error);
        });
        win.on?.('closed', () => finish('cancel'));

        Promise.resolve(contents.loadURL(startUrl)).then(() => {
          if (!settled) {
            win.show?.();
            win.focus?.();
          }
        }).catch((error) => finish('error', error));
      });
    }

    const api = Object.freeze({
      get target() { assertActive(); return { ...configuration.target }; },
      get approvedFingerprint() { assertActive(); return configuration.approvedFingerprint; },
      partition,
      get session() { assertActive(); return ses; },
      cookieProvider: async (...args) => {
        assertActive();
        if (transitioning) throw new Error('Cookie storage is unavailable while the server session is changing');
        return cookies.cookieProvider(...args);
      },
      cookieSink: async (...args) => {
        assertActive();
        if (transitioning) throw new Error('Cookie storage is unavailable while the server session is changing');
        return cookies.cookieSink(...args);
      },
      clearServerData,
      refreshCertificateApproval,
      updateTargetMetadata,
      createOAuthWindow,
      runOAuthFlow,
      revoke() {
        if (revoked) return false;
        revoked = true;
        transitioning = true;
        for (const cancel of [...activeOAuthCancels]) cancel(new Error('The server was removed'));
        return true;
      },
    });
    adapters.set(initial.id, api);
    return api;
  }

  async function clearServerData(serverId) {
    const adapter = adapters.get(serverId);
    if (adapter) await adapter.clearServerData();
    else {
      const partition = partitionForServer(serverId);
      const ses = sessionModule.fromPartition(partition, { cache: true });
      await clearSessionData(ses);
    }
    return true;
  }

  async function removeServer(serverId) {
    const adapter = adapters.get(serverId);
    if (adapter) {
      const ses = adapter.session;
      adapter.revoke();
      try {
        await clearSessionData(ses);
      } finally {
        ses.setCertificateVerifyProc(null);
        await ses.closeAllConnections();
        adapters.delete(serverId);
      }
    } else {
      await clearServerData(serverId);
    }
    return true;
  }

  async function refreshCertificateApproval(updatedTarget) {
    const existing = updatedTarget && adapters.get(updatedTarget.id);
    return existing
      ? existing.refreshCertificateApproval(updatedTarget)
      : forServer(updatedTarget);
  }

  return Object.freeze({
    forServer,
    clearServerData,
    removeServer,
    refreshCertificateApproval,
    partitionForServer,
  });
}

module.exports = {
  CERTIFICATE_ACCEPTED,
  CERTIFICATE_REJECTED,
  CHROMIUM_DEFAULT,
  GITHUB_ORIGIN,
  canonicalOrigin,
  createCertificateVerifyProc,
  createCookieAdapters,
  createElectronControllerSessions,
  createHardenedOAuthWindow,
  hardenOAuthWebContents,
  isAllowedOAuthNavigation,
  normalizeFingerprint,
  parseSetCookie,
  partitionForServer,
};
