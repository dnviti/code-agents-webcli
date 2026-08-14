/** Partial class: lifecycle transitions, session admission, sweep and shutdown. */

import { Project, ProjectState } from './store.js';
import { ProjectContainerStateUnknownError, ProjectWorkspaceSessionStorageError } from './environment.js';
import { CreateResult, SessionEnvResult, SimpleResult, StartResult, UpdateResult } from './manager-types.js';
import { ProjectManagerLeases } from './manager-leases.js';

export abstract class ProjectManagerLifecycle extends ProjectManagerLeases {
  /** Starting a failed or unavailable project is its retry operation. */
  retry(ownerUserId: number, projectId: string): Promise<StartResult> {
    return this.start(ownerUserId, projectId);
  }

  async start(ownerUserId: number, projectId: string, opts: { stopProjectId?: string } = {}): Promise<StartResult> {
    if (this.shuttingDown) return { ok: false, reason: 'shutting_down', detail: 'Project manager is shutting down' };
    if (this.builds.has(projectId)) {
      return { ok: false, reason: 'invalid_state', detail: 'project build is still in progress' };
    }
    return this.exclusiveFor(
      [projectId, ...(opts.stopProjectId ? [opts.stopProjectId] : [])],
      () => this.startLocked(ownerUserId, projectId, opts),
    );
  }

  protected async startLocked(
    ownerUserId: number,
    projectId: string,
    opts: {
      stopProjectId?: string;
      fromStates?: ProjectState[];
      activateComposition?: { revision: string; expectedCurrentRevision: string | null };
    },
  ): Promise<StartResult> {
    const existing = this.deps.store.getProjectForUser(projectId, ownerUserId);
    if (!existing) return { ok: false, reason: 'not_found' };
    if (existing.state === 'blocked') return { ok: false, reason: 'blocked', detail: existing.stateDetail || undefined };
    const swapped = opts.stopProjectId
      ? this.deps.store.getProjectForUser(opts.stopProjectId, ownerUserId)
      : null;
    const priorProjectState = existing.state;
    const priorProjectDetail = existing.stateDetail;
    const priorSwapState = swapped?.state;
    const priorSwapDetail = swapped?.stateDetail;
    if (swapped && this.deps.hasLiveProjectWork?.(swapped.id)) {
      return { ok: false, reason: 'invalid_state', detail: 'swap project has active work' };
    }
    const attempt = this.deps.store.tryStartCounted({
      projectId, ownerUserId, toState: 'building',
      fromStates: opts.fromStates || ['stopped', 'failed', 'unavailable'],
      limit: this.deps.store.runLimitPerUser(), stopProjectId: opts.stopProjectId,
      activateComposition: opts.activateComposition,
    });
    if (!attempt.ok) {
      if (attempt.reason === 'run_limit') {
        const running = (attempt.running || []).map((candidate) => ({
          ...candidate,
          hasActiveWork: candidate.hasActiveWork || Boolean(this.deps.hasLiveProjectWork?.(candidate.id)),
        }));
        return { ok: false, reason: 'run_limit', running };
      }
      if (attempt.reason === 'composition_conflict') {
        return { ok: false, reason: 'conflict', detail: 'The active build recipe changed in another request' };
      }
      return { ok: false, reason: attempt.reason === 'not_found' ? 'not_found' : 'invalid_state' };
    }
    const restoreComposition = (): void => {
      if (!opts.activateComposition) return;
      this.deps.store.restoreCompositionActivation({
        projectId,
        userId: ownerUserId,
        expectedRevision: opts.activateComposition.revision,
        previousRevision: opts.activateComposition.expectedCurrentRevision,
      });
    };
    if (opts.stopProjectId) {
      if (!swapped) {
        restoreComposition();
        this.deps.store.setState(projectId, priorProjectState, priorProjectDetail);
        return { ok: false, reason: 'invalid_state' };
      }
      if (this.deps.hasLiveProjectWork?.(swapped.id)) {
        this.deps.store.setState(swapped.id, priorSwapState || 'running', priorSwapDetail || null);
        restoreComposition();
        this.deps.store.setState(projectId, priorProjectState, priorProjectDetail);
        this.publish(this.deps.store.getProject(swapped.id) as Project);
        this.publish(this.deps.store.getProject(projectId) as Project);
        return { ok: false, reason: 'invalid_state', detail: 'swap project has active work' };
      }
      try {
        await this.projects.stop(swapped);
        this.publish(this.deps.store.getProject(swapped.id) as Project);
      } catch (error) {
        // The database reservation happened atomically, but the engine stop is
        // the physical half of the swap.  If it fails, restore both rows before
        // allowing any replacement build to start or the cap would be fiction.
        this.deps.store.setState(swapped.id, priorSwapState || 'running', priorSwapDetail || null);
        restoreComposition();
        this.deps.store.setState(projectId, priorProjectState, priorProjectDetail);
        this.publish(this.deps.store.getProject(swapped.id) as Project);
        this.publish(this.deps.store.getProject(projectId) as Project);
        return { ok: false, reason: 'invalid_state', detail: `could not stop swap project: ${(error as Error).message}` };
      }
    }
    this.deps.store.resetBuildLog(projectId);
    const building = this.deps.store.getProject(projectId) as Project;
    this.event(building, { t: 'state', state: 'building', percent: 0, message: 'Project build queued' });
    this.trackBuild(ownerUserId, projectId);
    return { ok: true, state: 'building' };
  }

