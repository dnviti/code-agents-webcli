'use strict';

/**
 * Desktop controller gateway entry point.
 *
 * Originally a single 1,340-line file; this is now a thin re-export facade
 * over the cohesive modules in the `controller-gateway/` subfolder. The
 * public surface is unchanged — every key, arity, and default is preserved.
 */

const {
  CONTROLLER_HEADER,
  CONTROLLER_AUTH_HEADER,
  DEFAULT_UPSTREAM_RECONNECT_MS,
  MAX_ATTACHMENT_BYTES,
  MAX_AGGREGATE_BODY,
} = require('./controller-gateway/constants.js');

const {
  createControllerGateway,
  isAttachedStreamMessage,
} = require('./controller-gateway/gateway.js');

const {
  proxyRequestHeaders,
  proxyResponseHeaders,
} = require('./controller-gateway/http-util.js');

const {
  publicActionResult,
  publicTarget,
} = require('./controller-gateway/public-targets.js');

const { safeStaticFile } = require('./controller-gateway/static-files.js');

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