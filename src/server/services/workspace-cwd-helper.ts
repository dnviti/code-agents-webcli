import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { WorkspaceStorageDirectoryLease } from './workspace-session-storage.js';

const MAX_FILE_BYTES = 24 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 34 * 1024 * 1024;
const MAX_STAT_DECIMAL_DIGITS = 32;
const HELPER_TIMEOUT_MS = 15_000;
const BROKER_WAIT_GRACE_MS = 2_000;
const BROKER_STARTUP_TIMEOUT_MS = 2_000;
const BROKER_COOLDOWN_BASE_MS = 1_000;
const BROKER_COOLDOWN_MAX_MS = 30_000;
const BROKER_STARTING = 0;
const BROKER_IDLE = 1;
const BROKER_PENDING = 2;
const BROKER_COMPLETE = 3;
const BROKER_FATAL = 4;
const BROKER_TRANSPORT_ERROR = 'WORKSPACE_HELPER_TRANSPORT';
let smokeReported = false;

interface WorkspaceCwdHelperBroker {
  readonly worker: Worker;
  readonly control: Int32Array;
  readonly response: Uint8Array;
  requestId: number;
  closed: boolean;
}

let helperBroker: WorkspaceCwdHelperBroker | null = null;
let helperBrokerExecutableForTests: string | null = null;
let helperBrokerFailure: {
  readonly message: string;
  readonly cause?: unknown;
  readonly failures: number;
  readonly retryAt: number;
} | null = null;

export interface WorkspaceCwdHelperSpawnResult {
  readonly error?: Error;
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type WorkspaceCwdHelperSpawner = (
  executable: string,
  args: string[],
  options: {
    cwd: string; env: NodeJS.ProcessEnv; input: string; encoding: 'utf8';
    timeout: number; maxBuffer: number; windowsHide: boolean;
  },
) => WorkspaceCwdHelperSpawnResult;

const productionSpawner: WorkspaceCwdHelperSpawner = (executable, args, options) =>
  spawnSync(executable, args, options) as WorkspaceCwdHelperSpawnResult;
let helperSpawner = productionSpawner;

/** Source-level seam for deterministic broker failure/race tests; reset with `null`. */
export function setWorkspaceCwdHelperSpawnerForTests(
  spawner: WorkspaceCwdHelperSpawner | null,
): void {
  closeWorkspaceCwdHelpers();
  helperBrokerExecutableForTests = null;
  helperSpawner = spawner ?? productionSpawner;
}

/** Source-level seam for exercising the real broker's child-start failure path. */
export function setWorkspaceCwdHelperBrokerExecutableForTests(executable: string | null): void {
  if (executable !== null && (!path.isAbsolute(executable) || path.resolve(executable) !== executable)) {
    throw new Error('Workspace cwd helper broker test executable must be an absolute canonical path');
  }
  closeWorkspaceCwdHelpers();
  helperBrokerExecutableForTests = executable;
}

function helperEnvironment(): NodeJS.ProcessEnv {
  return process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {};
}

function brokerTransportError(message: string, cause?: unknown): NodeJS.ErrnoException {
  return Object.assign(unsafe(message, cause), { code: BROKER_TRANSPORT_ERROR });
}

function isBrokerTransportError(error: unknown): error is NodeJS.ErrnoException {
  return (error as NodeJS.ErrnoException | null)?.code === BROKER_TRANSPORT_ERROR;
}

function clearBrokerFailure(): void {
  helperBrokerFailure = null;
}

function rememberBrokerFailure(error: NodeJS.ErrnoException): void {
  const priorFailures = helperBrokerFailure?.failures ?? 0;
  const failures = Math.min(priorFailures + 1, 16);
  const cooldown = Math.min(
    BROKER_COOLDOWN_BASE_MS * (2 ** Math.min(failures - 1, 15)),
    BROKER_COOLDOWN_MAX_MS,
  );
  helperBrokerFailure = {
    message: error.message,
    cause: (error as Error & { cause?: unknown }).cause,
    failures,
    retryAt: Date.now() + cooldown,
  };
}

function refuseDuringBrokerCooldown(): void {
  const failure = helperBrokerFailure;
  if (!failure || Date.now() >= failure.retryAt) return;
  const remaining = Math.max(1, failure.retryAt - Date.now());
  throw brokerTransportError(
    `Workspace entry helper transport is cooling down for ${remaining}ms after: ${failure.message}`,
    failure.cause,
  );
}

function closeHelperBroker(broker: WorkspaceCwdHelperBroker): void {
  if (broker.closed) return;
  broker.closed = true;
  if (helperBroker === broker) helperBroker = null;
  void broker.worker.terminate();
}

/** Process-wide teardown used by tests and orderly server shutdown. */
export function closeWorkspaceCwdHelpers(): void {
  if (helperBroker) closeHelperBroker(helperBroker);
  clearBrokerFailure();
}

function sharedBrokerError(
  broker: WorkspaceCwdHelperBroker,
  fallback: string,
): NodeJS.ErrnoException {
  const responseLength = Atomics.load(broker.control, 1);
  if (responseLength > 0 && responseLength <= MAX_RESPONSE_BYTES) {
    try {
      const raw = Buffer.from(broker.response.subarray(0, responseLength)).toString('utf8');
      const response = JSON.parse(raw) as { code?: unknown; message?: unknown };
      if (typeof response.message === 'string') {
        return brokerTransportError(response.message.slice(0, 2_048));
      }
    } catch { /* Preserve the explicit broker fallback below. */ }
  }
  return brokerTransportError(fallback);
}

function createHelperBroker(): WorkspaceCwdHelperBroker {
  const childPath = path.join(__dirname, 'workspace-cwd-helper-child.js');
  const brokerPath = path.join(__dirname, 'workspace-cwd-helper-broker.js');
  const controlBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3);
  const responseBuffer = new SharedArrayBuffer(MAX_RESPONSE_BYTES);
  const control = new Int32Array(controlBuffer);
  Atomics.store(control, 0, BROKER_STARTING);
  const worker = new Worker(brokerPath, {
    workerData: {
      controlBuffer,
      responseBuffer,
      executable: helperBrokerExecutableForTests ?? process.execPath,
      childPath,
      env: helperEnvironment(),
      timeoutMs: HELPER_TIMEOUT_MS,
      maximumFrameBytes: MAX_RESPONSE_BYTES,
    },
  });
  worker.unref();
  const broker: WorkspaceCwdHelperBroker = {
    worker,
    control,
    response: new Uint8Array(responseBuffer),
    requestId: 0,
    closed: false,
  };
  worker.once('error', (error) => {
    if (broker.closed) return;
    closeHelperBroker(broker);
    const detail = error instanceof Error ? error.message : String(error);
    rememberBrokerFailure(brokerTransportError(
      `Workspace entry helper broker crashed: ${detail}`,
      error,
    ));
  });
  worker.once('exit', () => {
    if (broker.closed) return;
    closeHelperBroker(broker);
    rememberBrokerFailure(brokerTransportError('Workspace entry helper broker exited unexpectedly'));
  });
  helperBroker = broker;
  const waited = Atomics.wait(
    broker.control,
    0,
    BROKER_STARTING,
    BROKER_STARTUP_TIMEOUT_MS,
  );
  const state = Atomics.load(broker.control, 0);
  if (state === BROKER_FATAL) {
    const error = sharedBrokerError(broker, 'Workspace entry helper broker failed during startup');
    closeHelperBroker(broker);
    throw error;
  }
  if (waited === 'timed-out' || state !== BROKER_IDLE) {
    closeHelperBroker(broker);
    throw brokerTransportError(
      `Workspace entry helper broker did not become ready within ${BROKER_STARTUP_TIMEOUT_MS}ms`,
    );
  }
  return broker;
}

