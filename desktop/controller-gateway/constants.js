'use strict';

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

module.exports = {
  CONTROLLER_AUTH_HEADER,
  CONTROLLER_HEADER,
  DEFAULT_UPSTREAM_RECONNECT_MS,
  HOP_BY_HOP,
  MAX_AGGREGATE_BODY,
  MAX_ATTACHMENT_BYTES,
  MAX_ROUTING_BODY,
  MIME_TYPES,
};