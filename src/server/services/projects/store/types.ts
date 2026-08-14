/** Durable shape and domain types for project persistence. */

/** Every state a project row can be in. `blocked` means preservation failed
 * and the rebuild or reclaim that needed it is held until the user decides. */
export type ProjectState =
  | 'inspecting'
  | 'composition_pending'
  | 'building'
  | 'running'
  | 'stopped'
  | 'reclaiming'
  | 'failed'
  | 'unavailable'
  | 'blocked';

/** The states that count against a user's run limit. */
export const COUNTED_STATES: ProjectState[] = ['building', 'running', 'reclaiming'];

/** What a restart needs to find a project's container again. */
export interface ProjectContainerInfo {
  name: string;
  image?: string;
  shells?: string[];
  /**
   * A boot scan found a same-project runtime which could not be safely
   * adopted. Its name is retained solely to block destructive lifecycle work
   * until a later complete scan proves that runtime is gone.
   */
  reconciliationConflict?: 'unverified_runtime';
}

/** One buffered build event, persisted so a reopened tab rejoins the build. */
export interface BuildEvent {
  t: 'step' | 'progress' | 'state' | 'error' | 'preserve' | 'partial_install';
  step?: string;
  message?: string;
  percent?: number;
  state?: ProjectState;
  branch?: string;
  commit?: string;
  at: string;
}

export interface Project {
  id: string;
  ownerUserId: number;
  name: string;
  repoUrl: string | null;
  repoHost: string | null;
  /** The deploy target it was placed on; null means the legacy engine. */
  targetId: string | null;
  /** Host projects are ordinary local workspaces; container is the legacy/default placement. */
  executionKind: 'host' | 'container';
  tierId: string | null;
  state: ProjectState;
  stateDetail: string | null;
  container: ProjectContainerInfo | null;
  /** True only when retained workspace bytes must be replaced on next build. */
  rebuildRequired: boolean;
  buildLog: BuildEvent[];
  lastActivityAt: string;
  lastPreservedCommit: string | null;
  lastPreservedBranch: string | null;
  compositionRevision: string | null;
  /** Revision applied to the currently retained runtime; null for legacy rows. */
  appliedCompositionRevision: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectInput {
  ownerUserId: number;
  name: string;
  repoUrl?: string | null;
  repoHost?: string | null;
  targetId?: string | null;
  executionKind?: 'host' | 'container';
  tierId?: string | null;
  /** Opt-in so existing callers retain the historical stopped-on-create contract. */
  initialState?: Extract<ProjectState, 'inspecting' | 'composition_pending' | 'stopped'>;
}

export type CompositionInstallationStatus = 'pending' | 'installing' | 'installed' | 'failed';

export interface ProjectComposition {
  id: string;
  projectId: string;
  userId: number;
  catalogVersion: string;
  detected: unknown;
  chosen: unknown;
  sourceOid: string | null;
  sourceRef: string | null;
  forgeKind: string | null;
  forgeHost: string | null;
  createdAt: string;
}

export interface CompositionInstallation {
  id: string;
  compositionId: string;
  itemId: string;
  status: CompositionInstallationStatus;
  attempts: number;
  installedVersion: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GitIdentity {
  id: string;
  userId: number;
  projectId: string | null;
  name: string;
  email: string;
  createdAt: string;
  updatedAt: string;
}

export interface StorageUsageSnapshot {
  id: string;
  userId: number | null;
  totalBytes: number;
  breakdown: StorageUsageBreakdown;
  errors: string[];
  freeBytes: number | null;
  createdAt: string;
}
/** Scanner-owned category map.  Unknown categories survive a round trip so
 * future scanner versions do not need a schema migration merely to report. */
export interface StorageUsageBreakdown {
  [category: string]: StorageUsageValue;
}
export type StorageUsageValue = number | string | boolean | null | StorageUsageBreakdown | StorageUsageValue[];

/** One row of the running list a 409 `run_limit` answer carries. */
export interface RunningProjectInfo {
  id: string;
  name: string;
  state: ProjectState;
  lastActivityAt: string;
  /** Active sessions in it — the signal that a swap must never stop it. */
  hasActiveWork: boolean;
}

export type StartAttempt =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'invalid_state'
        | 'composition_conflict'
        | 'stop_candidate_invalid'
        | 'stop_candidate_busy'
        | 'run_limit';
      /** Present when reason is `run_limit`: what the user is running now. */
      running?: RunningProjectInfo[];
    };

export type LifecycleClaim =
  | { ok: true; project: Project }
  | { ok: false; reason: 'not_found' | 'invalid_state' | 'active_work' | 'not_idle' };

export type SessionLeaseAttempt =
  | { ok: true; leaseId: string }
  | { ok: false; reason: 'not_found' | 'invalid_state' };

export interface ConnectedHost {
  id: string;
  userId: number;
  host: string;
  kind: string;
  forgeKind: string | null;
  credentialKind: 'token' | 'oauth' | null;
  validationStatus: ConnectedHostValidationStatus | null;
  lastValidatedAt: string | null;
  validationErrorCode: string | null;
  validationErrorMessage: string | null;
  credentialRevision: number;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ConnectedHostValidationStatus = 'unvalidated' | 'valid' | 'invalid';

/** One decrypted credential bound to the durable generation that produced it. */
export interface ConnectedCredential {
  token: string;
  kind: 'token' | 'oauth';
  revision: number;
}

/** How many build events a project row keeps; older ones drop off the front. */
export const BUILD_LOG_LIMIT = 200;

export const SETTING_RUN_LIMIT = 'deploy.runLimitPerUser';
export const SETTING_IDLE_STOP = 'deploy.idleStopMinutes';
export const SETTING_IDLE_RECLAIM = 'deploy.idleReclaimMinutes';
export const SETTING_USAGE_WARN_USER = 'deploy.usageWarnUserBytes';
export const SETTING_USAGE_WARN_ADMIN = 'deploy.usageWarnAdminBytes';

export const DEFAULT_RUN_LIMIT_PER_USER = 3;
export const DEFAULT_IDLE_STOP_MINUTES = 60;
/** Seven days: long enough that only a genuinely forgotten project is reclaimed. */
export const DEFAULT_IDLE_RECLAIM_MINUTES = 10080;
