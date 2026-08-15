import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

const FRAME_HEADER_BYTES = 4;
const CONTROL_STATE = 0;
const CONTROL_LENGTH = 1;
const CONTROL_REQUEST_ID = 2;
const BROKER_IDLE = 1;
const BROKER_COMPLETE = 3;
const BROKER_FATAL = 4;
const BROKER_TRANSPORT_ERROR = 'WORKSPACE_HELPER_TRANSPORT';
const MAX_ERROR_MESSAGE_BYTES = 2_048;

interface BrokerWorkerData {
  controlBuffer: SharedArrayBuffer;
  responseBuffer: SharedArrayBuffer;
  executable: string;
  childPath: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maximumFrameBytes: number;
}

interface BrokerRequest {
  type: 'request';
  requestId: number;
  canonicalPath: string;
  rawRequest: string;
}

interface PendingRequest {
  readonly requestId: number;
  readonly timer: NodeJS.Timeout;
}

const config = workerData as BrokerWorkerData;
const bootstrapControl = config.controlBuffer instanceof SharedArrayBuffer
  && config.controlBuffer.byteLength >= Int32Array.BYTES_PER_ELEMENT * 3
  ? new Int32Array(config.controlBuffer)
  : null;
const bootstrapResponse = config.responseBuffer instanceof SharedArrayBuffer
  ? new Uint8Array(config.responseBuffer)
  : null;
if (!parentPort
  || !(config.controlBuffer instanceof SharedArrayBuffer)
  || !(config.responseBuffer instanceof SharedArrayBuffer)
  || config.controlBuffer.byteLength < Int32Array.BYTES_PER_ELEMENT * 3
  || typeof config.executable !== 'string'
  || typeof config.childPath !== 'string'
  || !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0
  || !Number.isSafeInteger(config.maximumFrameBytes) || config.maximumFrameBytes <= 0
  || config.maximumFrameBytes > config.responseBuffer.byteLength) {
  if (bootstrapControl && bootstrapResponse) {
    const bytes = Buffer.from(JSON.stringify({
      ok: false,
      code: BROKER_TRANSPORT_ERROR,
      message: 'Invalid workspace cwd helper broker configuration',
    }), 'utf8');
    if (bytes.length <= bootstrapResponse.byteLength) {
      bootstrapResponse.set(bytes, 0);
      Atomics.store(bootstrapControl, CONTROL_LENGTH, bytes.length);
      Atomics.store(bootstrapControl, CONTROL_REQUEST_ID, 0);
      Atomics.store(bootstrapControl, CONTROL_STATE, BROKER_FATAL);
      Atomics.notify(bootstrapControl, CONTROL_STATE, 1);
    }
  }
  throw new Error('Invalid workspace cwd helper broker configuration');
}

const control = new Int32Array(config.controlBuffer);
const response = new Uint8Array(config.responseBuffer);
let helper: ChildProcessWithoutNullStreams | null = null;
let helperOutput = Buffer.alloc(0);
let helperError = '';
let pending: PendingRequest | null = null;

function errorResponse(message: string, code = 'UNSAFE_WORKSPACE_STORAGE'): string {
  return JSON.stringify({ ok: false, code, message: message.slice(0, MAX_ERROR_MESSAGE_BYTES) });
}

function publish(requestId: number, rawResponse: string, state = BROKER_COMPLETE): void {
  let bytes = Buffer.from(rawResponse, 'utf8');
  if (bytes.length === 0 || bytes.length > config.maximumFrameBytes) {
    bytes = Buffer.from(errorResponse('Workspace entry helper returned an oversized response'), 'utf8');
  }
  response.set(bytes, 0);
  Atomics.store(control, CONTROL_LENGTH, bytes.length);
  Atomics.store(control, CONTROL_REQUEST_ID, requestId);
  Atomics.store(control, CONTROL_STATE, state);
  Atomics.notify(control, CONTROL_STATE, 1);
}

function finish(rawResponse: string): void {
  const current = pending;
  if (!current) return;
  pending = null;
  clearTimeout(current.timer);
  publish(current.requestId, rawResponse);
}

function stopHelper(target = helper): void {
  if (!target) return;
  if (helper === target) helper = null;
  helperOutput = Buffer.alloc(0);
  helperError = '';
  try { target.stdin.destroy(); } catch { /* Transport is already closed. */ }
  try { target.stdout.destroy(); } catch { /* Transport is already closed. */ }
  try { target.stderr.destroy(); } catch { /* Transport is already closed. */ }
  try { target.kill(); } catch { /* Process has already exited. */ }
}

function failTransport(message: string, target = helper): void {
  stopHelper(target);
  finish(errorResponse(message, BROKER_TRANSPORT_ERROR));
}

