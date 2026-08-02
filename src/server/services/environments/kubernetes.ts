/**
 * The same environment, scheduled by Kubernetes.
 *
 * Driven through `kubectl` rather than a client library. The exec model is
 * identical to `docker exec` — a long-lived thing you run commands in — so the
 * command transformer the rest of the server already goes through keeps
 * working unchanged, and it adds no dependency to a package that deliberately
 * ships without install scripts.
 *
 * Three differences from a container runtime are load-bearing:
 *
 * 1. **A Pod cannot be started.** `docker start` brings a stopped container
 *    back with its filesystem; a Pod that has stopped is finished, and the only
 *    way back is a new one. That is safe here for the same reason a rebuild is
 *    safe everywhere else in this feature — the user's home is on a volume, not
 *    in the pod — but it means `stop` is a delete and `ensure` is what callers
 *    use.
 * 2. **`kubectl exec` has neither `--workdir` nor `--env`.** Both are applied
 *    by the argv the pod runs (a `cd` in a shell that receives the directory as
 *    a positional parameter, then `env`), never by a shell string built from
 *    user input.
 * 3. **The home is a subPath of one shared claim**, not a bind mount. The
 *    server mounts the same claim at the environments root, which is what keeps
 *    the file browser, editor and uploads on ordinary `fs` calls. It has to be
 *    ReadWriteMany: two pods need it at once.
 */

import {
  ContainerDescription,
  CreateContainerSpec,
  EngineRunner,
  EnvironmentEngine,
  ExecSpec,
  ResourceUsage,
  RunResult,
  defaultRunner,
  EnvironmentInspectionError,
  parseSize,
  validateIdentityLabels,
} from './engine.js';
import { TARGET_LABEL, targetLabelValue } from './naming.js';
import { ContainerEngineKind, Mount } from './types.js';

/** The one container in every environment Pod. */
export const WORKSPACE_CONTAINER = 'workspace';

export interface KubernetesOptions {
  runner?: EngineRunner;
  binary?: string;
  /**
   * The kubectl context to use.
   *
   * Explicit by design, and not defaulted to the current one: "whatever kubectl
   * happens to point at" is not an acceptable default for something whose job
   * is to create pods. Null means the current context, which an administrator
   * has to choose deliberately.
   */
  context?: string | null;
  namespace: string;
  /** The ReadWriteMany claim every user's home lives on. */
  storageClaim: string;
  /**
   * Where that claim is mounted in *this* server's own filesystem.
   *
   * It is what turns a host path into a path inside the claim: everything the
   * server can offer a pod has to live under here, because a subPath of the
   * shared claim is the only thing both sides can name.
   */
  rootDir: string;
  /** Service account for the environment pods, when the cluster needs one named. */
  serviceAccount?: string | null;
  /** Reserved host callback address for integrations outside the shared-home channel. */
  callbackHost?: string | null;
  /**
   * Path to a kubeconfig file to use for every kubectl invocation. When set,
   * `--kubeconfig <path>` precedes `--context` and `--namespace`.
   */
  kubeconfigPath?: string | null;
  /** Seconds to wait for a new pod to become ready. */
  readyTimeoutSeconds?: number;
  /** Overrides the poll interval while waiting; only tests set this. */
  pollIntervalMs?: number;
}

interface PodResources {
  requests: Record<string, string>;
  limits: Record<string, string>;
}

function isPodNotFound(detail: string): boolean {
  return /Error from server \(NotFound\): pods? "[^"]+" not found/i.test(detail)
    || /"reason"\s*:\s*"NotFound"[\s\S]*"kind"\s*:\s*"pods?"/i.test(detail);
}

/**
 * `2g` (what the container engines accept) → `2Gi` (what Kubernetes accepts).
 *
 * The units mean the same thing — both are binary — but the spellings are not
 * interchangeable, and Kubernetes rejects the engine spelling outright rather
 * than guessing. Passed through unchanged when it already looks like a
 * Kubernetes quantity, so an administrator may write either.
 */
