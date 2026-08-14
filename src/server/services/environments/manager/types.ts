import { EnvironmentEngine } from '../engine.js';
import { ContainerConfig } from '../types.js';

export const OWNER_HOME_MAP_DIR = '.owner-homes';

interface OwnerHomeIdentity {
  /** Existing user-container name and legacy host-directory basename. */
  name: string;
  hostPath: string;
  /** Kept immutable because tools often persist absolute paths under $HOME. */
  containerPath: string;
}

/** Which deploy target an `ensureFor` should place new work on. */
export interface ActiveTargetResolution {
  /** The target id, or `'legacy'` for the startup-flag configuration. */
  key: string;
  config: ContainerConfig;
  /** Display name, used in error messages. */
  name?: string;
}

/** The replacement engine/config set a `reloadTargets` call installs. */
export interface ReloadTargetsInput {
  engines: Map<string, EnvironmentEngine>;
  configs: Map<string, ContainerConfig>;
  activeKey: string | null;
}

interface PlacementObservation {
  /** The engine key through which the container was observed. */
  engineKey: string;
  engine: EnvironmentEngine;
  config: ContainerConfig;
  /** Null for containers created before deploy-target labels existed. */
  targetLabel: string | null;
}

interface PlacementScanResult {
  engineKey: string;
  observation: PlacementObservation | null;
  error: unknown | null;
}

interface ResolvedPlacement extends ActiveTargetResolution {
  /** The exact engine that proved or will own this container. */
  engine: EnvironmentEngine;
}

export interface EnvironmentManagerOptions {
  config: ContainerConfig;
  engine?: EnvironmentEngine;
  /** False makes every container/deploy-target path unreachable. */
  featureEnabled?: boolean;
  /** Home directory used in host mode. Defaults to the server's working directory. */
  hostHome: string;
  now?: () => number;
  /**
   * The size this user asked for: a tier id, `auto`, or null for the default.
   *
   * A callback rather than a value because the answer lives in the database and
   * may change between two sessions of the same user, and the manager must not
   * own persistence.
   */
  getUserTier?: (userId: number) => string | null;
  /**
   * Multi-target mode: where new environments go, consulted on every ensure.
   *
   * Returning null means "deploy targets exist but none is active", which
   * makes `ensureFor` throw rather than silently falling back to the host.
   */
  resolveActive?: () => ActiveTargetResolution | null;
  /** Engines by target key (`'legacy'` for the startup configuration). */
  engines?: Map<string, EnvironmentEngine>;
  /** Container configs by target key, matching `engines`. */
  configs?: Map<string, ContainerConfig>;
  /** The active key when `resolveActive` is not supplied. */
  activeKey?: string | null;
}

export type {
  OwnerHomeIdentity,
  PlacementObservation,
  PlacementScanResult,
  ResolvedPlacement,
};
