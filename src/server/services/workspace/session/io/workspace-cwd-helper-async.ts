import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type {
  WorkspaceCwdHelperOperation,
  WorkspaceCwdHelperResult,
} from './workspace-cwd-helper.js';
import type { WorkspaceSessionFileParentLease } from '../workspace-session-storage.js';

const MAX_PENDING_REQUESTS = 256;
// The inner helper has a 15s process timeout plus broker/startup grace. Keep an
// independent bound above that whole path so a wedged outer worker cannot hold
// session descriptors (or an unbounded chat backlog) forever.
const ACTIVE_REQUEST_TIMEOUT_MS = 20_000;
// A request admitted behind a wedged predecessor must not retain a session fd
// for the sum of every request ahead of it. The active watchdog normally fires
// first; this is an independent admission-to-start bound.
const QUEUED_REQUEST_TIMEOUT_MS = 40_000;
const MAX_IDENTITY_DIGITS = 32;

type AsyncHelperLease = Pick<
  WorkspaceSessionFileParentLease,
  'canonicalPath' | 'fd' | 'identity' | 'retain'
>;

interface SerializedHelperLease {
  canonicalPath: string;
  fd: number;
  dev: string;
  ino: string;
}

interface AsyncHelperReply {
  type: 'result';
  requestId: number;
  result?: WorkspaceCwdHelperResult;
  error?: {
    name?: string;
    message?: string;
    stack?: string;
    code?: string;
  };
}

interface PendingRequest {
  readonly requestId: number;
  readonly lease: SerializedHelperLease;
  readonly operation: WorkspaceCwdHelperOperation;
  readonly resolve: (result: WorkspaceCwdHelperResult) => void;
  readonly reject: (error: Error) => void;
  readonly release: () => void;
  watchdog: NodeJS.Timeout | null;
  settled: boolean;
  released: boolean;
}

interface AsyncHelperWorker {
  readonly worker: Worker;
  readonly exited: Promise<void>;
  readonly queue: PendingRequest[];
  active: PendingRequest | null;
  closed: boolean;
}

let activeWorker: AsyncHelperWorker | null = null;
/** A failed worker must be gone before any recovery helper can touch storage. */
let retiringWorker: Promise<void> | null = null;
let nextRequestId = 0;

function transportError(message: string, cause?: unknown): NodeJS.ErrnoException {
  return Object.assign(new Error(message), {
    code: 'WORKSPACE_HELPER_TRANSPORT',
    cause,
  });
}

function unsafe(message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code: 'UNSAFE_WORKSPACE_STORAGE' });
}

function serializedLease(lease: AsyncHelperLease): SerializedHelperLease {
  const canonicalPath = lease?.canonicalPath;
  const fd = lease?.fd;
  const dev = lease?.identity?.dev;
  const ino = lease?.identity?.ino;
  if (typeof canonicalPath !== 'string'
    || !path.isAbsolute(canonicalPath)
    || path.resolve(canonicalPath) !== canonicalPath
    || !Number.isSafeInteger(fd) || fd < 0
    || typeof dev !== 'bigint' || dev < 0n
    || typeof ino !== 'bigint' || ino <= 0n
    || dev.toString().length > MAX_IDENTITY_DIGITS
    || ino.toString().length > MAX_IDENTITY_DIGITS
    || typeof lease.retain !== 'function') {
    throw unsafe('Workspace entry helper received an invalid retained lease');
  }
  return { canonicalPath, fd, dev: dev.toString(), ino: ino.toString() };
}

function clearRequestWatchdog(request: PendingRequest): void {
  if (request.watchdog !== null) {
    clearTimeout(request.watchdog);
    request.watchdog = null;
  }
}

function releaseRequestHold(request: PendingRequest): void {
  if (request.released) return;
  request.released = true;
  try { request.release(); } catch { /* A transport failure must still settle every promise. */ }
}

function rejectRequest(request: PendingRequest, error: Error, releaseNow = true): void {
  if (request.settled) return;
  request.settled = true;
  clearRequestWatchdog(request);
  if (releaseNow) releaseRequestHold(request);
  request.reject(error);
}

function resolveRequest(request: PendingRequest, result: WorkspaceCwdHelperResult): void {
  if (request.settled) return;
  request.settled = true;
  clearRequestWatchdog(request);
  releaseRequestHold(request);
  request.resolve(result);
}

function failWorker(state: AsyncHelperWorker, error: Error): void {
  if (state.closed) return;
  state.closed = true;
  if (activeWorker === state) activeWorker = null;
  const active = state.active;
  const queued = state.queue.splice(0);
  state.active = null;
  // Queued requests were never shared with the worker and can settle now. The
  // active mutation cannot: exposing its failure would let caller recovery
  // race the worker (and its nested helper) before termination completed.
  for (const request of queued) rejectRequest(request, error);
  state.worker.unref();
  let termination: Promise<number>;
  try {
    termination = state.worker.terminate();
  } catch (terminationError) {
    termination = Promise.reject(terminationError);
  }
  const retired = Promise.allSettled([state.exited, termination]).then(() => {
    if (active) rejectRequest(active, error);
  });
  retiringWorker = retired;
  void retired.finally(() => {
    if (retiringWorker === retired) retiringWorker = null;
  });
}

