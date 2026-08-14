/** Partial class: session leases, recovery, and identity-bound file/exec helpers. */

import { spawn } from 'node:child_process';
import { EnvironmentEngine, RunResult } from '../../environments/engine.js';
import { WrappedProcessControl } from '../../environments/types.js';
import {
  ProjectContainerAccess,
  ProjectTrackedSpawnDescriptor,
  validateProjectContainerPath,
} from '../environment.js';
import { Project } from '../store.js';
import {
  ProjectSessionFileCommand,
  ProjectSessionFileProcess,
  ProjectSessionProcessRecovery,
  UnverifiedProjectFileProcessError,
} from '../working-dir.js';
import { IssuedSessionLease, RecoveryEntry } from './manager-core.js';
import { ProjectManagerBuild } from './manager-build.js';

export abstract class ProjectManagerLeases extends ProjectManagerBuild {
  protected requireIssuedLease(ownerUserId: number, projectId: string, leaseId: string): IssuedSessionLease {
    const issued = this.issuedLeases.get(leaseId);
    if (!issued || issued.ownerUserId !== ownerUserId || issued.projectId !== projectId) {
      throw new Error('project session lease is no longer active');
    }
    return issued;
  }

  protected retryRecovery(
    leaseId: string,
    issued: IssuedSessionLease,
    entry: RecoveryEntry,
  ): Promise<boolean> {
    if (!issued.recoveries.has(entry)) return Promise.resolve(true);
    if (entry.attempt) return entry.attempt;
    if (!entry.recovery.stop) return Promise.resolve(false);

    const attempt = Promise.resolve()
      .then(() => entry.recovery.stop!())
      .then(() => {
        if (entry.retryTimer) clearTimeout(entry.retryTimer);
        entry.retryTimer = undefined;
        issued.recoveries.delete(entry);
        if (issued.releaseRequested && issued.recoveries.size === 0) {
          this.finishLeaseRelease(leaseId, issued);
        }
        return true;
      })
      .catch((error: unknown) => {
        entry.lastError = error instanceof Error ? error.message : String(error);
        if (issued.releaseRequested && !this.shuttingDown && !entry.retryTimer) {
          entry.retryTimer = setTimeout(() => {
            entry.retryTimer = undefined;
            void this.retryRecovery(leaseId, issued, entry);
          }, 1_000);
          entry.retryTimer.unref();
        }
        return false;
      })
      .finally(() => {
        if (entry.attempt === attempt) entry.attempt = null;
      });
    entry.attempt = attempt;
    return attempt;
  }

  protected finishLeaseRelease(leaseId: string, issued: IssuedSessionLease): boolean {
    if (issued.recoveries.size > 0) return false;
    const released = this.deps.store.releaseSessionLease(
      issued.projectId,
      issued.ownerUserId,
      leaseId,
    );
    if (this.issuedLeases.get(leaseId) === issued) {
      this.issuedLeases.delete(leaseId);
      this.resolveLeaseWaiters();
    }
    return released;
  }

  protected waitForLeaseChange(): Promise<void> {
    return new Promise((resolve) => this.leaseWaiters.add(resolve));
  }

  protected resolveLeaseWaiters(): void {
    for (const resolve of this.leaseWaiters) resolve();
    this.leaseWaiters.clear();
  }

  /**
   * Runtime/websocket integration releases this idempotently on detach, failed
   * launch, and process exit. A lease must span the full period during which a
   * connection or runtime could be killed by a project stop.
   */
  releaseSessionLease(ownerUserId: number, projectId: string, leaseId: string): boolean {
    const host = this.issuedHostLeases.get(leaseId);
    if (host) {
      if (host.ownerUserId !== ownerUserId || host.projectId !== projectId) return false;
      const released = this.deps.store.releaseSessionLease(projectId, ownerUserId, leaseId);
      this.issuedHostLeases.delete(leaseId);
      this.resolveLeaseWaiters();
      return released;
    }
    const issued = this.issuedLeases.get(leaseId);
    if (!issued || issued.ownerUserId !== ownerUserId || issued.projectId !== projectId) {
      return this.deps.store.releaseSessionLease(projectId, ownerUserId, leaseId);
    }
    issued.releaseRequested = true;
    if (issued.recoveries.size > 0) {
      for (const entry of issued.recoveries) {
        void this.retryRecovery(leaseId, issued, entry);
      }
      return false;
    }
    return this.finishLeaseRelease(leaseId, issued);
  }

