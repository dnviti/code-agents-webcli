/** The project-shaped container: a durable owner home plus a disposable workspace. */

import { constants as fsConstants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import fsp from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ContainerEnvironment, EnvironmentManager, HostEnvironment, LOGIN_LABEL, MANAGED_LABEL, TIER_LABEL, USER_ID_LABEL } from '../environments/manager.js';
import { EnvironmentEngine, RunResult } from '../environments/engine.js';
import { trackContainerProcess } from '../environments/process-control.js';
import { PROJECT_LABEL, projectContainerName, TARGET_LABEL, targetLabelValue } from '../environments/naming.js';
import { EnvironmentOwner, Mount, UserEnvironment, WrappedProcessControl } from '../environments/types.js';
import { Project } from './store.js';
import { repoBaseName } from './clone.js';
import type { WorkspaceStorageIdentity } from '../workspace-session-storage.js';

export const PROJECT_WORKSPACE = '/workspace';
export const PROJECT_OVERLAY = '/opt/code-agents-project';
export const FORGE_SCRATCH = '/run/code-agents-forge';
const WORKSPACE_SESSION_STORAGE = '.cc-web';

interface PinnedWorkspaceDirectory {
  directory: string;
  handle: FileHandle | null;
  dev: bigint;
  ino: bigint;
  descriptorPath: string | null;
}

export type WorkspaceSessionStorageIdentity = WorkspaceStorageIdentity;

interface StagedWorkspaceSessionStorage extends WorkspaceSessionStorageIdentity {
  readonly path: string;
}

/** Portable app-owned root used by host-local projects. */
export function localProjectWorkspaceRoot(homeDir = os.homedir(), pathApi: Pick<typeof path, 'join'> = path): string {
  return pathApi.join(homeDir, '.cc-web', 'workspaces');
}

