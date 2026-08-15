import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { SessionRecord, SessionStorageScope } from './types.js';
import { canonicalExistingRoot } from './services/workspace/catalog/workspace-catalog.js';
import {
  closeWorkspaceSessionDirectoryLeasesForScope,
  openWorkspaceStorageDirectorySync,
} from './services/workspace/session/workspace-session-storage.js';
import { type Project } from './services/projects/store.js';
import { type ProjectWorkspaceReplacementAuthority } from './services/projects/manager.js';
import {
  ProjectWorkspaceSessionStorageError,
  type WorkspaceSessionStorageIdentity,
} from './services/projects/environment.js';
import { ServerEnvironment } from './server-environment.js';

export abstract class ServerWorkspace extends ServerEnvironment {
  /** Resolve once; later cwd changes cannot move a session to another archive. */
  protected sessionStorageScope(ownerUserId: number, root: string): SessionStorageScope {
    const ownerKey = this.sessionOwnerKey(ownerUserId);
    return {
      workspaceRoot: this.workspaceCatalog.register(
        ownerKey,
        this.authorizeWorkspaceRoot(ownerUserId, root),
      ),
      ownerKey,
    };
  }

  protected workspaceScopeKey(scope: SessionStorageScope): string {
    return `${scope.ownerKey}\u0000${scope.workspaceRoot}`;
  }

  protected sameWorkspaceScope(left: SessionStorageScope, right: SessionStorageScope): boolean {
    return left.ownerKey === right.ownerKey && left.workspaceRoot === right.workspaceRoot;
  }

  /** A staged/rejected project archive is a scope-level gate, not a row hint. */
  protected workspaceScopeGateReason(scope: SessionStorageScope): string | null {
    const key = this.workspaceScopeKey(scope);
    if (this.unrestoredProjectScopes.has(key)) {
      return this.workspacePersistenceErrors.get(key)
        || 'Project session artifacts are crash-staged and have not been restored';
    }
    for (const suspended of this.suspendedProjectScopes.values()) {
      if (this.sameWorkspaceScope(suspended, scope)) {
        return this.workspacePersistenceErrors.get(key)
          || 'Project session artifacts are temporarily unavailable';
      }
    }
    return null;
  }

  protected assertWorkspaceScopeWritable(scope: SessionStorageScope): void {
    const reason = this.workspaceScopeGateReason(scope);
    if (reason) throw new ProjectWorkspaceSessionStorageError(reason);
  }

  /** Admit one archive inode; never silently substitute a later same-name directory. */
  protected admitWorkspaceArtifactArchive(
    scope: SessionStorageScope,
    createIfMissing: boolean,
  ): WorkspaceSessionStorageIdentity {
    const key = this.workspaceScopeKey(scope);
    const expected = this.workspaceArtifactIdentities.get(key);
    const lease = openWorkspaceStorageDirectorySync(scope.workspaceRoot, {
      createIfMissing,
      ...(expected ? { expectedIdentity: expected } : {}),
    });
    try {
      lease.verify();
      const opened = fs.fstatSync(lease.fd, { bigint: true });
      if (!opened.isDirectory() || opened.ino === 0n) {
        throw new Error('Workspace artifact directory has no stable identity');
      }
      const identity = { dev: opened.dev, ino: opened.ino };
      if (expected && (identity.dev !== expected.dev || identity.ino !== expected.ino)) {
        throw new Error('Workspace artifact directory changed after admission');
      }
      this.workspaceArtifactIdentities.set(key, identity);
      return identity;
    } finally {
      lease.close();
    }
  }

  /** A catalog entry locates a candidate; current policy still authorises it. */
  protected authorizeWorkspaceRoot(ownerUserId: number, root: string): string {
    const canonical = canonicalExistingRoot(root);
    const owner = this.getEnvironmentOwner(ownerUserId);
    if (owner) {
      for (const project of this.projectStore.listProjectsForUser(ownerUserId)) {
        const projectRoot = path.resolve(this.projectPaths.worktreePath(project, owner));
        if (canonical === projectRoot) return canonical;
      }
    }
    const validation = this.validatePath(canonical, ownerUserId);
    if (validation.valid && validation.path && path.resolve(validation.path) === canonical) {
      return canonical;
    }
    throw new Error('Workspace root is no longer authorised for this account');
  }

  protected sessionOwnerKey(ownerUserId: number): string {
    const owner = this.database.getUserById(ownerUserId);
    if (!owner) throw new Error(`session owner ${ownerUserId} is unavailable`);
    return createHash('sha256')
      .update(`cc-web-session-owner:v1:${owner.githubId}`)
      .digest('hex');
  }

