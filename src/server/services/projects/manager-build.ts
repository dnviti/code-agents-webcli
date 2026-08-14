/** Partial class: build, preservation and reclaim of project workspaces. */

import { preserveProjectWork } from './preserve.js';
import {
  cloneRepository,
  cloneRepositoryOnHost,
  CloneSourceChangedError,
  hostRepositoryHasChanges,
} from './clone.js';
import {
  ProjectContainerOwnershipError,
  ProjectContainerStateUnknownError,
  ProjectWorkspaceSessionStorageError,
} from './environment.js';
import { Project, ProjectComposition, ProjectState, CompositionInstallation } from './store.js';
import { SimpleResult } from './manager-types.js';
import { compositionChoiceFrom } from './manager-helpers.js';
import { ProjectManagerCompositionCore } from './manager-composition-core.js';

export abstract class ProjectManagerBuild extends ProjectManagerCompositionCore {
  protected trackBuild(ownerUserId: number, projectId: string): void {
    if (this.builds.has(projectId)) return;
    const task = this.exclusiveFor([projectId], () => this.build(ownerUserId, projectId));
    this.builds.set(projectId, task);
    void task.finally(() => {
      if (this.builds.get(projectId) === task) this.builds.delete(projectId);
    }).catch(() => undefined);
  }

