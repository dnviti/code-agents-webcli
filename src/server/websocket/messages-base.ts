import path from 'node:path';
import { SessionRecord, AgentKind } from '../types.js';
import { ScrollbackRecorder } from '../services/scrollback.js';
import { announceSessionActivity } from './handler.js';
import { UserEnvironment } from '../services/environments/types.js';
import { HostEnvironment } from '../services/environments/manager.js';
import { registerUnverifiedProjectProcess, releaseProjectSessionLease, restoreProjectWorkingDir, validateProjectContainerPath } from '../services/projects/working-dir.js';
import type { ProjectSessionEnvironmentResult, ProjectSessionLease } from '../services/projects/working-dir.js';
import { ProjectContainerFiles } from '../services/projects/container-files.js';
import { MessageProcessorDeps } from './messages-types.js';
import { ACTIVITY_ANNOUNCE_MS, BuiltInWorkflowAdmission, HeldProjectSessionLease } from './messages-shared.js';
export abstract class MessageProcessorBase {

  protected deps: MessageProcessorDeps;

  /** One scrollback emulator per session, rebuilding history from the PTY stream. */
  protected recorders = new Map<string, ScrollbackRecorder>();

  /**
   * When each session last told the user's other screens that it is working.
   *
   * Output arrives a keystroke at a time and a build's worth at a time, and the
   * screens that are not attached to the session cannot use any of it — they
   * only need to know it is happening. One announcement a second is far below
   * the ninety the tab strip waits before calling a session quiet, so every
   * screen reaches the same verdict at the same moment for the price of a few
   * bytes a second.
   */
  protected activityAnnounced = new Map<string, number>();

  /** Admission owned by a socket driving one session. */
  protected joinedProjectLeases = new Map<string, HeldProjectSessionLease>();

  /** Admissions owned by background chat subscriptions, per socket/session. */
  protected subscribedProjectLeases = new Map<string, Map<string, HeldProjectSessionLease>>();

  /** Admission owned by a live terminal or chat process. */
  protected runtimeProjectLeases = new Map<string, HeldProjectSessionLease>();

  /** One launch at a time per record while `active` has not been set yet. */
  protected runtimeStarts = new Set<string>();

  /** Completion signals shutdown can await before its final runtime stop pass. */
  protected runtimeStartDrains = new Map<string, { promise: Promise<void>; resolve(): void }>();

  /** Coalesces exit callback, explicit stop and concurrent stop requests per run. */
  protected runtimeStops = new Map<
    string,
    { session: SessionRecord; runId: string | undefined; promise: Promise<void> }
  >();

  /** One agent replacement per session; a second click receives Busy. */
  protected agentUpdateRestarts = new Map<string, Promise<void>>();

  /**
   * Successful workflow admissions keyed by owner, conversation and client id.
   *
   * The browser retries with the same id after a timeout. Keeping the in-flight
   * promise as well as its answer makes both a concurrent retry and a lost
   * acknowledgement exactly-once at the chat-manager boundary.
   */
  protected builtInWorkflowAdmissions = new Map<string, BuiltInWorkflowAdmission>();


  constructor(deps: MessageProcessorDeps) {
    this.deps = deps;
  }


  /**
   * Say "this session is working", at most once a second.
   *
   * The clock is only ever read here, so a session that goes quiet simply stops
   * being announced; nothing has to be cancelled and nothing fires late.
   */
  protected noteActivity(session: SessionRecord): void {
    const now = Date.now();
    const last = this.activityAnnounced.get(session.id) ?? 0;
    if (now - last < ACTIVITY_ANNOUNCE_MS) return;
    this.activityAnnounced.set(session.id, now);
    announceSessionActivity(session, true, this.deps.webSocketConnections);
  }


  /**
   * Say "this session has stopped", and let the throttle go.
   *
   * Forgetting the timestamp is what makes the next run announce itself
   * immediately instead of waiting out the remainder of a second that belonged
   * to the previous one.
   */
  protected noteStopped(session: SessionRecord): void {
    this.activityAnnounced.delete(session.id);
    announceSessionActivity(session, false, this.deps.webSocketConnections);
  }


