/** Project lifecycle policy: placement, preservation, limits and recovery. */

import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EnvironmentManager, MANAGED_LABEL, USER_ID_LABEL } from '../environments/manager.js';
import { EnvironmentOwner, UserEnvironment, WrappedProcessControl } from '../environments/types.js';
import { DeployTargetStore } from '../deploy-targets.js';
import { checkRepositoryAccess, cloneRepository, FetchLike } from './clone.js';
import {
  ProjectContainerAccess,
  ProjectContainerOwnershipError,
  ProjectContainerStateUnknownError,
  ProjectEnvironmentManager,
  ProjectTrackedSpawnDescriptor,
  validateProjectContainerPath,
} from './environment.js';
import { EnvironmentEngine, RunResult, isQuiescentContainerStatus } from '../environments/engine.js';
import { preserveProjectWork } from './preserve.js';
import { BuildEvent, Project, ProjectState, ProjectStore, RunningProjectInfo } from './store.js';
import { PROJECT_LABEL, TARGET_LABEL, projectContainerName, targetLabelValue } from '../environments/naming.js';
import {
  ProjectSessionFileCommand,
  ProjectSessionFileProcess,
  ProjectSessionProcessRecovery,
  UnverifiedProjectFileProcessError,
} from './working-dir.js';

export type {
  ProjectSessionFileCommand,
  ProjectSessionProcessRecovery,
} from './working-dir.js';

export type CreateResult =
  | { ok: true; project: Project; state: 'building' | 'running' }
  | { ok: false; reason: 'validation'; message: string }
  | { ok: false; reason: 'credential_required'; host: string }
  | { ok: false; reason: 'repo_unreachable'; message: string }
  | { ok: false; reason: 'no_target'; message: string }
  | { ok: false; reason: 'shutting_down'; message: string }
  | { ok: false; reason: 'run_limit'; project: Project; running: RunningProjectInfo[] };
export type StartResult =
  | { ok: true; state: 'building' | 'running' }
  | { ok: false; reason: 'not_found' | 'invalid_state' | 'blocked' | 'shutting_down'; detail?: string }
  | { ok: false; reason: 'run_limit'; running: RunningProjectInfo[] };
export type SimpleResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'invalid_state' | 'preserve_failed' | 'shutting_down'; detail?: string };
export type SessionEnvResult =
  | { ok: true; environment: UserEnvironment; workingDir: string; allowedWorkingDirs: string[]; containerAccess: ProjectContainerAccess; leaseId: string }
  | { ok: false; reason: 'not_found' | 'run_limit' | 'failed' | 'building' | 'shutting_down'; running?: RunningProjectInfo[]; detail?: string };
export type UpdateResult =
  | { ok: true; project: Project }
  | { ok: false; reason: 'not_found' | 'invalid_state' | 'preserve_failed' | 'shutting_down'; detail?: string }
  | { ok: false; reason: 'validation'; message: string }
  | { ok: false; reason: 'credential_required'; host: string }
  | { ok: false; reason: 'repo_unreachable'; message: string };

interface RecoveryEntry {
  recovery: ProjectSessionProcessRecovery;
  attempt: Promise<boolean> | null;
  retryTimer?: NodeJS.Timeout;
  lastError?: string;
}

interface IssuedSessionLease {
  ownerUserId: number;
  projectId: string;
  /** Immutable runtime placement captured before this lease can escape. */
  project: Project;
  engine: EnvironmentEngine;
  access: ProjectContainerAccess;
  recoveries: Set<RecoveryEntry>;
  releaseRequested: boolean;
}

/** Project ids are UUIDs; never turn a runtime-controlled label into a path. */
const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface ProjectManagerDeps {
  store: ProjectStore;
  environments: EnvironmentManager;
  deployTargets: DeployTargetStore;
  authorFor(userId: number): { name: string; email: string };
  broadcast(userId: number, payload: unknown): void;
  now?(): Date;
  /** S1 is route-independent; integration supplies the authenticated profile. */
  ownerFor?(userId: number): EnvironmentOwner | null;
  /** Retire every project session (runtime and in-memory) before its FK row goes. */
  deleteProjectSessions?(projectId: string, ownerUserId: number): Promise<void> | void;
  /** Attached clients, commands or agent turns not yet represented by DB active=1. */
  hasLiveProjectWork?(projectId: string): boolean;
  fetch?: FetchLike;
  preflightTimeoutMs?: number;
  cloneTimeoutMs?: number;
  preserveTimeoutMs?: number;
}

