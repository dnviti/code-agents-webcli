import { EnvironmentManagerLifecycle } from './manager-lifecycle.js';

/**
 * The single public manager type: one per-user environment per deploy target.
 *
 * The class is spread across an abstract inheritance chain so each half of the
 * split stays small; this concrete leaf assembles them into the full surface
 * callers inside the server rely on.
 */
export class EnvironmentManager extends EnvironmentManagerLifecycle {}
