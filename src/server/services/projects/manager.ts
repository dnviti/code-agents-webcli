/** Project lifecycle policy: placement, preservation, limits and recovery. */

import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EnvironmentManager, MANAGED_LABEL, USER_ID_LABEL } from '../environments/manager.js';
import { EnvironmentOwner, UserEnvironment, WrappedProcessControl } from '../environments/types.js';
import { DeployTargetStore } from '../deploy-targets.js';
import { checkRepositoryAccess, cloneRepository, cloneRepositoryOnHost, CloneSourceChangedError, FetchLike, hostRepositoryHasChanges } from './clone.js';
import {
  ProjectContainerAccess,
  ProjectContainerOwnershipError,
  ProjectContainerStateUnknownError,
  ProjectEnvironmentResult,
  ProjectEnvironmentManager,
  ProjectWorkspaceSessionStorageError,
  ProjectTrackedSpawnDescriptor,
  WorkspaceSessionStorageIdentity,
  FORGE_SCRATCH,
  validateProjectContainerPath,
} from './environment.js';
import { EnvironmentEngine, RunResult, isQuiescentContainerStatus } from '../environments/engine.js';
import { preserveProjectWork } from './preserve.js';
import {
  BuildEvent,
  CompositionInstallation,
  ConnectedCredential,
  Project,
  ProjectComposition,
  ProjectState,
  ProjectStore,
  RunningProjectInfo,
} from './store.js';
import { PROJECT_LABEL, TARGET_LABEL, projectContainerName, targetLabelValue } from '../environments/naming.js';
import {
  AgentRuntimeId,
  COMPOSITION_CATALOG_VERSION,
  RuntimeId,
  getAgentRuntimeCatalogEntry,
  getCompositionCatalog,
  isConservativeRuntimeVersion,
} from '../composition/catalog.js';
import {
  RepositoryInspectionError,
  RepositoryInspectionResult,
  RepositoryInspector,
} from '../composition/repository-inspector.js';
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
  | { ok: false; reason: 'not_found' | 'conflict' | 'invalid_state' | 'blocked' | 'shutting_down'; detail?: string }
  | { ok: false; reason: 'run_limit'; running: RunningProjectInfo[] };
export type SimpleResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'invalid_state' | 'preserve_failed' | 'shutting_down'; detail?: string };
export type SessionEnvResult =
  | { ok: true; environment: UserEnvironment; workingDir: string; allowedWorkingDirs: string[]; containerAccess?: ProjectContainerAccess; leaseId: string }
  | { ok: false; reason: 'not_found' | 'run_limit' | 'failed' | 'building' | 'shutting_down'; running?: RunningProjectInfo[]; detail?: string };
export type UpdateResult =
  | { ok: true; project: Project }
  | { ok: false; reason: 'not_found' | 'invalid_state' | 'preserve_failed' | 'shutting_down'; detail?: string }
  | { ok: false; reason: 'validation'; message: string }
  | { ok: false; reason: 'credential_required'; host: string }
  | { ok: false; reason: 'repo_unreachable'; message: string };

export interface CompositionChoice {
  runtimes: Array<{ runtimeId: RuntimeId; version: string }>;
  agents: Array<{ runtimeId: AgentRuntimeId; version: string }>;
  forgeKind?: 'github' | 'gitlab' | 'gitea' | 'forgejo' | null;
}

export interface CompositionView {
  revision: string | null;
  activeRevision: string | null;
  appliedRevision: string | null;
  detected: RepositoryInspectionResult | null;
  chosen: CompositionChoice | null;
  installations: CompositionInstallation[];
  identity: { name: string; email: string } | null;
  identitySource: 'project' | 'global' | 'provider' | 'incomplete';
  forge: { kind: string; host: string; connected: boolean; validationStatus: string | null } | null;
}

export type CompositionCreateResult =
  | { ok: true; project: Project }
  | { ok: false; reason: 'validation' | 'repo_unreachable' | 'no_target' | 'shutting_down'; message: string }
  | { ok: false; reason: 'credential_required'; host: string };

export type CompositionReadResult =
  | { ok: true; project: Project; composition: CompositionView }
  | { ok: false; reason: 'not_found' };

export type CompositionSaveResult =
  | { ok: true; composition: CompositionView }
  | { ok: false; reason: 'not_found' | 'conflict' | 'invalid_state' | 'validation'; detail?: string };

export type CompositionConfirmResult =
  | { ok: true; state: 'building' | 'running' }
  | { ok: false; reason: 'not_found' | 'conflict' | 'invalid_state' | 'preserve_failed' | 'source_changed' | 'identity_required' | 'blocked' | 'shutting_down'; detail?: string; composition?: CompositionView }
  | { ok: false; reason: 'run_limit'; running: RunningProjectInfo[] };

export type CompositionRetryResult =
  | { ok: true; installations: CompositionInstallation[] }
  | { ok: false; reason: 'not_found' | 'invalid_state' | 'shutting_down'; detail?: string };

export interface CompositionRuntimeContext {
  project: Project;
  composition: ProjectComposition;
  chosen: CompositionChoice;
  containerName: string;
  containerIdentity: string;
  engine: EnvironmentEngine;
  ownerHomeHost: string;
  ownerHomeContainer: string;
  projectOverlayHost: string;
  checkoutContainerPath: string;
  credential: string | null;
  credentialKind: 'token' | 'oauth' | null;
  credentialRevision: number | null;
  identity: { name: string; email: string };
  globalIdentity: { name: string; email: string };
  projectIdentity: { name: string; email: string } | null;
}

