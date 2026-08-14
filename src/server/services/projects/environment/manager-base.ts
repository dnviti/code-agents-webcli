import { constants as fsConstants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import fsp from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { EnvironmentManager } from '../../environments/manager.js';
import { EnvironmentOwner } from '../../environments/types.js';
import { Project } from '../store.js';
import { WORKSPACE_SESSION_STORAGE, PinnedWorkspaceDirectory, StagedWorkspaceSessionStorage } from './shared.js';
import { ProjectWorkspaceSessionStorageError } from './errors.js';
import { WorkspaceSessionStorageIdentity } from './types.js';
import { localProjectWorkspaceRoot } from './constants.js';

/**
 * Low-level lifecycle primitives shared by every project environment partial.
 * Descendant partials implement the path and intent hooks this layer needs:
 * see {@link ProjectEnvironmentManagerSession} for their definitions.
 */
export abstract class ProjectEnvironmentManagerBase {
  constructor(
    protected readonly environments: EnvironmentManager,
    protected readonly localWorkspaceRoot = localProjectWorkspaceRoot(),
    /** Linux can address an opened directory without resolving its mutable name again. */
    protected readonly descriptorDirectory: string | null = process.platform === 'linux' ? '/proc/self/fd' : null,
    /** Test seam for the path-only fallback used where directory handles are unavailable. */
    protected readonly allowDirectoryHandles = process.platform !== 'win32',
  ) {}

  /** Project worktree root; implemented by the path partial. */
  public abstract worktreePath(project: Project, _owner: EnvironmentOwner): string;

  /** Crash-recovery staging slot; implemented by the session storage partial. */
  protected abstract workspaceSessionStorageStagingPath(project: Project, owner: EnvironmentOwner): string;

  /** Durable session-storage authority; implemented by the session storage partial. */
  protected abstract readWorkspaceSessionStorageIntent(
    project: Project,
    owner: EnvironmentOwner,
  ): Promise<WorkspaceSessionStorageIdentity | null>;

  protected async removePinnedOwnedDirectory(
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

  protected async assertSafeTree(root: string, label: string): Promise<void> {
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
  protected async pinDirectory(directory: string, label: string): Promise<PinnedWorkspaceDirectory | null> {
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

  protected async assertPinnedHandle(pinned: PinnedWorkspaceDirectory, label: string): Promise<void> {
    if (!pinned.handle) return;
    const opened = await pinned.handle.stat({ bigint: true });
    if (!opened.isDirectory() || opened.dev !== pinned.dev || opened.ino !== pinned.ino) {
      throw new ProjectWorkspaceSessionStorageError(`${label} changed after it was pinned`);
    }
  }

  protected async assertPinnedNamespace(pinned: PinnedWorkspaceDirectory, label: string): Promise<void> {
    await this.assertPinnedHandle(pinned, label);
    await this.assertPathMatchesPinned(pinned.directory, pinned, label);
  }

  protected pinnedIdentityMatches(
    pinned: { dev: bigint; ino: bigint },
    candidate: { dev: bigint; ino: bigint; isDirectory(): boolean },
  ): boolean {
    return candidate.isDirectory()
      && candidate.dev === pinned.dev
      && candidate.ino === pinned.ino;
  }

  protected storageIdentityMatches(
    expected: WorkspaceSessionStorageIdentity,
    candidate: { dev: bigint; ino: bigint },
  ): boolean {
    return candidate.dev === expected.dev && candidate.ino === expected.ino;
  }

  protected async lstatOrNull(target: string): Promise<Awaited<ReturnType<typeof fsp.lstat>> | null> {
    try {
      return await fsp.lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  protected async lstatIdentityOrNull(target: string): Promise<BigIntStats | null> {
    try {
      return await fsp.lstat(target, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  /** Make a directory-entry mutation durable while retaining its inode binding. */
  protected async syncPinnedDirectory(
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
  protected async restoreStagedWorkspaceSessionStorage(
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
  protected async stageWorkspaceSessionStorage(
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
  protected async withStagedWorkspaceSessionStorage(
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

  protected async assertPathMatchesPinned(
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

  protected async pinnedRootPath(pinned: PinnedWorkspaceDirectory, label: string): Promise<string> {
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

  protected async pinnedChildPath(
    pinned: PinnedWorkspaceDirectory,
    child: string,
    label: string,
  ): Promise<string> {
    if (!child || child === '.' || child === '..' || path.basename(child) !== child) {
      throw new ProjectWorkspaceSessionStorageError(`refusing unsafe child of ${label}`);
    }
    return path.join(await this.pinnedRootPath(pinned, label), child);
  }

  protected async readdirPinned(pinned: PinnedWorkspaceDirectory, label: string): Promise<string[]> {
    return fsp.readdir(await this.pinnedRootPath(pinned, label));
  }

  protected async removePinnedChild(
    pinned: PinnedWorkspaceDirectory,
    child: string,
    label: string,
  ): Promise<void> {
    const target = await this.pinnedChildPath(pinned, child, label);
    await fsp.rm(target, { recursive: true, force: true });
  }

  protected async pinWorkspaceSessionStorage(
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

  protected async chmodPinnedDirectory(
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
}
