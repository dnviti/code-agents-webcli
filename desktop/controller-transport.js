'use strict';

const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const { Readable } = require('node:stream');
const WebSocket = require('ws');

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_IDENTITY_BYTES = 64 * 1024;
const PRODUCT_ID = 'code-agents-webcli';
const PROTOCOL_VERSION = 1;
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const UNSAFE_FORWARDED_HEADERS = new Set([
  'cookie',
  'forwarded',
  'host',
  'origin',
  'set-cookie',
  'via',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
]);

class ControllerTransportError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'ControllerTransportError';
    this.code = code;
    this.category = options.category || categoryForCode(code);
    if (options.origin) this.origin = options.origin;
    if (options.fingerprint256) this.fingerprint256 = options.fingerprint256;
    if (options.certificate) this.certificate = options.certificate;
    if (options.tlsReason) this.tlsReason = options.tlsReason;
    if (options.requiresRenewedApproval) this.requiresRenewedApproval = true;
    if (options.statusCode) this.statusCode = options.statusCode;
    if (options.details) this.details = options.details;
  }
}

function categoryForCode(code) {
  if (code === 'DNS_FAILURE') return 'dns';
  if (code === 'UNREACHABLE') return 'unreachable';
  if (code === 'TLS_CERTIFICATE' || code === 'TLS_CERTIFICATE_CHANGED') return 'tls-certificate';
  if (code === 'AUTH_REQUIRED') return 'auth-required';
  if (code === 'UNSUPPORTED_PROTOCOL' || code === 'HTTPS_REQUIRED') return 'unsupported-protocol';
  if (code === 'UNRELATED_RESPONSE') return 'unrelated-response';
  if (code === 'INCOMPATIBLE_RESPONSE') return 'incompatible-response';
  return 'request-failed';
}

function canonicalTarget(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ControllerTransportError('INVALID_TARGET', 'A remote server address is required.');
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch (cause) {
    throw new ControllerTransportError('INVALID_TARGET', 'The remote server address is not a valid URL.', { cause });
  }
  if (url.protocol !== 'https:') {
    throw new ControllerTransportError(
      'HTTPS_REQUIRED',
      'Remote servers must use HTTPS.',
      { origin: url.origin },
    );
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new ControllerTransportError(
      'INVALID_TARGET',
      'The remote server address must be an HTTPS origin without credentials, a path, query, or fragment.',
    );
  }
  return url.origin;
}

function normalizeFingerprint256(value) {
  if (value === undefined || value === null || value === '') return null;
  const compact = String(value).trim().replaceAll(':', '').toUpperCase();
  if (!/^[A-F0-9]{64}$/.test(compact)) {
    throw new ControllerTransportError(
      'INVALID_CERTIFICATE_APPROVAL',
      'The approved certificate fingerprint must be a SHA-256 fingerprint.',
    );
  }
  return compact.match(/.{2}/g).join(':');
}

function peerFingerprint256(certificate) {
  if (!certificate || typeof certificate !== 'object') return null;
  if (certificate.fingerprint256) {
    try {
      return normalizeFingerprint256(certificate.fingerprint256);
    } catch {
      return null;
    }
  }
  return null;
}

function certificateSummary(certificate) {
  if (!certificate || typeof certificate !== 'object' || Object.keys(certificate).length === 0) return null;
  const summary = {
    fingerprint256: peerFingerprint256(certificate),
  };
  const subject = certificate.subject && typeof certificate.subject === 'object'
    ? certificate.subject : null;
  const issuer = certificate.issuer && typeof certificate.issuer === 'object'
    ? certificate.issuer : null;
  if (subject?.CN) summary.subject = String(subject.CN);
  if (issuer?.CN) summary.issuer = String(issuer.CN);
  if (certificate.valid_from) summary.validFrom = String(certificate.valid_from);
  if (certificate.valid_to) summary.validTo = String(certificate.valid_to);
  if (certificate.serialNumber) summary.serialNumber = String(certificate.serialNumber);
  return summary;
}

