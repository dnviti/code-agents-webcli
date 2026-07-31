/**
 * Creating, reusing and retiring one environment per signed-in user.
 *
 * The manager owns two things that must agree: a directory on the host, and a
 * container that has it bind-mounted. The directory is the durable half — it
 * outlives every `rm`, upgrade and idle stop — so the container can always be
 * thrown away and rebuilt without asking the user's permission or losing their
 * work. That asymmetry is why `ensureFor` is safe to call on every sign-in and
 * on every session start: it converges on the desired state instead of
 * assuming one.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ContainerEngine, EnvironmentEngine, ResourceUsage } from './engine.js';
import { KubernetesEngine } from './kubernetes.js';
import { TARGET_LABEL, containerHomeFor, environmentName, targetLabelValue } from './naming.js';
import {
  AUTO_TIER,
  AutoState,
  DEFAULT_AUTO_POLICY,
  INITIAL_AUTO_STATE,
  decideAutoTier,
  findTier,
  resolveTier,
} from './tiers.js';
import {
  ContainerConfig,
  EnvironmentOwner,
  EnvironmentSummary,
  EnvironmentTier,
  Mount,
  UserEnvironment,
  WrapOptions,
  WrappedCommand,
} from './types.js';

export const MANAGED_LABEL = 'com.code-agents-webcli.managed';
export const TIER_LABEL = 'com.code-agents-webcli.tier';
export const USER_ID_LABEL = 'com.code-agents-webcli.user-id';
export const LOGIN_LABEL = 'com.code-agents-webcli.login';
export { TARGET_LABEL };

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

function mergedEnv(extra?: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      base[key] = value;
    }
  }
  return { ...base, ...(extra || {}) };
}

/**
 * The environment the server has always had: this machine, this account.
 *
 * Every method is the identity, so a call site that has been converted to go
 * through an environment behaves exactly as it did before conversion when the
 * feature is off. That is the whole reason the host is modelled as an
 * environment rather than as a `if (containers)` branch at each site.
 */
export class HostEnvironment implements UserEnvironment {
  readonly kind = 'host' as const;
  readonly name = null;
  readonly homeDir: string;
  /** Empty: the terminal bridge's own host search is the better answer here. */
  readonly shells: readonly string[] = [];
  readonly mounts: readonly Mount[] = [];
  readonly nodePath = process.execPath;

  constructor(homeDir: string) {
    this.homeDir = homeDir;
  }

  get containerHome(): string {
    return this.homeDir;
  }

  toContainerPath(hostPath: string): string {
    return hostPath;
  }

  toHostPath(containerPath: string): string {
    return containerPath;
  }

  wrap(command: string, args: string[], options: WrapOptions = {}): WrappedCommand {
    return { command, args, env: mergedEnv(options.env) };
  }
}

/** One user's container, plus the path translation its bind mount implies. */
export class ContainerEnvironment implements UserEnvironment {
  readonly kind = 'container' as const;
  readonly name: string;
  readonly homeDir: string;
  readonly containerHome: string;
  readonly shells: readonly string[];
  readonly mounts: readonly Mount[];
  /** Resolved through the image's PATH: the host's binary is not in there. */
  readonly nodePath = 'node';
  private readonly engine: EnvironmentEngine;

  constructor(options: {
    name: string;
    homeDir: string;
    containerHome: string;
    engine: EnvironmentEngine;
    shells?: readonly string[];
    mounts?: readonly Mount[];
  }) {
    this.name = options.name;
    this.homeDir = options.homeDir;
    this.containerHome = options.containerHome;
    this.engine = options.engine;
    this.shells = options.shells || [];
    this.mounts = options.mounts
      || [{ hostPath: options.homeDir, containerPath: options.containerHome }];
  }

