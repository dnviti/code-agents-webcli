/**
 * Project shapes used by the client shell.
 *
 * These mirror the HTTP contracts in routes/projects.ts and the store types
 * in services/projects/store.ts, but are declared independently here so the
 * client bundle stays separate from server internals.
 */

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

export interface ProjectSummary {
  id: string;
  name: string;
  repoUrl: string | null;
  repoHost: string | null;
  targetId: string | null;
  executionKind?: 'host' | 'container';
  /** Human-readable placement supplied by the server; null names legacy placement. */
  targetName?: string | null;
  state: ProjectState;
  stateDetail: string | null;
  lastActivityAt: string;
  hasActiveWork: boolean;
  /** Exact remote recovery ref created by the latest successful preservation. */
  lastPreservedBranch: string | null;
  lastPreservedCommit: string | null;
  /** Durable lifecycle history, including the exact WIP branch used to preserve work. */
  buildLog: BuildEvent[];
  /** Desired active recipe. Null while a new project is awaiting first confirmation. */
  compositionRevision: string | null;
  /** Recipe applied to the retained runtime; null until a composed build succeeds. */
  appliedCompositionRevision: string | null;
}

/** Project creation capability and the placement used by an ordinary create. */
export interface ProjectAvailability {
  available: boolean;
  message?: string;
  defaultExecutionKind?: 'host' | 'container';
}

/** Preserve placement capability while treating malformed optional fields as absent. */
export function normalizeProjectAvailability(value: unknown): ProjectAvailability {
  const input = value && typeof value === 'object'
    ? value as Partial<ProjectAvailability>
    : {};
  const availability: ProjectAvailability = { available: input.available !== false };
  if (typeof input.message === 'string') availability.message = input.message;
  if (input.defaultExecutionKind === 'host' || input.defaultExecutionKind === 'container') {
    availability.defaultExecutionKind = input.defaultExecutionKind;
  }
  return availability;
}

/** One row of the running list a 409 `run_limit` answer carries. */
export interface RunningProjectInfo {
  id: string;
  name: string;
  state: ProjectState;
  lastActivityAt: string;
  hasActiveWork: boolean;
}

/** One buffered build event streamed from /api/projects/:id/build. */
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

/** Full project row returned by /api/projects/:id. */
export type ProjectDetails = ProjectSummary;

/** Stable across JSON list responses and SSE frames regardless of object key order. */
export function buildEventKey(event: BuildEvent): string {
  return JSON.stringify([
    event.t,
    event.step ?? null,
    event.message ?? null,
    event.percent ?? null,
    event.state ?? null,
    event.branch ?? null,
    event.commit ?? null,
    event.at,
  ]);
}

/**
 * Fold each list response's durable build log into the live event view.
 *
 * The list is the recovery path after reload or a missed SSE frame. Existing
 * live entries win their position, while exact persisted duplicates are kept
 * once. Projects absent from one response retain no visible card anyway, so
 * keeping their entries here avoids turning a transient filtered response into
 * destructive local state.
 */
export function mergeProjectBuildEvents(
  previous: Readonly<Record<string, BuildEvent[]>>,
  projects: readonly ProjectSummary[],
): Record<string, BuildEvent[]> {
  const next: Record<string, BuildEvent[]> = { ...previous };
  for (const project of projects) {
    const merged = [...(previous[project.id] || [])];
    const seen = new Set(merged.map(buildEventKey));
    for (const event of project.buildLog || []) {
      const key = buildEventKey(event);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(event);
    }
    next[project.id] = merged;
  }
  return next;
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
