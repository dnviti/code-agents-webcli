/**
 * Provider-neutral project tooling provisioner.
 *
 * Every system boundary is injectable: target commands, the pinned artifact
 * catalog, downloads, and durable installation status.  Production can bind
 * those seams to an exact project container and SQLite; tests never need a
 * network or a container runtime.
 */

import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fsp from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

export interface CommandRunOptions {
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  /** Sensitive input is permitted here and nowhere in command metadata. */
  input?: string;
  signal?: AbortSignal;
}

export interface ContainerCommandRunner {
  run(
    command: string,
    args: readonly string[],
    options?: CommandRunOptions,
  ): Promise<{ stdout: string; stderr: string }>;
}

export type TargetArchitecture = 'x64' | 'arm64';
export type TargetLibc = 'glibc' | 'musl';

export interface TargetPlatform {
  os: 'linux';
  arch: TargetArchitecture;
  libc: TargetLibc;
  /** Safe as one durable directory name. */
  namespace: string;
}

export class TargetCompatibilityError extends Error {
  readonly code = 'TARGET_INCOMPATIBLE';
}

const TARGET_PROBE = [
  'set -eu',
  'test -r /proc/self/status',
  'command -v uname >/dev/null',
  'command -v bash >/dev/null',
  'command -v git >/dev/null',
  'command -v setsid >/dev/null',
  'certificates=',
  'for candidate in /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt /etc/ssl/cert.pem; do',
  '  if test -r "$candidate"; then certificates=$candidate; break; fi',
  'done',
  'test -n "$certificates"',
  'os=$(uname -s)',
  'arch=$(uname -m)',
  'libc=glibc',
  'if command -v ldd >/dev/null 2>&1; then',
  '  case "$(ldd --version 2>&1 || true)" in *musl*) libc=musl;; esac',
  'fi',
  'printf "%s\\n%s\\n%s\\n" "$os" "$arch" "$libc"',
].join('\n');

/** Probe only fixed commands; repository files and configuration are absent. */
export async function probeTargetPlatform(runner: ContainerCommandRunner): Promise<TargetPlatform> {
  let stdout: string;
  try {
    ({ stdout } = await runner.run('sh', ['-c', TARGET_PROBE]));
  } catch {
    throw new TargetCompatibilityError(
      'Base image requires Linux sh, Bash, CA certificates, Git, readable /proc, and setsid',
    );
  }
  const [rawOs, rawArch, rawLibc, ...extra] = stdout.trim().split(/\r?\n/);
  if (extra.length || rawOs !== 'Linux') {
    throw new TargetCompatibilityError('Provisioning requires a Linux target');
  }
  const arch = rawArch === 'x86_64' || rawArch === 'amd64'
    ? 'x64'
    : rawArch === 'aarch64' || rawArch === 'arm64'
      ? 'arm64'
      : null;
  const libc = rawLibc === 'glibc' || rawLibc === 'musl' ? rawLibc : null;
  if (!arch || !libc) {
    throw new TargetCompatibilityError('Target architecture or libc is unsupported');
  }
  return { os: 'linux', arch, libc, namespace: `linux-${arch}-${libc}` };
}

export interface MiseArtifact {
  /** A pinned mise release, never a moving tag. */
  version: string;
  platform: Pick<TargetPlatform, 'os' | 'arch' | 'libc'>;
  url: string;
  sha256: string;
}

export interface TeaArtifact {
  /** Exact official tea release, never a moving tag. */
  version: string;
  platform: Pick<TargetPlatform, 'os' | 'arch'>;
  url: string;
  sha256: string;
}

const MISE_RELEASE_BASE = 'https://github.com/jdx/mise/releases/download/v2026.8.1';

/** Official v2026.8.1 direct binaries, pinned from its SHASUMS256.txt. */
export const PINNED_MISE_ARTIFACTS: readonly MiseArtifact[] = Object.freeze([
  Object.freeze({
    version: 'v2026.8.1',
    platform: Object.freeze({ os: 'linux' as const, arch: 'arm64' as const, libc: 'glibc' as const }),
    url: `${MISE_RELEASE_BASE}/mise-v2026.8.1-linux-arm64`,
    sha256: '54f9e0b4c4085cde1c80e107671a0058d4b234f7d2fc6bd3b61ead68df6cfcef',
  }),
  Object.freeze({
    version: 'v2026.8.1',
    platform: Object.freeze({ os: 'linux' as const, arch: 'arm64' as const, libc: 'musl' as const }),
    url: `${MISE_RELEASE_BASE}/mise-v2026.8.1-linux-arm64-musl`,
    sha256: '509e42504b83347d8ae3d63f6d284c4a8f8c807ec775a102cfc20d7c8bef4b0b',
  }),
  Object.freeze({
    version: 'v2026.8.1',
    platform: Object.freeze({ os: 'linux' as const, arch: 'x64' as const, libc: 'glibc' as const }),
    url: `${MISE_RELEASE_BASE}/mise-v2026.8.1-linux-x64`,
    sha256: '961b1fcc78830e861ab887abd19d9b961478bcf252e37881fdd61c81388308d4',
  }),
  Object.freeze({
    version: 'v2026.8.1',
    platform: Object.freeze({ os: 'linux' as const, arch: 'x64' as const, libc: 'musl' as const }),
    url: `${MISE_RELEASE_BASE}/mise-v2026.8.1-linux-x64-musl`,
    sha256: '522fd15a3b0748d8a240bdf06cd45f679f759a097e2f49b436363e92c48fdbdc',
  }),
]);

