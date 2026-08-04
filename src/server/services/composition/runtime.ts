/** Apply one immutable composition to one identity-verified project runtime. */

import type {
  CompositionRuntimeAdapter,
  CompositionRuntimeContext,
} from '../projects/manager.js';
import type {
  CompositionInstallation,
  CompositionInstallationStatus,
  ProjectStore,
} from '../projects/store.js';
import {
  InstallationItem,
  InstallationRecord,
  InstallationStateStore,
  ProjectProvisioner,
} from './provisioner.js';
import {
  FORGE_CATALOG,
  ForgeCredentialMaterializer,
  ForgeKind,
  FORGE_SCRATCH_ROOT,
} from './forge.js';
import { getAgentRuntimeCatalogEntry, getRuntimeCatalogEntry } from './catalog.js';

const PROJECT_GIT_CONFIG = '/opt/code-agents-project/gitconfig';

export class DefaultCompositionRuntime implements CompositionRuntimeAdapter {
  constructor(private readonly store: ProjectStore) {}

  async prepare(context: CompositionRuntimeContext): Promise<{ installations: CompositionInstallation[] }> {
    return this.apply(context, false);
  }

  async retryFailed(context: CompositionRuntimeContext): Promise<{ installations: CompositionInstallation[] }> {
    return this.apply(context, true);
  }

  async refreshForgeCredential(context: CompositionRuntimeContext): Promise<void> {
    await this.authenticateForge(context, true);
  }

  async configureGit(context: CompositionRuntimeContext): Promise<void> {
    const runner = commandRunner(context);
    const globalPath = `${context.ownerHomeContainer}/.gitconfig`;
    await runner.run('git', ['config', '--file', globalPath, '--replace-all', 'user.name', context.globalIdentity.name], {
      cwd: '/opt/code-agents-project',
    });
    await runner.run('git', ['config', '--file', globalPath, '--replace-all', 'user.email', context.globalIdentity.email], {
      cwd: '/opt/code-agents-project',
    });

    // The generated project config is the container's GIT_CONFIG_GLOBAL. It
    // includes the durable user config, then optionally overrides identity for
    // this project only. No repository-controlled config is loaded here.
    await runner.run('install', ['-m', '0600', '/dev/null', PROJECT_GIT_CONFIG], {
      cwd: '/opt/code-agents-project',
    });
    await runner.run('git', ['config', '--file', PROJECT_GIT_CONFIG, '--replace-all', 'include.path', globalPath], {
      cwd: '/opt/code-agents-project',
    });
    if (context.projectIdentity) {
      await runner.run('git', ['config', '--file', PROJECT_GIT_CONFIG, '--replace-all', 'user.name', context.projectIdentity.name], {
        cwd: '/opt/code-agents-project',
      });
      await runner.run('git', ['config', '--file', PROJECT_GIT_CONFIG, '--replace-all', 'user.email', context.projectIdentity.email], {
        cwd: '/opt/code-agents-project',
      });
    }
  }

  private async apply(
    context: CompositionRuntimeContext,
    retry: boolean,
  ): Promise<{ installations: CompositionInstallation[] }> {
    const runner = commandRunner(context);
    const items = compositionInstallationItems(context);

    if (items.length) {
      const provisioner = new ProjectProvisioner({
        runner,
        state: installationState(this.store, context, items),
      });
      const request = {
        compositionId: context.composition.id,
        ownerHomeHost: context.ownerHomeHost,
        ownerHomeContainer: context.ownerHomeContainer,
        projectOverlayHost: context.projectOverlayHost,
        items,
      };
      if (retry) await provisioner.retryFailed(request);
      else await provisioner.provision(request);
    }

    await this.authenticateForge(context);

    return {
      installations: this.store.listCompositionInstallations(
        context.composition.id,
        context.project.ownerUserId,
      ),
    };
  }

  private async authenticateForge(context: CompositionRuntimeContext, strict = false): Promise<void> {
    const forgeKind = context.chosen.forgeKind;
    const host = context.composition.forgeHost;
    if (forgeKind && host) {
      const runner = commandRunner(context);
      // A stopped container can retain its tmpfs until it is started again.
      // Clear every supported client's fixed path before deciding whether a
      // current credential should be materialized.
      await runner.run('rm', [
        '-rf', '--',
        `${FORGE_SCRATCH_ROOT}/home`,
        `${FORGE_SCRATCH_ROOT}/xdg`,
        `${FORGE_SCRATCH_ROOT}/gh`,
        `${FORGE_SCRATCH_ROOT}/glab`,
        `${FORGE_SCRATCH_ROOT}/tea`,
      ], { cwd: FORGE_SCRATCH_ROOT });

      const current = this.store.credentialRecordFor(context.project.ownerUserId, host);
      if ((current?.revision ?? null) !== context.credentialRevision
        || (current?.kind ?? null) !== context.credentialKind) {
        throw new Error('Forge credential changed while the project was being prepared');
      }
      if (!context.credential) return;

      const definition = FORGE_CATALOG[forgeKind];
      const installation = this.store.listCompositionInstallations(
        context.composition.id,
        context.project.ownerUserId,
      ).find((record) => record.itemId === definition.cli);
      if (installation?.status !== 'installed') {
        if (strict) throw new Error(`Forge client ${definition.cli} is not installed`);
        return;
      }
      try {
        await new ForgeCredentialMaterializer(runner).materialize({
          host,
          kind: forgeKind,
          token: context.credential,
        });
        this.store.setConnectedHostValidation({
          userId: context.project.ownerUserId,
          host,
          ...(context.credentialKind ? { kind: context.credentialKind } : {}),
          ...(context.credentialRevision !== null
            ? { expectedCredentialRevision: context.credentialRevision }
            : {}),
          forgeKind,
          status: 'valid',
        });
      } catch {
        this.store.updateCompositionInstallationForUser({
          compositionId: context.composition.id,
          userId: context.project.ownerUserId,
          itemId: definition.cli,
          patch: {
            status: 'failed',
            errorCode: 'FORGE_AUTH_FAILED',
            errorMessage: `Could not authenticate ${definition.cli} for ${host}`,
          },
        });
        this.store.setConnectedHostValidation({
          userId: context.project.ownerUserId,
          host,
          ...(context.credentialKind ? { kind: context.credentialKind } : {}),
          ...(context.credentialRevision !== null
            ? { expectedCredentialRevision: context.credentialRevision }
            : {}),
          forgeKind,
          status: 'invalid',
          errorCode: 'credential_rejected',
          errorMessage: 'Credential was rejected when the forge client was prepared',
        });
        if (strict) throw new Error(`Could not authenticate ${definition.cli} for ${host}`);
      }
    }
  }
}

