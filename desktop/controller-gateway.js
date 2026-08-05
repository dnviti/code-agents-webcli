'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const WebSocket = require('ws');

const {
  parseQualifiedSessionId,
  qualifyAttachmentUrls,
  qualifyOwnedAttachment,
  qualifyServerMessage,
  qualifySessionId,
  qualifySessionList,
  resolveClientMessage,
  splitSessionsByServer,
} = require('./controller-protocol.js');

const CONTROLLER_AUTH_HEADER = 'x-code-agents-controller-auth';
const CONTROLLER_HEADER = 'x-controller-server-id';
const MAX_ROUTING_BODY = 1024 * 1024;
const MAX_AGGREGATE_BODY = 16 * 1024 * 1024;
// Keep the desktop boundary aligned with the server attachment store.  This
// is deliberately separate from MAX_ROUTING_BODY: attachment bytes are never
// routing JSON and must not be buffered just to select their owner.
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const DEFAULT_UPSTREAM_RECONNECT_MS = 5_000;
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);
const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

function json(res, statusCode, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function publicTarget(target) {
  const safe = {
    id: target.id,
    type: target.type || (target.id === 'local' ? 'local' : 'remote'),
    name: target.name,
    status: target.status || 'unknown',
    insecure: target.insecure === true || Boolean(target.certificateOverride),
    signedIn: target.id === 'local' || target.signedIn === true || target.authMarker === true,
  };
  if (target.stagedAddition === true) safe.stagedAddition = true;
  if (typeof target.origin === 'string') safe.origin = target.origin;
  if (typeof target.version === 'string') safe.version = target.version;
  if (Number.isInteger(target.protocolVersion)) safe.protocolVersion = target.protocolVersion;
  if (typeof target.certificateFingerprint === 'string') {
    safe.certificateFingerprint = target.certificateFingerprint;
  }
  if (Number.isInteger(target.runningWorkCount) && target.runningWorkCount >= 0) {
    safe.runningWorkCount = target.runningWorkCount;
  }
  if (Array.isArray(target.capabilities)) {
    safe.capabilities = target.capabilities.filter((value) => typeof value === 'string');
  }
  if (target.error) {
    safe.error = typeof target.error === 'string'
      ? { message: target.error }
      : {
          ...(typeof target.error.code === 'string' ? { code: target.error.code } : {}),
          ...(typeof target.error.message === 'string' ? { message: target.error.message } : {}),
          ...(typeof target.error.category === 'string' ? { category: target.error.category } : {}),
          ...(typeof target.error.fingerprint256 === 'string' ? { fingerprint256: target.error.fingerprint256 } : {}),
          ...(target.error.requiresRenewedApproval === true ? { requiresRenewedApproval: true } : {}),
          ...(target.error.certificate && typeof target.error.certificate === 'object'
            ? { certificate: Object.fromEntries(Object.entries(target.error.certificate).filter(([, value]) => typeof value === 'string')) }
            : {}),
        };
  }
  if (typeof target.lastSuccessfulContact === 'string' || typeof target.lastSuccessfulContact === 'number') {
    safe.lastSuccessfulContact = target.lastSuccessfulContact;
  }
  return safe;
}

function publicCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const safe = {};
  for (const key of ['id', 'name', 'serverName', 'origin', 'address', 'status', 'version', 'protocolVersion', 'compatible', 'discoveredFrom']) {
    if (['string', 'number', 'boolean'].includes(typeof candidate[key])) safe[key] = candidate[key];
  }
  if (candidate.product?.id === 'code-agents-webcli' && typeof candidate.product.name === 'string') {
    safe.product = { id: 'code-agents-webcli', name: candidate.product.name };
  }
  if (Array.isArray(candidate.capabilities)) {
    safe.capabilities = candidate.capabilities.filter((value) => typeof value === 'string');
  }
  return safe;
}

function publicActionResult(result) {
  if (result == null) return { success: true };
  if (!result || typeof result !== 'object') return { success: result === true };
  const safe = {};
  for (const key of ['success', 'removed', 'warning', 'requiresApproval', 'requiresConfirmation', 'message', 'origin']) {
    if (['string', 'boolean'].includes(typeof result[key])) safe[key] = result[key];
  }
  if (result.error) {
    safe.error = typeof result.error === 'string'
      ? { message: result.error }
      : {
          ...(typeof result.error.code === 'string' ? { code: result.error.code } : {}),
          ...(typeof result.error.message === 'string' ? { message: result.error.message } : {}),
          ...(typeof result.error.category === 'string' ? { category: result.error.category } : {}),
          ...(typeof result.error.fingerprint256 === 'string' ? { fingerprint256: result.error.fingerprint256 } : {}),
          ...(result.error.requiresRenewedApproval === true ? { requiresRenewedApproval: true } : {}),
          ...(result.error.certificate && typeof result.error.certificate === 'object'
            ? { certificate: Object.fromEntries(Object.entries(result.error.certificate).filter(([, value]) => typeof value === 'string')) }
            : {}),
        };
  }
  if (result.target) safe.target = publicTarget(result.target);
  else if (typeof result.id === 'string' && typeof result.name === 'string') return publicTarget(result);
  if (Array.isArray(result.targets)) safe.targets = result.targets.map(publicTarget);
  if (Array.isArray(result.candidates)) safe.candidates = result.candidates.map(publicCandidate).filter(Boolean);
  return Object.keys(safe).length ? safe : { success: true };
}

function isAvailable(target) {
  if (!target) return false;
  if (target.id === 'local' || target.type === 'local') return target.status === 'ready';
  const reportsAuthentication = typeof target.signedIn === 'boolean'
    || typeof target.authMarker === 'boolean';
  return target.status === 'connected'
    && (!reportsAuthentication || target.signedIn === true || target.authMarker === true);
}

function headerTokens(headers, name) {
  const value = headers[name];
  return String(value || '').split(',').map((token) => token.trim().toLowerCase()).filter(Boolean);
}

function proxyRequestHeaders(headers) {
  const connectionTokens = new Set(headerTokens(headers, 'connection'));
  const result = {};
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (
      !name || HOP_BY_HOP.has(name) || connectionTokens.has(name)
      || name === 'host' || name === 'cookie' || name === 'origin'
      || name === CONTROLLER_HEADER || name === CONTROLLER_AUTH_HEADER
      || name.startsWith('proxy-') || name.startsWith('sec-')
    ) continue;
    result[name] = value;
  }
  return result;
}