export const PINNED_TEA_VERSION = '0.15.1' as const;
export const TEA_TMPFS_XDG_CONFIG_HOME = '/run/code-agents-forge/xdg' as const;
const TEA_RELEASE_BASE = `https://gitea.com/gitea/tea/releases/download/v${PINNED_TEA_VERSION}`;

/** Official v0.15.1 direct binaries, pinned from its checksums.txt release asset. */
export const PINNED_TEA_ARTIFACTS: readonly TeaArtifact[] = Object.freeze([
  Object.freeze({
    version: PINNED_TEA_VERSION,
    platform: Object.freeze({ os: 'linux' as const, arch: 'arm64' as const }),
    url: `${TEA_RELEASE_BASE}/tea-${PINNED_TEA_VERSION}-linux-arm64`,
    sha256: '0db109df6696bfe01f9203402f503404692404d4ea9c16a540ecaeecc8e6bab2',
  }),
  Object.freeze({
    version: PINNED_TEA_VERSION,
    platform: Object.freeze({ os: 'linux' as const, arch: 'x64' as const }),
    url: `${TEA_RELEASE_BASE}/tea-${PINNED_TEA_VERSION}-linux-amd64`,
    sha256: 'aac99cc6e650a81ae7b5061f8c75bc0eade4509c828d97b6072e1f0a3bd24357',
  }),
]);

export type MiseArtifactFetcher = (artifact: MiseArtifact) => Promise<Uint8Array>;
export type TeaArtifactFetcher = (artifact: TeaArtifact) => Promise<Uint8Array>;

// v2026.8.1's largest pinned Linux binary is about 106 MiB. Keep a bounded
// allowance above the verified artifact set without accepting arbitrary-sized
// responses from the release host.
const MISE_BINARY_MAX_BYTES = 128 * 1024 * 1024;
const TEA_BINARY_MAX_BYTES = 64 * 1024 * 1024;

/** Network implementation for production; tests inject a byte fixture. */
export async function fetchPinnedMiseArtifact(artifact: MiseArtifact): Promise<Uint8Array> {
  const url = new URL(artifact.url);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com'
    || !/^[a-f0-9]{64}$/i.test(artifact.sha256)) {
    throw new Error('mise artifact pin is invalid');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    // GitHub's immutable release URL redirects to signed object storage.
    const response = await fetch(url, { redirect: 'follow', signal: controller.signal });
    if (!response.ok || new URL(response.url).protocol !== 'https:') {
      throw new Error('mise artifact download failed');
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MISE_BINARY_MAX_BYTES) {
      throw new Error('mise artifact is too large');
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MISE_BINARY_MAX_BYTES) {
      throw new Error('mise artifact has an invalid size');
    }
    return bytes;
  } finally {
    clearTimeout(timer);
  }
}

/** Download only a compile-time pinned official tea artifact. */
export async function fetchPinnedTeaArtifact(artifact: TeaArtifact): Promise<Uint8Array> {
  const url = new URL(artifact.url);
  if (url.protocol !== 'https:' || url.hostname !== 'gitea.com'
    || !/^[a-f0-9]{64}$/i.test(artifact.sha256)) {
    throw new Error('tea artifact pin is invalid');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    // Gitea's immutable release URL redirects to its signed object-storage URL.
    // The initial URL is fixed above and the final transport must remain HTTPS.
    const response = await fetch(url, { redirect: 'follow', signal: controller.signal });
    if (!response.ok || new URL(response.url).protocol !== 'https:') {
      throw new Error('tea artifact download failed');
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > TEA_BINARY_MAX_BYTES) {
      throw new Error('tea artifact is too large');
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > TEA_BINARY_MAX_BYTES) {
      throw new Error('tea artifact has an invalid size');
    }
    return bytes;
  } finally {
    clearTimeout(timer);
  }
}

export type InstallationStatus = 'pending' | 'installing' | 'installed' | 'failed';

export interface InstallationItem {
  id: string;
  /** Catalog key such as node, python, gh, glab, or tea. */
  tool: string;
  version: string;
}

