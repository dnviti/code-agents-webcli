/**
 * The container engine, as the rest of this feature needs it.
 *
 * Docker and Podman are near-identical at the command line, and the differences
 * that matter here are few enough to name: Podman rootless needs
 * `--userns=keep-id` for a bind-mounted home to come back out owned by the host
 * user, and Docker has no such flag. Everything else is shared, which is why
 * this is one class with two argv tweaks rather than two implementations.
 *
 * No shell is ever involved: every call is `execFile` with an argv array, so a
 * login, an image name or a setup command can never be read as shell syntax.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { ContainerEngineKind, Mount } from './types.js';

export interface RunResult {
  stdout: string;
  stderr: string;
}

export type EngineRunner = (
  file: string,
  args: string[],
  /** Written to the child's stdin and closed. Used to feed manifests to `kubectl apply`. */
  input?: string,
  /** Cancels the underlying engine client process, not only its awaiting caller. */
  signal?: AbortSignal,
) => Promise<RunResult>;

export interface CreateContainerSpec {
  name: string;
  image: string;
  /** Bind mounts, the user's home first. */
  mounts: Mount[];
  /** The directory the environment starts in. */
  containerHome: string;
  cpus: string | null;
  memory: string | null;
  labels: Record<string, string>;
  /** Labels whose exact values must match before an existing object is adopted. */
  identityLabels?: readonly string[];
  env: Record<string, string>;
}

export interface ContainerDescription {
  name: string;
  /** Immutable Docker/Podman container ID or Kubernetes Pod UID. */
  identity: string;
  status: string;
  image: string;
  labels: Record<string, string>;
}

export interface ExecSpec {
  name: string;
  /** Prefer this immutable identity when the engine supports it. */
  identity?: string;
  cwd?: string;
  env?: Record<string, string>;
  tty?: boolean;
  signal?: AbortSignal;
}

/** What one environment is currently consuming, as far as the engine can say. */
export interface ResourceUsage {
  /** Cores in use — `1.5` means one and a half cores, not 150% of the limit. */
  cpuCores: number;
  memoryBytes: number;
}

/**
 * What the manager needs of an engine, and nothing more.
 *
 * Written as an interface rather than a base class because the two
 * implementations share no code worth inheriting: one drives a container
 * runtime through `docker`/`podman`, the other drives an API server through
 * `kubectl`, and the only thing they genuinely have in common is this list.
 */
export interface EnvironmentEngine {
  readonly kind: ContainerEngineKind;
  /**
   * Bring an environment into existence and into a usable state, whatever
   * state it was in.
   *
   * One call rather than the manager reasoning about statuses, because the
   * reasoning is engine-specific and getting it wrong is silent: a container
   * that exists but is stopped is *started*, while a Pod that exists but has
   * failed cannot be started at all and has to be replaced. Reports whether it
   * had to build a new one, which is what decides if the setup command runs.
   */
  ensure(spec: CreateContainerSpec): Promise<{ created: boolean }>;
  /**
   * Project-safe ensure: the name must still resolve to this exact identity.
   * The returned identity is the one created or retained by this operation,
   * so a caller can reject a delete/recreate race before issuing any command.
   */
  ensureIdentity(spec: CreateContainerSpec, expected: ContainerDescription | null): Promise<{ created: boolean; identity: string }>;
  create(spec: CreateContainerSpec): Promise<void>;
  start(name: string): Promise<void>;
  stop(name: string): Promise<void>;
  remove(name: string): Promise<void>;
  stopIdentity(description: ContainerDescription): Promise<void>;
  removeIdentity(description: ContainerDescription): Promise<void>;
  status(name: string): Promise<string | null>;
  /**
   * Describe one exact object, returning null only when it does not exist.
   * Transport, authentication and parse failures are errors, never absence.
   */
  describeStrict(name: string): Promise<ContainerDescription | null>;
  /** Best-effort description for operator/status views. */
  describe(name: string): Promise<ContainerDescription | null>;
  exec(spec: ExecSpec, command: string, commandArgs: string[]): Promise<RunResult>;
  /** Argv for running a command inside an environment, for pty and pipe spawns alike. */
  execArgs(spec: ExecSpec, command: string, commandArgs: string[]): string[];
  /** The binary a wrapped command is spawned as. */
  readonly binary: string;
  list(label: string): Promise<string[]>;
  available(): Promise<boolean>;
  /**
   * Change an environment's limits without recreating it.
   *
   * Returns false when this engine cannot: the caller then rebuilds, which is
   * lossless but interrupts, so the difference decides whether a user's tier
   * change applies now or once they are idle.
   */
  resize(name: string, cpus: string | null, memory: string | null): Promise<boolean>;
  /** Current consumption, or null when the engine cannot report it. */
  usage(name: string): Promise<ResourceUsage | null>;
}