export interface CompositionRuntimeAdapter {
  prepare(context: CompositionRuntimeContext): Promise<{ installations: CompositionInstallation[] }>;
  configureGit(context: CompositionRuntimeContext): Promise<void>;
  retryFailed(context: CompositionRuntimeContext): Promise<{ installations: CompositionInstallation[] }>;
  /** Re-materialize only forge auth in an existing verified runtime. */
  refreshForgeCredential?(context: CompositionRuntimeContext): Promise<void>;
}

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
  /** Stop attached runtimes and detach their live claims without deleting history. */
  suspendProjectSessions?(projectId: string, ownerUserId: number): Promise<void> | void;
  /**
   * Flush global session metadata and project artifacts before checkout removal,
   * returning the exact artifact-directory authority when preservation is mandatory.
   */
  beforeWorkspaceReplacement?(
    project: Project,
  ): Promise<boolean | ProjectWorkspaceReplacementAuthority> | boolean | ProjectWorkspaceReplacementAuthority;
  /** Reauthorise project-file stores against the retained artifact directory. */
  afterWorkspaceRestored?(
    project: Project,
    expected?: WorkspaceSessionStorageIdentity,
  ): Promise<WorkspaceSessionStorageIdentity | void> | WorkspaceSessionStorageIdentity | void;
  /** Reverify the restored artifact directory after the durable intent is retired. */
  confirmWorkspaceRestored?(
    project: Project,
    expected: WorkspaceSessionStorageIdentity,
  ): Promise<WorkspaceSessionStorageIdentity> | WorkspaceSessionStorageIdentity;
  /** Keep project-file access unavailable when final authority verification fails. */
  rejectWorkspaceRestore?(project: Project, reason: string): Promise<void> | void;
  /** Release cached artifact handles immediately before explicit project deletion. */
  beforeWorkspaceDeletion?(project: Project): Promise<void> | void;
  /** Refuse destructive replacement while the authoritative archive is unavailable. */
  hasUnavailableProjectSessionStorage?(project: Project): Promise<boolean> | boolean;
  /** Attached clients, commands or agent turns not yet represented by DB active=1. */
  hasLiveProjectWork?(projectId: string): boolean;
  fetch?: FetchLike;
  preflightTimeoutMs?: number;
  cloneTimeoutMs?: number;
  preserveTimeoutMs?: number;
  /** Static inspection is optional only for legacy/unit-test construction. */
  repositoryInspector?: Pick<RepositoryInspector, 'inspect'>;
  /** Runtime application remains behind an injected, identity-bound adapter. */
  compositionRuntime?: CompositionRuntimeAdapter;
  /** Test/embedding override; the server default is the OS user's ~/.cc-web/workspaces. */
  localWorkspaceRoot?: string;
}

export interface ProjectWorkspaceReplacementAuthority {
  readonly required: boolean;
  readonly identity?: WorkspaceSessionStorageIdentity;
}

export class ProjectManager {
  readonly events = new EventEmitter();
  private readonly projects: ProjectEnvironmentManager;
  private readonly now: () => Date;
  private sweep: NodeJS.Timeout | null = null;
  private readonly lifecycleTails = new Map<string, Promise<void>>();
  /** Serialize every plaintext use and mutation for one owner/forge host. */
  private readonly credentialTails = new Map<string, Promise<void>>();
  private readonly builds = new Map<string, Promise<void>>();
  private readonly creations = new Set<Promise<unknown>>();
  private readonly inspections = new Map<string, Promise<void>>();
  private readonly issuedLeases = new Map<string, IssuedSessionLease>();
  private readonly issuedHostLeases = new Map<string, { ownerUserId: number; projectId: string }>();
  private readonly leaseWaiters = new Set<() => void>();
  private sweepTask: Promise<void> | null = null;
  private shuttingDown = false;

  constructor(private readonly deps: ProjectManagerDeps) {
    this.projects = new ProjectEnvironmentManager(deps.environments, deps.localWorkspaceRoot);
    this.now = deps.now || (() => new Date());
  }

  private async projectSessionStorageIsUnavailable(project: Project): Promise<boolean> {
    try {
      return Boolean(await this.deps.hasUnavailableProjectSessionStorage?.(project));
    } catch (error) {
      throw new ProjectWorkspaceSessionStorageError(
        `Project session storage could not be verified: ${(error as Error).message}`,
      );
    }
  }

  private async assertProjectSessionStorageAvailable(project: Project): Promise<void> {
    if (await this.projectSessionStorageIsUnavailable(project)) {
      throw new ProjectWorkspaceSessionStorageError(
        'Project session storage is unavailable; restore the archive and retry before replacing it',
      );
    }
  }

  /**
   * Stage a project for composition review. Repository inspection is detached
   * from the request, but remains tracked for orderly shutdown. Crucially this
   * path does not ask an environment engine to create or start anything.
   */
  createForComposition(
    ownerUserId: number,
    input: { name: string; repoUrl?: string | null; local?: boolean },
  ): Promise<CompositionCreateResult> {
    if (this.shuttingDown) {
      return Promise.resolve({ ok: false, reason: 'shutting_down', message: 'Project manager is shutting down' });
    }
    const task = this.createForCompositionActive(ownerUserId, input);
    this.trackCreation(task);
    return task;
  }

