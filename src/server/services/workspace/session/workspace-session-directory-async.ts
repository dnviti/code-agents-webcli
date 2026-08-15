import path from 'node:path';
import { Worker } from 'node:worker_threads';

export interface WorkspaceSessionDirectoryOpenRef {
  id: string;
  ownerUserId: number;
  storageRoot?: string;
  ownerKey?: string;
  storageScope?: { readonly workspaceRoot: string; readonly ownerKey: string };
}

export interface OpenedWorkspaceSessionDirectory {
  canonicalPath: string;
  accessPath: string;
  pathFallback: boolean;
  entryMutationPolicy: 'descriptor' | 'cwd-helper' | 'deny';
  identity: { dev: string; ino: string };
}

interface WorkerReply {
  type: 'result';
  result?: OpenedWorkspaceSessionDirectory;
  error?: { message?: string; code?: string; stack?: string };
}

function transportError(message: string, cause?: unknown): NodeJS.ErrnoException {
  return Object.assign(new Error(message), {
    code: 'WORKSPACE_HELPER_TRANSPORT',
    cause,
  });
}

/** Open a cold Windows session hierarchy without blocking the server thread. */
export function openWorkspaceSessionDirectoryOffThread(
  ref: WorkspaceSessionDirectoryOpenRef,
): Promise<OpenedWorkspaceSessionDirectory> {
  let worker: Worker;
  try {
    worker = new Worker(path.join(__dirname, 'workspace-session-directory-worker.js'), {
      workerData: {
        ref: {
          id: ref.id,
          ownerUserId: ref.ownerUserId,
          ...(ref.storageRoot === undefined ? {} : { storageRoot: ref.storageRoot }),
          ...(ref.ownerKey === undefined ? {} : { ownerKey: ref.ownerKey }),
          ...(ref.storageScope === undefined ? {} : {
            storageScope: {
              workspaceRoot: ref.storageScope.workspaceRoot,
              ownerKey: ref.storageScope.ownerKey,
            },
          }),
        },
      },
    });
  } catch (error) {
    return Promise.reject(transportError('Workspace session directory worker could not start', error));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let retiring = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (error?: Error, result?: OpenedWorkspaceSessionDirectory): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else if (result) resolve(result);
      else reject(transportError('Workspace session directory worker omitted its result'));
    };
    const retire = (error: Error): void => {
      if (settled || retiring) return;
      retiring = true;
      if (timer) clearTimeout(timer);
      worker.unref();
      let termination: Promise<number>;
      try {
        termination = worker.terminate();
      } catch (terminationError) {
        termination = Promise.reject(terminationError);
      }
      void Promise.allSettled([termination]).then(() => finish(error));
    };
    timer = setTimeout(() => {
      retire(transportError('Workspace session directory worker timed out after 60000ms'));
    }, 60_000);
    timer.unref();

    worker.once('message', (message: unknown) => {
      const reply = message as Partial<WorkerReply>;
      if (reply?.type !== 'result' || (reply.result === undefined) === (reply.error === undefined)) {
        retire(transportError('Workspace session directory worker returned an invalid response'));
        return;
      }
      if (reply.error) {
        const error = new Error(String(reply.error.message ?? 'Workspace session directory open failed').slice(0, 2_048));
        if (typeof reply.error.code === 'string' && /^[A-Z0-9_]+$/.test(reply.error.code)) {
          Object.assign(error, { code: reply.error.code });
        }
        if (typeof reply.error.stack === 'string') error.stack = reply.error.stack.slice(0, 16_384);
        finish(error);
      } else {
        finish(undefined, reply.result);
      }
    });
    worker.once('error', (error) => {
      const detail = error instanceof Error ? error : new Error(String(error));
      retire(transportError(`Workspace session directory worker crashed: ${detail.message}`, detail));
    });
    worker.once('exit', (code) => {
      if (!settled && !retiring) {
        finish(transportError(`Workspace session directory worker exited unexpectedly (${code})`));
      }
    });
  });
}