export class ProjectManager {
  readonly events = new EventEmitter();
  private readonly projects: ProjectEnvironmentManager;
  private readonly now: () => Date;
  private sweep: NodeJS.Timeout | null = null;
  private readonly lifecycleTails = new Map<string, Promise<void>>();
  private readonly builds = new Map<string, Promise<void>>();
  private readonly creations = new Set<Promise<CreateResult>>();
  private readonly issuedLeases = new Map<string, IssuedSessionLease>();
  private readonly leaseWaiters = new Set<() => void>();
  private sweepTask: Promise<void> | null = null;
  private shuttingDown = false;

  constructor(private readonly deps: ProjectManagerDeps) {
    this.projects = new ProjectEnvironmentManager(deps.environments);
    this.now = deps.now || (() => new Date());
  }

  createAndStart(ownerUserId: number, input: { name: string; repoUrl?: string | null }): Promise<CreateResult> {
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

  private async createAndStartActive(ownerUserId: number, input: { name: string; repoUrl?: string | null }): Promise<CreateResult> {
    const name = input.name.trim();
    if (!name) return { ok: false, reason: 'validation', message: 'Project name is required' };
    const repoUrl = input.repoUrl?.trim() || null;
    let targetId: string | null;
    let tierId: string | null;
    try {
      const target = this.deps.environments.activeProjectTarget();
      targetId = target.key === 'legacy' ? null : target.key;
      tierId = this.deps.environments.intendedTierOnTarget(ownerUserId, targetId)?.id || null;
    } catch (error) {
      return { ok: false, reason: 'no_target', message: (error as Error).message };
    }
    let host: string | null = null;
    if (repoUrl) {
      let access = await this.preflight(repoUrl);
      if (!access.ok && access.reason === 'credential_required' && access.host) {
        const credential = this.deps.store.credentialFor(ownerUserId, access.host);
        if (credential) access = await this.preflight(repoUrl, credential);
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
    const project = this.deps.store.createProject({ ownerUserId, name, repoUrl, repoHost: host, targetId, tierId });
    const started = await this.exclusiveFor(
      [project.id],
      () => this.startLocked(ownerUserId, project.id, {}),
    );
    if (!started.ok && started.reason === 'run_limit') return { ok: false, reason: 'run_limit', project, running: started.running };
    if (!started.ok) return { ok: false, reason: 'repo_unreachable', message: started.detail || 'Project could not start' };
    return { ok: true, project: this.deps.store.getProject(project.id) || project, state: started.state };
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

  private async startLocked(ownerUserId: number, projectId: string, opts: { stopProjectId?: string }): Promise<StartResult> {
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
      projectId, ownerUserId, toState: 'building', fromStates: ['stopped', 'failed', 'unavailable'],
      limit: this.deps.store.runLimitPerUser(), stopProjectId: opts.stopProjectId,
    });
    if (!attempt.ok) {
      if (attempt.reason === 'run_limit') {
        const running = (attempt.running || []).map((candidate) => ({
          ...candidate,
          hasActiveWork: candidate.hasActiveWork || Boolean(this.deps.hasLiveProjectWork?.(candidate.id)),
        }));
        return { ok: false, reason: 'run_limit', running };
      }
      return { ok: false, reason: attempt.reason === 'not_found' ? 'not_found' : 'invalid_state' };
    }
    if (opts.stopProjectId) {
      if (!swapped) {
        this.deps.store.setState(projectId, priorProjectState, priorProjectDetail);
        return { ok: false, reason: 'invalid_state' };
      }
      if (this.deps.hasLiveProjectWork?.(swapped.id)) {
        this.deps.store.setState(swapped.id, priorSwapState || 'running', priorSwapDetail || null);
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

  async stop(ownerUserId: number, projectId: string): Promise<SimpleResult> {
    if (this.shuttingDown) return { ok: false, reason: 'shutting_down', detail: 'Project manager is shutting down' };
    if (this.builds.has(projectId)) {
      return { ok: false, reason: 'invalid_state', detail: 'project build is still in progress' };
    }
    return this.exclusiveFor([projectId], () => this.stopLocked(ownerUserId, projectId));
  }

  private async stopLocked(ownerUserId: number, projectId: string, idleBefore?: Date): Promise<SimpleResult> {
    if (this.deps.hasLiveProjectWork?.(projectId)) {
      return { ok: false, reason: 'invalid_state', detail: 'project has active work' };
    }
    const claim = this.deps.store.tryClaimStop({ projectId, ownerUserId, idleBefore });
    if (!claim.ok) {
      return { ok: false, reason: claim.reason === 'not_found' ? 'not_found' : 'invalid_state', detail: claim.reason };
    }
    const project = claim.project;
    if (this.deps.hasLiveProjectWork?.(projectId)) {
      this.deps.store.setState(project.id, 'running', project.stateDetail);
      this.publish(this.deps.store.getProject(project.id) as Project);
      return { ok: false, reason: 'invalid_state', detail: 'project has active work' };
    }
    try {
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

  async remove(ownerUserId: number, projectId: string, opts: { force?: boolean } = {}): Promise<SimpleResult> {
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

  private async removeLocked(ownerUserId: number, projectId: string, opts: { force?: boolean }): Promise<SimpleResult> {
    const project = this.deps.store.getProjectForUser(projectId, ownerUserId);
    if (!project) return { ok: false, reason: 'not_found' };
    if (project.state === 'building' || this.builds.has(projectId)) {
      return { ok: false, reason: 'invalid_state', detail: 'project lifecycle operation is still in progress' };
    }
    if (project.container?.reconciliationConflict === 'unverified_runtime') {
      return { ok: false, reason: 'invalid_state', detail: 'project runtime ownership is unverified; wait for a complete boot reconciliation' };
    }
    if (project.state === 'blocked' && !opts.force) return { ok: false, reason: 'preserve_failed', detail: project.stateDetail || undefined };
    if (this.hasActiveWork(project.id)) {
      return { ok: false, reason: 'invalid_state', detail: 'project has active work' };
    }
    // Sessions are not detached to the legacy environment.  Retiring them is
    // deliberately an integration hook because S1 does not own their live
    // processes or transcripts; without it a foreign-key failure after the
    // workspace was wiped would be materially worse than refusing deletion.
    if (!this.deps.deleteProjectSessions) {
      return { ok: false, reason: 'invalid_state', detail: 'project sessions cannot be retired safely' };
    }
    const reclaimed = await this.reclaim(project, opts.force === true, async () => {
      await this.deps.deleteProjectSessions?.(project.id, ownerUserId);
    });
    if (!reclaimed.ok) return reclaimed;
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

  private async releaseLocked(ownerUserId: number, projectId: string, opts: { discard?: boolean }): Promise<SimpleResult> {
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

  listForUser(ownerUserId: number): Array<Project & { hasActiveWork: boolean; targetName: string | null }> {
    return this.deps.store.listProjectsForUser(ownerUserId).map((project) => ({
      ...project,
      hasActiveWork: this.hasActiveWork(project.id),
      targetName: this.targetNameFor(project),
    }));
  }

  getForUser(ownerUserId: number, projectId: string): Project | null {
    return this.deps.store.getProjectForUser(projectId, ownerUserId);
  }

  targetNameFor(project: Project): string | null {
    if (!project.targetId) return 'Legacy';
    return this.deps.deployTargets.getTarget(project.targetId)?.name || null;
  }

  /** Starting a failed or unavailable project is its retry operation. */
  retry(ownerUserId: number, projectId: string): Promise<StartResult> {
    return this.start(ownerUserId, projectId);
  }

  async update(
    ownerUserId: number,
    projectId: string,
    input: { name?: string; repoUrl?: string | null },
  ): Promise<UpdateResult> {
    if (this.shuttingDown) return { ok: false, reason: 'shutting_down', detail: 'Project manager is shutting down' };
    return this.exclusiveFor([projectId], () => this.updateLocked(ownerUserId, projectId, input));
  }

  private async updateLocked(
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
      let access = await this.preflight(nextRepo);
      if (!access.ok && access.reason === 'credential_required' && access.host) {
        const credential = this.deps.store.credentialFor(ownerUserId, access.host);
        if (credential) access = await this.preflight(nextRepo, credential);
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
      const preserved = await this.snapshotBeforeRepositoryChange(project);
      if (!preserved.ok) return preserved;
      await this.projects.clearCheckout(project, this.owner(ownerUserId));
    }
    this.deps.store.updateProject(project.id, {
      name,
      ...(input.repoUrl !== undefined ? { repoUrl: nextRepo, repoHost } : {}),
    });
    if (input.repoUrl !== undefined && nextRepo !== project.repoUrl) {
      this.deps.store.setState(project.id, 'stopped', 'Repository updated; ready to start');
    }
    const updated = this.deps.store.getProject(project.id) as Project;
    this.publish(updated);
    return { ok: true, project: updated };
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
        this.deps.store.touchActivity(project.id, this.now());
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
        }
        this.deps.store.releaseSessionLease(projectId, ownerUserId, lease.leaseId);
        return { ok: false, reason: 'failed', detail: (error as Error).message };
      }
    });
  }

  /**
   * Runtime/websocket integration releases this idempotently on detach, failed
   * launch, and process exit. A lease must span the full period during which a
   * connection or runtime could be killed by a project stop.
   */
  releaseSessionLease(ownerUserId: number, projectId: string, leaseId: string): boolean {
    const issued = this.issuedLeases.get(leaseId);
    if (!issued || issued.ownerUserId !== ownerUserId || issued.projectId !== projectId) {
      return this.deps.store.releaseSessionLease(projectId, ownerUserId, leaseId);
    }
    issued.releaseRequested = true;
    if (issued.recoveries.size > 0) {
      for (const entry of issued.recoveries) {
        void this.retryRecovery(leaseId, issued, entry);
      }
      return false;
    }
    return this.finishLeaseRelease(leaseId, issued);
  }

  /**
   * Take synchronous ownership of an unverified helper before its caller can
   * forget the child handle. Ordinary release remains blocked until every
   * registered helper is proved gone; retries are coalesced per helper.
   */
  registerUnverifiedSessionProcess(
    ownerUserId: number,
    projectId: string,
    leaseId: string,
    recovery: ProjectSessionProcessRecovery,
  ): void {
    const issued = this.requireIssuedLease(ownerUserId, projectId, leaseId);
    const entry: RecoveryEntry = { recovery, attempt: null };
    issued.recoveries.add(entry);
    if (recovery.stop) {
      void this.retryRecovery(leaseId, issued, entry).catch((error: unknown) => {
        // retryRecovery records the error and deliberately keeps ownership.
        console.error(`Project ${projectId}: helper stop retry failed:`, error);
      });
    }
  }

  /**
   * Run a bounded command in a lease-owned project container. This is for
   * server-owned file-browser helpers; callers must never pass browser text as
   * `command` or manufacture an engine/container selector themselves.
   */
  async execInSessionContainer(
    ownerUserId: number,
    projectId: string,
    leaseId: string,
    cwd: string,
    command: string,
    commandArgs: string[],
    signal?: AbortSignal,
  ): Promise<RunResult> {
    const issued = this.requireIssuedLease(ownerUserId, projectId, leaseId);
    const project = this.deps.store.getProjectForUser(projectId, ownerUserId);
    if (!project) throw new Error('project was removed while its session lease was active');
    // A rejection here is definitively pre-launch: ownership and an already
    // aborted signal are checked before a tracking wrapper is started.
    const tracked = await this.projects.startTrackedExec(
      project,
      issued.access,
      cwd,
      command,
      commandArgs,
      signal,
      issued.engine,
    );
    const execution = await this.settle(tracked.result);
    const stopped = await this.settle(tracked.processControl.stop());
    if (!stopped.ok) {
      const commandDetail = execution.ok ? '' : `; command failed first: ${this.errorDetail(execution.error)}`;
      throw new UnverifiedProjectFileProcessError(
        `Could not verify that the project container helper stopped: ${this.errorDetail(stopped.error)}${commandDetail}`,
        () => tracked.processControl.stop(),
      );
    }
    if (!execution.ok) throw execution.error;
    return execution.value;
  }

  /**
   * Descriptor for raw upload/download streams. The only executable programs
   * are fixed `dd` and `tee` helpers with argv assembled here; integration can
   * pass their stdin/stdout straight through without exposing engine details.
   */
  async spawnSessionFileCommand(
    ownerUserId: number,
    projectId: string,
    leaseId: string,
    input: ProjectSessionFileCommand,
  ): Promise<ProjectSessionFileProcess> {
    const issued = this.requireIssuedLease(ownerUserId, projectId, leaseId);
    const project = this.deps.store.getProjectForUser(projectId, ownerUserId);
    if (!project) throw new Error('project was removed while its session lease was active');
    const filePath = validateProjectContainerPath(issued.access, input.path);
    if (input.operation === 'read') {
      const offset = input.offset ?? 0;
      const length = input.length;
      if (!Number.isSafeInteger(offset) || offset < 0 || (length !== undefined && (!Number.isSafeInteger(length) || length < 0))) {
        throw new Error('invalid project file range');
      }
      const commandArgs = [
        `if=${filePath}`,
        'iflag=skip_bytes,count_bytes',
        `skip=${offset}`,
        ...(length === undefined ? [] : [`count=${length}`]),
        'status=none',
      ];
      return this.spawnTrackedFileCommand(project, issued.access, issued.engine, 'dd', commandArgs);
    }
    if (input.append && input.exclusive) throw new Error('exclusive project file writes cannot append');
    if (input.exclusive) {
      return this.spawnTrackedFileCommand(project, issued.access, issued.engine, 'dd', [
          `of=${filePath}`,
          'conv=excl',
          'status=none',
        ]);
    }
    return this.spawnTrackedFileCommand(
      project,
      issued.access,
      issued.engine,
      'tee',
      [...(input.append ? ['-a'] : []), '--', filePath],
    );
  }

  private async spawnTrackedFileCommand(
    project: Project,
    access: ProjectContainerAccess,
    engine: EnvironmentEngine,
    command: string,
    commandArgs: string[],
  ): Promise<ProjectSessionFileProcess> {
    // Descriptor validation happens before spawn, so an ownership failure here
    // is known not to have launched a helper and needs no recovery transfer.
    const launch = await this.projects.trackedExecDescriptor(
      project,
      access,
      undefined,
      command,
      commandArgs,
      engine,
    );
    return this.spawnIdentityBound(launch);
  }

  private async spawnIdentityBound(
    launch: ProjectTrackedSpawnDescriptor,
  ): Promise<ProjectSessionFileProcess> {
    const child = spawn(launch.file, launch.args, { stdio: ['pipe', 'pipe', 'pipe'] }) as ProjectSessionFileProcess;
    child.processControl = launch.processControl;
    child.on('error', () => { /* surfaced through exit/close to the stream owner */ });
    try {
      await this.waitForSpawn(child);
    } catch (error) {
      // Node reports a missing/unstartable local engine binary before `spawn`.
      // No remote helper exists, so wait only for the local handle and preserve
      // the original error without falsely retaining the project lease.
      const closed = await this.settle(this.terminateSpawn(child));
      if (!closed.ok) {
        throw new Error(
          `Project container helper could not spawn (${this.errorDetail(error)}) and its local client did not settle: ${this.errorDetail(closed.error)}`,
        );
      }
      throw error;
    }
    try {
      // Docker/Podman argv already targets the immutable ID. Kubernetes exec
      // is name-addressed, so do a second UID check after the client process is
      // started and before its streams escape this manager.
      await launch.verifyIdentity();
      return child;
    } catch (error) {
      const stopped = await this.settleSpawn(child, launch.processControl);
      if (!stopped.ok) {
        throw new UnverifiedProjectFileProcessError(
          `Project container helper failed post-spawn identity validation (${this.errorDetail(error)}) and could not be settled: ${this.errorDetail(stopped.error)}`,
          () => this.retrySettleSpawn(child, launch.processControl),
        );
      }
      throw error;
    }
  }

  private waitForSpawn(child: ProjectSessionFileProcess): Promise<void> {
    if (typeof child.pid === 'number') return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const spawned = (): void => {
        child.off('error', failed);
        resolve();
      };
      const failed = (error: Error): void => {
        child.off('spawn', spawned);
        reject(error);
      };
      child.once('spawn', spawned);
      child.once('error', failed);
    });
  }

  private async settleSpawn(
    child: ProjectSessionFileProcess,
    processControl: WrappedProcessControl,
  ): Promise<{ ok: true } | { ok: false; error: unknown }> {
    const [local, remote] = await Promise.all([
      this.settle(this.terminateSpawn(child)),
      this.settle(processControl.stop()),
    ]);
    if (!remote.ok) return remote;
    if (!local.ok) return local;
    return { ok: true };
  }

  private async retrySettleSpawn(
    child: ProjectSessionFileProcess,
    processControl: WrappedProcessControl,
  ): Promise<void> {
    const result = await this.settleSpawn(child, processControl);
    if (!result.ok) throw result.error;
  }

  private async terminateSpawn(child: ProjectSessionFileProcess): Promise<void> {
    if (this.localSpawnClosed(child)) return;
    await new Promise<void>((resolve, reject) => {
      let escalation: NodeJS.Timeout | undefined;
      const finish = (): void => {
        if (escalation) clearTimeout(escalation);
        clearTimeout(deadline);
        resolve();
      };
      const deadline = setTimeout(() => {
        child.off('close', finish);
        reject(new Error('local project container helper client did not close'));
      }, 12_000);
      deadline.unref?.();
      child.once('close', finish);
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGTERM'); } catch { /* close remains authoritative */ }
        escalation = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            try { child.kill('SIGKILL'); } catch { /* close remains authoritative */ }
          }
        }, 500);
        escalation.unref?.();
      }
    });
  }