export function toQuantity(value: string): string {
  const trimmed = value.trim();
  if (/^[0-9.]+(Ki|Mi|Gi|Ti|k|M|G|T)?$/.test(trimmed)) {
    return trimmed;
  }
  const match = /^([0-9]*\.?[0-9]+)\s*([kmgt])b?$/i.exec(trimmed);
  if (match) {
    return `${match[1]}${match[2].toUpperCase()}i`;
  }
  return trimmed;
}

/** Kubernetes CPU quantities: `1.5` cores, or `1500m`. */
function cpuQuantity(value: string): string {
  const trimmed = value.trim();
  return /^[0-9.]+m?$/.test(trimmed) ? trimmed : trimmed;
}

export class KubernetesEngine implements EnvironmentEngine {
  readonly kind: ContainerEngineKind = 'kubernetes';
  readonly binary: string;
  private readonly run: EngineRunner;
  private readonly context: string | null;
  private readonly namespace: string;
  private readonly storageClaim: string;
  private readonly rootDir: string;
  private readonly serviceAccount: string | null;
  private readonly kubeconfigPath: string | null;
  private readonly readyTimeoutSeconds: number;
  private readonly pollIntervalMs: number;

  constructor(options: KubernetesOptions) {
    this.binary = options.binary || 'kubectl';
    this.run = options.runner || defaultRunner;
    this.context = options.context ?? null;
    this.namespace = options.namespace;
    this.storageClaim = options.storageClaim;
    this.rootDir = options.rootDir;
    this.serviceAccount = options.serviceAccount ?? null;
    this.kubeconfigPath = options.kubeconfigPath ?? null;
    this.readyTimeoutSeconds = options.readyTimeoutSeconds ?? 120;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
  }

  /** Kubeconfig, context and namespace on every call, so none can land elsewhere. */
  private base(): string[] {
    const args: string[] = [];
    if (this.kubeconfigPath) {
      args.push('--kubeconfig', this.kubeconfigPath);
    }
    if (this.context) {
      args.push('--context', this.context);
    }
    args.push('--namespace', this.namespace);
    return args;
  }

