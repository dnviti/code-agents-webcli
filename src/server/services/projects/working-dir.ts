import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  UserEnvironment,
  WrappedProcessControl,
} from '../environments/types.js';

/** Signals that releasing a lease could orphan a live in-container helper. */
export class UnverifiedProjectFileProcessError extends Error {
  readonly retainProjectLease = true;

  constructor(
    message: string,
    /** Retryable identity-bound proof retained by the eventual lease owner. */
    readonly retryProjectProcessStop?: () => Promise<void>,
  ) {
    super(message);
    this.name = 'UnverifiedProjectFileProcessError';
  }
}

/** Recognise fail-closed helper errors across module/realm boundaries. */
export function mustRetainProjectLease(error: unknown): boolean {
  return error instanceof UnverifiedProjectFileProcessError
    || (
      typeof error === 'object'
      && error !== null
      && (error as { retainProjectLease?: unknown }).retainProjectLease === true
    );
}

/** Do not let a best-effort path/file result erase an unverified process. */
export function rethrowIfProjectLeaseMustBeRetained(error: unknown): void {
  if (mustRetainProjectLease(error)) throw error;
}

/** A manager-owned route from an unverified helper to eventual safe release. */
export interface ProjectSessionProcessRecovery {
  reason: string;
  /** Retry the same identity-bound stop proof. Absent means retire the container. */
  stop?: () => Promise<void>;
}

export interface ProjectContainerAccessLike {
  projectId: string;
  ownerUserId: number;
  containerName: string;
  /** Immutable engine identity used by every helper/control exec. */
  containerIdentity: string;
  root: '/';
  workspaceRoot: string;
  ownerHomeRoot: string;
}

export type ProjectContainerPathLifetime = 'workspace' | 'owner_home' | 'disposable';

export type ProjectSessionFileCommand =
  | { operation: 'read'; path: string; offset?: number; length?: number }
  | { operation: 'write'; path: string; append?: boolean; exclusive?: boolean };

export type ProjectSessionFileProcess = ChildProcessWithoutNullStreams & {
  /** Identity-bound remote process-group control, not merely local exec kill. */
  processControl: WrappedProcessControl;
};

export interface ProjectRunningInfoLike {
  id: string;
  name: string;
  lastActivityAt: string;
  hasActiveWork: boolean;
}

export type ProjectSessionEnvironmentResult =
  | {
      ok: true;
      environment: UserEnvironment;
      workingDir: string;
      allowedWorkingDirs: string[];
      containerAccess?: ProjectContainerAccessLike;
      leaseId: string;
    }
  | {
      ok: false;
      reason: 'not_found' | 'run_limit' | 'failed' | 'building' | 'shutting_down';
      running?: ProjectRunningInfoLike[];
      detail?: string;
    };

/**
 * The narrow project-manager contract used by session-facing transports.
 *
 * `ensureForSession` is an admission operation: a successful call owns the
 * returned lease until this layer releases it. Keeping that ownership in the
 * structural seam makes accidentally dropping the lease harder than it was
 * when the method returned only an environment.
 */
export interface ProjectsSessionApi {
  getForUser(
    ownerUserId: number,
    projectId: string,
  ): { id: string; name?: string } | null;
  /**
   * Resolve the stable host root which owns project-scoped session storage.
   * This is a pure catalog lookup: it must not start a runtime or acquire the
   * lifecycle lock, so project deletion may call it while already exclusive.
   */
  projectWorkspaceRoot?(ownerUserId: number, projectId: string): string | null;
  /**
   * Run ordinary storage cleanup while holding the project's lifecycle gate.
   * Unlike `ensureForSession`, this must neither start nor rebuild a project.
   */
  withProjectWorkspace?<T>(
    ownerUserId: number,
    projectId: string,
    operation: (workspaceRoot: string) => Promise<T>,
  ): Promise<T>;
  ensureForSession(
    ownerUserId: number,
    projectId: string,
  ): Promise<ProjectSessionEnvironmentResult>;
  /** Returns false and keeps ownership while this lease has an unverified helper. */
  releaseSessionLease(ownerUserId: number, projectId: string, leaseId: string): boolean;
  /**
   * Take ownership of a helper whose death could not be verified.
   *
   * The manager keeps the issued lease, rejects ordinary release attempts,
   * retries `stop` when supplied, and on shutdown must retire the exact
   * immutable container before releasing when proof remains unavailable.
   * Registration is synchronous so the throwing request cannot leave a gap
   * between losing its local child and transferring lifecycle ownership.
   */
  registerUnverifiedSessionProcess(
    ownerUserId: number,
    projectId: string,
    leaseId: string,
    recovery: ProjectSessionProcessRecovery,
  ): void;
  touchActivity(projectId: string, when?: Date): void;
  execInSessionContainer(
    ownerUserId: number,
    projectId: string,
    leaseId: string,
    cwd: string,
    command: string,
    commandArgs: string[],
    signal?: AbortSignal,
  ): Promise<{ stdout: string; stderr: string }>;
  spawnSessionFileCommand(
    ownerUserId: number,
    projectId: string,
    leaseId: string,
    input: ProjectSessionFileCommand,
  ): Promise<ProjectSessionFileProcess>;
}

