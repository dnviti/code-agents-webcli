/** Project lifecycle policy: placement, preservation, limits and recovery. */

import { EventEmitter } from 'node:events';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EnvironmentManager, MANAGED_LABEL, USER_ID_LABEL } from '../environments/manager.js';
import { EnvironmentOwner, UserEnvironment } from '../environments/types.js';
import { DeployTargetStore } from '../deploy-targets.js';
import { checkRepositoryAccess, cloneRepository, FetchLike } from './clone.js';
import {
  ProjectContainerAccess,
  ProjectContainerOwnershipError,
  ProjectContainerStateUnknownError,
  ProjectEnvironmentManager,
  validateProjectContainerPath,
} from './environment.js';
import { RunResult, isQuiescentContainerStatus } from '../environments/engine.js';
import { preserveProjectWork } from './preserve.js';
import { BuildEvent, Project, ProjectState, ProjectStore, RunningProjectInfo } from './store.js';
import { PROJECT_LABEL, TARGET_LABEL, targetLabelValue } from '../environments/naming.js';

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

/** Fixed, binary-safe helpers for an engine-backed project file browser. */
export type ProjectSessionFileCommand =
  | { operation: 'read'; path: string; offset?: number; length?: number }
  | { operation: 'write'; path: string; append?: boolean; exclusive?: boolean };

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
  private readonly issuedLeases = new Map<string, { ownerUserId: number; projectId: string; access: ProjectContainerAccess }>();
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
    if (current && (current.state === 'building' || current.state === 'reclaiming' || this.builds.has(projectId))) {
      return { ok: false, reason: 'invalid_state', detail: 'project lifecycle operation is still in progress' };
    }
    return this.exclusiveFor([projectId], () => this.removeLocked(ownerUserId, projectId, opts));
  }

  private async removeLocked(ownerUserId: number, projectId: string, opts: { force?: boolean }): Promise<SimpleResult> {
    const project = this.deps.store.getProjectForUser(projectId, ownerUserId);
    if (!project) return { ok: false, reason: 'not_found' };
    if (project.state === 'building' || project.state === 'reclaiming' || this.builds.has(projectId)) {
      return { ok: false, reason: 'invalid_state', detail: 'project lifecycle operation is still in progress' };
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
    return this.exclusiveFor([projectId], () => this.releaseLocked(ownerUserId, projectId, opts));
  }

  private async releaseLocked(ownerUserId: number, projectId: string, opts: { discard?: boolean }): Promise<SimpleResult> {
    const project = this.deps.store.getProjectForUser(projectId, ownerUserId);
    if (!project) return { ok: false, reason: 'not_found' };
    if (project.state !== 'blocked') return { ok: false, reason: 'invalid_state' };
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
          access: result.containerAccess,
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
    const released = this.deps.store.releaseSessionLease(projectId, ownerUserId, leaseId);
    if (issued && issued.ownerUserId === ownerUserId && issued.projectId === projectId) {
      this.issuedLeases.delete(leaseId);
      this.resolveLeaseWaiters();
    }
    return released;
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
    return this.projects.exec(project, issued.access, cwd, command, commandArgs, signal);
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
  ): Promise<ChildProcessWithoutNullStreams> {
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
      const launch = await this.projects.execDescriptor(project, issued.access, undefined, 'dd', commandArgs);
      return this.spawnIdentityBound(project, issued.access, launch);
    }
    if (input.append && input.exclusive) throw new Error('exclusive project file writes cannot append');
    if (input.exclusive) {
      const launch = await this.projects.execDescriptor(project, issued.access, undefined, 'dd', [
          `of=${filePath}`,
          'conv=excl',
          'status=none',
        ]);
      return this.spawnIdentityBound(project, issued.access, launch);
    }
    const launch = await this.projects.execDescriptor(project, issued.access, undefined, 'tee', [ ...(input.append ? ['-a'] : []), '--', filePath ]);
    return this.spawnIdentityBound(project, issued.access, launch);
  }

  private async spawnIdentityBound(
    project: Project,
    access: ProjectContainerAccess,
    launch: { file: string; args: string[] },
  ): Promise<ChildProcessWithoutNullStreams> {
    const child = spawn(launch.file, launch.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    child.on('error', () => { /* surfaced through exit/close to the stream owner */ });
    try {
      // Docker/Podman argv already targets the immutable ID. Kubernetes exec
      // is name-addressed, so do a second UID check after the client process is
      // started and before its streams escape this manager.
      await this.projects.execDescriptor(project, access, undefined, 'true', []);
      return child;
    } catch (error) {
      await this.terminateSpawn(child);
      throw error;
    }
  }

  private async terminateSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const wait = (ms: number) => new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off('close', finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      timer.unref();
      child.once('close', finish);
    });
    child.kill('SIGTERM');
    await wait(1_000);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await wait(1_000);
    }
    if (child.exitCode === null && child.signalCode === null) {
      throw new Error('project container helper did not terminate after identity validation failed');
    }
  }

  async reconcileOnBoot(): Promise<void> {
    // Boot integration calls this after old runtimes are gone and before any
    // new project attachment is admitted; process-local leases cannot survive.
    this.deps.store.clearSessionLeases();
    for (const [engineKey, engine] of this.deps.environments.reachableEngines()) {
      let names: string[];
      try { names = await engine.list(PROJECT_LABEL); } catch (error) {
        console.error(`Project reconcile: could not list target '${engineKey}':`, error);
        continue;
      }
      for (const name of names) {
        try {
          const described = await engine.describeStrict(name);
          // The project label is public metadata and can appear on unrelated
          // containers. Only this application's explicitly managed containers
          // are eligible for reconciliation or destructive orphan cleanup.
          if (!described || described.labels[MANAGED_LABEL] !== 'true') continue;
          const id = described.labels[PROJECT_LABEL];
          const project = id ? this.deps.store.getProject(id) : null;
          // A managed container with no project row is an orphan. A container
          // whose label/name collides with an existing row is *not* an orphan:
          // it may be foreign, so reconciliation must retain the row and let
          // the per-project pass fail closed rather than deleting by name.
          const isSafeOrphan = !project
            && Boolean(id)
            && /^\d+$/.test(described.labels[USER_ID_LABEL] || '')
            && described.labels[TARGET_LABEL] === targetLabelValue(engineKey);
          if (isSafeOrphan) {
            await engine.removeIdentity(described);
            if (await engine.describeStrict(name)) {
              throw new Error(`managed orphan '${name}' still exists after removal`);
            }
          }
        } catch (error) {
          console.error(`Project reconcile: could not reconcile '${name}':`, error);
        }
      }
    }

    const reconciled = new Set<string>();
    for (const snapshot of this.deps.store.listProjectsWithContainers()) {
      reconciled.add(snapshot.id);
      await this.exclusiveFor([snapshot.id], async () => {
        const project = this.deps.store.getProject(snapshot.id);
        if (!project?.container) return;
        let described;
        try {
          described = await this.deps.environments
            .projectTarget(project.targetId)
            .engine.describeStrict(project.container.name);
        } catch (error) {
          const detail = `Recorded project container could not be inspected: ${(error as Error).message}`;
          // Its physical state is unknown, so retain a counted state until an
          // operator can reach the target and reconcile it safely.
          this.deps.store.setState(project.id, 'reclaiming', detail);
          this.publish(this.deps.store.getProject(project.id) as Project);
          return;
        }

        if (!described) {
          this.deps.store.setContainer(project.id, null);
          const expectedStoppedPod = project.state === 'stopped'
            && !project.rebuildRequired
            && this.deps.environments.projectTarget(project.targetId).engine.kind === 'kubernetes';
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
          // Do not clear the recorded name or touch its workspace: it may now
          // name a foreign container. Keep the lifecycle counted until an
          // operator resolves the ownership conflict deliberately.
          this.deps.store.setState(project.id, 'reclaiming', 'Recorded container ownership changed; manual recovery required');
          this.publish(this.deps.store.getProject(project.id) as Project);
          return;
        }

        const engine = this.deps.environments.projectTarget(project.targetId).engine;
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
        this.deps.store.setState(project.id, 'building', message);
        this.event(this.deps.store.getProject(project.id) as Project, {
          t: 'error', state: 'building', message,
        });
        return;
      }
      if (workingProject) {
        try {
          await this.projects.stop(workingProject);
        } catch (stopError) {
          const detail = `${message}; project container could not be stopped: ${(stopError as Error).message}`;
          // `building` remains counted. Publishing an uncounted terminal state
          // while the engine still runs would make the run cap fictional.
          this.deps.store.setState(project.id, 'building', detail);
          this.event(this.deps.store.getProject(project.id) as Project, {
            t: 'error', state: 'building', message: detail,
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

  private requireIssuedLease(ownerUserId: number, projectId: string, leaseId: string): { ownerUserId: number; projectId: string; access: ProjectContainerAccess } {
    const issued = this.issuedLeases.get(leaseId);
    if (!issued || issued.ownerUserId !== ownerUserId || issued.projectId !== projectId) {
      throw new Error('project session lease is no longer active');
    }
    return issued;
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