  /**
   * Take synchronous ownership of an unverified helper before its caller can
   * forget the child handle. Ordinary release remains blocked until every
   * registered helper is proved gone; retries are coalesced per helper.
   */
  registerUnverifiedSessionProcess(
    ownerUserId: number,
    projectId: string,
    leaseId: string,
    recovery: ProjectSessionProcessRecovery,
  ): void {
    const issued = this.requireIssuedLease(ownerUserId, projectId, leaseId);
    const entry: RecoveryEntry = { recovery, attempt: null };
    issued.recoveries.add(entry);
    if (recovery.stop) {
      void this.retryRecovery(leaseId, issued, entry).catch((error: unknown) => {
        // retryRecovery records the error and deliberately keeps ownership.
        console.error(`Project ${projectId}: helper stop retry failed:`, error);
      });
    }
  }

  /**
   * Run a bounded command in a lease-owned project container. This is for
   * server-owned file-browser helpers; callers must never pass browser text as
   * `command` or manufacture an engine/container selector themselves.
   */
  async execInSessionContainer(
    ownerUserId: number,
    projectId: string,
    leaseId: string,
    cwd: string,
    command: string,
    commandArgs: string[],
    signal?: AbortSignal,
  ): Promise<RunResult> {
    const issued = this.requireIssuedLease(ownerUserId, projectId, leaseId);
    const project = this.deps.store.getProjectForUser(projectId, ownerUserId);
    if (!project) throw new Error('project was removed while its session lease was active');
    // A rejection here is definitively pre-launch: ownership and an already
    // aborted signal are checked before a tracking wrapper is started.
    const tracked = await this.projects.startTrackedExec(
      project,
      issued.access,
      cwd,
      command,
      commandArgs,
      signal,
      issued.engine,
    );
    const execution = await this.settle(tracked.result);
    const stopped = await this.settle(tracked.processControl.stop());
    if (!stopped.ok) {
      const commandDetail = execution.ok ? '' : `; command failed first: ${this.errorDetail(execution.error)}`;
      throw new UnverifiedProjectFileProcessError(
        `Could not verify that the project container helper stopped: ${this.errorDetail(stopped.error)}${commandDetail}`,
        () => tracked.processControl.stop(),
      );
    }
    if (!execution.ok) throw execution.error;
    return execution.value;
  }

  /**
   * Descriptor for raw upload/download streams. The only executable programs
   * are fixed `dd` and `tee` helpers with argv assembled here; integration can
   * pass their stdin/stdout straight through without exposing engine details.
   */
  async spawnSessionFileCommand(
    ownerUserId: number,
    projectId: string,
    leaseId: string,
    input: ProjectSessionFileCommand,
  ): Promise<ProjectSessionFileProcess> {
    const issued = this.requireIssuedLease(ownerUserId, projectId, leaseId);
    const project = this.deps.store.getProjectForUser(projectId, ownerUserId);
    if (!project) throw new Error('project was removed while its session lease was active');
    const filePath = validateProjectContainerPath(issued.access, input.path);
    if (input.operation === 'read') {
      const offset = input.offset ?? 0;
      const length = input.length;
      if (!Number.isSafeInteger(offset) || offset < 0 || (length !== undefined && (!Number.isSafeInteger(length) || length < 0))) {
        throw new Error('invalid project file range');
      }
      const commandArgs = [
        `if=${filePath}`,
        'iflag=skip_bytes,count_bytes',
        `skip=${offset}`,
        ...(length === undefined ? [] : [`count=${length}`]),
        'status=none',
      ];
      return this.spawnTrackedFileCommand(project, issued.access, issued.engine, 'dd', commandArgs);
    }
    if (input.append && input.exclusive) throw new Error('exclusive project file writes cannot append');
    if (input.exclusive) {
      return this.spawnTrackedFileCommand(project, issued.access, issued.engine, 'dd', [
          `of=${filePath}`,
          'conv=excl',
          'status=none',
        ]);
    }
    return this.spawnTrackedFileCommand(
      project,
      issued.access,
      issued.engine,
      'tee',
      [...(input.append ? ['-a'] : []), '--', filePath],
    );
  }

