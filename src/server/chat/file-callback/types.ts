import * as fsp from 'fs/promises';

export type FileCallbackKind = 'question' | 'plan' | (string & {});

export interface FileCallbackEndpoint {
  /** Absolute path as seen by the process that is going to use it. */
  directory: string;
  /** Secret encryption key material; do not put it in a file, log, or transcript. */
  token: string;
}

export interface FileCallbackRequest {
  id: string;
  kind: FileCallbackKind;
  payload: unknown;
  createdAt: number;
}

export interface FileCallbackReply {
  id: string;
  result?: unknown;
  error?: string;
  cancelled?: boolean;
}

export interface FileCallbackBrokerOptions {
  /** Polling is portable to NFS/claim-backed homes; fs.watch is not. */
  pollMs?: number;
  /** Optional ceiling for non-question/test operations; questions ignore it. */
  requestTimeoutMs?: number;
  /** Age at which orphaned requests/replies/cancellation markers are removed. */
  cleanupAfterMs?: number;
  testHooks?: FileCallbackTestHooks;
}

export type FileCallbackFilesystemOperation = 'read' | 'write' | 'unlink' | 'cleanup';

export interface FileCallbackTestHooks {
  /** Deterministic race injection for security tests; never set by production composition. */
  afterDirectoryOpened?(
    operation: FileCallbackFilesystemOperation,
    directory: string,
  ): void | Promise<void>;
}

export type FileCallbackHandler = (
  request: FileCallbackRequest,
  signal: AbortSignal,
) => Promise<unknown>;

export interface FileCallbackClientOptions {
  pollMs?: number;
  /** Optional ceiling for non-question/test operations; questions ignore it. */
  timeoutMs?: number;
  signal?: AbortSignal;
  testHooks?: FileCallbackTestHooks;
}

export const ID = /^[A-Za-z0-9_-]{12,128}$/;
export const ENDPOINT_NAME = /^[a-f0-9]{32}$/;
export const DEFAULT_POLL_MS = 200;
// Request timeouts are deliberately opt-in. A human question may remain open
// indefinitely while heartbeat/liveness still detects a dead server promptly.
export const DEFAULT_CLEANUP_MS = 25 * 24 * 60 * 60_000;
export const HEARTBEAT_MS = 2_000;
export const HEARTBEAT_STALE_MS = 10_000;
export const MAX_LEASE_MS = 60_000;
export const MAX_ENVELOPE_BYTES = 2 * 1024 * 1024;
export const CALLBACK_VERSION = 1;
export const AAD_PREFIX = 'ccweb-file-callback-v1:';

export type CriticalDirectoryName = 'requests' | 'replies' | 'cancelled';

export interface DirectoryIdentity {
  dev: number;
  ino: number;
}

export interface DirectoryRef extends DirectoryIdentity {
  path: string;
}

export interface BrokerLayout {
  base: DirectoryRef;
  endpoint: DirectoryRef;
  requests: DirectoryRef;
  replies: DirectoryRef;
  cancelled: DirectoryRef;
  pi: DirectoryRef;
  piCcweb: DirectoryRef;
}

export interface ClientLayout {
  base: DirectoryRef;
  endpoint: DirectoryRef;
  requests: DirectoryRef;
  replies: DirectoryRef;
  cancelled: DirectoryRef;
}

export interface EncryptedEnvelope {
  v: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface OpenDirectory {
  handle: fsp.FileHandle;
  identity: DirectoryIdentity;
  accessPath: string;
}

export class UnsafeCallbackPathError extends Error {
  constructor(file: string) {
    super(`unsafe file callback path: ${file}`);
    this.name = 'UnsafeCallbackPathError';
  }
}

export class InvalidCallbackEnvelopeError extends Error {
  constructor() {
    super('invalid encrypted file callback envelope');
    this.name = 'InvalidCallbackEnvelopeError';
  }
}

export function requestName(id: string): string { return `${id}.json`; }
export function cancelName(id: string): string { return `${id}.cancel`; }
export function replyName(id: string): string { return `${id}.json`; }
export function aad(kind: 'request' | 'reply' | 'cancel', id: string): string { return `${AAD_PREFIX}${kind}:${id}`; }

export function sameDirectory(actual: DirectoryIdentity, expected: DirectoryIdentity): boolean {
  return actual.dev === expected.dev && actual.ino === expected.ino;
}
