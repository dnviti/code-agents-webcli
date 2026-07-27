/**
 * Reading the environment feature's settings.
 *
 * Kept apart from the server's own config so the defaults can be asserted on
 * their own: the single most important property of this feature is that an
 * installation which has not asked for it gets `enabled: false` and therefore
 * the host environment, and that is a property of *this* function.
 */

import { ContainerConfig, ContainerEngineKind, Mount } from './types.js';
import { defaultEnvironmentRoot } from './manager.js';

export const DEFAULT_IMAGE = 'docker.io/library/node:22-bookworm';
export const DEFAULT_NAME_PREFIX = 'cawc';

export interface ContainerConfigInput {
  containers?: boolean;
  containerEngine?: string;
  containerImage?: string;
  containerCpus?: string;
  containerMemory?: string;
  containerIdleMinutes?: number;
  containerSetupCommand?: string;
  dataDir?: string | null;
  extraMounts?: Mount[];
}

/** Where the app's own code and its chat sockets land inside an environment. */
export const APP_MOUNT = '/opt/code-agents-webcli';
export const SOCKET_MOUNT = '/run/code-agents-webcli';

function parseEngine(value: string | undefined): ContainerEngineKind {
  return value === 'podman' ? 'podman' : 'docker';
}

export function createContainerConfig(
  input: ContainerConfigInput = {},
  env: NodeJS.ProcessEnv = process.env,
): ContainerConfig {
  const enabled = input.containers === true || env.CODE_AGENTS_WEBCLI_CONTAINERS === 'true';

  const idleRaw = input.containerIdleMinutes
    ?? Number(env.CODE_AGENTS_WEBCLI_CONTAINER_IDLE_MINUTES || '');
  const idleTimeoutMinutes = Number.isFinite(idleRaw) && Number(idleRaw) >= 0
    ? Number(idleRaw)
    : 0;

  return {
    enabled,
    engine: parseEngine(input.containerEngine || env.CODE_AGENTS_WEBCLI_CONTAINER_ENGINE),
    image: input.containerImage || env.CODE_AGENTS_WEBCLI_CONTAINER_IMAGE || DEFAULT_IMAGE,
    cpus: input.containerCpus || env.CODE_AGENTS_WEBCLI_CONTAINER_CPUS || null,
    memory: input.containerMemory || env.CODE_AGENTS_WEBCLI_CONTAINER_MEMORY || null,
    idleTimeoutMinutes,
    rootDir: defaultEnvironmentRoot(input.dataDir ?? env.CODE_AGENTS_WEBCLI_DATA_DIR ?? null),
    namePrefix: DEFAULT_NAME_PREFIX,
    setupCommand:
      input.containerSetupCommand || env.CODE_AGENTS_WEBCLI_CONTAINER_SETUP || null,
    extraMounts: input.extraMounts || [],
  };
}
