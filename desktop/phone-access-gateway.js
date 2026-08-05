'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { Transform } = require('node:stream');
const WebSocket = require('ws');
const { isPhoneAccessUnicastAddress } = require('./phone-access-network.js');

const PAIRING_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PAIRING_BODY = 8 * 1024;
const MAX_ROUTING_BODY = 1024 * 1024;
const MAX_PROXY_BODY = 20 * 1024 * 1024;
const CLOSE_GRACE_MS = 1_500;
const DEFAULT_PHONE_ACCESS_PORT = 32354;
const SESSION_COOKIE = '__Host-code_agents_phone_access';
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);
const SECURITY_SINGLETON_HEADERS = new Set([
  'authorization', 'connection', 'content-length', 'cookie', 'forwarded', 'host',
  'origin', 'proxy-authorization', 'sec-fetch-site', 'sec-websocket-key',
  'transfer-encoding', 'upgrade', 'via', 'x-code-agents-controller-auth',
  'x-controller-server-id', 'x-forwarded-for', 'x-forwarded-host',
  'x-forwarded-port', 'x-forwarded-proto',
]);
const PUBLIC_ASSET_FILES = new Set([
  '/app.bundle.js', '/favicon.ico', '/mermaid.bundle.js', '/monaco-editor.worker.js',
  '/monaco.bundle.css', '/monaco.bundle.js',
]);
const PUBLIC_ASSET_EXTENSIONS = new Set([
  '.css', '.gif', '.ico', '.jpeg', '.jpg', '.js', '.png', '.svg', '.wasm',
  '.webp', '.woff', '.woff2',
]);

function json(res, statusCode, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

function rejectJson(req, res, statusCode, value, headers = {}) {
  // A rejected request may still have an unread body. Keeping that connection
  // alive would let the next request be parsed as bytes belonging to the
  // rejected one (an HTTP desynchronization boundary, especially through a
  // pooling reverse proxy). Finish the response, then close this transport.
  const socket = req.socket;
  res.shouldKeepAlive = false;
  res.once('finish', () => {
    if (!socket.destroyed) socket.end();
  });
  json(res, statusCode, value, { ...headers, connection: 'close' });
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function tokenDigest(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('base64url');
}

function exactHttpsOrigin(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw new TypeError('An exact HTTPS origin is required'); }
  if (
    url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/'
    || url.search || url.hash
  ) throw new TypeError('An exact HTTPS origin is required');
  return url.origin;
}

function formatOrigin(protocol, address, port) {
  const host = net.isIP(address) === 6 ? `[${address}]` : address;
  const defaultPort = protocol === 'https:' ? 443 : 80;
  return `${protocol}//${host}${port === defaultPort ? '' : `:${port}`}`;
}

function validLanAddress(value) {
  return isPhoneAccessUnicastAddress(value);
}

function isSafeImmutableAssetPath(pathname) {
  if (typeof pathname !== 'string' || pathname.includes('\\') || pathname.includes('\0')) return false;
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return false; }
  if (decoded !== pathname || decoded.split('/').includes('..')) return false;
  if (PUBLIC_ASSET_FILES.has(pathname)) return true;
  if (!pathname.startsWith('/css/') && !pathname.startsWith('/icons/')) return false;
  if (!/^\/[A-Za-z0-9._/-]+$/.test(pathname)) return false;
  const dot = pathname.lastIndexOf('.');
  return dot > pathname.lastIndexOf('/') && PUBLIC_ASSET_EXTENSIONS.has(pathname.slice(dot).toLowerCase());
}

function duplicateSecurityHeader(req) {
  const counts = new Map();
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const name = String(req.rawHeaders[index] || '').toLowerCase();
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  for (const [name, count] of counts) {
    if (count > 1 && (SECURITY_SINGLETON_HEADERS.has(name) || name.startsWith('tailscale-') || name.startsWith('x-tailscale-'))) {
      return name;
    }
  }
  return null;
}

function requestPath(req, origin) {
  const raw = String(req.url || '');
  if (!raw.startsWith('/') || raw.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(raw)) {
    throw Object.assign(new Error('Only an origin-relative request target is allowed'), { statusCode: 400 });
  }
  const url = new URL(raw, origin);
  if (url.origin !== origin) throw Object.assign(new Error('The request crossed its ingress origin'), { statusCode: 400 });
  return url;
}

