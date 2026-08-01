/** The project-shaped container: a durable owner home plus a disposable workspace. */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { ContainerEnvironment, EnvironmentManager, LOGIN_LABEL, MANAGED_LABEL, TIER_LABEL, USER_ID_LABEL } from '../environments/manager.js';
import { EnvironmentEngine, RunResult } from '../environments/engine.js';
import { trackContainerProcess } from '../environments/process-control.js';
import { PROJECT_LABEL, projectContainerName, TARGET_LABEL, targetLabelValue } from '../environments/naming.js';
import { EnvironmentOwner, Mount, UserEnvironment, WrappedProcessControl } from '../environments/types.js';
import { Project } from './store.js';
import { repoBaseName } from './clone.js';

export const PROJECT_WORKSPACE = '/workspace';

export interface ProjectEnvironmentResult {
  environment: UserEnvironment;
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
  constructor(private readonly environments: EnvironmentManager) {}

  worktreePath(project: Project, _owner: EnvironmentOwner): string {
    // Sibling of owner homes: mounting the persistent home into project A must
    // not reveal project B through /home/<owner>/projects/B.
    return path.join(this.environments.projectStorageRoot(project.targetId), project.id);
  }

  checkoutPath(project: Project, owner: EnvironmentOwner): string {
    const root = this.worktreePath(project, owner);
    return project.repoUrl ? path.join(root, repoBaseName(project.repoUrl)) : root;
  }

  checkoutContainerPath(project: Project): string {
    return project.repoUrl ? `${PROJECT_WORKSPACE}/${repoBaseName(project.repoUrl)}` : PROJECT_WORKSPACE;
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
    // A saved target is authoritative.  projectTarget intentionally refuses a
    // missing target instead of quietly selecting today's active machine.
    const target = this.environments.projectTarget(project.targetId);
    const ownerHome = this.environments.ownerHomeOnTarget(owner, project.targetId);
    const root = this.worktreePath(project, owner);
    await fsp.mkdir(ownerHome.hostPath, { recursive: true, mode: 0o700 });
    await fsp.chmod(ownerHome.hostPath, 0o700);
    await fsp.mkdir(root, { recursive: true, mode: 0o700 });
    await fsp.chmod(root, 0o700);

    const name = project.container?.name || projectContainerName(target.config.namePrefix, project);
    const tier = project.tierId
      ? target.config.tiers.find((candidate) => candidate.id === project.tierId) || null
      : this.environments.intendedTierOnTarget(owner.id, project.targetId);
    const mounts: Mount[] = [
      { hostPath: ownerHome.hostPath, containerPath: ownerHome.containerPath },
      { hostPath: root, containerPath: PROJECT_WORKSPACE },
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
        containerHome: PROJECT_WORKSPACE,
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
        env: { HOME: ownerHome.containerPath, USER: owner.githubLogin, TERM: 'xterm-256color' },
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
      shells: ['sh'],
      // Keep the workspace translation first so an explicitly configured
      // overlapping mount cannot shadow the isolated /workspace mapping.
      mounts: [mounts[1], mounts[0], ...mounts.slice(2)],
    });
    return {
      environment,
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
  ): Promise<'absent' | 'stopped'> {
    this.assertAccess(project, access);
    const owned = await this.ownedDescription(project);
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
  ): Promise<ProjectTrackedExecution> {
    const owned = await this.ownedAccess(project, access);
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
  ): Promise<ProjectTrackedSpawnDescriptor> {
    const owned = await this.ownedAccess(project, access);
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