function exchangePersistentHelper(
  canonicalPath: string,
  rawRequest: string,
): string {
  refuseDuringBrokerCooldown();
  const request = Buffer.from(rawRequest, 'utf8');
  if (request.length > MAX_RESPONSE_BYTES) throw unsafe('Workspace entry helper request is too large');
  let broker: WorkspaceCwdHelperBroker;
  try {
    broker = helperBroker && !helperBroker.closed ? helperBroker : createHelperBroker();
  } catch (error) {
    const failure = isBrokerTransportError(error)
      ? error
      : brokerTransportError('Workspace entry helper broker could not start', error);
    rememberBrokerFailure(failure);
    throw failure;
  }
  if (Atomics.compareExchange(broker.control, 0, BROKER_IDLE, BROKER_PENDING) !== BROKER_IDLE) {
    closeHelperBroker(broker);
    const failure = brokerTransportError('Workspace entry helper broker received a concurrent request');
    rememberBrokerFailure(failure);
    throw failure;
  }
  broker.requestId = broker.requestId >= 0x7fff_fffe ? 1 : broker.requestId + 1;
  const requestId = broker.requestId;
  Atomics.store(broker.control, 1, 0);
  Atomics.store(broker.control, 2, requestId);
  try {
    broker.worker.postMessage({
      type: 'request', requestId, canonicalPath, rawRequest,
    });
    const waited = Atomics.wait(
      broker.control,
      0,
      BROKER_PENDING,
      HELPER_TIMEOUT_MS + BROKER_WAIT_GRACE_MS,
    );
    const state = Atomics.load(broker.control, 0);
    if (state === BROKER_FATAL && Atomics.load(broker.control, 2) === requestId) {
      const error = sharedBrokerError(broker, 'Workspace entry helper broker failed');
      closeHelperBroker(broker);
      throw error;
    }
    if (waited === 'timed-out' || state !== BROKER_COMPLETE
      || Atomics.load(broker.control, 2) !== requestId) {
      closeHelperBroker(broker);
      throw brokerTransportError('Workspace entry helper broker timed out');
    }
    const responseLength = Atomics.load(broker.control, 1);
    if (responseLength <= 0 || responseLength > MAX_RESPONSE_BYTES) {
      closeHelperBroker(broker);
      throw brokerTransportError('Workspace entry helper broker returned an invalid response length');
    }
    const response = Buffer.from(broker.response.subarray(0, responseLength)).toString('utf8');
    Atomics.store(broker.control, 0, BROKER_IDLE);
    return response;
  } catch (error) {
    if (Atomics.load(broker.control, 0) !== BROKER_IDLE) closeHelperBroker(broker);
    const failure = isBrokerTransportError(error)
      ? error
      : brokerTransportError('Workspace entry helper broker failed', error);
    rememberBrokerFailure(failure);
    throw failure;
  }
}

