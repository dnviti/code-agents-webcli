import fs from 'node:fs';
import path from 'node:path';
import { EnvironmentEngine } from '../engine.js';
import { containerHomeFor, environmentName } from '../naming.js';
import { resolveTier } from '../tiers.js';
import { ContainerConfig, EnvironmentOwner, EnvironmentTier, UserEnvironment } from '../types.js';
import { EnvironmentManagerState } from './manager-state.js';
import {
  ActiveTargetResolution,
  OWNER_HOME_MAP_DIR,
  OwnerHomeIdentity,
  ReloadTargetsInput,
  ResolvedPlacement,
} from './types.js';

/**
 * Target, engine and config routing for an environment manager.
 *
 * Everything that decides which engine/config/route a container belongs to, and
 * the durable owner-home mapping, lives here so the provisioning and lifecycle
 * halves of the split can rely on one set of resolution rules.
 */
export abstract class EnvironmentManagerTargets extends EnvironmentManagerState {
  /** Where new work would go right now; null when no target is active. */
  protected resolveActiveTarget(): ActiveTargetResolution | null {
    if (this.resolveActiveFn) {
      return this.resolveActiveFn();
    }
    if (this.multiTarget) {
      if (!this.activeKey) {
        return null;
      }
      const config = this.configs.get(this.activeKey);
      return config ? { key: this.activeKey, config } : null;
    }
    return { key: 'legacy', config: this.config };
  }

  protected engineForKey(key: string): EnvironmentEngine {
    const engine = this.engines.get(key);
    if (engine) {
      return engine;
    }
    // 'legacy' is always reachable: it is the startup configuration this
    // manager was constructed with, whether or not a reload kept it in the map.
    if (key === 'legacy') {
      return this.engine;
    }
    // Anything else is a routing bug or a stale placement, and silently
    // substituting the startup engine would run the container against the
    // wrong target — loudly name the missing key instead.
    throw new Error(`no engine for deploy target '${key}'`);
  }

  protected configForKey(key: string): ContainerConfig {
    return this.configs.get(key) || this.config;
  }

  /** The engine that owns an existing container, whatever is active now. */
  protected engineForContainer(name: string): EnvironmentEngine {
    const placement = this.containerPlacement.get(name);
    if (placement) {
      return placement.engine;
    }
    return this.engineForKey(this.containerTarget.get(name) || 'legacy');
  }

  /** The policy/root that belongs to an existing container's exact route. */
  protected configForContainer(name: string): ContainerConfig {
    const placement = this.containerPlacement.get(name);
    if (placement) {
      // Retain the exact engine endpoint, but not a stale policy snapshot.
      // Safe edits such as tiers, image and idle timeout must affect existing
      // environments; if the target was deleted, reloadTargets keeps (or this
      // placement falls back to) the last configuration that can still serve it.
      return this.configs.get(placement.key) || placement.config;
    }
    return this.configForKey(this.containerTarget.get(name) || 'legacy');
  }

  /** The target a container was placed on, as far as this manager knows. */
  targetKeyForContainer(name: string): string {
    return this.containerTarget.get(name) || 'legacy';
  }

  /**
   * Every engine this manager can still reach: the current target set plus
   * any engine retained for containers a reload would otherwise have
   * stranded. This — not the active set — is the authoritative answer to
   * "could containers for this target still exist?".
   */
  reachableEngines(): Map<string, EnvironmentEngine> {
    if (!this.featureEnabled) return new Map();
    const reachable = new Map(this.engines);
    let retained = 0;
    for (const placement of this.containerPlacement.values()) {
      if ([...reachable.values()].includes(placement.engine)) {
        continue;
      }
      let key = placement.key;
      while (reachable.has(key)) {
        retained += 1;
        key = `retained:${placement.key}:${retained}`;
      }
      reachable.set(key, placement.engine);
    }
    return reachable;
  }

  /**
   * Resolve a project container's recorded placement.  Unlike user ensures,
   * this deliberately never consults the active target: moving the active
   * target must not make an existing project's container run somewhere else.
   */
  projectTarget(targetId: string | null): ActiveTargetResolution & { engine: EnvironmentEngine } {
    if (!this.featureEnabled) {
      throw new Error('containerized environments are disabled by the server feature flag');
    }
    const key = targetId || 'legacy';
    const config = key === 'legacy' ? this.configForKey(key) : this.configs.get(key);
    const engine = key === 'legacy' ? this.engineForKey(key) : this.engines.get(key);
    if (!config || !engine) {
      throw new Error(`recorded deploy target '${key}' is no longer reachable`);
    }
    if (config.engine !== 'kubernetes' && config.hostArgs?.length) {
      throw new Error(`project workspaces do not support remote ${config.engine} bind mounts`);
    }
    return { key, config, engine };
  }

