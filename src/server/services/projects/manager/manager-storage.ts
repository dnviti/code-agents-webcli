/** Partial class: workspace/checkout storage authority, replacement and boot reconciliation. */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { EnvironmentOwner } from '../../environments/types.js';
import { MANAGED_LABEL, USER_ID_LABEL } from '../../environments/manager.js';
import { PROJECT_LABEL, TARGET_LABEL, projectContainerName, targetLabelValue } from '../../environments/naming.js';
import { isQuiescentContainerStatus } from '../../environments/engine.js';
import { ProjectWorkspaceSessionStorageError, WorkspaceSessionStorageIdentity } from '../environment.js';
import { Project } from '../store.js';
import { ProjectManagerCore } from './manager-core.js';
import { ProjectManagerDeps, ProjectWorkspaceReplacementAuthority } from './manager-types.js';

/** Project ids are UUIDs; never turn a runtime-controlled label into a path. */
const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export abstract class ProjectManagerStorage extends ProjectManagerCore {
  constructor(deps: ProjectManagerDeps) {
    super(deps);
  }

  protected async projectSessionStorageIsUnavailable(project: Project): Promise<boolean> {
    try {
      return Boolean(await this.deps.hasUnavailableProjectSessionStorage?.(project));
    } catch (error) {
      throw new ProjectWorkspaceSessionStorageError(
        `Project session storage could not be verified: ${(error as Error).message}`,
      );
    }
  }

  protected async assertProjectSessionStorageAvailable(project: Project): Promise<void> {
    if (await this.projectSessionStorageIsUnavailable(project)) {
      throw new ProjectWorkspaceSessionStorageError(
        'Project session storage is unavailable; restore the archive and retry before replacing it',
      );
    }
  }

  protected async workspaceReplacementAuthority(
    project: Project,
  ): Promise<ProjectWorkspaceReplacementAuthority> {
    const prepared = await this.deps.beforeWorkspaceReplacement?.(project);
    if (prepared === true) return { required: true };
    if (!prepared) return { required: false };
    return {
      required: prepared.required === true,
      ...(prepared.identity ? { identity: prepared.identity } : {}),
    };
  }

  protected async restoreWorkspaceSessionStorage(
    project: Project,
    owner: EnvironmentOwner,
    required = false,
    expected?: WorkspaceSessionStorageIdentity,
  ): Promise<void> {
    if (required && !expected) {
      throw new ProjectWorkspaceSessionStorageError(
        'workspace session storage could not be restored with its pre-suspension identity',
      );
    }
    const restored = await this.projects.restoreWorkspaceSessionStorage(project, owner, expected);
    if (required && !restored) {
      throw new ProjectWorkspaceSessionStorageError(
        'workspace session storage was not restored after project replacement',
      );
    }
    if (!restored) return;

    const recoveryIdentity = await this.projects.workspaceSessionStorageRecoveryIdentity(project, owner)
      || expected;
    try {
      const reopened = await this.deps.afterWorkspaceRestored?.(project, recoveryIdentity);
      if (!recoveryIdentity) return;
      if (
        !reopened
        || reopened.dev !== recoveryIdentity.dev
        || reopened.ino !== recoveryIdentity.ino
      ) {
        throw new ProjectWorkspaceSessionStorageError(
          'workspace session storage reopen did not prove the retained archive inode',
        );
      }
      await this.projects.completeWorkspaceSessionStorageRestore(project, owner, reopened);
      const confirmed = await this.deps.confirmWorkspaceRestored?.(project, recoveryIdentity);
      if (
        !confirmed
        || confirmed.dev !== recoveryIdentity.dev
        || confirmed.ino !== recoveryIdentity.ino
      ) {
        throw new ProjectWorkspaceSessionStorageError(
          'workspace session storage lease changed after restore completion',
        );
      }
    } catch (error) {
      if (recoveryIdentity) {
        await this.projects.recordWorkspaceSessionStorageIntent(
          project,
          owner,
          recoveryIdentity,
        ).catch(() => undefined);
      }
      await this.deps.rejectWorkspaceRestore?.(
        project,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  protected async clearCheckout(project: Project, owner: EnvironmentOwner): Promise<void> {
    await this.assertProjectSessionStorageAvailable(project);
    const authority = await this.workspaceReplacementAuthority(project);
    const archiveRequired = authority.required;
    const expectedStorage = authority.identity;
    let replacementError: unknown;
    try {
      await this.projects.clearCheckout(project, owner, archiveRequired, expectedStorage);
    } catch (error) {
      replacementError = error;
    }
    // `.cc-web` is staged independently from the disposable checkout bytes.
    // Once the old checkout is gone the retained artifact tree is already back
    // in its canonical place, so re-enable access immediately even if the
    // following clone later fails. This also prevents repository changes from
    // leaving healthy project-file persistence suspended until the next build.
    try {
      await this.restoreWorkspaceSessionStorage(project, owner, archiveRequired, expectedStorage);
    } catch (restoreError) {
      if (replacementError) {
        throw new ProjectWorkspaceSessionStorageError(
          `checkout replacement failed and workspace session storage could not be restored: ${(replacementError as Error).message}; ${(restoreError as Error).message}`,
        );
      }
      throw restoreError;
    }
    if (replacementError) throw replacementError;
  }

  protected async wipe(project: Project): Promise<void> {
    await this.assertProjectSessionStorageAvailable(project);
    const owner = this.owner(project.ownerUserId);
    const root = this.projects.worktreePath(project, owner);
    // `project.id` is a UUID from our store, nevertheless retain the parent
    // check: no malformed row may turn lifecycle recovery into a broad wipe.
    const parent = path.dirname(root);
    if (path.basename(root) !== project.id || path.resolve(root) === path.resolve(parent)) throw new Error('refusing unsafe project workspace removal');
    const authority = await this.workspaceReplacementAuthority(project);
    const archiveRequired = authority.required;
    const expectedStorage = authority.identity;
    let replacementError: unknown;
    try {
      await this.projects.clearWorkspaceForRebuild(project, owner, archiveRequired, expectedStorage);
    } catch (error) {
      replacementError = error;
    }
    try {
      await this.restoreWorkspaceSessionStorage(project, owner, archiveRequired, expectedStorage);
    } catch (restoreError) {
      if (replacementError) {
        throw new ProjectWorkspaceSessionStorageError(
          `project rebuild cleanup failed and workspace session storage could not be restored: ${(replacementError as Error).message}; ${(restoreError as Error).message}`,
        );
      }
      throw restoreError;
    }
    if (replacementError) throw replacementError;
  }

  protected async projectStorageRootForEngine(engineKey: string): Promise<string | null> {
    try {
      // Group aliases by their physical root. A lexical `resolve()` would let
      // a failing alias scan race a successful sweep of the same bytes.
      return await fsp.realpath(path.resolve(
        this.deps.environments.projectStorageRoot(engineKey === 'legacy' ? null : engineKey),
      ));
    } catch {
      return null;
    }
  }

  protected orphanWorkspacePath(root: string, projectId: string): string {
    if (!PROJECT_ID.test(projectId)) throw new Error('refusing non-UUID orphan workspace id');
    const parent = path.resolve(root);
    const workspace = path.resolve(parent, projectId);
    if (path.dirname(workspace) !== parent || path.basename(workspace) !== projectId) {
      throw new Error('refusing unsafe orphan workspace removal');
    }
    return workspace;
  }

  protected async removeOrphanWorkspace(root: string, projectId: string): Promise<void> {
    await fsp.rm(this.orphanWorkspacePath(root, projectId), { recursive: true, force: true });
  }

  protected async removeStaleOrphanWorkspaces(root: string, protectedIds: ReadonlySet<string>): Promise<void> {
    let entries;
    try {
      entries = await fsp.readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !PROJECT_ID.test(entry.name)
        || protectedIds.has(entry.name) || this.deps.store.getProject(entry.name)) continue;
      await this.removeOrphanWorkspace(root, entry.name);
    }
  }

  async reconcileOnBoot(): Promise<void> {
    // Boot integration calls this after old runtimes are gone and before any
    // new project attachment is admitted; process-local leases cannot survive.
    this.deps.store.clearSessionLeases();
    // A crash can leave a syntactically valid `.git` directory before clone's
    // exact-OID fetch/checkout/verification finishes. Never infer that such a
    // workspace is the inspected tree merely because repository metadata now
    // exists: every interrupted build must wipe and reconstruct it on retry.
    for (const project of this.deps.store.listProjectsInState('building')) {
      this.deps.store.setRebuildRequired(project.id, true);
      if (project.executionKind === 'host') {
        this.deps.store.setState(project.id, 'stopped', 'Local build was interrupted; start the project to retry');
      }
    }
    const reconciled = new Set<string>();
    // A crash can happen after the engine creates a deterministic runtime but
    // before its name reaches SQLite. Do not rely on the broad label scan to
    // find it: that scan can itself be unavailable. Record only the expected
    // name for interrupted, counted rows, then let the identity-bound pass
    // below prove it absent, owned, foreign, or unreachable.
    for (const project of this.deps.store.listProjectsInState('building', 'running', 'reclaiming')) {
      if (project.executionKind === 'host') continue;
      if (project.container) continue;
      try {
        const target = this.deps.environments.projectTarget(project.targetId);
        this.deps.store.setContainer(project.id, {
          name: projectContainerName(target.config.namePrefix, project),
        });
      } catch (error) {
        reconciled.add(project.id);
        this.deps.store.setState(
          project.id,
          'reclaiming',
          `Interrupted project runtime placement could not be resolved: ${(error as Error).message}`,
        );
        this.publish(this.deps.store.getProject(project.id) as Project);
      }
    }
    // Several deploy targets may intentionally share one storage root. A
    // stale directory is deletable only after every engine that can mount that
    // root completed its scan; one uncertain engine could still be executing
    // from the same workspace.
    const rootScans = new Map<string, { complete: boolean; protectedIds: Set<string> }>();
    // A conflict name is not placement authority. Until every reachable
    // engine has completed this pass, a claimant might still be alive on a
    // different target, so do not clear its durable conflict marker.
    let engineScansComplete = true;
    const observedConflictClaimants = new Set<string>();
    for (const engineKey of this.deps.environments.reachableEngines().keys()) {
      const root = await this.projectStorageRootForEngine(engineKey);
      if (root && !rootScans.has(root)) rootScans.set(root, { complete: true, protectedIds: new Set() });
    }
    for (const [engineKey, engine] of this.deps.environments.reachableEngines()) {
      const root = await this.projectStorageRootForEngine(engineKey);
      const scan = root ? rootScans.get(root) : undefined;
      let names: string[];
      try { names = await engine.list(PROJECT_LABEL); } catch (error) {
        engineScansComplete = false;
        if (scan) scan.complete = false;
        console.error(`Project reconcile: could not list target '${engineKey}':`, error);
        continue;
      }
      for (const name of names) {
        try {
          const described = await engine.describeStrict(name);
          // The project label is public metadata and can appear on unrelated
          // containers. Any UUID-labelled container might still mount the
          // matching workspace, however, so protect it before deciding
          // whether its ownership labels permit reconciliation.
          if (!described) continue;
          const id = described.labels[PROJECT_LABEL];
          const project = id ? this.deps.store.getProject(id) : null;
          if (project?.executionKind === 'host') continue;
          if (project) {
            // A project label identifies a workspace, not the authority to
            // use it. Check placement before the managed-label early return:
            // even a foreign claimant must block lifecycle deletion.
            const expectedKey = project.targetId || 'legacy';
            let expected;
            try {
              expected = this.deps.environments.projectTarget(project.targetId);
            } catch {
              expected = null;
            }
            const expectedName = project.container?.name || projectContainerName(expected?.config.namePrefix || '', project);
            const exactRuntime = Boolean(expected)
              && engineKey === expectedKey
              && engine === expected!.engine
              && described.name === expectedName
              && described.labels[MANAGED_LABEL] === 'true'
              && described.labels[USER_ID_LABEL] === String(project.ownerUserId)
              && described.labels[TARGET_LABEL] === targetLabelValue(expectedKey);
            if (!exactRuntime) {
              // A conflict remains observed even if this claimant's labels
              // changed. Keep the recorded/deterministic name: the claimant
              // name itself is never placement authority and must not replace
              // the identity-bound runtime we still need to retire.
              reconciled.add(project.id);
              observedConflictClaimants.add(project.id);
              this.deps.store.setContainer(project.id, project.container
                ? { ...project.container, reconciliationConflict: 'unverified_runtime' }
                : { name: expectedName, reconciliationConflict: 'unverified_runtime' });
              this.deps.store.setState(
                project.id,
                'reclaiming',
                'A project-labelled runtime did not match the recorded project placement; manual recovery required',
              );
              this.publish(this.deps.store.getProject(project.id) as Project);
              continue;
            }
          }
          if (scan && id && PROJECT_ID.test(id)
            && described.labels[MANAGED_LABEL] !== 'true') scan.protectedIds.add(id);
          // Only this application's explicitly managed containers are
          // eligible for reconciliation or destructive orphan cleanup.
          if (described.labels[MANAGED_LABEL] !== 'true') continue;
          // A managed container with no project row is an orphan. A container
          // whose label/name collides with an existing row is *not* an orphan:
          // it may be foreign, so reconciliation must retain the row and let
          // the per-project pass fail closed rather than deleting by name.
          const isSafeOrphan = !project
            && Boolean(id)
            && PROJECT_ID.test(id)
            && /^\d+$/.test(described.labels[USER_ID_LABEL] || '')
            && described.labels[TARGET_LABEL] === targetLabelValue(engineKey);
          // A managed UUID-labelled runtime with an unsafe claimant shape is
          // never removable, and may be using this root. Safe orphans are
          // intentionally not protected: a removal failure makes the entire
          // root scan incomplete instead.
          if (!isSafeOrphan && scan && id && PROJECT_ID.test(id)) scan.protectedIds.add(id);
          if (isSafeOrphan) {
            await engine.removeIdentity(described);
            if (await engine.describeStrict(name)) {
              throw new Error(`managed orphan '${name}' still exists after removal`);
            }
            if (!root) throw new Error(`managed orphan '${name}' has no resolvable storage root`);
            // Workspace deletion is deferred until every engine sharing this
            // root completes. Another target can still have this UUID mounted.
            continue;
          }
          if (project && !project.container) {
            // A crash can land after the runtime was created but before its
            // name was committed. Adopt only the exact deterministic runtime
            // on the recorded target; a project label alone is public data and
            // is never enough authority to stop or remove a container.
            const expectedKey = project.targetId || 'legacy';
            let expected;
            try {
              expected = this.deps.environments.projectTarget(project.targetId);
            } catch {
              expected = null;
            }
            const exactRuntime = Boolean(expected)
              && engineKey === expectedKey
              && engine === expected!.engine
              && described.name === projectContainerName(expected!.config.namePrefix, project)
              && described.labels[USER_ID_LABEL] === String(project.ownerUserId)
              && described.labels[TARGET_LABEL] === targetLabelValue(expectedKey);
            reconciled.add(project.id);
            if (exactRuntime) {
              this.deps.store.setContainer(project.id, { name: described.name });
              continue;
            }
            // Do not let a later fallback turn an interrupted build into an
            // uncounted stopped row while an unverified same-label runtime
            // may still be executable. Keep it recoverable but unadopted.
            this.deps.store.setState(
              project.id,
              'reclaiming',
              'A project-labelled runtime did not match the recorded project placement; manual recovery required',
            );
            this.publish(this.deps.store.getProject(project.id) as Project);
          }
        } catch (error) {
          engineScansComplete = false;
          if (scan) scan.complete = false;
          console.error(`Project reconcile: could not reconcile '${name}':`, error);
        }
      }
    }
    for (const snapshot of this.deps.store.listProjectsWithContainers()) {
      reconciled.add(snapshot.id);
      await this.exclusiveFor([snapshot.id], async () => {
        const project = this.deps.store.getProject(snapshot.id);
        if (!project?.container) return;
        let target;
        try {
          target = this.deps.environments.projectTarget(project.targetId);
        } catch (error) {
          const detail = `Recorded project target could not be resolved: ${(error as Error).message}`;
          this.deps.store.setState(project.id, 'reclaiming', detail);
          this.publish(this.deps.store.getProject(project.id) as Project);
          return;
        }
        const storageRoot = await this.projectStorageRootForEngine(target.key);
        const scan = storageRoot ? rootScans.get(storageRoot) : undefined;
        let described;
        try {
          described = await target.engine.describeStrict(project.container.name);
        } catch (error) {
          engineScansComplete = false;
          if (scan) scan.complete = false;
          const detail = `Recorded project container could not be inspected: ${(error as Error).message}`;
          // Its physical state is unknown, so retain a counted state until an
          // operator can reach the target and reconcile it safely.
          this.deps.store.setState(project.id, 'reclaiming', detail);
          this.publish(this.deps.store.getProject(project.id) as Project);
          return;
        }

        const hasConflict = project.container.reconciliationConflict === 'unverified_runtime';
        if (hasConflict && !described) {
          // The expected runtime is absent, but a mismatch observed anywhere
          // in this complete boot pass still blocks workspace destruction.
          if (observedConflictClaimants.has(project.id) || !engineScansComplete || !scan?.complete) {
            if (scan && PROJECT_ID.test(project.id)) scan.protectedIds.add(project.id);
            this.deps.store.setState(
              project.id,
              'reclaiming',
              'An unverified project-labelled runtime still exists; manual recovery required',
            );
            this.publish(this.deps.store.getProject(project.id) as Project);
            return;
          }
          // Every target completed and no mismatched claimant was seen.
          this.deps.store.setContainer(project.id, null);
          this.deps.store.setRebuildRequired(project.id, true);
          this.deps.store.setState(project.id, 'stopped', 'Unverified runtime is absent after a complete target scan; rebuild required');
          this.publish(this.deps.store.getProject(project.id) as Project);
          return;
        }

        if (!described) {
          this.deps.store.setContainer(project.id, null);
          const expectedStoppedPod = project.state === 'stopped'
            && !project.rebuildRequired
            && target.engine.kind === 'kubernetes';
          this.deps.store.setRebuildRequired(project.id, !expectedStoppedPod);
          this.deps.store.setState(
            project.id,
            'stopped',
            expectedStoppedPod ? 'Stopped Kubernetes runtime is absent; retained workspace is ready' : 'Recorded project container is missing; rebuild required',
          );
          this.publish(this.deps.store.getProject(project.id) as Project);
          return;
        }

        const expectedKey = project.targetId || 'legacy';
        const ownershipMatches = described.labels[MANAGED_LABEL] === 'true'
          && described.labels[PROJECT_LABEL] === project.id
          && described.labels[USER_ID_LABEL] === String(project.ownerUserId)
          && described.labels[TARGET_LABEL] === targetLabelValue(expectedKey);
        if (!ownershipMatches) {
          engineScansComplete = false;
          if (scan) scan.complete = false;
          // Do not clear the recorded name or touch its workspace: it may now
          // name a foreign container. Keep the lifecycle counted until an
          // operator resolves the ownership conflict deliberately.
          this.deps.store.setState(project.id, 'reclaiming', 'Recorded container ownership changed; manual recovery required');
          this.publish(this.deps.store.getProject(project.id) as Project);
          return;
        }

        const engine = target.engine;
        let expectedRuntimeAbsent = false;
        try {
          // Session leases and in-memory command ownership do not survive a
          // server restart. Retire every potentially executable runtime before
          // reopening admission, including Pending Pods and restarting or
          // paused containers that are not literally reported as "running".
          const alreadyQuiescent = engine.kind !== 'kubernetes'
            && isQuiescentContainerStatus(described.status);
          if (!alreadyQuiescent) await engine.stopIdentity(described);

          const after = await engine.describeStrict(described.name);
          if (after) {
            if (after.identity !== described.identity) {
              throw new Error(`container '${described.name}' was replaced while being retired`);
            }
            if (engine.kind === 'kubernetes'
              || !isQuiescentContainerStatus(after.status)) {
              throw new Error(`container '${described.name}' is still potentially executable (${after.status})`);
            }
          } else {
            expectedRuntimeAbsent = true;
            if (!hasConflict) this.deps.store.setContainer(project.id, null);
          }
        } catch (error) {
          engineScansComplete = false;
          if (scan) scan.complete = false;
          const detail = `Interrupted project container could not be retired safely: ${(error as Error).message}`;
          this.deps.store.setState(project.id, 'reclaiming', detail);
          this.publish(this.deps.store.getProject(project.id) as Project);
          return;
        }

        if (hasConflict) {
          if (observedConflictClaimants.has(project.id) || !engineScansComplete || !scan?.complete) {
            // The exact runtime was retired, but retain the marker (including
            // after Kubernetes deletes it) until a later full scan proves no
            // mismatched claimant survived elsewhere.
            this.deps.store.setState(
              project.id,
              'reclaiming',
              'Recorded runtime was retired but an unverified project-labelled runtime still exists',
            );
            this.publish(this.deps.store.getProject(project.id) as Project);
            return;
          }
          if (expectedRuntimeAbsent) {
            this.deps.store.setContainer(project.id, null);
          } else {
            const { reconciliationConflict: _conflict, ...verifiedContainer } = project.container;
            this.deps.store.setContainer(project.id, verifiedContainer);
          }
          this.deps.store.setState(project.id, 'stopped', 'Project runtime stopped after a complete conflict-free boot scan');
          this.publish(this.deps.store.getProject(project.id) as Project);
          return;
        }

        if (project.state === 'running') {
          this.deps.store.setState(project.id, 'stopped', 'Interrupted by server restart; runtime stopped safely');
          this.publish(this.deps.store.getProject(project.id) as Project);
        } else if (project.state === 'building' || project.state === 'reclaiming') {
          this.deps.store.setState(project.id, 'stopped', 'Interrupted by server restart; start again to rebuild');
          this.publish(this.deps.store.getProject(project.id) as Project);
        }
      });
    }
    for (const project of this.deps.store.listProjectsInState('building', 'reclaiming')) {
      if (reconciled.has(project.id)) continue;
      this.deps.store.setState(project.id, 'stopped', 'Interrupted by server restart; start again to rebuild');
      this.publish(this.deps.store.getProject(project.id) as Project);
    }
    for (const project of this.deps.store.listProjectsInState('inspecting')) {
      this.deps.store.setState(project.id, 'unavailable', 'Repository inspection was interrupted; inspect it again');
      this.publish(this.deps.store.getProject(project.id) as Project);
    }
    // Only sweep after direct project reconciliation too. A successful broad
    // list is insufficient if an identity-bound inspection later became
    // uncertain; it could still be holding the shared workspace mount.
    for (const [root, scan] of rootScans) {
      if (!scan.complete) continue;
      try {
        await this.removeStaleOrphanWorkspaces(root, scan.protectedIds);
      } catch (error) {
        console.error(`Project reconcile: could not remove stale workspaces under '${root}':`, error);
      }
    }
  }
}