  /** Rebuild runtime/path authority from the global project catalogue, never from a checkout DB. */
  protected revalidateRestoredSession(
    session: SessionRecord,
    scope: SessionStorageScope,
    ownerUserId: number,
  ): void {
    if (session.projectId) {
      const project = this.projectStore.getProjectForUser(session.projectId, ownerUserId);
      const owner = this.getEnvironmentOwner(ownerUserId);
      if (!project || !owner) throw new Error(`Session ${session.id} names an unavailable project`);
      const projectRoot = path.resolve(this.projectPaths.worktreePath(project, owner));
      if (projectRoot !== scope.workspaceRoot) {
        throw new Error(`Session ${session.id} project does not own this workspace archive`);
      }
      if (project.executionKind === 'host') {
        session.projectWorkingDirKind = 'host';
        const candidate = path.resolve(session.workingDir || projectRoot);
        const relative = path.relative(projectRoot, candidate);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          session.workingDir = this.projectPaths.checkoutPath(project, owner);
        } else {
          session.workingDir = candidate;
        }
      } else {
        session.projectWorkingDirKind = 'container';
        if (
          typeof session.workingDir !== 'string'
          || !session.workingDir
          || session.workingDir.includes('\0')
          || !path.posix.isAbsolute(session.workingDir)
        ) {
          session.workingDir = this.projectPaths.checkoutContainerPath(project);
        } else {
          session.workingDir = path.posix.normalize(session.workingDir);
        }
      }
      return;
    }