function invalidHelperResponse(
  persistentTransport: boolean,
  message: string,
  cause?: unknown,
): NodeJS.ErrnoException {
  if (!persistentTransport) return unsafe(message, cause);
  if (helperBroker) closeHelperBroker(helperBroker);
  const failure = brokerTransportError(message, cause);
  rememberBrokerFailure(failure);
  return failure;
}

export type WorkspaceCwdHelperOperation =
  | { operation: 'mkdir'; name: string }
  | { operation: 'ensure-directory'; name: string; createIfMissing: boolean; harden: boolean; expectedEntry?: { dev: bigint; ino: bigint } }
  | { operation: 'inspect-directory'; name: string }
  | { operation: 'unlink' | 'rmdir'; name: string; expectedEntry: { dev: bigint; ino: bigint } }
  | { operation: 'rename'; name: string; target: string; expectedEntry: { dev: bigint; ino: bigint } }
  | { operation: 'publish'; name: string; target: string; expectedEntry: { dev: bigint; ino: bigint } }
  | { operation: 'claim' | 'retire'; name: string; target: string; expectedEntry: { dev: bigint; ino: bigint } }
  | { operation: 'isolate'; name: string; target: string; expectedEntry: { dev: bigint; ino: bigint } }
  | { operation: 'reconcile-publish' | 'reconcile-rename'; name: string; target: string; expectedEntry: { dev: bigint; ino: bigint } }
  | { operation: 'recover-publish'; name: string }
  | { operation: 'fingerprint'; name: string; maximumBytes?: number; expectedEntry?: { dev: bigint; ino: bigint } }
  | { operation: 'read'; name: string; offset: number; length: number; expectedEntry?: { dev: bigint; ino: bigint } }
  | { operation: 'authority-read'; name: string }
  | { operation: 'stat'; name: string; expectedEntry?: { dev: bigint; ino: bigint } }
  | { operation: 'list'; name: '.list' }
  | { operation: 'write'; name: string; offset: number; data: Uint8Array; expectedEntry: { dev: bigint; ino: bigint }; mode?: 0o600 }
  | { operation: 'append'; name: string; data: Uint8Array; expectedEntry?: { dev: bigint; ino: bigint }; mode?: 0o600 }
  | { operation: 'truncate'; name: string; length: number; expectedEntry: { dev: bigint; ino: bigint }; mode?: 0o600 }
  | { operation: 'harden'; name: string; expectedEntry?: { dev: bigint; ino: bigint }; mode?: 0o600 }
  | { operation: 'migration-retire'; name: string; expectedEntry: { dev: bigint; ino: bigint } }
  | { operation: 'recover-migration-retire'; name: string; expectedBytes: number; expectedSha256: string }
  | { operation: 'cleanup-create'; name: string; data: Uint8Array }
  | { operation: 'verify-absent'; name: string; expectedEntry: { dev: bigint; ino: bigint }; mode?: 0o700 }
  | { operation: 'create' | 'replace'; name: string; data: Uint8Array; mode?: 0o600 | 0o700 };

export interface WorkspaceCwdHelperResult {
  dev?: bigint; ino?: bigint; bytes?: string; sha256?: string; data?: string;
  size?: string; nlink?: string; mode?: string; mtimeNs?: string; ctimeNs?: string;
  birthtimeNs?: string;
  entries?: string;
  helperPid?: number;
}

function unsafe(message: string, cause?: unknown): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code: 'UNSAFE_WORKSPACE_STORAGE', cause });
}

function unsignedStatDecimal(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_STAT_DECIMAL_DIGITS
    && /^(?:0|[1-9]\d*)$/.test(value);
}

function signedStatDecimal(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_STAT_DECIMAL_DIGITS + 1
    && /^(?:0|-?[1-9]\d*)$/.test(value);
}

function component(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]+$/.test(value)
    || value === '.' || value === '..' || path.basename(value) !== value) {
    throw unsafe(`Refusing non-direct workspace helper component: ${JSON.stringify(value)}`);
  }
  return value;
}