/** Secret-free, application-owned paths exposed in container metadata. */
export function projectContainerEnvironment(containerHome: string, login: string): Record<string, string> {
  const miseData = `${containerHome}/.local/share/code-agents/mise`;
  const miseShims = `${miseData}/shims`;
  return {
    HOME: containerHome,
    USER: login,
    TERM: 'xterm-256color',
    PATH: `${miseShims}:${containerHome}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    MISE_DATA_DIR: miseData,
    MISE_CACHE_DIR: `${containerHome}/.cache/code-agents/mise`,
    MISE_STATE_DIR: `${containerHome}/.local/state/code-agents/mise`,
    MISE_CONFIG_DIR: `${PROJECT_OVERLAY}/mise`,
    MISE_CONFIG_FILE: `${PROJECT_OVERLAY}/mise.toml`,
    MISE_SHIMS_DIR: miseShims,
    MISE_AUTO_INSTALL: '0',
    // App-generated project config includes the user's durable ~/.gitconfig
    // and may layer a project-only identity without mutating repository data.
    GIT_CONFIG_GLOBAL: `${PROJECT_OVERLAY}/gitconfig`,
    GIT_CONFIG_NOSYSTEM: '1',
    GH_CONFIG_DIR: `${FORGE_SCRATCH}/gh`,
    GLAB_CONFIG_DIR: `${FORGE_SCRATCH}/glab`,
    // tea itself reads XDG_CONFIG_HOME; its app-owned launcher points there.
    // This metadata value names that same tmpfs file without containing a token.
    TEA_CONFIG: `${FORGE_SCRATCH}/xdg/tea/config.yml`,
  };
}

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

/** A same-name container is known to belong to somebody else; never touch it. */
export class ProjectContainerOwnershipError extends Error {}

/**
 * Engine preparation may have left this project's deterministic container
 * running, but ownership/absence or a successful stop could not be proven.
 * Callers must record the name and retain a counted lifecycle state.
 */
export class ProjectContainerStateUnknownError extends Error {
  constructor(message: string, readonly containerName: string) {
    super(message);
  }
}

/** Workspace history could not be moved without risking traversal or loss. */
export class ProjectWorkspaceSessionStorageError extends Error {}

export type ProjectCheckoutState = 'valid' | 'empty_or_absent' | 'unsafe';

export class ProjectEnvironmentManager {
  constructor(
    private readonly environments: EnvironmentManager,
    private readonly localWorkspaceRoot = localProjectWorkspaceRoot(),
    /** Linux can address an opened directory without resolving its mutable name again. */
    private readonly descriptorDirectory: string | null = process.platform === 'linux' ? '/proc/self/fd' : null,
    /** Test seam for the path-only fallback used where directory handles are unavailable. */
    private readonly allowDirectoryHandles = process.platform !== 'win32',
  ) {}

  worktreePath(project: Project, _owner: EnvironmentOwner): string {
    if (project.executionKind === 'host') {
      return path.join(this.localWorkspaceRoot, project.id);
    }
    // Sibling of owner homes: mounting the persistent home into project A must
    // not reveal project B through /home/<owner>/projects/B.
    return path.join(this.environments.projectStorageRoot(project.targetId), project.id);
  }

  ownerHomePath(project: Project, owner: EnvironmentOwner): string {
    if (project.executionKind === 'host') return os.homedir();
    return this.environments.ownerHomeOnTarget(owner, project.targetId).hostPath;
  }

  checkoutPath(project: Project, owner: EnvironmentOwner): string {
    const root = this.worktreePath(project, owner);
    return project.repoUrl ? path.join(root, repoBaseName(project.repoUrl)) : root;
  }

  checkoutContainerPath(project: Project): string {
    return project.repoUrl ? `${PROJECT_WORKSPACE}/${repoBaseName(project.repoUrl)}` : PROJECT_WORKSPACE;
  }

  /** Project-only durable settings, deliberately outside every owner home. */
  overlayPath(project: Project): string {
    if (project.executionKind === 'host') {
      return path.join(os.homedir(), '.cc-web', 'project-overlays', project.id);
    }
    return path.join(
      this.environments.projectTarget(project.targetId).config.rootDir,
      'project-overlays',
      project.id,
    );
  }

  /** Stable host roots consumed by lifecycle cleanup and storage reporting. */
  durablePaths(project: Project, owner: EnvironmentOwner): {
    ownerHome: string;
    workspace: string;
    overlay: string;
  } {
    return {
      ownerHome: this.ownerHomePath(project, owner),
      workspace: this.worktreePath(project, owner),
      overlay: this.overlayPath(project),
    };
  }

  /** Integration calls this only after the owner-scoped project row is deleted. */
  async removeOverlay(project: Project): Promise<void> {
    await this.removePinnedOwnedDirectory(
      this.overlayPath(project),
      project.id,
      'project overlay',
    );
  }

  /** Durable project root: checkout replacement never owns this directory. */
  workspaceSessionStoragePath(project: Project, owner: EnvironmentOwner): string {
    return path.join(this.worktreePath(project, owner), WORKSPACE_SESSION_STORAGE);
  }

  /**
   * Crash-recovery slot outside the bind-mounted project root.
   *
   * A container can rename any child below `/workspace`, so merely keeping an
   * open handle to `<workspace>/.cc-web` does not stop it exchanging that name
   * with the checkout immediately before a recursive delete.  The parent of
   * the project root is not mounted into the project container; moving the
   * exact pinned archive here removes it from that mutation namespace for the
   * complete destructive operation.  The deterministic name also lets the
   * next process restore an archive after a crash between stage and restore.
   */
  private workspaceSessionStorageStagingPath(project: Project, owner: EnvironmentOwner): string {
    const root = this.worktreePath(project, owner);
    if (
      !project.id
      || project.id === '.'
      || project.id === '..'
      || path.basename(project.id) !== project.id
      || path.basename(root) !== project.id
    ) {
      throw new ProjectWorkspaceSessionStorageError('refusing unsafe workspace session staging path');
    }
    return path.join(path.dirname(root), `.${project.id}.ccweb-session-storage-retained`);
  }

  /** Durable authority survives both a failed stage and a process crash. */
  private workspaceSessionStorageIntentPaths(
    project: Project,
    owner: EnvironmentOwner,
  ): { intent: string; pending: string } {
    const staging = this.workspaceSessionStorageStagingPath(project, owner);
    const prefix = staging.slice(0, -'retained'.length);
    const intent = `${prefix}intent`;
    return { intent, pending: `${intent}.pending` };
  }

  private parseWorkspaceSessionStorageIntent(
    raw: string,
    label: string,
  ): WorkspaceSessionStorageIdentity {
    if (Buffer.byteLength(raw) > 512) {
      throw new ProjectWorkspaceSessionStorageError(`${label} is too large`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ProjectWorkspaceSessionStorageError(`${label} is corrupt`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ProjectWorkspaceSessionStorageError(`${label} is corrupt`);
    }
    const record = parsed as Record<string, unknown>;
    if (
      record.version !== 1
      || typeof record.dev !== 'string'
      || typeof record.ino !== 'string'
      || !/^\d{1,32}$/.test(record.dev)
      || !/^[1-9]\d{0,31}$/.test(record.ino)
      || Object.keys(record).some((key) => !['version', 'dev', 'ino'].includes(key))
    ) {
      throw new ProjectWorkspaceSessionStorageError(`${label} is corrupt`);
    }
    return { dev: BigInt(record.dev), ino: BigInt(record.ino) };
  }

  private async readWorkspaceSessionStorageIntentFile(
    target: string,
    label: string,
  ): Promise<WorkspaceSessionStorageIdentity | null> {
    const before = await this.lstatOrNull(target);
    if (!before) return null;
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || before.size > 512) {
      throw new ProjectWorkspaceSessionStorageError(`${label} is not a private regular file`);
    }
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
    let handle: FileHandle;
    try {
      handle = await fsp.open(target, flags);
    } catch (error) {
      throw new ProjectWorkspaceSessionStorageError(`could not open ${label}: ${(error as Error).message}`);
    }
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile()
        || opened.nlink !== 1
        || opened.dev !== before.dev
        || opened.ino !== before.ino
        || opened.size > 512
      ) {
        throw new ProjectWorkspaceSessionStorageError(`${label} changed while it was opened`);
      }
      const raw = await handle.readFile({ encoding: 'utf8' });
      const [after, openedAfter] = await Promise.all([this.lstatOrNull(target), handle.stat()]);
      if (
        !after
        || after.isSymbolicLink()
        || !after.isFile()
        || after.nlink !== 1
        || after.dev !== openedAfter.dev
        || after.ino !== openedAfter.ino
        || openedAfter.dev !== opened.dev
        || openedAfter.ino !== opened.ino
      ) {
        throw new ProjectWorkspaceSessionStorageError(`${label} changed while it was read`);
      }
      return this.parseWorkspaceSessionStorageIntent(raw, label);
    } finally {
      await handle.close();
    }
  }

  private async readWorkspaceSessionStorageIntent(
    project: Project,
    owner: EnvironmentOwner,
  ): Promise<WorkspaceSessionStorageIdentity | null> {
    const parent = await this.pinDirectory(
      path.dirname(this.worktreePath(project, owner)),
      'project workspace parent',
    );
    if (!parent) return null;
    try {
      const paths = this.workspaceSessionStorageIntentPaths(project, owner);
      const intentPath = await this.pinnedChildPath(parent, path.basename(paths.intent), 'project workspace parent');
      const pendingPath = await this.pinnedChildPath(parent, path.basename(paths.pending), 'project workspace parent');
      const [intent, pending] = await Promise.all([
        this.readWorkspaceSessionStorageIntentFile(intentPath, 'workspace session storage intent'),
        this.readWorkspaceSessionStorageIntentFile(pendingPath, 'pending workspace session storage intent'),
      ]);
      if (intent && pending && !this.storageIdentityMatches(intent, pending)) {
        throw new ProjectWorkspaceSessionStorageError('workspace session storage intent generations disagree');
      }
      await this.assertPinnedNamespace(parent, 'project workspace parent');
      return intent || pending;
    } finally {
      await parent.handle?.close();
    }
  }

  /**
   * Persist authority obtained from the live SQLite directory lease before the
   * composition root closes that lease. Both the final and pending names are
   * recognised during recovery, so a crash on either side of rename fails
   * closed instead of accepting a same-name replacement.
   */
  async recordWorkspaceSessionStorageIntent(
    project: Project,
    owner: EnvironmentOwner,
    expected: WorkspaceSessionStorageIdentity,
  ): Promise<void> {
    const parent = await this.pinDirectory(
      path.dirname(this.worktreePath(project, owner)),
      'project workspace parent',
    );
    if (!parent) {
      throw new ProjectWorkspaceSessionStorageError(
        'project workspace parent disappeared before session storage intent could be recorded',
      );
    }
    let pendingHandle: FileHandle | null = null;
    try {
      const paths = this.workspaceSessionStorageIntentPaths(project, owner);
      const intentPath = await this.pinnedChildPath(parent, path.basename(paths.intent), 'project workspace parent');
      const pendingPath = await this.pinnedChildPath(parent, path.basename(paths.pending), 'project workspace parent');
      const [intent, pending] = await Promise.all([
        this.readWorkspaceSessionStorageIntentFile(intentPath, 'workspace session storage intent'),
        this.readWorkspaceSessionStorageIntentFile(pendingPath, 'pending workspace session storage intent'),
      ]);
      for (const existing of [intent, pending]) {
        if (existing && !this.storageIdentityMatches(expected, existing)) {
          throw new ProjectWorkspaceSessionStorageError(
            'workspace session storage intent belongs to another inode',
          );
        }
      }
      if (!intent && !pending) {
        const flags = fsConstants.O_WRONLY
          | fsConstants.O_CREAT
          | fsConstants.O_EXCL
          | (fsConstants.O_NOFOLLOW || 0);
        pendingHandle = await fsp.open(pendingPath, flags, 0o600);
        const payload = `${JSON.stringify({
          version: 1,
          dev: String(expected.dev),
          ino: String(expected.ino),
        })}\n`;
        await pendingHandle.writeFile(payload, { encoding: 'utf8' });
        await pendingHandle.chmod(0o600);
        await pendingHandle.sync();
        const written = await pendingHandle.stat();
        if (!written.isFile() || written.nlink !== 1 || written.size !== Buffer.byteLength(payload)) {
          throw new ProjectWorkspaceSessionStorageError(
            'pending workspace session storage intent was not written safely',
          );
        }
        await pendingHandle.close();
        pendingHandle = null;
      }
      if (!intent) {
        if (await this.lstatOrNull(intentPath)) {
          throw new ProjectWorkspaceSessionStorageError(
            'workspace session storage intent name became occupied',
          );
        }
        await this.assertPinnedNamespace(parent, 'project workspace parent');
        await fsp.rename(pendingPath, intentPath);
      }
      await this.syncPinnedDirectory(parent, 'project workspace parent');
      const durable = await this.readWorkspaceSessionStorageIntentFile(
        intentPath,
        'workspace session storage intent',
      );
      if (!durable || !this.storageIdentityMatches(expected, durable)) {
        throw new ProjectWorkspaceSessionStorageError(
          'workspace session storage intent did not become durable',
        );
      }
    } catch (error) {
      if (error instanceof ProjectWorkspaceSessionStorageError) throw error;
      throw new ProjectWorkspaceSessionStorageError(
        `could not record workspace session storage intent: ${(error as Error).message}`,
      );
    } finally {
      await pendingHandle?.close();
      await parent.handle?.close();
    }

    const visible = await this.workspaceSessionStorageIdentity(project, owner);
    if (!visible || !this.storageIdentityMatches(expected, visible)) {
      throw new ProjectWorkspaceSessionStorageError(
        'workspace session storage changed before its durable intent was verified',
      );
    }
  }

  private async clearWorkspaceSessionStorageIntent(
    project: Project,
    owner: EnvironmentOwner,
    expected: WorkspaceSessionStorageIdentity,
  ): Promise<void> {
    const parent = await this.pinDirectory(
      path.dirname(this.worktreePath(project, owner)),
      'project workspace parent',
    );
    if (!parent) {
      throw new ProjectWorkspaceSessionStorageError(
        'project workspace parent disappeared before session storage intent could be cleared',
      );
    }
    try {
      const paths = this.workspaceSessionStorageIntentPaths(project, owner);
      for (const [target, label] of [
        [paths.intent, 'workspace session storage intent'],
        [paths.pending, 'pending workspace session storage intent'],
      ] as const) {
        const anchored = await this.pinnedChildPath(parent, path.basename(target), 'project workspace parent');
        const identity = await this.readWorkspaceSessionStorageIntentFile(anchored, label);
        if (!identity) continue;
        if (!this.storageIdentityMatches(expected, identity)) {
          throw new ProjectWorkspaceSessionStorageError(`${label} belongs to another inode`);
        }
        await fsp.unlink(anchored);
      }
      await this.syncPinnedDirectory(parent, 'project workspace parent');
    } finally {
      await parent.handle?.close();
    }
  }

  /**
   * Capture the exact archive inode before integration suspends its open stores.
   * Lifecycle replacement must carry this authority through staging and reopen;
   * a later safe-looking directory at the same name is not equivalent.
   */
  async workspaceSessionStorageIdentity(
    project: Project,
    owner: EnvironmentOwner,
  ): Promise<WorkspaceSessionStorageIdentity | null> {
    const root = this.worktreePath(project, owner);
    const pinned = await this.pinDirectory(root, 'project workspace');
    if (!pinned) return null;
    let storage: PinnedWorkspaceDirectory | null = null;
    try {
      storage = await this.pinWorkspaceSessionStorage(pinned);
      await this.assertPinnedNamespace(pinned, 'project workspace');
      if (storage) await this.assertPinnedNamespace(storage, 'workspace session storage');
      if (!storage) return null;
      const identity = storage.handle
        ? await storage.handle.stat({ bigint: true })
        : await fsp.lstat(storage.directory, { bigint: true });
      return { dev: identity.dev, ino: identity.ino };
    } finally {
      await storage?.handle?.close();
      await pinned.handle?.close();
    }
  }

  /** Validate the in-place archive before any rebuild operation. */
  async preserveWorkspaceSessionStorage(project: Project, owner: EnvironmentOwner): Promise<boolean> {
    return (await this.workspaceSessionStorageIdentity(project, owner)) !== null;
  }

  /** Restore a crash-staged archive, then revalidate its canonical namespace. */
  async restoreWorkspaceSessionStorage(
    project: Project,
    owner: EnvironmentOwner,
    expected?: WorkspaceSessionStorageIdentity,
  ): Promise<boolean> {
    const intent = await this.readWorkspaceSessionStorageIntent(project, owner);
    if (intent && expected && !this.storageIdentityMatches(expected, intent)) {
      throw new ProjectWorkspaceSessionStorageError(
        'workspace session storage intent does not match the requested inode',
      );
    }
    const authority = intent || expected;
    await this.restoreStagedWorkspaceSessionStorage(project, owner, authority);
    const restored = await this.workspaceSessionStorageIdentity(project, owner);
    if (authority && (!restored || !this.storageIdentityMatches(authority, restored))) {
      throw new ProjectWorkspaceSessionStorageError(
        'workspace session storage is not the pre-suspension inode',
      );
    }
    return restored !== null;
  }

  /** Authority remains durable until integration has reopened the exact inode. */
  async workspaceSessionStorageRecoveryIdentity(
    project: Project,
    owner: EnvironmentOwner,
  ): Promise<WorkspaceSessionStorageIdentity | null> {
    return this.readWorkspaceSessionStorageIntent(project, owner);
  }

  /** Retire the crash intent only after the reopened database lease agrees. */
  async completeWorkspaceSessionStorageRestore(
    project: Project,
    owner: EnvironmentOwner,
    reopened: WorkspaceSessionStorageIdentity,
  ): Promise<void> {
    const intent = await this.readWorkspaceSessionStorageIntent(project, owner);
    if (!intent) return;
    if (!this.storageIdentityMatches(intent, reopened)) {
      throw new ProjectWorkspaceSessionStorageError(
        'reopened workspace database does not hold the retained archive inode',
      );
    }
    const canonical = await this.workspaceSessionStorageIdentity(project, owner);
    if (!canonical || !this.storageIdentityMatches(intent, canonical)) {
      throw new ProjectWorkspaceSessionStorageError(
        'workspace session storage changed before restore completion',
      );
    }
    await this.clearWorkspaceSessionStorageIntent(project, owner, intent);
    const durable = await this.workspaceSessionStorageIdentity(project, owner);
    if (!durable || !this.storageIdentityMatches(intent, durable)) {
      await this.recordWorkspaceSessionStorageIntent(project, owner, intent).catch(() => undefined);
      throw new ProjectWorkspaceSessionStorageError(
        'workspace session storage changed while its restore intent was retired',
      );
    }
  }

  /** Read-only boot probe used when container reconciliation is disabled. */
  async hasStagedWorkspaceSessionStorage(project: Project, owner: EnvironmentOwner): Promise<boolean> {
    if (await this.readWorkspaceSessionStorageIntent(project, owner)) return true;
    const staged = await this.pinDirectory(
      this.workspaceSessionStorageStagingPath(project, owner),
      'staged workspace session storage',
    );
    if (!staged) return false;
    try {
      await this.assertPinnedNamespace(staged, 'staged workspace session storage');
      return true;
    } finally {
      await staged.handle?.close();
    }
  }

  /** Remove rebuildable project bytes while leaving `<project>/.cc-web` in place. */
  async clearWorkspaceForRebuild(
    project: Project,
    owner: EnvironmentOwner,
    requireSessionStorage = false,
    expected?: WorkspaceSessionStorageIdentity,
  ): Promise<void> {
    await this.withStagedWorkspaceSessionStorage(
      project,
      owner,
      requireSessionStorage,
      'project rebuild',
      async () => {
        const root = this.worktreePath(project, owner);
        const pinned = await this.pinDirectory(root, 'project workspace');
        if (!pinned) return;
        try {
          const entries = await this.readdirPinned(pinned, 'project workspace');
          for (const entry of entries) {
            // A writer can recreate this name while the real archive is staged.
            // Never delete it: restoration will reject the conflict and keep the
            // authoritative staged inode outside the disposable namespace.
            if (entry === WORKSPACE_SESSION_STORAGE) continue;
            await this.removePinnedChild(pinned, entry, 'project workspace');
          }
          await this.assertPinnedNamespace(pinned, 'project workspace');
        } finally {
          await pinned.handle?.close();
        }
      },
      expected,
    );
  }

  /** Explicit project deletion is the only lifecycle operation that removes the archive. */
  async removeWorkspace(project: Project, owner: EnvironmentOwner): Promise<void> {
    await this.removePinnedOwnedDirectory(
      this.worktreePath(project, owner),
      project.id,
      'project workspace',
    );
  }

  private async removePinnedOwnedDirectory(
    root: string,
    expectedBaseName: string,
    label: string,
  ): Promise<void> {
    const parent = path.dirname(root);
    if (path.basename(root) !== expectedBaseName || path.resolve(root) === path.resolve(parent)) {
      throw new ProjectWorkspaceSessionStorageError(`refusing unsafe ${label} removal`);
    }
    const pinnedParent = await this.pinDirectory(parent, `${label} parent`);
    if (!pinnedParent) return;
    try {
      const anchoredRoot = path.join(
        await this.pinnedRootPath(pinnedParent, `${label} parent`),
        expectedBaseName,
      );
      const pinnedRoot = await this.pinDirectory(anchoredRoot, label);
      if (!pinnedRoot) return;
      try {
        // Explicit project deletion owns every child (including `.cc-web` in
        // a workspace). Overlay removal reaches this path only after its
        // owner-scoped project row has been deleted.
        // Delete those children through the already-opened root, never by
        // recursively resolving the mutable public directory name.
        for (const entry of await this.readdirPinned(pinnedRoot, label)) {
          await this.removePinnedChild(pinnedRoot, entry, label);
        }
        await this.assertPinnedNamespace(pinnedRoot, label);

        const removalTarget = await this.pinnedChildPath(
          pinnedParent,
          expectedBaseName,
          `${label} parent`,
        );
        await this.assertPathMatchesPinned(removalTarget, pinnedRoot, label);
        // Never recurse at the final mutable name. If it is replaced after
        // the identity check, a non-empty foreign directory makes rmdir fail
        // without deleting any of its children.
        await fsp.rmdir(removalTarget);
        await this.assertPinnedNamespace(pinnedParent, `${label} parent`);
      } finally {
        await pinnedRoot.handle?.close();
      }
    } finally {
      await pinnedParent.handle?.close();
    }
  }

  private async assertSafeTree(root: string, label: string): Promise<void> {
    const stat = await fsp.lstat(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ProjectWorkspaceSessionStorageError(`${label} must be a real directory`);
    }
    const entries = await fsp.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      const child = path.join(root, entry.name);
      const childStat = await fsp.lstat(child);
      if (childStat.isSymbolicLink()) {
        throw new ProjectWorkspaceSessionStorageError(`${label} contains a symbolic link`);
      }
      if (childStat.isDirectory()) {
        await this.assertSafeTree(child, label);
      } else if (!childStat.isFile()) {
        throw new ProjectWorkspaceSessionStorageError(`${label} contains an unsupported filesystem entry`);
      }
    }
  }

  /**
   * Open and identify a directory before a destructive lifecycle operation.
   * The before/open/after identity checks also cover platforms without
   * O_NOFOLLOW, where opening a symlink would otherwise follow it.
   */
  private async pinDirectory(directory: string, label: string): Promise<PinnedWorkspaceDirectory | null> {
    let before;
    try {
      before = await fsp.lstat(directory, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new ProjectWorkspaceSessionStorageError(`could not inspect ${label}: ${(error as Error).message}`);
    }
    if (before.isSymbolicLink() || !before.isDirectory()) {
      throw new ProjectWorkspaceSessionStorageError(`${label} must be a real directory`);
    }
    const canOpenWithoutFollowing = this.allowDirectoryHandles
      && typeof fsConstants.O_DIRECTORY === 'number'
      && typeof fsConstants.O_NOFOLLOW === 'number'
      && fsConstants.O_NOFOLLOW !== 0;
    // Platforms without safe directory FileHandle support use namespace
    // identity revalidation. POSIX platforms still open the directory even
    // when they lack `/proc/self/fd`, so metadata changes can use fchmod.
    if (!canOpenWithoutFollowing) {
      let after;
      try {
        after = await fsp.lstat(directory, { bigint: true });
      } catch (error) {
        throw new ProjectWorkspaceSessionStorageError(`could not verify ${label}: ${(error as Error).message}`);
      }
      if (
        after.isSymbolicLink()
        || !after.isDirectory()
        || after.dev !== before.dev
        || after.ino !== before.ino
      ) {
        throw new ProjectWorkspaceSessionStorageError(`${label} changed while it was being pinned`);
      }
      return {
        directory,
        handle: null,
        dev: before.dev,
        ino: before.ino,
        descriptorPath: null,
      };
    }
    const flags = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
    let handle: FileHandle;
    try {
      handle = await fsp.open(directory, flags);
    } catch (error) {
      throw new ProjectWorkspaceSessionStorageError(`could not pin ${label}: ${(error as Error).message}`);
    }
    try {
      const [opened, after] = await Promise.all([
        handle.stat({ bigint: true }),
        fsp.lstat(directory, { bigint: true }),
      ]);
      if (
        !opened.isDirectory()
        || after.isSymbolicLink()
        || !after.isDirectory()
        || opened.dev !== before.dev
        || opened.ino !== before.ino
        || after.dev !== opened.dev
        || after.ino !== opened.ino
      ) {
        throw new ProjectWorkspaceSessionStorageError(`${label} changed while it was being pinned`);
      }
      let descriptorPath: string | null = null;
      if (this.descriptorDirectory) {
        const candidate = path.join(this.descriptorDirectory, String(handle.fd));
        try {
          const descriptorStat = await fsp.stat(candidate, { bigint: true });
          if (descriptorStat.isDirectory() && descriptorStat.dev === opened.dev && descriptorStat.ino === opened.ino) {
            descriptorPath = candidate;
          }
        } catch {
          // Portable fallback below revalidates the public path before each operation.
        }
      }
      return {
        directory,
        handle,
        dev: opened.dev,
        ino: opened.ino,
        descriptorPath,
      };
    } catch (error) {
      await handle.close();
      if (error instanceof ProjectWorkspaceSessionStorageError) throw error;
      throw new ProjectWorkspaceSessionStorageError(`could not verify ${label}: ${(error as Error).message}`);
    }
  }

  private async assertPinnedHandle(pinned: PinnedWorkspaceDirectory, label: string): Promise<void> {
    if (!pinned.handle) return;
    const opened = await pinned.handle.stat({ bigint: true });
    if (!opened.isDirectory() || opened.dev !== pinned.dev || opened.ino !== pinned.ino) {
      throw new ProjectWorkspaceSessionStorageError(`${label} changed after it was pinned`);
    }
  }

  private async assertPinnedNamespace(pinned: PinnedWorkspaceDirectory, label: string): Promise<void> {
    await this.assertPinnedHandle(pinned, label);
    await this.assertPathMatchesPinned(pinned.directory, pinned, label);
  }

  private pinnedIdentityMatches(
    pinned: { dev: bigint; ino: bigint },
    candidate: { dev: bigint; ino: bigint; isDirectory(): boolean },
  ): boolean {
    return candidate.isDirectory()
      && candidate.dev === pinned.dev
      && candidate.ino === pinned.ino;
  }

  private storageIdentityMatches(
    expected: WorkspaceSessionStorageIdentity,
    candidate: { dev: bigint; ino: bigint },
  ): boolean {
    return candidate.dev === expected.dev && candidate.ino === expected.ino;
  }

  private async lstatOrNull(target: string): Promise<Awaited<ReturnType<typeof fsp.lstat>> | null> {
    try {
      return await fsp.lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async lstatIdentityOrNull(target: string): Promise<BigIntStats | null> {
    try {
      return await fsp.lstat(target, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  /** Make a directory-entry mutation durable while retaining its inode binding. */
  private async syncPinnedDirectory(
    pinned: PinnedWorkspaceDirectory,
    label: string,
  ): Promise<void> {
    await this.assertPinnedNamespace(pinned, label);
    if (pinned.handle) {
      try {
        await pinned.handle.sync();
      } catch (error) {
        throw new ProjectWorkspaceSessionStorageError(
          `could not make ${label} durable: ${(error as Error).message}`,
        );
      }
    } else if (process.platform !== 'win32') {
      // A POSIX path-only backend cannot make a directory rename durable while
      // proving which inode it synced.  Refuse the destructive operation rather
      // than claiming crash safety from a re-opened mutable pathname.
      throw new ProjectWorkspaceSessionStorageError(
        `${label} cannot be synchronised through a pinned directory handle`,
      );
    }
    // Windows directory handles are not exposed by this backend; its rename is
    // nevertheless protected by the platform's live-handle sharing semantics.
    await this.assertPinnedNamespace(pinned, label);
  }

  /**
   * Restore the deterministic crash slot without overwriting a canonical
   * archive.  When `expected` is supplied, this process must recover the exact
   * inode it staged before allowing the lifecycle operation to settle.
   */
  private async restoreStagedWorkspaceSessionStorage(
    project: Project,
    owner: EnvironmentOwner,
    expected?: WorkspaceSessionStorageIdentity,
  ): Promise<void> {
    const rootPath = this.worktreePath(project, owner);
    const parentPath = path.dirname(rootPath);
    const stagingPath = this.workspaceSessionStorageStagingPath(project, owner);
    const parent = await this.pinDirectory(parentPath, 'project workspace parent');
    if (!parent) {
      if (expected) {
        throw new ProjectWorkspaceSessionStorageError(
          'project workspace parent disappeared before session storage could be restored',
        );
      }
      return;
    }
    let root: PinnedWorkspaceDirectory | null = null;
    let staged: PinnedWorkspaceDirectory | null = null;
    try {
      const stagingAccess = await this.pinnedChildPath(
        parent,
        path.basename(stagingPath),
        'project workspace parent',
      );
      const visibleStaging = await this.lstatOrNull(stagingAccess);
      if (!visibleStaging) {
        if (expected) {
          const canonical = await this.lstatIdentityOrNull(
            path.join(rootPath, WORKSPACE_SESSION_STORAGE),
          );
          if (!canonical || !this.pinnedIdentityMatches(expected, canonical)) {
            throw new ProjectWorkspaceSessionStorageError(
              'staged workspace session storage disappeared before restoration',
            );
          }
        }
        return;
      }
      if (visibleStaging.isSymbolicLink() || !visibleStaging.isDirectory()) {
        throw new ProjectWorkspaceSessionStorageError(
          'workspace session staging slot is not a real directory',
        );
      }
      staged = await this.pinDirectory(stagingAccess, 'staged workspace session storage');
      if (!staged) {
        throw new ProjectWorkspaceSessionStorageError(
          'workspace session staging slot disappeared while it was opened',
        );
      }
      if (expected && !this.storageIdentityMatches(expected, staged)) {
        throw new ProjectWorkspaceSessionStorageError(
          'workspace session staging slot changed during project replacement',
        );
      }
      await this.assertSafeTree(staged.directory, 'staged workspace session storage');

      root = await this.pinDirectory(rootPath, 'project workspace');
      if (!root) {
        throw new ProjectWorkspaceSessionStorageError(
          'project workspace disappeared before session storage could be restored',
        );
      }
      const target = await this.pinnedChildPath(
        root,
        WORKSPACE_SESSION_STORAGE,
        'project workspace',
      );
      if (await this.lstatOrNull(target)) {
        throw new ProjectWorkspaceSessionStorageError(
          'workspace session storage name was occupied before restoration',
        );
      }

      await this.assertPinnedNamespace(parent, 'project workspace parent');
      await this.assertPinnedNamespace(root, 'project workspace');
      await this.assertPinnedNamespace(staged, 'staged workspace session storage');
      await fsp.rename(staged.directory, target);

      const restored = await this.lstatIdentityOrNull(target);
      if (!restored || !this.pinnedIdentityMatches(staged, restored)) {
        throw new ProjectWorkspaceSessionStorageError(
          'restored workspace session storage is not the staged inode',
        );
      }
      if (await this.lstatOrNull(stagingAccess)) {
        throw new ProjectWorkspaceSessionStorageError(
          'workspace session staging name remained after restoration',
        );
      }
      await this.syncPinnedDirectory(root, 'project workspace');
      await this.syncPinnedDirectory(parent, 'project workspace parent');
      const durable = await this.lstatIdentityOrNull(target);
      if (!durable || !this.pinnedIdentityMatches(staged, durable)) {
        throw new ProjectWorkspaceSessionStorageError(
          'workspace session storage changed while restoration became durable',
        );
      }
    } finally {
      await staged?.handle?.close();
      await root?.handle?.close();
      await parent.handle?.close();
    }
  }

  /** Move the exact admitted archive outside the container-writable root. */
  private async stageWorkspaceSessionStorage(
    project: Project,
    owner: EnvironmentOwner,
    expected?: WorkspaceSessionStorageIdentity,
  ): Promise<StagedWorkspaceSessionStorage | null> {
    const intent = await this.readWorkspaceSessionStorageIntent(project, owner);
    if (intent && expected && !this.storageIdentityMatches(expected, intent)) {
      throw new ProjectWorkspaceSessionStorageError(
        'workspace session storage intent does not match the requested inode',
      );
    }
    const authority = intent || expected;
    // Complete a prior crash recovery before creating a new staging generation.
    await this.restoreStagedWorkspaceSessionStorage(project, owner, authority);

    const rootPath = this.worktreePath(project, owner);
    const parentPath = path.dirname(rootPath);
    const stagingPath = this.workspaceSessionStorageStagingPath(project, owner);
    const parent = await this.pinDirectory(parentPath, 'project workspace parent');
    const root = await this.pinDirectory(rootPath, 'project workspace');
    if (!root) {
      await parent?.handle?.close();
      return null;
    }
    if (!parent) {
      await root.handle?.close();
      throw new ProjectWorkspaceSessionStorageError(
        'project workspace parent disappeared before session storage could be staged',
      );
    }
    let storage: PinnedWorkspaceDirectory | null = null;
    let staged: StagedWorkspaceSessionStorage | null = null;
    try {
      storage = await this.pinWorkspaceSessionStorage(root);
      if (!storage) {
        if (authority) {
          throw new ProjectWorkspaceSessionStorageError(
            'workspace session storage intent has no matching canonical archive',
          );
        }
        return null;
      }
      if (authority && !this.storageIdentityMatches(authority, storage)) {
        throw new ProjectWorkspaceSessionStorageError(
          'workspace session storage changed after its pre-suspension identity was captured',
        );
      }
      const stagingAccess = await this.pinnedChildPath(
        parent,
        path.basename(stagingPath),
        'project workspace parent',
      );
      if (await this.lstatOrNull(stagingAccess)) {
        throw new ProjectWorkspaceSessionStorageError(
          'workspace session staging slot is already occupied',
        );
      }
      await this.assertPinnedNamespace(parent, 'project workspace parent');
      await this.assertPinnedNamespace(root, 'project workspace');
      await this.assertPinnedNamespace(storage, 'workspace session storage');
      const admittedIdentity = storage.handle
        ? await storage.handle.stat({ bigint: true })
        : await fsp.lstat(storage.directory, { bigint: true });
      await fsp.rename(storage.directory, stagingAccess);
      staged = { path: stagingPath, dev: admittedIdentity.dev, ino: admittedIdentity.ino };

      const visibleStaging = await this.lstatIdentityOrNull(stagingAccess);
      if (!visibleStaging || !this.pinnedIdentityMatches(storage, visibleStaging)) {
        throw new ProjectWorkspaceSessionStorageError(
          'workspace session staging slot did not receive the pinned archive',
        );
      }
      if (await this.lstatOrNull(storage.directory)) {
        throw new ProjectWorkspaceSessionStorageError(
          'workspace session storage name was recreated during staging',
        );
      }
      await this.syncPinnedDirectory(root, 'project workspace');
      await this.syncPinnedDirectory(parent, 'project workspace parent');
      const durable = await this.lstatIdentityOrNull(stagingAccess);
      if (!durable || !this.pinnedIdentityMatches(storage, durable)) {
        throw new ProjectWorkspaceSessionStorageError(
          'workspace session staging slot changed while the move became durable',
        );
      }
      return staged;
    } catch (error) {
      if (staged) {
        try {
          await this.restoreStagedWorkspaceSessionStorage(project, owner, staged);
        } catch (restoreError) {
          throw new ProjectWorkspaceSessionStorageError(
            `workspace session storage staging failed and could not be restored: ${(error as Error).message}; ${(restoreError as Error).message}`,
          );
        }
      }
      throw error;
    } finally {
      await storage?.handle?.close();
      await root.handle?.close();
      await parent.handle?.close();
    }
  }

  /** Run one destructive operation only while the archive is out of reach. */
  private async withStagedWorkspaceSessionStorage(
    project: Project,
    owner: EnvironmentOwner,
    required: boolean,
    operationLabel: string,
    operation: () => Promise<void>,
    expected?: WorkspaceSessionStorageIdentity,
  ): Promise<void> {
    const staged = await this.stageWorkspaceSessionStorage(project, owner, expected);
    if (required && !staged) {
      throw new ProjectWorkspaceSessionStorageError(
        `workspace session storage disappeared before ${operationLabel}`,
      );
    }
    let operationError: unknown;
    try {
      await operation();
    } catch (error) {
      operationError = error;
    }

    let restoreError: unknown;
    if (staged) {
      try {
        await this.restoreStagedWorkspaceSessionStorage(project, owner, staged);
      } catch (error) {
        restoreError = error;
      }
    }
    if (restoreError) {
      throw new ProjectWorkspaceSessionStorageError(
        `${operationLabel} did not restore workspace session storage${operationError ? ` after ${(operationError as Error).message}` : ''}: ${(restoreError as Error).message}`,
      );
    }
    if (operationError) throw operationError;
  }

  private async assertPathMatchesPinned(
    target: string,
    pinned: PinnedWorkspaceDirectory,
    label: string,
  ): Promise<void> {
    let current;
    try {
      current = await fsp.lstat(target, { bigint: true });
    } catch (error) {
      throw new ProjectWorkspaceSessionStorageError(`${label} changed during lifecycle cleanup: ${(error as Error).message}`);
    }
    if (
      current.isSymbolicLink()
      || !current.isDirectory()
      || current.dev !== pinned.dev
      || current.ino !== pinned.ino
    ) {
      throw new ProjectWorkspaceSessionStorageError(`${label} changed during lifecycle cleanup`);
    }
  }

  private async pinnedRootPath(pinned: PinnedWorkspaceDirectory, label: string): Promise<string> {
    if (pinned.descriptorPath) {
      await this.assertPinnedHandle(pinned, label);
      return pinned.descriptorPath;
    }
    // This check deliberately sits immediately before every portable path
    // operation. A namespace swap observed between two entries aborts before
    // another recursive removal can be issued.
    await this.assertPinnedNamespace(pinned, label);
    return pinned.directory;
  }

  private async pinnedChildPath(
    pinned: PinnedWorkspaceDirectory,
    child: string,
    label: string,
  ): Promise<string> {
    if (!child || child === '.' || child === '..' || path.basename(child) !== child) {
      throw new ProjectWorkspaceSessionStorageError(`refusing unsafe child of ${label}`);
    }
    return path.join(await this.pinnedRootPath(pinned, label), child);
  }

  private async readdirPinned(pinned: PinnedWorkspaceDirectory, label: string): Promise<string[]> {
    return fsp.readdir(await this.pinnedRootPath(pinned, label));
  }

  private async removePinnedChild(
    pinned: PinnedWorkspaceDirectory,
    child: string,
    label: string,
  ): Promise<void> {
    const target = await this.pinnedChildPath(pinned, child, label);
    await fsp.rm(target, { recursive: true, force: true });
  }

  private async pinWorkspaceSessionStorage(
    pinnedWorkspace: PinnedWorkspaceDirectory,
  ): Promise<PinnedWorkspaceDirectory | null> {
    const storagePath = await this.pinnedChildPath(
      pinnedWorkspace,
      WORKSPACE_SESSION_STORAGE,
      'project workspace',
    );
    const storage = await this.pinDirectory(storagePath, 'workspace session storage');
    if (!storage) return null;
    try {
      await this.assertPinnedNamespace(storage, 'workspace session storage');
      // `storage.directory` is already rooted through the pinned workspace on
      // Linux. Unlike `/proc/self/fd/<storage-fd>` itself, its final component
      // is the real directory rather than a procfs magic symlink, so the tree
      // validator can keep rejecting ordinary symbolic links.
      await this.assertSafeTree(storage.directory, 'workspace session storage');
      await this.chmodPinnedDirectory(storage, 0o700, 'workspace session storage');
      return storage;
    } catch (error) {
      await storage.handle?.close();
      throw error;
    }
  }

  private async chmodPinnedDirectory(
    pinned: PinnedWorkspaceDirectory,
    mode: number,
    label: string,
  ): Promise<void> {
    await this.assertPinnedNamespace(pinned, label);
    if (pinned.handle) {
      await pinned.handle.chmod(mode);
    } else {
      await fsp.chmod(pinned.directory, mode);
    }
    // The FileHandle keeps chmod bound to the admitted inode. The portable
    // path-only fallback cannot bind the syscall, so its post-check makes any
    // observed namespace swap fail closed instead of being accepted.
    await this.assertPinnedNamespace(pinned, label);
  }

  /**
   * Resolve an already-running project without any lifecycle mutation.
   *
   * Composition retry uses this path so retrying failed tools cannot preserve,
   * wipe, recreate, start, or clone a project as an accidental side effect.
   */
  async existing(project: Project, owner: EnvironmentOwner): Promise<ProjectEnvironmentResult | null> {
    if (!project.container) return null;
    if (owner.id !== project.ownerUserId) {
      throw new ProjectContainerOwnershipError('project owner does not match the requested environment');
    }
    const target = this.environments.projectTarget(project.targetId);
    const owned = await this.ownedDescription(project, target.engine);
    if (!owned) return null;
    const ownerHome = this.environments.ownerHomeOnTarget(owner, project.targetId);
    const root = this.worktreePath(project, owner);
    const overlay = this.overlayPath(project);
    const mounts: Mount[] = [
      { hostPath: ownerHome.hostPath, containerPath: ownerHome.containerPath },
      { hostPath: root, containerPath: PROJECT_WORKSPACE },
      { hostPath: overlay, containerPath: PROJECT_OVERLAY },
      ...target.config.extraMounts,
    ];
    const environment = new ContainerEnvironment({
      name: owned.description.name,
      identity: owned.description.identity,
      homeDir: ownerHome.hostPath,
      containerHome: ownerHome.containerPath,
      engine: owned.engine,
      // Project compatibility requires Bash. Ignore legacy shell metadata so
      // an existing project created when this path advertised only `sh` is
      // upgraded immediately without rebuilding its container.
      shells: ['bash'],
      mounts: [mounts[1], mounts[2], mounts[0], ...mounts.slice(3)],
    });
    return {
      environment,
      engine: owned.engine,
      workingDir: this.checkoutPath(project, owner),
      allowedWorkingDirs: [root, ownerHome.hostPath],
      containerAccess: {
        projectId: project.id,
        ownerUserId: project.ownerUserId,
        containerName: owned.description.name,
        containerIdentity: owned.description.identity,
        root: '/',
        workspaceRoot: PROJECT_WORKSPACE,
        ownerHomeRoot: ownerHome.containerPath,
      },
      containerName: owned.description.name,
      created: false,
    };
  }

  async hasValidCheckout(project: Project, owner: EnvironmentOwner): Promise<boolean> {
    return (await this.checkoutState(project, owner)) === 'valid';
  }

  async checkoutState(project: Project, owner: EnvironmentOwner): Promise<ProjectCheckoutState> {
    if (!project.repoUrl) return 'valid';
    const checkout = this.checkoutPath(project, owner);
    try {
      const stat = await fsp.stat(path.join(checkout, '.git'));
      return stat.isDirectory() || stat.isFile() ? 'valid' : 'unsafe';
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') return 'unsafe';
      try {
        const checkoutStat = await fsp.stat(checkout);
        if (!checkoutStat.isDirectory()) return 'unsafe';
        return (await fsp.readdir(checkout)).length ? 'unsafe' : 'empty_or_absent';
      } catch (checkoutError) {
        return (checkoutError as NodeJS.ErrnoException).code === 'ENOENT' ? 'empty_or_absent' : 'unsafe';
      }
    }
  }

  async clearCheckout(
    project: Project,
    owner: EnvironmentOwner,
    requireSessionStorage = false,
    expected?: WorkspaceSessionStorageIdentity,
  ): Promise<void> {
    if (!project.repoUrl) return;
    const checkout = this.checkoutPath(project, owner);
    const root = this.worktreePath(project, owner);
    const relativeCheckout = path.relative(path.resolve(root), path.resolve(checkout));
    if (
      !relativeCheckout
      || path.isAbsolute(relativeCheckout)
      || relativeCheckout === '..'
      || relativeCheckout.startsWith(`..${path.sep}`)
    ) {
      throw new Error('refusing unsafe partial checkout removal');
    }
    await this.withStagedWorkspaceSessionStorage(
      project,
      owner,
      requireSessionStorage,
      'checkout replacement',
      async () => {
        const pinned = await this.pinDirectory(root, 'project workspace');
        if (!pinned) return;
        try {
          const target = await this.pinnedChildPath(pinned, relativeCheckout, 'project workspace');
          await fsp.rm(target, { recursive: true, force: true });
          await this.assertPinnedNamespace(pinned, 'project workspace');
        } finally {
          await pinned.handle?.close();
        }
      },
      expected,
    );
  }

  async ensure(project: Project, owner: EnvironmentOwner): Promise<ProjectEnvironmentResult> {
    if (project.executionKind === 'host') throw new Error('host projects do not have a container runtime');
    // A saved target is authoritative.  projectTarget intentionally refuses a
    // missing target instead of quietly selecting today's active machine.
    const target = this.environments.projectTarget(project.targetId);
    const ownerHome = this.environments.ownerHomeOnTarget(owner, project.targetId);
    const root = this.worktreePath(project, owner);
    const overlay = this.overlayPath(project);
    await fsp.mkdir(ownerHome.hostPath, { recursive: true, mode: 0o700 });
    await fsp.chmod(ownerHome.hostPath, 0o700);
    await fsp.mkdir(root, { recursive: true, mode: 0o700 });
    await fsp.chmod(root, 0o700);
    await fsp.mkdir(overlay, { recursive: true, mode: 0o700 });
    await fsp.chmod(overlay, 0o700);

    const name = project.container?.name || projectContainerName(target.config.namePrefix, project);
    const tier = project.tierId
      ? target.config.tiers.find((candidate) => candidate.id === project.tierId) || null
      : this.environments.intendedTierOnTarget(owner.id, project.targetId);
    const mounts: Mount[] = [
      { hostPath: ownerHome.hostPath, containerPath: ownerHome.containerPath },
      { hostPath: root, containerPath: PROJECT_WORKSPACE },
      { hostPath: overlay, containerPath: PROJECT_OVERLAY },
      ...target.config.extraMounts,
    ];
    // A fresh project's deterministic name can still be occupied by a
    // foreign container. Never let `ensure` silently adopt it.
    const described = await this.inspect(target.engine, name);
    const expectedTarget = targetLabelValue(target.key);
    const ownsContainer = (labels: Record<string, string>) => (
      labels[MANAGED_LABEL] === 'true'
      && labels[PROJECT_LABEL] === project.id
      && labels[USER_ID_LABEL] === String(owner.id)
      && labels[TARGET_LABEL] === expectedTarget
    );
    if (described && !ownsContainer(described.labels)) {
      throw new ProjectContainerOwnershipError(`project container '${name}' has mismatched ownership labels`);
    }
    let result: { created: boolean; identity: string };
    try {
      result = await target.engine.ensureIdentity({
        name,
        image: project.container?.image || target.config.image,
        mounts,
        memoryMounts: [{ containerPath: FORGE_SCRATCH, mode: 0o700 }],
        containerHome: ownerHome.containerPath,
        cpus: tier ? tier.cpus : target.config.cpus,
        memory: tier ? tier.memory : target.config.memory,
        labels: {
          [MANAGED_LABEL]: 'true',
          [PROJECT_LABEL]: project.id,
          [USER_ID_LABEL]: String(owner.id),
          [LOGIN_LABEL]: owner.githubLogin,
          [TARGET_LABEL]: targetLabelValue(target.key),
          ...(tier ? { [TIER_LABEL]: tier.id } : {}),
        },
        env: projectContainerEnvironment(ownerHome.containerPath, owner.githubLogin),
      }, described);
    } catch (error) {
      let after = null;
      try { after = await this.inspect(target.engine, name); } catch { /* Unknown is handled below. */ }
      if (after && !ownsContainer(after.labels)) {
        throw new ProjectContainerOwnershipError(`project container '${name}' changed ownership during ensure`);
      }
      if (after) {
        if (!described || after.identity !== described.identity) {
          throw new ProjectContainerStateUnknownError(
            `${(error as Error).message}; a same-name project container appeared during ensure and was not touched`,
            name,
          );
        }
        try {
          await target.engine.stopIdentity(after);
        } catch (stopError) {
          throw new ProjectContainerStateUnknownError(
            `${(error as Error).message}; owned project container could not be stopped: ${(stopError as Error).message}`,
            name,
          );
        }
        throw error;
      }
      throw new ProjectContainerStateUnknownError(
        `${(error as Error).message}; project container state could not be verified after ensure failure`,
        name,
      );
    }
    // `describe` and `ensure` are separate engine operations. Verify again so
    // a foreign same-name container appearing in between is never adopted and
    // never receives a project command.
    const verified = await this.inspect(target.engine, name);
    if (!verified) {
      throw new ProjectContainerStateUnknownError(
        `project container '${name}' could not be verified after ensure`,
        name,
      );
    }
    if (!verified.identity) {
      throw new ProjectContainerStateUnknownError(`project container '${name}' has no verifiable immutable identity`, name);
    }
    if (!ownsContainer(verified.labels)) {
      throw new ProjectContainerOwnershipError(`project container '${name}' changed ownership during ensure`);
    }
    if (verified.identity !== result.identity) {
      throw new ProjectContainerOwnershipError(`project container '${name}' changed identity after ensure`);
    }
    const environment = new ContainerEnvironment({
      name,
      identity: verified.identity,
      homeDir: ownerHome.hostPath,
      containerHome: ownerHome.containerPath,
      engine: target.engine,
      shells: ['bash'],
      // Keep the workspace translation first so an explicitly configured
      // overlapping mount cannot shadow the isolated /workspace mapping.
      mounts: [mounts[1], mounts[2], mounts[0], ...mounts.slice(3)],
    });
    return {
      environment,
      engine: target.engine,
      workingDir: this.checkoutPath(project, owner),
      allowedWorkingDirs: [root, ownerHome.hostPath],
      containerAccess: {
        projectId: project.id,
        ownerUserId: project.ownerUserId,
        containerName: name,
        containerIdentity: verified.identity,
        root: '/',
        workspaceRoot: PROJECT_WORKSPACE,
        ownerHomeRoot: ownerHome.containerPath,
      },
      containerName: name,
      created: result.created,
    };
  }

  /** Prepare a host-local workspace without creating or contacting an engine. */
  async ensureLocal(project: Project, owner: EnvironmentOwner): Promise<{
    environment: UserEnvironment;
    workingDir: string;
    allowedWorkingDirs: string[];
  }> {
    if (project.executionKind !== 'host') throw new Error('project is not host-local');
    const root = this.worktreePath(project, owner);
    await fsp.mkdir(root, { recursive: true, mode: 0o700 });
    await fsp.chmod(root, 0o700).catch(() => undefined);
    return {
      environment: new HostEnvironment(os.homedir()),
      workingDir: this.checkoutPath(project, owner),
      allowedWorkingDirs: [root],
    };
  }

  async stop(project: Project): Promise<'absent' | 'stopped'> {
    if (!project.container) return 'absent';
    const owned = await this.ownedDescription(project);
    if (!owned) return 'absent';
    await owned.engine.stopIdentity(owned.description);
    return 'stopped';
  }

  /** Stop only the immutable container that issued a still-live session lease. */
  async stopAccess(
    project: Project,
    access: ProjectContainerAccess,
    exactEngine?: EnvironmentEngine,
  ): Promise<'absent' | 'stopped'> {
    this.assertAccess(project, access);
    const owned = await this.ownedDescription(project, exactEngine);
    if (!owned) return 'absent';
    if (owned.description.identity !== access.containerIdentity) {
      throw new ProjectContainerOwnershipError(
        `project container '${access.containerName}' was replaced before recovery`,
      );
    }
    await owned.engine.stopIdentity(owned.description);
    return 'stopped';
  }

  async remove(project: Project): Promise<void> {
    if (!project.container) return;
    const owned = await this.ownedDescription(project);
    if (!owned) return;
    await owned.engine.removeIdentity(owned.description);
  }

  async status(project: Project): Promise<string | null> {
    if (!project.container) return null;
    const owned = await this.ownedDescription(project);
    return owned?.description.status || null;
  }

  /**
   * Execute an engine-backed file-browser/terminal operation in exactly the
   * container named by a live project lease. Callers only get this through the
   * manager, which binds access to owner/project/lease first.
   */
  async exec(
    project: Project,
    access: ProjectContainerAccess,
    cwd: string,
    command: string,
    commandArgs: string[],
    signal?: AbortSignal,
  ): Promise<RunResult> {
    const owned = await this.ownedAccess(project, access);
    return owned.engine.exec(
      { name: access.containerName, identity: access.containerIdentity, cwd: validateProjectContainerPath(access, cwd), signal },
      command,
      commandArgs,
    );
  }

  /**
   * Validate first, then start one tracked helper through that same engine.
   * A rejection from this method means launch was never attempted; once it
   * resolves, `result` may fail for either a command or transport reason and
   * its process control must always be settled before admission is released.
   */
  async startTrackedExec(
    project: Project,
    access: ProjectContainerAccess,
    cwd: string,
    command: string,
    commandArgs: string[],
    signal?: AbortSignal,
    exactEngine?: EnvironmentEngine,
  ): Promise<ProjectTrackedExecution> {
    const owned = await this.ownedAccess(project, access, exactEngine);
    signal?.throwIfAborted();
    const tracked = trackContainerProcess(
      owned.engine,
      access.containerName,
      access.containerIdentity,
      command,
      commandArgs,
      false,
    );
    return {
      result: owned.engine.exec(
        {
          name: access.containerName,
          identity: access.containerIdentity,
          cwd: validateProjectContainerPath(access, cwd),
          signal,
        },
        tracked.command,
        tracked.args,
      ),
      processControl: tracked.processControl,
    };
  }

  /** Validate ownership then describe a direct engine-client spawn safely. */
  async execDescriptor(
    project: Project,
    access: ProjectContainerAccess,
    cwd: string | undefined,
    command: string,
    commandArgs: string[],
  ): Promise<{ file: string; args: string[] }> {
    const owned = await this.ownedAccess(project, access);
    return {
      file: owned.engine.binary,
      args: owned.engine.execArgs(
        { name: access.containerName, identity: access.containerIdentity, ...(cwd ? { cwd: validateProjectContainerPath(access, cwd) } : {}) },
        command,
        commandArgs,
      ),
    };
  }

  /** Build a tracked pipe descriptor and post-spawn verifier on one engine. */
  async trackedExecDescriptor(
    project: Project,
    access: ProjectContainerAccess,
    cwd: string | undefined,
    command: string,
    commandArgs: string[],
    exactEngine?: EnvironmentEngine,
  ): Promise<ProjectTrackedSpawnDescriptor> {
    const owned = await this.ownedAccess(project, access, exactEngine);
    const tracked = trackContainerProcess(
      owned.engine,
      access.containerName,
      access.containerIdentity,
      command,
      commandArgs,
      false,
    );
    return {
      file: owned.engine.binary,
      args: owned.engine.execArgs(
        {
          name: access.containerName,
          identity: access.containerIdentity,
          ...(cwd ? { cwd: validateProjectContainerPath(access, cwd) } : {}),
        },
        tracked.command,
        tracked.args,
      ),
      processControl: tracked.processControl,
      verifyIdentity: async () => {
        await this.ownedAccess(project, access, owned.engine);
      },
    };
  }

  private async ownedAccess(
    project: Project,
    access: ProjectContainerAccess,
    exactEngine?: EnvironmentEngine,
  ): Promise<{ engine: EnvironmentEngine; description: NonNullable<Awaited<ReturnType<EnvironmentEngine['describe']>>> }> {
    this.assertAccess(project, access);
    const owned = await this.ownedDescription(project, exactEngine);
    if (!owned) throw new ProjectContainerStateUnknownError(
      `project container '${access.containerName}' is missing`, access.containerName,
    );
    if (owned.description.identity !== access.containerIdentity) {
      throw new ProjectContainerOwnershipError(`project container '${access.containerName}' was replaced`);
    }
    return owned;
  }

  private async ownedDescription(
    project: Project,
    exactEngine?: EnvironmentEngine,
  ): Promise<{ engine: EnvironmentEngine; description: NonNullable<Awaited<ReturnType<EnvironmentEngine['describe']>>> } | null> {
    if (!project.container) return null;
    const engine = exactEngine || this.environments.projectTarget(project.targetId).engine;
    const described = await this.inspect(engine, project.container.name);
    if (!described) return null;
    if (!described.identity) throw new ProjectContainerStateUnknownError(
      `project container '${project.container.name}' has no verifiable immutable identity`,
      project.container.name,
    );
    const expectedTarget = targetLabelValue(project.targetId || 'legacy');
    if (described.labels[MANAGED_LABEL] !== 'true'
      || described.labels[PROJECT_LABEL] !== project.id
      || described.labels[USER_ID_LABEL] !== String(project.ownerUserId)
      || described.labels[TARGET_LABEL] !== expectedTarget) {
      throw new ProjectContainerOwnershipError(`project container '${project.container.name}' has mismatched ownership labels`);
    }
    return { engine, description: described };
  }

  private assertAccess(project: Project, access: ProjectContainerAccess): void {
    if (access.projectId !== project.id || access.ownerUserId !== project.ownerUserId
      || !project.container || access.containerName !== project.container.name) {
      throw new ProjectContainerOwnershipError(
        'project container access does not match the recorded project',
      );
    }
  }

  private async inspect(engine: EnvironmentEngine, name: string) {
    try {
      return await engine.describeStrict(name);
    } catch (error) {
      throw new ProjectContainerStateUnknownError(
        `project container '${name}' could not be inspected: ${(error as Error).message}`,
        name,
      );
    }
  }
}
