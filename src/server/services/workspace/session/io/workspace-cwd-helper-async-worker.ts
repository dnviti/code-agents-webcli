import fs from 'node:fs';
import path from 'node:path';
import { parentPort } from 'node:worker_threads';
import {
  closeWorkspaceCwdHelpers,
  runWorkspaceCwdHelper,
  type WorkspaceCwdHelperOperation,
} from './workspace-cwd-helper.js';

interface WorkerRequest {
  type: 'request';
  requestId: number;
  lease: {
    canonicalPath: string;
    fd: number;
    dev: string;
    ino: string;
  };
  operation: WorkspaceCwdHelperOperation;
}

const MAX_IDENTITY_DIGITS = 32;

function unsafe(message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code: 'UNSAFE_WORKSPACE_STORAGE' });
}

function serializedError(error: unknown): {
  name: string;
  message: string;
  stack?: string;
  code?: string;
} {
  const caught = error instanceof Error ? error : new Error(String(error));
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return {
    name: caught.name.slice(0, 128),
    message: caught.message.slice(0, 2_048),
    ...(caught.stack ? { stack: caught.stack.slice(0, 16_384) } : {}),
    ...(typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? { code } : {}),
  };
}

function leaseFor(request: WorkerRequest): {
  canonicalPath: string;
  fd: number;
  verify(): void;
} {
  const lease = request.lease;
  const unsignedIdentity = /^(?:0|[1-9]\d{0,31})$/;
  if (!lease || typeof lease.canonicalPath !== 'string'
    || !path.isAbsolute(lease.canonicalPath)
    || path.resolve(lease.canonicalPath) !== lease.canonicalPath
    || !Number.isSafeInteger(lease.fd) || lease.fd < 0
    || typeof lease.dev !== 'string' || lease.dev.length > MAX_IDENTITY_DIGITS
    || typeof lease.ino !== 'string' || lease.ino.length > MAX_IDENTITY_DIGITS
    || !unsignedIdentity.test(lease.dev) || !unsignedIdentity.test(lease.ino)
    || lease.ino === '0') {
    throw unsafe('Workspace entry helper worker received an invalid lease');
  }
  const expected = { dev: BigInt(lease.dev), ino: BigInt(lease.ino) };
  return {
    canonicalPath: lease.canonicalPath,
    fd: lease.fd,
    verify: () => {
      const current = fs.fstatSync(lease.fd, { bigint: true });
      if (!current.isDirectory() || current.dev !== expected.dev || current.ino !== expected.ino) {
        throw unsafe('Workspace entry helper worker lease changed while it was in use');
      }
    },
  };
}

const port = parentPort;
if (!port) throw new Error('Workspace entry helper worker requires a parent port');

port.on('message', (message: unknown) => {
  const request = message as Partial<WorkerRequest>;
  if (request?.type !== 'request' || !Number.isSafeInteger(request.requestId)) return;
  try {
    const result = runWorkspaceCwdHelper(
      leaseFor(request as WorkerRequest),
      (request as WorkerRequest).operation,
    );
    port.postMessage({ type: 'result', requestId: request.requestId, result });
  } catch (error) {
    port.postMessage({
      type: 'result',
      requestId: request.requestId,
      error: serializedError(error),
    });
  }
});

process.once('exit', () => closeWorkspaceCwdHelpers());
