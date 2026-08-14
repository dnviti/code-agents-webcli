'use strict';

const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const WebSocket = require('ws');

const {
  CONTROLLER_AUTH_HEADER,
  CONTROLLER_HEADER,
  HOP_BY_HOP,
  MAX_ATTACHMENT_BYTES,
  MAX_ROUTING_BODY,
} = require('./constants.js');

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

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function socketOpen(socket) {
  return socket && socket.readyState === WebSocket.OPEN;
}

module.exports = {
  bodyStream,
  boundedAttachmentBody,
  declaredBodyLength,
  encodeBody,
  errorMessage,
  isAttachmentUpload,
  json,
  lastActivity,
  parseJsonBody,
  pipeResponseBody,
  proxyRequestHeaders,
  proxyResponseHeaders,
  readBody,
  safeEqual,
  socketOpen,
};