function sanitizeRequestHeaders(input = {}, options = {}) {
  const connectionTokens = new Set();
  for (const [rawName, rawValue] of Object.entries(input || {})) {
    if (rawName.toLowerCase() !== 'connection') continue;
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      for (const token of String(value || '').split(',')) connectionTokens.add(token.trim().toLowerCase());
    }
  }

  const output = {};
  for (const [rawName, value] of Object.entries(input || {})) {
    const name = rawName.toLowerCase();
    if (
      !name
      || HOP_BY_HOP_HEADERS.has(name)
      || UNSAFE_FORWARDED_HEADERS.has(name)
      || connectionTokens.has(name)
      || name.startsWith('proxy-')
      || name.startsWith('sec-websocket-')
    ) continue;
    output[name] = value;
  }
  if (options.rewriteOrigin && options.targetOrigin) output.origin = options.targetOrigin;
  return output;
}

function cookieHeader(cookies) {
  if (!cookies) return '';
  if (typeof cookies === 'string') {
    if (/\r|\n/.test(cookies)) throw new ControllerTransportError('INVALID_COOKIE', 'The cookie provider returned an invalid cookie header.');
    return cookies.trim();
  }
  if (!Array.isArray(cookies)) {
    throw new ControllerTransportError('INVALID_COOKIE', 'The cookie provider must return a cookie header or cookie records.');
  }
  return cookies.map((cookie) => {
    if (!cookie || typeof cookie.name !== 'string' || typeof cookie.value !== 'string') {
      throw new ControllerTransportError('INVALID_COOKIE', 'The cookie provider returned an invalid cookie record.');
    }
    if (/[^\x21-\x7E]|[;=]/.test(cookie.name) || /[\r\n;]/.test(cookie.value)) {
      throw new ControllerTransportError('INVALID_COOKIE', 'The cookie provider returned an unsafe cookie record.');
    }
    return `${cookie.name}=${cookie.value}`;
  }).join('; ');
}

function classifyTransportError(error, origin) {
  if (error instanceof ControllerTransportError) return error;
  const code = error && typeof error.code === 'string' ? error.code : '';
  // Cancellation is caller intent, not target health.  Preserve the standard
  // abort shape so the runtime can distinguish it from a network outage and
  // callers can retry without translating it through a generic transport
  // failure.
  if (code === 'ABORT_ERR' || error?.name === 'AbortError') return error;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_FAIL') {
    return new ControllerTransportError('DNS_FAILURE', 'The server name could not be resolved.', {
      cause: error,
      origin,
    });
  }
  if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE'].includes(code)) {
    return new ControllerTransportError('UNREACHABLE', 'The server could not be reached.', {
      cause: error,
      origin,
    });
  }
  if (code === 'EPROTO' || code === 'ERR_SSL_WRONG_VERSION_NUMBER') {
    return new ControllerTransportError('UNSUPPORTED_PROTOCOL', 'The server did not negotiate HTTPS.', {
      cause: error,
      origin,
    });
  }
  if (
    code.startsWith('ERR_TLS_')
    || ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
      'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(code)
  ) {
    return new ControllerTransportError('TLS_CERTIFICATE', 'The server certificate could not be verified.', {
      cause: error,
      origin,
      tlsReason: code || error.message,
    });
  }
  return new ControllerTransportError('REQUEST_FAILED', 'The request to the server failed.', {
    cause: error,
    origin,
    statusCode: error?.statusCode,
  });
}

