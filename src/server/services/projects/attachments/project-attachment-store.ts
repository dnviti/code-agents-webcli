import { Readable } from 'node:stream';
import path from 'node:path';
import type { ChatAttachment } from '../../../../shared/chat-events.js';
import {
  DEFAULT_MAX_ATTACHMENT_BYTES,
  type AttachmentDeleteOptions,
  type AttachmentInput,
  type AttachmentSessionRef,
  type AttachmentStoreLike,
  type ServeKind,
  type StoredAttachment,
} from '../../workspace/artifacts/attachment-store.js';
import {
  canonicalProjectWorkingDir,
  projectHostWorkingDirToContainer,
  registerUnverifiedProjectProcess,
  releaseProjectSessionLease,
  restoreProjectWorkingDir,
  type ProjectSessionLease,
  type ProjectsSessionApi,
} from '../working-dir.js';

function errno(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/**
 * Route chat attachments through the namespace that owns the session.
 *
 * Ordinary sessions keep the inode-bound host store. Project sessions first
 * acquire the same manager lease as the workspace routes; host checkouts use
 * that store only after admission, while container-only paths use fixed,
 * binary-safe project file helpers. No container path is ever interpreted as a
 * path on the web server.
 */
export class ProjectAwareAttachmentStore implements AttachmentStoreLike {
  private readonly inFlightMutations = new Map<string, Set<Promise<unknown>>>();

  constructor(
    private readonly host: AttachmentStoreLike,
    private readonly projects: ProjectsSessionApi,
    private readonly saveSessionsToDisk: () => Promise<boolean | void>,
  ) {}

  async save(session: AttachmentSessionRef, input: AttachmentInput): Promise<StoredAttachment> {
    this.assertPersistenceAvailable(session);
    if (!session.projectId) return this.host.save(session, input);
    return this.withProjectStore(session, (store, admitted) => {
      // `ensureForSession` is serialised by the project lifecycle lock. A save
      // waiting for that lock has not been admitted to the old workspace and
      // must not be part of the old workspace's flush barrier: otherwise the
      // lifecycle callback waits for a save which is itself waiting for the
      // callback's lock. Recheck the synchronous gate after admission, then
      // track exactly the mutation performed under the issued project lease.
      this.assertPersistenceAvailable(session);
      return this.trackMutation(session, () => store.save(admitted, input));
    }, { requirePersistenceAvailable: true });
  }

  async flush(session: AttachmentSessionRef): Promise<void> {
    const key = this.mutationKey(session);
    for (;;) {
      const pending = [...(this.inFlightMutations.get(key) || [])];
      if (pending.length === 0) break;
      await Promise.allSettled(pending);
    }
    if (!this.host.flush) return;
    await this.host.flush({
      ...session,
      workingDir: session.storageScope?.workspaceRoot || session.workingDir,
      projectId: undefined,
      projectWorkingDirKind: undefined,
    });
  }

  async cloneForBranch(
    source: AttachmentSessionRef,
    target: AttachmentSessionRef,
    attachment: ChatAttachment,
  ): Promise<ChatAttachment> {
    if (
      source.ownerUserId !== target.ownerUserId
      || source.storageScope?.ownerKey !== target.storageScope?.ownerKey
    ) {
      throw errno('OWNER_MISMATCH', 'branch attachments cannot cross owners');
    }
    if (source.id === target.id) {
      throw errno('INVALID_TARGET', 'branch attachment target must be a new session');
    }
    if (!source.projectId && !target.projectId) {
      return this.host.cloneForBranch(source, target, attachment);
    }
    if (!source.projectId || source.projectId !== target.projectId) {
      throw errno('PROJECT_MISMATCH', 'branch attachments must remain in one project');
    }
    if (!this.projects.withProjectWorkspace) {
      throw errno('UNSUPPORTED_ATTACHMENT_NAMESPACE', 'project lifecycle storage is unavailable');
    }

    // Branching is host-side durable storage work. It must not start a stopped
    // runtime merely to copy bytes, and the returned path deliberately remains
    // a host path. `resolveForTurn` maps that immutable URL into the live
    // container namespace later, when the branch is actually launched.
    return this.projects.withProjectWorkspace(
      source.ownerUserId,
      source.projectId,
      (workspaceRoot) => this.cloneForBranchInProjectWorkspace(
        source,
        target,
        attachment,
        workspaceRoot,
      ),
    );
  }

  /**
   * Clone while the caller already owns `withProjectWorkspace` for this exact
   * project. This avoids re-entering the lifecycle gate from the branch route.
   */
  async cloneForBranchInProjectWorkspace(
    source: AttachmentSessionRef,
    target: AttachmentSessionRef,
    attachment: ChatAttachment,
    workspaceRoot: string,
  ): Promise<ChatAttachment> {
    if (source.ownerUserId !== target.ownerUserId) {
      throw errno('OWNER_MISMATCH', 'branch attachments cannot cross owners');
    }
    if (source.id === target.id) {
      throw errno('INVALID_TARGET', 'branch attachment target must be a new session');
    }
    const projectId = source.projectId;
    if (!projectId || projectId !== target.projectId) {
      throw errno('PROJECT_MISMATCH', 'branch attachments must remain in one project');
    }
    if (!this.projects.getForUser(source.ownerUserId, projectId)) {
      throw errno('UNSUPPORTED_ATTACHMENT_NAMESPACE', 'project is unavailable');
    }
    if (!source.storageScope || !target.storageScope) {
      throw errno('UNSAFE_ATTACHMENT_DIR', 'project attachment storage scope is unavailable');
    }
    if (source.storageScope.ownerKey !== target.storageScope.ownerKey) {
      throw errno('OWNER_MISMATCH', 'branch attachment owner scope changed');
    }

    const canonicalRoot = await canonicalProjectWorkingDir([workspaceRoot], workspaceRoot);
    const canonicalSourceRoot = canonicalRoot
      ? await canonicalProjectWorkingDir([canonicalRoot], source.storageScope.workspaceRoot)
      : null;
    const canonicalTargetRoot = canonicalRoot
      ? await canonicalProjectWorkingDir([canonicalRoot], target.storageScope.workspaceRoot)
      : null;
    const catalogRoot = this.projects.projectWorkspaceRoot?.(source.ownerUserId, projectId);
    const canonicalCatalogRoot = this.projects.projectWorkspaceRoot
      ? canonicalRoot && catalogRoot
        ? await canonicalProjectWorkingDir([canonicalRoot], catalogRoot)
        : null
      : canonicalRoot;
    if (
      !canonicalRoot
      || canonicalCatalogRoot !== canonicalRoot
      || canonicalSourceRoot !== canonicalRoot
      || canonicalTargetRoot !== canonicalRoot
    ) {
      throw errno('UNSAFE_ATTACHMENT_DIR', 'attachment storage does not match the project workspace');
    }

    const hostRef = (session: AttachmentSessionRef): AttachmentSessionRef => ({
      id: session.id,
      ownerUserId: session.ownerUserId,
      workingDir: canonicalRoot,
      projectId: undefined,
      projectWorkingDirKind: undefined,
      storageScope: {
        ...session.storageScope!,
        workspaceRoot: canonicalRoot,
      },
    });
    return this.host.cloneForBranch(
      hostRef(source),
      hostRef(target),
      attachment,
    );
  }

  async deleteSessionAttachments(
    session: AttachmentSessionRef,
    options: AttachmentDeleteOptions = {},
  ): Promise<void> {
    if (!session.projectId) return this.host.deleteSessionAttachments(session, options);
    const projectId = session.projectId;
    if (!session.storageScope) {
      throw errno('UNSAFE_ATTACHMENT_DIR', 'project attachment storage scope is unavailable');
    }

    const removeFrom = async (managerRoot: string): Promise<void> => {
      // `storageScope` is persisted input, not path authority. Resolve both it
      // and the manager-owned durable root through the same confinement helper,
      // then require exact identity before any descriptor is opened for delete.
      const canonicalManagerRoot = await canonicalProjectWorkingDir([managerRoot], managerRoot);
      const canonicalSessionRoot = await canonicalProjectWorkingDir(
        [managerRoot],
        session.storageScope!.workspaceRoot,
      );
      if (!canonicalManagerRoot || canonicalSessionRoot !== canonicalManagerRoot) {
        throw errno('UNSAFE_ATTACHMENT_DIR', 'attachment storage does not match the project workspace');
      }
      return this.host.deleteSessionAttachments({
        ...session,
        workingDir: canonicalManagerRoot,
        projectId: undefined,
        projectWorkingDirKind: undefined,
        storageScope: {
          ...session.storageScope!,
          workspaceRoot: canonicalManagerRoot,
        },
      });
    };

    if (options.projectLifecycleExclusive) {
      // Project removal already owns the lifecycle gate. Re-entering it would
      // deadlock, so use only the pure manager-derived root in this path.
      const managerRoot = this.projects.projectWorkspaceRoot?.(session.ownerUserId, projectId);
      if (!managerRoot) throw errno('UNSUPPORTED_ATTACHMENT_NAMESPACE', 'project is unavailable');
      return removeFrom(managerRoot);
    }

    // Ordinary session delete and branch rollback must not race a rebuild or
    // reclaim, but must also never start a stopped project merely to clean data.
    if (!this.projects.withProjectWorkspace) {
      throw errno('UNSUPPORTED_ATTACHMENT_NAMESPACE', 'project lifecycle cleanup is unavailable');
    }
    return this.projects.withProjectWorkspace(
      session.ownerUserId,
      projectId,
      removeFrom,
    );
  }

  async resolve(
    session: AttachmentSessionRef,
    storedName: string,
  ): Promise<{ absolutePath: string; serve: ServeKind; bytes: number }> {
    if (!session.projectId) return this.host.resolve(session, storedName);
    return this.withProjectStore(session, (store, admitted) => store.resolve(admitted, storedName));
  }

  async resolveForTurn(
    session: AttachmentSessionRef,
    attachment: ChatAttachment,
  ): Promise<ChatAttachment> {
    if (!session.projectId) return this.host.resolveForTurn(session, attachment);
    return this.withProjectStore(
      session,
      (store, admitted) => store.resolveForTurn(admitted, attachment),
    );
  }

  async openForDownload(
    session: AttachmentSessionRef,
    storedName: string,
  ): Promise<{ stream: Readable; serve: ServeKind; bytes: number }> {
    if (!session.projectId) return this.host.openForDownload(session, storedName);

    // A returned host stream would outlive the project lease. Materialise the
    // bounded attachment while admitted, then serve the owned bytes after the
    // lease has been released. The upload route caps every file at 20 MiB.
    return this.withProjectStore(session, async (store, admitted) => {
      const opened = await store.openForDownload(admitted, storedName);
      const expectedBytes = opened.bytes;
      if (expectedBytes <= 0 || expectedBytes > DEFAULT_MAX_ATTACHMENT_BYTES) {
        opened.stream.destroy();
        throw errno('NOT_FOUND', 'attachment exceeded its stored limit');
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of opened.stream) {
        const value = Buffer.from(chunk);
        bytes += value.length;
        if (bytes > DEFAULT_MAX_ATTACHMENT_BYTES) {
          opened.stream.destroy();
          throw errno('NOT_FOUND', 'attachment exceeded its stored limit');
        }
        chunks.push(value);
      }
      if (bytes !== expectedBytes) {
        throw errno('SOURCE_ATTACHMENT_CHANGED', 'source attachment changed while it was read');
      }
      return {
        stream: Readable.from(Buffer.concat(chunks, bytes)),
        serve: opened.serve,
        bytes: expectedBytes,
      };
    });
  }

  private async withProjectStore<T>(
    session: AttachmentSessionRef,
    operation: (store: AttachmentStoreLike, admitted: AttachmentSessionRef) => Promise<T>,
    options: { requirePersistenceAvailable?: boolean } = {},
  ): Promise<T> {
    const projectId = session.projectId;
    if (!projectId || !this.projects.getForUser(session.ownerUserId, projectId)) {
      throw errno('UNSUPPORTED_ATTACHMENT_NAMESPACE', 'project is unavailable');
    }

    let lease: ProjectSessionLease | undefined;
    let retainLease = false;
    try {
      const prepared = await this.projects.ensureForSession(session.ownerUserId, projectId);
      if (!prepared.ok) {
        throw errno('UNSUPPORTED_ATTACHMENT_NAMESPACE', `project is ${prepared.reason}`);
      }
      lease = { ownerUserId: session.ownerUserId, projectId, leaseId: prepared.leaseId };
      // A lifecycle gate may have been installed while this request waited in
      // `ensureForSession`'s exclusive queue. Reject before cwd repair or its
      // write-through save can touch state belonging to the restored scope.
      if (options.requirePersistenceAvailable) this.assertPersistenceAvailable(session);
      const cwd = await restoreProjectWorkingDir(
        this.projects,
        prepared,
        session.workingDir,
        session.projectWorkingDirKind,
      );
      const changed = session.workingDir !== cwd.workingDir
        || session.projectWorkingDirKind !== cwd.kind;
      session.workingDir = cwd.workingDir;
      session.projectWorkingDirKind = cwd.kind;
      if (changed) await this.saveSessionsToDisk();

      const requestedStorageRoot = session.storageScope
        ? session.storageScope.workspaceRoot
        : prepared.allowedWorkingDirs[0];
      const durableProjectRoot = prepared.allowedWorkingDirs[0];
      const canonicalStorageRoot = await canonicalProjectWorkingDir(
        [durableProjectRoot],
        requestedStorageRoot,
      );
      const canonicalPreparedRoot = await canonicalProjectWorkingDir(
        [durableProjectRoot],
        durableProjectRoot,
      );
      if (!canonicalStorageRoot || canonicalStorageRoot !== canonicalPreparedRoot) {
        throw errno('UNSAFE_ATTACHMENT_DIR', 'attachment storage does not match the project workspace');
      }

      const admitted: AttachmentSessionRef = {
        id: session.id,
        ownerUserId: session.ownerUserId,
        workingDir: canonicalStorageRoot,
        projectId: undefined,
        projectWorkingDirKind: undefined,
        storageScope: session.storageScope,
      };

      if (prepared.containerAccess) {
        const containerStorageRoot = await projectHostWorkingDirToContainer(
          prepared,
          canonicalStorageRoot,
        );
        if (!containerStorageRoot) {
          throw errno('UNSAFE_ATTACHMENT_DIR', 'project workspace is not mounted into its container');
        }
        return operation(
          new MappedProjectAttachmentStore(this.host, canonicalStorageRoot, containerStorageRoot),
          admitted,
        );
      }

      // The host store intentionally rejects project-shaped references. The
      // manager admission above is the authority that permits this exact host
      // checkout, so erase only the namespace flags for the delegated call.
      return operation(this.host, admitted);
    } catch (error) {
      retainLease = registerUnverifiedProjectProcess(this.projects, lease, error);
      throw error;
    } finally {
      if (!retainLease) releaseProjectSessionLease(this.projects, lease);
    }
  }

  private mutationKey(session: AttachmentSessionRef): string {
    return `${session.storageScope?.workspaceRoot || session.workingDir}\0${session.storageScope?.ownerKey || session.ownerUserId}\0${session.id}`;
  }

  private assertPersistenceAvailable(session: AttachmentSessionRef): void {
    if (session.persistenceUnavailable) {
      throw errno('SESSION_PERSISTENCE_UNAVAILABLE', session.persistenceUnavailable);
    }
  }

  private async trackMutation<T>(
    session: AttachmentSessionRef,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = this.mutationKey(session);
    const promise = operation();
    let pending = this.inFlightMutations.get(key);
    if (!pending) {
      pending = new Set();
      this.inFlightMutations.set(key, pending);
    }
    pending.add(promise);
    try {
      return await promise;
    } finally {
      pending.delete(promise);
      if (pending.size === 0 && this.inFlightMutations.get(key) === pending) {
        this.inFlightMutations.delete(key);
      }
    }
  }
}

/** Store bytes on the durable host mount while returning paths valid in the container. */
class MappedProjectAttachmentStore implements AttachmentStoreLike {
  constructor(
    private readonly host: AttachmentStoreLike,
    private readonly hostRoot: string,
    private readonly containerRoot: string,
  ) {}

  async save(session: AttachmentSessionRef, input: AttachmentInput): Promise<StoredAttachment> {
    const stored = await this.host.save(session, input);
    return { ...stored, absolutePath: this.toContainerPath(stored.absolutePath) };
  }

  cloneForBranch(
    source: AttachmentSessionRef,
    target: AttachmentSessionRef,
    attachment: ChatAttachment,
  ): Promise<ChatAttachment> {
    return this.host.cloneForBranch(source, target, attachment).then((stored) => {
      if (!stored.path) return stored;
      return { ...stored, path: this.toContainerPath(stored.path) };
    });
  }

  deleteSessionAttachments(
    session: AttachmentSessionRef,
    options?: AttachmentDeleteOptions,
  ): Promise<void> {
    return this.host.deleteSessionAttachments(session, options);
  }

  async resolve(
    session: AttachmentSessionRef,
    storedName: string,
  ): Promise<{ absolutePath: string; serve: ServeKind; bytes: number }> {
    const resolved = await this.host.resolve(session, storedName);
    return { ...resolved, absolutePath: this.toContainerPath(resolved.absolutePath) };
  }

  async resolveForTurn(
    session: AttachmentSessionRef,
    attachment: ChatAttachment,
  ): Promise<ChatAttachment> {
    const resolved = await this.host.resolveForTurn(session, attachment);
    if (!resolved.path) throw errno('NOT_FOUND', 'attachment path is unavailable');
    return { ...resolved, path: this.toContainerPath(resolved.path) };
  }

  openForDownload(
    session: AttachmentSessionRef,
    storedName: string,
  ): Promise<{ stream: Readable; serve: ServeKind; bytes: number }> {
    return this.host.openForDownload(session, storedName);
  }

  private toContainerPath(hostPath: string): string {
    const relative = path.relative(this.hostRoot, hostPath);
    if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
      throw errno('UNSAFE_ATTACHMENT_DIR', 'attachment escaped the project workspace');
    }
    return path.posix.join(this.containerRoot, ...relative.split(path.sep));
  }
}