  /** The only placement used for a new project. */
  activeProjectTarget(): ActiveTargetResolution & { engine: EnvironmentEngine } {
    if (!this.featureEnabled) {
      throw new Error('containerized environments are disabled by the server feature flag');
    }
    const active = this.resolveActiveTarget();
    if (!active) {
      throw new Error('no active deploy target: an administrator must activate one before new work can start');
    }
    if (!active.config.enabled) {
      throw new Error('project environments are disabled: configure and activate a deploy target first');
    }
    if (active.config.engine !== 'kubernetes' && active.config.hostArgs?.length) {
      throw new Error(`project workspaces do not support remote ${active.config.engine} bind mounts`);
    }
    return { ...active, engine: this.engineForKey(active.key) };
  }

  /** Placement for new projects; no active target is explicit host-local mode. */
  newProjectPlacement():
    | { kind: 'host' }
    | { kind: 'container'; target: ActiveTargetResolution & { engine: EnvironmentEngine } } {
    if (!this.featureEnabled) return { kind: 'host' };
    const active = this.resolveActiveTarget();
    if (!active || !active.config.enabled) return { kind: 'host' };
    return { kind: 'container', target: this.activeProjectTarget() };
  }

  /**
   * The durable owner-home path as seen from one target.  Projects mount this
   * alongside their own workspace so rebuilding a project never costs a user
   * their sign-in or home-directory state.
   */
  ownerHomeOnTarget(owner: EnvironmentOwner, targetId: string | null): {
    hostPath: string;
    containerPath: string;
  } {
    const target = this.projectTarget(targetId);
    const identity = this.ownerHomeForConfig(target.config, owner);
    return { hostPath: identity.hostPath, containerPath: identity.containerPath };
  }

  /** Durable root shared by project workspaces placed on one target. */
  projectStorageRoot(targetId: string | null): string {
    return path.join(this.projectTarget(targetId).config.rootDir, 'projects');
  }

  /**
   * Install a new set of targets.
   *
   * Engines that still own known containers are retained even when the new
   * set drops them: an edited or deleted target must not strand the work it
   * already runs. Retained engines only ever serve their existing containers
   * — new ensures resolve through the new active key and never see them.
   */
  reloadTargets(input: ReloadTargetsInput): void {
    const liveKeys = new Set(this.containerTarget.values());

    const engines = new Map(input.engines);
    for (const key of liveKeys) {
      const retained = this.engines.get(key);
      if (!engines.has(key) && retained) {
        engines.set(key, retained);
      }
    }
    // Server-built target maps intentionally contain only database targets.
    // Keep the startup engine independently reachable: containers created
    // before target labels existed belong to this legacy route, and an admin
    // edit must not make them undiscoverable.
    if (!engines.has('legacy')) {
      engines.set('legacy', this.engine);
    }

    const configs = new Map(input.configs);
    for (const key of liveKeys) {
      const retained = this.configs.get(key);
      if (!configs.has(key) && retained) {
        configs.set(key, retained);
      }
    }
    if (!configs.has('legacy')) {
      configs.set('legacy', this.config);
    }

    this.engines = engines;
    this.configs = configs;
    this.activeKey = input.activeKey;
    this.targetRevision += 1;
  }

  /** The catalog an administrator defined, in ladder order. */
  get tiers(): EnvironmentTier[] {
    return (this.resolveActiveTarget()?.config || this.config).tiers;
  }

  get defaultTierId(): string {
    return (this.resolveActiveTarget()?.config || this.config).defaultTier;
  }

  get userTierChoiceAllowed(): boolean {
    return (this.resolveActiveTarget()?.config || this.config).allowUserTierChoice;
  }

  /** The size a user's environment is running at right now, if it is running. */
  appliedTierFor(userId: number): EnvironmentTier | null {
    return this.appliedTier.get(userId) || null;
  }

  /** A size change waiting for this user to stop working, if there is one. */
  pendingTierFor(userId: number): EnvironmentTier | null {
    return this.pendingRebuild.get(userId) || null;
  }

  /** The size this user's environment should be, given their choice. */
  intendedTierFor(userId: number): EnvironmentTier | null {
    return this.intendedTier(this.resolveActiveTarget()?.config || this.config, userId);
  }

  /** Resolve a user's tier against a recorded target, never today's active one. */
  intendedTierOnTarget(userId: number, targetId: string | null): EnvironmentTier | null {
    return this.intendedTier(this.projectTarget(targetId).config, userId);
  }

  protected intendedTier(config: ContainerConfig, userId: number): EnvironmentTier | null {
    return resolveTier(
      config.tiers,
      this.getUserTier(userId),
      config.defaultTier,
      this.autoTier.get(userId),
    );
  }