function exactTargetUrl(origin, value, websocket = false) {
  let url;
  try {
    url = value instanceof URL ? new URL(value.href) : new URL(value || '/', origin);
  } catch (cause) {
    throw new ControllerTransportError('INVALID_REQUEST_URL', 'The request URL is invalid.', { cause, origin });
  }
  if (websocket && url.protocol === 'https:') url.protocol = 'wss:';
  const expectedProtocol = websocket ? 'wss:' : 'https:';
  const comparableOrigin = websocket
    ? `${url.protocol === 'wss:' ? 'https:' : url.protocol}//${url.host}`
    : url.origin;
  if (url.protocol !== expectedProtocol || comparableOrigin !== origin || url.username || url.password) {
    throw new ControllerTransportError(
      'TARGET_ORIGIN_MISMATCH',
      'The transport refuses to send a request outside its verified server origin.',
      { origin },
    );
  }
  return url;
}

function abortedRequestError() {
  const error = Object.assign(new Error('The request was aborted.'), { code: 'ABORT_ERR' });
  error.name = 'AbortError';
  return error;
}

function connectTls({ origin, ca, timeoutMs, tlsConnect, signal }) {
  const target = new URL(origin);
  const options = {
    host: target.hostname,
    port: target.port ? Number(target.port) : 443,
    rejectUnauthorized: false,
    ...(net.isIP(target.hostname) ? {} : { servername: target.hostname }),
    ...(ca === undefined ? {} : { ca }),
  };

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortedRequestError());
      return;
    }
    let settled = false;
    let socket;
    const abort = () => {
      const error = abortedRequestError();
      socket?.destroy(error);
      finishError(error);
    };
    const cleanup = () => signal?.removeEventListener?.('abort', abort);
    const finishError = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(classifyTransportError(error, origin));
    };
    const timer = setTimeout(() => {
      const error = Object.assign(new Error('TLS connection timed out.'), { code: 'ETIMEDOUT' });
      socket?.destroy(error);
      finishError(error);
    }, timeoutMs);
    try {
      socket = tlsConnect(options, () => {
        if (settled) return;
        try {
          const certificate = socket.getPeerCertificate(true);
          const summary = certificateSummary(certificate);
          const fingerprint256 = peerFingerprint256(certificate);
          settled = true;
          clearTimeout(timer);
          cleanup();
          // Keep the now-inert error listener during the short interval between
          // certificate verification and handing the socket to HTTPS/ws. A
          // disconnect in that interval must become a request failure, not an
          // unhandled EventEmitter 'error'.
          resolve({
            socket,
            authorized: socket.authorized === true,
            authorizationError: socket.authorizationError || null,
            certificate: summary,
            fingerprint256,
          });
        } catch (error) {
          socket.destroy(error);
          finishError(error);
        }
      });
      socket.once('error', finishError);
      signal?.addEventListener?.('abort', abort, { once: true });
    } catch (error) {
      finishError(error);
    }
  });
}

function rejectInvalidCertificate(connection, origin, approvedFingerprint256) {
  if (connection.authorized) return;
  const approved = normalizeFingerprint256(approvedFingerprint256);
  const presented = connection.fingerprint256;
  if (approved && presented && approved === presented) return;

  connection.socket.destroy();
  const changed = Boolean(approved && presented && approved !== presented);
  throw new ControllerTransportError(
    changed ? 'TLS_CERTIFICATE_CHANGED' : 'TLS_CERTIFICATE',
    changed
      ? 'The server presented a different invalid certificate. Renew approval before reconnecting.'
      : 'The server certificate is invalid and requires explicit approval.',
    {
      origin,
      fingerprint256: presented || undefined,
      certificate: connection.certificate || undefined,
      tlsReason: connection.authorizationError || 'CERTIFICATE_INVALID',
      requiresRenewedApproval: changed,
    },
  );
}

function oneShotAgent(socket) {
  const agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
  let used = false;
  agent.createConnection = (_options, callback) => {
    if (used) {
      const error = new Error('The verified TLS socket cannot be reused.');
      callback?.(error);
      throw error;
    }
    used = true;
    callback?.(null, socket);
    return socket;
  };
  return agent;
}