/** Docker/Podman states in which the container cannot execute user work. */
const QUIESCENT_CONTAINER_STATES = new Set([
  'configured', 'created', 'dead', 'exited', 'initialized', 'stopped',
]);

export function isQuiescentContainerStatus(status: string): boolean {
  return QUIESCENT_CONTAINER_STATES.has(status.toLowerCase());
}

export const defaultRunner: EngineRunner = (file, args, input, signal) =>
  new Promise((resolve, reject) => {
    const child = execFile(file, args, { maxBuffer: 8 * 1024 * 1024, signal }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolve({ stdout, stderr });
    });

    if (input !== undefined) {
      child.stdin?.end(input);
    }
  });

/** Inspection failed for a reason other than a confirmed native not-found. */
export class EnvironmentInspectionError extends Error {}

export function validateIdentityLabels(
  spec: CreateContainerSpec,
  described: ContainerDescription,
): void {
  for (const key of spec.identityLabels || []) {
    if (described.labels[key] !== spec.labels[key]) {
      throw new Error(
        `environment '${spec.name}' has an incompatible ownership label '${key}'`,
      );
    }
  }
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error || '');
  }
  const detail = error as Error & { stdout?: unknown; stderr?: unknown };
  return [error.message, detail.stdout, detail.stderr]
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
}

function containerObjectMissing(error: unknown): boolean {
  return /no such (?:object|container)|no container with name or id/i.test(errorText(error));
}

/**
 * Whether bind mounts need an SELinux relabel suffix.
 *
 * On an enforcing system (Fedora, RHEL and their derivatives) a bind mount
 * without `:Z` is readable inside the container only until the first denial;
 * on every other system the suffix is accepted and ignored. Detected rather
 * than assumed so the argv stays minimal where it can.
 */
export function selinuxEnforcing(readFile: (p: string) => string = (p) => fs.readFileSync(p, 'utf8')): boolean {
  try {
    return readFile('/sys/fs/selinux/enforce').trim() === '1';
  } catch {
    return false;
  }
}

export class ContainerEngine implements EnvironmentEngine {
  readonly kind: ContainerEngineKind;
  readonly binary: string;
  private readonly run: EngineRunner;
  private readonly relabel: boolean;
  private readonly uid: number;
  private readonly gid: number;
  private readonly hostArgs: string[];

  constructor(options: {
    kind: ContainerEngineKind;
    runner?: EngineRunner;
    binary?: string;
    relabelMounts?: boolean;
    uid?: number;
    gid?: number;
    /**
     * Arguments prepended to every docker/podman invocation. Used for remote
     * hosts (`-H <host>`) and TLS material (`--tlscacert`, ...).
     */
    hostArgs?: string[];
  }) {
    this.kind = options.kind;
    this.binary = options.binary || options.kind;
    this.run = options.runner || defaultRunner;
    this.relabel = options.relabelMounts ?? selinuxEnforcing();
    // `process.getuid` is absent on Windows, where this feature does not apply.
    this.uid = options.uid ?? (process.getuid ? process.getuid() : 0);
    this.gid = options.gid ?? (process.getgid ? process.getgid() : 0);
    this.hostArgs = options.hostArgs || [];
  }