  protected async build(ownerUserId: number, projectId: string): Promise<void> {
    const project = this.deps.store.getProjectForUser(projectId, ownerUserId);
    if (!project) return;
    if (project.executionKind === 'host') {
      await this.buildLocal(project);
      return;
    }
    this.event(project, { t: 'step', step: 'container', percent: 15, message: 'Preparing project environment' });
    let workingProject: Project | null = null;
    let failureState: ProjectState = 'failed';
    let failureEvent: 'error' | 'preserve' = 'error';
    let checkoutReplacementStarted = false;
    try {
      const owner = this.owner(ownerUserId);
      const initialCheckout = project.repoUrl
        ? await this.projects.checkoutState(project, owner)
        : 'empty_or_absent';
      if (project.repoUrl && initialCheckout === 'unsafe') {
        failureState = 'blocked'; failureEvent = 'preserve';
        throw new Error('Repository metadata is missing or unreadable in a non-empty workspace; repair it or discard explicitly');
      }
      const hadValidCheckout = initialCheckout === 'valid';
      let prepared = await this.projects.ensure(project, owner);
      workingProject = { ...project, container: { name: prepared.containerName } };
      this.deps.store.setContainer(project.id, workingProject.container);
      const missingRecordedDockerRuntime = prepared.created
        && Boolean(project.container)
        && this.deps.environments.projectTarget(project.targetId).engine.kind !== 'kubernetes';
      if (missingRecordedDockerRuntime) this.deps.store.setRebuildRequired(project.id, true);
      const current = this.deps.store.getProject(project.id) as Project;
      const requiresWorkspaceRebuild = current.rebuildRequired;
      if (requiresWorkspaceRebuild) {
        await this.assertProjectSessionStorageAvailable(current);
      }
      if (!requiresWorkspaceRebuild) {
        await this.restoreWorkspaceSessionStorage(current, owner);
      }
      if (current.repoUrl) {
        if (requiresWorkspaceRebuild && hadValidCheckout) {
          this.event(current, { t: 'preserve', message: 'Preserving work before replacing the project container' });
          try {
            const result = await this.exclusiveCredentialFor(
              current.ownerUserId,
              current.repoHost,
              () => preserveProjectWork({
                engine: this.deps.environments.projectTarget(current.targetId).engine,
                containerName: prepared.containerName,
                containerIdentity: prepared.containerAccess.containerIdentity,
                repoContainerPath: this.projects.checkoutContainerPath(current),
                repoUrl: current.repoUrl!,
                author: this.preservationAuthor(current),
                credential: this.credentialRecordFor(current)?.token || null,
                now: this.now,
                timeoutMs: this.deps.preserveTimeoutMs,
              }),
            );
            if (result.preserved) this.recordPreservation(current.id, result);
          } catch (error) {
            failureState = 'blocked';
            failureEvent = 'preserve';
            throw error;
          }
        }
      }
      if (requiresWorkspaceRebuild) {
        // Do not delete a bind-mounted root beneath a live runtime: the
        // container could retain an unlinked mount and write bytes the next
        // build cannot see. Remove the verified owned runtime, wipe every
        // project byte (including no-repository projects), then make a fresh
        // runtime around the empty root.
        await this.projects.remove(workingProject);
        await this.wipe(current);
        prepared = await this.projects.ensure({ ...current, container: { name: prepared.containerName } }, owner);
        workingProject = { ...current, container: { name: prepared.containerName } };
        this.deps.store.setContainer(current.id, workingProject.container);
        if (!current.repoUrl) {
          await this.restoreWorkspaceSessionStorage(current, owner);
        }
      }
      let composition: ProjectComposition | null = null;
      let installationResults: CompositionInstallation[] = [];
      if (current.compositionRevision) {
        composition = this.deps.store.getProjectComposition(
          current.id,
          current.ownerUserId,
          current.compositionRevision,
        );
        const chosen = compositionChoiceFrom(composition?.chosen);
        if (!composition || !chosen) throw new Error('Active build recipe is unavailable');
        if (!this.deps.compositionRuntime) throw new Error('Project composition runtime is unavailable');
        this.event(current, {
          t: 'step', step: 'tooling', percent: 30, message: 'Installing the selected project tools',
        });
        await this.exclusiveCredentialFor(current.ownerUserId, composition.forgeHost, async () => {
          // Read the generation only after entering the host critical section;
          // a long tool install can no longer publish a superseded credential.
          const context = this.runtimeContext(current, composition!, chosen, prepared);
          const applied = await this.deps.compositionRuntime!.prepare(context);
          installationResults = applied.installations;
          await this.deps.compositionRuntime!.configureGit(context);
        });
      }
      if (current.repoUrl && (requiresWorkspaceRebuild || !(await this.projects.hasValidCheckout(current, owner)))) {
        await this.exclusiveCredentialFor(current.ownerUserId, current.repoHost, async () => {
          let access = await this.preflight(current.repoUrl!);
          const credential = this.credentialRecordFor(current);
          if (!access.ok && access.reason === 'credential_required' && credential) {
            access = await this.preflight(current.repoUrl!, credential.token);
          }
          if (!access.ok) {
            if (credential && access.reason === 'credential_required' && current.repoHost) {
              this.markCredentialRejected(current.ownerUserId, current.repoHost, credential);
            }
            failureState = access.reason === 'repo_gone' ? 'unavailable' : 'failed';
            throw new Error(access.message);
          }
          // `git clone` leaves its destination behind on many failures. Its
          // mere existence is not proof of an exact checkout. Persist the
          // replacement intent before touching bytes so a crash or a failed
          // cleanup cannot turn a partial `.git` directory into boot evidence.
          this.deps.store.setRebuildRequired(current.id, true);
          checkoutReplacementStarted = true;
          await this.clearCheckout(current, owner);
          this.event(current, { t: 'step', step: 'clone', percent: 45, message: 'Cloning repository' });
          await cloneRepository({
            engine: this.deps.environments.projectTarget(current.targetId).engine,
            containerName: prepared.containerName,
            containerIdentity: prepared.containerAccess.containerIdentity,
            repoUrl: current.repoUrl!,
            destination: this.projects.checkoutContainerPath(current),
            credential: credential?.token || null,
            expectedOid: composition?.sourceOid || undefined,
            timeoutMs: this.deps.cloneTimeoutMs,
          });
        });
        if (!(await this.projects.hasValidCheckout(current, owner))) {
          throw new Error('Repository clone completed without a valid .git checkout');
        }
        await this.restoreWorkspaceSessionStorage(current, owner);
        checkoutReplacementStarted = false;
      }
      const failedInstallations = installationResults.filter((item) => item.status === 'failed');
      if (failedInstallations.length) {
        this.event(current, {
          t: 'partial_install',
          percent: 90,
          message: `Project is usable, but some tools failed: ${failedInstallations.map((item) => item.itemId).join(', ')}`,
        });
      }
      if (composition && !this.deps.store.markCompositionApplied(project.id, ownerUserId, composition.id)) {
        throw new Error('Active build recipe changed before its result could be recorded');
      }
      this.deps.store.setState(
        project.id,
        'running',
        failedInstallations.length
          ? `Some selected tools could not be installed: ${failedInstallations.map((item) => item.itemId).join(', ')}`
          : null,
      );
      this.deps.store.setRebuildRequired(project.id, false);
      this.deps.store.touchActivity(project.id, this.now());
      this.event(this.deps.store.getProject(project.id) as Project, {
        t: 'state',
        state: 'running',
        percent: 100,
        message: failedInstallations.length ? 'Project ready with tool installation warnings' : 'Project ready',
      });
    } catch (error) {
      const message = (error as Error).message;
      if (error instanceof ProjectWorkspaceSessionStorageError) {
        failureState = 'blocked';
        failureEvent = 'preserve';
      }
      if (error instanceof CloneSourceChangedError) {
        try {
          if (checkoutReplacementStarted) {
            await this.clearCheckout(project, this.owner(ownerUserId));
            checkoutReplacementStarted = false;
          }
          if (workingProject) await this.projects.stop(workingProject);
        } catch (cleanupError) {
          const detail = `${message}; project container cleanup could not be verified: ${(cleanupError as Error).message}`;
          this.deps.store.setState(project.id, 'reclaiming', detail);
          this.event(this.deps.store.getProject(project.id) as Project, {
            t: 'error', state: 'reclaiming', message: detail,
          });
          return;
        }
        this.deps.store.setState(project.id, 'composition_pending', message);
        this.event(this.deps.store.getProject(project.id) as Project, {
          t: 'state', state: 'composition_pending', message,
        });
        return;
      }
      if (checkoutReplacementStarted) {
        try {
          await this.clearCheckout(project, this.owner(ownerUserId));
          checkoutReplacementStarted = false;
        } catch {
          failureState = 'blocked';
          failureEvent = 'preserve';
        }
      }
      if (error instanceof ProjectContainerStateUnknownError || error instanceof ProjectContainerOwnershipError) {
        const containerName = error instanceof ProjectContainerStateUnknownError
          ? error.containerName
          : project.container?.name;
        if (containerName) this.deps.store.setContainer(project.id, { name: containerName });
        this.deps.store.setState(project.id, 'reclaiming', message);
        this.event(this.deps.store.getProject(project.id) as Project, {
          t: 'error', state: 'reclaiming', message,
        });
        return;
      }
      if (workingProject) {
        try {
          await this.projects.stop(workingProject);
        } catch (stopError) {
          const detail = `${message}; project container could not be stopped: ${(stopError as Error).message}`;
          // `reclaiming` remains counted. The build has settled, but the
          // runtime could still run; recovery must re-check its ownership and
          // liveness before it can release this slot.
          this.deps.store.setState(project.id, 'reclaiming', detail);
          this.event(this.deps.store.getProject(project.id) as Project, {
            t: 'error', state: 'reclaiming', message: detail,
          });
          return;
        }
      }
      this.deps.store.setState(project.id, failureState, message);
      this.event(this.deps.store.getProject(project.id) as Project, {
        t: failureEvent, state: failureState, message,
      });
    }
  }