  protected async spawnTrackedFileCommand(
    project: Project,
    access: ProjectContainerAccess,
    engine: EnvironmentEngine,
    command: string,
    commandArgs: string[],
  ): Promise<ProjectSessionFileProcess> {
    // Descriptor validation happens before spawn, so an ownership failure here
    // is known not to have launched a helper and needs no recovery transfer.
    const launch = await this.projects.trackedExecDescriptor(
      project,
      access,
      undefined,
      command,
      commandArgs,
      engine,
    );
    return this.spawnIdentityBound(launch);
  }

  protected async spawnIdentityBound(
    launch: ProjectTrackedSpawnDescriptor,
  ): Promise<ProjectSessionFileProcess> {
    const child = spawn(launch.file, launch.args, { stdio: ['pipe', 'pipe', 'pipe'] }) as ProjectSessionFileProcess;
    child.processControl = launch.processControl;
    child.on('error', () => { /* surfaced through exit/close to the stream owner */ });
    try {
      await this.waitForSpawn(child);
    } catch (error) {
      // Node reports a missing/unstartable local engine binary before `spawn`.
      // No remote helper exists, so wait only for the local handle and preserve
      // the original error without falsely retaining the project lease.
      const closed = await this.settle(this.terminateSpawn(child));
      if (!closed.ok) {
        throw new Error(
          `Project container helper could not spawn (${this.errorDetail(error)}) and its local client did not settle: ${this.errorDetail(closed.error)}`,
        );
      }
      throw error;
    }
    try {
      // Docker/Podman argv already targets the immutable ID. Kubernetes exec
      // is name-addressed, so do a second UID check after the client process is
      // started and before its streams escape this manager.
      await launch.verifyIdentity();
      return child;
    } catch (error) {
      const stopped = await this.settleSpawn(child, launch.processControl);
      if (!stopped.ok) {
        throw new UnverifiedProjectFileProcessError(
          `Project container helper failed post-spawn identity validation (${this.errorDetail(error)}) and could not be settled: ${this.errorDetail(stopped.error)}`,
          () => this.retrySettleSpawn(child, launch.processControl),
        );
      }
      throw error;
    }
  }

  protected waitForSpawn(child: ProjectSessionFileProcess): Promise<void> {
    if (typeof child.pid === 'number') return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const spawned = (): void => {
        child.off('error', failed);
        resolve();
      };
      const failed = (error: Error): void => {
        child.off('spawn', spawned);
        reject(error);
      };
      child.once('spawn', spawned);
      child.once('error', failed);
    });
  }

  protected async settleSpawn(
    child: ProjectSessionFileProcess,
    processControl: WrappedProcessControl,
  ): Promise<{ ok: true } | { ok: false; error: unknown }> {
    const [local, remote] = await Promise.all([
      this.settle(this.terminateSpawn(child)),
      this.settle(processControl.stop()),
    ]);
    if (!remote.ok) return remote;
    if (!local.ok) return local;
    return { ok: true };
  }

  protected async retrySettleSpawn(
    child: ProjectSessionFileProcess,
    processControl: WrappedProcessControl,
  ): Promise<void> {
    const result = await this.settleSpawn(child, processControl);
    if (!result.ok) throw result.error;
  }

  protected async terminateSpawn(child: ProjectSessionFileProcess): Promise<void> {
    if (this.localSpawnClosed(child)) return;
    await new Promise<void>((resolve, reject) => {
      let escalation: NodeJS.Timeout | undefined;
      const finish = (): void => {
        if (escalation) clearTimeout(escalation);
        clearTimeout(deadline);
        resolve();
      };
      const deadline = setTimeout(() => {
        child.off('close', finish);
        reject(new Error('local project container helper client did not close'));
      }, 12_000);
      deadline.unref?.();
      child.once('close', finish);
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGTERM'); } catch { /* close remains authoritative */ }
        escalation = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            try { child.kill('SIGKILL'); } catch { /* close remains authoritative */ }
          }
        }, 500);
        escalation.unref?.();
      }
    });
  }

  protected localSpawnClosed(child: ProjectSessionFileProcess): boolean {
    return (child.exitCode !== null || child.signalCode !== null)
      && child.stdin.destroyed
      && child.stdout.destroyed
      && child.stderr.destroyed;
  }
}
