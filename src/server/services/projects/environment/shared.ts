import type { FileHandle } from 'node:fs/promises';
import type { WorkspaceStorageIdentity } from '../../workspace/session/workspace-session-storage.js';

export const WORKSPACE_SESSION_STORAGE = '.cc-web';

export interface PinnedWorkspaceDirectory {
  directory: string;
  handle: FileHandle | null;
  dev: bigint;
  ino: bigint;
  descriptorPath: string | null;
}

export interface StagedWorkspaceSessionStorage extends WorkspaceStorageIdentity {
  readonly path: string;
}
