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
import { ContainerEngine } from './engine.js';
import { containerHomeFor, environmentName } from './naming.js';
import {
  ContainerConfig,
  EnvironmentOwner,
  EnvironmentSummary,
  Mount,
  UserEnvironment,
  WrapOptions,
  WrappedCommand,
} from './types.js';

export const MANAGED_LABEL = 'com.code-agents-webcli.managed';
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
  private readonly engine: ContainerEngine;

  constructor(options: {
    name: string;
    homeDir: string;
    containerHome: string;
    engine: ContainerEngine;
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
  engine?: ContainerEngine;
  /** Home directory used in host mode. Defaults to the server's working directory. */
  hostHome: string;
  now?: () => number;
}

export class EnvironmentManager {
  private readonly config: ContainerConfig;
  private readonly engine: ContainerEngine;
  private readonly hostEnvironment: HostEnvironment;
  private readonly now: () => number;
  /** In-flight `ensureFor` calls, so two tabs signing in at once make one container. */
  private readonly pending = new Map<number, Promise<UserEnvironment>>();
  private readonly ready = new Map<number, ContainerEnvironment>();
  private readonly lastUsed = new Map<number, number>();

  constructor(options: EnvironmentManagerOptions) {
    this.config = options.config;
    this.engine = options.engine || new ContainerEngine({ kind: options.config.engine });
    this.hostEnvironment = new HostEnvironment(options.hostHome);
    this.now = options.now || (() => Date.now());
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

    const status = await this.engine.status(name);
    let created = false;

    if (!status) {
      await this.engine.create({
        name,
        image: this.config.image,
        mounts,
        containerHome,
        cpus: this.config.cpus,
        memory: this.config.memory,
        labels: {
          [MANAGED_LABEL]: 'true',
          [USER_ID_LABEL]: String(owner.id),
          [LOGIN_LABEL]: owner.githubLogin,
        },
        env: {
          HOME: containerHome,
          USER: owner.githubLogin,
          TERM: 'xterm-256color',
        },
      });
      created = true;
    } else if (status !== 'running') {
      await this.engine.start(name);
    }

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

/** The default root for per-user homes, matching where the rest of the data lives. */
export function defaultEnvironmentRoot(dataDir: string | null): string {
  const base = dataDir || path.join(process.env.HOME || '/tmp', '.code-agents-webcli');
  return path.join(base, 'environments');
}

export function ensureRoot(rootDir: string): void {
  fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
}