export interface InstallationRecord extends InstallationItem {
  status: InstallationStatus;
  attempts: number;
  installedVersion: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

/** SQLite-backed in production; an in-memory fake is sufficient for tests. */
export interface InstallationStateStore {
  ensureItems(compositionId: string, items: readonly InstallationItem[]): void | Promise<void>;
  list(compositionId: string): readonly InstallationRecord[] | Promise<readonly InstallationRecord[]>;
  markInstalling(compositionId: string, itemId: string): void | Promise<void>;
  markInstalled(compositionId: string, itemId: string, version: string): void | Promise<void>;
  markFailed(
    compositionId: string,
    itemId: string,
    errorCode: string,
    safeMessage: string,
  ): void | Promise<void>;
}

export interface ProvisionRequest {
  compositionId: string;
  ownerHomeHost: string;
  ownerHomeContainer: string;
  projectOverlayHost: string;
  items: readonly InstallationItem[];
}

export interface ProvisionResult {
  platform: TargetPlatform | null;
  misePath: string | null;
  activationFile: string | null;
  items: readonly InstallationRecord[];
}

export interface OwnerToolVersionLock {
  ownerHomeHost: string;
  /** Composition installation key (`node`, `gh`, `tea`), not a display label. */
  tool: string;
  version: string;
}

export type ApprovedTool = Readonly<
  | { installer: 'mise'; miseName: string; executable: string }
  | { installer: 'tea-direct'; binaryName: 'tea'; version: typeof PINNED_TEA_VERSION }
>;

/** Catalog v1 language/agent tools plus the three supported forge clients. */
export const APPROVED_TOOL_CATALOG: Readonly<Record<string, ApprovedTool>> = Object.freeze({
  node: { installer: 'mise', miseName: 'node', executable: 'node' },
  python: { installer: 'mise', miseName: 'python', executable: 'python3' },
  php: { installer: 'mise', miseName: 'php', executable: 'php' },
  go: { installer: 'mise', miseName: 'go', executable: 'go' },
  rust: { installer: 'mise', miseName: 'rust', executable: 'rustc' },
  java: { installer: 'mise', miseName: 'java', executable: 'java' },
  dotnet: { installer: 'mise', miseName: 'dotnet', executable: 'dotnet' },
  gh: { installer: 'mise', miseName: 'github-cli', executable: 'gh' },
  glab: { installer: 'mise', miseName: 'glab', executable: 'glab' },
  tea: { installer: 'tea-direct', binaryName: 'tea', version: PINNED_TEA_VERSION },
  'agent-claude': { installer: 'mise', miseName: 'npm:@anthropic-ai/claude-code', executable: 'claude' },
  'agent-codex': { installer: 'mise', miseName: 'npm:@openai/codex', executable: 'codex' },
  'agent-pi': { installer: 'mise', miseName: 'npm:@mariozechner/pi-coding-agent', executable: 'pi' },
  'agent-grok': { installer: 'mise', miseName: 'npm:@xai-official/grok', executable: 'grok' },
  'agent-qwen': { installer: 'mise', miseName: 'npm:@qwen-code/qwen-code', executable: 'qwen' },
  'agent-kimi': { installer: 'mise', miseName: 'pipx:kimi-cli', executable: 'kimi' },
  'agent-omp': { installer: 'mise', miseName: 'npm:@oh-my-pi/pi-coding-agent', executable: 'omp' },
});

export interface ProjectProvisionerOptions {
  runner: ContainerCommandRunner;
  state: InstallationStateStore;
  /** Must contain exactly pinned, checksummed artifacts. */
  artifacts?: readonly MiseArtifact[];
  fetchArtifact?: MiseArtifactFetcher;
  teaArtifacts?: readonly TeaArtifact[];
  fetchTeaArtifact?: TeaArtifactFetcher;
  probe?: (runner: ContainerCommandRunner) => Promise<TargetPlatform>;
  tools?: Readonly<Record<string, ApprovedTool>>;
}

class ProvisioningFoundationError extends Error {
  constructor(readonly safeCode: string, readonly safeMessage: string) {
    super(safeMessage);
  }
}

/**
 * Process-wide because one runtime application constructs a fresh provisioner.
 * The queue is deliberately narrower than a composition: projects sharing one
 * durable home serialize only the exact tool/version they would mutate.
 */
const sharedInstallationLocks = new Map<string, Promise<void>>();
/** Owner-wide mise mutations that enumerate or publish durable installs/shims. */
const sharedMiseMutationLocks = new Map<string, Promise<void>>();
/** Exact app-owned destination paths serialize their final atomic rename. */
const sharedPublicationLocks = new Map<string, Promise<void>>();

export class ProjectProvisioner {
  private readonly fetchArtifact: MiseArtifactFetcher;
  private readonly fetchTeaArtifact: TeaArtifactFetcher;
  private readonly probe: (runner: ContainerCommandRunner) => Promise<TargetPlatform>;
  private readonly tools: Readonly<Record<string, ApprovedTool>>;
  private readonly artifacts: readonly MiseArtifact[];
  private readonly teaArtifacts: readonly TeaArtifact[];

