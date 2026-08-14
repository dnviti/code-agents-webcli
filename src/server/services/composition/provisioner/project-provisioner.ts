import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { probeTargetPlatform } from './platform.js';
import type { ContainerCommandRunner, TargetPlatform } from './platform.js';
import {
  fetchPinnedMiseArtifact,
  fetchPinnedTeaArtifact,
  PINNED_MISE_ARTIFACTS,
  PINNED_TEA_ARTIFACTS,
  MISE_BINARY_MAX_BYTES,
  TEA_BINARY_MAX_BYTES,
} from './artifacts.js';
import type {
  MiseArtifact,
  MiseArtifactFetcher,
  TeaArtifact,
  TeaArtifactFetcher,
} from './artifacts.js';
import { APPROVED_TOOL_CATALOG } from './installation.js';
import type {
  ApprovedTool,
  InstallationItem,
  InstallationStatus,
  InstallationRecord,
  InstallationStateStore,
  ProjectProvisionerOptions,
  ProvisionRequest,
  ProvisionResult,
} from './installation.js';
import { withOwnerToolVersionLock, withOwnerMiseMutationLock } from './locks.js';
import { privateDirectory, readPrivateFile, atomicPublish } from './private-fs.js';
import type { PrivateFile } from './private-fs.js';
import {
  ProvisioningFoundationError,
  sha256,
  miseEnvironment,
  safeItemFailure,
  miseDispatcher,
  teaDispatcher,
  publishPrivateEntrypoint,
} from './dispatchers.js';

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