function validateBrowserBoundary(req, ingress) {
  if (!ingress?.origin) {
    throw Object.assign(new Error('This ingress has no confirmed public origin'), { statusCode: 403 });
  }
  const duplicate = duplicateSecurityHeader(req);
  if (duplicate) throw Object.assign(new Error(`Duplicate ${duplicate} header`), { statusCode: 400 });
  if (String(req.headers.host || '').toLowerCase() !== new URL(ingress.origin).host.toLowerCase()) {
    throw Object.assign(new Error('Host does not match this phone ingress'), { statusCode: 403 });
  }
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let normalized;
    try { normalized = exactHttpsOrigin(origin); } catch { normalized = ''; }
    if (normalized !== ingress.origin) {
      throw Object.assign(new Error('Origin does not match this phone ingress'), { statusCode: 403 });
    }
  }
  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    throw Object.assign(new Error('Cross-site browser requests are forbidden'), { statusCode: 403 });
  }
  const method = String(req.method || 'GET').toUpperCase();
  if (['CONNECT', 'TRACE'].includes(method)) {
    throw Object.assign(new Error('The HTTP method is not allowed'), { statusCode: 405 });
  }
  if (['GET', 'HEAD'].includes(method)
    && (req.headers['transfer-encoding'] !== undefined
      || (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0'))) {
    throw Object.assign(new Error('GET and HEAD requests cannot carry a body'), { statusCode: 400 });
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && origin === undefined) {
    throw Object.assign(new Error('An exact Origin header is required'), { statusCode: 403 });
  }
  return requestPath(req, ingress.origin);
}

function headerTokens(value) {
  return String(value || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
}

function headerValue(headers, wanted) {
  for (const [name, value] of Object.entries(headers || {})) {
    if (name.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function proxyRequestHeaders(headers = {}) {
  const nominated = new Set(headerTokens(headerValue(headers, 'connection')));
  const result = {};
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (
      !name || HOP_BY_HOP.has(name) || nominated.has(name) || name === 'host'
      || name === 'cookie' || name === 'authorization' || name === 'forwarded'
      || name === 'via' || name === 'x-code-agents-controller-auth'
      || name === 'x-controller-server-id' || name.startsWith('proxy-')
      || name.startsWith('sec-') || name.startsWith('tailscale-')
      || name.startsWith('x-tailscale-') || name.startsWith('x-forwarded-')
    ) continue;
    result[name] = value;
  }
  // The local controller transport treats this only as a signal to synthesize
  // its own exact loopback Origin. The external Origin never crosses the seam.
  result.origin = 'https://phone-access.invalid';
  return result;
}

function safeRedirect(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return null;
  if (/[\\\r\n\0]/.test(value)) return null;
  return value;
}

function proxyResponseHeaders(headers = {}) {
  const nominated = new Set(headerTokens(headerValue(headers, 'connection')));
  const result = {};
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (
      !name || HOP_BY_HOP.has(name) || nominated.has(name) || name === 'set-cookie'
      || name === 'location' || name === 'refresh' || name === 'authorization' || name === 'forwarded'
      || name === 'via' || name === 'x-code-agents-controller-auth'
      || name === 'x-controller-server-id' || name.startsWith('proxy-')
      || name.startsWith('sec-') || name.startsWith('tailscale-')
      || name.startsWith('x-tailscale-') || name.startsWith('x-forwarded-')
    ) continue;
    result[name] = value;
  }
  const location = headerValue(headers, 'location');
  if (location !== undefined) {
    const redirect = safeRedirect(Array.isArray(location) ? null : location);
    if (!redirect) throw Object.assign(new Error('The local server returned an unsafe redirect'), { statusCode: 502 });
    result.location = redirect;
  }
  return result;
}

function declaredBodyLength(headers, maximumBytes = MAX_PROXY_BODY) {
  const value = headers['content-length'];
  if (value === undefined) return null;
  if (Array.isArray(value) || !/^\d+$/.test(String(value))) {
    throw Object.assign(new Error('Content-Length must be a non-negative integer'), { statusCode: 400 });
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length > maximumBytes) {
    throw Object.assign(new Error('The request body is too large'), { statusCode: 413 });
  }
  return length;
}

function boundedBody(req, maximumBytes = MAX_PROXY_BODY) {
  const declared = declaredBodyLength(req.headers, maximumBytes);
  if (declared === 0) return null;
  let received = 0;
  const bounded = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > maximumBytes) {
        callback(Object.assign(new Error('The request body is too large'), { statusCode: 413 }));
        return;
      }
      callback(null, chunk);
    },
  });
  req.once('aborted', () => bounded.destroy(Object.assign(new Error('The browser aborted the upload'), { code: 'ECONNRESET' })));
  req.once('error', (error) => bounded.destroy(error));
  req.pipe(bounded);
  return bounded;
}

