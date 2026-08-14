import path from 'node:path';
import type { WorkspaceStorageIdentity } from '../../workspace-session-storage.js';
import { EnvironmentEngine, RunResult } from '../../environments/engine.js';
import { UserEnvironment, WrappedProcessControl } from '../../environments/types.js';
import { PROJECT_WORKSPACE } from './constants.js';

export type WorkspaceSessionStorageIdentity = WorkspaceStorageIdentity;

export interface ProjectEnvironmentResult {
  environment: UserEnvironment;
  /** Exact engine snapshot that admitted this project runtime. */
  engine: EnvironmentEngine;
  workingDir: string;
  /** Host roots a requested/persisted session cwd may be confined within. */
  allowedWorkingDirs: string[];
  /**
   * Engine-scoped paths for terminal/file-browser operations.  These are never
   * host paths: arbitrary paths such as /tmp exist only in this project's
   * container. The roots have intentionally different lifetime guarantees:
   * owner home survives rebuild; workspace survives an ordinary stop but is
   * wiped/fresh-cloned on a true rebuild; every other path is disposable.
   */
  containerAccess: ProjectContainerAccess;
  containerName: string;
  created: boolean;
}

export interface ProjectContainerAccess {
  projectId: string;
  ownerUserId: number;
  containerName: string;
  containerIdentity: string;
  root: '/';
  workspaceRoot: typeof PROJECT_WORKSPACE;
  ownerHomeRoot: string;
}

export interface ProjectTrackedExecution {
  result: Promise<RunResult>;
  processControl: WrappedProcessControl;
}

export interface ProjectTrackedSpawnDescriptor {
  file: string;
  args: string[];
  processControl: WrappedProcessControl;
  /** Re-inspect through the exact engine snapshot that built this descriptor. */
  verifyIdentity(): Promise<void>;
}

export type ProjectContainerPathLifetime = 'workspace' | 'owner_home' | 'disposable';

/** Validate a container-local cwd without ever confusing it for a host path. */
export function validateProjectContainerPath(access: ProjectContainerAccess, input: string): string {
  if (typeof input !== 'string' || !input || input.includes('\0') || !path.posix.isAbsolute(input)) {
    throw new Error('project container path must be an absolute path');
  }
  const normalized = path.posix.normalize(input);
  if (!normalized.startsWith('/')) throw new Error('project container path escapes its root');
  return normalized;
}

export function classifyProjectContainerPath(access: ProjectContainerAccess, input: string): ProjectContainerPathLifetime {
  const value = validateProjectContainerPath(access, input);
  const within = (root: string) => value === root || value.startsWith(`${root}/`);
  if (within(access.ownerHomeRoot)) return 'owner_home';
  if (within(access.workspaceRoot)) return 'workspace';
  return 'disposable';
}

export type ProjectCheckoutState = 'valid' | 'empty_or_absent' | 'unsafe';