  constructor(private readonly options: ProjectProvisionerOptions) {
    this.fetchArtifact = options.fetchArtifact || fetchPinnedMiseArtifact;
    this.fetchTeaArtifact = options.fetchTeaArtifact || fetchPinnedTeaArtifact;
    this.probe = options.probe || probeTargetPlatform;
    this.tools = options.tools || APPROVED_TOOL_CATALOG;
    this.artifacts = options.artifacts || PINNED_MISE_ARTIFACTS;
    this.teaArtifacts = options.teaArtifacts || PINNED_TEA_ARTIFACTS;
  }

  /** Install only never-attempted items. Existing failures require explicit retry. */
  async provision(request: ProvisionRequest): Promise<ProvisionResult> {
    const items = this.validateItems(request.items);
    await this.options.state.ensureItems(request.compositionId, items);
    return this.runSelected(request, items, new Set(['pending']));
  }

  /** Retry is intentionally narrower than provision: failed rows and nothing else. */
  async retryFailed(request: ProvisionRequest): Promise<ProvisionResult> {
    const items = this.validateItems(request.items);
    const records = await this.options.state.list(request.compositionId);
    const known = new Set(items.map((item) => item.id));
    if (records.some((record) => !known.has(record.id))) {
      throw new Error('installation state does not match the composition');
    }
    return this.runSelected(request, items, new Set(['failed']));
  }

  private async runSelected(
    request: ProvisionRequest,
    items: readonly InstallationItem[],
    statuses: ReadonlySet<InstallationStatus>,
  ): Promise<ProvisionResult> {
    const before = await this.options.state.list(request.compositionId);
    if (before.length !== items.length || items.some((item) => {
      const record = before.find((candidate) => candidate.id === item.id);
      return !record || record.tool !== item.tool || record.version !== item.version;
    })) {
      throw new Error('installation state does not match the composition');
    }
    const byId = new Map(before.map((record) => [record.id, record]));
    const selected = items.filter((item) => statuses.has(byId.get(item.id)?.status || 'pending'));
    if (!selected.length) {
      // Refresh the stable launcher even when every selected tool is already
      // installed. This upgrades shared homes whose mise-generated shims still
      // point at an older launcher implementation.
      if (items.some((item) => this.tools[item.tool].installer === 'mise')) {
        await this.publishMiseEntrypoint(request.ownerHomeHost);
        await this.publishMiseToolEntrypoints(request.ownerHomeHost, items);
      }
      return { platform: null, misePath: null, activationFile: null, items: before };
    }

    let platform: TargetPlatform | null = null;
    let activationFile: string | null = null;
    let foundation: Promise<{ platform: TargetPlatform; activationFile: string }> | null = null;
    let misePath: string | null = null;
    const env = miseEnvironment(request.ownerHomeContainer);
    for (const item of selected) {
      await withOwnerToolVersionLock({
        ownerHomeHost: request.ownerHomeHost,
        tool: item.tool,
        version: item.version,
      }, async () => {
        // Another provisioner for this exact composition can have completed
        // while this one waited behind the owner/tool/version queue.
        const current = (await this.options.state.list(request.compositionId))
          .find((record) => record.id === item.id);
        if (!current || !statuses.has(current.status)) return;

        await this.options.state.markInstalling(request.compositionId, item.id);
        const approved = this.tools[item.tool];
        try {
          foundation ||= (async () => {
            const target = await this.probe(this.options.runner);
            const activation = await this.writeActivation(request.projectOverlayHost, items);
            return { platform: target, activationFile: activation };
          })();
          const prepared = await foundation;
          platform = prepared.platform;
          activationFile = prepared.activationFile;
          if (approved.installer === 'mise') {
            const mise = await this.installMise(request, prepared.platform);
            misePath = mise.containerPath;
            // `mise install` may reshim implicitly. Point that mutation at a
            // unique project-local staging directory so distinct exact
            // versions can still install concurrently without sharing shims.
            const isolatedShims = `/opt/code-agents-project/.mise-install-shims/${randomUUID()}`;
            const installEnv = { ...env, MISE_SHIMS_DIR: isolatedShims };
            // No repository cwd/config/hooks, no shell, and no dynamic argv beyond
            // catalog-approved names and validated literal versions.
            try {
              await this.options.runner.run(
                mise.containerPath,
                ['--no-config', '--no-hooks', 'install', '--yes', `${approved.miseName}@${item.version}`],
                { cwd: '/opt/code-agents-project', env: installEnv },
              );
            } finally {
              await this.options.runner.run(
                'rm',
                ['-rf', '--', isolatedShims],
                { cwd: '/opt/code-agents-project' },
              );
            }
            await withOwnerMiseMutationLock(request.ownerHomeHost, async () => {
              await this.options.runner.run(
                mise.containerPath,
                ['--no-config', '--no-hooks', 'reshim'],
                { cwd: '/opt/code-agents-project', env },
              );
              await this.publishMiseToolEntrypoints(request.ownerHomeHost, items);
            });
          } else {
            await this.installTea(request, prepared.platform, item.version);
          }
          await this.options.state.markInstalled(request.compositionId, item.id, item.version);
        } catch (error) {
          // Engine stderr can contain arbitrary remote text. Never persist it.
          const safe = safeItemFailure(error, item.tool);
          await this.options.state.markFailed(
            request.compositionId,
            item.id,
            safe.code,
            safe.message,
          );
        }
      });
    }

    return {
      platform,
      misePath,
      activationFile,
      items: await this.options.state.list(request.compositionId),
    };
  }

