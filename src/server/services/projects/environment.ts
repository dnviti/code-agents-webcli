/** The project-shaped container: a durable owner home plus a disposable workspace. */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ContainerEnvironment, EnvironmentManager, HostEnvironment, LOGIN_LABEL, MANAGED_LABEL, TIER_LABEL, USER_ID_LABEL } from '../environments/manager.js';
import { EnvironmentEngine, RunResult } from '../environments/engine.js';
import { trackContainerProcess } from '../environments/process-control.js';
import { PROJECT_LABEL, projectContainerName, TARGET_LABEL, targetLabelValue } from '../environments/naming.js';
import { EnvironmentOwner, Mount, UserEnvironment, WrappedProcessControl } from '../environments/types.js';
import { Project } from './store.js';
import { repoBaseName } from './clone.js';

export const PROJECT_WORKSPACE = '/workspace';
export const PROJECT_OVERLAY = '/opt/code-agents-project';
export const FORGE_SCRATCH = '/run/code-agents-forge';

/** Portable app-owned root used by host-local projects. */
export function localProjectWorkspaceRoot(homeDir = os.homedir(), pathApi: Pick<typeof path, 'join'> = path): string {
  return pathApi.join(homeDir, '.cc-web', 'workspaces');
}

/** Secret-free, application-owned paths exposed in container metadata. */
export function projectContainerEnvironment(containerHome: string, login: string): Record<string, string> {
  const miseData = `${containerHome}/.local/share/code-agents/mise`;
  const miseShims = `${miseData}/shims`;
  return {
    HOME: containerHome,
    USER: login,
    TERM: 'xterm-256color',
    PATH: `${miseShims}:${containerHome}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    MISE_DATA_DIR: miseData,
    MISE_CACHE_DIR: `${containerHome}/.cache/code-agents/mise`,
    MISE_STATE_DIR: `${containerHome}/.local/state/code-agents/mise`,
    MISE_CONFIG_DIR: `${PROJECT_OVERLAY}/mise`,
    MISE_CONFIG_FILE: `${PROJECT_OVERLAY}/mise.toml`,
    MISE_SHIMS_DIR: miseShims,
    MISE_AUTO_INSTALL: '0',
    // App-generated project config includes the user's durable ~/.gitconfig
    // and may layer a project-only identity without mutating repository data.
    GIT_CONFIG_GLOBAL: `${PROJECT_OVERLAY}/gitconfig`,
    GIT_CONFIG_NOSYSTEM: '1',
    GH_CONFIG_DIR: `${FORGE_SCRATCH}/gh`,
    GLAB_CONFIG_DIR: `${FORGE_SCRATCH}/glab`,
    // tea itself reads XDG_CONFIG_HOME; its app-owned launcher points there.
    // This metadata value names that same tmpfs file without containing a token.
    TEA_CONFIG: `${FORGE_SCRATCH}/xdg/tea/config.yml`,
  };
}

export interface ProjectEnvironmentResult {
  environment: UserEnvironment;
  /** Exact engine snapshot that admitted this project runtime. */
  engine: EnvironmentEngine;
  workingDir: string;
  /** Host roots a requested/persisted session cwd may be confined within. */
  allowedWorkingDirs: string[];
  /**
   * Engine-scoped paths for terminal/file-browser operations.  These are never
   * host paths: arbitrary paths such as /tmp exist only in this project's
   * container. The roots have intentionally different lifetime guarantees:
   * owner home survives rebuild; workspace survives an ordinary stop but is
   * wiped/fresh-cloned on a true rebuild; every other path is disposable.
   */
  containerAccess: ProjectContainerAccess;
  containerName: string;
  created: boolean;
}

export interface ProjectContainerAccess {
  projectId: string;
  ownerUserId: number;
  containerName: string;
  containerIdentity: string;
  root: '/';
  workspaceRoot: typeof PROJECT_WORKSPACE;
  ownerHomeRoot: string;
}

export interface ProjectTrackedExecution {
  result: Promise<RunResult>;
  processControl: WrappedProcessControl;
}

export interface ProjectTrackedSpawnDescriptor {
  file: string;
  args: string[];
  processControl: WrappedProcessControl;
  /** Re-inspect through the exact engine snapshot that built this descriptor. */
  verifyIdentity(): Promise<void>;
}

export type ProjectContainerPathLifetime = 'workspace' | 'owner_home' | 'disposable';

/** Validate a container-local cwd without ever confusing it for a host path. */
export function validateProjectContainerPath(access: ProjectContainerAccess, input: string): string {
  if (typeof input !== 'string' || !input || input.includes('\0') || !path.posix.isAbsolute(input)) {
    throw new Error('project container path must be an absolute path');
  }
  const normalized = path.posix.normalize(input);
  if (!normalized.startsWith('/')) throw new Error('project container path escapes its root');
  return normalized;
}

export function classifyProjectContainerPath(access: ProjectContainerAccess, input: string): ProjectContainerPathLifetime {
  const value = validateProjectContainerPath(access, input);
  const within = (root: string) => value === root || value.startsWith(`${root}/`);
  if (within(access.ownerHomeRoot)) return 'owner_home';
  if (within(access.workspaceRoot)) return 'workspace';
  return 'disposable';
}

/** A same-name container is known to belong to somebody else; never touch it. */
export class ProjectContainerOwnershipError extends Error {}

/**
 * Engine preparation may have left this project's deterministic container
 * running, but ownership/absence or a successful stop could not be proven.
 * Callers must record the name and retain a counted lifecycle state.
 */
export class ProjectContainerStateUnknownError extends Error {
  constructor(message: string, readonly containerName: string) {
    super(message);
  }
}

export type ProjectCheckoutState = 'valid' | 'empty_or_absent' | 'unsafe';

export class ProjectEnvironmentManager {
  constructor(
    private readonly environments: EnvironmentManager,
    private readonly localWorkspaceRoot = localProjectWorkspaceRoot(),
  ) {}

  worktreePath(project: Project, _owner: EnvironmentOwner): string {
    if (project.executionKind === 'host') {
      return path.join(this.localWorkspaceRoot, project.id);
    }
    // Sibling of owner homes: mounting the persistent home into project A must
    // not reveal project B through /home/<owner>/projects/B.
    return path.join(this.environments.projectStorageRoot(project.targetId), project.id);
  }

  ownerHomePath(project: Project, owner: EnvironmentOwner): string {
    if (project.executionKind === 'host') return os.homedir();
    return this.environments.ownerHomeOnTarget(owner, project.targetId).hostPath;
  }

  checkoutPath(project: Project, owner: EnvironmentOwner): string {
    const root = this.worktreePath(project, owner);
    return project.repoUrl ? path.join(root, repoBaseName(project.repoUrl)) : root;
  }

  checkoutContainerPath(project: Project): string {
    return project.repoUrl ? `${PROJECT_WORKSPACE}/${repoBaseName(project.repoUrl)}` : PROJECT_WORKSPACE;
  }

  /** Project-only durable settings, deliberately outside every owner home. */
  overlayPath(project: Project): string {
    if (project.executionKind === 'host') {
      return path.join(os.homedir(), '.cc-web', 'project-overlays', project.id);
    }
    return path.join(
      this.environments.projectTarget(project.targetId).config.rootDir,
      'project-overlays',
      project.id,
    );
  }

  /** Stable host roots consumed by lifecycle cleanup and storage reporting. */
  durablePaths(project: Project, owner: EnvironmentOwner): {
    ownerHome: string;
    workspace: string;
    overlay: string;
  } {
    return {
      ownerHome: this.ownerHomePath(project, owner),
      workspace: this.worktreePath(project, owner),
      overlay: this.overlayPath(project),
    };
  }

  /** Integration calls this only after the owner-scoped project row is deleted. */
  async removeOverlay(project: Project): Promise<void> {
    await fsp.rm(this.overlayPath(project), { recursive: true, force: true });
  }

  /**
   * Resolve an already-running project without any lifecycle mutation.
   *
   * Composition retry uses this path so retrying failed tools cannot preserve,
   * wipe, recreate, start, or clone a project as an accidental side effect.
   */
  async existing(project: Project, owner: EnvironmentOwner): Promise<ProjectEnvironmentResult | null> {
    if (!project.container) return null;
    if (owner.id !== project.ownerUserId) {
      throw new ProjectContainerOwnershipError('project owner does not match the requested environment');
    }
    const target = this.environments.projectTarget(project.targetId);
    const owned = await this.ownedDescription(project, target.engine);
    if (!owned) return null;
    const ownerHome = this.environments.ownerHomeOnTarget(owner, project.targetId);
    const root = this.worktreePath(project, owner);
    const overlay = this.overlayPath(project);
    const mounts: Mount[] = [
      { hostPath: ownerHome.hostPath, containerPath: ownerHome.containerPath },
      { hostPath: root, containerPath: PROJECT_WORKSPACE },
      { hostPath: overlay, containerPath: PROJECT_OVERLAY },
      ...target.config.extraMounts,
    ];
    const environment = new ContainerEnvironment({
      name: owned.description.name,
      identity: owned.description.identity,
      homeDir: ownerHome.hostPath,
      containerHome: ownerHome.containerPath,
      engine: owned.engine,
      // Project compatibility requires Bash. Ignore legacy shell metadata so
      // an existing project created when this path advertised only `sh` is
      // upgraded immediately without rebuilding its container.
      shells: ['bash'],
      mounts: [mounts[1], mounts[2], mounts[0], ...mounts.slice(3)],
    });
    return {
      environment,
      engine: owned.engine,
      workingDir: this.checkoutPath(project, owner),
      allowedWorkingDirs: [root, ownerHome.hostPath],
      containerAccess: {
        projectId: project.id,
        ownerUserId: project.ownerUserId,
        containerName: owned.description.name,
        containerIdentity: owned.description.identity,
        root: '/',
        workspaceRoot: PROJECT_WORKSPACE,
        ownerHomeRoot: ownerHome.containerPath,
      },
      containerName: owned.description.name,
      created: false,
    };
  }

  async hasValidCheckout(project: Project, owner: EnvironmentOwner): Promise<boolean> {
    return (await this.checkoutState(project, owner)) === 'valid';
  }

  async checkoutState(project: Project, owner: EnvironmentOwner): Promise<ProjectCheckoutState> {
    if (!project.repoUrl) return 'valid';
    const checkout = this.checkoutPath(project, owner);
    try {
      const stat = await fsp.stat(path.join(checkout, '.git'));
      return stat.isDirectory() || stat.isFile() ? 'valid' : 'unsafe';
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') return 'unsafe';
      try {
        const checkoutStat = await fsp.stat(checkout);
        if (!checkoutStat.isDirectory()) return 'unsafe';
        return (await fsp.readdir(checkout)).length ? 'unsafe' : 'empty_or_absent';
      } catch (checkoutError) {
        return (checkoutError as NodeJS.ErrnoException).code === 'ENOENT' ? 'empty_or_absent' : 'unsafe';
      }
    }
  }

  async clearCheckout(project: Project, owner: EnvironmentOwner): Promise<void> {
    if (!project.repoUrl) return;
    const checkout = this.checkoutPath(project, owner);
    const root = this.worktreePath(project, owner);
    if (!path.resolve(checkout).startsWith(`${path.resolve(root)}${path.sep}`)) {
      throw new Error('refusing unsafe partial checkout removal');
    }
    await fsp.rm(checkout, { recursive: true, force: true });
  }

  async ensure(project: Project, owner: EnvironmentOwner): Promise<ProjectEnvironmentResult> {
    if (project.executionKind === 'host') throw new Error('host projects do not have a container runtime');
    // A saved target is authoritative.  projectTarget intentionally refuses a
    // missing target instead of quietly selecting today's active machine.
    const target = this.environments.projectTarget(project.targetId);
    const ownerHome = this.environments.ownerHomeOnTarget(owner, project.targetId);
    const root = this.worktreePath(project, owner);
    const overlay = this.overlayPath(project);
    await fsp.mkdir(ownerHome.hostPath, { recursive: true, mode: 0o700 });
    await fsp.chmod(ownerHome.hostPath, 0o700);
    await fsp.mkdir(root, { recursive: true, mode: 0o700 });
    await fsp.chmod(root, 0o700);
    await fsp.mkdir(overlay, { recursive: true, mode: 0o700 });
    await fsp.chmod(overlay, 0o700);

    const name = project.container?.name || projectContainerName(target.config.namePrefix, project);
    const tier = project.tierId
      ? target.config.tiers.find((candidate) => candidate.id === project.tierId) || null
      : this.environments.intendedTierOnTarget(owner.id, project.targetId);
    const mounts: Mount[] = [
      { hostPath: ownerHome.hostPath, containerPath: ownerHome.containerPath },
      { hostPath: root, containerPath: PROJECT_WORKSPACE },
      { hostPath: overlay, containerPath: PROJECT_OVERLAY },
      ...target.config.extraMounts,
    ];
    // A fresh project's deterministic name can still be occupied by a
    // foreign container. Never let `ensure` silently adopt it.
    const described = await this.inspect(target.engine, name);
    const expectedTarget = targetLabelValue(target.key);
    const ownsContainer = (labels: Record<string, string>) => (
      labels[MANAGED_LABEL] === 'true'
      && labels[PROJECT_LABEL] === project.id
      && labels[USER_ID_LABEL] === String(owner.id)
      && labels[TARGET_LABEL] === expectedTarget
    );
    if (described && !ownsContainer(described.labels)) {
      throw new ProjectContainerOwnershipError(`project container '${name}' has mismatched ownership labels`);
    }
    let result: { created: boolean; identity: string };
    try {
      result = await target.engine.ensureIdentity({
        name,
        image: project.container?.image || target.config.image,
        mounts,
        memoryMounts: [{ containerPath: FORGE_SCRATCH, mode: 0o700 }],
        containerHome: ownerHome.containerPath,
        cpus: tier ? tier.cpus : target.config.cpus,
        memory: tier ? tier.memory : target.config.memory,
        labels: {
          [MANAGED_LABEL]: 'true',
          [PROJECT_LABEL]: project.id,
          [USER_ID_LABEL]: String(owner.id),
          [LOGIN_LABEL]: owner.githubLogin,
          [TARGET_LABEL]: targetLabelValue(target.key),
          ...(tier ? { [TIER_LABEL]: tier.id } : {}),
        },
        env: projectContainerEnvironment(ownerHome.containerPath, owner.githubLogin),
      }, described);
    } catch (error) {
      let after = null;
      try { after = await this.inspect(target.engine, name); } catch { /* Unknown is handled below. */ }
      if (after && !ownsContainer(after.labels)) {
        throw new ProjectContainerOwnershipError(`project container '${name}' changed ownership during ensure`);
      }
      if (after) {
        if (!described || after.identity !== described.identity) {
          throw new ProjectContainerStateUnknownError(
            `${(error as Error).message}; a same-name project container appeared during ensure and was not touched`,
            name,
          );
        }
        try {
          await target.engine.stopIdentity(after);
        } catch (stopError) {
          throw new ProjectContainerStateUnknownError(
            `${(error as Error).message}; owned project container could not be stopped: ${(stopError as Error).message}`,
            name,
          );
        }
        throw error;
      }
      throw new ProjectContainerStateUnknownError(
        `${(error as Error).message}; project container state could not be verified after ensure failure`,
        name,
      );
    }
    // `describe` and `ensure` are separate engine operations. Verify again so
    // a foreign same-name container appearing in between is never adopted and
    // never receives a project command.
    const verified = await this.inspect(target.engine, name);
    if (!verified) {
      throw new ProjectContainerStateUnknownError(
        `project container '${name}' could not be verified after ensure`,
        name,
      );
    }
    if (!verified.identity) {
      throw new ProjectContainerStateUnknownError(`project container '${name}' has no verifiable immutable identity`, name);
    }
    if (!ownsContainer(verified.labels)) {
      throw new ProjectContainerOwnershipError(`project container '${name}' changed ownership during ensure`);
    }
    if (verified.identity !== result.identity) {
      throw new ProjectContainerOwnershipError(`project container '${name}' changed identity after ensure`);
    }
    const environment = new ContainerEnvironment({
      name,
      identity: verified.identity,
      homeDir: ownerHome.hostPath,
      containerHome: ownerHome.containerPath,
      engine: target.engine,
      shells: ['bash'],
      // Keep the workspace translation first so an explicitly configured
      // overlapping mount cannot shadow the isolated /workspace mapping.
      mounts: [mounts[1], mounts[2], mounts[0], ...mounts.slice(3)],
    });
    return {
      environment,
      engine: target.engine,
      workingDir: this.checkoutPath(project, owner),
      allowedWorkingDirs: [root, ownerHome.hostPath],
      containerAccess: {
        projectId: project.id,
        ownerUserId: project.ownerUserId,
        containerName: name,
        containerIdentity: verified.identity,
        root: '/',
        workspaceRoot: PROJECT_WORKSPACE,
        ownerHomeRoot: ownerHome.containerPath,
      },
      containerName: name,
      created: result.created,
    };
  }

  /** Prepare a host-local workspace without creating or contacting an engine. */
  async ensureLocal(project: Project, owner: EnvironmentOwner): Promise<{
    environment: UserEnvironment;
    workingDir: string;
    allowedWorkingDirs: string[];
  }> {
    if (project.executionKind !== 'host') throw new Error('project is not host-local');
    const root = this.worktreePath(project, owner);
    await fsp.mkdir(root, { recursive: true, mode: 0o700 });
    await fsp.chmod(root, 0o700).catch(() => undefined);
    return {
      environment: new HostEnvironment(os.homedir()),
      workingDir: this.checkoutPath(project, owner),
      allowedWorkingDirs: [root],
    };
  }

  async stop(project: Project): Promise<'absent' | 'stopped'> {
    if (!project.container) return 'absent';
    const owned = await this.ownedDescription(project);
    if (!owned) return 'absent';
    await owned.engine.stopIdentity(owned.description);
    return 'stopped';
  }

  /** Stop only the immutable container that issued a still-live session lease. */
  async stopAccess(
    project: Project,
    access: ProjectContainerAccess,
    exactEngine?: EnvironmentEngine,
  ): Promise<'absent' | 'stopped'> {
    this.assertAccess(project, access);
    const owned = await this.ownedDescription(project, exactEngine);
    if (!owned) return 'absent';
    if (owned.description.identity !== access.containerIdentity) {
      throw new ProjectContainerOwnershipError(
        `project container '${access.containerName}' was replaced before recovery`,
      );
    }
    await owned.engine.stopIdentity(owned.description);
    return 'stopped';
  }

  async remove(project: Project): Promise<void> {
    if (!project.container) return;
    const owned = await this.ownedDescription(project);
    if (!owned) return;
    await owned.engine.removeIdentity(owned.description);
  }

  async status(project: Project): Promise<string | null> {
    if (!project.container) return null;
    const owned = await this.ownedDescription(project);
    return owned?.description.status || null;
  }

  /**
   * Execute an engine-backed file-browser/terminal operation in exactly the
   * container named by a live project lease. Callers only get this through the
   * manager, which binds access to owner/project/lease first.
   */
  async exec(
    project: Project,
    access: ProjectContainerAccess,
    cwd: string,
    command: string,
    commandArgs: string[],
    signal?: AbortSignal,
  ): Promise<RunResult> {
    const owned = await this.ownedAccess(project, access);
    return owned.engine.exec(
      { name: access.containerName, identity: access.containerIdentity, cwd: validateProjectContainerPath(access, cwd), signal },
      command,
      commandArgs,
    );
  }

  /**
   * Validate first, then start one tracked helper through that same engine.
   * A rejection from this method means launch was never attempted; once it
   * resolves, `result` may fail for either a command or transport reason and
   * its process control must always be settled before admission is released.
   */
  async startTrackedExec(
    project: Project,
    access: ProjectContainerAccess,
    cwd: string,
    command: string,
    commandArgs: string[],
    signal?: AbortSignal,
    exactEngine?: EnvironmentEngine,
  ): Promise<ProjectTrackedExecution> {
    const owned = await this.ownedAccess(project, access, exactEngine);
    signal?.throwIfAborted();
    const tracked = trackContainerProcess(
      owned.engine,
      access.containerName,
      access.containerIdentity,
      command,
      commandArgs,
      false,
    );
    return {
      result: owned.engine.exec(
        {
          name: access.containerName,
          identity: access.containerIdentity,
          cwd: validateProjectContainerPath(access, cwd),
          signal,
        },
        tracked.command,
        tracked.args,
      ),
      processControl: tracked.processControl,
    };
  }

  /** Validate ownership then describe a direct engine-client spawn safely. */
  async execDescriptor(
    project: Project,
    access: ProjectContainerAccess,
    cwd: string | undefined,
    command: string,
    commandArgs: string[],
  ): Promise<{ file: string; args: string[] }> {
    const owned = await this.ownedAccess(project, access);
    return {
      file: owned.engine.binary,
      args: owned.engine.execArgs(
        { name: access.containerName, identity: access.containerIdentity, ...(cwd ? { cwd: validateProjectContainerPath(access, cwd) } : {}) },
        command,
        commandArgs,
      ),
    };
  }

  /** Build a tracked pipe descriptor and post-spawn verifier on one engine. */
  async trackedExecDescriptor(
    project: Project,
    access: ProjectContainerAccess,
    cwd: string | undefined,
    command: string,
    commandArgs: string[],
    exactEngine?: EnvironmentEngine,
  ): Promise<ProjectTrackedSpawnDescriptor> {
    const owned = await this.ownedAccess(project, access, exactEngine);
    const tracked = trackContainerProcess(
      owned.engine,
      access.containerName,
      access.containerIdentity,
      command,
      commandArgs,
      false,
    );
    return {
      file: owned.engine.binary,
      args: owned.engine.execArgs(
        {
          name: access.containerName,
          identity: access.containerIdentity,
          ...(cwd ? { cwd: validateProjectContainerPath(access, cwd) } : {}),
        },
        tracked.command,
        tracked.args,
      ),
      processControl: tracked.processControl,
      verifyIdentity: async () => {
        await this.ownedAccess(project, access, owned.engine);
      },
    };
  }

  private async ownedAccess(
    project: Project,
    access: ProjectContainerAccess,
    exactEngine?: EnvironmentEngine,
  ): Promise<{ engine: EnvironmentEngine; description: NonNullable<Awaited<ReturnType<EnvironmentEngine['describe']>>> }> {
    this.assertAccess(project, access);
    const owned = await this.ownedDescription(project, exactEngine);
    if (!owned) throw new ProjectContainerStateUnknownError(
      `project container '${access.containerName}' is missing`, access.containerName,
    );
    if (owned.description.identity !== access.containerIdentity) {
      throw new ProjectContainerOwnershipError(`project container '${access.containerName}' was replaced`);
    }
    return owned;
  }

  private async ownedDescription(
    project: Project,
    exactEngine?: EnvironmentEngine,
  ): Promise<{ engine: EnvironmentEngine; description: NonNullable<Awaited<ReturnType<EnvironmentEngine['describe']>>> } | null> {
    if (!project.container) return null;
    const engine = exactEngine || this.environments.projectTarget(project.targetId).engine;
    const described = await this.inspect(engine, project.container.name);
    if (!described) return null;
    if (!described.identity) throw new ProjectContainerStateUnknownError(
      `project container '${project.container.name}' has no verifiable immutable identity`,
      project.container.name,
    );
    const expectedTarget = targetLabelValue(project.targetId || 'legacy');
    if (described.labels[MANAGED_LABEL] !== 'true'
      || described.labels[PROJECT_LABEL] !== project.id
      || described.labels[USER_ID_LABEL] !== String(project.ownerUserId)
      || described.labels[TARGET_LABEL] !== expectedTarget) {
      throw new ProjectContainerOwnershipError(`project container '${project.container.name}' has mismatched ownership labels`);
    }
    return { engine, description: described };
  }

  private assertAccess(project: Project, access: ProjectContainerAccess): void {
    if (access.projectId !== project.id || access.ownerUserId !== project.ownerUserId
      || !project.container || access.containerName !== project.container.name) {
      throw new ProjectContainerOwnershipError(
        'project container access does not match the recorded project',
      );
    }
  }

  private async inspect(engine: EnvironmentEngine, name: string) {
    try {
      return await engine.describeStrict(name);
    } catch (error) {
      throw new ProjectContainerStateUnknownError(
        `project container '${name}' could not be inspected: ${(error as Error).message}`,
        name,
      );
    }
  }
}