  /** Build the default-installation form of a project: a normal host folder. */
  protected async buildLocal(project: Project): Promise<void> {
    const owner = this.owner(project.ownerUserId);
    let replacementStarted = false;
    try {
      await this.projects.ensureLocal(project, owner);
      const current = this.deps.store.getProject(project.id) as Project;
      const composition = current.compositionRevision
        ? this.deps.store.getProjectComposition(current.id, current.ownerUserId, current.compositionRevision)
        : null;
      // A host project has no disposable runtime layer. Recipe changes and an
      // interrupted app process never justify deleting a valid local checkout.
      if (current.repoUrl && !(await this.projects.hasValidCheckout(current, owner))) {
        await this.exclusiveCredentialFor(current.ownerUserId, current.repoHost, async () => {
          let access = await this.preflight(current.repoUrl!);
          const credential = this.credentialRecordFor(current);
          if (!access.ok && access.reason === 'credential_required' && credential) {
            access = await this.preflight(current.repoUrl!, credential.token);
          }
          if (!access.ok) throw new Error(access.message);
          this.deps.store.setRebuildRequired(current.id, true);
          replacementStarted = true;
          await this.clearCheckout(current, owner);
          this.event(current, { t: 'step', step: 'clone', percent: 45, message: 'Cloning repository into the local workspace' });
          await cloneRepositoryOnHost({
            repoUrl: current.repoUrl!,
            destination: this.projects.checkoutPath(current, owner),
            credential: credential?.token || null,
            expectedOid: composition?.sourceOid || undefined,
            timeoutMs: this.deps.cloneTimeoutMs,
          });
        });
        replacementStarted = false;
      }
      await this.restoreWorkspaceSessionStorage(current, owner);
      if (composition && !this.deps.store.markCompositionApplied(project.id, project.ownerUserId, composition.id)) {
        throw new Error('Active build recipe changed before its result could be recorded');
      }
      this.deps.store.setContainer(project.id, null);
      this.deps.store.setRebuildRequired(project.id, false);
      this.deps.store.setState(project.id, 'running');
      this.deps.store.touchActivity(project.id, this.now());
      this.event(this.deps.store.getProject(project.id) as Project, {
        t: 'state', state: 'running', percent: 100, message: 'Local project ready',
      });
    } catch (error) {
      if (replacementStarted) await this.clearCheckout(project, owner).catch(() => undefined);
      const message = (error as Error).message;
      const state: ProjectState = error instanceof CloneSourceChangedError
        ? 'composition_pending'
        : error instanceof ProjectWorkspaceSessionStorageError ? 'blocked' : 'failed';
      this.deps.store.setState(project.id, state, message);
      this.event(this.deps.store.getProject(project.id) as Project, {
        t: error instanceof ProjectWorkspaceSessionStorageError ? 'preserve' : 'error', state, message,
      });
    }
  }