  private validateItems(input: readonly InstallationItem[]): readonly InstallationItem[] {
    const ids = new Set<string>();
    const installKeys = new Set<string>();
    return input.map((candidate) => {
      const approved = this.tools[candidate.tool];
      if (!approved || !/^[a-z][a-z0-9-]{0,31}$/.test(candidate.id)
        || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(candidate.version)) {
        throw new Error('composition contains an unsupported tool or version');
      }
      if (approved.installer === 'tea-direct' && candidate.version !== approved.version) {
        throw new Error('composition contains an unsupported tool or version');
      }
      const installKey = approved.installer === 'mise'
        ? `mise:${approved.miseName}`
        : `direct:${approved.binaryName}`;
      if (ids.has(candidate.id) || installKeys.has(installKey)) {
        throw new Error('composition contains a duplicate tool');
      }
      ids.add(candidate.id);
      installKeys.add(installKey);
      return { id: candidate.id, tool: candidate.tool, version: candidate.version };
    });
  }

  private async installMise(
    request: ProvisionRequest,
    platform: TargetPlatform,
  ): Promise<{ hostPath: string; containerPath: string }> {
    const artifact = this.artifacts.find((candidate) => (
      candidate.platform.os === platform.os
      && candidate.platform.arch === platform.arch
      && candidate.platform.libc === platform.libc
    ));
    if (!artifact || !/^[a-f0-9]{64}$/i.test(artifact.sha256)) {
      throw new ProvisioningFoundationError(
        'MISE_ARTIFACT_UNAVAILABLE',
        'No pinned mise artifact is available for this platform',
      );
    }
    const relativeDir = path.join(
      '.local', 'share', 'code-agents', 'platforms', platform.namespace, 'bin',
    );
    const directory = await privateDirectory(request.ownerHomeHost, relativeDir.split(path.sep));
    const hostPath = directory.displayEntry('mise');
    const containerPath = path.posix.join(
      request.ownerHomeContainer,
      ...relativeDir.split(path.sep),
      'mise',
    );
    try {
      let existing: PrivateFile | null;
      try {
        existing = await readPrivateFile(directory, 'mise', MISE_BINARY_MAX_BYTES);
      } catch {
        throw new ProvisioningFoundationError('MISE_INSTALL_FAILED', 'Pinned mise could not be inspected');
      }
      if (existing?.bytes && sha256(existing.bytes) === artifact.sha256.toLowerCase()) {
        if (existing.mode !== 0o700) {
          await atomicPublish(directory, 'mise', existing.bytes, 0o700);
        } else {
          await directory.assertReachable();
        }
        await this.publishMiseEntrypoint(request.ownerHomeHost);
        return { hostPath, containerPath };
      }

      let bytes: Uint8Array;
      try {
        bytes = await this.fetchArtifact(artifact);
      } catch {
        throw new ProvisioningFoundationError('MISE_DOWNLOAD_FAILED', 'Pinned mise could not be downloaded');
      }
      if (!bytes.length || bytes.length > MISE_BINARY_MAX_BYTES
        || sha256(bytes) !== artifact.sha256.toLowerCase()) {
        throw new ProvisioningFoundationError('MISE_CHECKSUM_MISMATCH', 'Pinned mise checksum did not match');
      }
      await atomicPublish(directory, 'mise', bytes, 0o700);
      await this.publishMiseEntrypoint(request.ownerHomeHost);
      return { hostPath, containerPath };
    } finally {
      await directory.close();
    }
  }

  /** Stable entrypoint dispatches across target platforms that share one home. */
  private async publishMiseEntrypoint(ownerHome: string): Promise<void> {
    await publishPrivateEntrypoint(ownerHome, 'mise', miseDispatcher());
  }

  /**
   * Mise normally symlinks each shim to the binary that happened to run
   * `reshim`. A durable home may be mounted on a different architecture next,
   * so replace each selected primary executable with the stable dispatcher.
   */
  private async publishMiseToolEntrypoints(
    ownerHome: string,
    items: readonly InstallationItem[],
  ): Promise<void> {
    const names = new Set(items.flatMap((item) => {
      const tool = this.tools[item.tool];
      return tool?.installer === 'mise' ? [tool.executable] : [];
    }));
    if (!names.size) return;
    const directory = await privateDirectory(
      ownerHome,
      ['.local', 'share', 'code-agents', 'mise', 'shims'],
    );
    try {
      for (const name of names) {
        await atomicPublish(directory, name, miseDispatcher(), 0o700);
      }
    } finally {
      await directory.close();
    }
  }