  /** Argv for creating and starting a detached environment. */
  createArgs(spec: CreateContainerSpec): string[] {
    const args = [
      ...this.hostArgs,
      'run',
      '--detach',
      '--name', spec.name,
      '--hostname', spec.name,
      '--user', `${this.uid}:${this.gid}`,
    ];

    // Rootless Podman maps the host user to container root by default, which
    // would leave every file the user creates owned by a subordinate uid on the
    // host. keep-id maps it to itself instead, so the bind mount stays readable
    // and writable from both sides.
    if (this.kind === 'podman') {
      args.push('--userns=keep-id');
    }

    for (const [key, value] of Object.entries(spec.labels)) {
      args.push('--label', `${key}=${value}`);
    }
    for (const [key, value] of Object.entries(spec.env)) {
      args.push('--env', `${key}=${value}`);
    }

    for (const mount of spec.mounts) {
      // `z` (shared) rather than `Z` (private) for read-only mounts: the app's
      // own directory is mounted into every user's environment, and a private
      // label would relabel it for whichever container was created last,
      // breaking it for all the others.
      const suffixes = [
        mount.readOnly ? 'ro' : null,
        this.relabel ? (mount.readOnly ? 'z' : 'Z') : null,
      ].filter(Boolean);
      const spec_ = `${mount.hostPath}:${mount.containerPath}${suffixes.length ? `:${suffixes.join(',')}` : ''}`;
      args.push('--volume', spec_);
    }

    args.push('--workdir', spec.containerHome);

    if (spec.cpus) {
      args.push('--cpus', spec.cpus);
    }
    if (spec.memory) {
      args.push('--memory', spec.memory);
    }

    // The image's own entrypoint is displaced: an environment is a place to run
    // commands in, not a service, and an image whose entrypoint exits would
    // otherwise take the environment down with it. The loop rather than
    // `sleep infinity` because the latter is a GNU extension.
    args.push(
      '--entrypoint', 'sh',
      spec.image,
      '-c', 'while true; do sleep 3600; done',
    );

    return args;
  }

  /** Argv prefix that runs a command inside an existing environment. */
  execArgs(spec: ExecSpec, command: string, commandArgs: string[]): string[] {
    const args = [...this.hostArgs, 'exec', '--interactive'];
    if (spec.tty) {
      args.push('--tty');
    }
    if (spec.cwd) {
      args.push('--workdir', spec.cwd);
    }
    for (const [key, value] of Object.entries(spec.env || {})) {
      args.push('--env', `${key}=${value}`);
    }
    args.push(spec.identity || spec.name, command, ...commandArgs);
    return args;
  }

  async ensure(spec: CreateContainerSpec): Promise<{ created: boolean }> {
    const described = await this.describeStrict(spec.name);
    if (!described) {
      await this.create(spec);
      return { created: true };
    }
    validateIdentityLabels(spec, described);
    if (described.status !== 'running') {
      await this.start(spec.name);
    }
    return { created: false };
  }

  async ensureIdentity(spec: CreateContainerSpec, expected: ContainerDescription | null): Promise<{ created: boolean; identity: string }> {
    const current = await this.describeStrict(spec.name);
    if (expected) {
      if (!current || current.identity !== expected.identity) {
        throw new EnvironmentInspectionError(`container '${spec.name}' was replaced before ensure`);
      }
      validateIdentityLabels(spec, current);
      if (current.status !== 'running') {
        await this.run(this.binary, [...this.hostArgs, 'start', expected.identity]);
        const after = await this.describeStrict(spec.name);
        if (!after || after.identity !== expected.identity || after.status !== 'running') {
          throw new EnvironmentInspectionError(`container '${spec.name}' changed identity or did not start`);
        }
      }
      return { created: false, identity: expected.identity };
    }
    if (current) throw new EnvironmentInspectionError(`container '${spec.name}' appeared before creation`);
    const { stdout } = await this.run(this.binary, this.createArgs(spec));
    const identity = stdout.trim().split(/\s+/)[0] || '';
    if (!identity) {
      throw new EnvironmentInspectionError(`container '${spec.name}' was created without a verifiable identity`);
    }
    const created = await this.describeStrict(spec.name);
    if (!created || created.identity !== identity || created.status !== 'running') {
      throw new EnvironmentInspectionError(`container '${spec.name}' changed identity or did not start after creation`);
    }
    validateIdentityLabels(spec, created);
    return { created: true, identity };
  }