  async stop(
    ownerUserId: number,
    projectId: string,
    opts: { stopActive?: boolean } = {},
  ): Promise<SimpleResult> {
    if (this.shuttingDown) return { ok: false, reason: 'shutting_down', detail: 'Project manager is shutting down' };
    if (this.builds.has(projectId)) {
      return { ok: false, reason: 'invalid_state', detail: 'project build is still in progress' };
    }
    return this.exclusiveFor(
      [projectId],
      () => this.stopLocked(ownerUserId, projectId, undefined, opts.stopActive === true),
    );
  }

  protected async stopLocked(
    ownerUserId: number,
    projectId: string,
    idleBefore?: Date,
    stopActive = false,
  ): Promise<SimpleResult> {
    if (!stopActive && this.deps.hasLiveProjectWork?.(projectId)) {
      return { ok: false, reason: 'invalid_state', detail: 'project has active work' };
    }
    const claim = this.deps.store.tryClaimStop({
      projectId,
      ownerUserId,
      idleBefore,
      allowActiveWork: stopActive,
    });
    if (!claim.ok) {
      return { ok: false, reason: claim.reason === 'not_found' ? 'not_found' : 'invalid_state', detail: claim.reason };
    }
    const project = claim.project;
    if (stopActive && this.hasActiveWork(projectId)) {
      if (!this.deps.suspendProjectSessions) {
        this.deps.store.setState(project.id, 'running', project.stateDetail);
        this.publish(this.deps.store.getProject(project.id) as Project);
        return { ok: false, reason: 'invalid_state', detail: 'active project sessions cannot be suspended safely' };
      }
      try {
        await this.deps.suspendProjectSessions(projectId, ownerUserId);
      } catch (error) {
        this.deps.store.setState(project.id, 'running', project.stateDetail);
        this.publish(this.deps.store.getProject(project.id) as Project);
        return {
          ok: false,
          reason: 'invalid_state',
          detail: `project sessions could not be stopped: ${(error as Error).message}`,
        };
      }
    }
    if (this.hasActiveWork(projectId)) {
      this.deps.store.setState(project.id, 'running', project.stateDetail);
      this.publish(this.deps.store.getProject(project.id) as Project);
      return { ok: false, reason: 'invalid_state', detail: 'project has active work' };
    }
    try {
      if (project.executionKind === 'host') {
        this.deps.store.setState(project.id, 'stopped');
        this.deps.store.touchActivity(project.id, this.now());
        this.publish(this.deps.store.getProject(project.id) as Project);
        return { ok: true };
      }
      const stopped = await this.projects.stop(project);
      const missingDockerRuntime = stopped === 'absent'
        && Boolean(project.container)
        && this.deps.environments.projectTarget(project.targetId).engine.kind !== 'kubernetes';
      if (missingDockerRuntime) this.deps.store.setRebuildRequired(project.id, true);
      this.deps.store.setState(
        project.id,
        'stopped',
        missingDockerRuntime ? 'Recorded project container is missing; rebuild required' : null,
      );
      this.deps.store.touchActivity(project.id, this.now());
      this.publish(this.deps.store.getProject(project.id) as Project);
      return { ok: true };
    } catch (error) {
      this.deps.store.setState(project.id, 'running', project.stateDetail);
      this.publish(this.deps.store.getProject(project.id) as Project);
      return { ok: false, reason: 'invalid_state', detail: (error as Error).message };
    }
  }

