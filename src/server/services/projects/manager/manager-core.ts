/** Base partial class: shared state, constructor and leaf utilities. */

import { EventEmitter } from 'node:events';
import { EnvironmentOwner } from '../../environments/types.js';
import { checkRepositoryAccess } from '../clone.js';
import { ProjectContainerAccess, ProjectEnvironmentManager } from '../environment.js';
import { EnvironmentEngine } from '../../environments/engine.js';
import { BuildEvent, Project } from '../store.js';
import { ProjectSessionProcessRecovery } from '../working-dir.js';
import { ProjectManagerDeps } from './manager-types.js';

export interface RecoveryEntry {
  recovery: ProjectSessionProcessRecovery;
  attempt: Promise<boolean> | null;
  retryTimer?: NodeJS.Timeout;
  lastError?: string;
}

export interface IssuedSessionLease {
  ownerUserId: number;
  projectId: string;
  /** Immutable runtime placement captured before this lease can escape. */
  project: Project;
  engine: EnvironmentEngine;
  access: ProjectContainerAccess;
  recoveries: Set<RecoveryEntry>;
  releaseRequested: boolean;
}

export abstract class ProjectManagerCore {
  readonly events = new EventEmitter();
  protected readonly projects: ProjectEnvironmentManager;
  protected readonly now: () => Date;
  protected sweep: NodeJS.Timeout | null = null;
  protected readonly lifecycleTails = new Map<string, Promise<void>>();
  /** Serialize every plaintext use and mutation for one owner/forge host. */
  protected readonly credentialTails = new Map<string, Promise<void>>();
  protected readonly builds = new Map<string, Promise<void>>();
  protected readonly creations = new Set<Promise<unknown>>();
  protected readonly inspections = new Map<string, Promise<void>>();
  protected readonly issuedLeases = new Map<string, IssuedSessionLease>();
  protected readonly issuedHostLeases = new Map<string, { ownerUserId: number; projectId: string }>();
  protected readonly leaseWaiters = new Set<() => void>();
  protected sweepTask: Promise<void> | null = null;
  protected shuttingDown = false;

  constructor(protected readonly deps: ProjectManagerDeps) {
    this.projects = new ProjectEnvironmentManager(deps.environments, deps.localWorkspaceRoot);
    this.now = deps.now || (() => new Date());
  }

  protected settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
    return promise.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
  }

  protected errorDetail(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  protected emitSafely(eventName: string, payload: unknown): void {
    for (const listener of this.events.rawListeners(eventName)) {
      try { listener.call(this.events, payload); } catch (error) {
        console.error(`Project ${eventName} listener failed:`, error);
      }
    }
  }

  protected publish(project: Project): void {
    this.emitSafely('updated', { project });
    try { this.deps.broadcast(project.ownerUserId, { type: 'project_updated', project }); } catch (error) {
      console.error('Project broadcast failed:', error);
    }
  }

  protected event(project: Project, event: Omit<BuildEvent, 'at'>): void {
    const full = { ...event, at: this.now().toISOString() };
    this.deps.store.appendBuildEvent(project.id, full);
    this.emitSafely('build', { projectId: project.id, event: full });
    this.publish(this.deps.store.getProject(project.id) as Project);
  }

  protected owner(userId: number): EnvironmentOwner {
    const owner = this.deps.ownerFor?.(userId);
    if (!owner) throw new Error(`project owner ${userId} is unavailable for environment placement`);
    return owner;
  }

  protected preflight(repoUrl: string, credential?: string | null) {
    return checkRepositoryAccess(
      repoUrl,
      this.deps.fetch || fetch,
      credential,
      this.deps.preflightTimeoutMs,
    );
  }

  protected hasActiveWork(projectId: string): boolean {
    return this.deps.store.projectHasActiveSessions(projectId)
      || Boolean(this.deps.hasLiveProjectWork?.(projectId));
  }

  protected trackCreation<T>(task: Promise<T>): void {
    this.creations.add(task);
    void task.finally(() => this.creations.delete(task)).catch(() => undefined);
  }

  /** Serialize one project's lifecycle without blocking unrelated projects. */
  protected exclusiveFor<T>(projectIds: string[], work: () => Promise<T>): Promise<T> {
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

  /** Serialize source mutations and every plaintext use for one owner/host. */
  protected exclusiveCredentialFor<T>(
    ownerUserId: number,
    hostInput: string | null,
    work: () => Promise<T>,
  ): Promise<T> {
    if (!hostInput) return Promise.resolve().then(work);
    const key = `${ownerUserId}\0${hostInput.trim().toLowerCase()}`;
    const predecessor = this.credentialTails.get(key) || Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    this.credentialTails.set(key, tail);
    return predecessor.then(work).finally(() => {
      release();
      if (this.credentialTails.get(key) === tail) this.credentialTails.delete(key);
    });
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

  /**
   * Stable host root for project-specific session artifacts.
   *
   * This deliberately performs no lifecycle admission. Project removal already
   * owns `exclusiveFor(projectId)` when it tears sessions down, so attempting to
   * reacquire that gate here would deadlock the deletion which needs the path.
   */
  projectWorkspaceRoot(ownerUserId: number, projectId: string): string | null {
    const project = this.deps.store.getProjectForUser(projectId, ownerUserId);
    if (!project) return null;
    return this.projects.worktreePath(project, this.owner(ownerUserId));
  }

  /**
   * Pin ordinary session-file cleanup against rebuild/reclaim without starting
   * a stopped project. The project-delete path uses `projectWorkspaceRoot`
   * directly because its caller already holds this same exclusive gate.
   */
  async withProjectWorkspace<T>(
    ownerUserId: number,
    projectId: string,
    operation: (workspaceRoot: string) => Promise<T>,
  ): Promise<T> {
    return this.exclusiveFor([projectId], async () => {
      const workspaceRoot = this.projectWorkspaceRoot(ownerUserId, projectId);
      if (!workspaceRoot) throw new Error('project is unavailable');
      return operation(workspaceRoot);
    });
  }

  targetNameFor(project: Project): string | null {
    if (project.executionKind === 'host') return 'Local machine';
    if (!project.targetId) return 'Legacy';
    return this.deps.deployTargets.getTarget(project.targetId)?.name || null;
  }

  /** Project-management navigation may refresh lifecycle recency; session traffic never does. */
  touchActivity(projectId: string, when?: Date): void {
    if (this.shuttingDown) return;
    this.deps.store.touchActivity(projectId, when || this.now());
  }

  /** Exposed for deterministic integration tests and orderly shutdown. */
  async waitForInspection(projectId: string): Promise<void> {
    await this.inspections.get(projectId);
  }

  /** Exposed for focused tests and orderly shutdown; routes do not await it. */
  async waitForBuild(projectId: string): Promise<void> {
    await this.builds.get(projectId);
  }
}