  protected async snapshotBeforeRepositoryChange(project: Project): Promise<SimpleResult> {
    const owner = this.owner(project.ownerUserId);
    if (!project.repoUrl) {
      return { ok: true };
    }
    const checkout = await this.projects.checkoutState(project, owner);
    if (checkout === 'unsafe') {
      const detail = 'Repository metadata is missing or unreadable in a non-empty workspace; repair it or discard explicitly';
      this.deps.store.setState(project.id, 'blocked', detail);
      this.event(this.deps.store.getProject(project.id) as Project, { t: 'preserve', state: 'blocked', message: detail });
      return { ok: false, reason: 'preserve_failed', detail };
    }
    if (checkout !== 'valid') return { ok: true };
    if (project.executionKind === 'host') {
      try {
        if (!await hostRepositoryHasChanges(this.projects.checkoutPath(project, owner))) return { ok: true };
      } catch (error) {
        return { ok: false, reason: 'preserve_failed', detail: `Could not verify local repository state: ${(error as Error).message}` };
      }
      const detail = 'Local repository has uncommitted work; commit or push it before changing the repository, or discard explicitly';
      return { ok: false, reason: 'preserve_failed', detail };
    }
    const priorState = project.state;
    const priorDetail = project.stateDetail;
    let workingProject: Project | null = null;
    this.deps.store.setState(project.id, 'reclaiming', 'Preserving work before repository change');
    this.publish(this.deps.store.getProject(project.id) as Project);
    try {
      const prepared = await this.projects.ensure(project, owner);
      workingProject = { ...project, container: { name: prepared.containerName } };
      this.deps.store.setContainer(project.id, workingProject.container);
      const result = await this.exclusiveCredentialFor(
        project.ownerUserId,
        project.repoHost,
        () => preserveProjectWork({
          engine: this.deps.environments.projectTarget(project.targetId).engine,
          containerName: prepared.containerName,
          containerIdentity: prepared.containerAccess.containerIdentity,
          repoContainerPath: this.projects.checkoutContainerPath(project),
          repoUrl: project.repoUrl!,
          author: this.preservationAuthor(project),
          credential: this.credentialRecordFor(project)?.token || null,
          now: this.now,
          timeoutMs: this.deps.preserveTimeoutMs,
        }),
      );
      if (result.preserved) this.recordPreservation(project.id, result);
      await this.projects.stop(workingProject);
      this.deps.store.setState(project.id, priorState, priorDetail);
      this.publish(this.deps.store.getProject(project.id) as Project);
      return { ok: true };
    } catch (error) {
      const message = (error as Error).message;
      if (error instanceof ProjectContainerStateUnknownError) {
        this.deps.store.setContainer(project.id, { name: error.containerName });
        this.deps.store.setState(project.id, 'reclaiming', message);
        this.event(this.deps.store.getProject(project.id) as Project, {
          t: 'preserve', state: 'reclaiming', message,
        });
        return { ok: false, reason: 'preserve_failed', detail: message };
      }
      try {
        if (workingProject?.container) await this.projects.stop(workingProject);
      } catch (stopError) {
        const detail = `${message}; project container could not be stopped: ${(stopError as Error).message}`;
        this.deps.store.setState(project.id, 'reclaiming', detail);
        this.event(this.deps.store.getProject(project.id) as Project, {
          t: 'preserve', state: 'reclaiming', message: detail,
        });
        return { ok: false, reason: 'preserve_failed', detail };
      }
      this.deps.store.setState(project.id, 'blocked', message);
      this.event(this.deps.store.getProject(project.id) as Project, {
        t: 'preserve', state: 'blocked', message,
      });
      return { ok: false, reason: 'preserve_failed', detail: message };
    }
  }

