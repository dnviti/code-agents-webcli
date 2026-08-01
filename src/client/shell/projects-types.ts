/**
 * Project shapes used by the client shell.
 *
 * These mirror the HTTP contracts in routes/projects.ts and the store types
 * in services/projects/store.ts, but are declared independently here so the
 * client bundle stays separate from server internals.
 */

export type ProjectState =
  | 'building'
  | 'running'
  | 'stopped'
  | 'reclaiming'
  | 'failed'
  | 'unavailable'
  | 'blocked';

export interface ProjectSummary {
  id: string;
  name: string;
  repoUrl: string | null;
  repoHost: string | null;
  targetId: string | null;
  state: ProjectState;
  stateDetail: string | null;
  lastActivityAt: string;
  hasActiveWork: boolean;
}

/** One row of the running list a 409 `run_limit` answer carries. */
export interface RunningProjectInfo {
  id: string;
  name: string;
  lastActivityAt: string;
  hasActiveWork: boolean;
}

/** One buffered build event streamed from /api/projects/:id/build. */
export interface BuildEvent {
  t: 'step' | 'progress' | 'state' | 'error' | 'preserve';
  step?: string;
  message?: string;
  percent?: number;
  state?: ProjectState;
  branch?: string;
  commit?: string;
  at: string;
}

/** Full project row returned by /api/projects/:id. */
export interface ProjectDetails extends ProjectSummary {
  buildLog: BuildEvent[];
}

/** 409 run_limit payload. */
export interface RunLimitPayload {
  error: 'run_limit';
  running: RunningProjectInfo[];
}

/** 428 credential_required payload. */
export interface CredentialRequiredPayload {
  error: 'credential_required';
  host: string;
}