  /**
   * The Pod that is one user's environment.
   *
   * `restartPolicy: Never` with a container that sleeps: the pod is a place to
   * exec into, not a workload, and a restarting one would silently discard
   * whatever the user had running without telling them.
   */
  podManifest(spec: CreateContainerSpec): Record<string, unknown> {
    const resources: PodResources = { requests: {}, limits: {} };
    if (spec.cpus) {
      // Request half of what is allowed: the limit is the ceiling this user may
      // burst to, the request is what the scheduler must find room for, and
      // requesting the ceiling would leave a cluster able to place far fewer
      // environments than it can actually run.
      resources.limits.cpu = cpuQuantity(spec.cpus);
      resources.requests.cpu = cpuQuantity(String(Number(spec.cpus) / 2 || spec.cpus));
    }
    if (spec.memory) {
      // Memory is not compressible: a pod over its request is a candidate for
      // eviction, so request what was promised rather than half of it.
      resources.limits.memory = toQuantity(spec.memory);
      resources.requests.memory = toQuantity(spec.memory);
    }

    // Every mount is the same claim at a different subPath, and anything the
    // server cannot express that way is dropped rather than faked: an
    // `emptyDir` standing in for a directory of real files would mount
    // successfully and be empty, which fails later and further away.
    const volumeMounts = spec.mounts
      .map((mount, index) => {
        const subPath = this.subPathFor(mount);
        if (subPath === null) {
          return null;
        }
        return {
          name: index === 0 ? 'home' : `mount-${index}`,
          mountPath: mount.containerPath,
          subPath,
          ...(mount.readOnly ? { readOnly: true } : {}),
        };
      })
      .filter((mount): mount is NonNullable<typeof mount> => mount !== null);

    const volumes = volumeMounts.map((mount) => ({
      name: mount.name,
      persistentVolumeClaim: { claimName: this.storageClaim },
    }));

    return {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: spec.name,
        namespace: this.namespace,
        labels: sanitiseLabels(spec.labels),
      },
      spec: {
        restartPolicy: 'Never',
        ...(this.serviceAccount ? { serviceAccountName: this.serviceAccount } : {}),
        // Every environment is one user's, so nothing in it should be able to
        // reach the node or another pod's filesystem.
        securityContext: {
          runAsNonRoot: false,
          fsGroup: 0,
        },
        containers: [
          {
            name: WORKSPACE_CONTAINER,
            image: spec.image,
            command: ['sh', '-c', 'while true; do sleep 3600; done'],
            workingDir: spec.containerHome,
            env: [
              ...Object.entries(spec.env).map(([name, value]) => ({ name, value })),
              { name: 'CAWC_POD_UID', valueFrom: { fieldRef: { fieldPath: 'metadata.uid' } } },
            ],
            volumeMounts,
            ...(Object.keys(resources.limits).length || Object.keys(resources.requests).length
              ? { resources }
              : {}),
          },
        ],
        volumes,
      },
    };
  }

  async ensure(spec: CreateContainerSpec): Promise<{ created: boolean }> {
    const described = await this.describeStrict(spec.name);

    if (described) {
      validateIdentityLabels(spec, described);
    }

    if (described?.status === 'running') {
      return { created: false };
    }

    // A pod that exists but is not running cannot be revived, and `apply` will
    // not replace it — most of a Pod's spec is immutable. Deleting first is the
    // only way forward, and it is safe: the home is on the claim.
    if (described) {
      await this.remove(spec.name);
    }

    await this.create(spec);
    await this.waitForRunning(spec.name);
    return { created: true };
  }

  async ensureIdentity(spec: CreateContainerSpec, expected: ContainerDescription | null): Promise<{ created: boolean; identity: string }> {
    const current = await this.describeStrict(spec.name);
    if (expected) {
      if (!current || current.identity !== expected.identity) {
        throw new EnvironmentInspectionError(`pod '${spec.name}' was replaced before ensure`);
      }
      validateIdentityLabels(spec, current);
      if (current.status === 'running') return { created: false, identity: current.identity };
      await this.removeIdentity(expected);
    } else if (current) {
      throw new EnvironmentInspectionError(`pod '${spec.name}' appeared before creation`);
    }
    const identity = await this.createPod(spec);
    if (!identity) {
      throw new EnvironmentInspectionError(`pod '${spec.name}' was created without a verifiable UID`);
    }
    await this.waitForRunningIdentity(spec.name, identity);
    const created = await this.describeStrict(spec.name);
    if (!created || created.identity !== identity) {
      throw new EnvironmentInspectionError(`pod '${spec.name}' changed identity after creation`);
    }
    validateIdentityLabels(spec, created);
    return { created: true, identity };
  }

  async create(spec: CreateContainerSpec): Promise<void> {
    await this.createPod(spec);
  }

  /**
   * Kubernetes `create` is a single create-only API operation. Unlike apply,
   * it fails with AlreadyExists if the absent name is occupied between our
   * inspection and this call, and its response supplies the exact new UID.
   */
  private async createPod(spec: CreateContainerSpec): Promise<string | null> {
    const { stdout } = await this.run(
      this.binary,
      [...this.base(), 'create', '-f', '-', '-o', 'jsonpath={.metadata.uid}'],
      JSON.stringify(this.podManifest(spec)),
    );
    return stdout.trim() || null;
  }

  /**
   * There is no such thing.
   *
   * Kept because the interface has it and the operator paths call it, but a Pod
   * that has stopped is finished — `ensure` is what brings an environment back.
   */
  async start(name: string): Promise<void> {
    const status = await this.status(name);
    if (status && status !== 'running') {
      // Removing it is the honest half of what a caller means by "start": the
      // next `ensure` builds a new one. Silently doing nothing would leave a
      // caller believing an environment is coming back that never will.
      await this.remove(name);
    }
  }

  async stop(name: string): Promise<void> {
    await this.remove(name);
  }

  async remove(name: string): Promise<void> {
    await this.run(this.binary, [
      ...this.base(), 'delete', 'pod', name, '--ignore-not-found', '--wait=true',
    ]);
  }

  async stopIdentity(description: ContainerDescription): Promise<void> {
    await this.removeIdentity(description);
  }

  async removeIdentity(description: ContainerDescription): Promise<void> {
    const endpoint = `/api/v1/namespaces/${encodeURIComponent(this.namespace)}/pods/${encodeURIComponent(description.name)}`;
    try {
      await this.run(this.binary, [...this.base(), 'delete', '--raw', endpoint, '-f', '-'], JSON.stringify({
        apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: description.identity },
      }));
    } catch (error) {
      const candidate = error as Error & { stderr?: string };
      const detail = `${candidate.message || ''}\n${candidate.stderr || ''}`;
      if (!isPodNotFound(detail)) throw error;
    }
    // DELETE acknowledgement precedes final object disappearance. Poll the
    // exact UID through its Terminating window; a replacement or inspection
    // failure is not absence and must fail closed immediately.
    const deadline = Date.now() + this.readyTimeoutSeconds * 1000;
    for (;;) {
      const after = await this.describeStrict(description.name);
      if (!after) return;
      if (after.identity !== description.identity) {
        throw new EnvironmentInspectionError(`pod '${description.name}' was replaced during removal`);
      }
      if (Date.now() >= deadline) {
        throw new EnvironmentInspectionError(
          `pod '${description.name}' still exists after ${this.readyTimeoutSeconds}s removal timeout`,
        );
      }
      await new Promise((resolve) => { setTimeout(resolve, this.pollIntervalMs); });
    }
  }

  async status(name: string): Promise<string | null> {
    try {
      const { stdout } = await this.run(this.binary, [
        ...this.base(), 'get', 'pod', name, '-o', 'jsonpath={.status.phase}',
      ]);
      const phase = stdout.trim();
      if (!phase) throw new EnvironmentInspectionError(`malformed pod status response for '${name}'`);
      return phase === 'Running' ? 'running' : phase.toLowerCase();
    } catch (error) {
      const candidate = error as Error & { stderr?: string };
      const detail = `${candidate.message || ''}\n${candidate.stderr || ''}`;
      if (isPodNotFound(detail)) return null;
      throw new EnvironmentInspectionError(`could not inspect pod status '${name}': ${detail.trim()}`);
    }
  }

  async describeStrict(name: string): Promise<ContainerDescription | null> {
    try {
      const { stdout } = await this.run(this.binary, [
        ...this.base(), 'get', 'pod', name, '--ignore-not-found',
        '-o', 'json',
      ]);
      if (!stdout.trim()) return null;

      let pod: {
        status?: { phase?: unknown };
        spec?: { containers?: Array<{ image?: unknown }> };
        metadata?: { uid?: unknown; labels?: unknown };
      };
      try {
        pod = JSON.parse(stdout);
      } catch (error) {
        throw new EnvironmentInspectionError(
          `engine returned invalid JSON for '${name}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const identity = typeof pod.metadata?.uid === 'string' ? pod.metadata.uid : '';
      const phase = typeof pod.status?.phase === 'string' ? pod.status.phase : '';
      if (!identity || !phase) {
        throw new EnvironmentInspectionError(`malformed pod inspection response for '${name}'`);
      }
      const image = typeof pod.spec?.containers?.[0]?.image === 'string'
        ? pod.spec.containers[0].image
        : '';
      const rawLabels = pod.metadata?.labels;
      if (
        rawLabels !== undefined
        && (
          rawLabels === null
          || typeof rawLabels !== 'object'
          || Array.isArray(rawLabels)
          || Object.values(rawLabels as Record<string, unknown>)
            .some((value) => typeof value !== 'string')
        )
      ) {
        throw new EnvironmentInspectionError(`malformed pod labels for '${name}'`);
      }
      const labels = (rawLabels || {}) as Record<string, string>;
      return {
        name,
        identity,
        status: phase === 'Running' ? 'running' : phase.toLowerCase(),
        image,
        labels: desanitiseLabels(labels),
      };
    } catch (error) {
      const candidate = error as Error & { stderr?: string; stdout?: string };
      const detail = `${candidate.message || ''}\n${candidate.stderr || ''}\n${candidate.stdout || ''}`;
      if (isPodNotFound(detail)) return null;
      if (error instanceof EnvironmentInspectionError) throw error;
      throw new EnvironmentInspectionError(
        `could not inspect pod '${name}': ${detail.trim()}`,
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

  /**
   * Argv that runs a command in a user's pod, at a directory, with variables.
   *
   * `kubectl exec` supports neither, so both are applied inside: a shell that
   * receives the directory as `$1` and the command as `"$@"`, and `env` to
   * carry the variables. Nothing is ever interpolated into the shell string, so
   * a working directory or a variable value containing quotes, `;` or `$()` is
   * data rather than syntax.
   */
  execArgs(spec: ExecSpec, command: string, commandArgs: string[]): string[] {
    const args = [...this.base(), 'exec', spec.name, '--container', WORKSPACE_CONTAINER, '--stdin'];
    if (spec.tty) {
      args.push('--tty');
    }
    args.push('--');

    const envPairs = Object.entries(spec.env || {}).map(([key, value]) => `${key}=${value}`);

    if (spec.identity) {
      args.push(
        'sh', '-c',
        '[ "$CAWC_POD_UID" = "$1" ] || exit 125; shift; cd "$1" || exit 1; shift; exec "$@"',
        'sh', spec.identity, spec.cwd || '/',
        ...(envPairs.length ? ['env', ...envPairs] : []),
        command, ...commandArgs,
      );
      return args;
    }

    if (spec.cwd) {
      args.push(
        'sh', '-c', 'cd "$1" || exit 1; shift; exec "$@"', 'sh', spec.cwd,
        ...(envPairs.length ? ['env', ...envPairs] : []),
        command, ...commandArgs,
      );
      return args;
    }

    if (envPairs.length) {
      args.push('env', ...envPairs);
    }
    args.push(command, ...commandArgs);
    return args;
  }

  async exec(spec: ExecSpec, command: string, commandArgs: string[]): Promise<RunResult> {
    return this.run(this.binary, this.execArgs(spec, command, commandArgs), spec.input, spec.signal);
  }

  async list(label: string): Promise<string[]> {
    const { stdout } = await this.run(this.binary, [
      ...this.base(), 'get', 'pods',
      '--selector', sanitiseSelector(label),
      '-o', 'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}',
    ]);
    return stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  }

  /**
   * Change a running pod's limits without replacing it.
   *
   * In-place resize reached beta in Kubernetes 1.33 and is not available at all
   * before that, so this reports failure rather than throwing when the cluster
   * has no `resize` subresource — the caller's fallback is a rebuild, which
   * every cluster supports.
   */
  async resize(name: string, cpus: string | null, memory: string | null): Promise<boolean> {
    const limits: Record<string, string> = {};
    const requests: Record<string, string> = {};
    if (cpus) {
      limits.cpu = cpuQuantity(cpus);
      requests.cpu = cpuQuantity(String(Number(cpus) / 2 || cpus));
    }
    if (memory) {
      limits.memory = toQuantity(memory);
      requests.memory = toQuantity(memory);
    }
    if (!Object.keys(limits).length) {
      return true;
    }

    const patch = JSON.stringify({
      spec: { containers: [{ name: WORKSPACE_CONTAINER, resources: { limits, requests } }] },
    });

    try {
      await this.run(this.binary, [
        ...this.base(), 'patch', 'pod', name, '--subresource', 'resize', '--patch', patch,
      ]);
      return true;
    } catch {
      return false;
    }
  }

  async usage(name: string): Promise<ResourceUsage | null> {
    try {
      const { stdout } = await this.run(this.binary, [
        ...this.base(), 'top', 'pod', name, '--no-headers', '--containers',
      ]);
      // `POD  CONTAINER  CPU(cores)  MEMORY(bytes)`, e.g. `env-1 workspace 12m 48Mi`
      const row = stdout.trim().split('\n')[0] || '';
      const parts = row.split(/\s+/).filter(Boolean);
      const cpuRaw = parts[parts.length - 2];
      const memRaw = parts[parts.length - 1];
      const cpuCores = cpuRaw?.endsWith('m')
        ? Number.parseFloat(cpuRaw) / 1000
        : Number.parseFloat(cpuRaw);
      const memoryBytes = parseSize(memRaw || '');
      if (!Number.isFinite(cpuCores) || memoryBytes === null) {
        return null;
      }
      return { cpuCores, memoryBytes };
    } catch {
      // No metrics-server is the common case, and it is not an error worth
      // failing a request over — it only means `auto` has nothing to read.
      return null;
    }
  }

  async available(): Promise<boolean> {
    try {
      // Probe only the namespace-scoped permission environments actually use.
      // A least-privileged Role may manage Pods without being allowed to GET
      // the cluster-scoped Namespace object itself.
      await this.run(this.binary, [
        ...this.base(), 'get', 'pods', '--limit=1', '-o', 'name',
      ]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Where a host path sits inside the shared claim, or null if it does not.
   *
   * The claim is mounted at `rootDir` on this server, so a path under it is
   * the same file both sides can reach. A path outside — the chat socket
   * directory, for one — has no representation here, and saying so is the
   * point: a unix socket could not cross a pod boundary even if it did.
   */
  subPathFor(mount: Mount): string | null {
    const root = this.rootDir.replace(/\/+$/, '');
    const host = mount.hostPath.replace(/\/+$/, '');
    if (host === root) {
      return '';
    }
    if (!host.startsWith(`${root}/`)) {
      return null;
    }
    return host.slice(root.length + 1);
  }

  /** Poll until the pod is running, so the first exec does not race the scheduler. */
  private async waitForRunning(name: string): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutSeconds * 1000;
    for (;;) {
      const status = await this.status(name);
      if (status === 'running') {
        return;
      }
      if (status === 'failed' || status === 'succeeded') {
        throw new Error(`Environment ${name} did not start: pod is ${status}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Environment ${name} was not running after ${this.readyTimeoutSeconds}s`
          + (status ? ` (pod is ${status})` : ' (no pod appeared)'),
        );
      }
      await new Promise((resolve) => { setTimeout(resolve, this.pollIntervalMs); });
    }
  }

  /** Poll one immutable Pod, never a same-name object that replaced it. */
  private async waitForRunningIdentity(name: string, identity: string): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutSeconds * 1000;
    for (;;) {
      const described = await this.describeStrict(name);
      if (!described || described.identity !== identity) {
        throw new EnvironmentInspectionError(`pod '${name}' changed identity while waiting for it to start`);
      }
      if (described.status === 'running') return;
      if (described.status === 'failed' || described.status === 'succeeded') {
        throw new Error(`Environment ${name} did not start: pod is ${described.status}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Environment ${name} was not running after ${this.readyTimeoutSeconds}s (pod is ${described.status})`,
        );
      }
      await new Promise((resolve) => { setTimeout(resolve, this.pollIntervalMs); });
    }
  }
}

/**
 * Label keys, as Kubernetes will accept them.
 *
 * A label key may have at most one `/`, and the part before it is a DNS
 * subdomain — so `com.code-agents-webcli.managed` is fine as a key but the
 * dotted form is kept as-is rather than converted, and only the values are
 * checked. Values may not contain `/`, which a GitHub login cannot anyway.
 */
function sanitiseLabels(labels: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    out[key] = key === TARGET_LABEL
      ? targetLabelValue(value)
      : value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 63);
  }
  return out;
}

function desanitiseLabels(labels: Record<string, string>): Record<string, string> {
  return labels;
}

/** `key=value` is already selector syntax; this only guards the shape. */
function sanitiseSelector(label: string): string {
  return label;
}