function requestWithSocket({ requestImpl, url, method, headers, body, socket, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const agent = oneShotAgent(socket);
    let request;
    let settled = false;
    const abort = () => request?.destroy(abortedRequestError());
    const cleanup = () => signal?.removeEventListener?.('abort', abort);
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      agent.destroy();
      reject(error);
    };
    if (signal?.aborted) {
      socket.destroy(abortedRequestError());
      fail(abortedRequestError());
      return;
    }
    try {
      request = requestImpl(url, { method, headers, agent }, (response) => {
        if (settled) {
          response.destroy();
          return;
        }
        settled = true;
        cleanup();
        resolve(response);
      });
      signal?.addEventListener?.('abort', abort, { once: true });
      request.once('error', fail);
      request.setTimeout?.(timeoutMs, () => {
        const error = Object.assign(new Error('HTTPS request timed out.'), { code: 'ETIMEDOUT' });
        request.destroy(error);
      });
      if (body === undefined || body === null) {
        request.end();
      } else if (body instanceof Readable || (body && typeof body.pipe === 'function')) {
        const abortBody = () => request.destroy(Object.assign(new Error('The upload was aborted.'), { code: 'ECONNRESET' }));
        body.once?.('error', (error) => request.destroy(error));
        body.once?.('aborted', abortBody);
        request.once('close', () => {
          if (!request.writableEnded && !body.destroyed) body.destroy?.();
          body.removeListener?.('aborted', abortBody);
          cleanup();
        });
        body.pipe(request);
      } else {
        request.end(body);
      }
    } catch (error) {
      socket.destroy();
      fail(error);
    }
  });
}

function setCookiesFromResponse(response, cookieSink, origin, url) {
  if (!cookieSink) return Promise.resolve();
  const values = response.headers?.['set-cookie'];
  if (!values) return Promise.resolve();
  const cookies = Array.isArray(values) ? [...values] : [values];
  return Promise.resolve(cookieSink(origin, cookies, url.href));
}

async function readJsonResponse(response, maximumBytes = MAX_IDENTITY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > maximumBytes) {
      response.destroy();
      throw new ControllerTransportError('UNRELATED_RESPONSE', 'The server identity response was unexpectedly large.');
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new ControllerTransportError('UNRELATED_RESPONSE', 'The address did not return a CODE AGENTS identity response.', { cause });
  }
}

function validateIdentity(identity, origin, supportedProtocolVersion = PROTOCOL_VERSION) {
  if (!identity || typeof identity !== 'object' || identity.product?.id !== PRODUCT_ID) {
    throw new ControllerTransportError(
      'UNRELATED_RESPONSE',
      'The address is reachable but is not a CODE AGENTS server.',
      { origin },
    );
  }
  if (identity.protocolVersion !== supportedProtocolVersion) {
    throw new ControllerTransportError(
      'UNSUPPORTED_PROTOCOL',
      `The server controller protocol (${String(identity.protocolVersion)}) is not supported.`,
      { origin, details: { presented: identity.protocolVersion, supported: supportedProtocolVersion } },
    );
  }
  if (
    typeof identity.version !== 'string'
    || typeof identity.serverName !== 'string'
    || !Array.isArray(identity.capabilities)
    || !identity.capabilities.includes('remote-controller')
  ) {
    throw new ControllerTransportError(
      'INCOMPATIBLE_RESPONSE',
      'The server identity is incomplete or does not support remote controllers.',
      { origin },
    );
  }
  let advertisedOrigin;
  try {
    advertisedOrigin = canonicalTarget(identity.address);
  } catch (cause) {
    throw new ControllerTransportError(
      'INCOMPATIBLE_RESPONSE',
      'The server advertised an invalid controller address.',
      { origin, cause },
    );
  }
  if (advertisedOrigin !== origin) {
    throw new ControllerTransportError(
      'INCOMPATIBLE_RESPONSE',
      'The server identity does not match the verified address.',
      { origin, details: { advertisedOrigin } },
    );
  }
  return identity;
}