  protected async reclaim(
    project: Project,
    discard: boolean,
    beforeDestroy?: () => Promise<void>,
    alreadyClaimed = false,
  ): Promise<SimpleResult> {
    if (await this.projectSessionStorageIsUnavailable(project)) {
      const detail = 'Project session storage is unavailable; restore the archive and retry before reclaiming it';
      // `tryClaimIdleReclaim` may already have moved the durable row into the
      // counted transition state. Put it back exactly where the claim found it
      // (running/stopped/blocked/reclaiming) and expose the storage reason; the
      // archive guard must not strand an idle project in a fake in-flight
      // reclaim or make a still-running runtime uncounted.
      this.deps.store.setRebuildRequired(project.id, project.rebuildRequired);
      this.deps.store.setState(project.id, project.state, detail);
      this.publish(this.deps.store.getProject(project.id) as Project);
      return { ok: false, reason: 'preserve_failed', detail };
    }
    if (project.container?.reconciliationConflict === 'unverified_runtime') {
      return { ok: false, reason: 'invalid_state', detail: 'project runtime ownership is unverified; wait for a complete boot reconciliation' };
    }
    const priorState = project.state;
    const priorDetail = project.stateDetail;
    const owner = this.owner(project.ownerUserId);
    const checkout = project.repoUrl
      ? await this.projects.checkoutState(project, owner)
      : 'empty_or_absent';
    const validCheckout = checkout === 'valid';
    if (!discard && project.repoUrl && checkout === 'unsafe') {
      const detail = 'Repository metadata is missing or unreadable in a non-empty workspace; repair it or discard explicitly';
      this.deps.store.setState(project.id, 'blocked', detail);
      this.event(this.deps.store.getProject(project.id) as Project, { t: 'preserve', state: 'blocked', message: detail });
      return { ok: false, reason: 'preserve_failed', detail };
    }
    if (!discard && project.state === 'blocked' && project.repoUrl && !validCheckout) {
      const detail = 'Repository checkout is unavailable for preservation; retry after repair or discard explicitly';
      this.deps.store.setState(project.id, 'blocked', detail);
      this.event(this.deps.store.getProject(project.id) as Project, {
        t: 'preserve', state: 'blocked', message: detail,
      });
      return { ok: false, reason: 'preserve_failed', detail };
    }
    if (project.executionKind === 'host') {
      return this.reclaimLocal(project, discard, beforeDestroy, alreadyClaimed, validCheckout);
    }
    if (!alreadyClaimed) this.deps.store.setState(project.id, 'reclaiming');
    if (!alreadyClaimed) this.deps.store.setRebuildRequired(project.id, true);
    this.publish(this.deps.store.getProject(project.id) as Project);
    let workingProject = project;
    let preparedForPreservation = false;
    if (!discard && project.repoUrl && validCheckout) {
      try {
        // Explicit stop only stops execution; it does not prove that work was
        // clean at that moment. Re-ensure temporarily so stopped and blocked
        // projects can genuinely retry preservation before their bind mount is
        // removed.
        const prepared = await this.projects.ensure(project, owner);
        workingProject = { ...project, container: { name: prepared.containerName } };
        preparedForPreservation = true;
        this.deps.store.setContainer(project.id, workingProject.container);
        const result = await this.exclusiveCredentialFor(
          project.ownerUserId,
          project.repoHost,
          () => preserveProjectWork({
            engine: this.deps.environments.projectTarget(project.targetId).engine,
            containerName: prepared.containerName,
            containerIdentity: prepared.containerAccess.containerIdentity,
            repoContainerPath: this.projects.checkoutContainerPath(project),
            repoUrl: project.repoUrl!,
            author: this.preservationAuthor(project),
            credential: this.credentialRecordFor(project)?.token || null,
            now: this.now,
            timeoutMs: this.deps.preserveTimeoutMs,
          }),
        );
        if (result.preserved) this.recordPreservation(project.id, result);
      } catch (error) {
        const message = (error as Error).message;
        if (error instanceof ProjectContainerStateUnknownError) {
          this.deps.store.setContainer(project.id, { name: error.containerName });
          this.deps.store.setState(project.id, 'reclaiming', message);
          this.event(this.deps.store.getProject(project.id) as Project, {
            t: 'preserve', state: 'reclaiming', message,
          });
          return { ok: false, reason: 'preserve_failed', detail: message };
        }
        try {
          if (preparedForPreservation && workingProject.container) await this.projects.stop(workingProject);
        } catch (stopError) {
          const detail = `${message}; project container could not be stopped: ${(stopError as Error).message}`;
          this.deps.store.setState(project.id, 'reclaiming', detail);
          this.event(this.deps.store.getProject(project.id) as Project, {
            t: 'preserve', state: 'reclaiming', message: detail,
          });
          return { ok: false, reason: 'preserve_failed', detail };
        }
        this.deps.store.setState(project.id, 'blocked', message);
        this.event(this.deps.store.getProject(project.id) as Project, {
          t: 'preserve', state: 'blocked', message,
        });
        return { ok: false, reason: 'preserve_failed', detail: message };
      }
    }
    if (beforeDestroy) {
      try {
        await beforeDestroy();
      } catch (error) {
        if (priorState !== 'running' && workingProject.container) {
          try {
            await this.projects.stop(workingProject);
          } catch (stopError) {
            const detail = `project sessions could not be retired: ${(error as Error).message}; project container could not be stopped: ${(stopError as Error).message}`;
            this.deps.store.setState(project.id, 'reclaiming', detail);
            this.event(this.deps.store.getProject(project.id) as Project, {
              t: 'error', state: 'reclaiming', message: detail,
            });
            return { ok: false, reason: 'invalid_state', detail };
          }
        }
        this.deps.store.setState(project.id, priorState, priorDetail);
        this.publish(this.deps.store.getProject(project.id) as Project);
        return { ok: false, reason: 'invalid_state', detail: `project sessions could not be retired: ${(error as Error).message}` };
      }
    }
    try {
      if (workingProject.container && await this.projects.status(workingProject) !== null) {
        await this.projects.remove(workingProject);
      }
      await this.wipe(project);
      this.deps.store.setContainer(project.id, null);
      this.deps.store.setState(project.id, 'stopped');
      this.deps.store.touchActivity(project.id, this.now());
      this.publish(this.deps.store.getProject(project.id) as Project);
      return { ok: true };
    } catch (error) {
      // Reclaim has durably committed a true-rebuild cause before touching the
      // runtime/workspace. Any failure remains counted until boot or an
      // explicit retry can prove what survived; never publish reusable state.
      let state: ProjectState = error instanceof ProjectWorkspaceSessionStorageError ? 'blocked' : 'reclaiming';
      let detail = (error as Error).message;
      if (workingProject.container) {
        try {
          if (await this.projects.status(workingProject) === 'running') {
            state = 'reclaiming';
            detail = `${detail}; project container is still running`;
          }
        } catch (statusError) {
          state = 'reclaiming';
          detail = `${detail}; project container state is unknown: ${(statusError as Error).message}`;
        }
      }
      this.deps.store.setState(project.id, state, detail);
      this.event(this.deps.store.getProject(project.id) as Project, {
        t: error instanceof ProjectWorkspaceSessionStorageError ? 'preserve' : 'error', state, message: detail,
      });
      return { ok: false, reason: error instanceof ProjectWorkspaceSessionStorageError ? 'preserve_failed' : 'invalid_state', detail };
    }
  }