  async remove(
    ownerUserId: number,
    projectId: string,
    opts: { force?: boolean; stopActive?: boolean } = {},
  ): Promise<SimpleResult> {
    if (this.shuttingDown) return { ok: false, reason: 'shutting_down', detail: 'Project manager is shutting down' };
    const current = this.deps.store.getProjectForUser(projectId, ownerUserId);
    // A settled `reclaiming` row is a recovery request, not an in-flight
    // operation. `reclaim()` redoes its ownership and liveness checks before
    // touching either the runtime or workspace.
    if (current && (current.state === 'building' || this.builds.has(projectId))) {
      return { ok: false, reason: 'invalid_state', detail: 'project lifecycle operation is still in progress' };
    }
    return this.exclusiveFor([projectId], () => this.removeLocked(ownerUserId, projectId, opts));
  }

  protected async removeLocked(
    ownerUserId: number,
    projectId: string,
    opts: { force?: boolean; stopActive?: boolean },
  ): Promise<SimpleResult> {
    const project = this.deps.store.getProjectForUser(projectId, ownerUserId);
    if (!project) return { ok: false, reason: 'not_found' };
    if (project.state === 'building' || this.builds.has(projectId)) {
      return { ok: false, reason: 'invalid_state', detail: 'project lifecycle operation is still in progress' };
    }
    if (project.container?.reconciliationConflict === 'unverified_runtime') {
      return { ok: false, reason: 'invalid_state', detail: 'project runtime ownership is unverified; wait for a complete boot reconciliation' };
    }
    if (project.state === 'blocked' && !opts.force) return { ok: false, reason: 'preserve_failed', detail: project.stateDetail || undefined };
    if (this.hasActiveWork(project.id) && !opts.stopActive) {
      return { ok: false, reason: 'invalid_state', detail: 'project has active work' };
    }
    // Sessions are not detached to the legacy environment.  Retiring them is
    // deliberately an integration hook because S1 does not own their live
    // processes or transcripts; without it a foreign-key failure after the
    // workspace was wiped would be materially worse than refusing deletion.
    if (!this.deps.deleteProjectSessions) {
      return { ok: false, reason: 'invalid_state', detail: 'project sessions cannot be retired safely' };
    }
    if (this.hasActiveWork(project.id)) {
      if (!this.deps.suspendProjectSessions) {
        return { ok: false, reason: 'invalid_state', detail: 'active project sessions cannot be suspended safely' };
      }
      const priorState = project.state;
      const priorDetail = project.stateDetail;
      this.deps.store.setState(project.id, 'reclaiming', 'Stopping active project sessions before deletion');
      this.publish(this.deps.store.getProject(project.id) as Project);
      try {
        await this.deps.suspendProjectSessions(project.id, ownerUserId);
      } catch (error) {
        this.deps.store.setState(project.id, priorState, priorDetail);
        this.publish(this.deps.store.getProject(project.id) as Project);
        return {
          ok: false,
          reason: 'invalid_state',
          detail: `project sessions could not be stopped: ${(error as Error).message}`,
        };
      }
      if (this.hasActiveWork(project.id)) {
        this.deps.store.setState(project.id, priorState, priorDetail);
        this.publish(this.deps.store.getProject(project.id) as Project);
        return {
          ok: false,
          reason: 'invalid_state',
          detail: 'project still has active work after its sessions were stopped',
        };
      }
    }
    const reclaimed = await this.reclaim(project, opts.force === true, async () => {
      await this.deps.deleteProjectSessions?.(project.id, ownerUserId);
    });
    if (!reclaimed.ok) return reclaimed;
    try {
      await this.deps.beforeWorkspaceDeletion?.(project);
      await this.projects.removeWorkspace(project, this.owner(ownerUserId));
      await this.projects.removeOverlay(project);
    } catch (error) {
      const detail = `project workspace could not be removed: ${(error as Error).message}`;
      this.deps.store.setState(project.id, 'stopped', detail);
      this.publish(this.deps.store.getProject(project.id) as Project);
      return { ok: false, reason: 'invalid_state', detail };
    }
    this.deps.store.deleteProject(project.id);
    try { this.deps.broadcast(ownerUserId, { type: 'project_removed', projectId: project.id }); } catch (error) {
      console.error('Project removal broadcast failed:', error);
    }
    return { ok: true };
  }

