/**
 * Project persistence: the rows, the states, and the one number that must
 * never be wrong.
 *
 * The store owns everything that is pure data — CRUD, owner scoping, the
 * connected-host credentials, the build-event ring buffer — and exactly one
 * piece of policy: the run-limit check-and-transition, which lives here
 * because it is only meaningful inside a single `BEGIN IMMEDIATE`
 * transaction. A check in one statement and a transition in another would
 * let two concurrent starts both pass the count; holding the write lock from
 * the count to the update is what makes the limit real.
 *
 * This file is a thin facade over `./store/`; the implementation lives in the
 * subfolder as a linear chain of abstract partial classes.
 */

export { ProjectStore } from './store/store.js';
export type {
  BuildEvent,
  CompositionInstallation,
  CompositionInstallationStatus,
  ConnectedCredential,
  ConnectedHost,
  ConnectedHostValidationStatus,
  CreateProjectInput,
  GitIdentity,
  LifecycleClaim,
  Project,
  ProjectComposition,
  ProjectContainerInfo,
  ProjectState,
  RunningProjectInfo,
  SessionLeaseAttempt,
  StartAttempt,
  StorageUsageBreakdown,
  StorageUsageSnapshot,
  StorageUsageValue,
} from './store/types.js';
export {
  COUNTED_STATES,
  DEFAULT_IDLE_RECLAIM_MINUTES,
  DEFAULT_IDLE_STOP_MINUTES,
  DEFAULT_RUN_LIMIT_PER_USER,
} from './store/types.js';