    session.projectWorkingDirKind = undefined;
    const validation = typeof session.workingDir === 'string'
      ? this.validatePath(session.workingDir, ownerUserId)
      : { valid: false };
    if (!validation.valid || !validation.path) session.workingDir = scope.workspaceRoot;
    else session.workingDir = validation.path;
  }

  /** Retire one structured project gate only after its exact archive is back. */
  protected clearVerifiedProjectScopeGate(
    project: Project,
    scope: SessionStorageScope,
    identity: WorkspaceSessionStorageIdentity,
  ): void {
    const key = this.workspaceScopeKey(scope);
    this.workspaceArtifactIdentities.set(key, identity);
    this.suspendedProjectScopes.delete(project.id);
    this.unrestoredProjectScopes.delete(key);
    this.loadedWorkspaceScopes.add(key);
    this.workspacePersistenceErrors.delete(key);
    for (const session of this.claudeSessions.values()) {
      if (!session.storageScope || !this.sameWorkspaceScope(session.storageScope, scope)) continue;
      try {
        this.revalidateRestoredSession(session, scope, session.ownerUserId);
        session.persistenceUnavailable = undefined;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        session.persistenceUnavailable = reason;
        this.workspacePersistenceErrors.set(key, reason);
      }
    }
  }

  /** Open one authorised archive and merge it without last-wins collisions. */
  protected async loadWorkspaceSessions(
    ownerUserId: number,
    storageRoot: string,
  ): Promise<void> {
    try {
      const scope = this.sessionStorageScope(ownerUserId, storageRoot);
      const key = this.workspaceScopeKey(scope);
      this.assertWorkspaceScopeWritable(scope);
      this.admitWorkspaceArtifactArchive(scope, true);
      this.loadedWorkspaceScopes.add(key);
      const blocked = [...this.claudeSessions.values()].some((session) =>
        session.storageScope?.ownerKey === scope.ownerKey
        && session.storageScope.workspaceRoot === scope.workspaceRoot
        && Boolean(session.persistenceUnavailable));
      if (!blocked) this.workspacePersistenceErrors.delete(key);
    } catch (error) {
      const ownerKey = this.sessionOwnerKey(ownerUserId);
      this.workspacePersistenceErrors.set(
        `${ownerKey}\u0000${path.resolve(storageRoot)}`,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  protected async loadProjectWorkspaceSessions(ownerUserId: number, projectId: string): Promise<void> {
    const project = this.projectStore.getProjectForUser(projectId, ownerUserId);
    const owner = this.getEnvironmentOwner(ownerUserId);
    if (!project || !owner) throw new Error('Project workspace is unavailable');
    await this.loadWorkspaceSessions(
      ownerUserId,
      this.projectPaths.worktreePath(project, owner),
    );
  }

  protected projectSessionStorageScope(project: Project): SessionStorageScope {
    const owner = this.getEnvironmentOwner(project.ownerUserId);
    if (!owner) throw new Error('Project workspace owner is unavailable');
    return {
      workspaceRoot: path.resolve(this.projectPaths.worktreePath(project, owner)),
      ownerKey: this.sessionOwnerKey(project.ownerUserId),
    };
  }

  /**
   * Recover crash-staged archives only after boot reconciliation quiesces managed
   * runtimes; failures remain unavailable and never create replacement storage.
   */
  protected async restoreStagedProjectSessionArchives(): Promise<void> {
    for (const user of this.database.listUsers()) {
      const owner = this.getEnvironmentOwner(user.id);
      if (!owner) continue;
      for (const project of this.projectStore.listProjectsForUser(user.id)) {
        const scope = this.projectSessionStorageScope(project);
        const key = `${scope.ownerKey}\u0000${scope.workspaceRoot}`;
        // Without project environments, recover host archives only; staged container
        // archives remain unavailable until their runtimes can be quiesced.
        if (!this.containerizedEnvironmentsEnabled && project.executionKind !== 'host') {
          try {
            if (await this.projectPaths.hasStagedWorkspaceSessionStorage(project, owner)) {
              this.unrestoredProjectScopes.add(key);
              this.workspacePersistenceErrors.set(
                key,
                'Project session archive is crash-staged; enable project environments to quiesce its runtime and recover it safely',
              );
            }
          } catch (error) {
            this.unrestoredProjectScopes.add(key);
            this.workspacePersistenceErrors.set(
              key,
              `Project session archive staging state is unsafe: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          continue;
        }
        try {
          await this.projectPaths.restoreWorkspaceSessionStorage(project, owner);
          const recoveryIdentity = await this.projectPaths.workspaceSessionStorageRecoveryIdentity(
            project,
            owner,
          );
          if (recoveryIdentity) {
            const reopened = await this.projectPaths.workspaceSessionStorageIdentity(project, owner);
            if (!reopened || reopened.dev !== recoveryIdentity.dev || reopened.ino !== recoveryIdentity.ino) {
              throw new ProjectWorkspaceSessionStorageError(
                'Cold-restored project artifacts did not retain their archive inode',
              );
            }
            await this.projectPaths.completeWorkspaceSessionStorageRestore(project, owner, reopened);
            this.clearVerifiedProjectScopeGate(project, scope, reopened);
          } else {
            this.unrestoredProjectScopes.delete(key);
            const diagnostic = this.workspacePersistenceErrors.get(key);
            if (diagnostic?.startsWith('Project session archive crash recovery failed:')) {
              this.workspacePersistenceErrors.delete(key);
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.unrestoredProjectScopes.add(key);
          this.workspacePersistenceErrors.set(
            key,
            `Project session archive crash recovery failed: ${message}`,
          );
        }
      }
    }
  }

  protected async projectSessionStorageIsUnavailable(project: Project): Promise<boolean> {
    const scope = this.projectSessionStorageScope(project);
    const key = this.workspaceScopeKey(scope);
    const owner = this.getEnvironmentOwner(project.ownerUserId);
    if (!owner) throw new Error('Project workspace owner is unavailable');
    try {
      await this.projectPaths.restoreWorkspaceSessionStorage(project, owner);
      const recoveryIdentity = await this.projectPaths.workspaceSessionStorageRecoveryIdentity(
        project,
        owner,
      );
      if (recoveryIdentity) {
        const reopened = await this.projectPaths.workspaceSessionStorageIdentity(project, owner);
        if (!reopened || reopened.dev !== recoveryIdentity.dev || reopened.ino !== recoveryIdentity.ino) {
          throw new ProjectWorkspaceSessionStorageError(
            'Restored project artifacts did not prove the retained archive inode',
          );
        }
        await this.projectPaths.completeWorkspaceSessionStorageRestore(project, owner, reopened);
        this.clearVerifiedProjectScopeGate(project, scope, reopened);
      } else if (this.workspaceScopeGateReason(scope)) {
        return true;
      }
      await this.loadWorkspaceSessions(project.ownerUserId, scope.workspaceRoot);
    } catch (error) {
      this.rejectProjectWorkspaceRestore(
        project,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
    return this.workspacePersistenceErrors.has(key)
      || this.unrestoredProjectScopes.has(key)
      || this.suspendedProjectScopes.has(project.id);
  }

  protected async beforeProjectWorkspaceReplacement(
    project: Project,
  ): Promise<boolean | ProjectWorkspaceReplacementAuthority> {
    if (await this.projectSessionStorageIsUnavailable(project)) {
      throw new ProjectWorkspaceSessionStorageError(
        'Project session storage is unavailable; restore the archive before replacing the workspace',
      );
    }
    const scope = this.projectSessionStorageScope(project);
    const key = `${scope.ownerKey}\u0000${scope.workspaceRoot}`;
    const owner = this.getEnvironmentOwner(project.ownerUserId);
    if (!owner) throw new Error('Project workspace owner is unavailable');
    // Capture the authoritative inode before closing admission or draining writers;
    // never accept a same-name replacement as preservation authority.
    const admittedIdentity = await this.projectPaths.workspaceSessionStorageIdentity(project, owner);
    if (!admittedIdentity) return false;
    const retainedIdentity = this.workspaceArtifactIdentities.get(key);
    if (retainedIdentity && (
      retainedIdentity.dev !== admittedIdentity.dev
      || retainedIdentity.ino !== admittedIdentity.ino
    )) {
      throw new Error('Project artifact directory changed after workspace admission');
    }
    this.workspaceArtifactIdentities.set(key, admittedIdentity);
    // Close admission before awaiting so no create can replace staged authoritative `.cc-web`.
    this.suspendedProjectScopes.set(project.id, scope);
    // Keep scoped records read-only until the exact archive is restored and reloaded;
    // otherwise a failure could recreate canonical storage and obstruct recovery.
    const suspendedReason = 'Project workspace session storage is temporarily unavailable during project replacement';
    const affected: Array<{ session: SessionRecord; previous: string | undefined }> = [];
    for (const session of this.claudeSessions.values()) {
      if (
        session.ownerUserId === project.ownerUserId
        && session.storageScope?.ownerKey === scope.ownerKey
        && session.storageScope?.workspaceRoot === scope.workspaceRoot
      ) {
        affected.push({ session, previous: session.persistenceUnavailable });
        session.persistenceUnavailable = suspendedReason;
      }
    }
    const previousDiagnostic = this.workspacePersistenceErrors.get(key);
    this.workspacePersistenceErrors.set(key, suspendedReason);
    let intentCommitted = false;
    try {
      // Flush barriers let admitted writes finish; later writes reject while persistence is unavailable.
      await Promise.all(affected.flatMap(({ session }) => [
        this.chatStore.flush?.(session),
        this.transcriptStore.flush?.(session),
        this.historyStore.flush?.(session),
        this.pasteStore.flush?.(session),
        this.attachmentStore.flush?.({
          ...session,
          projectId: session.projectId,
          projectWorkingDirKind: session.projectWorkingDirKind,
        }),
      ].filter((pending): pending is Promise<void> => Boolean(pending))));
      // Persist the pre-suspension snapshot; general autosaves must ignore blocked records.
      const persistenceSnapshot = new Map(this.claudeSessions);
      for (const { session, previous } of affected) {
        persistenceSnapshot.set(session.id, {
          ...session,
          persistenceUnavailable: previous,
        });
      }
      if (!(await this.saveSessionsToDisk(persistenceSnapshot))) {
        throw new Error('Workspace storage authority could not be flushed before project replacement');
      }
      // Close direct-child leases before moving the full `.cc-web` tree into staging.
      await closeWorkspaceSessionDirectoryLeasesForScope(scope);
      const identity = await this.projectPaths.workspaceSessionStorageIdentity(project, owner);
      if (
        !identity
        || identity.dev !== admittedIdentity.dev
        || identity.ino !== admittedIdentity.ino
      ) {
        throw new Error('Project artifact directory changed while lifecycle writers were draining');
      }
      // Record durable intent before moving storage so a crash cannot authorize a replacement.
      await this.projectPaths.recordWorkspaceSessionStorageIntent(project, owner, identity);
      intentCommitted = true;
      this.loadedWorkspaceScopes.delete(key);
      return { required: true, identity };
    } catch (error) {
      if (!intentCommitted) {
        this.suspendedProjectScopes.delete(project.id);
        for (const { session, previous } of affected) {
          session.persistenceUnavailable = previous;
        }
        if (previousDiagnostic === undefined) this.workspacePersistenceErrors.delete(key);
        else this.workspacePersistenceErrors.set(key, previousDiagnostic);
      }
      throw error;
    }
  }

  protected async afterProjectWorkspaceRestored(
    project: Project,
    expected?: WorkspaceSessionStorageIdentity,
  ): Promise<WorkspaceSessionStorageIdentity | void> {
    const scope = this.suspendedProjectScopes.get(project.id);
    if (!scope) return;
    try {
      const owner = this.getEnvironmentOwner(project.ownerUserId);
      if (!owner) throw new Error('Project workspace owner is unavailable');
      const reopened = await this.projectPaths.workspaceSessionStorageIdentity(project, owner);
      if (!reopened) throw new Error('Restored project artifact directory is unavailable');
      if (expected && (reopened.dev !== expected.dev || reopened.ino !== expected.ino)) {
        throw new Error('Restored project artifact directory changed identity');
      }
      return reopened;
    } catch (error) {
      this.workspacePersistenceErrors.set(
        `${scope.ownerKey}\u0000${scope.workspaceRoot}`,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  protected async confirmProjectWorkspaceRestored(
    project: Project,
    expected: WorkspaceSessionStorageIdentity,
  ): Promise<WorkspaceSessionStorageIdentity> {
    const scope = this.suspendedProjectScopes.get(project.id);
    if (!scope) throw new Error('Project workspace restore is not awaiting confirmation');
    const owner = this.getEnvironmentOwner(project.ownerUserId);
    if (!owner) throw new Error('Project workspace owner is unavailable');
    const confirmed = await this.projectPaths.workspaceSessionStorageIdentity(project, owner);
    if (!confirmed || confirmed.dev !== expected.dev || confirmed.ino !== expected.ino) {
      throw new Error('Restored project artifact directory changed after confirmation');
    }
    this.clearVerifiedProjectScopeGate(project, scope, confirmed);
    return confirmed;
  }

  protected rejectProjectWorkspaceRestore(project: Project, reason: string): void {
    const scope = this.suspendedProjectScopes.get(project.id)
      || this.projectSessionStorageScope(project);
    const key = `${scope.ownerKey}\u0000${scope.workspaceRoot}`;
    const suspendedReason = `Project workspace session storage restore was rejected: ${reason}`;
    for (const session of this.claudeSessions.values()) {
      if (
        session.ownerUserId === project.ownerUserId
        && session.storageScope?.ownerKey === scope.ownerKey
        && session.storageScope?.workspaceRoot === scope.workspaceRoot
      ) {
        session.persistenceUnavailable = suspendedReason;
      }
    }
    this.loadedWorkspaceScopes.delete(key);
    this.suspendedProjectScopes.set(project.id, scope);
    this.workspacePersistenceErrors.set(key, suspendedReason);
  }

  protected async beforeProjectWorkspaceDeletion(project: Project): Promise<void> {
    const scope = this.projectSessionStorageScope(project);
    const key = this.workspaceScopeKey(scope);
    await closeWorkspaceSessionDirectoryLeasesForScope(scope);
    this.loadedWorkspaceScopes.delete(key);
    this.workspaceArtifactIdentities.delete(key);
    this.suspendedProjectScopes.delete(project.id);
    this.workspaceCatalog.unregister(scope.ownerKey, scope.workspaceRoot);
  }

  protected async workspaceSessionMetadata(ownerUserId?: number): Promise<Record<string, unknown>> {
    const ownerKey = ownerUserId === undefined ? null : this.sessionOwnerKey(ownerUserId);
    const metadata = await this.sessionStore.getSessionMetadata();
    const counts = new Map<string, { ownerKey: string; root: string; sessionCount: number }>();
    for (const session of this.claudeSessions.values()) {
      const scope = session.storageScope;
      if (!scope || (ownerKey && scope.ownerKey !== ownerKey)) continue;
      const key = `${scope.ownerKey}\u0000${scope.workspaceRoot}`;
      const entry = counts.get(key) ?? {
        ownerKey: scope.ownerKey,
        root: scope.workspaceRoot,
        sessionCount: 0,
      };
      entry.sessionCount += 1;
      counts.set(key, entry);
    }
    const workspaces = [...counts.values()].map(({ ownerKey: scopeOwner, root, sessionCount }) => {
      const error = this.workspacePersistenceErrors.get(`${scopeOwner}\u0000${root}`);
      return {
        root,
        available: !error,
        sessionCount,
        ...(error ? { error } : {}),
      };
    });
    const unavailableByScope = new Map<string, { ownerKey: string; root: string; error: string }>();
    for (const [key, error] of this.workspacePersistenceErrors) {
      const separator = key.indexOf('\u0000');
      unavailableByScope.set(key, {
        ownerKey: key.slice(0, separator),
        root: key.slice(separator + 1),
        error,
      });
    }
    const unavailable = Array.from(unavailableByScope.values())
      .filter((entry) => !ownerKey || entry.ownerKey === ownerKey)
      .map(({ root, error }) => ({ root, error }));
    return {
      exists: metadata.exists,
      storage: 'shared-app-sqlite',
      layoutVersion: 2,
      sessionCount: ownerUserId === undefined
        ? metadata.sessionCount ?? 0
        : [...this.claudeSessions.values()].filter((session) => session.ownerUserId === ownerUserId).length,
      savedAt: metadata.savedAt,
      version: metadata.version,
      workspaces,
      unavailable,
      allAvailable: unavailable.length === 0,
    };
  }
}