  toContainerPath(hostPath: string): string {
    const resolved = path.resolve(hostPath);

    for (const mount of this.mounts) {
      const root = path.resolve(mount.hostPath);
      if (resolved === root) {
        return mount.containerPath;
      }
      if (resolved.startsWith(`${root}${path.sep}`)) {
        const rest = path.relative(root, resolved).split(path.sep).join('/');
        return `${mount.containerPath}/${rest}`;
      }
    }

    // Not a translation failure to paper over: a path the environment cannot
    // see reaching this point means something upstream skipped the scoping
    // check, and quietly clamping it into the container would turn a routing
    // bug into a silent write to the wrong place.
    throw new Error(`Path ${hostPath} is outside environment ${this.name}`);
  }

  toHostPath(containerPath: string): string {
    const normalized = path.posix.resolve(containerPath);

    for (const mount of this.mounts) {
      if (normalized === mount.containerPath) {
        return path.resolve(mount.hostPath);
      }
      if (normalized.startsWith(`${mount.containerPath}/`)) {
        return path.join(mount.hostPath, normalized.slice(mount.containerPath.length + 1));
      }
    }

    throw new Error(`Path ${containerPath} is outside environment ${this.name}`);
  }

  wrap(command: string, args: string[], options: WrapOptions = {}): WrappedCommand {
    const cwd = options.cwd ? this.toContainerPath(options.cwd) : this.containerHome;
    const execArgs = this.engine.execArgs(
      { name: this.name, cwd, env: options.env, tty: options.tty },
      command,
      args,
    );
    // The spawn itself gets this process's environment: it is running the
    // engine client, not the user's program. Everything the user's program
    // should see was turned into `--env` flags above, which is also what keeps
    // the server's own secrets out of the container.
    return { command: this.engine.binary, args: execArgs, env: mergedEnv() };
  }
}

export interface EnvironmentManagerOptions {
  config: ContainerConfig;
  engine?: EnvironmentEngine;
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

export class EnvironmentManager {
  private readonly config: ContainerConfig;
  private readonly engine: EnvironmentEngine;
  private readonly hostEnvironment: HostEnvironment;
  private readonly now: () => number;
  /** In-flight `ensureFor` calls, so two tabs signing in at once make one container. */
  private readonly pending = new Map<number, Promise<UserEnvironment>>();
  private readonly ready = new Map<number, ContainerEnvironment>();
  private readonly lastUsed = new Map<number, number>();
  /** The tier each ready environment was actually built or resized to. */
  private readonly appliedTier = new Map<number, EnvironmentTier>();
  /** Where automatic sizing has settled for a user, and its counters. */
  private readonly autoTier = new Map<number, string>();
  private readonly autoState = new Map<number, AutoState>();
  /**
   * A size change that could not be applied to a running environment.
   *
   * Held until the user is idle rather than applied at once: on an engine
   * without live resize the only way to change a limit is to replace the
   * environment, and doing that under a working agent would destroy the run.
   */
  private readonly pendingRebuild = new Map<number, EnvironmentTier>();
  private readonly getUserTier: (userId: number) => string | null;
  /**
   * Whether this manager places work across deploy targets. The legacy
   * single-config constructor path leaves this false and behaves exactly as
   * it always has.
   */
  private readonly multiTarget: boolean;
  private readonly resolveActiveFn: (() => ActiveTargetResolution | null) | null;
  private engines: Map<string, EnvironmentEngine>;
  private configs: Map<string, ContainerConfig>;
  private activeKey: string | null;
  /**
   * Which target each known container was placed on, by container name.
   *
   * The routing table that lets an edit, a switch or a deletion of a target
   * leave the containers it already produced reachable: `ensureFor` records
   * the active key here, `list()` relearns it from the target label, and
   * every operation on an existing container goes through it.
   */
  private readonly containerTarget = new Map<string, string>();