  /** The user's own root, or the single shared one when environments are off. */
  protected userBaseFolder(userId?: number): string {
    return this.deps.getUserBaseFolder?.(userId) ?? this.deps.baseFolder;
  }


  /** The environment a user's processes run in; this host when there are none. */
  protected async userEnvironment(userId?: number): Promise<UserEnvironment> {
    return this.deps.ensureEnvironment
      ? this.deps.ensureEnvironment(userId)
      : new HostEnvironment(this.deps.baseFolder);
  }


  /**
   * Resolve a record's actual execution environment. A persisted project id is
   * an instruction, not a hint: falling back to the host or user environment
   * here would run project work in the wrong checkout after a restart.
   */
  protected async environmentForSession(
    session: SessionRecord,
  ): Promise<{
    environment: UserEnvironment;
    lease?: HeldProjectSessionLease;
    project?: Extract<ProjectSessionEnvironmentResult, { ok: true }>;
  }> {
    if (!session.projectId) {
      return { environment: await this.userEnvironment(session.ownerUserId) };
    }

    const manager = this.deps.projectsManager;
    if (!manager) {
      throw new Error('This project session cannot be resolved until project support is configured.');
    }
    const resolved = await manager.ensureForSession(session.ownerUserId, session.projectId);
    if (!resolved.ok) {
      const detail = resolved.detail ? `: ${resolved.detail}` : '';
      throw new Error(`This project's environment is ${resolved.reason}${detail}`);
    }
    const lease: HeldProjectSessionLease = {
      sessionId: session.id,
      ownerUserId: session.ownerUserId,
      projectId: session.projectId,
      leaseId: resolved.leaseId,
    };
    try {
      // Preserve any persisted cwd that is still canonically inside the
      // workspace or owner home. Rebuilds and missing paths alone fall back to
      // the manager's current checkout.
      const cwd = await restoreProjectWorkingDir(
        manager,
        resolved,
        session.workingDir,
        session.projectWorkingDirKind,
      );
      const cwdChanged = session.workingDir !== cwd.workingDir
        || session.projectWorkingDirKind !== cwd.kind;
      session.workingDir = cwd.workingDir;
      session.projectWorkingDirKind = cwd.kind;
      // A rebuild can invalidate a disposable container cwd and move the
      // authoritative session back to its host checkout. Persist that repair
      // while the admission is still held; otherwise a quiet join or
      // subscription fixes only this process and the next restart restores the
      // stale namespace discriminator again.
      if (cwdChanged) await this.deps.saveSessionsToDisk();
      return { environment: resolved.environment, lease, project: resolved };
    } catch (error) {
      releaseProjectSessionLease(manager, lease);
      throw error;
    }
  }


  protected releaseHeldProjectLease(lease: HeldProjectSessionLease | undefined): void {
    releaseProjectSessionLease(this.deps.projectsManager, lease);
  }


