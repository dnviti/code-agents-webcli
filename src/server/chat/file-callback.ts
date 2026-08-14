/**
 * A filesystem callback channel for agents running somewhere a Unix socket
 * cannot reach (a remote engine or a Kubernetes pod).
 *
 * The shared home is an untrusted transport. Request, reply, cancellation, and
 * heartbeat files are authenticated and encrypted with the endpoint's random
 * session token. The endpoint root is sealed after generated runtime artifacts
 * are installed, and every operation verifies that its directories have not
 * been replaced. Cleanup only unlinks non-directories and never follows a
 * symlink or recursively walks an attacker-controlled path.
 *
 * Implementation lives in ./file-callback/*.
 */

export type { FileCallbackBrokerOptions } from './file-callback/types.js';
export type { FileCallbackClientOptions } from './file-callback/types.js';
export type { FileCallbackEndpoint } from './file-callback/types.js';
export type { FileCallbackFilesystemOperation } from './file-callback/types.js';
export type { FileCallbackHandler } from './file-callback/types.js';
export type { FileCallbackKind } from './file-callback/types.js';
export type { FileCallbackReply } from './file-callback/types.js';
export type { FileCallbackRequest } from './file-callback/types.js';
export type { FileCallbackTestHooks } from './file-callback/types.js';
export { FileCallbackBroker } from './file-callback/broker.js';
export { FILE_CALLBACK_GENERATED_CLIENT_SOURCE } from './file-callback/generated-client.js';
export { requestFileCallback } from './file-callback/client.js';