  async create(spec: CreateContainerSpec): Promise<void> {
    await this.run(this.binary, this.createArgs(spec));
  }

  async start(name: string): Promise<void> {
    await this.run(this.binary, [...this.hostArgs, 'start', name]);
  }

  async stop(name: string): Promise<void> {
    await this.run(this.binary, [...this.hostArgs, 'stop', '--time', '5', name]);
  }

  async remove(name: string): Promise<void> {
    await this.run(this.binary, [...this.hostArgs, 'rm', '--force', name]);
  }

  async stopIdentity(description: ContainerDescription): Promise<void> {
    try {
      await this.run(this.binary, [...this.hostArgs, 'stop', '--time', '5', description.identity]);
    } catch (error) {
      if (!/no such (?:object|container)/i.test(errorText(error))) throw error;
    }
    const after = await this.describeStrict(description.name);
    if (!after) return;
    if (after.identity !== description.identity) throw new EnvironmentInspectionError(`container '${description.name}' was replaced during stop`);
    if (!isQuiescentContainerStatus(after.status)) {
      throw new EnvironmentInspectionError(
        `container '${description.name}' is still potentially executable after stop (${after.status})`,
      );
    }
  }

  async removeIdentity(description: ContainerDescription): Promise<void> {
    try {
      await this.run(this.binary, [...this.hostArgs, 'rm', '--force', description.identity]);
    } catch (error) {
      if (!/no such (?:object|container)/i.test(errorText(error))) throw error;
    }
    const after = await this.describeStrict(description.name);
    if (!after) return;
    if (after.identity !== description.identity) throw new EnvironmentInspectionError(`container '${description.name}' was replaced during removal`);
    throw new EnvironmentInspectionError(`container '${description.name}' still exists after removal`);
  }

  /** `running`, `exited`, … or null when no such container exists. */
  async status(name: string): Promise<string | null> {
    try {
      const { stdout } = await this.run(this.binary, [
        ...this.hostArgs,
        'container', 'inspect', '--format', '{{.State.Status}}', name,
      ]);
      const status = stdout.trim();
      if (!status) throw new EnvironmentInspectionError(`malformed status response for '${name}'`);
      return status;
    } catch (error) {
      if (/no such (?:object|container)/i.test(errorText(error))) return null;
      if (error instanceof EnvironmentInspectionError) throw error;
      throw new EnvironmentInspectionError(`could not inspect status for '${name}': ${errorText(error).trim()}`);
    }
  }