export interface ProjectSessionLease {
  ownerUserId: number;
  projectId: string;
  leaseId: string;
}

export const PROJECT_CONTAINER_EXEC_TIMEOUT_MS = 10_000;

/**
 * Run one fixed command through a live project lease with a hard admission
 * deadline. Callers must still supply only server-owned commands/arguments.
 *
 * `execInSessionContainer` owns the complete tracked remote-process lifecycle:
 * aborting its engine client is not completion. It must resolve/reject only
 * after its identity-bound in-container process group is proven gone, and tag
 * a failed proof with `retainProjectLease: true`. This layer deliberately does
 * not turn an AbortSignal callback into proof of remote death.
 */
export async function execProjectContainerCommand(
  manager: ProjectsSessionApi,
  result: Extract<ProjectSessionEnvironmentResult, { ok: true }>,
  cwd: string,
  command: string,
  commandArgs: string[],
  timeoutMs = PROJECT_CONTAINER_EXEC_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    if (!result.containerAccess) throw new Error('project is running on the host');
    return await manager.execInSessionContainer(
      result.containerAccess.ownerUserId,
      result.containerAccess.projectId,
      result.leaseId,
      cwd,
      command,
      commandArgs,
      controller.signal,
    );
  } finally {
    clearTimeout(timeout);
  }
}

/** Validate and normalise one explicitly container-local absolute path. */
export function validateProjectContainerPath(
  access: ProjectContainerAccessLike,
  input: string,
): string {
  if (
    typeof input !== 'string'
    || !input
    || input.includes('\0')
    || !path.posix.isAbsolute(input)
  ) {
    throw new Error('project container path must be an absolute path');
  }
  const normalized = path.posix.normalize(input);
  if (!normalized.startsWith('/')) {
    throw new Error('project container path escapes its root');
  }
  return normalized;
}

/** State the rebuild lifetime of a canonical container path. */
export function classifyProjectContainerPath(
  access: ProjectContainerAccessLike,
  input: string,
): ProjectContainerPathLifetime {
  const value = validateProjectContainerPath(access, input);
  const inside = (root: string): boolean => value === root || value.startsWith(`${root}/`);
  if (inside(access.ownerHomeRoot)) return 'owner_home';
  if (inside(access.workspaceRoot)) return 'workspace';
  return 'disposable';
}

/** Release a manager-issued lease. The manager makes this idempotent. */
export function releaseProjectSessionLease(
  manager: ProjectsSessionApi | undefined,
  lease: ProjectSessionLease | undefined,
): void {
  if (!manager || !lease) return;
  manager.releaseSessionLease(lease.ownerUserId, lease.projectId, lease.leaseId);
}

/**
 * Transfer an unverified helper to the manager that owns its issued lease.
 *
 * The runtime guard is intentionally fail closed for older embedders: if the
 * required method is absent or throws, callers still retain the lease. They do
 * not silently reinterpret failed registration as permission to release.
 * Returns true only when the caller itself must retain the lease. A false
 * return after a marked error means ownership transferred successfully, so a
 * temporary caller should request its normal manager-gated release.
 */
export function registerUnverifiedProjectProcess(
  manager: ProjectsSessionApi | undefined,
  lease: ProjectSessionLease | undefined,
  error: unknown,
): boolean {
  if (!lease || !mustRetainProjectLease(error)) return false;
  const retryCandidate = (error as { retryProjectProcessStop?: unknown } | null)
    ?.retryProjectProcessStop;
  const retry = typeof retryCandidate === 'function'
    ? () => Promise.resolve(retryCandidate.call(error))
    : undefined;
  const recovery: ProjectSessionProcessRecovery = {
    reason: error instanceof Error ? error.message : 'project helper stop was not verified',
    ...(retry ? { stop: retry } : {}),
  };
  const register = (manager as Partial<ProjectsSessionApi> | undefined)
    ?.registerUnverifiedSessionProcess;
  if (typeof register === 'function' && manager) {
    try {
      register.call(
        manager,
        lease.ownerUserId,
        lease.projectId,
        lease.leaseId,
        recovery,
      );
      // Ownership has moved to the manager. The caller must still request its
      // ordinary lease release: the manager records that request and keeps the
      // lease counted until every transferred recovery proves the helper gone.
      return false;
    } catch {
      // The caller retains the lease below. Failed transfer is never release.
    }
  }
  return true;
}

