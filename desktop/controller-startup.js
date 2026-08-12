'use strict';

const {
  validPersistedPort,
  writeControllerPort,
} = require('./controller-endpoint.js');

const RECOVERABLE_PERSISTED_BIND_ERRORS = new Set(['EACCES', 'EADDRINUSE']);

function recoverablePersistedBindError(error) {
  return RECOVERABLE_PERSISTED_BIND_ERRORS.has(error?.code);
}

async function closeAfterFailure(gateway, error) {
  try {
    await gateway?.close?.();
  } catch (closeError) {
    if (error && error.cause === undefined) error.cause = closeError;
  }
  throw error;
}

async function bindGateway(createGateway, gatewayOptions, port) {
  let gateway;
  try {
    gateway = createGateway({ ...gatewayOptions, port });
    const endpoint = await gateway.listen();
    if (!endpoint || !validPersistedPort(endpoint.port)) {
      throw new TypeError('The controller gateway returned an invalid listening port');
    }
    return { gateway, endpoint };
  } catch (error) {
    return closeAfterFailure(gateway, error);
  }
}

/**
 * Bind the desktop controller to its stable origin, repairing a stale Windows
 * port reservation exactly once. Server data never lives at this origin; the
 * persisted port exists only to keep renderer preferences stable.
 */
async function startControllerGateway({
  createGateway,
  gatewayOptions,
  persistedPort,
  endpointFile,
  writePort = writeControllerPort,
}) {
  if (typeof createGateway !== 'function') throw new TypeError('A controller gateway factory is required');
  if (persistedPort !== 0 && !validPersistedPort(persistedPort)) {
    throw new TypeError('The persisted controller port is invalid');
  }

  let started;
  let recoveredFrom = null;
  try {
    started = await bindGateway(createGateway, gatewayOptions, persistedPort);
  } catch (error) {
    if (persistedPort === 0 || !recoverablePersistedBindError(error)) throw error;
    recoveredFrom = { port: persistedPort, code: error.code };
    try {
      started = await bindGateway(createGateway, gatewayOptions, 0);
    } catch (fallbackError) {
      if (fallbackError && fallbackError.cause === undefined) fallbackError.cause = error;
      throw fallbackError;
    }
  }

  try {
    if (started.endpoint.port !== persistedPort) {
      await writePort(endpointFile, started.endpoint.port);
    }
  } catch (error) {
    return closeAfterFailure(started.gateway, error);
  }
  return { ...started, recoveredFrom };
}

module.exports = {
  recoverablePersistedBindError,
  startControllerGateway,
};