function isAttachmentUpload(method, pathname) {
  return method === 'POST' && /^\/api\/sessions\/[^/]+\/chat-attachments$/.test(pathname);
}

function isControllerPath(pathname) {
  return pathname === '/api/controller' || pathname.startsWith('/api/controller/');
}

async function collectJson(req, maximumBytes = MAX_PAIRING_BODY) {
  const declared = declaredBodyLength(req.headers);
  if (declared !== null && declared > maximumBytes) {
    throw Object.assign(new Error('The pairing request is too large'), { statusCode: 413 });
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maximumBytes) throw Object.assign(new Error('The pairing request is too large'), { statusCode: 413 });
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
    throw Object.assign(new Error('The pairing request must be JSON'), { statusCode: 400 });
  }
}

function cookieValue(header, name) {
  if (typeof header !== 'string' || /[\r\n]/.test(header)) return null;
  let found = null;
  for (const part of header.split(';')) {
    const equals = part.indexOf('=');
    if (equals < 1 || part.slice(0, equals).trim() !== name) continue;
    if (found !== null) return null;
    found = part.slice(equals + 1).trim();
  }
  return found;
}

function pairingBootstrap(nonce) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pair Code Agents</title></head><body><main><h1>Pair this device</h1><p id="status">Pairing…</p></main><script nonce="${nonce}">(async()=>{const s=document.getElementById('status');const p=new URLSearchParams(location.hash.slice(1));const token=p.get('token')||'';history.replaceState(null,'','/auth/pair');try{if('serviceWorker'in navigator){const rs=await navigator.serviceWorker.getRegistrations();await Promise.all(rs.map(r=>r.unregister()))}const r=await fetch('/auth/pair',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,label:navigator.userAgentData&&navigator.userAgentData.platform||navigator.platform||'Phone'})});if(!r.ok)throw new Error('Pairing failed');location.replace('/')}catch(e){s.textContent='This pairing link is invalid or expired.'}})();</script></body></html>`;
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const failed = (error) => { server.removeListener('listening', ready); reject(error); };
    const ready = () => { server.removeListener('error', failed); resolve(server.address()); };
    server.once('error', failed);
    server.once('listening', ready);
    server.listen({ port, host, exclusive: true });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) { resolve(); return; }
    server.close(() => resolve());
  });
}

function createPhoneAccessGateway(options = {}) {
  const controller = options.controller;
  if (!controller || typeof controller.request !== 'function' || typeof controller.listTargets !== 'function') {
    throw new TypeError('A controller facade with listTargets() and request() is required');
  }
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const now = options.now || Date.now;
  const pairingTtlMs = options.pairingTtlMs || PAIRING_TTL_MS;
  const sessionTtlMs = options.sessionTtlMs || SESSION_TTL_MS;
  const closeGraceMs = options.closeGraceMs ?? CLOSE_GRACE_MS;
  const createHttpServer = options.createHttpServer || http.createServer;
  const createHttpsServer = options.createHttpsServer || https.createServer;
  const createWebSocketServer = options.createWebSocketServer
    || ((wsOptions) => new WebSocket.Server(wsOptions));
  const allowEphemeralPort = options.allowEphemeralPort === true;

  const pairings = new Map();
  const sessions = new Map();
  const devices = new Map();
  const rateLimits = new Map();
  const transportSockets = new Set();
  const servers = [];
  let wsServer = null;
  let running = null;
  let caCertificate = null;

  function purgeExpired() {
    const time = now();
    for (const [digest, pairing] of pairings) if (pairing.expiresAt <= time) pairings.delete(digest);
    for (const [digest, session] of sessions) {
      if (session.expiresAt > time) continue;
      sessions.delete(digest);
      const device = devices.get(session.deviceId);
      device?.sessions.delete(digest);
      if (device && device.sessions.size === 0) devices.delete(device.id);
    }
    for (const [address, limit] of rateLimits) if (limit.resetAt <= time) rateLimits.delete(address);
  }

  function publicDevices() {
    purgeExpired();
    return [...devices.values()].map((device) => ({
      id: device.id,
      ...(device.label ? { label: device.label } : {}),
      origin: device.origin,
      lastSeen: new Date(device.lastSeen).toISOString(),
    }));
  }

  function ingressForOrigin(origin) {
    if (!running) return null;
    return running.ingresses.find((ingress) => ingress.origin === origin) || null;
  }

  function authenticate(req, ingress) {
    purgeExpired();
    const secret = cookieValue(req.headers.cookie, SESSION_COOKIE);
    if (!secret || !/^[A-Za-z0-9_-]{43,}$/.test(secret)) return null;
    const digest = tokenDigest(secret);
    const session = sessions.get(digest);
    if (!session || session.origin !== ingress.origin || !safeEqual(session.digest, digest)) return null;
    const device = devices.get(session.deviceId);
    if (!device || device.revoked) return null;
    device.lastSeen = now();
    return device;
  }

  function track(device, resource, cleanupEvent = 'close') {
    if (!device || !resource) return;
    device.resources.add(resource);
    resource.once?.(cleanupEvent, () => device.resources.delete(resource));
  }

  function pairingAllowed(address) {
    const key = String(address || 'unknown');
    const time = now();
    let limit = rateLimits.get(key);
    if (!limit || limit.resetAt <= time) {
      limit = { attempts: 0, resetAt: time + 60_000 };
      rateLimits.set(key, limit);
    }
    limit.attempts += 1;
    return limit.attempts <= 8;
  }

  async function pair(req, res, ingress) {
    if (req.method === 'GET' || req.method === 'HEAD') {
      const nonce = randomBytes(18).toString('base64url');
      const body = Buffer.from(pairingBootstrap(nonce));
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(body.length),
        'cache-control': 'no-store, max-age=0',
        pragma: 'no-cache',
        expires: '0',
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; worker-src 'none'`,
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
      });
      if (req.method === 'HEAD') res.end(); else res.end(body);
      return;
    }
    if (req.method !== 'POST') {
      rejectJson(req, res, 405, { error: 'method_not_allowed' }, { allow: 'GET, HEAD, POST' });
      return;
    }
    if (!pairingAllowed(req.socket.remoteAddress)) {
      rejectJson(req, res, 429, { error: 'pairing_rate_limited' }, { 'retry-after': '60' });
      return;
    }
    const body = await collectJson(req);
    const token = typeof body?.token === 'string' ? body.token : '';
    const digest = tokenDigest(token);
    const pairing = pairings.get(digest);
    if (!pairing || pairing.expiresAt <= now() || pairing.origin !== ingress.origin || !safeEqual(pairing.digest, digest)) {
      json(res, 401, { error: 'invalid_or_expired_pairing' });
      return;
    }
    // Consume the capability before allocating any durable session state.
    pairings.delete(digest);
    const secret = randomBytes(32).toString('base64url');
    if (Buffer.byteLength(secret) < 32) throw new TypeError('The session capability lacks entropy');
    const sessionDigest = tokenDigest(secret);
    const deviceId = randomBytes(16).toString('base64url');
    const label = typeof body.label === 'string'
      ? body.label.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) : '';
    const device = {
      id: deviceId, label, origin: ingress.origin, lastSeen: now(), revoked: false,
      sessions: new Set([sessionDigest]), resources: new Set(),
    };
    devices.set(deviceId, device);
    sessions.set(sessionDigest, {
      digest: sessionDigest, deviceId, origin: ingress.origin, expiresAt: now() + sessionTtlMs,
    });
    json(res, 200, { paired: true, device: { id: deviceId, label, origin: ingress.origin }, redirect: '/' }, {
      'set-cookie': `${SESSION_COOKIE}=${secret}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(sessionTtlMs / 1000)}`,
    });
  }

  function serveCa(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      rejectJson(req, res, 405, { error: 'method_not_allowed' }, { allow: 'GET, HEAD' });
      return;
    }
    if (!caCertificate) {
      json(res, 404, { error: 'ca_certificate_unavailable' });
      return;
    }
    const body = Buffer.isBuffer(caCertificate) ? caCertificate : Buffer.from(caCertificate);
    res.writeHead(200, {
      'content-type': 'application/x-x509-ca-cert',
      'content-disposition': 'attachment; filename="code-agents-webcli-ca.crt"',
      'content-length': String(body.length),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') res.end(); else res.end(body);
  }

  async function proxy(req, res, url, ingress, device) {
    const operation = { abortController: new AbortController(), destroy: () => operation.abortController.abort() };
    track(device, operation, null);
    track(device, req);
    track(device, res);
    let body;
    try {
      const maximumBytes = isAttachmentUpload(req.method, url.pathname) ? MAX_PROXY_BODY : MAX_ROUTING_BODY;
      body = ['GET', 'HEAD'].includes(req.method) ? null : boundedBody(req, maximumBytes);
      if (body) track(device, body);
      const upstream = await controller.request('local', {
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers: proxyRequestHeaders(req.headers),
        body,
        signal: operation.abortController.signal,
      });
      track(device, upstream);
      const responseBody = upstream?.body && typeof upstream.body.pipe === 'function' ? upstream.body : upstream;
      if (responseBody !== upstream) track(device, responseBody);
      const headers = proxyResponseHeaders(upstream?.headers || {});
      res.writeHead(upstream?.statusCode || 502, headers);
      if (req.method === 'HEAD') {
        responseBody?.resume?.();
        res.end();
      } else if (responseBody && typeof responseBody.pipe === 'function') {
        responseBody.once('error', (error) => res.destroy(error));
        res.once('close', () => { if (!res.writableEnded) responseBody.destroy?.(); });
        responseBody.pipe(res);
      } else {
        res.end(responseBody == null ? undefined : responseBody);
      }
    } finally {
      device?.resources.delete(operation);
    }
  }

  async function handleRequest(req, res, ingress) {
    try {
      const url = validateBrowserBoundary(req, ingress);
      if (isControllerPath(url.pathname)) {
        rejectJson(req, res, 404, { error: 'not_found' });
        return;
      }
      if (url.pathname === '/auth/pair' && !url.search) {
        await pair(req, res, ingress);
        return;
      }
      if (url.pathname === '/ca.crt' && !url.search) {
        serveCa(req, res);
        return;
      }
      const publicAsset = (req.method === 'GET' || req.method === 'HEAD') && isSafeImmutableAssetPath(url.pathname);
      const device = authenticate(req, ingress);
      if (!device && !publicAsset) {
        rejectJson(req, res, 401, { error: 'phone_session_required' });
        return;
      }
      await proxy(req, res, url, ingress, device);
    } catch (error) {
      if (res.headersSent) { res.destroy(error); return; }
      rejectJson(req, res, error?.statusCode || 502, { error: error?.statusCode ? 'request_rejected' : 'local_gateway_failure' });
    }
  }

  function rejectUpgrade(socket, statusCode) {
    const reason = statusCode === 401 ? 'Unauthorized' : statusCode === 403 ? 'Forbidden' : 'Bad Request';
    socket.end(`HTTP/1.1 ${statusCode} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }

  function bridgeWebSocket(browser, upstream, device) {
    track(device, browser);
    track(device, upstream);
    const closePeer = (peer, code = 1011, reason = 'Connection closed') => {
      if (peer.readyState === WebSocket.OPEN || peer.readyState === WebSocket.CONNECTING) peer.close?.(code, reason);
    };
    browser.on('message', (data, binary) => {
      if (upstream.readyState !== WebSocket.OPEN) { closePeer(browser, 1011, 'Local server unavailable'); return; }
      upstream.send(data, { binary }, (error) => { if (error) closePeer(browser); });
    });
    upstream.on('message', (data, binary) => {
      if (browser.readyState !== WebSocket.OPEN) return;
      browser.send(data, { binary }, (error) => { if (error) closePeer(upstream); });
    });
    browser.once('close', (code, reason) => closePeer(upstream, code || 1000, reason));
    upstream.once('close', (code, reason) => closePeer(browser, code || 1000, reason));
    browser.on('error', () => closePeer(upstream));
    upstream.on('error', () => closePeer(browser));
  }

  function waitForWebSocketOpen(socket, timeoutMs = 10_000) {
    if (socket?.readyState === WebSocket.OPEN) return Promise.resolve(socket);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket?.removeListener?.('open', opened);
        socket?.removeListener?.('error', failed);
        socket?.removeListener?.('close', closed);
        if (error) reject(error); else resolve(socket);
      };
      const opened = () => finish();
      const failed = (error) => finish(error);
      const closed = () => finish(new Error('The local WebSocket closed before opening'));
      const timer = setTimeout(() => {
        socket?.terminate?.();
        finish(new Error('The local WebSocket did not open in time'));
      }, timeoutMs);
      timer.unref?.();
      socket?.once?.('open', opened);
      socket?.once?.('error', failed);
      socket?.once?.('close', closed);
    });
  }

  async function handleUpgrade(req, socket, head, ingress) {
    let url;
    let upstream;
    try {
      url = validateBrowserBoundary(req, ingress);
      if (isControllerPath(url.pathname)) { rejectUpgrade(socket, 403); return; }
      const device = authenticate(req, ingress);
      if (!device) { rejectUpgrade(socket, 401); return; }
      if (typeof controller.connectWebSocket !== 'function') { rejectUpgrade(socket, 503); return; }
      upstream = await controller.connectWebSocket('local', { path: `${url.pathname}${url.search}` });
      track(device, upstream);
      await waitForWebSocketOpen(upstream);
      if (device.revoked || !devices.has(device.id)) { upstream.close?.(4401, 'Device revoked'); rejectUpgrade(socket, 401); return; }
      wsServer.handleUpgrade(req, socket, head, (browser) => bridgeWebSocket(browser, upstream, device));
    } catch (error) {
      upstream?.close?.(1011, 'Gateway rejected the connection');
      rejectUpgrade(socket, error?.statusCode || 400);
    }
  }

  function attachServer(server, ingress) {
    server.on('connection', (socket) => {
      transportSockets.add(socket);
      socket.once('close', () => transportSockets.delete(socket));
    });
    server.on('request', (req, res) => void handleRequest(req, res, ingress));
    server.on('upgrade', (req, socket, head) => void handleUpgrade(req, socket, head, ingress));
    servers.push(server);
  }

  async function start(config = {}) {
    if (running) throw new Error('Phone access is already running');
    const mode = config.mode;
    if (!['lan', 'tailscale', 'both'].includes(mode)) throw new TypeError('Phone access mode must be lan, tailscale, or both');
    const requestedPort = config.port === undefined ? DEFAULT_PHONE_ACCESS_PORT : config.port;
    if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535
      || (requestedPort > 0 && requestedPort < 1024) || (requestedPort === 0 && !allowEphemeralPort)) {
      throw new TypeError(`The phone access port must be an unprivileged TCP port (default ${DEFAULT_PHONE_ACCESS_PORT})`);
    }
    if ((mode === 'lan' || mode === 'both') && !validLanAddress(config.address)) {
      throw new TypeError('An exact non-loopback LAN interface address is required');
    }
    const tailscaleOrigin = (mode === 'tailscale' || mode === 'both') && config.tailscaleOrigin
      ? exactHttpsOrigin(config.tailscaleOrigin) : null;
    if ((mode === 'lan' || mode === 'both') && (!config.tls?.key || !config.tls?.cert)) {
      throw new TypeError('LAN phone access requires a TLS key and certificate');
    }
    wsServer = createWebSocketServer({ noServer: true, maxPayload: options.maxWebSocketPayload || 4 * 1024 * 1024 });
    caCertificate = config.tls?.ca || null;
    const ingresses = [];
    let selectedPort = requestedPort;
    try {
      if (mode === 'lan' || mode === 'both') {
        const ingress = { kind: 'lan', origin: null };
        const server = createHttpsServer({ key: config.tls.key, cert: config.tls.cert });
        attachServer(server, ingress);
        const address = await listen(server, selectedPort, config.address);
        selectedPort = address.port;
        ingress.origin = formatOrigin('https:', config.address, selectedPort);
        ingresses.push(ingress);
      }
      if (mode === 'tailscale' || mode === 'both') {
        const ingress = { kind: 'tailscale', origin: tailscaleOrigin };
        const server = createHttpServer();
        attachServer(server, ingress);
        const address = await listen(server, selectedPort, '127.0.0.1');
        selectedPort = address.port;
        ingresses.push(ingress);
      }
      running = {
        mode, port: selectedPort, ingresses,
        origins: Object.fromEntries(ingresses.filter((item) => item.origin).map((item) => [item.kind, item.origin])),
      };
      return { mode, port: selectedPort, origins: { ...running.origins } };
    } catch (error) {
      await Promise.allSettled(servers.splice(0).map(closeServer));
      for (const socket of transportSockets) socket.destroy();
      transportSockets.clear();
      wsServer?.close();
      wsServer = null;
      caCertificate = null;
      throw error;
    }
  }

  function createPairing(origin) {
    if (!running) throw new Error('Phone access is not running');
    purgeExpired();
    const selectedOrigin = origin === undefined || origin === null || origin === ''
      ? running.ingresses.find((item) => item.origin)?.origin : exactHttpsOrigin(origin);
    if (!selectedOrigin) throw new Error('This phone ingress does not have a confirmed HTTPS origin yet');
    if (!ingressForOrigin(selectedOrigin)) throw new RangeError('The pairing origin is not an active phone ingress');
    const token = randomBytes(32).toString('base64url');
    if (Buffer.byteLength(token) < 32) throw new TypeError('The pairing capability lacks entropy');
    const digest = tokenDigest(token);
    const expiresAt = now() + pairingTtlMs;
    pairings.set(digest, { digest, origin: selectedOrigin, expiresAt });
    return { url: `${selectedOrigin}/auth/pair#token=${encodeURIComponent(token)}`, origin: selectedOrigin, expiresAt: new Date(expiresAt).toISOString() };
  }

  function setTailscaleOrigin(origin) {
    if (!running) throw new Error('Phone access is not running');
    const ingress = running.ingresses.find((item) => item.kind === 'tailscale');
    if (!ingress) throw new Error('The active phone gateway has no Tailscale backend');
    const normalized = exactHttpsOrigin(origin);
    const previous = ingress.origin;
    if (previous === normalized) return { mode: running.mode, port: running.port, origins: { ...running.origins } };
    // Remove every capability bound to the superseded browser origin before
    // publishing the replacement. No event-loop turn observes mixed policy.
    for (const [digest, pairing] of pairings) if (pairing.origin === previous) pairings.delete(digest);
    for (const device of [...devices.values()]) if (device.origin === previous) revoke(device.id);
    ingress.origin = normalized;
    running.origins = { ...running.origins, tailscale: normalized };
    return { mode: running.mode, port: running.port, origins: { ...running.origins } };
  }

  function revoke(deviceId) {
    const device = devices.get(deviceId);
    if (!device) return false;
    // Invalidate first. Resource callbacks cannot authenticate again while
    // sockets and streams are being torn down.
    device.revoked = true;
    devices.delete(deviceId);
    for (const digest of device.sessions) sessions.delete(digest);
    for (const resource of [...device.resources]) {
      resource.abortController?.abort?.();
      resource.close?.(4401, 'Device revoked');
      resource.terminate?.();
      resource.destroy?.(Object.assign(new Error('Phone device revoked'), { code: 'PHONE_DEVICE_REVOKED' }));
    }
    device.resources.clear();
    return true;
  }

  async function stop() {
    const activeServers = servers.splice(0);
    running = null;
    pairings.clear();
    rateLimits.clear();
    for (const deviceId of [...devices.keys()]) revoke(deviceId);
    sessions.clear();
    const closePromise = Promise.allSettled(activeServers.map(closeServer));
    let timer;
    await Promise.race([
      closePromise,
      new Promise((resolve) => { timer = setTimeout(resolve, closeGraceMs); timer.unref?.(); }),
    ]);
    clearTimeout(timer);
    for (const socket of transportSockets) socket.destroy();
    transportSockets.clear();
    wsServer?.close();
    wsServer = null;
    caCertificate = null;
  }

  return Object.freeze({
    start,
    listen: start,
    stop,
    close: stop,
    createPairing,
    setTailscaleOrigin,
    revoke,
    devices: publicDevices,
    status: () => running ? { mode: running.mode, port: running.port, origins: { ...running.origins }, devices: publicDevices() } : null,
    address: () => running ? { mode: running.mode, port: running.port, origins: { ...running.origins } } : null,
  });
}

module.exports = {
  CLOSE_GRACE_MS,
  DEFAULT_PHONE_ACCESS_PORT,
  MAX_PAIRING_BODY,
  MAX_PROXY_BODY,
  MAX_ROUTING_BODY,
  PAIRING_TTL_MS,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  boundedBody,
  createPhoneAccessGateway,
  duplicateSecurityHeader,
  exactHttpsOrigin,
  isSafeImmutableAssetPath,
  isAttachmentUpload,
  isControllerPath,
  proxyRequestHeaders,
  proxyResponseHeaders,
  safeRedirect,
  validLanAddress,
  validateBrowserBoundary,
};