  async release(ownerUserId: number, projectId: string, opts: { discard?: boolean } = {}): Promise<SimpleResult> {
    if (this.shuttingDown) return { ok: false, reason: 'shutting_down', detail: 'Project manager is shutting down' };
    if (this.builds.has(projectId)) {
      return { ok: false, reason: 'invalid_state', detail: 'project build is still in progress' };
    }
    return this.exclusiveFor([projectId], () => this.releaseLocked(ownerUserId, projectId, opts));
  }

  protected async releaseLocked(ownerUserId: number, projectId: string, opts: { discard?: boolean }): Promise<SimpleResult> {
    const project = this.deps.store.getProjectForUser(projectId, ownerUserId);
    if (!project) return { ok: false, reason: 'not_found' };
    if (this.builds.has(projectId)) {
      return { ok: false, reason: 'invalid_state', detail: 'project build is still in progress' };
    }
    // `blocked` is a preservation failure after the physical runtime was
    // proven stopped. `reclaiming` is the fail-closed counterpart: teardown or
    // its target-side outcome could not be verified, so it remains counted.
    // Both are terminal recovery states once their exclusive lifecycle action
    // has returned. Calling release through the same per-project lock retries
    // all ownership and liveness checks; it never treats an in-flight reclaim
    // as permission to bypass them.
    if (project.state !== 'blocked' && project.state !== 'reclaiming') {
      return { ok: false, reason: 'invalid_state' };
    }
    if (project.container?.reconciliationConflict === 'unverified_runtime') {
      return { ok: false, reason: 'invalid_state', detail: 'project runtime ownership is unverified; wait for a complete boot reconciliation' };
    }
    if (this.hasActiveWork(project.id)) {
      return { ok: false, reason: 'invalid_state', detail: 'project has active work' };
    }
    return this.reclaim(project, opts.discard === true);
  }

  async update(
    ownerUserId: number,
    projectId: string,
    input: { name?: string; repoUrl?: string | null },
  ): Promise<UpdateResult> {
    if (this.shuttingDown) return { ok: false, reason: 'shutting_down', detail: 'Project manager is shutting down' };
    return this.exclusiveFor([projectId], () => this.updateLocked(ownerUserId, projectId, input));
  }

  protected async updateLocked(
    ownerUserId: number,
    projectId: string,
    input: { name?: string; repoUrl?: string | null },
  ): Promise<UpdateResult> {
    const project = this.deps.store.getProjectForUser(projectId, ownerUserId);
    if (!project) return { ok: false, reason: 'not_found' };
    if (!['stopped', 'failed', 'unavailable'].includes(project.state)) {
      return { ok: false, reason: 'invalid_state', detail: 'stop the project before editing it' };
    }
    const name = input.name === undefined ? project.name : input.name.trim();
    if (!name) return { ok: false, reason: 'validation', message: 'Project name is required' };
    const nextRepo = input.repoUrl === undefined ? project.repoUrl : (input.repoUrl?.trim() || null);
    let repoHost = project.repoHost;
    if (input.repoUrl !== undefined && nextRepo) {
      if (!nextRepo.toLowerCase().startsWith('https://')) {
        return { ok: false, reason: 'validation', message: 'Repository inspection requires HTTPS' };
      }
      let access = await this.preflight(nextRepo);
      if (!access.ok && access.reason === 'credential_required' && access.host) {
        const credentialHost = access.host;
        access = await this.exclusiveCredentialFor(ownerUserId, credentialHost, async () => {
          const credential = this.connectedCredentialFor(ownerUserId, credentialHost);
          if (!credential) return access;
          const checked = await this.preflight(nextRepo, credential.token);
          if (!checked.ok && checked.reason === 'credential_required') {
            this.markCredentialRejected(ownerUserId, credentialHost, credential);
          }
          return checked;
        });
      }
      if (!access.ok) {
        if (access.reason === 'validation') return { ok: false, reason: 'validation', message: access.message };
        if (access.reason === 'credential_required' && access.host) return { ok: false, reason: 'credential_required', host: access.host };
        return { ok: false, reason: 'repo_unreachable', message: access.message };
      }
      repoHost = access.host;
    } else if (input.repoUrl !== undefined) {
      repoHost = null;
    }

    if (input.repoUrl !== undefined && nextRepo !== project.repoUrl && project.repoUrl) {
      try {
        await this.assertProjectSessionStorageAvailable(project);
      } catch (error) {
        return { ok: false, reason: 'preserve_failed', detail: (error as Error).message };
      }
      const preserved = await this.snapshotBeforeRepositoryChange(project);
      if (!preserved.ok) return preserved;
      await this.clearCheckout(project, this.owner(ownerUserId));
    }
    this.deps.store.updateProject(project.id, {
      name,
      ...(input.repoUrl !== undefined ? { repoUrl: nextRepo, repoHost } : {}),
    });
    if (input.repoUrl !== undefined && nextRepo !== project.repoUrl) {
      if (nextRepo) {
        this.deps.store.setState(project.id, 'inspecting', 'Repository updated; refreshing the build recipe');
        this.deps.store.resetBuildLog(project.id);
        this.event(this.deps.store.getProject(project.id) as Project, {
          t: 'state', state: 'inspecting', percent: 0, message: 'Inspecting the updated repository',
        });
        this.trackInspection(ownerUserId, project.id);
      } else {
        const withoutRepository = this.deps.store.getProject(project.id) as Project;
        this.saveDetectedDraft(withoutRepository, null);
        this.deps.store.setState(project.id, 'composition_pending', 'Repository removed; review the build recipe');
      }
    }
    const updated = this.deps.store.getProject(project.id) as Project;
    this.publish(updated);
    return { ok: true, project: updated };
  }