let publishingFatal = false;
function failBroker(error: unknown): never {
  if (publishingFatal) process.exit(1);
  publishingFatal = true;
  const current = pending;
  if (current) clearTimeout(current.timer);
  pending = null;
  stopHelper();
  const message = error instanceof Error ? error.message : String(error);
  publish(
    current?.requestId ?? Atomics.load(control, CONTROL_REQUEST_ID),
    errorResponse(`Workspace entry helper broker crashed: ${message}`, BROKER_TRANSPORT_ERROR),
    BROKER_FATAL,
  );
  process.exit(1);
}

function acceptHelperOutput(chunk: Buffer, target: ChildProcessWithoutNullStreams): void {
  if (helper !== target || !pending) return;
  helperOutput = Buffer.concat([helperOutput, chunk]);
  if (helperOutput.length > config.maximumFrameBytes + FRAME_HEADER_BYTES) {
    failTransport('Workspace entry helper emitted an oversized frame', target);
    return;
  }
  if (helperOutput.length < FRAME_HEADER_BYTES) return;
  const length = helperOutput.readUInt32BE(0);
  if (length === 0 || length > config.maximumFrameBytes) {
    failTransport('Workspace entry helper emitted an invalid frame length', target);
    return;
  }
  if (helperOutput.length < FRAME_HEADER_BYTES + length) return;
  if (helperOutput.length !== FRAME_HEADER_BYTES + length) {
    failTransport('Workspace entry helper emitted trailing protocol bytes', target);
    return;
  }
  const rawResponse = helperOutput.subarray(FRAME_HEADER_BYTES).toString('utf8');
  helperOutput = Buffer.alloc(0);
  finish(rawResponse);
}

function startHelper(): ChildProcessWithoutNullStreams {
  const neutralCwd = path.parse(config.executable).root;
  const child = spawn(config.executable, [config.childPath, '--persistent'], {
    cwd: neutralCwd,
    env: config.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  helper = child;
  helperOutput = Buffer.alloc(0);
  helperError = '';
  child.stdout.on('data', (chunk: Buffer) => acceptHelperOutput(chunk, child));
  child.stderr.on('data', (chunk: Buffer) => {
    if (helper !== child || helperError.length >= MAX_ERROR_MESSAGE_BYTES) return;
    helperError += chunk.toString('utf8').slice(0, MAX_ERROR_MESSAGE_BYTES - helperError.length);
  });
  child.once('error', (error) => {
    if (helper !== child) return;
    failTransport(`Workspace entry helper could not start: ${error.message}`, child);
  });
  child.once('exit', (code, signal) => {
    if (helper !== child) return;
    const detail = helperError.trim();
    failTransport(
      `Workspace entry helper exited (${signal ?? code ?? 'unknown'})${detail ? `: ${detail}` : ''}`,
      child,
    );
  });
  return child;
}

function send(request: BrokerRequest): void {
  if (pending) {
    publish(request.requestId, errorResponse('Workspace entry helper broker refused a concurrent request'));
    return;
  }
  if (!Number.isSafeInteger(request.requestId) || request.requestId <= 0
    || typeof request.canonicalPath !== 'string' || !path.isAbsolute(request.canonicalPath)
    || path.resolve(request.canonicalPath) !== request.canonicalPath
    || typeof request.rawRequest !== 'string'
    || Buffer.byteLength(request.rawRequest, 'utf8') > config.maximumFrameBytes) {
    publish(request.requestId, errorResponse('Workspace entry helper broker received an invalid request'));
    return;
  }
  try {
    const wire = JSON.parse(request.rawRequest) as { cwdPath?: unknown };
    if (!wire || typeof wire !== 'object' || wire.cwdPath !== request.canonicalPath) {
      throw new Error('cwd mismatch');
    }
  } catch {
    publish(request.requestId, errorResponse('Workspace entry helper broker received a mismatched cwd'));
    return;
  }

  const target = helper ?? startHelper();
  const payload = Buffer.from(request.rawRequest, 'utf8');
  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, FRAME_HEADER_BYTES);
  const timer = setTimeout(() => {
    if (!pending || pending.requestId !== request.requestId) return;
    failTransport('Workspace entry helper timed out', target);
  }, config.timeoutMs);
  timer.unref();
  pending = { requestId: request.requestId, timer };
  target.stdin.write(frame, (error) => {
    if (error && pending?.requestId === request.requestId) {
      failTransport(`Workspace entry helper transport write failed: ${error.message}`, target);
    }
  });
}

parentPort.on('message', (message: unknown) => {
  try {
    const request = message as Partial<BrokerRequest>;
    if (request?.type !== 'request') return;
    send(request as BrokerRequest);
  } catch (error) {
    failBroker(error);
  }
});

parentPort.once('close', () => stopHelper());
process.once('uncaughtException', (error) => failBroker(error));
process.once('unhandledRejection', (error) => failBroker(error));
Atomics.store(control, CONTROL_STATE, BROKER_IDLE);
Atomics.notify(control, CONTROL_STATE, 1);