  private async createForCompositionActive(
    ownerUserId: number,
    input: { name: string; repoUrl?: string | null; local?: boolean },
  ): Promise<CompositionCreateResult> {
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
      if (!this.deps.repositoryInspector) {
        return { ok: false, reason: 'validation', message: 'Repository inspection is unavailable' };
      }
      if (!repoUrl.toLowerCase().startsWith('https://')) {
        return { ok: false, reason: 'validation', message: 'Repository inspection requires HTTPS' };
      }
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
        if (access.reason === 'validation') {
          return { ok: false, reason: 'validation', message: access.message };
        }
        return { ok: false, reason: 'repo_unreachable', message: access.message };
      }
      host = access.host;
    }

    const project = this.deps.store.createProject({
      ownerUserId,
      name,
      repoUrl,
      repoHost: host,
      targetId,
      executionKind,
      tierId,
      initialState: repoUrl ? 'inspecting' : 'composition_pending',
    });
    this.deps.store.resetBuildLog(project.id);
    if (repoUrl) {
      this.event(project, {
        t: 'state', state: 'inspecting', percent: 0, message: 'Inspecting repository without executing its code',
      });
      this.trackInspection(ownerUserId, project.id);
    } else {
      const draft = this.saveDetectedDraft(project, null);
      if (!draft) {
        this.deps.store.setState(project.id, 'failed', 'Could not create the initial build recipe');
      } else {
        this.deps.store.setState(project.id, 'composition_pending', 'Choose the tools for this project');
        this.event(this.deps.store.getProject(project.id) as Project, {
          t: 'state', state: 'composition_pending', percent: 100, message: 'Build recipe is ready for review',
        });
      }
    }
    return { ok: true, project: this.deps.store.getProject(project.id) || project };
  }

  getComposition(ownerUserId: number, projectId: string): CompositionReadResult {
    const project = this.deps.store.getProjectForUser(projectId, ownerUserId);
    if (!project) return { ok: false, reason: 'not_found' };
    return { ok: true, project, composition: this.compositionView(project) };
  }

  saveComposition(
    ownerUserId: number,
    projectId: string,
    input: { expectedRevision: string | null; runtimes: Array<{ runtimeId: string; version: string }>; agents?: Array<{ runtimeId: string; version: string }>; forgeKind?: string | null },
  ): Promise<CompositionSaveResult> {
    if (this.shuttingDown) {
      return Promise.resolve({ ok: false, reason: 'invalid_state', detail: 'Project manager is shutting down' });
    }
    return this.exclusiveFor([projectId], async () => {
      const project = this.deps.store.getProjectForUser(projectId, ownerUserId);
      if (!project) return { ok: false, reason: 'not_found' };
      if (['inspecting', 'building', 'reclaiming', 'blocked'].includes(project.state)) {
        return { ok: false, reason: 'invalid_state', detail: 'Project composition cannot be edited in its current state' };
      }
      const previous = this.deps.store.getProjectComposition(project.id, ownerUserId);
      if ((previous?.id || null) !== input.expectedRevision) {
        return { ok: false, reason: 'conflict', detail: 'The build recipe changed in another request' };
      }
      const chosen = validateCompositionChoice(input);
      if (!chosen.ok) return chosen;
      const detected = inspectionFrom(previous?.detected);
      const forgeHost = previous?.forgeHost || project.repoHost;
      if (forgeHost && !chosen.choice.forgeKind && !knownPublicForge(forgeHost)) {
        return { ok: false, reason: 'validation', detail: 'Choose the forge used by this repository host' };
      }
      const knownForge = knownPublicForge(forgeHost);
      if (knownForge && chosen.choice.forgeKind && chosen.choice.forgeKind !== knownForge) {
        return { ok: false, reason: 'validation', detail: `The forge for ${forgeHost} is ${knownForge}` };
      }
      const forgeKind = chosen.choice.forgeKind || knownForge;
      const draft = this.deps.store.saveCompositionDraft({
        projectId: project.id,
        userId: ownerUserId,
        catalogVersion: previous?.catalogVersion || COMPOSITION_CATALOG_VERSION,
        detected: detected || emptyInspection(),
        chosen: { ...chosen.choice, forgeKind },
        sourceOid: previous?.sourceOid,
        sourceRef: previous?.sourceRef,
        forgeKind,
        forgeHost,
        installations: installationIds(chosen.choice, forgeKind).map((itemId) => ({ itemId })),
      });
      if (!draft) return { ok: false, reason: 'not_found' };
      if (project.state === 'composition_pending') {
        this.deps.store.setState(project.id, 'composition_pending', 'Build recipe saved; confirm it to build');
      }
      this.publish(this.deps.store.getProject(project.id) as Project);
      return { ok: true, composition: this.compositionView(this.deps.store.getProject(project.id) as Project) };
    });
  }

  confirmComposition(
    ownerUserId: number,
    projectId: string,
    input: { revision: string; expectedRevision: string | null; acknowledgeRebuild: boolean; stopProjectId?: string },
  ): Promise<CompositionConfirmResult> {
    if (this.shuttingDown) {
      return Promise.resolve({ ok: false, reason: 'shutting_down', detail: 'Project manager is shutting down' });
    }
    return this.exclusiveFor(
      [projectId, ...(input.stopProjectId ? [input.stopProjectId] : [])],
      () => this.confirmCompositionLocked(ownerUserId, projectId, input),
    );
  }

  private async confirmCompositionLocked(
    ownerUserId: number,
    projectId: string,
    input: { revision: string; expectedRevision: string | null; acknowledgeRebuild: boolean; stopProjectId?: string },
  ): Promise<CompositionConfirmResult> {
    let project = this.deps.store.getProjectForUser(projectId, ownerUserId);
    if (!project) return { ok: false, reason: 'not_found' };
    if (['inspecting', 'building', 'reclaiming'].includes(project.state)) {
      return { ok: false, reason: 'invalid_state', detail: 'Project lifecycle work is still in progress' };
    }
    if (project.state === 'blocked') {
      return { ok: false, reason: 'blocked', detail: project.stateDetail || undefined };
    }
    const revision = this.deps.store.getCompositionForUser(input.revision, ownerUserId);
    if (!revision || revision.projectId !== project.id) return { ok: false, reason: 'not_found' };
    if (project.compositionRevision !== input.expectedRevision) {
      return { ok: false, reason: 'conflict', detail: 'The active build recipe changed in another request' };
    }
    const latest = this.deps.store.getProjectComposition(project.id, ownerUserId);
    if (latest?.id !== revision.id) {
      return { ok: false, reason: 'conflict', detail: 'A newer build recipe is available' };
    }
    // Confirmation is idempotent once this exact recipe is already running.
    // In particular, never relabel an existing live runtime as stopped and
    // enqueue a second build around it.
    if (project.state === 'running'
      && project.compositionRevision === revision.id
      && project.appliedCompositionRevision === revision.id) {
      return { ok: true, state: 'running' };
    }
    if (this.hasActiveWork(project.id)) {
      return { ok: false, reason: 'invalid_state', detail: 'Project has active work; close it before rebuilding' };
    }
    const chosen = compositionChoiceFrom(revision.chosen);
    if (!chosen) return { ok: false, reason: 'invalid_state', detail: 'The saved build recipe is invalid' };
    const identity = this.resolvedIdentity(project);
    if (!identity.identity) {
      return { ok: false, reason: 'identity_required', detail: 'Set a valid Git name and email before building' };
    }

    if (project.repoUrl && revision.sourceOid) {
      if (!this.deps.repositoryInspector) {
        return { ok: false, reason: 'invalid_state', detail: 'Repository inspection is unavailable' };
      }
      let current: RepositoryInspectionResult;
      const inspectionProject = project;
      try {
        current = await this.exclusiveCredentialFor(ownerUserId, inspectionProject.repoHost, async () => {
          const credential = this.credentialRecordFor(inspectionProject);
          try {
            return await this.deps.repositoryInspector!.inspect({
              repoUrl: inspectionProject.repoUrl!,
              credential: credential?.token || null,
            });
          } catch (error) {
            if (error instanceof RepositoryInspectionError
              && error.code === 'credential_required'
              && inspectionProject.repoHost) {
              this.markCredentialRejected(ownerUserId, inspectionProject.repoHost, credential);
            }
            throw error;
          }
        });
      } catch (error) {
        return { ok: false, reason: 'invalid_state', detail: safeInspectionMessage(error) };
      }
      if (current.sourceOid !== revision.sourceOid) {
        this.saveDetectedDraft(project, current, chosen);
        if (project.state !== 'running') {
          this.deps.store.setState(project.id, 'composition_pending', 'Repository changed; review the refreshed build recipe');
        } else {
          this.deps.store.setState(project.id, 'running', 'Repository changed; the current container remains active until the refreshed recipe is confirmed');
        }
        project = this.deps.store.getProject(project.id) as Project;
        this.event(project, {
          t: 'state', state: project.state, message: 'Repository changed after inspection; review the refreshed build recipe',
        });
        return {
          ok: false,
          reason: 'source_changed',
          detail: 'Repository changed after inspection; review the refreshed build recipe',
          composition: this.compositionView(project),
        };
      }
    }

    const alreadyBuilt = project.state !== 'composition_pending';
    if (alreadyBuilt && revision.id !== project.appliedCompositionRevision && !input.acknowledgeRebuild) {
      return { ok: false, reason: 'invalid_state', detail: 'Confirm that changing this recipe rebuilds the project container' };
    }
    if (alreadyBuilt && revision.id !== project.appliedCompositionRevision) {
      const reclaimed = await this.reclaim(project, false);
      if (!reclaimed.ok) {
        return { ok: false, reason: reclaimed.reason, detail: reclaimed.detail };
      }
      // Reclaim has already preserved and removed the old workspace. The next
      // build should create directly around that empty root, not repeat it.
      this.deps.store.setRebuildRequired(project.id, false);
      project = this.deps.store.getProject(project.id) as Project;
    }
    const started = await this.startLocked(ownerUserId, project.id, {
      stopProjectId: input.stopProjectId,
      fromStates: project.state === 'composition_pending'
        ? ['composition_pending']
        : ['stopped', 'failed', 'unavailable'],
      activateComposition: {
        revision: revision.id,
        expectedCurrentRevision: input.expectedRevision,
      },
    });
    if (!started.ok) return started;
    return started;
  }

  async reinspectComposition(ownerUserId: number, projectId: string): Promise<CompositionReadResult> {
    if (this.shuttingDown) return { ok: false, reason: 'not_found' };
    const existingTask = this.inspections.get(projectId);
    if (existingTask) return { ok: false, reason: 'not_found' };

    // Admission, the state decision, and the final draft write all stay behind
    // the same lifecycle lock. A confirm/build queued on either side therefore
    // cannot be relabelled by a stale `keepRuntimeActive` snapshot.
    let resolveAdmission!: (admitted: boolean) => void;
    let admissionSettled = false;
    const admission = new Promise<boolean>((resolve) => { resolveAdmission = resolve; });
    const settleAdmission = (admitted: boolean): void => {
      if (admissionSettled) return;
      admissionSettled = true;
      resolveAdmission(admitted);
    };
    const task = this.exclusiveFor([projectId], async (): Promise<void> => {
      try {
        const project = this.deps.store.getProjectForUser(projectId, ownerUserId);
        if (!project?.repoUrl || ['inspecting', 'building', 'reclaiming'].includes(project.state)) return;
        const keepRuntimeActive = project.state === 'running';
        if (keepRuntimeActive) {
          this.event(project, {
            t: 'step', state: 'running', step: 'inspection', percent: 0,
            message: 'Refreshing build recipe while the current container stays active',
          });
        } else {
          this.deps.store.setState(project.id, 'inspecting', 'Refreshing repository inspection');
          this.deps.store.resetBuildLog(project.id);
          this.event(this.deps.store.getProject(project.id) as Project, {
            t: 'state', state: 'inspecting', percent: 0, message: 'Refreshing build recipe',
          });
        }
        settleAdmission(true);
        await this.inspectProject(ownerUserId, project.id, keepRuntimeActive, true);
      } finally {
        settleAdmission(false);
      }
    });
    this.inspections.set(projectId, task);
    void task.finally(() => {
      if (this.inspections.get(projectId) === task) this.inspections.delete(projectId);
    }).catch(() => undefined);
    if (!(await admission)) return { ok: false, reason: 'not_found' };
    const refreshed = this.deps.store.getProjectForUser(projectId, ownerUserId);
    if (!refreshed) return { ok: false, reason: 'not_found' };
    return { ok: true, project: refreshed, composition: this.compositionView(refreshed) };
  }

  retryComposition(ownerUserId: number, projectId: string): Promise<CompositionRetryResult> {
    if (this.shuttingDown) {
      return Promise.resolve({ ok: false, reason: 'shutting_down', detail: 'Project manager is shutting down' });
    }
    return this.exclusiveFor([projectId], async () => {
      const project = this.deps.store.getProjectForUser(projectId, ownerUserId);
      if (!project) return { ok: false, reason: 'not_found' };
      if (project.state !== 'running' || !project.compositionRevision || !this.deps.compositionRuntime) {
        return { ok: false, reason: 'invalid_state', detail: 'Only a running composed project can retry failed tools' };
      }
      const composition = this.deps.store.getProjectComposition(
        project.id,
        ownerUserId,
        project.compositionRevision,
      );
      const chosen = compositionChoiceFrom(composition?.chosen);
      if (!composition || !chosen) {
        return { ok: false, reason: 'invalid_state', detail: 'Active build recipe is unavailable' };
      }
      const failed = this.deps.store.listCompositionInstallations(composition.id, ownerUserId)
        .filter((item) => item.status === 'failed');
      if (!failed.length) return { ok: true, installations: [] };
      let result: { installations: CompositionInstallation[] };
      try {
        const prepared = await this.projects.existing(project, this.owner(ownerUserId));
        if (!prepared) {
          return { ok: false, reason: 'invalid_state', detail: 'The existing project container is unavailable; rebuild it instead' };
        }
        result = await this.exclusiveCredentialFor(
          ownerUserId,
          composition.forgeHost,
          () => this.deps.compositionRuntime!.retryFailed(
            this.runtimeContext(project, composition, chosen, prepared),
          ),
        );
      } catch {
        const detail = 'Failed setup could not be retried in the existing project container';
        this.deps.store.setState(project.id, 'running', detail);
        this.event(this.deps.store.getProject(project.id) as Project, {
          t: 'partial_install', state: 'running', message: detail,
        });
        return { ok: false, reason: 'invalid_state', detail };
      }
      const stillFailed = result.installations.filter((item) => item.status === 'failed');
      if (stillFailed.length) {
        this.event(project, {
          t: 'partial_install',
          state: 'running',
          message: `Some tools still need attention: ${stillFailed.map((item) => item.itemId).join(', ')}`,
        });
      } else {
        this.deps.store.setState(project.id, 'running');
        this.event(project, {
          t: 'progress', state: 'running', percent: 100, message: 'All selected tools are installed',
        });
      }
      return { ok: true, installations: result.installations };
    });
  }

  /**
   * Keep an encrypted credential replacement and every live tmpfs copy in one
   * generation-ordered critical section. Routes supply only the storage and
   * validation mutation; lifecycle ownership remains here.
   */
  synchronizeHostCredentialReplacement<T>(
    ownerUserId: number,
    hostInput: string,
    mutation: () => Promise<T> | T,
  ): Promise<T> {
    if (this.shuttingDown) {
      return Promise.reject(new Error('Project manager is shutting down'));
    }
    const host = hostInput.trim().toLowerCase();
    const projectIds = this.deps.store.listProjectsForUser(ownerUserId)
      .filter((project) => this.projectMayUseForgeHost(project, ownerUserId, host))
      .map((project) => project.id);
    return this.exclusiveFor(projectIds, () =>
      this.exclusiveCredentialFor(ownerUserId, host, async () => {
        const result = await mutation();
        await this.refreshHostCredentialsLocked(ownerUserId, host, true);
        return result;
      }));
  }

  /** Remove live tmpfs copies and their encrypted source as one host operation. */
  disconnectHostCredentials(ownerUserId: number, hostInput: string): Promise<SimpleResult> {
    if (this.shuttingDown) {
      return Promise.resolve({ ok: false, reason: 'shutting_down', detail: 'Project manager is shutting down' });
    }
    const host = hostInput.trim().toLowerCase();
    const projectIds = this.deps.store.listProjectsForUser(ownerUserId)
      .filter((project) => this.projectMayUseForgeHost(project, ownerUserId, host))
      .map((project) => project.id);
    return this.exclusiveFor(projectIds, () =>
      this.exclusiveCredentialFor(ownerUserId, host, async (): Promise<SimpleResult> => {
        if (!this.deps.store.listConnectedHosts(ownerUserId).some((entry) => entry.host === host)) {
          return { ok: false, reason: 'not_found' };
        }
        try {
          await this.refreshHostCredentialsLocked(ownerUserId, host, false);
        } catch {
          return {
            ok: false,
            reason: 'invalid_state',
            detail: 'Could not clear this live forge login; stop affected projects and try again',
          };
        }
        return this.deps.store.deleteConnectedHost(ownerUserId, host)
          ? { ok: true }
          : { ok: false, reason: 'not_found' };
      }));
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

  private async createAndStartActive(ownerUserId: number, input: { name: string; repoUrl?: string | null; local?: boolean }): Promise<CreateResult> {
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

  private async startLocked(
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

  private async stopLocked(
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

  private async removeLocked(
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

  /**
   * Runtime/websocket integration releases this idempotently on detach, failed
   * launch, and process exit. A lease must span the full period during which a
   * connection or runtime could be killed by a project stop.
   */
  releaseSessionLease(ownerUserId: number, projectId: string, leaseId: string): boolean {
    const host = this.issuedHostLeases.get(leaseId);
    if (host) {
      if (host.ownerUserId !== ownerUserId || host.projectId !== projectId) return false;
      const released = this.deps.store.releaseSessionLease(projectId, ownerUserId, leaseId);
      this.issuedHostLeases.delete(leaseId);
      this.resolveLeaseWaiters();
      return released;
    }
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

  private async build(ownerUserId: number, projectId: string): Promise<void> {
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
  private async buildLocal(project: Project): Promise<void> {
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

  private async reclaim(
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

  private async reclaimLocal(
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

  private async workspaceReplacementAuthority(
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

  private async clearCheckout(project: Project, owner: EnvironmentOwner): Promise<void> {
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

  private async restoreWorkspaceSessionStorage(
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

  private async wipe(project: Project): Promise<void> {
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

  /** Project-management navigation may refresh lifecycle recency; session traffic never does. */
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

  private credentialRecordFor(project: Project): ConnectedCredential | null {
    if (!project.repoHost) return null;
    return this.connectedCredentialFor(project.ownerUserId, project.repoHost);
  }

  /**
   * Compatibility seam for pre-composition ProjectStore adapters. Production
   * always supplies the generation-aware accessor; older integrations expose
   * only the token accessor and therefore cannot participate in validation CAS.
   */
  private connectedCredentialFor(ownerUserId: number, host: string): ConnectedCredential | null {
    const store = this.deps.store as Partial<ProjectStore>;
    if (typeof store.credentialRecordFor === 'function') {
      return store.credentialRecordFor.call(this.deps.store, ownerUserId, host);
    }
    if (typeof store.credentialFor !== 'function') return null;
    const token = store.credentialFor.call(this.deps.store, ownerUserId, host);
    return token ? { token, kind: 'token', revision: 0 } : null;
  }

  private credentialFor(project: Project): string | null {
    return this.credentialRecordFor(project)?.token || null;
  }

  private projectMayUseForgeHost(project: Project, ownerUserId: number, host: string): boolean {
    if (project.repoHost === host) return true;
    const revisionIds = new Set([
      project.compositionRevision,
      project.appliedCompositionRevision,
      this.deps.store.getProjectComposition(project.id, ownerUserId)?.id || null,
    ].filter((revision): revision is string => Boolean(revision)));
    for (const revisionId of revisionIds) {
      const composition = this.deps.store.getProjectComposition(project.id, ownerUserId, revisionId);
      if (composition?.forgeHost === host) return true;
    }
    return false;
  }

  private markCredentialRejected(
    ownerUserId: number,
    host: string,
    credential: ConnectedCredential | null,
  ): void {
    if (!credential) return;
    const setValidation = (this.deps.store as Partial<ProjectStore>).setConnectedHostValidation;
    if (typeof setValidation !== 'function') return;
    setValidation.call(this.deps.store, {
      userId: ownerUserId,
      host,
      kind: credential.kind,
      expectedCredentialRevision: credential.revision,
      status: 'invalid',
      errorCode: 'credential_rejected',
      errorMessage: 'The repository host rejected this credential; replace it to continue',
    });
  }

  private async refreshHostCredentialsLocked(
    ownerUserId: number,
    host: string,
    rematerialize: boolean,
  ): Promise<void> {
    // The owner/host credential lock is the generation barrier. A project that
    // has not passed its credential section cannot materialize the old token;
    // one that passed it before this replacement may still be `building` and
    // must be included even if it was created after the lifecycle snapshot.
    // Exact-identity inspection/scrubbing fails closed if that runtime changes.
    const affected = this.deps.store.listProjectsForUser(ownerUserId)
      .filter((project) => this.projectMayUseForgeHost(project, ownerUserId, host));
    const running: Array<{ project: Project; prepared: ProjectEnvironmentResult }> = [];
    let scrubFailed = false;

    for (const project of affected) {
      try {
        // Only a physically executing runtime can consume its memory-backed
        // login. Stopped runtimes are scrubbed before any later authentication.
        if (await this.projects.status(project) !== 'running') continue;
        const prepared = await this.projects.existing(project, this.owner(ownerUserId));
        if (!prepared) throw new Error('running project ownership could not be verified');
        running.push({ project, prepared });
      } catch {
        // Keep inspecting the other lifecycle-locked projects. One unavailable
        // engine must not leave an otherwise reachable old token untouched.
        scrubFailed = true;
      }
    }

    // Scrub every verified runtime before attempting any login. If one scrub
    // fails, still try all the others, then fail closed without materializing a
    // mix of old and new credentials across the owner.
    for (const { prepared } of running) {
      try {
        await this.scrubForgeCredential(prepared);
      } catch {
        scrubFailed = true;
      }
    }
    if (scrubFailed) throw new Error('Could not clear every live forge credential');
    if (!rematerialize || !this.deps.compositionRuntime?.refreshForgeCredential) return;

    let refreshFailed = false;
    for (const { project, prepared } of running) {
      try {
        const revisionIds = [project.compositionRevision, project.appliedCompositionRevision]
          .filter((revision, index, all): revision is string => Boolean(revision) && all.indexOf(revision) === index);
        for (const revisionId of revisionIds) {
          const composition = this.deps.store.getProjectComposition(project.id, ownerUserId, revisionId);
          const chosen = compositionChoiceFrom(composition?.chosen);
          if (!composition || composition.forgeHost !== host || !chosen?.forgeKind) continue;
          await this.deps.compositionRuntime.refreshForgeCredential(
            this.runtimeContext(project, composition, chosen, prepared),
          );
          break;
        }
      } catch {
        // Old material is already gone everywhere. Continue so a failure in one
        // project does not unnecessarily leave another without the new login.
        refreshFailed = true;
      }
    }
    if (refreshFailed) throw new Error('Could not refresh every live forge credential');
  }

  private async scrubForgeCredential(prepared: ProjectEnvironmentResult): Promise<void> {
    await prepared.engine.exec(
      {
        name: prepared.containerName,
        identity: prepared.containerAccess.containerIdentity,
      },
      'rm',
      [
        '-rf', '--',
        `${FORGE_SCRATCH}/home`,
        `${FORGE_SCRATCH}/xdg`,
        `${FORGE_SCRATCH}/gh`,
        `${FORGE_SCRATCH}/glab`,
        `${FORGE_SCRATCH}/tea`,
      ],
    );
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

  private trackCreation<T>(task: Promise<T>): void {
    this.creations.add(task);
    void task.finally(() => this.creations.delete(task)).catch(() => undefined);
  }

  private trackInspection(
    ownerUserId: number,
    projectId: string,
    keepRuntimeActive = false,
    preserveChoice = false,
  ): void {
    if (this.inspections.has(projectId)) return;
    const task = this.exclusiveFor(
      [projectId],
      () => this.inspectProject(ownerUserId, projectId, keepRuntimeActive, preserveChoice),
    );
    this.inspections.set(projectId, task);
    void task.finally(() => {
      if (this.inspections.get(projectId) === task) this.inspections.delete(projectId);
    }).catch(() => undefined);
  }

  /** Exposed for deterministic integration tests and orderly shutdown. */
  async waitForInspection(projectId: string): Promise<void> {
    await this.inspections.get(projectId);
  }

  private async inspectProject(
    ownerUserId: number,
    projectId: string,
    keepRuntimeActive = false,
    preserveChoice = false,
  ): Promise<void> {
    const project = this.deps.store.getProjectForUser(projectId, ownerUserId);
    if (!project || !project.repoUrl) return;
    if (!this.deps.repositoryInspector) {
      this.deps.store.setState(project.id, 'failed', 'Repository inspection is unavailable');
      this.event(this.deps.store.getProject(project.id) as Project, {
        t: 'error', state: 'failed', message: 'Repository inspection is unavailable',
      });
      return;
    }
    try {
      const result = await this.exclusiveCredentialFor(ownerUserId, project.repoHost, async () => {
        const credential = this.credentialRecordFor(project);
        try {
          return await this.deps.repositoryInspector!.inspect({
            repoUrl: project.repoUrl!,
            credential: credential?.token || null,
          });
        } catch (error) {
          if (error instanceof RepositoryInspectionError
            && error.code === 'credential_required'
            && project.repoHost) {
            this.markCredentialRejected(ownerUserId, project.repoHost, credential);
          }
          throw error;
        }
      });
      const previousChoice = preserveChoice
        ? compositionChoiceFrom(
            this.deps.store.getProjectComposition(project.id, ownerUserId)?.chosen,
          )
        : null;
      if (!this.saveDetectedDraft(project, result, previousChoice || undefined)) {
        throw new Error('Could not save the inspected build recipe');
      }
      const nextState: ProjectState = keepRuntimeActive ? 'running' : 'composition_pending';
      const detail = keepRuntimeActive
        ? 'A refreshed build recipe is ready; the current container remains active until you confirm it'
        : 'Review the detected build recipe';
      this.deps.store.setState(project.id, nextState, detail);
      this.event(this.deps.store.getProject(project.id) as Project, {
        t: 'state', state: nextState, percent: 100,
        message: keepRuntimeActive
          ? 'Refreshed build recipe is ready; the current container is unchanged'
          : 'Build recipe is ready for review',
      });
    } catch (error) {
      const message = safeInspectionMessage(error);
      const state: ProjectState = keepRuntimeActive
        ? 'running'
        : error instanceof RepositoryInspectionError
          && ['repository_unavailable', 'timed_out'].includes(error.code)
          ? 'unavailable'
          : 'failed';
      this.deps.store.setState(project.id, state, message);
      this.event(this.deps.store.getProject(project.id) as Project, {
        t: 'error', state, message,
      });
    }
  }

  private saveDetectedDraft(
    project: Project,
    detected: RepositoryInspectionResult | null,
    rememberedChoice?: CompositionChoice,
  ): ProjectComposition | null {
    const runtimes = rememberedChoice?.runtimes || detected?.detectedRuntimes.map((runtime) => ({
      runtimeId: runtime.runtimeId,
      version: runtime.selectedVersion,
    })) || [];
    const forgeKind = rememberedChoice?.forgeKind
      || detected?.forgeHint?.kind
      || knownPublicForge(project.repoHost);
    const choice: CompositionChoice = {
      runtimes: runtimes.map((runtime) => ({ ...runtime })),
      agents: rememberedChoice?.agents?.map((agent) => ({ ...agent })) || [],
      forgeKind,
    };
    return this.deps.store.saveCompositionDraft({
      projectId: project.id,
      userId: project.ownerUserId,
      catalogVersion: detected?.catalogVersion || COMPOSITION_CATALOG_VERSION,
      detected: detected || emptyInspection(),
      chosen: choice,
      sourceOid: detected?.sourceOid,
      sourceRef: detected?.sourceRef,
      forgeKind,
      forgeHost: detected?.forgeHint?.host || project.repoHost,
      installations: installationIds(choice, forgeKind).map((itemId) => ({ itemId })),
    });
  }

  private resolvedIdentity(project: Project): ReturnType<ProjectStore['resolveGitIdentity']> {
    let providerDefault: { name: string; email: string } | null = null;
    try { providerDefault = this.deps.authorFor(project.ownerUserId); } catch { /* Deleted owners remain incomplete. */ }
    const resolveIdentity = (this.deps.store as Partial<ProjectStore>).resolveGitIdentity;
    if (typeof resolveIdentity === 'function') {
      return resolveIdentity.call(this.deps.store, {
        userId: project.ownerUserId,
        projectId: project.id,
        providerDefault,
      });
    }
    return providerDefault
      ? { identity: { ...providerDefault, source: 'provider' }, source: 'provider' }
      : { identity: null, source: 'incomplete' };
  }

  /** The same project-aware resolver feeds both runtime git and preservation. */
  private preservationAuthor(project: Project): { name: string; email: string } {
    const resolved = this.resolvedIdentity(project);
    if (!resolved.identity) throw new Error('Git identity is incomplete');
    return { name: resolved.identity.name, email: resolved.identity.email };
  }

  private runtimeContext(
    project: Project,
    composition: ProjectComposition,
    chosen: CompositionChoice,
    prepared: ProjectEnvironmentResult,
  ): CompositionRuntimeContext {
    let providerDefault: { name: string; email: string } | null = null;
    try { providerDefault = this.deps.authorFor(project.ownerUserId); } catch { /* Reported as incomplete below. */ }
    const global = this.deps.store.resolveGitIdentity({
      userId: project.ownerUserId,
      providerDefault,
    });
    const resolved = this.deps.store.resolveGitIdentity({
      userId: project.ownerUserId,
      projectId: project.id,
      providerDefault,
    });
    if (!global.identity || !resolved.identity) throw new Error('Git identity is incomplete');
    const projectIdentity = this.deps.store.getGitIdentity(project.ownerUserId, project.id);
    const connectedCredential = composition.forgeHost
      ? this.connectedCredentialFor(project.ownerUserId, composition.forgeHost)
      : null;
    return {
      project,
      composition,
      chosen,
      containerName: prepared.containerName,
      containerIdentity: prepared.containerAccess.containerIdentity,
      engine: prepared.engine,
      ownerHomeHost: prepared.environment.homeDir,
      ownerHomeContainer: prepared.environment.containerHome,
      projectOverlayHost: this.projects.overlayPath(project),
      checkoutContainerPath: this.projects.checkoutContainerPath(project),
      credential: connectedCredential?.token || null,
      credentialKind: connectedCredential?.kind || null,
      credentialRevision: connectedCredential?.revision ?? null,
      identity: { name: resolved.identity.name, email: resolved.identity.email },
      globalIdentity: { name: global.identity.name, email: global.identity.email },
      projectIdentity: projectIdentity
        ? { name: projectIdentity.name, email: projectIdentity.email }
        : null,
    };
  }

  private compositionView(project: Project): CompositionView {
    const latest = this.deps.store.getProjectComposition(project.id, project.ownerUserId);
    const resolved = this.resolvedIdentity(project);
    const chosen = compositionChoiceFrom(latest?.chosen);
    const host = latest?.forgeHost || project.repoHost;
    const connectedHost = host
      ? this.deps.store.listConnectedHosts(project.ownerUserId).find((candidate) => candidate.host === host)
      : null;
    return {
      revision: latest?.id || null,
      activeRevision: project.compositionRevision,
      appliedRevision: project.appliedCompositionRevision,
      detected: inspectionFrom(latest?.detected),
      chosen,
      installations: latest
        ? this.deps.store.listCompositionInstallations(latest.id, project.ownerUserId)
        : [],
      identity: resolved.identity
        ? { name: resolved.identity.name, email: resolved.identity.email }
        : null,
      identitySource: resolved.source,
      forge: host && latest?.forgeKind
        ? {
            kind: latest.forgeKind,
            host,
            connected: Boolean(connectedHost)
              && connectedHost?.validationStatus !== 'invalid'
              && (!connectedHost?.expiresAt
                || (Number.isFinite(Date.parse(connectedHost.expiresAt))
                  && Date.parse(connectedHost.expiresAt) > this.now().getTime())),
            validationStatus: connectedHost?.validationStatus || null,
          }
        : null,
    };
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

  /** Serialize source mutations and every plaintext use for one owner/host. */
  private exclusiveCredentialFor<T>(
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

  private emitSafely(eventName: string, payload: unknown): void {
    for (const listener of this.events.rawListeners(eventName)) {
      try { listener.call(this.events, payload); } catch (error) {
        console.error(`Project ${eventName} listener failed:`, error);
      }
    }
  }
}

type ChoiceValidation =
  | { ok: true; choice: CompositionChoice }
  | { ok: false; reason: 'validation'; detail: string };

function validateCompositionChoice(input: {
  runtimes: Array<{ runtimeId: string; version: string }>;
  agents?: Array<{ runtimeId: string; version: string }>;
  forgeKind?: string | null;
}): ChoiceValidation {
  if (!Array.isArray(input.runtimes) || input.runtimes.length > getCompositionCatalog().runtimes.length) {
    return { ok: false, reason: 'validation', detail: 'Runtime selection is invalid' };
  }
  const supported = new Set<RuntimeId>(getCompositionCatalog().runtimes.map((entry) => entry.id));
  const seen = new Set<RuntimeId>();
  const runtimes: CompositionChoice['runtimes'] = [];
  for (const candidate of input.runtimes) {
    if (!candidate || !supported.has(candidate.runtimeId as RuntimeId)) {
      return { ok: false, reason: 'validation', detail: 'Runtime selection contains an unsupported entry' };
    }
    const runtimeId = candidate.runtimeId as RuntimeId;
    if (seen.has(runtimeId) || typeof candidate.version !== 'string'
      || !isConservativeRuntimeVersion(candidate.version)) {
      return { ok: false, reason: 'validation', detail: 'Runtime versions must be unique conservative numeric literals' };
    }
    seen.add(runtimeId);
    runtimes.push({ runtimeId, version: candidate.version });
  }
  const inputAgents = input.agents || [];
  const agentCatalog = getCompositionCatalog().agents;
  if (!Array.isArray(inputAgents) || inputAgents.length > agentCatalog.length) {
    return { ok: false, reason: 'validation', detail: 'Agent runtime selection is invalid' };
  }
  const supportedAgents = new Set<AgentRuntimeId>(agentCatalog.map((entry) => entry.id));
  const seenAgents = new Set<AgentRuntimeId>();
  const agents: CompositionChoice['agents'] = [];
  for (const candidate of inputAgents) {
    if (!candidate || !supportedAgents.has(candidate.runtimeId as AgentRuntimeId)) {
      return { ok: false, reason: 'validation', detail: 'Agent runtime selection contains an unsupported entry' };
    }
    const runtimeId = candidate.runtimeId as AgentRuntimeId;
    const definition = getAgentRuntimeCatalogEntry(runtimeId);
    if (seenAgents.has(runtimeId) || candidate.version !== definition.defaultVersion) {
      return { ok: false, reason: 'validation', detail: 'Agent runtime versions must match the catalog pin' };
    }
    seenAgents.add(runtimeId);
    agents.push({ runtimeId, version: candidate.version });
  }
  const forgeKind = input.forgeKind ?? null;
  if (forgeKind !== null && !['github', 'gitlab', 'gitea', 'forgejo'].includes(forgeKind)) {
    return { ok: false, reason: 'validation', detail: 'Forge selection is invalid' };
  }
  return {
    ok: true,
    choice: {
      runtimes,
      agents,
      forgeKind: forgeKind as CompositionChoice['forgeKind'],
    },
  };
}

function compositionChoiceFrom(value: unknown): CompositionChoice | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { runtimes?: unknown; agents?: unknown; forgeKind?: unknown };
  if (!Array.isArray(raw.runtimes)) return null;
  const result = validateCompositionChoice({
    runtimes: raw.runtimes as Array<{ runtimeId: string; version: string }>,
    agents: Array.isArray(raw.agents)
      ? raw.agents as Array<{ runtimeId: string; version: string }>
      : [],
    forgeKind: typeof raw.forgeKind === 'string' || raw.forgeKind === null
      ? raw.forgeKind
      : undefined,
  });
  return result.ok ? result.choice : null;
}

function inspectionFrom(value: unknown): RepositoryInspectionResult | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<RepositoryInspectionResult>;
  if (raw.catalogVersion !== COMPOSITION_CATALOG_VERSION
    || typeof raw.sourceOid !== 'string'
    || typeof raw.sourceRef !== 'string'
    || !Array.isArray(raw.detectedRuntimes)) return null;
  return raw as RepositoryInspectionResult;
}

function emptyInspection(): Record<string, unknown> {
  return {
    catalogVersion: COMPOSITION_CATALOG_VERSION,
    sourceOid: null,
    sourceRef: null,
    forgeHint: null,
    detectedRuntimes: [],
  };
}

function knownPublicForge(host: string | null | undefined): CompositionChoice['forgeKind'] {
  const hostname = (host || '').split(':')[0].toLowerCase();
  if (hostname === 'github.com') return 'github';
  if (hostname === 'gitlab.com') return 'gitlab';
  return null;
}

function installationIds(
  choice: CompositionChoice,
  forgeKind: CompositionChoice['forgeKind'],
): string[] {
  const ids: string[] = choice.runtimes.map((runtime) => runtime.runtimeId);
  const selectedLanguages = new Set(choice.runtimes.map((runtime) => runtime.runtimeId));
  const requirements = new Set(choice.agents.map((agent) => getAgentRuntimeCatalogEntry(agent.runtimeId).requires));
  for (const requirement of requirements) {
    if (!selectedLanguages.has(requirement)) ids.push(`agent-foundation-${requirement}`);
  }
  ids.push(...choice.agents.map((agent) => `agent-${agent.runtimeId}`));
  if (forgeKind === 'github') ids.push('gh');
  else if (forgeKind === 'gitlab') ids.push('glab');
  else if (forgeKind === 'gitea' || forgeKind === 'forgejo') ids.push('tea');
  return ids;
}

function safeInspectionMessage(error: unknown): string {
  if (!(error instanceof RepositoryInspectionError)) return 'Repository inspection failed';
  switch (error.code) {
    case 'unsupported_platform': return 'Repository inspection is unavailable on Windows; create a project without a repository or use a Linux server';
    case 'credential_required': return 'Repository credential is missing or invalid';
    case 'invalid_url': return 'Repository URL is not eligible for safe inspection';
    case 'invalid_repository': return 'Repository could not be inspected safely';
    case 'limit_exceeded': return 'Repository inspection exceeded a safety limit';
    case 'timed_out': return 'Repository inspection timed out';
    case 'cancelled': return 'Repository inspection was cancelled';
    default: return 'Repository is currently unavailable for inspection';
  }
}