  createAndStart(ownerUserId: number, input: { name: string; repoUrl?: string | null; local?: boolean }): Promise<CreateResult> {
    if (this.shuttingDown) {
      return Promise.resolve({ ok: false, reason: 'shutting_down', message: 'Project manager is shutting down' });
    }
    const task = this.createAndStartActive(ownerUserId, input);
    this.creations.add(task);
    void task.then(
      () => { this.creations.delete(task); },
      () => { this.creations.delete(task); },
    );
    return task;
  }

  protected async createAndStartActive(ownerUserId: number, input: { name: string; repoUrl?: string | null; local?: boolean }): Promise<CreateResult> {
    const name = input.name.trim();
    if (!name) return { ok: false, reason: 'validation', message: 'Project name is required' };
    const repoUrl = input.repoUrl?.trim() || null;
    let targetId: string | null;
    let tierId: string | null;
    const placement = input.local
      ? { kind: 'host' as const }
      : this.deps.environments.newProjectPlacement();
    const executionKind = placement.kind;
    if (placement.kind === 'host') {
      targetId = null;
      tierId = null;
    } else {
      targetId = placement.target.key === 'legacy' ? null : placement.target.key;
      tierId = this.deps.environments.intendedTierOnTarget(ownerUserId, targetId)?.id || null;
    }
    let host: string | null = null;
    if (repoUrl) {
      let access = await this.preflight(repoUrl);
      if (!access.ok && access.reason === 'credential_required' && access.host) {
        const credentialHost = access.host;
        access = await this.exclusiveCredentialFor(ownerUserId, credentialHost, async () => {
          const credential = this.connectedCredentialFor(ownerUserId, credentialHost);
          if (!credential) return access;
          const checked = await this.preflight(repoUrl, credential.token);
          if (!checked.ok && checked.reason === 'credential_required') {
            this.markCredentialRejected(ownerUserId, credentialHost, credential);
          }
          return checked;
        });
      }
      if (!access.ok) {
        if (access.reason === 'credential_required' && access.host) {
          return { ok: false, reason: 'credential_required', host: access.host };
        }
        if (access.reason === 'validation') return { ok: false, reason: 'validation', message: access.message };
        // A gone upstream is durable state only after there is a project row;
        // creation has no useful local workspace to retain, so report it.
        return { ok: false, reason: 'repo_unreachable', message: access.message };
      }
      host = access.host;
    }
    const project = this.deps.store.createProject({ ownerUserId, name, repoUrl, repoHost: host, targetId, executionKind, tierId });
    const started = await this.exclusiveFor(
      [project.id],
      () => this.startLocked(ownerUserId, project.id, {}),
    );
    if (!started.ok && started.reason === 'run_limit') return { ok: false, reason: 'run_limit', project, running: started.running };
    if (!started.ok) return { ok: false, reason: 'repo_unreachable', message: started.detail || 'Project could not start' };
    return { ok: true, project: this.deps.store.getProject(project.id) || project, state: started.state };
  }

