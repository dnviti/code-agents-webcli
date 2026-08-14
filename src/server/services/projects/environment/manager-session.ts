import { constants as fsConstants } from 'node:fs';
import fsp from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EnvironmentOwner } from '../../environments/types.js';
import { Project } from '../store.js';
import { repoBaseName } from '../clone.js';
import { PROJECT_WORKSPACE } from './constants.js';
import { WORKSPACE_SESSION_STORAGE, PinnedWorkspaceDirectory } from './shared.js';
import { ProjectWorkspaceSessionStorageError } from './errors.js';
import { WorkspaceSessionStorageIdentity } from './types.js';
import { ProjectEnvironmentManagerBase } from './manager-base.js';

/** Durable paths, checkout layout, and workspace session-storage intent. */
export abstract class ProjectEnvironmentManagerSession extends ProjectEnvironmentManagerBase {
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
  protected workspaceSessionStorageStagingPath(project: Project, owner: EnvironmentOwner): string {
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

  protected async readWorkspaceSessionStorageIntent(
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
}