function replyError(reply: AsyncHelperReply): Error {
  const detail = reply.error;
  const error = new Error(
    typeof detail?.message === 'string'
      ? detail.message.slice(0, 2_048)
      : 'Workspace entry helper worker rejected a request',
  );
  if (typeof detail?.name === 'string') error.name = detail.name.slice(0, 128);
  if (typeof detail?.stack === 'string') error.stack = detail.stack.slice(0, 16_384);
  if (typeof detail?.code === 'string' && /^[A-Z0-9_]+$/.test(detail.code)) {
    Object.assign(error, { code: detail.code });
  }
  return error;
}

function dispatchNext(state: AsyncHelperWorker): void {
  if (state.closed || state.active !== null) return;
  const request = state.queue.shift();
  if (!request) {
    state.worker.unref();
    return;
  }
  state.active = request;
  state.worker.ref();
  clearRequestWatchdog(request);
  request.watchdog = setTimeout(() => {
    failWorker(state, transportError(
      `Workspace entry helper worker timed out after ${ACTIVE_REQUEST_TIMEOUT_MS}ms`,
    ));
  }, ACTIVE_REQUEST_TIMEOUT_MS);
  request.watchdog.unref();
  try {
    state.worker.postMessage({
      type: 'request',
      requestId: request.requestId,
      lease: request.lease,
      operation: request.operation,
    });
  } catch (error) {
    failWorker(state, transportError('Workspace entry helper worker request could not be sent', error));
  }
}

function handleReply(state: AsyncHelperWorker, message: unknown): void {
  if (state.closed) return;
  const reply = message as Partial<AsyncHelperReply>;
  const request = state.active;
  if (reply?.type !== 'result' || !Number.isSafeInteger(reply.requestId)
    || !request || reply.requestId !== request.requestId) {
    failWorker(state, transportError('Workspace entry helper worker returned an invalid response'));
    return;
  }
  const hasError = reply.error !== undefined;
  const hasResult = reply.result !== undefined;
  if (hasError === hasResult) {
    failWorker(state, transportError('Workspace entry helper worker returned an ambiguous response'));
    return;
  }
  state.active = null;
  if (hasError) rejectRequest(request, replyError(reply as AsyncHelperReply));
  else resolveRequest(request, reply.result as WorkspaceCwdHelperResult);
  dispatchNext(state);
}

function createWorker(): AsyncHelperWorker {
  const worker = new Worker(path.join(__dirname, 'workspace-cwd-helper-async-worker.js'));
  let markExited!: () => void;
  const exited = new Promise<void>((resolve) => { markExited = resolve; });
  const state: AsyncHelperWorker = {
    worker,
    exited,
    queue: [],
    active: null,
    closed: false,
  };
  worker.unref();
  worker.on('message', (message: unknown) => handleReply(state, message));
  worker.once('error', (error) => {
    const detail = error instanceof Error ? error.message : String(error);
    failWorker(state, transportError(`Workspace entry helper worker crashed: ${detail}`, error));
  });
  worker.once('exit', (code) => {
    markExited();
    if (!state.closed) {
      failWorker(state, transportError(`Workspace entry helper worker exited unexpectedly (${code})`));
    }
  });
  activeWorker = state;
  return state;
}

export async function runWorkspaceCwdHelperOffThread(
  lease: AsyncHelperLease,
  operation: WorkspaceCwdHelperOperation,
): Promise<WorkspaceCwdHelperResult> {
  // Serialise recovery and fresh work behind definitive retirement. An outer
  // worker owns another worker/helper pair, so clearing the active pointer is
  // not proof that its last namespace mutation has stopped.
  const retirement = retiringWorker;
  if (retirement) await retirement;
  let state: AsyncHelperWorker;
  try {
    state = activeWorker && !activeWorker.closed ? activeWorker : createWorker();
  } catch (error) {
    return Promise.reject(transportError('Workspace entry helper worker could not start', error));
  }
  if (state.queue.length + (state.active ? 1 : 0) >= MAX_PENDING_REQUESTS) {
    return Promise.reject(transportError(
      `Workspace entry helper queue reached its ${MAX_PENDING_REQUESTS}-request capacity`,
    ));
  }

  let retainedLease: SerializedHelperLease;
  let release: () => void;
  try {
    retainedLease = serializedLease(lease);
    release = lease.retain();
  } catch (error) {
    return Promise.reject(error instanceof Error
      ? error
      : unsafe('Workspace entry helper could not retain its parent lease'));
  }

  nextRequestId = nextRequestId >= 0x7fff_fffe ? 1 : nextRequestId + 1;
  const requestId = nextRequestId;
  return new Promise((resolve, reject) => {
    const request: PendingRequest = {
      requestId,
      lease: retainedLease,
      operation,
      resolve,
      reject,
      release,
      watchdog: null,
      settled: false,
      released: false,
    };
    request.watchdog = setTimeout(() => {
      const index = state.queue.indexOf(request);
      if (index < 0) return;
      state.queue.splice(index, 1);
      rejectRequest(request, transportError(
        `Workspace entry helper request did not start within ${QUEUED_REQUEST_TIMEOUT_MS}ms`,
      ));
    }, QUEUED_REQUEST_TIMEOUT_MS);
    request.watchdog.unref();
    state.queue.push(request);
    dispatchNext(state);
  });
}

export function closeWorkspaceCwdHelperWorker(): void {
  const state = activeWorker;
  if (!state) return;
  failWorker(state, transportError('Workspace entry helper worker was closed'));
}