  async ensureForSession(ownerUserId: number, projectId: string): Promise<SessionEnvResult> {
    if (this.shuttingDown) return { ok: false, reason: 'shutting_down', detail: 'Project manager is shutting down' };
    return this.exclusiveFor([projectId], async (): Promise<SessionEnvResult> => {
      const project = this.deps.store.getProjectForUser(projectId, ownerUserId);
      if (!project) return { ok: false, reason: 'not_found' };
      if (project.state !== 'running') {
        if (project.state === 'building') return { ok: false, reason: 'building' };
        const started = await this.startLocked(ownerUserId, projectId, {});
        if (!started.ok) {
          if (started.reason === 'run_limit') return { ok: false, reason: 'run_limit', running: started.running };
          return { ok: false, reason: 'failed', detail: started.detail || started.reason };
        }
        return { ok: false, reason: 'building' };
      }
      const lease = this.deps.store.tryAcquireSessionLease(projectId, ownerUserId);
      if (!lease.ok) {
        return { ok: false, reason: lease.reason === 'not_found' ? 'not_found' : 'failed', detail: 'project session admission closed' };
      }
      try {
        if (project.executionKind === 'host') {
          const result = await this.projects.ensureLocal(project, this.owner(ownerUserId));
          await this.restoreWorkspaceSessionStorage(project, this.owner(ownerUserId));
          this.issuedHostLeases.set(lease.leaseId, { ownerUserId, projectId });
          return { ok: true, ...result, leaseId: lease.leaseId };
        }
        const result = await this.projects.ensure(project, this.owner(ownerUserId));
        // A DB-running project whose recorded runtime disappeared is a true
        // rebuild, not a normal stopped resume. Do not attach it just because
        // `ensure` recreated an empty runtime: stop that runtime under a
        // counted row, record the durable cause, then queue the normal build
        // which preserves, wipes, preflights and clones in order.
        if (result.created) {
          const replacement = { ...project, container: { name: result.containerName } };
          this.deps.store.setContainer(project.id, replacement.container);
          try {
            await this.projects.stop(replacement);
          } catch (error) {
            const detail = `missing recorded project runtime was recreated but could not be stopped safely: ${(error as Error).message}`;
            this.deps.store.setState(project.id, 'running', detail);
            this.publish(this.deps.store.getProject(project.id) as Project);
            this.deps.store.releaseSessionLease(projectId, ownerUserId, lease.leaseId);
            return { ok: false, reason: 'failed', detail };
          }
          this.deps.store.setRebuildRequired(project.id, true);
          this.deps.store.setState(project.id, 'stopped', 'Recorded project runtime was missing; rebuilding workspace safely');
          this.publish(this.deps.store.getProject(project.id) as Project);
          this.deps.store.releaseSessionLease(projectId, ownerUserId, lease.leaseId);
          const started = await this.startLocked(ownerUserId, projectId, {});
          if (!started.ok && started.reason === 'run_limit') return { ok: false, reason: 'run_limit', running: started.running };
          return { ok: false, reason: started.ok ? 'building' : 'failed', detail: started.ok ? undefined : started.detail || started.reason };
        }
        await this.restoreWorkspaceSessionStorage(project, this.owner(ownerUserId));
        this.issuedLeases.set(lease.leaseId, {
          ownerUserId,
          projectId,
          project: {
            ...project,
            container: { ...(project.container || {}), name: result.containerName },
          },
          engine: result.engine,
          access: result.containerAccess,
          recoveries: new Set(),
          releaseRequested: false,
        });
        return {
          ok: true,
          environment: result.environment,
          workingDir: result.workingDir,
          allowedWorkingDirs: result.allowedWorkingDirs,
          containerAccess: result.containerAccess,
          leaseId: lease.leaseId,
        };
      } catch (error) {
        if (error instanceof ProjectContainerStateUnknownError) {
          this.deps.store.setContainer(project.id, { name: error.containerName });
          this.deps.store.setState(project.id, 'running', error.message);
          this.publish(this.deps.store.getProject(project.id) as Project);
        } else if (error instanceof ProjectWorkspaceSessionStorageError) {
          this.deps.store.setState(project.id, 'running', error.message);
          this.publish(this.deps.store.getProject(project.id) as Project);
        }
        this.deps.store.releaseSessionLease(projectId, ownerUserId, lease.leaseId);
        return { ok: false, reason: 'failed', detail: (error as Error).message };
      }
    });
  }