  protected async reclaimLocal(
    project: Project,
    discard: boolean,
    beforeDestroy: (() => Promise<void>) | undefined,
    alreadyClaimed: boolean,
    validCheckout: boolean,
  ): Promise<SimpleResult> {
    if (!discard && project.repoUrl && validCheckout) {
      try {
        if (await hostRepositoryHasChanges(this.projects.checkoutPath(project, this.owner(project.ownerUserId)))) {
          const detail = 'Local repository has uncommitted work; commit or push it before removing the workspace, or discard explicitly';
          this.deps.store.setState(project.id, 'blocked', detail);
          this.event(this.deps.store.getProject(project.id) as Project, { t: 'preserve', state: 'blocked', message: detail });
          return { ok: false, reason: 'preserve_failed', detail };
        }
      } catch (error) {
        const detail = `Could not verify local repository state: ${(error as Error).message}`;
        this.deps.store.setState(project.id, 'blocked', detail);
        return { ok: false, reason: 'preserve_failed', detail };
      }
    }
    if (!alreadyClaimed) {
      this.deps.store.setState(project.id, 'reclaiming');
      this.deps.store.setRebuildRequired(project.id, true);
    }
    this.publish(this.deps.store.getProject(project.id) as Project);
    try {
      await beforeDestroy?.();
      await this.wipe(project);
      this.deps.store.setContainer(project.id, null);
      this.deps.store.setState(project.id, 'stopped');
      this.deps.store.touchActivity(project.id, this.now());
      this.publish(this.deps.store.getProject(project.id) as Project);
      return { ok: true };
    } catch (error) {
      const detail = (error as Error).message;
      const state: ProjectState = error instanceof ProjectWorkspaceSessionStorageError ? 'blocked' : 'reclaiming';
      this.deps.store.setState(project.id, state, detail);
      this.event(this.deps.store.getProject(project.id) as Project, {
        t: error instanceof ProjectWorkspaceSessionStorageError ? 'preserve' : 'error', state, message: detail,
      });
      return { ok: false, reason: error instanceof ProjectWorkspaceSessionStorageError ? 'preserve_failed' : 'invalid_state', detail };
    }
  }
}
