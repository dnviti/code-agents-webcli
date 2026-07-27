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
  env: Record<string, string>;
}

export interface ContainerDescription {
  name: string;
  status: string;
  image: string;
  labels: Record<string, string>;
}

export interface ExecSpec {
  name: string;
  cwd?: string;
  env?: Record<string, string>;
  tty?: boolean;
}

const defaultRunner: EngineRunner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolve({ stdout, stderr });
    });
  });

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

export class ContainerEngine {
  readonly kind: ContainerEngineKind;
  readonly binary: string;
  private readonly run: EngineRunner;
  private readonly relabel: boolean;
  private readonly uid: number;
  private readonly gid: number;

  constructor(options: {
    kind: ContainerEngineKind;
    runner?: EngineRunner;
    binary?: string;
    relabelMounts?: boolean;
    uid?: number;
    gid?: number;
  }) {
    this.kind = options.kind;
    this.binary = options.binary || options.kind;
    this.run = options.runner || defaultRunner;
    this.relabel = options.relabelMounts ?? selinuxEnforcing();
    // `process.getuid` is absent on Windows, where this feature does not apply.
    this.uid = options.uid ?? (process.getuid ? process.getuid() : 0);
    this.gid = options.gid ?? (process.getgid ? process.getgid() : 0);
  }

  /** Argv for creating and starting a detached environment. */
  createArgs(spec: CreateContainerSpec): string[] {
    const args = [
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
    const args = ['exec', '--interactive'];
    if (spec.tty) {
      args.push('--tty');
    }
    if (spec.cwd) {
      args.push('--workdir', spec.cwd);
    }
    for (const [key, value] of Object.entries(spec.env || {})) {
      args.push('--env', `${key}=${value}`);
    }
    args.push(spec.name, command, ...commandArgs);
    return args;
  }

  async create(spec: CreateContainerSpec): Promise<void> {
    await this.run(this.binary, this.createArgs(spec));
  }

  async start(name: string): Promise<void> {
    await this.run(this.binary, ['start', name]);
  }

  async stop(name: string): Promise<void> {
    await this.run(this.binary, ['stop', '--time', '5', name]);
  }

  async remove(name: string): Promise<void> {
    await this.run(this.binary, ['rm', '--force', name]);
  }

  /** `running`, `exited`, … or null when no such container exists. */
  async status(name: string): Promise<string | null> {
    try {
      const { stdout } = await this.run(this.binary, [
        'inspect', '--format', '{{.State.Status}}', name,
      ]);
      return stdout.trim() || null;
    } catch {
      return null;
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
  async describe(name: string): Promise<ContainerDescription | null> {
    try {
      const { stdout } = await this.run(this.binary, [
        'inspect', '--format', '{{.State.Status}}\t{{.Config.Image}}\t{{json .Config.Labels}}', name,
      ]);
      const [status, image, labelsJson] = stdout.trim().split('\t');
      let labels: Record<string, string> = {};
      try {
        labels = JSON.parse(labelsJson || '{}') || {};
      } catch {
        labels = {};
      }
      return { name, status: status || 'unknown', image: image || '', labels };
    } catch {
      return null;
    }
  }

  /** Run a one-shot command inside an environment and return its output. */
  async exec(spec: ExecSpec, command: string, commandArgs: string[]): Promise<RunResult> {
    return this.run(this.binary, this.execArgs(spec, command, commandArgs));
  }

  /** Names of every environment this server manages, running or not. */
  async list(label: string): Promise<string[]> {
    const { stdout } = await this.run(this.binary, [
      'ps', '--all',
      '--filter', `label=${label}`,
      '--format', '{{.Names}}',
    ]);
    return stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  }

  /** Whether the engine binary is present and answering. */
  async available(): Promise<boolean> {
    try {
      await this.run(this.binary, ['version', '--format', '{{.Client.Version}}']);
      return true;
    } catch {
      return false;
    }
  }
}
