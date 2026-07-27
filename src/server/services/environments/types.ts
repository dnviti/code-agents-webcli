/**
 * Per-user isolated environments: the shapes the rest of the server sees.
 *
 * The whole feature reduces to one question at every call site — "where does
 * this process run?" — so the handle the rest of the server gets is deliberately
 * small: a home directory, a path translation, and a command transformer. Host
 * mode implements all three as the identity, which is what makes "feature
 * disabled behaves exactly as today" true by construction rather than by
 * inspection of every branch.
 */

/**
 * What drives the environments.
 *
 * `docker` and `podman` place a container on this machine; `kubernetes` asks a
 * cluster to schedule a Pod. The rest of the server cannot tell the difference:
 * all three answer the same small interface.
 */
export type ContainerEngineKind = 'docker' | 'podman' | 'kubernetes';

export interface ContainerConfig {
  /** Off by default. Nothing in this module runs unless an administrator opts in. */
  enabled: boolean;
  engine: ContainerEngineKind;
  /** Base image every environment starts from. */
  image: string;
  /** `--cpus` value, or null for unlimited. */
  cpus: string | null;
  /** `--memory` value (e.g. `2g`), or null for unlimited. */
  memory: string | null;
  /**
   * Stop an environment after this many minutes with no activity; 0 disables
   * idle stopping. Data lives on the host, so a stop is never lossy.
   */
  idleTimeoutMinutes: number;
  /** Where per-user home directories live on the host. */
  rootDir: string;
  /** Prefix for every container this server creates. */
  namePrefix: string;
  /**
   * Shell run once, inside a freshly created environment, to install whatever
   * the administrator wants preinstalled. Never run again for an environment
   * that already exists.
   */
  setupCommand: string | null;
  /**
   * Host directories every environment gets besides the user's home.
   *
   * This is how the approval hook and the question channel keep working inside
   * a container: both are host-side files reached by a host-side unix socket,
   * and the runtime running in the container has to be able to open them.
   * Empty by default, so the module stays usable without them.
   */
  extraMounts: Mount[];
  /** Only read when `engine` is `kubernetes`. */
  kubernetes: KubernetesConfig;
  /**
   * The sizes this installation is willing to hand out, in order.
   *
   * Order is meaningful: automatic sizing steps along this list, so the
   * administrator's sequence is the ladder.
   */
  tiers: EnvironmentTier[];
  /** Which of them a user who has never chosen gets. */
  defaultTier: string;
  /** Whether a user may choose their own size at all. */
  allowUserTierChoice: boolean;
}

/**
 * One size an environment may be built at.
 *
 * Declared here rather than beside the scaling logic so the config type does
 * not have to import it back from a module that imports the config.
 */
export interface EnvironmentTier {
  id: string;
  label: string;
  /** Cores, as the engines spell them: `1`, `0.5`, `2`. */
  cpus: string;
  /** `2g`, `512m`. Translated per engine at the point of use. */
  memory: string;
}

export interface KubernetesConfig {
  /** kubectl context. Null means whatever kubectl is pointed at, which an administrator must choose deliberately. */
  context: string | null;
  namespace: string;
  /** The ReadWriteMany claim holding every user's home. */
  storageClaim: string;
  serviceAccount: string | null;
}

export interface Mount {
  hostPath: string;
  containerPath: string;
  readOnly?: boolean;
}

export interface EnvironmentOwner {
  id: number;
  githubLogin: string;
}

export interface WrappedCommand {
  command: string;
  args: string[];
  /** The environment the *spawn* gets — not the environment the program sees. */
  env: Record<string, string>;
}

export interface WrapOptions {
  cwd?: string;
  /** Variables the program should see. In container mode these become `-e` flags. */
  env?: Record<string, string>;
  /** Whether the wrapped process needs a TTY (`exec -t`). PTY spawns do; pipes do not. */
  tty?: boolean;
}

/**
 * Where one user's processes run and where their files live.
 *
 * `homeDir` is always a *host* path: the file browser, editor, uploads and git
 * keep using ordinary `fs`, because the container's home is a bind mount of that
 * directory rather than a copy inside an image layer.
 */
export interface UserEnvironment {
  readonly kind: 'host' | 'container';
  /** Container name, or null on the host. */
  readonly name: string | null;
  /** The user's workspace root, on the host filesystem. */
  readonly homeDir: string;
  /** The same directory as seen from inside; equal to `homeDir` on the host. */
  readonly containerHome: string;
  /**
   * Interactive shells known to exist *in this environment*, most preferred
   * first. Empty on the host, where the existing candidate search — which reads
   * `$SHELL` and probes real host paths — is still the right answer.
   *
   * A container's shells cannot be inferred from the host: `/bin/zsh` existing
   * here says nothing about an image that ships only `sh`, and a terminal
   * launched at a path that is not there dies on the first byte with an error
   * the user cannot act on.
   */
  readonly shells: readonly string[];
  /**
   * Every host directory this environment can see, home first.
   *
   * Not only the user's home: the approval hook and the question channel are
   * host-side files and a host-side unix socket that the *runtime* has to
   * reach, so they are mounted too and translated through the same lookup.
   * Empty on the host, where nothing needs translating.
   */
  readonly mounts: readonly Mount[];
  /**
   * The Node binary as this environment can reach it. `process.execPath` on the
   * host; a bare `node` in a container, resolved through the image's PATH.
   */
  readonly nodePath: string;
  toContainerPath(hostPath: string): string;
  toHostPath(containerPath: string): string;
  wrap(command: string, args: string[], options?: WrapOptions): WrappedCommand;
}

export interface EnvironmentSummary {
  name: string;
  userId: number | null;
  githubLogin: string | null;
  status: string;
  image: string;
  homeDir: string;
}