  constructor(options: EnvironmentManagerOptions) {
    this.config = options.config;
    this.engine = options.engine || createEngine(options.config);
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

  /** Where new work would go right now; null when no target is active. */
  private resolveActiveTarget(): ActiveTargetResolution | null {
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

  private engineForKey(key: string): EnvironmentEngine {
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

  private configForKey(key: string): ContainerConfig {
    return this.configs.get(key) || this.config;
  }

  /** The engine that owns an existing container, whatever is active now. */
  private engineForContainer(name: string): EnvironmentEngine {
    return this.engineForKey(this.containerTarget.get(name) || 'legacy');
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
    return new Map(this.engines);
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

    const configs = new Map(input.configs);
    for (const key of liveKeys) {
      const retained = this.configs.get(key);
      if (!configs.has(key) && retained) {
        configs.set(key, retained);
      }
    }

    this.engines = engines;
    this.configs = configs;
    this.activeKey = input.activeKey;
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

  private intendedTier(config: ContainerConfig, userId: number): EnvironmentTier | null {
    return resolveTier(
      config.tiers,
      this.getUserTier(userId),
      config.defaultTier,
      this.autoTier.get(userId),
    );
  }

  get enabled(): boolean {
    // Resolved rather than read off the startup config: once deploy targets
    // exist they are the source of truth, and an install started with
    // containers off still has environments the moment a target is active.
    // On the legacy single-config path this resolves to `this.config`, so
    // behavior there is exactly what it was.
    const active = this.resolveActiveTarget();
    if (!active) {
      // Only multi-target mode can resolve to nothing, and null there means
      // "targets exist, none active" — unplaceable work, not a disabled
      // feature. Reporting disabled here would make `ensureEnvironment` hand
      // out the host where `ensureFor` is supposed to throw its loud error.
      return this.multiTarget;
    }
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
    return environmentName(this.config.namePrefix, owner);
  }

  homeDirFor(owner: EnvironmentOwner): string {
    return path.join(this.config.rootDir, this.nameFor(owner));
  }

  /**
   * The environment for this user, created if absent and started if stopped.
   *
   * Idempotent and safe to call on every request that needs one.
   */
  async ensureFor(owner: EnvironmentOwner): Promise<UserEnvironment> {
    const active = this.resolveActiveTarget();
    if (!active) {
      // Targets exist but none is active: work is unplaceable, and the only
      // honest answers are a clear error — never a quiet fall back to running
      // on the host, which is exactly the machine containers exist to keep
      // this work off.
      throw new Error(
        'no active deploy target: deploy targets are configured but none is active; '
        + 'an administrator must activate one before new work can start',
      );
    }

    // Where this user's container goes is decided before anything is checked:
    // a container the routing table already knows stays on the target that
    // created it, even when the active target has since moved. Re-placing it
    // on the newly active target would duplicate it there — same name, shared
    // rootDir, two writers on one $HOME — and orphan the original.
    const name = environmentName(active.config.namePrefix, owner);
    const placedKey = this.containerTarget.get(name);
    const placement = placedKey && placedKey !== active.key && this.engines.has(placedKey)
      ? { key: placedKey, config: this.configForKey(placedKey), name: active.name }
      : active;

    const config = placement.config;
    if (!config.enabled) {
      return this.hostEnvironment;
    }

    const engine = this.engineForKey(placement.key);
    if (this.multiTarget && !(await engine.available())) {
      throw new Error(
        `deploy target '${placement.name || placement.key}' is unreachable: `
        + `the ${config.engine} engine is not answering`,
      );
    }

    this.lastUsed.set(owner.id, this.now());

    const inFlight = this.pending.get(owner.id);
    if (inFlight) {
      return inFlight;
    }

    // A size change that had to wait for the user to stop working: this is the
    // moment they are starting again, so it is applied before the new session
    // rather than after it, when it would have to interrupt them all over again.
    const deferred = this.pendingRebuild.get(owner.id);
    if (deferred) {
      const running = this.ready.get(owner.id);
      if (running) {
        try {
          await this.engineForContainer(running.name).stop(running.name);
        } catch (error) {
          console.error(`Environment ${running.name}: could not replace for a size change:`, error);
        }
        this.ready.delete(owner.id);
      }
      this.pendingRebuild.delete(owner.id);
    }

    const work = this.provision(owner, placement).finally(() => {
      this.pending.delete(owner.id);
    });
    this.pending.set(owner.id, work);
    return work;
  }

  /** The environment already prepared for this user, without preparing one. */
  existing(userId: number): UserEnvironment | null {
    // Disabled means the host, exactly as before this feature existed —
    // including on the multi-target path with an empty targets table, where
    // the legacy resolution is what decides.
    if (!this.enabled) {
      return this.hostEnvironment;
    }
    return this.ready.get(userId) || null;
  }

  /** Record activity, so an idle sweep does not stop an environment in use. */
  touch(userId: number): void {
    this.lastUsed.set(userId, this.now());
  }

  private async provision(
    owner: EnvironmentOwner,
    active: ActiveTargetResolution,
  ): Promise<UserEnvironment> {
    const config = active.config;
    const engine = this.engineForKey(active.key);
    const name = environmentName(config.namePrefix, owner);
    const homeDir = path.join(config.rootDir, name);
    const containerHome = containerHomeFor(owner);

    // The placement is registered before the first await — a reload landing
    // mid-provision must see which target this container belongs to, so it
    // retains that engine instead of stranding the container — and rolled
    // back if provisioning fails, so a failed ensure leaves no route to a
    // container that never came up.
    const priorPlacement = this.containerTarget.get(name);
    this.containerTarget.set(name, active.key);

    try {
      // 0700: the isolation claim has to hold on the host too, not only inside
      // the container. Created before the container so the bind mount never
      // brings a root-owned directory into being.
      await fsp.mkdir(homeDir, { recursive: true, mode: 0o700 });
      await fsp.chmod(homeDir, 0o700);

      const mounts: Mount[] = [
        { hostPath: homeDir, containerPath: containerHome },
        ...config.extraMounts,
      ];

      // The tier decides the limits; the flat `--container-cpus`/`--container-memory`
      // remain as the answer for an installation that wants one size for everyone
      // and has emptied the catalog.
      const tier = this.intendedTier(config, owner.id);

      const { created } = await engine.ensure({
        name,
        image: config.image,
        mounts,
        containerHome,
        cpus: tier ? tier.cpus : config.cpus,
        memory: tier ? tier.memory : config.memory,
        labels: {
          [MANAGED_LABEL]: 'true',
          [USER_ID_LABEL]: String(owner.id),
          [LOGIN_LABEL]: owner.githubLogin,
          // Which target placed this container, so a later switch of the active
          // target never makes existing work unreachable. Legacy containers read
          // as 'legacy', whether the label says so or is absent entirely.
          [TARGET_LABEL]: targetLabelValue(active.key),
          ...(tier ? { [TIER_LABEL]: tier.id } : {}),
        },
        env: {
          HOME: containerHome,
          USER: owner.githubLogin,
          TERM: 'xterm-256color',
        },
      });

      if (created && config.setupCommand) {
        // Per creation, not per user: a setup command installs into the image's
        // filesystem, which is exactly the half that a rebuild throws away.
        // Failure is reported and tolerated — an environment without the extras
        // is still a usable environment.
        try {
          await engine.exec(
            { name, cwd: containerHome, env: { HOME: containerHome } },
            'sh',
            ['-c', config.setupCommand],
          );
        } catch (error) {
          console.error(`Environment ${name}: setup command failed:`, error);
        }
      }

      // Probed after any setup command, because installing a nicer shell is one
      // of the things a setup command is for.
      const environment = new ContainerEnvironment({
        name,
        homeDir,
        containerHome,
        engine,
        shells: await this.probeShells(name, engine),
        mounts,
      });

      this.ready.set(owner.id, environment);
      if (tier) {
        this.appliedTier.set(owner.id, tier);
      }
      this.pendingRebuild.delete(owner.id);
      this.lastUsed.set(owner.id, this.now());
      return environment;
    } catch (error) {
      if (priorPlacement === undefined) {
        this.containerTarget.delete(name);
      } else {
        this.containerTarget.set(name, priorPlacement);
      }
      throw error;
    }
  }

  /**
   * Which of the shells this app supports actually exist in an image.
   *
   * One exec at creation rather than a probe per terminal start, and ordered by
   * preference so the caller can take the first. `sh` is appended unconditionally
   * as the last resort: a container without it could not have run the probe.
   */
  private async probeShells(name: string, engine: EnvironmentEngine = this.engine): Promise<string[]> {
    try {
      const { stdout } = await engine.exec({ name }, 'sh', [
        '-c',
        'for s in zsh bash sh; do command -v "$s" >/dev/null 2>&1 && echo "$s"; done',
      ]);
      const found = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
      return found.length ? found : ['sh'];
    } catch (error) {
      console.error(`Environment ${name}: shell probe failed:`, error);
      return ['sh'];
    }
  }

  /**
   * Stop environments with no recorded activity inside the idle window.
   *
   * `isBusy` is not optional in spirit: "idle" here has to mean "nothing is
   * running in it", and this object only sees the moments an environment was
   * handed out. An agent that has been working for an hour without a new
   * session starting would otherwise look untouched, and stopping it would kill
   * the run — the one thing an idle sweep must never do.
   */
  async sweepIdle(isBusy?: (userId: number) => boolean): Promise<string[]> {
    if (!this.multiTarget && (!this.config.enabled || this.config.idleTimeoutMinutes <= 0)) {
      return [];
    }

    const stopped: string[] = [];

    for (const [userId, environment] of [...this.ready]) {
      // Each container answers to the idle policy of the target that placed
      // it, not of whichever target happens to be active now.
      const key = this.containerTarget.get(environment.name) || 'legacy';
      const config = this.configForKey(key);
      const engine = this.engineForKey(key);
      const minutes = config.idleTimeoutMinutes;
      if (!config.enabled || minutes <= 0) {
        continue;
      }

      const cutoff = this.now() - minutes * 60_000;
      const seen = this.lastUsed.get(userId) ?? 0;
      if (seen > cutoff) {
        continue;
      }
      if (isBusy?.(userId)) {
        // Counts as activity, so the environment is not re-examined a minute
        // from now and stopped the instant the run happens to end.
        this.lastUsed.set(userId, this.now());
        continue;
      }
      try {
        const status = await engine.status(environment.name);
        if (status === 'running') {
          await engine.stop(environment.name);
          stopped.push(environment.name);
        }
        // Dropped from `ready` but not from disk: the next `ensureFor` starts
        // the same container again and the user finds their home as they left
        // it.
        this.ready.delete(userId);
      } catch (error) {
        console.error(`Environment ${environment.name}: idle stop failed:`, error);
      }
    }

    return stopped;
  }

  /** Every environment this server manages, running or not, across every target. */
  async list(): Promise<EnvironmentSummary[]> {
    const summaries: EnvironmentSummary[] = [];
    const seen = new Set<string>();
    const engines = [...this.engines.entries()];

    for (const [engineKey, engine] of engines) {
      let names: string[];
      try {
        names = await engine.list(`${MANAGED_LABEL}=true`);
      } catch (error) {
        // With one engine there is nothing to fall back on, and the caller
        // should see the failure. With several, one unreachable target must
        // not hide the environments the others can still report.
        if (engines.length === 1) {
          throw error;
        }
        console.error(`Deploy target '${engineKey}': could not list environments:`, error);
        continue;
      }

      for (const name of names) {
        if (seen.has(name)) {
          continue;
        }
        seen.add(name);
        const described = await engine.describe(name);
        const labels = described?.labels || {};
        // The label is the record of where the container was placed; a
        // container old enough to predate it belongs to the legacy engine.
        const targetKey = labels[TARGET_LABEL] || 'legacy';
        this.containerTarget.set(name, targetKey);
        const userId = Number(labels[USER_ID_LABEL]);
        summaries.push({
          name,
          userId: Number.isFinite(userId) && labels[USER_ID_LABEL] ? userId : null,
          githubLogin: labels[LOGIN_LABEL] || null,
          status: described?.status || 'unknown',
          image: described?.image || '',
          homeDir: path.join(this.configForKey(targetKey).rootDir, name),
        });
      }
    }

    return summaries;
  }

  /**
   * Remove an environment, and optionally the data behind it.
   *
   * Two steps rather than one because they answer different questions: the
   * container goes when a user should stop being able to run anything, the home
   * directory goes when their data should stop existing — which is what
   * revoking access is supposed to mean.
   */
  async remove(name: string, options: { purgeData?: boolean } = {}): Promise<void> {
    const targetKey = this.containerTarget.get(name) || 'legacy';
    await this.engineForKey(targetKey).remove(name);
    this.containerTarget.delete(name);

    for (const [userId, environment] of [...this.ready]) {
      if (environment.name === name) {
        this.ready.delete(userId);
      }
    }

    if (options.purgeData) {
      const rootDir = this.configForKey(targetKey).rootDir;
      const home = path.join(rootDir, name);
      // Guarded against a name that would resolve outside the root — the only
      // caller is an operator command, but a `..` here would delete the wrong
      // tree.
      const resolved = path.resolve(home);
      if (resolved.startsWith(`${path.resolve(rootDir)}${path.sep}`)) {
        await fsp.rm(resolved, { recursive: true, force: true });
      }
    }
  }

  /**
   * What a user's environment is consuming right now.
   *
   * Null when it is not running, or when the engine cannot say — a cluster
   * without metrics-server is the ordinary case, not a fault.
   */
  async usageFor(userId: number): Promise<ResourceUsage | null> {
    const environment = this.ready.get(userId);
    if (!environment) {
      return null;
    }
    try {
      return await this.engineForContainer(environment.name).usage(environment.name);
    } catch {
      return null;
    }
  }

  /**
   * Bring a user's running environment to a size.
   *
   * Live when the engine can — both container runtimes can change limits on a
   * running container, and Kubernetes can on a recent enough cluster — and
   * deferred to the next idle moment when it cannot. Never applied by
   * replacing an environment that has something running in it: the data would
   * survive, but the user's work would not.
   */
  async applyTier(
    userId: number,
    tier: EnvironmentTier,
    options: { busy?: boolean } = {},
  ): Promise<'applied' | 'deferred' | 'unchanged'> {
    const environment = this.ready.get(userId);
    const applied = this.appliedTier.get(userId);

    if (applied && applied.id === tier.id && !this.pendingRebuild.has(userId)) {
      return 'unchanged';
    }

    if (!environment) {
      // Nothing to resize: the next `ensureFor` reads the choice and builds at
      // the right size straight away.
      this.pendingRebuild.delete(userId);
      this.appliedTier.delete(userId);
      return 'applied';
    }

    const engine = this.engineForContainer(environment.name);
    try {
      if (await engine.resize(environment.name, tier.cpus, tier.memory)) {
        this.appliedTier.set(userId, tier);
        this.pendingRebuild.delete(userId);
        return 'applied';
      }
    } catch (error) {
      console.error(`Environment ${environment.name}: live resize failed:`, error);
    }

    if (options.busy) {
      this.pendingRebuild.set(userId, tier);
      return 'deferred';
    }

    await engine.stop(environment.name);
    this.ready.delete(userId);
    this.appliedTier.delete(userId);
    this.pendingRebuild.delete(userId);
    return 'applied';
  }

  /**
   * One round of automatic sizing.
   *
   * Only for users who asked for `auto`; everybody else's size is their own
   * decision and is never overridden by load. Returns what changed, for the log.
   */
  async sampleAndScale(isBusy?: (userId: number) => boolean): Promise<Array<{
    userId: number;
    name: string;
    from: string;
    to: string;
    reason: string;
    outcome: string;
  }>> {
    if (!this.multiTarget && (!this.config.enabled || !this.config.tiers.length)) {
      return [];
    }

    const changes = [];

    for (const [userId, environment] of [...this.ready]) {
      if (this.getUserTier(userId) !== AUTO_TIER) {
        continue;
      }

      // The catalog of the target that placed the container, not of the
      // active one: a switch must not resize existing work to sizes it was
      // never built against.
      const key = this.containerTarget.get(environment.name) || 'legacy';
      const config = this.configForKey(key);
      if (!config.enabled || !config.tiers.length) {
        continue;
      }
      const engine = this.engineForKey(key);

      const current = this.appliedTier.get(userId)
        || findTier(config.tiers, config.defaultTier)
        || config.tiers[0];

      let sample = null;
      try {
        sample = await engine.usage(environment.name);
      } catch {
        sample = null;
      }

      const decision = decideAutoTier({
        tiers: config.tiers,
        current,
        sample,
        state: this.autoState.get(userId) || INITIAL_AUTO_STATE,
        now: this.now(),
        policy: DEFAULT_AUTO_POLICY,
      });
      this.autoState.set(userId, decision.state);

      if (!decision.next) {
        continue;
      }

      this.autoTier.set(userId, decision.next.id);
      const outcome = await this.applyTier(userId, decision.next, { busy: isBusy?.(userId) });
      changes.push({
        userId,
        name: environment.name,
        from: current.id,
        to: decision.next.id,
        reason: decision.reason || '',
        outcome,
      });
    }

    return changes;
  }

  /**
   * Stop one user's environment, keeping their data.
   *
   * Used by the idle sweep and by a tier change that cannot be applied to a
   * running environment. Not destructive on any engine: the home is on a
   * volume, so the next `ensureFor` brings it back as it was.
   */
  async stopFor(userId: number): Promise<boolean> {
    const environment = this.ready.get(userId);
    if (!environment) {
      return false;
    }
    await this.engineForContainer(environment.name).stop(environment.name);
    this.ready.delete(userId);
    return true;
  }

  /** Stop everything this server started, without touching any data. */
  async stopAll(): Promise<void> {
    for (const environment of this.ready.values()) {
      try {
        await this.engineForContainer(environment.name).stop(environment.name);
      } catch {
        // A shutdown path: an environment that will not stop is the operator's
        // problem to see in `ps`, not a reason to hang the server's exit.
      }
    }
  }
}

/**
 * The engine an administrator asked for.
 *
 * The only place in the feature that branches on which one it is: everything
 * downstream holds an `EnvironmentEngine` and cannot tell.
 */
export function createEngine(config: ContainerConfig): EnvironmentEngine {
  if (config.engine === 'kubernetes') {
    return new KubernetesEngine({
      context: config.kubernetes.context,
      namespace: config.kubernetes.namespace,
      storageClaim: config.kubernetes.storageClaim,
      serviceAccount: config.kubernetes.serviceAccount,
      rootDir: config.rootDir,
      kubeconfigPath: config.kubeconfigPath ?? null,
    });
  }
  return new ContainerEngine({ kind: config.engine, hostArgs: config.hostArgs });
}

/** The default root for per-user homes, matching where the rest of the data lives. */
export function defaultEnvironmentRoot(dataDir: string | null): string {
  const base = dataDir || path.join(process.env.HOME || '/tmp', '.code-agents-webcli');
  return path.join(base, 'environments');
}

export function ensureRoot(rootDir: string): void {
  fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
}