function inspectedDirectoryComponent(value: unknown): string {
  if (typeof value !== 'string' || value === '.' || value === '..' || value.includes('\0')
    || path.basename(value) !== value || Buffer.byteLength(value, 'utf8') > 255
    || (process.platform === 'win32' && (
      /[<>:"/\\|?*]/.test(value) || /[. ]$/.test(value)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
    ))) throw unsafe(`Refusing unsafe directory component: ${JSON.stringify(value)}`);
  return value;
}

export function runWorkspaceCwdHelper(
  lease: Pick<WorkspaceStorageDirectoryLease, 'canonicalPath' | 'fd' | 'verify'>,
  request: WorkspaceCwdHelperOperation,
): WorkspaceCwdHelperResult {
  if (request.operation === 'inspect-directory') inspectedDirectoryComponent(request.name);
  else component(request.name);
  if (request.operation === 'replace') {
    if (request.data.byteLength > MAX_FILE_BYTES) {
      throw unsafe(`Workspace helper payload exceeds ${MAX_FILE_BYTES} bytes`);
    }
    const temporary = `.ccweb-replace-${process.pid}-${randomBytes(12).toString('hex')}.tmp`;
    const expected = createTemporaryWorkspaceCwdFile(lease, temporary, request.data);
    try {
      renameWorkspaceCwdFile(lease, temporary, request.name, expected);
      return expected;
    } catch (error) {
      try { removeWorkspaceCwdEntry(lease, temporary, expected); } catch { /* Exact cleanup only. */ }
      throw error;
    }
  }
  if (request.operation === 'rename' || request.operation === 'publish'
    || request.operation === 'claim' || request.operation === 'retire'
    || request.operation === 'isolate' || request.operation === 'reconcile-publish'
    || request.operation === 'reconcile-rename') component(request.target);
  if ((request.operation === 'create' || request.operation === 'append' || request.operation === 'write'
    || request.operation === 'cleanup-create')
    && request.data.byteLength > MAX_FILE_BYTES) {
    throw unsafe(`Workspace helper payload exceeds ${MAX_FILE_BYTES} bytes`);
  }
  lease.verify();
  const parent = fs.fstatSync(lease.fd, { bigint: true });
  if (!parent.isDirectory() || parent.ino === 0n) throw unsafe('Workspace helper parent has no stable identity');
  const childPath = path.join(__dirname, 'workspace-cwd-helper-child.js');
  const wire = {
    version: 1,
    cwdPath: lease.canonicalPath,
    expectedDev: parent.dev.toString(),
    expectedIno: parent.ino.toString(),
    ...request,
    ...('expectedEntry' in request && request.expectedEntry ? {
      expectedEntryDev: request.expectedEntry.dev.toString(),
      expectedEntryIno: request.expectedEntry.ino.toString(),
      expectedEntry: undefined,
    } : {}),
    ...((request.operation === 'create' || request.operation === 'append' || request.operation === 'write'
      || request.operation === 'cleanup-create')
      ? { data: Buffer.from(request.data).toString('base64') }
      : {}),
  };
  const rawRequest = JSON.stringify(wire);
  let rawResponse: string;
  const persistentTransport = process.platform === 'win32' && helperSpawner === productionSpawner;
  if (persistentTransport) {
    try {
      rawResponse = exchangePersistentHelper(lease.canonicalPath, rawRequest);
    } finally {
      lease.verify();
    }
  } else {
    const result = helperSpawner(process.execPath, [childPath], {
      cwd: lease.canonicalPath,
      env: helperEnvironment(),
      input: rawRequest,
      encoding: 'utf8',
      timeout: HELPER_TIMEOUT_MS,
      maxBuffer: MAX_RESPONSE_BYTES,
      windowsHide: true,
    });
    lease.verify();
    if (result.error || result.status !== 0 || result.signal) {
      let childCode = 'UNSAFE_WORKSPACE_STORAGE';
      try {
        const child = JSON.parse(String(result.stderr).trim()) as { code?: unknown };
        if (typeof child.code === 'string' && /^[A-Z0-9_]+$/.test(child.code)) childCode = child.code;
      } catch { /* Preserve the generic fail-closed code. */ }
      throw Object.assign(unsafe(
        `Workspace entry helper failed (${result.signal ?? result.status ?? 'spawn'}): ${String(result.stderr).slice(0, 2048)}`,
        result.error,
      ), { code: childCode });
    }
    rawResponse = result.stdout.trim();
  }
  let response: {
    ok?: unknown; origin?: unknown; dev?: unknown; ino?: unknown;
    bytes?: unknown; sha256?: unknown; data?: unknown; size?: unknown; nlink?: unknown;
    mode?: unknown; mtimeNs?: unknown; ctimeNs?: unknown; birthtimeNs?: unknown; entries?: unknown;
    code?: unknown; message?: unknown; helperPid?: unknown;
  };
  try { response = JSON.parse(rawResponse.trim()) as typeof response; } catch (error) {
    throw invalidHelperResponse(
      persistentTransport,
      'Workspace entry helper returned an invalid response',
      error,
    );
  }
  if (response.ok === false) {
    const childCode = typeof response.code === 'string' && /^[A-Z0-9_]+$/.test(response.code)
      ? response.code
      : 'UNSAFE_WORKSPACE_STORAGE';
    const message = typeof response.message === 'string'
      ? response.message.slice(0, 2048)
      : 'unknown helper failure';
    const failure = Object.assign(unsafe(`Workspace entry helper failed: ${message}`), { code: childCode });
    if (persistentTransport) {
      if (childCode === BROKER_TRANSPORT_ERROR) rememberBrokerFailure(failure);
      else clearBrokerFailure();
    }
    throw failure;
  }
  if (response.ok !== true || (response.origin !== 'source' && response.origin !== 'app.asar')) {
    throw invalidHelperResponse(
      persistentTransport,
      'Workspace entry helper returned an invalid success response',
    );
  }
  if (persistentTransport
    && (!Number.isSafeInteger(response.helperPid) || Number(response.helperPid) <= 0)) {
    throw invalidHelperResponse(
      persistentTransport,
      'Workspace entry helper returned an invalid process identity',
    );
  }
  for (const field of ['size', 'nlink', 'mode'] as const) {
    if (response[field] !== undefined && !unsignedStatDecimal(response[field])) {
      throw invalidHelperResponse(
        persistentTransport,
        `Workspace entry helper returned an invalid ${field}`,
      );
    }
  }
  for (const field of ['mtimeNs', 'ctimeNs', 'birthtimeNs'] as const) {
    if (response[field] !== undefined && !signedStatDecimal(response[field])) {
      throw invalidHelperResponse(
        persistentTransport,
        `Workspace entry helper returned an invalid ${field}`,
      );
    }
  }
  if (request.operation === 'mkdir' || request.operation === 'ensure-directory'
    || request.operation === 'inspect-directory'
    || request.operation === 'create' || request.operation === 'rename'
    || request.operation === 'publish' || request.operation === 'claim' || request.operation === 'isolate'
    || request.operation === 'reconcile-publish' || request.operation === 'reconcile-rename'
    || request.operation === 'fingerprint' || request.operation === 'read'
    || request.operation === 'authority-read' || request.operation === 'harden'
    || request.operation === 'stat' || request.operation === 'append'
    || request.operation === 'write' || request.operation === 'truncate') {
    if (typeof response.dev !== 'string' || typeof response.ino !== 'string') {
      throw invalidHelperResponse(
        persistentTransport,
        'Workspace entry helper omitted the published identity',
      );
    }
    if (!/^\d+$/.test(response.dev) || !/^\d+$/.test(response.ino)) {
      throw invalidHelperResponse(
        persistentTransport,
        'Workspace entry helper returned an invalid published identity',
      );
    }
  }
  if (persistentTransport) clearBrokerFailure();
  if (!smokeReported && process.env.CODE_AGENTS_WEBCLI_DESKTOP_SMOKE === '1') {
    smokeReported = true;
    console.log(`WORKSPACE_ENTRY_HELPER_OK ${response.origin}`);
  }
  return {
    ...(typeof response.dev === 'string' ? { dev: BigInt(response.dev) } : {}),
    ...(typeof response.ino === 'string' ? { ino: BigInt(response.ino) } : {}),
    ...(typeof response.bytes === 'string' ? { bytes: response.bytes } : {}),
    ...(typeof response.sha256 === 'string' ? { sha256: response.sha256 } : {}),
    ...(typeof response.data === 'string' ? { data: response.data } : {}),
    ...(typeof response.size === 'string' ? { size: response.size } : {}),
    ...(typeof response.nlink === 'string' ? { nlink: response.nlink } : {}),
    ...(typeof response.mode === 'string' ? { mode: response.mode } : {}),
    ...(typeof response.mtimeNs === 'string' ? { mtimeNs: response.mtimeNs } : {}),
    ...(typeof response.ctimeNs === 'string' ? { ctimeNs: response.ctimeNs } : {}),
    ...(typeof response.birthtimeNs === 'string' ? { birthtimeNs: response.birthtimeNs } : {}),
    ...(typeof response.entries === 'string' ? { entries: response.entries } : {}),
    ...(Number.isSafeInteger(response.helperPid) ? { helperPid: Number(response.helperPid) } : {}),
  };
}

export function ensureWorkspaceCwdDirectory(
  lease: Pick<WorkspaceStorageDirectoryLease, 'canonicalPath' | 'fd' | 'verify'>,
  name: string,
  createIfMissing: boolean,
  expectedEntry?: { dev: bigint; ino: bigint },
  harden = true,
): { dev: bigint; ino: bigint } {
  const result = runWorkspaceCwdHelper(lease, {
    operation: 'ensure-directory', name, createIfMissing, harden,
    ...(expectedEntry ? { expectedEntry } : {}),
  });
  if (result.dev === undefined || result.ino === undefined) {
    throw unsafe('Workspace helper omitted directory identity');
  }
  return { dev: result.dev, ino: result.ino };
}

export function inspectWorkspaceCwdDirectory(
  lease: Pick<WorkspaceStorageDirectoryLease, 'canonicalPath' | 'fd' | 'verify'>,
  name: string,
): { dev: bigint; ino: bigint } {
  const result = runWorkspaceCwdHelper(lease, { operation: 'inspect-directory', name });
  if (result.dev === undefined || result.ino === undefined) {
    throw unsafe('Workspace helper omitted inspected directory identity');
  }
  return { dev: result.dev, ino: result.ino };
}

/** Normalize a crashed no-clobber publication entirely inside the pinned cwd. */
export function recoverWorkspaceCwdPublication(
  lease: Pick<WorkspaceStorageDirectoryLease, 'canonicalPath' | 'fd' | 'verify'>,
  name: string,
): void {
  runWorkspaceCwdHelper(lease, { operation: 'recover-publish', name });
}

/** Hash an isolated direct child while the helper process pins its parent cwd. */
export function fingerprintWorkspaceCwdFile(
  lease: Pick<WorkspaceStorageDirectoryLease, 'canonicalPath' | 'fd' | 'verify'>,
  name: string,
  maximumBytes?: number,
): { bytes: number; sha256: string } {
  const result = runWorkspaceCwdHelper(lease, {
    operation: 'fingerprint', name, ...(maximumBytes === undefined ? {} : { maximumBytes }),
  });
  if (typeof result.bytes !== 'string' || !/^\d+$/.test(result.bytes)
    || typeof result.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(result.sha256)) {
    throw unsafe('Workspace helper returned an invalid fingerprint');
  }
  const bytes = Number(result.bytes);
  if (!Number.isSafeInteger(bytes)) throw unsafe('Workspace helper returned an oversized fingerprint');
  return { bytes, sha256: result.sha256 };
}

export function readWorkspaceCwdFile(
  lease: Pick<WorkspaceStorageDirectoryLease, 'canonicalPath' | 'fd' | 'verify'>,
  name: string,
  offset: number,
  length: number,
  expectedEntry?: { dev: bigint; ino: bigint },
): WorkspaceCwdHelperResult & { data: string; size: string } {
  const result = runWorkspaceCwdHelper(lease, {
    operation: 'read', name, offset, length,
    ...(expectedEntry ? { expectedEntry } : {}),
  });
  if (typeof result.data !== 'string' || typeof result.size !== 'string') {
    throw unsafe('Workspace helper returned an invalid read response');
  }
  return result as WorkspaceCwdHelperResult & { data: string; size: string };
}

export function readWorkspaceCwdAuthorityClaim(
  lease: Pick<WorkspaceStorageDirectoryLease, 'canonicalPath' | 'fd' | 'verify'>,
  name: string,
): { data: Buffer; identity: { dev: bigint; ino: bigint }; nlink: bigint } {
  const result = runWorkspaceCwdHelper(lease, { operation: 'authority-read', name });
  if (result.dev === undefined || result.ino === undefined
    || typeof result.data !== 'string' || typeof result.size !== 'string'
    || typeof result.nlink !== 'string') throw unsafe('Workspace helper returned an invalid authority claim');
  const data = Buffer.from(result.data, 'base64');
  if (data.toString('base64') !== result.data || BigInt(result.size) !== BigInt(data.length)) {
    throw unsafe('Workspace helper returned invalid authority claim bytes');
  }
  const nlink = BigInt(result.nlink);
  if (nlink < 1n || nlink > 3n) throw unsafe('Workspace helper returned an unsafe authority link count');
  return { data, identity: { dev: result.dev, ino: result.ino }, nlink };
}

export function statWorkspaceCwdFile(
  lease: Pick<WorkspaceStorageDirectoryLease, 'canonicalPath' | 'fd' | 'verify'>,
  name: string,
  expectedEntry?: { dev: bigint; ino: bigint },
): WorkspaceCwdHelperResult & { size: string; nlink: string; mode: string } {
  const result = runWorkspaceCwdHelper(lease, {
    operation: 'stat', name, ...(expectedEntry ? { expectedEntry } : {}),
  });
  if (typeof result.size !== 'string' || typeof result.nlink !== 'string'
    || typeof result.mode !== 'string') throw unsafe('Workspace helper returned an invalid stat response');
  return result as WorkspaceCwdHelperResult & { size: string; nlink: string; mode: string };
}

export interface WorkspaceCwdListedEntry {
  name: string; dev: bigint; ino: bigint; size: bigint; nlink: bigint; mode: bigint;
  type: 'file' | 'directory' | 'symlink' | 'special';
}

export function listWorkspaceCwdEntries(
  lease: Pick<WorkspaceStorageDirectoryLease, 'canonicalPath' | 'fd' | 'verify'>,
): WorkspaceCwdListedEntry[] {
  const result = runWorkspaceCwdHelper(lease, { operation: 'list', name: '.list' });
  if (typeof result.entries !== 'string') throw unsafe('Workspace helper omitted directory entries');
  let parsed: unknown;
  try { parsed = JSON.parse(result.entries); } catch (error) { throw unsafe('Workspace helper returned invalid entries', error); }
  if (!Array.isArray(parsed) || parsed.length > 10_000) throw unsafe('Workspace helper returned invalid entries');
  return parsed.map((entry: unknown) => {
    const item = entry as Record<string, unknown>;
    component(item.name);
    if (!['file', 'directory', 'symlink', 'special'].includes(String(item.type))) {
      throw unsafe('Workspace helper returned an invalid entry type');
    }
    for (const key of ['dev', 'ino', 'size', 'nlink', 'mode']) {
      if (typeof item[key] !== 'string' || !/^\d+$/.test(item[key] as string)) {
        throw unsafe('Workspace helper returned an invalid entry identity');
      }
    }
    return {
      name: item.name as string, type: item.type as WorkspaceCwdListedEntry['type'],
      dev: BigInt(item.dev as string), ino: BigInt(item.ino as string),
      size: BigInt(item.size as string), nlink: BigInt(item.nlink as string), mode: BigInt(item.mode as string),
    };
  });
}

export function readCompleteWorkspaceCwdFile(
  lease: Pick<WorkspaceStorageDirectoryLease, 'canonicalPath' | 'fd' | 'verify'>,
  name: string,
  maximumBytes: number,
): { data: Buffer; identity: { dev: bigint; ino: bigint } } {
  const initial = statWorkspaceCwdFile(lease, name);
  const size = Number(initial.size);
  if (!Number.isSafeInteger(size) || size < 0 || size > maximumBytes) {
    throw unsafe('Workspace helper file exceeds its bounded read limit');
  }
  if (initial.dev === undefined || initial.ino === undefined) throw unsafe('Workspace helper stat omitted identity');
  const data = Buffer.alloc(size);
  const expectedEntry = { dev: initial.dev, ino: initial.ino };
  let offset = 0;
  while (offset < size) {
    const next = readWorkspaceCwdFile(
      lease,
      name,
      offset,
      Math.min(MAX_FILE_BYTES, size - offset),
      expectedEntry,
    );
    if (next.dev !== initial.dev || next.ino !== initial.ino || next.size !== initial.size
      || next.mtimeNs !== initial.mtimeNs || next.ctimeNs !== initial.ctimeNs) {
      throw unsafe('Workspace helper file changed across bounded reads');
    }
    const chunk = Buffer.from(next.data, 'base64');
    if (chunk.length === 0 || chunk.length > size - offset || chunk.toString('base64') !== next.data) {
      throw unsafe('Workspace helper returned an invalid bounded read');
    }
    chunk.copy(data, offset);
    offset += chunk.length;
  }
  return { data, identity: { dev: initial.dev, ino: initial.ino } };
}

export function appendWorkspaceCwdFile(
  lease: Pick<WorkspaceStorageDirectoryLease, 'canonicalPath' | 'fd' | 'verify'>,
  name: string,
  data: Uint8Array,
  expectedEntry?: { dev: bigint; ino: bigint },
): void {
  runWorkspaceCwdHelper(lease, {
    operation: 'append', name, data, mode: 0o600,
    ...(expectedEntry ? { expectedEntry } : {}),
  });
}

export function writeWorkspaceCwdFile(
  lease: Pick<WorkspaceStorageDirectoryLease, 'canonicalPath' | 'fd' | 'verify'>,
  name: string,
  offset: number,
  data: Uint8Array,
  expectedEntry: { dev: bigint; ino: bigint },
): void {
  runWorkspaceCwdHelper(lease, {
    operation: 'write', name, offset, data, expectedEntry, mode: 0o600,
  });
}

export function truncateWorkspaceCwdFile(
  lease: Pick<WorkspaceStorageDirectoryLease, 'canonicalPath' | 'fd' | 'verify'>,
  name: string,
  length: number,
  expectedEntry: { dev: bigint; ino: bigint },
): void {
  runWorkspaceCwdHelper(lease, { operation: 'truncate', name, length, expectedEntry, mode: 0o600 });
}

export function hardenWorkspaceCwdFile(
  lease: Pick<WorkspaceStorageDirectoryLease, 'canonicalPath' | 'fd' | 'verify'>,
  name: string,
  expectedEntry?: { dev: bigint; ino: bigint },
): void {
  runWorkspaceCwdHelper(lease, {
    operation: 'harden', name, mode: 0o600, ...(expectedEntry ? { expectedEntry } : {}),
  });
}

function reconcileWorkspacePublication(
  lease: Pick<WorkspaceStorageDirectoryLease, 'canonicalPath' | 'fd' | 'verify'>,
  temporary: string,
  target: string,
  expected: { dev: bigint; ino: bigint },
  linked: boolean,
): boolean {
  try {
    runWorkspaceCwdHelper(lease, {
      operation: linked ? 'reconcile-publish' : 'reconcile-rename',
      name: temporary,
      target,
      expectedEntry: expected,
    });
    return true;
  } catch { return false; }
}

/** Create an app-generated direct child and exact-clean it if the helper reply is lost. */
export function createTemporaryWorkspaceCwdFile(
  lease: Pick<WorkspaceStorageDirectoryLease, 'canonicalPath' | 'fd' | 'verify'>,
  name: string,
  data: Uint8Array,
): { dev: bigint; ino: bigint } {
  try {
    const created = runWorkspaceCwdHelper(lease, {
      operation: 'create', name, data, mode: 0o600,
    });
    if (created.dev === undefined || created.ino === undefined) {
      throw unsafe('Missing helper temporary identity');
    }
    return { dev: created.dev, ino: created.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw error;
    try { runWorkspaceCwdHelper(lease, { operation: 'cleanup-create', name, data }); } catch {
      /* Preserve the helper failure and never unlink an unproved entry. */
    }
    throw error;
  }
}

/** Replace a direct child with an already-open exact inode, reconciling a lost helper reply. */
export function renameWorkspaceCwdFile(
  lease: Pick<WorkspaceStorageDirectoryLease, 'canonicalPath' | 'fd' | 'verify'>,
  temporary: string,
  target: string,
  expected: { dev: bigint; ino: bigint },
): void {
  try {
    runWorkspaceCwdHelper(lease, {
      operation: 'rename', name: temporary, target, expectedEntry: expected,
    });
  } catch (error) {
    if (reconcileWorkspacePublication(lease, temporary, target, expected, false)) return;
    throw error;
  }
}

/** Request removal after an identity precheck; containment comes from the child cwd pin. */
export function removeWorkspaceCwdEntry(
  lease: Pick<WorkspaceStorageDirectoryLease, 'canonicalPath' | 'fd' | 'verify'>,
  name: string,
  expected: { dev: bigint; ino: bigint },
  directory = false,
): void {
  try {
    runWorkspaceCwdHelper(lease, {
      operation: directory ? 'rmdir' : 'unlink', name, expectedEntry: expected,
    });
  } catch (error) {
    try {
      runWorkspaceCwdHelper(lease, {
        operation: 'verify-absent', name, expectedEntry: expected,
        ...(directory ? { mode: 0o700 as const } : {}),
      });
      return;
    } catch { /* Preserve the original mutation failure. */ }
    throw error;
  }
}

export function retireMigrationWorkspaceCwdEntry(
  lease: Pick<WorkspaceStorageDirectoryLease, 'canonicalPath' | 'fd' | 'verify'>,
  name: string,
  expected: { dev: bigint; ino: bigint },
): void {
  runWorkspaceCwdHelper(lease, { operation: 'migration-retire', name, expectedEntry: expected });
}

export function recoverMigrationWorkspaceCwdRetirement(
  lease: Pick<WorkspaceStorageDirectoryLease, 'canonicalPath' | 'fd' | 'verify'>,
  name: string,
  expected: { bytes: number; sha256: string },
): void {
  runWorkspaceCwdHelper(lease, {
    operation: 'recover-migration-retire', name,
    expectedBytes: expected.bytes, expectedSha256: expected.sha256,
  });
}

/** Reserved sibling prefix used to discover an interrupted migration retirement. */
export function migrationWorkspaceCwdRetirementPrefix(name: string): string {
  component(name);
  return `.ccweb-quarantine-migration-retire-${createHash('sha256')
    .update(name).digest('hex').slice(0, 24)}-`;
}

/** Atomically publish a complete new direct child without replacing a raced target. */
export function publishNewWorkspaceCwdFile(
  lease: Pick<WorkspaceStorageDirectoryLease, 'canonicalPath' | 'fd' | 'verify'>,
  name: string,
  data: Uint8Array,
): void {
  component(name);
  const temporary = `.ccweb-new-${process.pid}-${randomBytes(12).toString('hex')}.tmp`;
  const expected = createTemporaryWorkspaceCwdFile(lease, temporary, data);
  try {
    runWorkspaceCwdHelper(lease, {
      operation: 'publish', name: temporary, target: name,
      expectedEntry: { dev: expected.dev, ino: expected.ino },
    });
  } catch (error) {
    if (reconcileWorkspacePublication(
      lease, temporary, name, { dev: expected.dev, ino: expected.ino }, true,
    )) return;
    try {
      removeWorkspaceCwdEntry(lease, temporary, expected);
    } catch { /* Best effort; helper enforces cwd containment and the expected precondition. */ }
    throw error;
  }
}

/** Stream a complete new file into an exact helper-created inode, then no-clobber publish it. */
export function publishNewLargeWorkspaceCwdFile(
  lease: Pick<WorkspaceStorageDirectoryLease, 'canonicalPath' | 'fd' | 'verify'>,
  name: string,
  write: (writeChunk: (data: Uint8Array, position: number) => void) => void,
): void {
  component(name);
  const temporary = `.ccweb-stream-${process.pid}-${randomBytes(12).toString('hex')}.tmp`;
  const expected = createTemporaryWorkspaceCwdFile(lease, temporary, Buffer.alloc(0));
  let publicationAttempted = false;
  try {
    write((data, position) => writeWorkspaceCwdFile(lease, temporary, position, data, expected));
    publicationAttempted = true;
    runWorkspaceCwdHelper(lease, {
      operation: 'publish', name: temporary, target: name,
      expectedEntry: { dev: expected.dev, ino: expected.ino },
    });
  } catch (error) {
    if (publicationAttempted && reconcileWorkspacePublication(
      lease, temporary, name, { dev: expected.dev, ino: expected.ino }, true,
    )) return;
    try {
      removeWorkspaceCwdEntry(lease, temporary, expected);
    } catch { /* Exact-inode cleanup only. */ }
    throw error;
  }
}

/** Publish a large image without base64-copying it through the helper request pipe. */
export function publishLargeWorkspaceCwdFile(
  lease: Pick<WorkspaceStorageDirectoryLease, 'canonicalPath' | 'fd' | 'verify'>,
  name: string,
  data: Uint8Array,
): void {
  component(name);
  const temporary = `.ccweb-parent-${process.pid}-${randomBytes(12).toString('hex')}.tmp`;
  const expected = createTemporaryWorkspaceCwdFile(lease, temporary, Buffer.alloc(0));
  let publicationAttempted = false;
  try {
    const bytes = Buffer.from(data);
    for (let offset = 0; offset < bytes.length; offset += 16 * 1024 * 1024) {
      writeWorkspaceCwdFile(
        lease, temporary, offset, bytes.subarray(offset, offset + 16 * 1024 * 1024), expected,
      );
    }
    publicationAttempted = true;
    renameWorkspaceCwdFile(lease, temporary, name, {
      dev: expected.dev, ino: expected.ino,
    });
  } catch (error) {
    if (publicationAttempted && reconcileWorkspacePublication(
      lease, temporary, name, { dev: expected.dev, ino: expected.ino }, false,
    )) return;
    try {
      removeWorkspaceCwdEntry(lease, temporary, expected);
    } catch { /* Best effort; helper validates the expected precondition inside its pinned cwd. */ }
    throw error;
  }
}
