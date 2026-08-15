import fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { closeWorkspaceCwdHelpers } from './io/workspace-cwd-helper.js';
import { detachSessionDirectoryLease } from './workspace-session-lease-cache.js';
import {
  workspaceSessionAccessDirectory,
  workspaceSessionDirectory,
  type WorkspaceSessionIdentity,
} from './workspace-session-storage.js';

function serializedError(error: unknown): { message: string; code?: string; stack?: string } {
  const caught = error instanceof Error ? error : new Error(String(error));
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return {
    message: caught.message.slice(0, 2_048),
    ...(typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? { code } : {}),
    ...(caught.stack ? { stack: caught.stack.slice(0, 16_384) } : {}),
  };
}

const port = parentPort;
if (!port) throw new Error('Workspace session directory worker requires a parent port');

let detachedFd: number | null = null;
try {
  const ref = (workerData as { ref?: unknown })?.ref as WorkspaceSessionIdentity;
  const canonicalPath = workspaceSessionDirectory(ref);
  if (!canonicalPath) throw new Error('Workspace session directory worker requires project-local storage');
  // This worker is only spawned on the win32 cold-start path
  // (`establishSessionDirectoryLease`), where entry mutation is delegated to
  // the cwd helper. The worker thread does not inherit a test-forced
  // `process.platform`, so resolve with the same forced backend the parent
  // commit to rather than letting the host's descriptor namespace decide.
  const accessPath = workspaceSessionAccessDirectory(ref, { forceCwdHelper: true });
  const lease = detachSessionDirectoryLease(canonicalPath);
  if (!accessPath || !lease || accessPath !== lease.accessPath) {
    throw new Error('Workspace session directory worker could not transfer its lease');
  }
  detachedFd = lease.fd;
  port.postMessage({
    type: 'result',
    result: {
      canonicalPath,
      accessPath,
      pathFallback: lease.pathFallback,
      entryMutationPolicy: lease.entryMutationPolicy,
      identity: { dev: lease.identity.dev.toString(), ino: lease.identity.ino.toString() },
    },
  });
} catch (error) {
  port.postMessage({ type: 'result', error: serializedError(error) });
} finally {
  closeWorkspaceCwdHelpers();
  if (detachedFd !== null) {
    try { fs.closeSync(detachedFd); } catch { /* Exact failed-transfer cleanup. */ }
  }
  port.close();
}