  private async installTea(
    request: ProvisionRequest,
    platform: TargetPlatform,
    version: string,
  ): Promise<{ hostPath: string; containerPath: string }> {
    const artifact = this.teaArtifacts.find((candidate) => (
      candidate.version === version
      && candidate.platform.os === platform.os
      && candidate.platform.arch === platform.arch
    ));
    if (!artifact || !/^[a-f0-9]{64}$/i.test(artifact.sha256)) {
      throw new ProvisioningFoundationError(
        'TEA_ARTIFACT_UNAVAILABLE',
        'No pinned tea artifact is available for this platform',
      );
    }
    const relativeDir = path.join(
      '.local', 'share', 'code-agents', 'tools', 'tea', version, `linux-${platform.arch}`,
    );
    const directory = await privateDirectory(request.ownerHomeHost, relativeDir.split(path.sep));
    const hostPath = directory.displayEntry('tea');
    const containerPath = path.posix.join(
      request.ownerHomeContainer,
      ...relativeDir.split(path.sep),
      'tea',
    );
    try {
      let existing: PrivateFile | null;
      try {
        existing = await readPrivateFile(directory, 'tea', TEA_BINARY_MAX_BYTES);
      } catch {
        throw new ProvisioningFoundationError('TEA_INSTALL_FAILED', 'Pinned tea could not be inspected');
      }
      if (existing?.bytes && sha256(existing.bytes) === artifact.sha256.toLowerCase()) {
        if (existing.mode !== 0o700) {
          await atomicPublish(directory, 'tea', existing.bytes, 0o700);
        } else {
          await directory.assertReachable();
        }
        await this.publishTeaEntrypoint(request.ownerHomeHost, version);
        return { hostPath, containerPath };
      }

      let bytes: Uint8Array;
      try {
        bytes = await this.fetchTeaArtifact(artifact);
      } catch {
        throw new ProvisioningFoundationError('TEA_DOWNLOAD_FAILED', 'Pinned tea could not be downloaded');
      }
      if (!bytes.length || bytes.length > TEA_BINARY_MAX_BYTES
        || sha256(bytes) !== artifact.sha256.toLowerCase()) {
        throw new ProvisioningFoundationError('TEA_CHECKSUM_MISMATCH', 'Pinned tea checksum did not match');
      }
      await atomicPublish(directory, 'tea', bytes, 0o700);
      await this.publishTeaEntrypoint(request.ownerHomeHost, version);
      return { hostPath, containerPath };
    } finally {
      await directory.close();
    }
  }

  /** The launcher keeps tea's credential lookup in the memory-backed XDG tree. */
  private async publishTeaEntrypoint(ownerHome: string, version: string): Promise<void> {
    await publishPrivateEntrypoint(ownerHome, 'tea', teaDispatcher(version));
  }

  private async writeActivation(
    overlayHost: string,
    items: readonly InstallationItem[],
  ): Promise<string> {
    const directory = await privateDirectory(overlayHost, []);
    const activationFile = directory.displayEntry('mise.toml');
    const lines = ['# Generated by code-agents-webcli. Do not put credentials here.', '[tools]'];
    for (const item of items) {
      const tool = this.tools[item.tool];
      if (tool.installer === 'mise') {
        const key = /^[A-Za-z0-9_-]+$/.test(tool.miseName)
          ? tool.miseName
          : JSON.stringify(tool.miseName);
        lines.push(`${key} = ${JSON.stringify(item.version)}`);
      }
    }
    lines.push('');
    try {
      await atomicPublish(directory, 'mise.toml', lines.join('\n'), 0o600);
      return activationFile;
    } finally {
      await directory.close();
    }
  }

}

/**
 * Coordinate install and cleanup for one durable tool version. Cleanup callers
 * must recheck their database reference set inside `operation` before deleting:
 * reaching the callback proves every earlier install/cleanup for this key ended.
 */
export async function withOwnerToolVersionLock<T>(
  input: OwnerToolVersionLock,
  operation: () => Promise<T>,
): Promise<T> {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(input.tool)
    || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(input.version)) {
    throw new Error('owner tool version lock is invalid');
  }
  const ownerHome = await canonicalOwnerHome(input.ownerHomeHost);
  const key = JSON.stringify([ownerHome, input.tool, input.version]);
  return withSharedQueue(sharedInstallationLocks, key, operation);
}

/**
 * Serialize owner-wide mise mutation such as shared reshim and version cleanup.
 * When an exact version lock is also needed, callers must acquire that first.
 */
export async function withOwnerMiseMutationLock<T>(
  ownerHomeHost: string,
  operation: () => Promise<T>,
): Promise<T> {
  const ownerHome = await canonicalOwnerHome(ownerHomeHost);
  return withSharedQueue(sharedMiseMutationLocks, ownerHome, operation);
}

