import { EnvironmentEngine } from '../engine.js';
import { AutoState } from '../tiers.js';
import { ContainerConfig, EnvironmentTier, UserEnvironment } from '../types.js';
import { ContainerEnvironment } from './container-environment.js';
import { createEngine } from './create-engine.js';
import { HostEnvironment } from './host-environment.js';
import {
  ActiveTargetResolution,
  EnvironmentManagerOptions,
  ResolvedPlacement,
} from './types.js';

/**
 * The mutable state behind one environment manager.
 *
 * Kept as the root of the manager's inheritance chain so every translation,
 * discovery, provisioning and lifecycle step in the derived classes can read
 * and write the same fields without passing the whole bag around.
 */
export abstract class EnvironmentManagerState {
  protected readonly config: ContainerConfig;
  protected readonly engine: EnvironmentEngine;
  protected readonly featureEnabled: boolean;
  protected readonly hostEnvironment: HostEnvironment;
  protected readonly now: () => number;
  /** In-flight `ensureFor` calls, so two tabs signing in at once make one container. */
  protected readonly pending = new Map<number, Promise<UserEnvironment>>();
  protected readonly ready = new Map<number, ContainerEnvironment>();
  protected readonly lastUsed = new Map<number, number>();
  /** The tier each ready environment was actually built or resized to. */
  protected readonly appliedTier = new Map<number, EnvironmentTier>();
  /** Where automatic sizing has settled for a user, and its counters. */
  protected readonly autoTier = new Map<number, string>();
  protected readonly autoState = new Map<number, AutoState>();
  /**
   * A size change that could not be applied to a running environment.
   *
   * Held until the user is idle rather than applied at once: on an engine
   * without live resize the only way to change a limit is to replace the
   * environment, and doing that under a working agent would destroy the run.
   */
  protected readonly pendingRebuild = new Map<number, EnvironmentTier>();
  protected readonly getUserTier: (userId: number) => string | null;
  /**
   * Whether this manager places work across deploy targets. The legacy
   * single-config constructor path leaves this false and behaves exactly as
   * it always has.
   */
  protected readonly multiTarget: boolean;
  protected readonly resolveActiveFn: (() => ActiveTargetResolution | null) | null;
  protected engines: Map<string, EnvironmentEngine>;
  protected configs: Map<string, ContainerConfig>;
  protected activeKey: string | null;
  /** Incremented on every target reload so an in-flight discovery can retry a stale snapshot. */
  protected targetRevision = 0;
  /**
   * Which target each known container was placed on, by container name.
   *
   * The routing table that lets an edit, a switch or a deletion of a target
   * leave the containers it already produced reachable: `ensureFor` records
   * the active key here, `list()` relearns it from the target label, and
   * every operation on an existing container goes through it.
   */
  protected readonly containerTarget = new Map<string, string>();
  /**
   * Trusted per-container routes, including the exact engine/config snapshot.
   *
   * Keeping the objects matters when a target is edited or removed during an
   * ensure: a replacement map can reuse the same target id for a different
   * endpoint, while existing work must keep talking to the endpoint where it
   * was actually found.
   */
  protected readonly containerPlacement = new Map<string, ResolvedPlacement>();

  constructor(options: EnvironmentManagerOptions) {
    this.config = options.config;
    this.engine = options.engine || createEngine(options.config);
    this.featureEnabled = options.featureEnabled !== false;
    this.hostEnvironment = new HostEnvironment(options.hostHome);
    this.now = options.now || (() => Date.now());
    this.getUserTier = options.getUserTier || (() => null);

    this.multiTarget = Boolean(options.resolveActive || options.engines || options.configs);
    this.resolveActiveFn = options.resolveActive || null;
    this.engines = options.engines ? new Map(options.engines) : new Map();
    this.configs = options.configs ? new Map(options.configs) : new Map();
    // The startup configuration is always reachable under its well-known key:
    // pre-upgrade containers carry no target label, and an absent label reads
    // as 'legacy' everywhere it is consumed.
    if (!this.engines.has('legacy')) {
      this.engines.set('legacy', this.engine);
    }
    if (!this.configs.has('legacy')) {
      this.configs.set('legacy', this.config);
    }
    this.activeKey = options.activeKey !== undefined
      ? options.activeKey
      : (this.multiTarget ? null : 'legacy');
  }
}
