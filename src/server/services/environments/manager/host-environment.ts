import { WrapOptions, WrappedCommand, Mount, UserEnvironment } from '../types.js';
import {
  mergedEnv,
  wrapHostCommand,
  wrapFlatpakHostCommand,
  flatpakSpawnEnvironment,
} from './host-command.js';

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
    const baseEnv = options.inheritHostEnv === false
      ? { ...(options.env || {}) }
      : mergedEnv(options.env);
    const flatpakHost = Boolean(process.env.FLATPAK_ID) && process.platform === 'linux';
    const launch = flatpakHost
      ? wrapFlatpakHostCommand(command, args, options)
      : wrapHostCommand(command, args, process.platform, baseEnv);
    const { envPatch, ...processLaunch } = launch;
    return {
      ...processLaunch,
      env: flatpakHost
        ? flatpakSpawnEnvironment(baseEnv)
        : { ...baseEnv, ...(envPatch || {}) },
    };
  }
}