  get enabled(): boolean {
    if (!this.featureEnabled) return false;
    // Resolved rather than read off the startup config: once deploy targets
    // exist they are the source of truth, and an install started with
    // containers off still has environments the moment a target is active.
    // On the legacy single-config path this resolves to `this.config`, so
    // behavior there is exactly what it was.
    const active = this.resolveActiveTarget();
    if (!active) return false;
    return active.config.enabled;
  }

  /** The environment used when the feature is off, and the fallback when it fails. */
  host(): UserEnvironment {
    return this.hostEnvironment;
  }

  /** Whether the engine new work would land on is installed and answering. */
  async engineAvailable(): Promise<boolean> {
    return this.engineForKey(this.resolveActiveTarget()?.key || 'legacy').available();
  }

  nameFor(owner: EnvironmentOwner): string {
    const config = this.resolveActiveTarget()?.config || this.config;
    return this.ownerHomeForConfig(config, owner).name;
  }

  homeDirFor(owner: EnvironmentOwner): string {
    const config = this.resolveActiveTarget()?.config || this.config;
    return this.ownerHomeForConfig(config, owner).hostPath;
  }

  protected resolutionForActive(active: ActiveTargetResolution): ResolvedPlacement {
    return { ...active, engine: this.engineForKey(active.key) };
  }

  /**
   * Resolve the durable owner home from an immutable user-id pointer.
   *
   * The pointed-to path deliberately keeps the original login-derived shape:
   * existing #167 containers can keep their mount and their in-container HOME
   * unchanged. The pointer filename, not the mutable login, is the identity.
   * When upgrading an existing installation after a login rename, a single
   * validated legacy directory is discovered. Multiple candidates fail closed.
   */
  protected ownerHomeForConfig(config: ContainerConfig, owner: EnvironmentOwner): OwnerHomeIdentity {
    if (!Number.isSafeInteger(owner.id) || owner.id <= 0) {
      throw new Error('environment owner id must be a positive integer');
    }
    const root = path.resolve(config.rootDir);
    const mapDir = path.join(root, OWNER_HOME_MAP_DIR);
    const pointerPath = path.join(mapDir, `${owner.id}.json`);
    const readPointer = (): OwnerHomeIdentity | null => {
      try {
        const parsed = JSON.parse(fs.readFileSync(pointerPath, 'utf8')) as {
          name?: unknown;
          containerPath?: unknown;
        };
        return this.validateOwnerHomeIdentity(root, owner.id, parsed.name, parsed.containerPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new Error(`owner home mapping for user ${owner.id} is invalid: ${(error as Error).message}`);
      }
    };
    const recorded = readPointer();
    if (recorded) return recorded;

    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const suffix = `-${owner.id}`;
    const candidates = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== OWNER_HOME_MAP_DIR && entry.name.endsWith(suffix))
      .map((entry) => entry.name);
    if (candidates.length > 1) {
      throw new Error(`owner home mapping for user ${owner.id} is ambiguous`);
    }

    fs.mkdirSync(mapDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(mapDir, 0o700);

    const name = candidates[0] || environmentName(config.namePrefix, owner);
    const legacyContainerName = name.startsWith(`${config.namePrefix}-`)
      ? name.slice(config.namePrefix.length + 1)
      : null;
    const containerPath = legacyContainerName && legacyContainerName.endsWith(suffix)
      ? `/home/${legacyContainerName}`
      : containerHomeFor(owner);
    const identity = this.validateOwnerHomeIdentity(root, owner.id, name, containerPath);
    const payload = `${JSON.stringify({ version: 1, name, containerPath })}\n`;
    try {
      fs.writeFileSync(pointerPath, payload, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const raced = readPointer();
      if (!raced) throw new Error(`owner home mapping for user ${owner.id} disappeared during creation`);
      return raced;
    }
    return identity;
  }

  protected validateOwnerHomeIdentity(
    root: string,
    ownerId: number,
    rawName: unknown,
    rawContainerPath: unknown,
  ): OwnerHomeIdentity {
    if (typeof rawName !== 'string' || path.basename(rawName) !== rawName || rawName === OWNER_HOME_MAP_DIR) {
      throw new Error('host directory is not a safe root child');
    }
    const suffix = `-${ownerId}`;
    if (!rawName.endsWith(suffix) || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(rawName)) {
      throw new Error('host directory does not belong to this immutable user id');
    }
    if (
      typeof rawContainerPath !== 'string'
      || path.posix.dirname(rawContainerPath) !== '/home'
      || !path.posix.basename(rawContainerPath).endsWith(suffix)
    ) {
      throw new Error('container home does not belong to this immutable user id');
    }
    const hostPath = path.resolve(root, rawName);
    if (path.dirname(hostPath) !== root) throw new Error('host directory escapes its target root');
    return { name: rawName, hostPath, containerPath: rawContainerPath };
  }
}