  private localSpawnClosed(child: ProjectSessionFileProcess): boolean {
    return (child.exitCode !== null || child.signalCode !== null)
      && child.stdin.destroyed
      && child.stdout.destroyed
      && child.stderr.destroyed;
  }

  private settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
    return promise.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
  }

  private errorDetail(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async projectStorageRootForEngine(engineKey: string): Promise<string | null> {
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

  private orphanWorkspacePath(root: string, projectId: string): string {
    if (!PROJECT_ID.test(projectId)) throw new Error('refusing non-UUID orphan workspace id');
    const parent = path.resolve(root);
    const workspace = path.resolve(parent, projectId);
    if (path.dirname(workspace) !== parent || path.basename(workspace) !== projectId) {
      throw new Error('refusing unsafe orphan workspace removal');
    }
    return workspace;
  }

  private async removeOrphanWorkspace(root: string, projectId: string): Promise<void> {
    await fsp.rm(this.orphanWorkspacePath(root, projectId), { recursive: true, force: true });
  }

  private async removeStaleOrphanWorkspaces(root: string, protectedIds: ReadonlySet<string>): Promise<void> {
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
    const reconciled = new Set<string>();
    // A crash can happen after the engine creates a deterministic runtime but
    // before its name reaches SQLite. Do not rely on the broad label scan to
    // find it: that scan can itself be unavailable. Record only the expected
    // name for interrupted, counted rows, then let the identity-bound pass
    // below prove it absent, owned, foreign, or unreachable.
    for (const project of this.deps.store.listProjectsInState('building', 'running', 'reclaiming')) {
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
          if (project?.container?.reconciliationConflict === 'unverified_runtime') {
            // A conflict remains observed even if this claimant's labels have
            // changed. Its stored name does not grant placement authority.
            reconciled.add(project.id);
            observedConflictClaimants.add(project.id);
            this.deps.store.setState(
              project.id,
              'reclaiming',
              'An unverified project-labelled runtime still exists; manual recovery required',
            );
            this.publish(this.deps.store.getProject(project.id) as Project);
            continue;
          }
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
              reconciled.add(project.id);
              observedConflictClaimants.add(project.id);
              this.deps.store.setContainer(project.id, project.container
                ? { ...project.container, reconciliationConflict: 'unverified_runtime' }
                : { name: described.name, reconciliationConflict: 'unverified_runtime' });
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

        if (project.container.reconciliationConflict === 'unverified_runtime') {
          // This name came from an unadoptable crash-window claimant. Never
          // stop it, and never let a direct name lookup substitute for a
          // complete target scan: another same-workspace runtime could have
          // appeared while the target was unavailable.
          if (described || observedConflictClaimants.has(project.id)) {
            if (scan && PROJECT_ID.test(project.id)) scan.protectedIds.add(project.id);
            this.deps.store.setState(
              project.id,
              'reclaiming',
              'An unverified project-labelled runtime still exists; manual recovery required',
            );
            this.publish(this.deps.store.getProject(project.id) as Project);
            return;
          }
          if (!engineScansComplete || !scan?.complete) {
            this.deps.store.setState(
              project.id,
              'reclaiming',
              'An unverified project-labelled runtime could not be ruled out by a complete target scan',
            );
            this.publish(this.deps.store.getProject(project.id) as Project);
            return;
          }
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
            this.deps.store.setContainer(project.id, null);
          }
        } catch (error) {
          engineScansComplete = false;
          if (scan) scan.complete = false;
          const detail = `Interrupted project container could not be retired safely: ${(error as Error).message}`;
          this.deps.store.setState(project.id, 'reclaiming', detail);
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
    while (this.creations.size || this.builds.size || this.lifecycleTails.size || this.sweepTask) {
      const pending = new Set<Promise<unknown>>([
        ...this.creations.values(),
        ...this.builds.values(),
        ...this.lifecycleTails.values(),
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
    while (this.issuedLeases.size) await this.waitForLeaseChange();
  }

  private async build(ownerUserId: number, projectId: string): Promise<void> {
    const project = this.deps.store.getProjectForUser(projectId, ownerUserId);
    if (!project) return;
    this.event(project, { t: 'step', step: 'container', percent: 15, message: 'Preparing project environment' });
    let workingProject: Project | null = null;
    let failureState: ProjectState = 'failed';
    let failureEvent: 'error' | 'preserve' = 'error';
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
      if (current.repoUrl) {
        if (requiresWorkspaceRebuild && hadValidCheckout) {
          this.event(current, { t: 'preserve', message: 'Preserving work before replacing the project container' });
          try {
            const result = await preserveProjectWork({
              engine: this.deps.environments.projectTarget(current.targetId).engine,
              containerName: prepared.containerName,
              containerIdentity: prepared.containerAccess.containerIdentity,
              repoContainerPath: this.projects.checkoutContainerPath(current),
              repoUrl: current.repoUrl,
              author: this.deps.authorFor(current.ownerUserId),
              credential: this.credentialFor(current),
              now: this.now,
              timeoutMs: this.deps.preserveTimeoutMs,
            });
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
      }
      if (current.repoUrl && (requiresWorkspaceRebuild || !(await this.projects.hasValidCheckout(current, owner)))) {
        let access = await this.preflight(current.repoUrl);
        if (!access.ok && access.reason === 'credential_required') {
          const credential = this.credentialFor(current);
          if (credential) access = await this.preflight(current.repoUrl, credential);
        }
        if (!access.ok) {
          failureState = access.reason === 'repo_gone' ? 'unavailable' : 'failed';
          throw new Error(access.message);
        }
        // `git clone` leaves its destination behind on many failures. Its mere
        // existence is not proof of a checkout; only .git is.
        await this.projects.clearCheckout(current, owner);
        this.event(current, { t: 'step', step: 'clone', percent: 45, message: 'Cloning repository' });
        const credential = this.credentialFor(current);
        await cloneRepository({
          engine: this.deps.environments.projectTarget(current.targetId).engine,
          containerName: prepared.containerName,
          containerIdentity: prepared.containerAccess.containerIdentity,
          repoUrl: current.repoUrl,
          destination: this.projects.checkoutContainerPath(current),
          credential,
          timeoutMs: this.deps.cloneTimeoutMs,
        });
        if (!(await this.projects.hasValidCheckout(current, owner))) {
          throw new Error('Repository clone completed without a valid .git checkout');
        }
      }
      this.deps.store.setState(project.id, 'running');
      this.deps.store.setRebuildRequired(project.id, false);
      this.deps.store.touchActivity(project.id, this.now());
      this.event(this.deps.store.getProject(project.id) as Project, { t: 'state', state: 'running', percent: 100, message: 'Project ready' });
    } catch (error) {
      const message = (error as Error).message;
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

  private async snapshotBeforeRepositoryChange(project: Project): Promise<SimpleResult> {
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
    const priorState = project.state;
    const priorDetail = project.stateDetail;
    let workingProject: Project | null = null;
    this.deps.store.setState(project.id, 'reclaiming', 'Preserving work before repository change');
    this.publish(this.deps.store.getProject(project.id) as Project);
    try {
      const prepared = await this.projects.ensure(project, owner);
      workingProject = { ...project, container: { name: prepared.containerName } };
      this.deps.store.setContainer(project.id, workingProject.container);
      const result = await preserveProjectWork({
        engine: this.deps.environments.projectTarget(project.targetId).engine,
        containerName: prepared.containerName,
        containerIdentity: prepared.containerAccess.containerIdentity,
        repoContainerPath: this.projects.checkoutContainerPath(project),
        repoUrl: project.repoUrl,
        author: this.deps.authorFor(project.ownerUserId),
        credential: this.credentialFor(project),
        now: this.now,
        timeoutMs: this.deps.preserveTimeoutMs,
      });
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

  private async reclaim(
    project: Project,
    discard: boolean,
    beforeDestroy?: () => Promise<void>,
    alreadyClaimed = false,
  ): Promise<SimpleResult> {
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
        const credential = this.credentialFor(project);
        const result = await preserveProjectWork({
          engine: this.deps.environments.projectTarget(project.targetId).engine,
          containerName: prepared.containerName,
          containerIdentity: prepared.containerAccess.containerIdentity,
          repoContainerPath: this.projects.checkoutContainerPath(project),
          repoUrl: project.repoUrl,
          author: this.deps.authorFor(project.ownerUserId), credential, now: this.now,
          timeoutMs: this.deps.preserveTimeoutMs,
        });
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
      let state: ProjectState = 'reclaiming';
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
      this.event(this.deps.store.getProject(project.id) as Project, { t: 'error', state, message: detail });
      return { ok: false, reason: 'invalid_state', detail };
    }
  }

  private async wipe(project: Project): Promise<void> {
    const root = this.projects.worktreePath(project, this.owner(project.ownerUserId));
    // `project.id` is a UUID from our store, nevertheless retain the parent
    // check: no malformed row may turn lifecycle recovery into a broad wipe.
    const parent = path.dirname(root);
    if (path.basename(root) !== project.id || path.resolve(root) === path.resolve(parent)) throw new Error('refusing unsafe project workspace removal');
    await fsp.rm(root, { recursive: true, force: true });
  }

  private async sweepIdle(): Promise<void> {
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

  /** Session integration calls this on runtime activity and on runtime exit. */
  touchActivity(projectId: string, when?: Date): void {
    if (this.shuttingDown) return;
    this.deps.store.touchActivity(projectId, when || this.now());
  }

  /** One deterministic pass, useful at boot and in focused tests. */
  sweepOnce(): Promise<void> {
    if (this.shuttingDown) return Promise.resolve();
    return this.runSweep();
  }

  private runSweep(): Promise<void> {
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

  private requireIssuedLease(ownerUserId: number, projectId: string, leaseId: string): IssuedSessionLease {
    const issued = this.issuedLeases.get(leaseId);
    if (!issued || issued.ownerUserId !== ownerUserId || issued.projectId !== projectId) {
      throw new Error('project session lease is no longer active');
    }
    return issued;
  }

  private retryRecovery(
    leaseId: string,
    issued: IssuedSessionLease,
    entry: RecoveryEntry,
  ): Promise<boolean> {
    if (!issued.recoveries.has(entry)) return Promise.resolve(true);
    if (entry.attempt) return entry.attempt;
    if (!entry.recovery.stop) return Promise.resolve(false);

    const attempt = Promise.resolve()
      .then(() => entry.recovery.stop!())
      .then(() => {
        if (entry.retryTimer) clearTimeout(entry.retryTimer);
        entry.retryTimer = undefined;
        issued.recoveries.delete(entry);
        if (issued.releaseRequested && issued.recoveries.size === 0) {
          this.finishLeaseRelease(leaseId, issued);
        }
        return true;
      })
      .catch((error: unknown) => {
        entry.lastError = error instanceof Error ? error.message : String(error);
        if (issued.releaseRequested && !this.shuttingDown && !entry.retryTimer) {
          entry.retryTimer = setTimeout(() => {
            entry.retryTimer = undefined;
            void this.retryRecovery(leaseId, issued, entry);
          }, 1_000);
          entry.retryTimer.unref();
        }
        return false;
      })
      .finally(() => {
        if (entry.attempt === attempt) entry.attempt = null;
      });
    entry.attempt = attempt;
    return attempt;
  }

  private finishLeaseRelease(leaseId: string, issued: IssuedSessionLease): boolean {
    if (issued.recoveries.size > 0) return false;
    const released = this.deps.store.releaseSessionLease(
      issued.projectId,
      issued.ownerUserId,
      leaseId,
    );
    if (this.issuedLeases.get(leaseId) === issued) {
      this.issuedLeases.delete(leaseId);
      this.resolveLeaseWaiters();
    }
    return released;
  }

  private waitForLeaseChange(): Promise<void> {
    return new Promise((resolve) => this.leaseWaiters.add(resolve));
  }

  private resolveLeaseWaiters(): void {
    for (const resolve of this.leaseWaiters) resolve();
    this.leaseWaiters.clear();
  }

  private credentialFor(project: Project): string | null {
    if (!project.repoHost) return null;
    return this.deps.store.credentialFor(project.ownerUserId, project.repoHost);
  }

  private hasActiveWork(projectId: string): boolean {
    return this.deps.store.projectHasActiveSessions(projectId)
      || Boolean(this.deps.hasLiveProjectWork?.(projectId));
  }

  private preflight(repoUrl: string, credential?: string | null) {
    return checkRepositoryAccess(
      repoUrl,
      this.deps.fetch || fetch,
      credential,
      this.deps.preflightTimeoutMs,
    );
  }

  private owner(userId: number): EnvironmentOwner {
    const owner = this.deps.ownerFor?.(userId);
    if (!owner) throw new Error(`project owner ${userId} is unavailable for environment placement`);
    return owner;
  }

  /** Persist and surface the exact collision-resolved ref a user can recover. */
  private recordPreservation(projectId: string, result: { branch: string; commit: string }): void {
    this.deps.store.recordPreservation(projectId, result.branch, result.commit);
    const project = this.deps.store.getProject(projectId);
    if (!project) return;
    this.event(project, {
      t: 'preserve',
      branch: result.branch,
      commit: result.commit,
      message: `Preserved work on ${result.branch}`,
    });
  }

  private event(project: Project, event: Omit<BuildEvent, 'at'>): void {
    const full = { ...event, at: this.now().toISOString() };
    this.deps.store.appendBuildEvent(project.id, full);
    this.emitSafely('build', { projectId: project.id, event: full });
    this.publish(this.deps.store.getProject(project.id) as Project);
  }

  private publish(project: Project): void {
    this.emitSafely('updated', { project });
    try { this.deps.broadcast(project.ownerUserId, { type: 'project_updated', project }); } catch (error) {
      console.error('Project broadcast failed:', error);
    }
  }

  /** Exposed for focused tests and orderly shutdown; routes do not await it. */
  async waitForBuild(projectId: string): Promise<void> {
    await this.builds.get(projectId);
  }

  private trackBuild(ownerUserId: number, projectId: string): void {
    if (this.builds.has(projectId)) return;
    const task = this.exclusiveFor([projectId], () => this.build(ownerUserId, projectId));
    this.builds.set(projectId, task);
    void task.finally(() => {
      if (this.builds.get(projectId) === task) this.builds.delete(projectId);
    }).catch(() => undefined);
  }

  /** Serialize one project's lifecycle without blocking unrelated projects. */
  private exclusiveFor<T>(projectIds: string[], work: () => Promise<T>): Promise<T> {
    const keys = [...new Set(projectIds)].sort();
    const predecessors = keys.map((key) => this.lifecycleTails.get(key) || Promise.resolve());
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    for (const key of keys) this.lifecycleTails.set(key, tail);
    const run = Promise.all(predecessors).then(work);
    return run.finally(() => {
      release();
      for (const key of keys) {
        if (this.lifecycleTails.get(key) === tail) this.lifecycleTails.delete(key);
      }
    });
  }

  private emitSafely(eventName: string, payload: unknown): void {
    for (const listener of this.events.rawListeners(eventName)) {
      try { listener.call(this.events, payload); } catch (error) {
        console.error(`Project ${eventName} listener failed:`, error);
      }
    }
  }
}
