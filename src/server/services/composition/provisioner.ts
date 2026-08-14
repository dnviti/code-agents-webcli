/**
 * Provider-neutral project tooling provisioner.
 *
 * Every system boundary is injectable: target commands, the pinned artifact
 * catalog, downloads, and durable installation status.  Production can bind
 * those seams to an exact project container and SQLite; tests never need a
 * network or a container runtime.
 */

export {
  PINNED_MISE_ARTIFACTS,
  PINNED_TEA_ARTIFACTS,
  PINNED_TEA_VERSION,
  TEA_TMPFS_XDG_CONFIG_HOME,
  fetchPinnedMiseArtifact,
  fetchPinnedTeaArtifact,
} from './provisioner/artifacts.js';
export type {
  MiseArtifact,
  MiseArtifactFetcher,
  TeaArtifact,
  TeaArtifactFetcher,
} from './provisioner/artifacts.js';

export {
  APPROVED_TOOL_CATALOG,
} from './provisioner/installation.js';
export type {
  ApprovedTool,
  InstallationItem,
  InstallationRecord,
  InstallationStateStore,
  InstallationStatus,
  ProjectProvisionerOptions,
  ProvisionRequest,
  ProvisionResult,
} from './provisioner/installation.js';

export {
  withOwnerMiseMutationLock,
  withOwnerToolVersionLock,
} from './provisioner/locks.js';
export type {
  OwnerToolVersionLock,
} from './provisioner/locks.js';

export {
  probeTargetPlatform,
} from './provisioner/platform.js';
export type {
  CommandRunOptions,
  ContainerCommandRunner,
  TargetArchitecture,
  TargetLibc,
  TargetPlatform,
} from './provisioner/platform.js';
export {
  TargetCompatibilityError,
} from './provisioner/platform.js';

export {
  ProjectProvisioner,
} from './provisioner/project-provisioner.js';