function proxyResponseHeaders(headers = {}) {
  const connectionTokens = new Set(headerTokens(headers, 'connection'));
  const result = {};
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (!name || HOP_BY_HOP.has(name) || connectionTokens.has(name) || name === 'set-cookie' || name === 'location') continue;
    result[name] = value;
  }
  // Every proxied API payload is server-owned state. In Electron, accepting an
  // upstream cache policy could persist conversations, attachment bytes, or
  // workspace content beneath installation-level userData. Explicit downloads
  // still work; only the implicit Chromium cache is disabled.
  result['cache-control'] = 'no-store';
  return result;
}

function bodyStream(body) {
  if (body == null) return Readable.from([]);
  if (typeof body.pipe === 'function') return body;
  return Readable.from([Buffer.isBuffer(body) ? body : Buffer.from(String(body))]);
}

function isAttachmentUpload(method, pathname) {
  return method === 'POST' && /^\/api\/sessions\/[^/]+\/chat-attachments$/.test(pathname);
}

function declaredBodyLength(headers) {
  const value = headers['content-length'];
  if (value === undefined) return null;
  if (Array.isArray(value) || !/^\d+$/.test(value)) {
    const error = new Error('Content-Length must be a non-negative integer');
    error.statusCode = 400;
    throw error;
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length)) {
    const error = new Error('Content-Length is too large');
    error.statusCode = 413;
    throw error;
  }
  return length;
}

function boundedAttachmentBody(body, headers, onLimit) {
  const declared = declaredBodyLength(headers);
  if (declared !== null && declared > MAX_ATTACHMENT_BYTES) {
    const error = new Error('Attachment exceeds the 20 MiB limit');
    error.statusCode = 413;
    throw error;
  }
  // Chunked requests have no Content-Length. Count them while piping so the
  // limit holds without collecting their bytes or defeating backpressure.
  let length = 0;
  const bounded = new Transform({
    transform(chunk, _encoding, callback) {
      length += chunk.length;
      if (length > MAX_ATTACHMENT_BYTES) {
        const error = new Error('Attachment exceeds the 20 MiB limit');
        error.statusCode = 413;
        callback(error);
        onLimit?.(error);
        return;
      }
      callback(null, chunk);
    },
  });
  // pipe() deliberately does not forward source failures.  Preserve the
  // browser abort all the way to the selected local/remote transport instead
  // of leaving a bounded transform waiting forever.
  const abort = () => bounded.destroy(Object.assign(new Error('The upload was aborted.'), { code: 'ECONNRESET' }));
  const fail = (error) => bounded.destroy(error);
  const cleanup = () => {
    body.removeListener?.('aborted', abort);
    body.removeListener?.('error', fail);
  };
  body.once?.('aborted', abort);
  body.once?.('error', fail);
  bounded.once('close', cleanup);
  const completion = new Promise((resolve, reject) => {
    let settled = false;
    bounded.once('end', () => {
      settled = true;
      resolve({ complete: true, length });
    });
    bounded.once('error', (error) => {
      settled = true;
      reject(error);
    });
    // Both controller transports destroy an upload body when an upstream
    // rejects before consuming it. A destroyed Transform emits `close` but
    // neither `end` nor (necessarily) `error`; make that state explicit rather
    // than leaving the gateway waiting forever.
    bounded.once('close', () => {
      if (settled) return;
      settled = true;
      resolve({ complete: false, length });
    });
  });
  body.pipe(bounded);
  const cancel = (error) => {
    body.unpipe?.(bounded);
    if (!bounded.destroyed) bounded.destroy(error);
    // The gateway still owes the renderer an HTTP error response. Drain any
    // bytes already in flight instead of leaving the socket backpressured on a
    // transform whose target failed before it began consuming the upload.
    body.resume?.();
  };
  return { body: bounded, completion, cancel };
}

function pipeResponseBody(source, res) {
  const body = bodyStream(source);
  const abortUpstream = () => {
    if (!res.writableEnded) body.destroy();
  };
  res.once('close', abortUpstream);
  body.once('error', (error) => res.destroy(error));
  body.once('end', () => res.removeListener('close', abortUpstream));
  body.pipe(res);
}

async function readBody(req, limit = MAX_ROUTING_BODY) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) {
      const error = new Error('Controller routing request body is too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseJsonBody(buffer) {
  try {
    return buffer.length ? JSON.parse(buffer.toString('utf8')) : {};
  } catch {
    const error = new Error('Request body must be valid JSON');
    error.statusCode = 400;
    throw error;
  }
}

function encodeBody(value) {
  return Buffer.from(JSON.stringify(value));
}

function lastActivity(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const date = Date.parse(value);
    if (Number.isFinite(date)) return date;
  }
  return 0;
}

function errorMessage(error) {
  return error && typeof error.message === 'string' ? error.message : 'The server is unavailable.';
}

function rawPathname(url) {
  const raw = String(url || '/').split('?', 1)[0];
  let decoded;
  try { decoded = decodeURIComponent(raw); } catch { return null; }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const segments = decoded.split('/');
  if (segments.includes('..') || segments.includes('.')) return null;
  return decoded.startsWith('/') ? decoded : `/${decoded}`;
}

function safeStaticFile(publicDir, requestUrl) {
  const pathname = rawPathname(requestUrl);
  if (pathname === null || pathname.startsWith('/api/')) return null;
  let root;
  try { root = fs.realpathSync(publicDir); } catch { return null; }
  const relative = pathname.replace(/^\/+/, '');
  let candidate = path.resolve(root, relative || 'index.html');
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) return null;
  try {
    if (fs.statSync(candidate).isDirectory()) candidate = path.join(candidate, 'index.html');
    candidate = fs.realpathSync(candidate);
    if (
      candidate !== root
      && candidate.startsWith(`${root}${path.sep}`)
      && fs.statSync(candidate).isFile()
    ) return candidate;
  } catch { /* SPA fallback below */ }
  // Requests without a filename extension are client-side routes.
  if (!path.extname(relative)) {
    candidate = path.join(root, 'index.html');
    try {
      candidate = fs.realpathSync(candidate);
      if (candidate.startsWith(`${root}${path.sep}`) && fs.statSync(candidate).isFile()) return candidate;
    } catch { /* 404 */ }
  }
  return null;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function socketOpen(socket) {
  return socket && socket.readyState === WebSocket.OPEN;
}