async function canonicalOwnerHome(ownerHomeHost: string): Promise<string> {
  let ownerHome = path.resolve(ownerHomeHost);
  try {
    ownerHome = await fsp.realpath(ownerHome);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return ownerHome;
}

async function withSharedQueue<T>(
  registry: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = registry.get(key) || Promise.resolve();
  let release!: () => void;
  const slot = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => slot);
  registry.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (registry.get(key) === tail) registry.delete(key);
  }
}

function miseEnvironment(ownerHome: string): Readonly<Record<string, string>> {
  const data = `${ownerHome}/.local/share/code-agents/mise`;
  return {
    HOME: ownerHome,
    PATH: `${data}/shims:${ownerHome}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    MISE_DATA_DIR: data,
    MISE_CACHE_DIR: `${ownerHome}/.cache/code-agents/mise`,
    MISE_STATE_DIR: `${ownerHome}/.local/state/code-agents/mise`,
    MISE_CONFIG_DIR: '/opt/code-agents-project/mise',
    MISE_CONFIG_FILE: '/opt/code-agents-project/mise.toml',
    MISE_SHIMS_DIR: `${data}/shims`,
    MISE_AUTO_INSTALL: '0',
  };
}

function safeItemFailure(error: unknown, tool: string): { code: string; message: string } {
  if (error instanceof ProvisioningFoundationError) {
    return { code: error.safeCode, message: error.safeMessage };
  }
  if (error instanceof TargetCompatibilityError) {
    return { code: error.code, message: error.message };
  }
  return { code: 'INSTALL_FAILED', message: `Could not install ${tool}` };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function miseDispatcher(): string {
  return [
    '#!/bin/sh',
    'set -eu',
    'case "$(uname -m)" in',
    '  x86_64|amd64) code_agents_arch=x64 ;;',
    '  aarch64|arm64) code_agents_arch=arm64 ;;',
    '  *) echo "mise is unavailable for this architecture" >&2; exit 126 ;;',
    'esac',
    'code_agents_libc=glibc',
    'if command -v ldd >/dev/null 2>&1; then',
    '  case "$(ldd --version 2>&1 || true)" in *musl*) code_agents_libc=musl ;; esac',
    'fi',
    'if test -z "${HOME:-}"; then echo "mise requires HOME" >&2; exit 126; fi',
    'code_agents_binary="$HOME/.local/share/code-agents/platforms/linux-$code_agents_arch-$code_agents_libc/bin/mise"',
    'if test ! -x "$code_agents_binary"; then echo "mise is not installed for this platform" >&2; exit 127; fi',
    'code_agents_invoked_as=${0##*/}',
    'if test "$code_agents_invoked_as" != mise; then',
    '  exec "$code_agents_binary" exec -- "$code_agents_invoked_as" "$@"',
    'fi',
    'exec "$code_agents_binary" "$@"',
    '',
  ].join('\n');
}

function teaDispatcher(version: string): string {
  if (version !== PINNED_TEA_VERSION) throw new Error('tea dispatcher version is not pinned');
  return [
    '#!/bin/sh',
    'set -eu',
    'case "$(uname -m)" in',
    '  x86_64|amd64) code_agents_arch=x64 ;;',
    '  aarch64|arm64) code_agents_arch=arm64 ;;',
    '  *) echo "tea is unavailable for this architecture" >&2; exit 126 ;;',
    'esac',
    'if test -z "${HOME:-}"; then echo "tea requires HOME" >&2; exit 126; fi',
    `XDG_CONFIG_HOME=${TEA_TMPFS_XDG_CONFIG_HOME}`,
    'export XDG_CONFIG_HOME',
    `code_agents_binary="$HOME/.local/share/code-agents/tools/tea/${version}/linux-$code_agents_arch/tea"`,
    'if test ! -x "$code_agents_binary"; then echo "tea is not installed for this architecture" >&2; exit 127; fi',
    'exec "$code_agents_binary" "$@"',
    '',
  ].join('\n');
}

/** Atomically replace one fixed, owner-only launcher without following links. */
async function publishPrivateEntrypoint(
  ownerHome: string,
  name: 'mise' | 'tea',
  contents: string,
): Promise<void> {
  const directory = await privateDirectory(ownerHome, ['.local', 'bin']);
  try {
    await atomicPublish(directory, name, contents, 0o700);
  } finally {
    await directory.close();
  }
}

const OPEN_DIRECTORY_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
const OPEN_PRIVATE_READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
const OPEN_PRIVATE_WRITE_FLAGS = fsConstants.O_WRONLY | fsConstants.O_CREAT
  | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;
const DESCRIPTOR_ROOT = process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd';

interface PrivateFile {
  bytes: Uint8Array | null;
  mode: number;
}

class AnchoredPrivateDirectory {
  private closed = false;

  constructor(readonly handle: FileHandle, readonly displayPath: string) {}

  entry(name: string): string {
    validatePrivateName(name);
    return `${DESCRIPTOR_ROOT}/${this.handle.fd}/${name}`;
  }

  displayEntry(name: string): string {
    validatePrivateName(name);
    return path.join(this.displayPath, name);
  }

  /** The user-visible path must still name the exact directory inode we opened. */
  async assertReachable(): Promise<void> {
    const visible = await openDirectoryNoFollow(this.displayPath);
    try {
      const [anchoredStat, visibleStat] = await Promise.all([this.handle.stat(), visible.stat()]);
      if (!sameInode(anchoredStat, visibleStat)) {
        throw new Error('private directory changed during publication');
      }
    } finally {
      await visible.close();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.handle.close();
  }
}

/**
 * Create/open a 0700 directory chain by walking from opened directory handles.
 * Every child lookup after the root is relative to `/proc/self/fd/<dirfd>` and
 * opened with O_NOFOLLOW, so replacing a checked pathname cannot redirect a
 * privileged server write outside the owner's mounted root.
 */
async function privateDirectory(
  root: string,
  segments: readonly string[],
): Promise<AnchoredPrivateDirectory> {
  const rootPath = path.resolve(root);
  try {
    await fsp.mkdir(rootPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }

  let current = await openDirectoryNoFollow(rootPath);
  let displayPath = rootPath;
  try {
    await current.chmod(0o700);
    for (const segment of segments) {
      validatePrivateName(segment);
      const child = descriptorEntry(current, segment);
      try {
        await fsp.mkdir(child, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const next = await openDirectoryNoFollow(child);
      try {
        await next.chmod(0o700);
        await current.close();
      } catch (error) {
        await next.close();
        throw error;
      }
      current = next;
      displayPath = path.join(displayPath, segment);
    }
    const directory = new AnchoredPrivateDirectory(current, displayPath);
    await directory.assertReachable();
    return directory;
  } catch (error) {
    try {
      await current.close();
    } catch {
      // Preserve the path-safety error that caused the walk to fail.
    }
    throw error;
  }
}

async function openDirectoryNoFollow(candidate: string): Promise<FileHandle> {
  const handle = await fsp.open(candidate, OPEN_DIRECTORY_FLAGS);
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory()) throw new Error('private path is not a directory');
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readPrivateFile(
  directory: AnchoredPrivateDirectory,
  name: string,
  maxBytes: number,
): Promise<PrivateFile | null> {
  let handle: FileHandle;
  try {
    handle = await fsp.open(directory.entry(name), OPEN_PRIVATE_READ_FLAGS);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('private entry is not a regular file');
    const mode = stat.mode & 0o777;
    if (stat.size > maxBytes) return { bytes: null, mode };
    return { bytes: new Uint8Array(await handle.readFile()), mode };
  } finally {
    await handle.close();
  }
}

/** Publish a complete inode with one anchored rename; readers see old or new. */
async function atomicPublish(
  directory: AnchoredPrivateDirectory,
  name: string,
  contents: Uint8Array | string,
  mode: number,
): Promise<void> {
  validatePrivateName(name);
  await withSharedQueue(
    sharedPublicationLocks,
    path.resolve(directory.displayEntry(name)),
    async () => {
      const temporaryName = `.${name}-${randomUUID()}.tmp`;
      const temporary = directory.entry(temporaryName);
      const destination = directory.entry(name);
      let handle: FileHandle | null = null;
      let published = false;
      try {
        handle = await fsp.open(temporary, OPEN_PRIVATE_WRITE_FLAGS, mode);
        if (typeof contents === 'string') await handle.writeFile(contents, 'utf8');
        else await handle.writeFile(contents);
        await handle.chmod(mode);
        await handle.sync();
        const sourceStat = await handle.stat();
        await fsp.rename(temporary, destination);
        published = true;

        const visible = await fsp.open(destination, OPEN_PRIVATE_READ_FLAGS);
        try {
          const visibleStat = await visible.stat();
          if (!visibleStat.isFile() || !sameInode(sourceStat, visibleStat)
            || (visibleStat.mode & 0o777) !== mode) {
            throw new Error('private file publication changed unexpectedly');
          }
        } finally {
          await visible.close();
        }
        await directory.assertReachable();
      } finally {
        if (handle) await handle.close();
        if (!published) {
          try {
            await fsp.unlink(temporary);
          } catch {
            // O_EXCL plus a random name prevents our own writers from colliding;
            // cleanup must never follow or recursively remove an attacker entry.
          }
        }
      }
    },
  );
}

function descriptorEntry(directory: FileHandle, name: string): string {
  validatePrivateName(name);
  return `${DESCRIPTOR_ROOT}/${directory.fd}/${name}`;
}

function validatePrivateName(name: string): void {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')
    || name.includes('\0')) {
    throw new Error('invalid private directory component');
  }
}

function sameInode(
  left: Pick<Awaited<ReturnType<FileHandle['stat']>>, 'dev' | 'ino'>,
  right: Pick<Awaited<ReturnType<FileHandle['stat']>>, 'dev' | 'ino'>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
