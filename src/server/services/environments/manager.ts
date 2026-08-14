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
 *
 * This file is a thin facade over the `manager/` subfolder.
 */
export {
  MANAGED_LABEL,
  TIER_LABEL,
  USER_ID_LABEL,
  LOGIN_LABEL,
  TARGET_LABEL,
} from './manager/labels.js';
export {
  ActiveTargetResolution,
  EnvironmentManagerOptions,
  ReloadTargetsInput,
} from './manager/types.js';
export { HostCommandLaunch, wrapFlatpakHostCommand, wrapHostCommand } from './manager/host-command.js';
export { HostEnvironment } from './manager/host-environment.js';
export { ContainerEnvironment } from './manager/container-environment.js';
export { createEngine, defaultEnvironmentRoot, ensureRoot } from './manager/create-engine.js';
export { EnvironmentManager } from './manager/index.js';
