import path from 'node:path';
import { EnvironmentEngine } from '../engine.js';
import { trackContainerProcess } from '../process-control.js';
import { WrapOptions, WrappedCommand, Mount, UserEnvironment } from '../types.js';
import { mergedEnv } from './host-command.js';

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
  /** Immutable engine/container identity; names may be reused after rebuild. */
  readonly identity: string;

  constructor(options: {
    name: string;
    homeDir: string;
    containerHome: string;
    engine: EnvironmentEngine;
    identity: string;
    shells?: readonly string[];
    mounts?: readonly Mount[];
  }) {
    this.name = options.name;
    this.homeDir = options.homeDir;
    this.containerHome = options.containerHome;
    this.engine = options.engine;
    this.identity = options.identity;
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
    let cwd = this.containerHome;
    if (options.cwd) {
      if (options.cwdKind === 'container') {
        if (options.cwd.includes('\0') || !path.posix.isAbsolute(options.cwd)) {
          throw new Error('Container cwd must be an absolute path');
        }
        cwd = path.posix.normalize(options.cwd);
      } else {
        cwd = this.toContainerPath(options.cwd);
      }
    }
    const tracked = options.trackProcess
      ? trackContainerProcess(
          this.engine,
          this.name,
          this.identity,
          command,
          args,
          options.tty === true,
        )
      : null;
    const execArgs = this.engine.execArgs(
      {
        name: this.name,
        identity: this.identity,
        cwd,
        env: options.env,
        tty: options.tty,
      },
      tracked?.command || command,
      tracked?.args || args,
    );
    // The spawn itself gets this process's environment: it is running the
    // engine client, not the user's program. Everything the user's program
    // should see was turned into `--env` flags above, which is also what keeps
    // the server's own secrets out of the container.
    return {
      command: this.engine.binary,
      args: execArgs,
      env: mergedEnv(),
      processControl: tracked?.processControl,
    };
  }
}