  /**
   * Status, image and labels for one environment.
   *
   * Read through `inspect` rather than off a `ps` row because the two engines
   * disagree about how `{{.Labels}}` prints: Docker emits `k=v,k=v`, Podman
   * emits Go's `map[k:v k:v]`. `inspect` with an explicit `json` template says
   * the same thing on both.
   */
  async describeStrict(name: string): Promise<ContainerDescription | null> {
    try {
      const { stdout } = await this.run(this.binary, [
        ...this.hostArgs,
        'container', 'inspect', '--format',
        '{{.Id}}\t{{.State.Status}}\t{{.Config.Image}}\t{{json .Config.Labels}}', name,
      ]);
      const fields = stdout.trim().split('\t');
      if (fields.length !== 4 || !fields[0] || !fields[1]) {
        throw new EnvironmentInspectionError(`malformed inspection response for '${name}'`);
      }
      const [identity, status, image, labelsJson] = fields;
      let labels: Record<string, string>;
      try {
        labels = JSON.parse(labelsJson || '{}') || {};
        if (typeof labels !== 'object' || Array.isArray(labels)) {
          throw new Error('labels are not an object');
        }
      } catch (error) {
        throw new EnvironmentInspectionError(
          `malformed labels for '${name}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return { name, identity, status, image: image || '', labels };
    } catch (error) {
      if (containerObjectMissing(error)) return null;
      if (error instanceof EnvironmentInspectionError) throw error;
      throw new EnvironmentInspectionError(
        `could not inspect container '${name}': ${errorText(error).trim()}`,
      );
    }
  }

  async describe(name: string): Promise<ContainerDescription | null> {
    try {
      return await this.describeStrict(name);
    } catch {
      return null;
    }
  }

  /** Run a one-shot command inside an environment and return its output. */
  async exec(spec: ExecSpec, command: string, commandArgs: string[]): Promise<RunResult> {
    return this.run(this.binary, this.execArgs(spec, command, commandArgs), undefined, spec.signal);
  }

  /** Names of every environment this server manages, running or not. */
  async list(label: string): Promise<string[]> {
    const { stdout } = await this.run(this.binary, [
      ...this.hostArgs,
      'ps', '--all',
      '--filter', `label=${label}`,
      '--format', '{{.Names}}',
    ]);
    return stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  }

  /**
   * Change the limits of a running container in place.
   *
   * Both engines can do this without a restart, which is the difference
   * between a tier change the user sees immediately and one that has to wait
   * for their agent to finish.
   */
  async resize(name: string, cpus: string | null, memory: string | null): Promise<boolean> {
    const args = [...this.hostArgs, 'update'];
    if (cpus) {
      args.push('--cpus', cpus);
    }
    if (memory) {
      args.push('--memory', memory);
      // Without a matching swap limit Docker refuses the change on hosts where
      // swap accounting is on, and Podman quietly leaves swap at the old value.
      args.push('--memory-swap', memory);
    }
    if (args.length === 1) {
      return true;
    }
    args.push(name);
    await this.run(this.binary, args);
    return true;
  }

  /**
   * What the container is using right now.
   *
   * `--no-stream` so this is one sample rather than a subscription; the caller
   * is polling on its own schedule and a stream would outlive the question.
   */
  async usage(name: string): Promise<ResourceUsage | null> {
    try {
      const { stdout } = await this.run(this.binary, [
        ...this.hostArgs,
        'stats', '--no-stream', '--format', '{{.CPUPerc}}\t{{.MemUsage}}', name,
      ]);
      const [cpuPerc, memUsage] = stdout.trim().split('\t');
      const cpu = Number.parseFloat((cpuPerc || '').replace('%', ''));
      const memory = parseSize((memUsage || '').split('/')[0]);
      if (!Number.isFinite(cpu) || memory === null) {
        return null;
      }
      // `stats` reports a percentage of one core, so 250% is 2.5 cores.
      return { cpuCores: cpu / 100, memoryBytes: memory };
    } catch {
      return null;
    }
  }

  /** Whether the engine binary is present and answering. */
  async available(): Promise<boolean> {
    try {
      await this.run(this.binary, [...this.hostArgs, 'version', '--format', '{{.Client.Version}}']);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * `1.5GiB`, `512MB`, `2g` → bytes.
 *
 * Both engines print human sizes in `stats` and accept them in `--memory`, and
 * the two spellings differ (`GiB` out, `g` in), so one parser serves both
 * directions. Binary units throughout: that is what the engines mean by `g`.
 */
export function parseSize(raw: string): number | null {
  const match = /^\s*([0-9]*\.?[0-9]+)\s*([a-zA-Z]*)\s*$/.exec(raw || '');
  if (!match) {
    return null;
  }
  const value = Number.parseFloat(match[1]);
  // Both `GiB` (what the container engines print) and `Gi` (what Kubernetes
  // prints) reduce to `g`. Stripping only a trailing `b` left `Mi` unmatched,
  // which read every Kubernetes memory figure as unparseable — and an
  // unparseable figure is a missing sample, so automatic sizing silently never
  // moved on a cluster.
  const unit = match[2].toLowerCase().replace(/[ib]+$/, '');
  const scale: Record<string, number> = {
    '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4,
  };
  const factor = scale[unit];
  return factor === undefined || !Number.isFinite(value) ? null : value * factor;
}
