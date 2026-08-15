/** Shared public types for the ProjectManager partial-class chain. */

import type { EnvironmentOwner, UserEnvironment } from '../../environments/types.js';
import type { EnvironmentManager } from '../../environments/manager.js';
import type { DeployTargetStore } from '../deployment/deploy-targets.js';
import type { FetchLike } from '../clone.js';
import type {
  ProjectContainerAccess,
  WorkspaceSessionStorageIdentity,
} from '../environment.js';
import type { EnvironmentEngine } from '../../environments/engine.js';
import type {
  CompositionInstallation,
  Project,
  ProjectComposition,
  ProjectStore,
  RunningProjectInfo,
} from '../store.js';
import type { RepositoryInspectionResult, RepositoryInspector } from '../../composition/repository-inspector.js';
import type { AgentRuntimeId, RuntimeId } from '../../composition/catalog.js';

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
