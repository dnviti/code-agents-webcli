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
import { DEFAULT_TIERS, parseTiers } from './tiers.js';

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
  kubeContext?: string;
  kubeNamespace?: string;
  kubeStorageClaim?: string;
  kubeServiceAccount?: string;
  containerTiers?: string;
  containerDefaultTier?: string;
  containerUserTierChoice?: boolean;
}

/** Where the app's own code and its chat sockets land inside an environment. */
export const APP_MOUNT = '/opt/code-agents-webcli';
export const SOCKET_MOUNT = '/run/code-agents-webcli';

function parseEngine(value: string | undefined): ContainerEngineKind {
  if (value === 'podman' || value === 'kubernetes') {
    return value;
  }
  // `k8s` and `kube` are what people type; accepted rather than silently
  // falling back to docker, which would create containers on the wrong machine.
  if (value === 'k8s' || value === 'kube') {
    return 'kubernetes';
  }
  return 'docker';
}

export function createContainerConfig(
  input: ContainerConfigInput = {},
  env: NodeJS.ProcessEnv = process.env,
): ContainerConfig {
  const enabled = input.containers === true || env.CODE_AGENTS_WEBCLI_CONTAINERS === 'true';

  const cpus = input.containerCpus || env.CODE_AGENTS_WEBCLI_CONTAINER_CPUS || null;
  const memory = input.containerMemory || env.CODE_AGENTS_WEBCLI_CONTAINER_MEMORY || null;

  const tierSpec = input.containerTiers || env.CODE_AGENTS_WEBCLI_CONTAINER_TIERS || '';
  const parsed = tierSpec ? parseTiers(tierSpec) : [];

  // Three cases, and the order matters. An administrator who wrote a catalog
  // gets their catalog. One who set a flat limit and no catalog gets exactly
  // that limit as the only size — anything else would silently ignore a flag
  // that used to be the whole story, and hand out an environment of a size
  // nobody asked for. Only an installation that has configured neither gets the
  // stock ladder.
  const fixed = !parsed.length && (cpus || memory)
    ? [{ id: 'fixed', label: 'Fixed', cpus: cpus || '', memory: memory || '' }]
    : [];
  const tiers = parsed.length ? parsed : (fixed.length ? fixed : DEFAULT_TIERS);

  const idleRaw = input.containerIdleMinutes
    ?? Number(env.CODE_AGENTS_WEBCLI_CONTAINER_IDLE_MINUTES || '');
  const idleTimeoutMinutes = Number.isFinite(idleRaw) && Number(idleRaw) >= 0
    ? Number(idleRaw)
    : 0;

  return {
    enabled,
    engine: parseEngine(input.containerEngine || env.CODE_AGENTS_WEBCLI_CONTAINER_ENGINE),
    image: input.containerImage || env.CODE_AGENTS_WEBCLI_CONTAINER_IMAGE || DEFAULT_IMAGE,
    cpus,
    memory,
    idleTimeoutMinutes,
    rootDir: defaultEnvironmentRoot(input.dataDir ?? env.CODE_AGENTS_WEBCLI_DATA_DIR ?? null),
    namePrefix: DEFAULT_NAME_PREFIX,
    setupCommand:
      input.containerSetupCommand || env.CODE_AGENTS_WEBCLI_CONTAINER_SETUP || null,
    extraMounts: input.extraMounts || [],
    tiers,
    defaultTier: findDefaultTier(tiers, input.containerDefaultTier || env.CODE_AGENTS_WEBCLI_CONTAINER_DEFAULT_TIER),
    // On by default: the whole point of a catalog is that people pick from it.
    // An administrator who wants to size everyone centrally turns it off — and
    // a single fixed size is that decision already made, so there is nothing to
    // offer.
    allowUserTierChoice:
      fixed.length === 0
      && input.containerUserTierChoice !== false
      && env.CODE_AGENTS_WEBCLI_CONTAINER_USER_TIER_CHOICE !== 'false',
    kubernetes: {
      context: input.kubeContext || env.CODE_AGENTS_WEBCLI_KUBE_CONTEXT || null,
      namespace: input.kubeNamespace || env.CODE_AGENTS_WEBCLI_KUBE_NAMESPACE || 'default',
      storageClaim:
        input.kubeStorageClaim || env.CODE_AGENTS_WEBCLI_KUBE_STORAGE_CLAIM || 'cawc-environments',
      serviceAccount:
        input.kubeServiceAccount || env.CODE_AGENTS_WEBCLI_KUBE_SERVICE_ACCOUNT || null,
    },
  };
}

/** The configured default, or the middle of the catalog when none was named. */
function findDefaultTier(tiers: { id: string }[], requested: string | undefined): string {
  if (requested && tiers.some((tier) => tier.id === requested)) {
    return requested;
  }
  if (requested) {
    console.warn(`Unknown default environment tier "${requested}"; using the catalog's middle entry`);
  }
  // The middle rather than the first: a default at the bottom of the ladder
  // makes every new user's first impression the slowest one available.
  return tiers.length ? tiers[Math.floor((tiers.length - 1) / 2)].id : '';
}