function commandRunner(context: CompositionRuntimeContext) {
  return {
    run: async (
      command: string,
      args: readonly string[],
      options: { cwd?: string; env?: Readonly<Record<string, string>>; input?: string; signal?: AbortSignal } = {},
    ) => context.engine.exec(
      {
        name: context.containerName,
        identity: context.containerIdentity,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.env ? { env: { ...options.env } } : {}),
        ...(options.input !== undefined ? { input: options.input } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      },
      command,
      [...args],
    ),
  };
}

export function compositionInstallationItems(context: CompositionRuntimeContext): InstallationItem[] {
  const items: InstallationItem[] = context.chosen.runtimes.map((runtime) => ({
    id: runtime.runtimeId,
    tool: runtime.runtimeId,
    version: runtime.version,
  }));
  const agents = context.chosen.agents || [];
  const selectedLanguages = new Set(context.chosen.runtimes.map((runtime) => runtime.runtimeId));
  const requirements = new Set(agents.map((agent) => getAgentRuntimeCatalogEntry(agent.runtimeId).requires));
  // npm and pipx agent packages need their host language even when the
  // repository itself does not. Track that foundation as a retryable item,
  // but do not pretend the user selected it as a project language.
  for (const requirement of requirements) {
    if (!selectedLanguages.has(requirement)) {
      const dependency = getRuntimeCatalogEntry(requirement);
      items.push({
        id: `agent-foundation-${requirement}`,
        tool: requirement,
        version: dependency.defaultVersion,
      });
    }
  }
  for (const agent of agents) {
    const definition = getAgentRuntimeCatalogEntry(agent.runtimeId);
    items.push({ id: `agent-${agent.runtimeId}`, tool: definition.tool, version: agent.version });
  }
  if (context.chosen.forgeKind) {
    const forge = FORGE_CATALOG[context.chosen.forgeKind];
    items.push({ id: forge.cli, tool: forge.cli, version: forge.version });
  }
  return items;
}

function installationState(
  store: ProjectStore,
  context: CompositionRuntimeContext,
  items: readonly InstallationItem[],
): InstallationStateStore {
  const definitions = new Map(items.map((item) => [item.id, item]));
  const list = (): InstallationRecord[] => store
    .listCompositionInstallations(context.composition.id, context.project.ownerUserId)
    .filter((row) => definitions.has(row.itemId))
    .map((row) => ({
      ...definitions.get(row.itemId)!,
      status: row.status,
      attempts: row.attempts,
      installedVersion: row.installedVersion,
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
    }));
  const update = (
    itemId: string,
    status: CompositionInstallationStatus,
    patch: Partial<Pick<CompositionInstallation, 'installedVersion' | 'errorCode' | 'errorMessage'>> = {},
    incrementAttempts = false,
  ): void => {
    if (!definitions.has(itemId)) throw new Error('installation item is not part of this composition');
    const saved = store.updateCompositionInstallationForUser({
      compositionId: context.composition.id,
      userId: context.project.ownerUserId,
      itemId,
      patch: { status, incrementAttempts, ...patch },
    });
    if (!saved) throw new Error('composition installation is unavailable');
  };
  return {
    ensureItems: (_compositionId, expected) => {
      for (const item of expected) {
        if (!definitions.has(item.id)) throw new Error('installation recipe changed');
        if (!store.listCompositionInstallations(context.composition.id, context.project.ownerUserId)
          .some((row) => row.itemId === item.id)) {
          store.updateCompositionInstallationForUser({
            compositionId: context.composition.id,
            userId: context.project.ownerUserId,
            itemId: item.id,
            patch: { status: 'pending' },
          });
        }
      }
    },
    list: () => list(),
    markInstalling: (_compositionId, itemId) => update(itemId, 'installing', {}, true),
    markInstalled: (_compositionId, itemId, version) => update(itemId, 'installed', {
      installedVersion: version,
      errorCode: null,
      errorMessage: null,
    }),
    markFailed: (_compositionId, itemId, errorCode, safeMessage) => update(itemId, 'failed', {
      installedVersion: null,
      errorCode,
      errorMessage: safeMessage,
    }),
  };
}