  /** One deterministic pass, useful at boot and in focused tests. */
  sweepOnce(): Promise<void> {
    if (this.shuttingDown) return Promise.resolve();
    return this.runSweep();
  }

  protected runSweep(): Promise<void> {
    if (this.sweepTask) return this.sweepTask;
    const task = this.sweepIdle().catch((error) => {
      console.error('Project idle sweep failed:', error);
    });
    this.sweepTask = task;
    void task.finally(() => {
      if (this.sweepTask === task) this.sweepTask = null;
    }).catch(() => undefined);
    return task;
  }

  protected async sweepIdle(): Promise<void> {
    const now = this.now().getTime();
    for (const project of this.deps.store.listProjectsInState('running')) {
      const cutoff = new Date(now - this.deps.store.idleStopMinutes() * 60_000);
      if (new Date(project.lastActivityAt).getTime() <= cutoff.getTime()) {
        await this.exclusiveFor([project.id], () => this.stopLocked(project.ownerUserId, project.id, cutoff));
      }
    }
    for (const project of this.deps.store.listProjectsInState('stopped')) {
      const cutoff = new Date(now - this.deps.store.idleReclaimMinutes() * 60_000);
      if (new Date(project.lastActivityAt).getTime() <= cutoff.getTime()) {
        await this.exclusiveFor([project.id], async () => {
          if (this.deps.hasLiveProjectWork?.(project.id)) return;
          const claim = this.deps.store.tryClaimIdleReclaim({
            projectId: project.id,
            ownerUserId: project.ownerUserId,
            idleBefore: cutoff,
          });
          if (!claim.ok || this.deps.hasLiveProjectWork?.(project.id)) {
            if (claim.ok) this.deps.store.setState(project.id, 'stopped', project.stateDetail);
            return;
          }
          await this.reclaim(claim.project, false, undefined, true);
        });
      }
    }
  }

  startSweep(): void {
    if (!this.sweep && !this.shuttingDown) {
      this.sweep = setInterval(() => { void this.runSweep(); }, 60_000);
      this.sweep.unref();
    }
  }
  stopSweep(): void { if (this.sweep) clearInterval(this.sweep); this.sweep = null; }

  /**
   * Composition calls this before closing SQLite. Clone is bounded, so this
   * waits until every detached build and queued lifecycle finalizer has stopped
   * touching the store rather than leaving promises behind during teardown.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.stopSweep();
    while (this.creations.size || this.inspections.size || this.builds.size
      || this.lifecycleTails.size || this.credentialTails.size || this.sweepTask) {
      const pending = new Set<Promise<unknown>>([
        ...this.creations.values(),
        ...this.inspections.values(),
        ...this.builds.values(),
        ...this.lifecycleTails.values(),
        ...this.credentialTails.values(),
        ...(this.sweepTask ? [this.sweepTask] : []),
      ]);
      await Promise.allSettled(pending);
    }
    // Most helpers settle on their first transferred retry. Anything still
    // uncertain at shutdown is resolved by stopping the exact immutable
    // project container that issued the lease. This is the safe backstop:
    // releasing merely because the local engine client is gone could orphan a
    // command that is still writing the workspace.
    for (const [leaseId, issued] of Array.from(this.issuedLeases)) {
      if (issued.recoveries.size === 0) continue;
      for (const entry of issued.recoveries) {
        if (entry.retryTimer) clearTimeout(entry.retryTimer);
        entry.retryTimer = undefined;
      }
      await Promise.all(
        Array.from(issued.recoveries, (entry) => this.retryRecovery(leaseId, issued, entry)),
      );
      if (issued.recoveries.size === 0) continue;

      await this.projects.stopAccess(issued.project, issued.access, issued.engine);
      const project = this.deps.store.getProjectForUser(issued.projectId, issued.ownerUserId);
      if (project) {
        this.deps.store.setState(
          project.id,
          'stopped',
          'Project runtime stopped during shutdown because helper-process exit could not be verified',
        );
      }
      issued.recoveries.clear();
      issued.releaseRequested = true;
      if (!this.finishLeaseRelease(leaseId, issued)) {
        throw new Error(`Project ${issued.projectId}: could not release recovered session lease`);
      }
    }
    // Routes/runtime finalizers are allowed to release after admission closes.
    // SQLite must remain open until every lease this manager handed out has
    // either completed that finally path or been explicitly retired.
    while (this.issuedLeases.size || this.issuedHostLeases.size) await this.waitForLeaseChange();
  }
}