  /**
   * ACP filesystem access for a project always stays in the exact container
   * named by the live runtime lease. This is also used for a host-kind checkout:
   * the ACP process sees its mounted `/workspace/...` name, not the host mount
   * source stored on the session record.
   */
  protected projectChatFileAccess(
    session: SessionRecord,
    prepared: Extract<ProjectSessionEnvironmentResult, { ok: true }>,
  ): {
    readFile(filePath: string): Promise<string>;
    writeFile(filePath: string, contents: string): Promise<void>;
  } {
    const manager = this.deps.projectsManager;
    if (!manager) throw new Error('Project filesystem access is not configured.');
    const access = prepared.containerAccess;
    if (!access) throw new Error('Local project files use normal host filesystem access.');
    const runtimeRoot = session.projectWorkingDirKind === 'container'
      ? validateProjectContainerPath(access, session.workingDir)
      : validateProjectContainerPath(
          access,
          prepared.environment.toContainerPath(session.workingDir),
        );
    const workspace = new ProjectContainerFiles(manager, prepared, runtimeRoot);
    const runtimeLease: ProjectSessionLease = {
      ownerUserId: session.ownerUserId,
      projectId: session.projectId!,
      leaseId: prepared.leaseId,
    };
    let temporary: ProjectContainerFiles | undefined;
    const filesFor = (filePath: string): ProjectContainerFiles => {
      if (!path.posix.isAbsolute(filePath)) return workspace;
      const normalized = validateProjectContainerPath(access, filePath);
      if (normalized === runtimeRoot || normalized.startsWith(`${runtimeRoot}/`)) return workspace;
      // Preserve ACP's scratch-file handoff, but in the project container's
      // `/tmp` namespace. It must never become the server's coincident `/tmp`.
      if (normalized === '/tmp' || normalized.startsWith('/tmp/')) {
        temporary ??= new ProjectContainerFiles(manager, prepared, '/tmp');
        return temporary;
      }
      return workspace;
    };
    return {
      readFile: async (filePath) => {
        try {
          return await filesFor(filePath).readText(filePath);
        } catch (error) {
          // Transfer an uncertain helper to the project manager before ACP can
          // turn it into a protocol error and forget the local child. The
          // manager blocks ordinary runtime-lease release until every recovery
          // registered against this lease has verified or retired the exact
          // container.
          registerUnverifiedProjectProcess(manager, runtimeLease, error);
          throw error;
        }
      },
      writeFile: async (filePath, contents) => {
        try {
          await filesFor(filePath).writeText(filePath, contents);
        } catch (error) {
          registerUnverifiedProjectProcess(manager, runtimeLease, error);
          throw error;
        }
      },
    };
  }


  protected releaseJoinedProjectLease(wsId: string): void {
    const lease = this.joinedProjectLeases.get(wsId);
    if (!lease) return;
    this.joinedProjectLeases.delete(wsId);
    this.releaseHeldProjectLease(lease);
  }


  protected releaseSubscribedProjectLease(wsId: string, sessionId: string): void {
    const bySession = this.subscribedProjectLeases.get(wsId);
    const lease = bySession?.get(sessionId);
    if (!lease) return;
    bySession!.delete(sessionId);
    if (bySession!.size === 0) this.subscribedProjectLeases.delete(wsId);
    this.releaseHeldProjectLease(lease);
  }


  protected releaseRuntimeProjectLease(sessionId: string): void {
    const lease = this.runtimeProjectLeases.get(sessionId);
    if (!lease) return;
    this.runtimeProjectLeases.delete(sessionId);
    this.releaseHeldProjectLease(lease);
  }


  protected persistActive(session: SessionRecord, active: boolean): void {
    void this.deps.sessionStore?.setActive(session.id, active, session.storageScope);
  }


  protected projectIdentity(session: SessionRecord): {
    projectId: string | null;
    projectName: string | null;
  } {
    const projectId = session.projectId || null;
    if (!projectId) return { projectId: null, projectName: null };
    const project = this.deps.projectsManager?.getForUser(session.ownerUserId, projectId);
    return { projectId, projectName: project?.name || null };
  }


  protected beginRuntimeStart(sessionId: string): boolean {
    if (this.runtimeStarts.has(sessionId)) return false;
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    this.runtimeStarts.add(sessionId);
    this.runtimeStartDrains.set(sessionId, { promise, resolve });
    return true;
  }


  protected finishRuntimeStart(sessionId: string): void {
    this.runtimeStarts.delete(sessionId);
    const drain = this.runtimeStartDrains.get(sessionId);
    if (!drain) return;
    this.runtimeStartDrains.delete(sessionId);
    drain.resolve();
  }


  protected async drainRuntimeStart(sessionId: string): Promise<void> {
    while (this.runtimeStartDrains.has(sessionId)) {
      await this.runtimeStartDrains.get(sessionId)!.promise;
    }
  }


  protected launchIsCurrent(session: SessionRecord, runId: string): boolean {
    return (
      this.deps.claudeSessions.get(session.id) === session
      && session.runId === runId
      && session.retiring !== true
    );
  }