function createControllerTransport(options = {}) {
  const origin = canonicalTarget(options.origin || options.targetOrigin);
  const approval = options.certificateApproval || options.certificateOverride;
  if (approval && canonicalTarget(approval.origin) !== origin) {
    throw new ControllerTransportError(
      'INVALID_CERTIFICATE_APPROVAL',
      'A certificate approval can only be used for its exact server origin.',
      { origin },
    );
  }
  const approvedFingerprint256 = normalizeFingerprint256(
    approval?.fingerprint256
      || approval?.fingerprint
      || options.approvedFingerprint256
      || options.approvedFingerprint,
  );
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const cookieProvider = options.cookieProvider || (async () => '');
  const cookieSink = options.cookieSink || null;
  const tlsConnect = options.tlsConnect || tls.connect;
  const requestImpl = options.requestImpl || https.request;
  const createWebSocket = options.createWebSocket
    || ((url, protocols, wsOptions) => new WebSocket(url, protocols, wsOptions));

  async function openApprovedSocket(signal) {
    const connection = await connectTls({
      origin,
      ca: options.ca,
      timeoutMs,
      tlsConnect,
      signal,
    });
    rejectInvalidCertificate(connection, origin, approvedFingerprint256);
    return connection;
  }

  async function probeCertificate() {
    const connection = await connectTls({
      origin,
      ca: options.ca,
      timeoutMs,
      tlsConnect,
    });
    connection.socket.destroy();
    return {
      origin,
      valid: connection.authorized,
      authorizationError: connection.authorizationError,
      fingerprint256: connection.fingerprint256,
      certificate: connection.certificate,
      approved: !connection.authorized
        && Boolean(approvedFingerprint256)
        && approvedFingerprint256 === connection.fingerprint256,
      changed: !connection.authorized
        && Boolean(approvedFingerprint256)
        && approvedFingerprint256 !== connection.fingerprint256,
    };
  }

  async function requestTarget(requestOptions = {}) {
    const url = exactTargetUrl(origin, requestOptions.url || requestOptions.path || '/');
    const connection = await openApprovedSocket(requestOptions.signal);
    try {
      const sourceHeaders = requestOptions.headers || {};
      const headers = sanitizeRequestHeaders(sourceHeaders, {
        rewriteOrigin: Object.keys(sourceHeaders).some((name) => name.toLowerCase() === 'origin'),
        targetOrigin: origin,
      });
      if (requestOptions.useCookies !== false) {
        const suppliedCookies = cookieHeader(await cookieProvider(origin, url.href));
        if (suppliedCookies) headers.cookie = suppliedCookies;
      }
      const response = await requestWithSocket({
        requestImpl,
        url,
        method: requestOptions.method || 'GET',
        headers,
        body: requestOptions.body,
        socket: connection.socket,
        timeoutMs: requestOptions.timeoutMs || timeoutMs,
        signal: requestOptions.signal,
      });
      if (requestOptions.useCookies !== false) {
        await setCookiesFromResponse(response, cookieSink, origin, url);
      }
      return response;
    } catch (error) {
      connection.socket.destroy();
      throw classifyTransportError(error, origin);
    }
  }

  async function connectTargetWebSocket(webSocketOptions = {}) {
    const url = exactTargetUrl(origin, webSocketOptions.url || webSocketOptions.path || '/', true);
    const connection = await openApprovedSocket();
    try {
      const headers = sanitizeRequestHeaders(webSocketOptions.headers || {}, {
        rewriteOrigin: true,
        targetOrigin: origin,
      });
      if (webSocketOptions.useCookies !== false) {
        const suppliedCookies = cookieHeader(await cookieProvider(origin, url.href));
        if (suppliedCookies) headers.cookie = suppliedCookies;
      }
      const socket = createWebSocket(
        url.href,
        webSocketOptions.protocols || [],
        {
          ...(webSocketOptions.options || {}),
          agent: oneShotAgent(connection.socket),
          followRedirects: false,
          headers,
        },
      );
      if (webSocketOptions.useCookies !== false && cookieSink && socket && typeof socket.on === 'function') {
        socket.on('upgrade', (response) => {
          void setCookiesFromResponse(response, cookieSink, origin, url).catch((error) => {
            socket.emit('cookie-error', classifyTransportError(error, origin));
            socket.close?.();
          });
        });
      }
      // Constructing a ws client only starts the HTTP upgrade. Treating that
      // object as connected fabricates a successful contact for 401 responses
      // and other failed handshakes. Resolve only once the exact target has
      // accepted the upgrade; classify the response while it is still visible.
      await new Promise((resolve, reject) => {
        if (socket.readyState === WebSocket.OPEN) {
          resolve();
          return;
        }
        let settled = false;
        const cleanup = () => {
          clearTimeout(timer);
          socket.removeListener?.('open', opened);
          socket.removeListener?.('error', failed);
          socket.removeListener?.('close', closed);
          socket.removeListener?.('unexpected-response', unexpectedResponse);
        };
        const finish = (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (error) reject(error);
          else resolve();
        };
        const opened = () => finish();
        const failed = (error) => finish(classifyTransportError(error, origin));
        const closed = () => finish(new ControllerTransportError(
          'UNREACHABLE',
          'The server closed the WebSocket before accepting it.',
          { origin },
        ));
        const unexpectedResponse = (_request, response) => {
          response.resume?.();
          const statusCode = response.statusCode || 0;
          finish(new ControllerTransportError(
            statusCode === 401 ? 'AUTH_REQUIRED' : 'REQUEST_FAILED',
            statusCode === 401
              ? 'Sign in to this server to continue.'
              : `The server refused the WebSocket upgrade with HTTP ${statusCode || 'an unknown status'}.`,
            { origin, statusCode: statusCode || undefined },
          ));
        };
        const timer = setTimeout(() => {
          socket.terminate?.();
          finish(new ControllerTransportError(
            'UNREACHABLE',
            'The server did not accept the WebSocket in time.',
            { origin },
          ));
        }, webSocketOptions.timeoutMs || timeoutMs);
        socket.once('open', opened);
        socket.once('error', failed);
        socket.once('close', closed);
        socket.once('unexpected-response', unexpectedResponse);
      });
      return socket;
    } catch (error) {
      connection.socket.destroy();
      throw classifyTransportError(error, origin);
    }
  }

  async function verifyTarget(verifyOptions = {}) {
    const response = await requestTarget({
      path: '/api/identity',
      method: 'GET',
      headers: { accept: 'application/json' },
      useCookies: false,
    });
    if (response.statusCode === 401 || response.statusCode === 403) {
      response.resume();
      throw new ControllerTransportError(
        'AUTH_REQUIRED',
        'The server requires sign-in before it can be verified.',
        { origin, statusCode: response.statusCode },
      );
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.resume();
      throw new ControllerTransportError(
        'UNRELATED_RESPONSE',
        `The address returned HTTP ${response.statusCode} instead of a server identity.`,
        { origin, statusCode: response.statusCode },
      );
    }
    try {
      const identity = await readJsonResponse(response);
      return validateIdentity(identity, origin, verifyOptions.supportedProtocolVersion || PROTOCOL_VERSION);
    } catch (error) {
      throw classifyTransportError(error, origin);
    }
  }

  return Object.freeze({
    origin,
    approvedFingerprint256,
    probeCertificate,
    requestTarget,
    connectTargetWebSocket,
    verifyTarget,
  });
}

module.exports = {
  ControllerTransportError,
  PRODUCT_ID,
  PROTOCOL_VERSION,
  canonicalTarget,
  certificateSummary,
  classifyTransportError,
  createControllerTransport,
  normalizeFingerprint256,
  peerFingerprint256,
  sanitizeRequestHeaders,
  validateIdentity,
};
