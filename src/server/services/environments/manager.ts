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
import { containerHomeFor, environmentName } from './naming.js';
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

  constructor(options: EnvironmentManagerOptions) {
    this.config = options.config;
    this.engine = options.engine || createEngine(options.config);
    this.hostEnvironment = new HostEnvironment(options.hostHome);
    this.now = options.now || (() => Date.now());
    this.getUserTier = options.getUserTier || (() => null);
  }

  /** The catalog an administrator defined, in ladder order. */
  get tiers(): EnvironmentTier[] {
    return this.config.tiers;
  }

  get defaultTierId(): string {
    return this.config.defaultTier;
  }

  get userTierChoiceAllowed(): boolean {
    return this.config.allowUserTierChoice;
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
    return resolveTier(
      this.config.tiers,
      this.getUserTier(userId),
      this.config.defaultTier,
      this.autoTier.get(userId),
    );
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  /** The environment used when the feature is off, and the fallback when it fails. */
  host(): UserEnvironment {
    return this.hostEnvironment;
  }

  /** Whether the configured engine is installed and answering. */
  async engineAvailable(): Promise<boolean> {
    return this.engine.available();
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
    if (!this.config.enabled) {
      return this.hostEnvironment;
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
          await this.engine.stop(running.name);
        } catch (error) {
          console.error(`Environment ${running.name}: could not replace for a size change:`, error);
        }
        this.ready.delete(owner.id);
      }
      this.pendingRebuild.delete(owner.id);
    }

    const work = this.provision(owner).finally(() => {
      this.pending.delete(owner.id);
    });
    this.pending.set(owner.id, work);
    return work;
  }

  /** The environment already prepared for this user, without preparing one. */
  existing(userId: number): UserEnvironment | null {
    if (!this.config.enabled) {
      return this.hostEnvironment;
    }
    return this.ready.get(userId) || null;
  }

  /** Record activity, so an idle sweep does not stop an environment in use. */
  touch(userId: number): void {
    this.lastUsed.set(userId, this.now());
  }

  private async provision(owner: EnvironmentOwner): Promise<UserEnvironment> {
    const name = this.nameFor(owner);
    const homeDir = this.homeDirFor(owner);
    const containerHome = containerHomeFor(owner);

    // 0700: the isolation claim has to hold on the host too, not only inside
    // the container. Created before the container so the bind mount never
    // brings a root-owned directory into being.
    await fsp.mkdir(homeDir, { recursive: true, mode: 0o700 });
    await fsp.chmod(homeDir, 0o700);

    const mounts: Mount[] = [
      { hostPath: homeDir, containerPath: containerHome },
      ...this.config.extraMounts,
    ];

    // The tier decides the limits; the flat `--container-cpus`/`--container-memory`
    // remain as the answer for an installation that wants one size for everyone
    // and has emptied the catalog.
    const tier = this.intendedTierFor(owner.id);

    const { created } = await this.engine.ensure({
      name,
      image: this.config.image,
      mounts,
      containerHome,
      cpus: tier ? tier.cpus : this.config.cpus,
      memory: tier ? tier.memory : this.config.memory,
      labels: {
        [MANAGED_LABEL]: 'true',
        [USER_ID_LABEL]: String(owner.id),
        [LOGIN_LABEL]: owner.githubLogin,
        ...(tier ? { [TIER_LABEL]: tier.id } : {}),
      },
      env: {
        HOME: containerHome,
        USER: owner.githubLogin,
        TERM: 'xterm-256color',
      },
    });

    if (created && this.config.setupCommand) {
      // Per creation, not per user: a setup command installs into the image's
      // filesystem, which is exactly the half that a rebuild throws away.
      // Failure is reported and tolerated — an environment without the extras
      // is still a usable environment.
      try {
        await this.engine.exec(
          { name, cwd: containerHome, env: { HOME: containerHome } },
          'sh',
          ['-c', this.config.setupCommand],
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
      engine: this.engine,
      shells: await this.probeShells(name),
      mounts,
    });

    this.ready.set(owner.id, environment);
    if (tier) {
      this.appliedTier.set(owner.id, tier);
    }
    this.pendingRebuild.delete(owner.id);
    this.lastUsed.set(owner.id, this.now());
    return environment;
  }

  /**
   * Which of the shells this app supports actually exist in an image.
   *
   * One exec at creation rather than a probe per terminal start, and ordered by
   * preference so the caller can take the first. `sh` is appended unconditionally
   * as the last resort: a container without it could not have run the probe.
   */
  private async probeShells(name: string): Promise<string[]> {
    try {
      const { stdout } = await this.engine.exec({ name }, 'sh', [
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
    const minutes = this.config.idleTimeoutMinutes;
    if (!this.config.enabled || minutes <= 0) {
      return [];
    }

    const cutoff = this.now() - minutes * 60_000;
    const stopped: string[] = [];

    for (const [userId, environment] of [...this.ready]) {
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
        const status = await this.engine.status(environment.name);
        if (status === 'running') {
          await this.engine.stop(environment.name);
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

  /** Every environment this server manages, running or not. */
  async list(): Promise<EnvironmentSummary[]> {
    const names = await this.engine.list(`${MANAGED_LABEL}=true`);
    const summaries: EnvironmentSummary[] = [];

    for (const name of names) {
      const described = await this.engine.describe(name);
      const labels = described?.labels || {};
      const userId = Number(labels[USER_ID_LABEL]);
      summaries.push({
        name,
        userId: Number.isFinite(userId) && labels[USER_ID_LABEL] ? userId : null,
        githubLogin: labels[LOGIN_LABEL] || null,
        status: described?.status || 'unknown',
        image: described?.image || '',
        homeDir: path.join(this.config.rootDir, name),
      });
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
    await this.engine.remove(name);

    for (const [userId, environment] of [...this.ready]) {
      if (environment.name === name) {
        this.ready.delete(userId);
      }
    }

    if (options.purgeData) {
      const home = path.join(this.config.rootDir, name);
      // Guarded against a name that would resolve outside the root — the only
      // caller is an operator command, but a `..` here would delete the wrong
      // tree.
      const resolved = path.resolve(home);
      if (resolved.startsWith(`${path.resolve(this.config.rootDir)}${path.sep}`)) {
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
      return await this.engine.usage(environment.name);
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

    try {
      if (await this.engine.resize(environment.name, tier.cpus, tier.memory)) {
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

    await this.engine.stop(environment.name);
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
    if (!this.config.enabled || !this.config.tiers.length) {
      return [];
    }

    const changes = [];

    for (const [userId, environment] of [...this.ready]) {
      if (this.getUserTier(userId) !== AUTO_TIER) {
        continue;
      }

      const current = this.appliedTier.get(userId)
        || findTier(this.config.tiers, this.config.defaultTier)
        || this.config.tiers[0];

      let sample = null;
      try {
        sample = await this.engine.usage(environment.name);
      } catch {
        sample = null;
      }

      const decision = decideAutoTier({
        tiers: this.config.tiers,
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
    await this.engine.stop(environment.name);
    this.ready.delete(userId);
    return true;
  }

  /** Stop everything this server started, without touching any data. */
  async stopAll(): Promise<void> {
    for (const environment of this.ready.values()) {
      try {
        await this.engine.stop(environment.name);
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
    });
  }
  return new ContainerEngine({ kind: config.engine });
}

/** The default root for per-user homes, matching where the rest of the data lives. */
export function defaultEnvironmentRoot(dataDir: string | null): string {
  const base = dataDir || path.join(process.env.HOME || '/tmp', '.code-agents-webcli');
  return path.join(base, 'environments');
}

export function ensureRoot(rootDir: string): void {
  fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
}