  protected appendOutputToSession(sessionId: string, data: string): void {
    const session = this.deps.claudeSessions.get(sessionId);
    if (!session) return;

    session.outputBuffer.push(data);
    if (session.outputBuffer.length > session.maxBufferSize) {
      session.outputBuffer.shift();
    }

    this.deps.transcriptStore.appendOutput(session, data);
    this.getRecorder(session).write(data);
  }


  protected getRecorder(session: SessionRecord): ScrollbackRecorder {
    const existing = this.recorders.get(session.id);
    if (existing) {
      return existing;
    }

    const ref = session;
    const recorder = new ScrollbackRecorder({
      cols: session.termCols || 80,
      rows: session.termRows || 24,
      onLines: (lines) => this.deps.historyStore.append(ref, lines),
      onGap: (dropped) => {
        const amount = dropped === null ? 'an unknown number of' : String(dropped);
        this.deps.historyStore.append(ref, [
          `\x1b[2m[... ${amount} lines not recorded: output too fast ...]\x1b[0m`,
        ]);
      },
    });

    this.recorders.set(session.id, recorder);
    return recorder;
  }


  /**
   * The lines still on screen for a session, so an export can end where the
   * session actually ends. Flushes first so nothing sits in limbo between the
   * emulator and the store.
   */
  getScreenSnapshot(sessionId: string): string[] {
    const recorder = this.recorders.get(sessionId);
    if (!recorder) {
      return [];
    }
    recorder.flush();
    return recorder.snapshotScreen();
  }


  /**
   * Fold a finished run's last screen into history, then release the emulator.
   *
   * The remaining lines never scrolled off, so a plain flush would leave them
   * out of both the history and the export. They are final now that the
   * process is gone.
   */
  protected retireRecorder(session: SessionRecord): void {
    const recorder = this.recorders.get(session.id);
    if (!recorder) {
      return;
    }

    // Unregister first: a restart of the same session must get a fresh
    // recorder rather than write into one that is draining.
    this.recorders.delete(session.id);

    void recorder.drain().then(() => {
      const screen = recorder.snapshotScreen();
      if (screen.length > 0) {
        this.deps.historyStore.append(
          session,
          screen,
        );
      }
      recorder.dispose();
    });
  }


  /** Drop the emulator for a session that is going away. */
  disposeRecorder(sessionId: string): void {
    const recorder = this.recorders.get(sessionId);
    if (recorder) {
      recorder.flush();
      recorder.dispose();
      this.recorders.delete(sessionId);
    }
  }


  /** Let every emulator finish parsing before the process goes. */
  async drainAllRecorders(): Promise<void> {
    const recorders = Array.from(this.recorders.values());
    this.recorders.clear();
    await Promise.all(
      recorders.map(async (recorder) => {
        try {
          await recorder.drain();
        } finally {
          recorder.dispose();
        }
      }),
    );
  }


  protected getRuntimeLabel(agentKind: AgentKind, session: SessionRecord | null = null): string {
    switch (agentKind) {
      case 'codex':
        return this.deps.aliases.codex;
      case 'agent':
        return this.deps.aliases.agent;
      case 'pi':
        return this.deps.aliases.pi;
      case 'grok':
        return this.deps.aliases.grok;
      case 'qwen':
        return this.deps.aliases.qwen;
      case 'kimi':
        return this.deps.aliases.kimi;
      case 'omp':
        return this.deps.aliases.omp;
      case 'antigravity':
        return this.deps.aliases.antigravity;
      case 'terminal':
        return session?.runtimeLabel || 'Terminal';
      case 'claude':
      default:
        return this.deps.aliases.claude;
    }
  }


  protected getRuntimeErrorLabel(agentKind: AgentKind): string {
    switch (agentKind) {
      case 'codex':
        return 'Codex Code';
      case 'agent':
        return 'Agent';
      case 'pi':
        return 'Pi';
      case 'grok':
        return 'Grok Build';
      case 'qwen':
        return 'Qwen Code';
      case 'kimi':
        return 'Kimi Code';
      case 'omp':
        return 'Oh My Pi';
      case 'antigravity':
        return 'Antigravity CLI';
      case 'terminal':
        return 'terminal';
      case 'claude':
      default:
        return 'Claude Code';
    }
  }

}