/**
 * Resolve an existing path and prove its canonical target is under one of the
 * manager-provided roots.
 *
 * A relative request is measured from the first root (the project's isolated
 * workspace). Absolute paths are accepted when they land in either that root
 * or the owner's persistent home. Both roots and the candidate are realpath'd,
 * so a symlink in either location cannot turn a lexical child into an escape.
 */
export async function canonicalProjectWorkingDir(
  allowedRoots: readonly string[],
  requested: string,
): Promise<string | null> {
  const roots: string[] = [];
  for (const root of allowedRoots) {
    try {
      const canonical = await fsp.realpath(root);
      if (!roots.includes(canonical)) roots.push(canonical);
    } catch {
      // A root that disappeared after provisioning authorises nothing.
    }
  }
  if (roots.length === 0) return null;

  const lexical = path.isAbsolute(requested)
    ? path.resolve(requested)
    : path.resolve(roots[0], requested || '.');
  let candidate: string;
  try {
    candidate = await fsp.realpath(lexical);
  } catch {
    // A process cannot chdir into a missing path, so it is not a valid cwd.
    return null;
  }

  return roots.some((root) => isInside(root, candidate)) ? candidate : null;
}

/**
 * Keep a persisted/requested cwd when it is still valid; otherwise use the
 * manager's current checkout. A manager that returns a fallback outside its
 * own roots is a configuration error, never a reason to run on the host.
 */
export async function projectWorkingDirOrDefault(
  result: Extract<ProjectSessionEnvironmentResult, { ok: true }>,
  preferred?: string | null,
): Promise<string> {
  if (preferred) {
    const retained = await canonicalProjectWorkingDir(result.allowedWorkingDirs, preferred);
    if (retained) return retained;
  }
  const fallback = await canonicalProjectWorkingDir(
    result.allowedWorkingDirs,
    result.workingDir,
  );
  if (!fallback) {
    throw new Error('Project manager returned a working directory outside its allowed roots');
  }
  return fallback;
}

const DIRECTORY_REALPATH_SCRIPT = [
  "const fs = require('node:fs');",
  'try {',
  '  const value = fs.realpathSync(process.argv[1]);',
  '  if (!fs.statSync(value).isDirectory()) process.exit(2);',
  '  process.stdout.write(value);',
  '} catch { process.exit(2); }',
].join('\n');

/**
 * Resolve an existing directory in the project's container namespace.
 *
 * The command and script are server-owned constants; the requested path is a
 * single argv value. The manager binds execution to the live lease and exact
 * owner/project/container before this helper ever sees output.
 */
export async function canonicalProjectContainerWorkingDir(
  manager: ProjectsSessionApi,
  result: Extract<ProjectSessionEnvironmentResult, { ok: true }>,
  requested: string,
): Promise<string | null> {
  if (!result.containerAccess) return null;
  let candidate: string;
  try {
    candidate = validateProjectContainerPath(result.containerAccess, requested);
  } catch {
    return null;
  }
  try {
    const executed = await execProjectContainerCommand(
      manager,
      result,
      result.containerAccess.root,
      result.environment.nodePath,
      ['-e', DIRECTORY_REALPATH_SCRIPT, candidate],
    );
    return validateProjectContainerPath(result.containerAccess, executed.stdout.trim());
  } catch (error) {
    rethrowIfProjectLeaseMustBeRetained(error);
    return null;
  }
}

/** Convert a canonical host-mounted project path to its explicit container name. */
export async function projectHostWorkingDirToContainer(
  result: Extract<ProjectSessionEnvironmentResult, { ok: true }>,
  requested: string,
): Promise<string | null> {
  if (!result.containerAccess) return null;
  const host = await canonicalProjectWorkingDir(result.allowedWorkingDirs, requested);
  if (!host) return null;
  try {
    return validateProjectContainerPath(
      result.containerAccess,
      result.environment.toContainerPath(host),
    );
  } catch {
    return null;
  }
}

/**
 * Revalidate a persisted project cwd after the container was ensured.
 * Disposable container paths legitimately disappear on rebuild; only then do
 * they fall back to the manager's host-backed checkout and change namespace.
 */
export async function restoreProjectWorkingDir(
  manager: ProjectsSessionApi,
  result: Extract<ProjectSessionEnvironmentResult, { ok: true }>,
  preferred: string,
  kind: 'host' | 'container' | undefined,
): Promise<{ workingDir: string; kind: 'host' | 'container' }> {
  if (kind === 'container') {
    const retained = await canonicalProjectContainerWorkingDir(manager, result, preferred);
    if (retained) return { workingDir: retained, kind: 'container' };
  }
  return {
    workingDir: await projectWorkingDirOrDefault(
      result,
      kind === 'container' ? undefined : preferred,
    ),
    kind: 'host',
  };
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