/**
 * Facade contract (all methods may be async):
 *
 * - listTargets() -> catalog-shaped targets. Credentials/cookies must never be
 *   returned. The gateway publishes only the whitelist in publicTarget().
 * - request(serverId, { method, path, headers, body }) ->
 *   { statusCode, headers, body }. body may be a Readable and is never buffered
 *   except for the two small JSON routes whose ids must be rewritten.
 * - connectWebSocket(serverId, { path }) -> an open ws-compatible socket.
 * - action(name, payload) -> optional catalog/connection action. The supported
 *   names are add, test, update, remove, retry, signIn, signOut,
 *   approveCertificate, and discover. Returned targets are sanitized.
 * - cacheSessions(serverId, sessions) is an optional best-effort metadata hook.
 */
function createControllerGateway(options = {}) {
  const {
    publicDir,
    controller,
    phoneAccess = null,
    host = '127.0.0.1',
    randomBytes = crypto.randomBytes,
    port = 0,
    wsPath = '/',
    upstreamReconnectMs = DEFAULT_UPSTREAM_RECONNECT_MS,
  } = options;
  if (typeof publicDir !== 'string' || !publicDir) throw new TypeError('A publicDir is required');
  if (!controller || typeof controller.listTargets !== 'function' || typeof controller.request !== 'function') {
    throw new TypeError('A controller facade with listTargets() and request() is required');
  }
  if (net.isIP(host) === 0 || (!(net.isIP(host) === 4 && host.startsWith('127.')) && host !== '::1')) {
    throw new TypeError('The desktop controller gateway must bind to a loopback IP address');
  }
  if (!Number.isFinite(upstreamReconnectMs) || upstreamReconnectMs < 10) {
    throw new TypeError('The upstream reconnect interval must be at least 10ms');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535 || (port > 0 && port < 1024)) {
    throw new TypeError('The controller gateway port must be 0 or an unprivileged TCP port');
  }

  const secret = randomBytes(32).toString('base64url');
  if (Buffer.byteLength(secret) < 32) throw new TypeError('The controller capability lacks entropy');
  const browserSockets = new Set();
  const upstreamSockets = new Set();
  const upstreamOwners = new Map();
  const targetEpochs = new Map();
  let bound = null;

  function targetEpoch(serverId) {
    return targetEpochs.get(serverId) || 0;
  }

  function disconnectTarget(serverId) {
    targetEpochs.set(serverId, targetEpoch(serverId) + 1);
    for (const [upstream, owner] of upstreamOwners) {
      if (owner !== serverId) continue;
      upstreamOwners.delete(upstream);
      upstreamSockets.delete(upstream);
      if (typeof upstream.terminate === 'function') upstream.terminate();
      else upstream.close?.();
    }
  }

  const server = http.createServer((req, res) => {
    void handleRequest(req, res).catch((error) => {
      if (res.destroyed) return;
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
      const statusCode = error.statusCode || 502;
      json(res, statusCode, {
        error: statusCode === 400
          ? 'invalid_request'
          : statusCode === 413 ? 'file_too_large' : 'controller_request_failed',
        message: errorMessage(error),
        ...(statusCode === 413 ? { limitBytes: MAX_ATTACHMENT_BYTES } : {}),
      }, statusCode === 413 ? { connection: 'close' } : undefined);
    });
  });
  const wss = new WebSocket.Server({ noServer: true, clientTracking: false });

  function expectedHost() {
    if (!bound) return null;
    const printable = bound.address.includes(':') ? `[${bound.address}]` : bound.address;
    return `${printable}:${bound.port}`;
  }

  function expectedOrigin() {
    return `http://${expectedHost()}`;
  }

  function requestIsLocal(req) {
    if (!bound || req.headers.host !== expectedHost()) return false;
    const origin = req.headers.origin;
    if (origin && origin !== expectedOrigin()) return false;
    const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
    return !site || site === 'same-origin' || site === 'none';
  }

  function isAuthenticated(req) {
    return safeEqual(req.headers[CONTROLLER_AUTH_HEADER], secret);
  }

  async function targets() {
    const values = await controller.listTargets();
    if (!Array.isArray(values)) throw new TypeError('controller.listTargets() must return an array');
    return values;
  }

  async function targetById(serverId) {
    return (await targets()).find((target) => target.id === serverId) || null;
  }

  async function handleRequest(req, res) {
    if (!requestIsLocal(req)) {
      json(res, 403, { error: 'forbidden_origin' });
      return;
    }
    if (!isAuthenticated(req)) {
      // Electron injects this capability at the network boundary for this exact
      // origin. Never mint it in response to HTTP: another local process can
      // reach a loopback port, but it must not be able to turn that reachability
      // into the renderer's remembered server accounts.
      json(res, 401, { error: 'controller_authentication_required' });
      return;
    }

    const staticFile = (req.method === 'GET' || req.method === 'HEAD')
      ? safeStaticFile(publicDir, req.url) : null;
    const url = new URL(req.url, expectedOrigin());
    if (url.pathname === '/api/controller/bootstrap' && req.method === 'GET') {
      const values = await targets();
      json(res, 200, { desktopController: true, targets: values.map(publicTarget) });
      return;
    }
    if (url.pathname.startsWith('/api/controller/')) {
      await handleControllerAction(req, res, url);
      return;
    }
    if (url.pathname === '/api/sessions/list' && req.method === 'GET') {
      await aggregateSessions(res);
      return;
    }
    if (url.pathname === '/api/sessions/conversations' && req.method === 'GET') {
      const selected = req.headers[CONTROLLER_HEADER];
      if (Array.isArray(selected)) {
        json(res, 400, { error: 'target_server_invalid' });
        return;
      }
      await aggregateConversations(res, typeof selected === 'string' && selected ? selected : null);
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      await routeApi(req, res, url);
      return;
    }
    if (!staticFile) {
      json(res, 404, { error: 'not_found' });
      return;
    }
    await serveStatic(req, res, staticFile);
  }

  async function serveStatic(req, res, filename) {
    const stat = await fs.promises.stat(filename);
    const headers = {
      'content-type': MIME_TYPES.get(path.extname(filename).toLowerCase()) || 'application/octet-stream',
      'content-length': String(stat.size),
      'x-content-type-options': 'nosniff',
      'cache-control': path.basename(filename) === 'index.html' ? 'no-store' : 'public, max-age=3600',
    };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(filename).pipe(res);
  }

  async function handleControllerAction(req, res, url) {
    const phoneRoute = [
      ['GET', /^\/api\/controller\/phone-access$/, 'status'],
      ['GET', /^\/api\/controller\/phone-access\/ca$/, 'exportCa'],
      ['POST', /^\/api\/controller\/phone-access\/start$/, 'start'],
      ['POST', /^\/api\/controller\/phone-access\/pairing$/, 'createPairing'],
      ['DELETE', /^\/api\/controller\/phone-access\/devices\/([^/]+)$/, 'revoke'],
      ['DELETE', /^\/api\/controller\/phone-access$/, 'stop'],
      ['POST', /^\/api\/controller\/phone-access\/tailscale\/check$/, 'checkTailscale'],
      ['POST', /^\/api\/controller\/phone-access\/tailscale-origin$/, 'setTailscaleOrigin'],
    ].map(([method, pattern, action]) => {
      const match = pattern.exec(url.pathname);
      return method === req.method && match ? { action, match } : null;
    }).find(Boolean);
    if (phoneRoute) {
      if (!phoneAccess || typeof phoneAccess[phoneRoute.action] !== 'function') {
        json(res, 501, { error: 'phone_access_unavailable', message: 'Phone access is unavailable in this desktop build.' });
        return;
      }
      if (phoneRoute.action === 'exportCa') {
        const certificate = await phoneAccess.exportCa();
        if (!Buffer.isBuffer(certificate)) throw new TypeError('The phone-access CA export is invalid.');
        res.writeHead(200, {
          'content-type': 'application/x-x509-ca-cert',
          'content-disposition': 'attachment; filename="code-agents-webcli-ca.crt"',
          'content-length': String(certificate.length),
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        res.end(certificate);
        return;
      }
      const buffer = req.method === 'GET' ? Buffer.alloc(0) : await readBody(req);
      const input = buffer.length ? parseJsonBody(buffer) : {};
      let deviceId;
      if (phoneRoute.match[1]) {
        try {
          deviceId = decodeURIComponent(phoneRoute.match[1]);
        } catch {
          throw Object.assign(new Error('The phone device id is malformed.'), { statusCode: 400 });
        }
      }
      const result = phoneRoute.action === 'revoke'
        ? await phoneAccess.revoke(deviceId)
        : phoneRoute.action === 'setTailscaleOrigin'
          ? await phoneAccess.setTailscaleOrigin(input.origin)
          : await phoneAccess[phoneRoute.action](input);
      json(res, 200, result && typeof result === 'object' ? result : { success: true });
      return;
    }

    const routes = [
      ['POST', /^\/api\/controller\/targets\/test$/, 'test'],
      ['POST', /^\/api\/controller\/targets$/, 'add'],
      ['PATCH', /^\/api\/controller\/targets\/([^/]+)$/, 'update'],
      ['DELETE', /^\/api\/controller\/targets\/([^/]+)$/, 'remove'],
      ['POST', /^\/api\/controller\/targets\/([^/]+)\/retry$/, 'retry'],
      ['POST', /^\/api\/controller\/targets\/([^/]+)\/sign-in$/, 'signIn'],
      ['POST', /^\/api\/controller\/targets\/([^/]+)\/sign-out$/, 'signOut'],
      ['POST', /^\/api\/controller\/targets\/([^/]+)\/certificate$/, 'approveCertificate'],
      ['DELETE', /^\/api\/controller\/targets\/([^/]+)\/certificate$/, 'requireValidCertificate'],
      ['POST', /^\/api\/controller\/discover$/, 'discover'],
    ];
    const route = routes.map(([method, pattern, action]) => {
      const match = pattern.exec(url.pathname);
      return method === req.method && match ? { action, match } : null;
    }).find(Boolean);
    if (!route) {
      json(res, 404, { error: 'controller_action_not_found' });
      return;
    }
    if (typeof controller.action !== 'function') {
      json(res, 501, { error: 'controller_action_unavailable' });
      return;
    }
    const buffer = await readBody(req);
    const input = buffer.length ? parseJsonBody(buffer) : {};
    const serverId = route.match[1] ? decodeURIComponent(route.match[1]) : undefined;
    const result = await controller.action(route.action, { ...input, ...(serverId ? { serverId } : {}) });
    const completedInvalidation = result?.success !== false && (
      route.action === 'signOut'
      || route.action === 'remove'
      || route.action === 'approveCertificate'
      || route.action === 'requireValidCertificate'
      || (route.action === 'update' && result.destinationChanged === true)
    );
    // A certificate-blocked address edit is deliberately not committed, but
    // the user's destination choice takes effect immediately. Do not leave an
    // authenticated socket to the old address alive while the new pin waits
    // for review.
    const stagedDestinationInvalidation = route.action === 'update'
      && result?.stagedDestinationChanged === true;
    if (serverId && (completedInvalidation || stagedDestinationInvalidation)) {
      disconnectTarget(serverId);
    }
    json(res, 200, publicActionResult(result));
  }

  async function aggregateSessions(res) {
    const allTargets = await targets();
    const rows = await Promise.all(allTargets.map(async (target) => {
      if (!isAvailable(target)) return cachedSessions(target);
      try {
        const upstream = await controller.request(target.id, {
          method: 'GET', path: '/api/sessions/list', headers: {}, body: null,
        });
        const raw = await collectResponse(upstream);
        if ((upstream.statusCode || 200) < 200 || (upstream.statusCode || 200) >= 300) throw new Error(`Session list returned ${upstream.statusCode}`);
        const parsed = parseJsonBody(raw);
        if (!Array.isArray(parsed.sessions)) throw new TypeError('Session list response has no sessions array');
        await controller.cacheSessions?.(target.id, parsed.sessions);
        return qualifySessionList({ ...target, status: target.status }, parsed.sessions);
      } catch (error) {
        return cachedSessions({ ...target, status: 'offline', error: { message: errorMessage(error) } });
      }
    }));
    const sessions = rows.flat().sort((a, b) => lastActivity(b.lastActivity) - lastActivity(a.lastActivity));
    json(res, 200, { sessions, servers: allTargets.map(publicTarget) });
  }

  async function aggregateConversations(res, selectedServerId = null) {
    const allTargets = await targets();
    const selectedTarget = selectedServerId
      ? allTargets.find((target) => target.id === selectedServerId) : null;
    if (selectedServerId && !selectedTarget) {
      json(res, 404, { error: 'unknown_target_server' });
      return;
    }
    if (selectedTarget && !isAvailable(selectedTarget)) {
      json(res, 503, { error: 'target_server_unavailable', server: publicTarget(selectedTarget) });
      return;
    }
    const eligible = selectedTarget ? [selectedTarget] : allTargets.filter(isAvailable);
    const answers = await Promise.all(eligible.map(async (target) => {
      try {
        const upstream = await controller.request(target.id, {
          method: 'GET', path: '/api/sessions/conversations', headers: {}, body: null,
        });
        const raw = await collectResponse(upstream);
        if ((upstream.statusCode || 200) < 200 || (upstream.statusCode || 200) >= 300) {
          if (selectedTarget) {
            const headers = proxyResponseHeaders(upstream.headers);
            headers['content-length'] = String(raw.length);
            res.writeHead(upstream.statusCode || 502, headers);
            res.end(raw);
            return { proxied: true };
          }
          return null;
        }
        const value = parseJsonBody(raw);
        if (!Array.isArray(value.projects)) {
          if (selectedTarget) throw new TypeError('The selected server returned an invalid conversations response');
          return null;
        }
        const projects = value.projects.map((project) => ({
          ...project,
          key: JSON.stringify([target.id, project.key || project.dir || '']),
          name: `${project.name || 'Project'} · ${target.name}`,
          serverId: target.id,
          serverName: target.name,
          serverInsecure: target.insecure === true || Boolean(target.certificateOverride),
          conversations: Array.isArray(project.conversations)
            ? project.conversations.map((conversation) => ({
                ...conversation,
                id: qualifySessionId(target.id, conversation.id),
                serverId: target.id,
                serverName: target.name,
                serverInsecure: target.insecure === true || Boolean(target.certificateOverride),
              }))
            : [],
        }));
        return {
          projects,
          total: typeof value.total === 'number' ? value.total : projects.reduce((count, project) => count + project.conversations.length, 0),
          truncated: value.truncated === true,
        };
      } catch (error) {
        if (selectedTarget) throw error;
        return null;
      }
    }));
    if (selectedTarget && answers.some((answer) => answer?.proxied)) return;
    const available = answers.filter(Boolean);
    const projects = available.flatMap((answer) => answer.projects).sort((left, right) =>
      lastActivity(right.lastActivity) - lastActivity(left.lastActivity));
    json(res, 200, {
      projects,
      total: available.reduce((count, answer) => count + answer.total, 0),
      truncated: available.some((answer) => answer.truncated),
      servers: allTargets.map(publicTarget),
    });
  }

  function cachedSessions(target) {
    const cached = target.offlineMetadataCache && Array.isArray(target.offlineMetadataCache.sessions)
      ? target.offlineMetadataCache.sessions : [];
    return qualifySessionList({ ...target, status: 'offline' }, cached);
  }

  async function collectResponse(upstream, maximumBytes = MAX_AGGREGATE_BODY) {
    const chunks = [];
    let length = 0;
    for await (const chunk of bodyStream(upstream.body ?? upstream)) {
      length += chunk.length;
      if (length > maximumBytes) {
        upstream.destroy?.();
        upstream.body?.destroy?.();
        const error = new Error('The upstream controller response is too large');
        error.statusCode = 502;
        throw error;
      }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  function explicitServerId(req, url, body) {
    const header = req.headers[CONTROLLER_HEADER];
    const query = url.searchParams.get('serverId');
    const jsonId = body && typeof body.serverId === 'string' ? body.serverId : null;
    const ids = [header, query, jsonId].filter((value) => typeof value === 'string' && value);
    if (!ids.length) return null;
    if (new Set(ids).size !== 1) {
      const error = new Error('Conflicting target server ids');
      error.statusCode = 400;
      throw error;
    }
    return ids[0];
  }

  function rewriteQualifiedPath(pathname) {
    const match = /^\/api\/(sessions|workspace)\/([^/]+)(\/.*)?$/.exec(pathname);
    if (!match || (match[1] === 'sessions' && ['create', 'list', 'tabs', 'resumable', 'conversations', 'persistence'].includes(match[2]))) return null;
    let decoded;
    try { decoded = decodeURIComponent(match[2]); } catch { return { error: 'invalid' }; }
    const parsed = parseQualifiedSessionId(decoded);
    if (!parsed) return { error: 'unqualified' };
    return {
      serverId: parsed.serverId,
      sessionId: parsed.sessionId,
      pathname: `/api/${match[1]}/${encodeURIComponent(parsed.sessionId)}${match[3] || ''}`,
    };
  }

  async function routeApi(req, res, url) {
    let buffer = null;
    let parsedBody = null;
    const needsJsonRouting = url.pathname === '/api/sessions/create'
      || url.pathname === '/api/sessions/tabs/order'
      || url.pathname === '/api/set-working-dir';
    if (needsJsonRouting) {
      buffer = await readBody(req);
      parsedBody = parseJsonBody(buffer);
    }

    const sessionRoute = rewriteQualifiedPath(url.pathname);
    if (sessionRoute?.error) {
      json(res, 400, { error: 'qualified_session_id_required' });
      return;
    }
    const querySessionValue = url.searchParams.get('sessionId');
    const querySession = querySessionValue ? parseQualifiedSessionId(querySessionValue) : null;
    if (querySessionValue?.startsWith('ccs1.') && !querySession) {
      json(res, 400, { error: 'qualified_session_id_invalid' });
      return;
    }
    const bodySessionValue = typeof parsedBody?.sessionId === 'string' ? parsedBody.sessionId : null;
    const bodySession = bodySessionValue ? parseQualifiedSessionId(bodySessionValue) : null;
    if (bodySessionValue?.startsWith('ccs1.') && !bodySession) {
      json(res, 400, { error: 'qualified_session_id_invalid' });
      return;
    }
    const explicitTarget = explicitServerId(req, url, parsedBody);
    const qualifiedOwners = [sessionRoute?.serverId, querySession?.serverId, bodySession?.serverId].filter(Boolean);
    if (new Set(qualifiedOwners).size > 1 || (qualifiedOwners[0] && explicitTarget && qualifiedOwners[0] !== explicitTarget)) {
      json(res, 400, { error: 'wrong_target_server', message: 'The target does not own this session.' });
      return;
    }
    let serverId = qualifiedOwners[0] || explicitTarget;
    let pathname = sessionRoute?.pathname || url.pathname;
    if (querySession) url.searchParams.set('sessionId', querySession.sessionId);
    if (bodySession) {
      parsedBody = { ...parsedBody, sessionId: bodySession.sessionId };
      buffer = encodeBody(parsedBody);
    }

    if (url.pathname === '/api/sessions/tabs/order') {
      try {
        const groups = splitSessionsByServer(parsedBody.sessionIds);
        if (groups.size !== 1) throw new TypeError('Tab order cannot cross servers');
        const [owner, ids] = groups.entries().next().value;
        if (serverId && serverId !== owner) throw new TypeError('The target does not own this tab order');
        serverId = owner;
        parsedBody = { ...parsedBody, sessionIds: ids };
        delete parsedBody.serverId;
        buffer = encodeBody(parsedBody);
      } catch (error) {
        json(res, 400, { error: 'cross_server_operation', message: errorMessage(error) });
        return;
      }
    } else if (url.pathname === '/api/sessions/create') {
      if (!serverId) {
        json(res, 400, { error: 'target_server_required' });
        return;
      }
      parsedBody = { ...parsedBody };
      if (typeof parsedBody.ownerSessionId === 'string' && parsedBody.ownerSessionId) {
        const owner = parseQualifiedSessionId(parsedBody.ownerSessionId);
        if (!owner || owner.serverId !== serverId) {
          json(res, 400, { error: 'wrong_target_server', message: 'The target does not own the parent session.' });
          return;
        }
        parsedBody.ownerSessionId = owner.sessionId;
      }
      delete parsedBody.serverId;
      buffer = encodeBody(parsedBody);
    }

    // /api/config is the only implicit target: it is the renderer bootstrap
    // and must survive a failed local child process. Every other server-owned
    // route requires an explicit target or a qualified session id.
    if (!serverId && url.pathname === '/api/config') serverId = 'local';
    if (!serverId) {
      json(res, 400, { error: 'target_server_required' });
      return;
    }
    const target = await targetById(serverId);
    if (!target) {
      json(res, 404, { error: 'unknown_target_server' });
      return;
    }
    if (!isAvailable(target)) {
      if (url.pathname === '/api/config' && serverId === 'local') {
        json(res, 200, minimalConfig(target));
      } else {
        json(res, 503, { error: 'target_server_unavailable', server: publicTarget(target) });
      }
      return;
    }

    url.searchParams.delete('serverId');
    const upstreamPath = `${pathname}${url.search}`;
    const headers = proxyRequestHeaders(req.headers);
    if (buffer) headers['content-length'] = String(buffer.length);
    const attachmentUpload = isAttachmentUpload(req.method, pathname);
    const requestAbort = attachmentUpload ? new AbortController() : null;
    let attachmentLimitError = null;
    const abortUpstream = () => requestAbort?.abort();
    const rejectAttachmentLimit = (error) => {
      attachmentLimitError = error;
      abortUpstream();
    };
    const abortOnResponseClose = () => {
      if (!res.writableEnded) abortUpstream();
    };
    if (requestAbort) {
      req.once('aborted', abortUpstream);
      res.once('close', abortOnResponseClose);
      if (req.aborted) abortUpstream();
    }
    // Do not consume a raw attachment to route it.  The qualified path above
    // already identifies its one owner; this transform only enforces the
    // canonical 20 MiB limit as bytes flow to that owner.
    const boundedUpload = attachmentUpload
      ? boundedAttachmentBody(req, req.headers, rejectAttachmentLimit)
      : null;
    // The remote transport may still be proving TLS/cookies when the renderer
    // disconnects and the body rejects. Observe that rejection immediately;
    // a later explicit await still receives it for accepted (2xx) uploads.
    const observedUploadCompletion = boundedUpload?.completion.catch(() => undefined);
    const requestBody = buffer || boundedUpload?.body || req;
    let upstream;
    try {
      try {
        upstream = await controller.request(serverId, {
          method: req.method,
          path: upstreamPath,
          headers,
          body: requestBody,
          ...(requestAbort ? { signal: requestAbort.signal } : {}),
        });
        if (attachmentLimitError) throw attachmentLimitError;
        if (boundedUpload) {
          const statusCode = upstream.statusCode || 502;
          if (statusCode >= 200 && statusCode < 300) {
            const completed = await boundedUpload.completion;
            if (attachmentLimitError) throw attachmentLimitError;
            if (!completed.complete) {
              throw Object.assign(
                new Error('The attachment server accepted an incomplete upload.'),
                { statusCode: 502 },
              );
            }
          } else {
            // Authentication/session/quota middleware can reject from headers
            // without reading a large file. Forward that exact response now;
            // the transport/source close will settle in the background.
            void observedUploadCompletion;
          }
        }
      } catch (error) {
        if (boundedUpload) {
          boundedUpload.cancel(error);
          await observedUploadCompletion;
        }
        throw attachmentLimitError || error;
      }
    } finally {
      req.removeListener('aborted', abortUpstream);
      res.removeListener('close', abortOnResponseClose);
    }

    const rewritesJsonResponse = url.pathname === '/api/sessions/create'
      || url.pathname === '/api/sessions/resumable'
      || pathname.endsWith('/branch')
      || pathname.endsWith('/children')
      // An accepted upload returns a small JSON descriptor whose attachment
      // URL belongs in the renderer's qualified namespace.  Error bodies are
      // opaque upstream bytes (often non-JSON) and must retain their status,
      // content type, length, and payload exactly.
      || (attachmentUpload && (upstream.statusCode || 502) >= 200 && (upstream.statusCode || 502) < 300);
    if (rewritesJsonResponse) {
      const responseBuffer = await collectResponse(upstream);
      let responseBody = responseBuffer;
      let value;
      let parsed = false;
      try {
        value = parseJsonBody(responseBuffer);
        parsed = true;
      } catch (error) {
        if (attachmentUpload) {
          throw Object.assign(
            new Error('The attachment server returned an unsafe response.'),
            { statusCode: 502, cause: error },
          );
        }
        // Preserve the historical tolerance for opaque/non-JSON bodies on the
        // other rewritten endpoints. A valid JSON response is handled below,
        // where unsafe capabilities are never allowed to fall back unchanged.
      }
      if (parsed) {
        try {
          let responseSessionId;
          if ((url.pathname === '/api/sessions/create' || pathname.endsWith('/branch')) && typeof value.sessionId === 'string') {
            responseSessionId = value.sessionId;
            value.sessionId = qualifySessionId(serverId, value.sessionId);
          }
          if (url.pathname === '/api/sessions/resumable' && Array.isArray(value.conversations)) {
            value.conversations = value.conversations.map((conversation) => (
              conversation && typeof conversation === 'object' && typeof conversation.id === 'string'
                ? { ...conversation, id: qualifySessionId(serverId, conversation.id), serverId, serverName: target.name }
                : conversation
            ));
          }
          if (pathname.endsWith('/children') && Array.isArray(value.sessionIds)) {
            value.sessionIds = value.sessionIds.map((sessionId) =>
              qualifySessionId(serverId, sessionId));
          }
          responseBody = encodeBody(
            attachmentUpload
              ? qualifyOwnedAttachment(serverId, sessionRoute.sessionId, value)
              : qualifyAttachmentUrls(serverId, value, responseSessionId),
          );
        } catch (error) {
          throw Object.assign(
            new Error(attachmentUpload
              ? 'The attachment server returned an unsafe response.'
              : 'The target server returned an unsafe response.'),
            { statusCode: 502, cause: error },
          );
        }
      }
      const headersOut = proxyResponseHeaders(upstream.headers);
      headersOut['content-length'] = String(responseBody.length);
      res.writeHead(upstream.statusCode || 502, headersOut);
      res.end(responseBody);
      return;
    }
    res.writeHead(upstream.statusCode || 502, proxyResponseHeaders(upstream.headers));
    pipeResponseBody(upstream.body ?? upstream, res);
  }

  function minimalConfig(local) {
    return {
      desktopController: true,
      localServerUnavailable: true,
      localServerError: publicTarget(local).error || { message: 'Local computer is unavailable.' },
      folderMode: true,
      aliases: {},
      supportedShells: [],
      containerizedEnvironmentsEnabled: false,
      repositoryInspectionSupported: false,
      currentUser: null,
      logoutUrl: null,
      preferences: {},
    };
  }

  server.on('upgrade', (req, socket, head) => {
    if (!requestIsLocal(req) || !isAuthenticated(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const url = new URL(req.url, expectedOrigin());
    if (url.pathname !== wsPath) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const qualifiedInitialId = url.searchParams.get('sessionId');
    let initialSession = null;
    if (qualifiedInitialId) {
      initialSession = parseQualifiedSessionId(qualifiedInitialId);
      if (!initialSession) {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
    }
    wss.handleUpgrade(req, socket, head, (browser) => handleBrowserSocket(browser, initialSession));
  });

  async function handleBrowserSocket(browser, initialSession) {
    browserSockets.add(browser);
    const connections = new Map();
    const pending = new Map();
    const settledTargets = new Set();
    const connectingTargets = new Set();
    const announcedUnavailable = new Set();
    let activeServerId = initialSession?.serverId || null;
    let reconnectTimer = null;
    let closed = false;
    browser.once('close', () => {
      closed = true;
      if (reconnectTimer) clearInterval(reconnectTimer);
      browserSockets.delete(browser);
      for (const upstream of connections.values()) upstream.close?.();
    });
    browser.on('message', (data, binary) => {
      if (binary) {
        sendBrowser(browser, { type: 'controller_error', message: 'Binary controller messages are not supported.' });
        return;
      }
      try {
        const incoming = JSON.parse(data.toString('utf8'));
        const carriesTarget = (typeof incoming.serverId === 'string' && incoming.serverId)
          || (typeof incoming.sessionId === 'string' && incoming.sessionId)
          || Array.isArray(incoming.sessionIds);
        const resolved = resolveClientMessage(incoming, carriesTarget ? null : activeServerId);
        const upstream = connections.get(resolved.serverId);
        if (resolved.message.type === 'join_session') activeServerId = resolved.serverId;
        if (socketOpen(upstream)) {
          upstream.send(JSON.stringify(resolved.message));
        } else if (!settledTargets.has(resolved.serverId)) {
          const queued = pending.get(resolved.serverId) || [];
          queued.push(resolved.message);
          pending.set(resolved.serverId, queued);
        } else {
          throw new Error(`Server ${resolved.serverId} is not connected.`);
        }
      } catch (error) {
        sendBrowser(browser, { type: 'controller_error', message: errorMessage(error) });
      }
    });

    async function connectTarget(target) {
      if (
        closed
        || browser.readyState !== WebSocket.OPEN
        || connections.has(target.id)
        || connectingTargets.has(target.id)
      ) return;
      connectingTargets.add(target.id);
      const epoch = targetEpoch(target.id);
      try {
        const initialQuery = initialSession?.serverId === target.id
          ? `?sessionId=${encodeURIComponent(initialSession.sessionId)}` : '';
        const upstream = await controller.connectWebSocket(target.id, { path: `${wsPath}${initialQuery}` });
        if (browser.readyState !== WebSocket.OPEN || epoch !== targetEpoch(target.id)) {
          upstream.close?.();
          return;
        }
        connections.set(target.id, upstream);
        upstreamSockets.add(upstream);
        upstreamOwners.set(upstream, target.id);
        announcedUnavailable.delete(target.id);
        if (!activeServerId && target.id === 'local') activeServerId = target.id;
        if (!activeServerId) activeServerId = target.id;
        let lost = false;
        const connected = () => {
          settledTargets.add(target.id);
          sendStatus(browser, target, 'connected');
          for (const message of pending.get(target.id) || []) upstream.send(JSON.stringify(message));
          pending.delete(target.id);
        };
        if (socketOpen(upstream)) connected();
        else upstream.once('open', connected);
        upstream.on('message', (data, binary) => {
          if (browser.readyState !== WebSocket.OPEN) return;
          if (binary) {
            sendBrowser(browser, {
              type: 'controller_error', serverId: target.id, serverName: target.name,
              message: 'The server sent an unsupported binary message.',
            });
            return;
          }
          try {
            const message = JSON.parse(data.toString('utf8'));
            if (isAttachedStreamMessage(message) && activeServerId !== target.id) return;
            browser.send(JSON.stringify(qualifyServerMessage(target.id, message)));
          } catch {
            sendBrowser(browser, { type: 'controller_error', serverId: target.id, serverName: target.name, message: 'The server sent an invalid message.' });
          }
        });
        const markLost = (message) => {
          if (lost) return;
          lost = true;
          upstreamSockets.delete(upstream);
          upstreamOwners.delete(upstream);
          if (connections.get(target.id) === upstream) connections.delete(target.id);
          settledTargets.add(target.id);
          rejectPending(target.id, message);
          sendStatus(browser, target, 'offline', message);
        };
        upstream.once('close', () => markLost(`${target.name} disconnected.`));
        upstream.on('error', (error) => markLost(errorMessage(error)));
      } catch (error) {
        settledTargets.add(target.id);
        rejectPending(target.id, errorMessage(error));
        sendStatus(browser, target, 'offline', errorMessage(error));
      } finally {
        connectingTargets.delete(target.id);
      }
    }

    async function ensureConnections() {
      if (closed || browser.readyState !== WebSocket.OPEN) return;
      let allTargets;
      try { allTargets = await targets(); } catch (error) {
        sendBrowser(browser, { type: 'controller_error', message: errorMessage(error) });
        return;
      }
      const currentIds = new Set(allTargets.map((target) => target.id));
      for (const [serverId, upstream] of connections) {
        if (currentIds.has(serverId)) continue;
        connections.delete(serverId);
        upstreamSockets.delete(upstream);
        upstreamOwners.delete(upstream);
        upstream.close?.();
      }
      await Promise.all(allTargets.map(async (target) => {
        if (!isAvailable(target) || typeof controller.connectWebSocket !== 'function') {
          const upstream = connections.get(target.id);
          if (upstream) {
            connections.delete(target.id);
            upstreamSockets.delete(upstream);
            upstreamOwners.delete(upstream);
            upstream.close?.();
          }
          settledTargets.add(target.id);
          rejectPending(target.id, `${target.name} is unavailable.`);
          if (!announcedUnavailable.has(target.id)) {
            announcedUnavailable.add(target.id);
            const signedOut = target.id !== 'local'
              && target.signedIn !== true && target.authMarker !== true;
            sendStatus(
              browser,
              target,
              signedOut && target.status === 'connected' ? 'connected' : 'offline',
              signedOut ? 'Sign in required.' : target.error && errorMessage(target.error),
            );
          }
          return;
        }
        await connectTarget(target);
      }));
      for (const serverId of pending.keys()) {
        if (!currentIds.has(serverId)) {
          settledTargets.add(serverId);
          rejectPending(serverId, `Unknown server ${serverId}.`);
        }
      }
    }

    await ensureConnections();
    reconnectTimer = setInterval(() => void ensureConnections(), upstreamReconnectMs);
    reconnectTimer.unref?.();

    function rejectPending(serverId, message) {
      if (pending.has(serverId)) {
        pending.delete(serverId);
        sendBrowser(browser, { type: 'controller_error', serverId, message });
      }
    }
  }

  function sendBrowser(browser, message) {
    if (browser.readyState === WebSocket.OPEN) browser.send(JSON.stringify(message));
  }

  function sendStatus(browser, target, status, message) {
    sendBrowser(browser, {
      type: 'controller_server_status',
      serverId: target.id,
      serverName: target.name,
      status,
      insecure: target.insecure === true || Boolean(target.certificateOverride),
      ...(status === 'connected' ? { lastSuccessfulContact: Date.now() } : {}),
      ...(message ? { message: `${target.name}: ${message}` } : {}),
    });
  }

  async function listen() {
    if (bound) return { host: bound.address, port: bound.port, origin: expectedOrigin() };
    await new Promise((resolve, reject) => {
      const onError = (error) => { server.removeListener('listening', onListening); reject(error); };
      const onListening = () => { server.removeListener('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
    bound = server.address();
    return { host: bound.address, port: bound.port, origin: expectedOrigin() };
  }

  async function close() {
    for (const socket of browserSockets) socket.terminate?.();
    for (const socket of upstreamSockets) socket.close?.();
    if (server.listening) {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    bound = null;
  }

  function authentication() {
    if (!bound) throw new Error('The controller gateway is not listening');
    return { header: CONTROLLER_AUTH_HEADER, value: secret, origin: expectedOrigin() };
  }

  return {
    server,
    listen,
    close,
    authentication,
    address: () => bound && ({ ...bound, origin: expectedOrigin() }),
  };
}

function isAttachedStreamMessage(message) {
  if (!message || typeof message !== 'object') return false;
  return message.type === 'session_left'
    || message.type === 'output'
    || message.type === 'exit'
    || message.type === 'error'
    || message.type === 'info'
    || (typeof message.type === 'string' && (
      message.type.endsWith('_started') || message.type.endsWith('_stopped')
    ));
}

module.exports = {
  CONTROLLER_HEADER,
  CONTROLLER_AUTH_HEADER,
  DEFAULT_UPSTREAM_RECONNECT_MS,
  MAX_ATTACHMENT_BYTES,
  MAX_AGGREGATE_BODY,
  createControllerGateway,
  isAttachedStreamMessage,
  proxyRequestHeaders,
  proxyResponseHeaders,
  publicActionResult,
  publicTarget,
  safeStaticFile,
};
