import { randomUUID } from 'node:crypto';
import { AgentKind, RuntimeSession, SessionRecord, WebSocketInfo } from '../../types.js';
import { announceSessionActivity, broadcastToSession, sendToWebSocket } from '../handler.js';
import { UserEnvironment } from '../../services/environments/types.js';
import { HeldProjectSessionLease, IncomingMessage } from './messages-shared.js';
import { MessageProcessorChatSubscriptionBase } from './messages-chat-subscription.js';
export abstract class MessageProcessorRuntimeBase extends MessageProcessorChatSubscriptionBase {


  async startRuntime(
    wsId: string,
    agentKind: AgentKind,
    options: Record<string, unknown> = {}
  ): Promise<void> {
    const wsInfo = this.deps.webSocketConnections.get(wsId);
    if (!wsInfo || !wsInfo.claudeSessionId) {
      if (wsInfo?.ws) {
        sendToWebSocket(wsInfo.ws, {
          type: 'error',
          message: 'No session joined',
        });
      }
      return;
    }

    const session = this.deps.claudeSessions.get(wsInfo.claudeSessionId);
    if (!session) return;

    if (session.persistenceUnavailable) {
      sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: `This session is read-only while workspace persistence is unavailable: ${session.persistenceUnavailable}`,
      });
      return;
    }
    if (session.rollbackRecoveryPending) {
      sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: 'This session is retained only to retry an incomplete rollback',
      });
      return;
    }

    if (session.retiring) {
      sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: 'This session is being closed',
      });
      return;
    }

    if (session.active) {
      sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: 'A process is already running in this session',
      });
      return;
    }

    const bridge = this.deps.getRuntimeBridge(agentKind);
    if (!bridge) {
      sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: `Unsupported runtime: ${agentKind}`,
      });
      return;
    }

    if (!this.beginRuntimeStart(session.id)) {
      sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: 'A process is already starting in this session',
      });
      return;
    }

    try {
      const sessionId = wsInfo.claudeSessionId;
      const previousOutputBuffer = [...session.outputBuffer];
      session.outputBuffer = [];

    // Only these keys are accepted from the client. Spreading the raw client
    // object would let it override onOutput/onExit/onError (non-function values
    // are then invoked inside node-pty handlers, taking down the process) and
    // override workingDir, escaping the validated per-session sandbox.
    const safeOptions: Record<string, unknown> = {};
    if (options.mode === 'command' || options.mode === 'shell') {
      safeOptions.mode = options.mode;
    }
    if (typeof options.shell === 'string') {
      safeOptions.shell = options.shell;
    }
    if (typeof options.command === 'string') {
      safeOptions.command = options.command;
    }
    if (options.dangerouslySkipPermissions === true) {
      safeOptions.dangerouslySkipPermissions = true;
    }
    if (typeof options.cols === 'number' && Number.isFinite(options.cols)) {
      safeOptions.cols = options.cols;
    }
    if (typeof options.rows === 'number' && Number.isFinite(options.rows)) {
      safeOptions.rows = options.rows;
    }

    // The active profile is resolved here rather than in the bridge: the bridge
    // is a spawn wrapper with no view of settings, and resolving once per start
    // keeps a mid-session settings change from applying to a running process.
    //
    // Profile values are deliberately *not* read from `options`: everything in
    // safeOptions came from the browser, and the whole point of the profile is
    // that it is server-side configuration the client cannot forge. (`model`
    // is the one exception below: a conversation's own override is allowed to
    // beat it, but only for that conversation, never written back to the profile.)
    const profile = this.deps.resolveRuntimeProfile(
      agentKind,
      session.projectWorkingDirKind === 'container' ? undefined : session.workingDir,
    );
    if (profile) {
      // The rung behind the typed model, on the same terms as the chat launch:
      // a ladder decides which model does the work, and a terminal started from
      // this app is work being done. What it cannot have is the rest of #171 —
      // escalation is a conversation asking a person a question, and a PTY
      // running the CLI's own interface has no channel this app can put a
      // question through. The rung it opens on is the rung it stays on.
      const fromProfile = profile.model || profile.ladder?.model;
      if (fromProfile) safeOptions.model = fromProfile;
      if (profile.extraArgs?.length) safeOptions.extraArgs = profile.extraArgs;
      if (profile.env && Object.keys(profile.env).length) safeOptions.env = profile.env;
      console.log(`Applying runtime profile "${profile.profileName}" to ${agentKind}`);
    }
    // A model chosen for this conversation beats the profile default, but only
    // for this one launch: it is never written back as a new profile.
    //
    // No account default behind it, unlike the chat launch. A terminal runs the
    // CLI's own interface, where the model is the user's to change in the tool
    // itself and nothing here can see or record what they picked — so seeding
    // one would be this app asserting a choice it has no way to keep in step
    // with. Left deliberately out of #135; the chat surface is where the
    // preference is both made and observable.
    if (session.chatModelOverride) {
      safeOptions.model = session.chatModelOverride;
    }

    // The scrollback recorder is born on the first output byte, before any
    // resize message can arrive, so the geometry the run starts at has to be
    // known here — otherwise the splash is recorded wrapped at 80x24. Only
    // the payload overrides what the session already knows: a restart without
    // geometry must not clobber the size an earlier resize established.
    if (typeof safeOptions.cols === 'number') {
      session.termCols = Math.max(1, Math.floor(safeOptions.cols));
    }
    if (typeof safeOptions.rows === 'number') {
      session.termRows = Math.max(1, Math.floor(safeOptions.rows));
    }

    // Identifies this particular run, so a late callback from a previous run
    // cannot mark the current one dead and orphan its PTY.
    //
    // Claim the id BEFORE starting: the bridge registers the PTY handlers
    // synchronously, so output or an immediate exit can reach the callbacks
    // before startSession()'s promise resolves. Assigning afterwards left a
    // window where they saw runId undefined and dropped the event.
    const runId = randomUUID();
    const previousRunId = session.runId;
    let runEnded = false;
    session.runId = runId;

    // A session created before per-user environments were switched on points at
    // a folder on the host, which this user's environment cannot see. Moved to
    // their own root rather than refused: the alternative is a tab that can
    // never be started again and no way to say why from inside it.
    if (!session.projectId && !this.deps.validatePath(session.workingDir, wsInfo.userId).valid) {
      session.workingDir = this.userBaseFolder(wsInfo.userId);
    }

    // Prepared before the pty, not alongside it: creating a container takes a
    // moment the first time, and a bridge started against an environment that
    // is not up yet fails with an engine error the user cannot act on.
    let environment: UserEnvironment;
    let runtimeLease: HeldProjectSessionLease | undefined;
    try {
      const prepared = await this.environmentForSession(session);
      environment = prepared.environment;
      runtimeLease = prepared.lease;
      if (!this.launchIsCurrent(session, runId)) {
        this.releaseHeldProjectLease(runtimeLease);
        if (session.runId === runId) session.runId = previousRunId;
        return;
      }
      if (runtimeLease) {
        // An inactive record must not carry an old process lease. Delete first
        // so an idempotent release cannot remove the new claim by mistake.
        this.releaseRuntimeProjectLease(session.id);
        this.runtimeProjectLeases.set(session.id, runtimeLease);
      }
    } catch (error) {
      session.runId = previousRunId;
      session.outputBuffer = previousOutputBuffer;
      sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: error instanceof Error
          ? session.projectId
            ? error.message
            : `Your workspace environment could not be started: ${error.message}`
          : 'Your workspace environment could not be started.',
      });
      return;
    }

    const managedLaunch = agentKind === 'terminal'
      ? null
      : this.deps.resolveAgentLaunch?.(session, environment, agentKind) ?? null;
    if (managedLaunch) safeOptions.command = managedLaunch.command;

    let runtimeMayBeAlive = false;
    try {
      const runtimeSession = (await bridge.startSession(sessionId, {
        ...safeOptions,
        environment,
        workingDir: session.workingDir,
        cwdKind: session.projectWorkingDirKind,
        onOutput: (data: string) => {
          const currentSession = this.deps.claudeSessions.get(sessionId);
          if (!currentSession || currentSession.runId !== runId) return;
          this.appendOutputToSession(sessionId, data);
          broadcastToSession(
            sessionId,
            { type: 'output', data },
            this.deps.claudeSessions,
            this.deps.webSocketConnections
          );
          // The bytes go to whoever is attached; the fact that there were any
          // goes to every screen with a tab for this session.
          this.noteActivity(currentSession);
        },
        onExit: (code: number | null, signal: string | null) => {
          const currentSession = this.deps.claudeSessions.get(sessionId);
          if (!currentSession || currentSession.runId !== runId) return;

          // The run is over, so the screen it leaves behind can never be
          // repainted: freeze it into history and let the emulator go. Keeping
          // one alive per finished session costs a couple of megabytes each,
          // for a buffer nothing will ever write to again.
          this.retireRecorder(currentSession);

          const stopRequested = currentSession.stopRequested;
          runEnded = true;
          currentSession.active = false;
          this.persistActive(currentSession, false);
          currentSession.agent = null;
          currentSession.stopRequested = false;
          currentSession.lastActivity = new Date();
          this.releaseRuntimeProjectLease(sessionId);

          // Whether or not the exit was asked for, and whether or not anyone is
          // attached: the tab is bright on every screen that saw this session
          // start, and this is what puts it out.
          this.noteStopped(currentSession);

          if (!stopRequested) {
            broadcastToSession(
              sessionId,
              {
                type: 'exit',
                code,
                signal,
                agent: currentSession.lastAgent,
                runtimeLabel: currentSession.runtimeLabel,
              },
              this.deps.claudeSessions,
              this.deps.webSocketConnections
            );
          }
        },
        onError: (error: Error) => {
          const currentSession = this.deps.claudeSessions.get(sessionId);
          if (!currentSession || currentSession.runId !== runId) return;

          const stopRequested = currentSession.stopRequested;
          runEnded = true;
          currentSession.active = false;
          this.persistActive(currentSession, false);
          currentSession.agent = null;
          currentSession.stopRequested = false;
          currentSession.lastActivity = new Date();
          this.releaseRuntimeProjectLease(sessionId);

          this.noteStopped(currentSession);

          if (!stopRequested) {
            broadcastToSession(
              sessionId,
              {
                type: 'error',
                message: error.message,
              },
              this.deps.claudeSessions,
              this.deps.webSocketConnections
            );
          }
        },
      })) as RuntimeSession;
      runtimeMayBeAlive = true;

      // DELETE/reclaim can begin while the bridge is spawning but before this
      // promise resolves. Publish nothing from that launch: make the record an
      // admission owner temporarily and synchronously drain the process through
      // the same verified stop contract retirement will use.
      if (!this.launchIsCurrent(session, runId)) {
        session.active = true;
        session.agent = agentKind;
        session.stopRequested = true;
        this.persistActive(session, true);
        await this.stopRuntime(session.id, agentKind);
        return;
      }

      // A bridge may report an immediate exit while `startSession()` is still
      // resolving. Do not resurrect that finished run below — especially not
      // in SQLite, where it would make a dead project look busy. (#168)
      if (runEnded) {
        if (session.runId === runId) session.runId = previousRunId;
        return;
      }

      session.active = true;
      this.persistActive(session, true);
      session.agent = agentKind;
      session.lastAgent = agentKind;
      const verifiedVersion = agentKind === 'terminal'
        ? null
        : await this.deps.probeAgentLaunchVersion?.(
            environment,
            agentKind,
            managedLaunch?.command,
          ) ?? null;
      session.runningAgentVersion = verifiedVersion;
      session.runningManagedAgentVersion = managedLaunch && verifiedVersion === managedLaunch.version
        ? verifiedVersion
        : null;
      session.runtimeStartOptions = { ...safeOptions };
      session.stopRequested = false;
      session.lastActivity = new Date();
      session.runtimeLabel =
        agentKind === 'terminal'
          ? runtimeSession.runtimeLabel || 'Terminal'
          : this.getRuntimeLabel(agentKind, session);
      session.terminalOptions =
        agentKind === 'terminal'
          ? {
              mode: (runtimeSession.terminalMode as 'shell' | 'command') || 'shell',
              shell: runtimeSession.shell || '/bin/sh',
              command:
                runtimeSession.terminalMode === 'command'
                  ? typeof options.command === 'string'
                    ? options.command.trim()
                    : ''
                  : null,
            }
          : null;

      if (!session.sessionStartTime) {
        session.sessionStartTime = new Date();
      }

      broadcastToSession(
        sessionId,
        {
          type: `${agentKind}_started`,
          sessionId,
          agent: agentKind,
          runtimeLabel: session.runtimeLabel,
        },
        this.deps.claudeSessions,
        this.deps.webSocketConnections
      );

      // A run that produces nothing for its first ninety seconds is still a run,
      // so the tab lights up on the start rather than waiting for output. The
      // throttle is primed here too, so the first byte does not re-announce
      // what this line has just said.
      this.activityAnnounced.set(sessionId, Date.now());
      announceSessionActivity(session, true, this.deps.webSocketConnections);
    } catch (error: unknown) {
      session.outputBuffer = previousOutputBuffer;
      // The run never started, so hand the id back rather than leaving the
      // session tagged with a run that does not exist.
      if (session.runId === runId) {
        session.runId = previousRunId;
      }
      if (!runtimeMayBeAlive) {
        this.persistActive(session, false);
        this.releaseRuntimeProjectLease(sessionId);
      } else {
        // A failed verified stop is an admission failure, not an exited run.
        // Keep the record and lease live so deletion/reclaim cannot pass it.
        session.active = true;
        session.agent = agentKind;
        this.persistActive(session, true);
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      if (this.deps.dev) {
        console.error(
          `Error starting ${agentKind} in session ${wsInfo.claudeSessionId}:`,
          error
        );
      }
      const message = errorMessage.startsWith('Failed to start')
        ? errorMessage
        : `Failed to start ${this.getRuntimeErrorLabel(agentKind)}: ${errorMessage}`;
      sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message,
      });
    }
    } finally {
      this.finishRuntimeStart(session.id);
    }
  }


  async stopRuntime(sessionId: string, agentKind: AgentKind): Promise<void> {
    const session = this.deps.claudeSessions.get(sessionId);
    const runId = session?.runId;
    const existing = this.runtimeStops.get(sessionId);
    if (
      existing
      && existing.session === session
      && existing.runId === runId
    ) {
      return existing.promise;
    }

    const attempt = this.stopRuntimeOnce(sessionId, agentKind, session, runId);
    const entry = { session: session!, runId, promise: attempt };
    if (session) this.runtimeStops.set(sessionId, entry);
    try {
      await attempt;
    } finally {
      if (this.runtimeStops.get(sessionId) === entry) {
        this.runtimeStops.delete(sessionId);
      }
    }
  }


  protected async handleAgentUpdateRestart(
    wsId: string,
    wsInfo: WebSocketInfo,
    data: IncomingMessage,
  ): Promise<void> {
    const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
    if (!sessionId) {
      sendToWebSocket(wsInfo.ws, {
        type: 'runtime_restart_result', sessionId, ok: false, reason: 'invalid_session',
      });
      return;
    }
    if (this.agentUpdateRestarts.has(sessionId)) {
      sendToWebSocket(wsInfo.ws, { type: 'runtime_restart_result', sessionId, ok: false, reason: 'busy' });
      return;
    }
    const attempt = this.handleAgentUpdateRestartOnce(wsId, wsInfo, data, sessionId);
    this.agentUpdateRestarts.set(sessionId, attempt);
    try {
      await attempt;
    } finally {
      if (this.agentUpdateRestarts.get(sessionId) === attempt) {
        this.agentUpdateRestarts.delete(sessionId);
      }
    }
  }


  protected async handleAgentUpdateRestartOnce(
    wsId: string,
    wsInfo: WebSocketInfo,
    data: IncomingMessage,
    sessionId: string,
  ): Promise<void> {
    const session = this.deps.claudeSessions.get(sessionId);
    if (!session || session.ownerUserId !== wsInfo.userId) {
      sendToWebSocket(wsInfo.ws, { type: 'runtime_restart_result', sessionId, ok: false, reason: 'not_found' });
      return;
    }
    if (wsInfo.claudeSessionId !== sessionId) {
      sendToWebSocket(wsInfo.ws, { type: 'runtime_restart_result', sessionId, ok: false, reason: 'not_current' });
      return;
    }
    if (session.projectId) {
      sendToWebSocket(wsInfo.ws, { type: 'runtime_restart_result', sessionId, ok: false, reason: 'project_managed' });
      return;
    }
    const agentKind = session.agent || session.lastAgent;
    if (!agentKind || agentKind === 'terminal') {
      sendToWebSocket(wsInfo.ws, { type: 'runtime_restart_result', sessionId, ok: false, reason: 'not_agent' });
      return;
    }

    let environment: UserEnvironment;
    try {
      environment = this.deps.resolveAgentEnvironment
        ? await this.deps.resolveAgentEnvironment(session)
        : await this.userEnvironment(session.ownerUserId);
    } catch (error) {
      console.error(`Could not resolve the environment for agent restart ${sessionId}:`, error);
      sendToWebSocket(wsInfo.ws, {
        type: 'runtime_restart_result', sessionId, ok: false,
        reason: 'environment_unavailable',
      });
      return;
    }
    const selected = this.deps.resolveAgentLaunch?.(session, environment, agentKind) ?? null;
    if (!selected) {
      sendToWebSocket(wsInfo.ws, { type: 'runtime_restart_result', sessionId, ok: false, reason: 'no_managed_update' });
      return;
    }

    try {
      if (session.surface === 'chat') {
        const result = await this.deps.chatManager?.restartForAgentUpdate?.(sessionId, {
          automatic: data.automatic === true,
          allowFreshContext: data.allowFreshContext === true,
          command: selected.command,
        }) ?? { ok: false as const, reason: 'not_running' as const };
        if (!result.ok) {
          sendToWebSocket(wsInfo.ws, { type: 'runtime_restart_result', sessionId, ok: false, reason: result.reason });
          return;
        }
        const verifiedVersion = await this.deps.probeAgentLaunchVersion?.(
          environment,
          agentKind,
          selected.command,
        ) ?? null;
        if (verifiedVersion !== selected.version) {
          sendToWebSocket(wsInfo.ws, {
            type: 'runtime_restart_result', sessionId, ok: false,
            reason: 'version_verification_failed',
          });
          return;
        }
        session.runningAgentVersion = verifiedVersion;
        session.runningManagedAgentVersion = verifiedVersion;
        sendToWebSocket(wsInfo.ws, {
          type: 'runtime_restart_result', sessionId, ok: true,
          resumed: result.resumed, version: selected.version,
        });
        return;
      }

      if (data.automatic === true) {
        sendToWebSocket(wsInfo.ws, { type: 'runtime_restart_result', sessionId, ok: false, reason: 'manual_required' });
        return;
      }
      if (wsInfo.claudeSessionId !== sessionId) {
        sendToWebSocket(wsInfo.ws, { type: 'runtime_restart_result', sessionId, ok: false, reason: 'not_current' });
        return;
      }
      await this.stopRuntime(sessionId, agentKind);
      await this.startRuntime(wsId, agentKind, {
        ...(session.runtimeStartOptions || {}),
        ...(session.termCols ? { cols: session.termCols } : {}),
        ...(session.termRows ? { rows: session.termRows } : {}),
      });
      if (session.runningAgentVersion !== selected.version) {
        sendToWebSocket(wsInfo.ws, {
          type: 'runtime_restart_result', sessionId, ok: false,
          reason: 'version_verification_failed',
        });
        return;
      }
      sendToWebSocket(wsInfo.ws, {
        type: 'runtime_restart_result', sessionId, ok: true,
        resumed: false, version: selected.version,
      });
    } catch (error) {
      console.error(`Could not restart agent for session ${sessionId}:`, error);
      sendToWebSocket(wsInfo.ws, {
        type: 'runtime_restart_result', sessionId, ok: false,
        reason: 'restart_failed',
      });
    }
  }


  protected async stopRuntimeOnce(
    sessionId: string,
    agentKind: AgentKind,
    session: SessionRecord | undefined,
    runId: string | undefined,
  ): Promise<void> {
    if (!session) {
      this.releaseRuntimeProjectLease(sessionId);
      return;
    }
    const chatOwned = session.surface === 'chat'
      && this.deps.chatManager?.has(sessionId) === true;
    if (!session.active && !chatOwned) {
      this.releaseRuntimeProjectLease(sessionId);
      return;
    }
    if (chatOwned && !session.active) {
      // Manager ownership is stronger evidence than a stale persisted flag.
      // Restore the conservative record before an awaited retry so a rejected
      // proof cannot leave reclaim/delete believing there is no live work.
      session.active = true;
      session.agent ||= session.lastAgent || agentKind;
      this.persistActive(session, true);
    }

    session.stopRequested = true;
    if (session.surface === 'chat') {
      if (!this.deps.chatManager) {
        if (session.projectId || this.runtimeProjectLeases.has(sessionId)) {
          throw new Error(`Cannot verify that project chat ${sessionId} stopped: manager unavailable`);
        }
      } else {
        await this.deps.chatManager.stop(sessionId);
      }
    } else {
      const bridge = this.deps.getRuntimeBridge(agentKind);
      if (bridge) {
        await bridge.stopSession(sessionId);
      } else if (session.projectId || this.runtimeProjectLeases.has(sessionId)) {
        // Losing the only terminal handle is not evidence that a container
        // command ended. Keep the record and project admission closed so an
        // operator/retry can recover it; host-only legacy records retain their
        // historical no-handle cleanup below.
        throw new Error(`Cannot verify that project terminal ${sessionId} stopped: bridge unavailable`);
      }
    }

    // The verified exit callback may make this run inactive and allow a new
    // launch before the awaiting stop continuation is scheduled. Never let the
    // old continuation retire or release the replacement run.
    if (
      this.deps.claudeSessions.get(sessionId) !== session
      || session.runId !== runId
    ) {
      return;
    }
    session.active = false;
    this.persistActive(session, false);
    session.agent = null;
    session.lastActivity = new Date();
    this.releaseRuntimeProjectLease(sessionId);

    this.noteStopped(session);

    broadcastToSession(
      sessionId,
      {
        type: `${agentKind}_stopped`,
        sessionId,
        agent: agentKind,
        runtimeLabel: session.runtimeLabel,
      },
      this.deps.claudeSessions,
      this.deps.webSocketConnections
    );
  }


  protected async handleInput(
    wsId: string,
    wsInfo: WebSocketInfo,
    inputData: string
  ): Promise<void> {
    if (!wsInfo.claudeSessionId) return;

    const session = this.deps.claudeSessions.get(wsInfo.claudeSessionId);
    if (!session || !session.connections.has(wsId)) return;

    if (session.active && session.agent) {
      try {
        const bridge = this.deps.getRuntimeBridge(session.agent);
        if (bridge) {
          await bridge.sendInput(wsInfo.claudeSessionId, inputData);
          this.noteActivity(session);
        }
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (this.deps.dev) {
          console.error(
            `Failed to send input to session ${wsInfo.claudeSessionId}:`,
            errorMessage
          );
        }
        sendToWebSocket(wsInfo.ws, {
          type: 'error',
          message: 'Nothing is running in this session. Please start one first.',
        });
      }
    } else {
      sendToWebSocket(wsInfo.ws, {
        type: 'info',
        message: 'No process is running. Choose an option to start.',
      });
    }
  }


  protected async handleResize(
    wsId: string,
    wsInfo: WebSocketInfo,
    cols: number,
    rows: number
  ): Promise<void> {
    if (!wsInfo.claudeSessionId) return;

    const session = this.deps.claudeSessions.get(wsInfo.claudeSessionId);
    if (!session || !session.connections.has(wsId)) return;

    // cols/rows come straight off the socket: Math.max(1, Math.floor(NaN))
    // is NaN, and a NaN geometry would reach the emulator and the PTY.
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;

    // Keep the recorder's geometry in step with the PTY, otherwise stored lines
    // would be wrapped at a width the program never actually rendered at.
    session.termCols = Math.max(1, Math.floor(cols));
    session.termRows = Math.max(1, Math.floor(rows));
    this.recorders.get(session.id)?.resize(session.termCols, session.termRows);

    if (session.active && session.agent) {
      try {
        const bridge = this.deps.getRuntimeBridge(session.agent);
        if (bridge) {
          await bridge.resize(wsInfo.claudeSessionId, session.termCols, session.termRows);
          this.noteActivity(session);
        }
      } catch (error) {
        if (this.deps.dev) {
          console.log(
            `Resize ignored - process not active in session ${wsInfo.claudeSessionId}`
          );
        }
      }
    }
  }


  protected async handleStop(wsInfo: WebSocketInfo): Promise<void> {
    if (!wsInfo.claudeSessionId) return;

    const session = this.deps.claudeSessions.get(wsInfo.claudeSessionId);
    if (session?.active && session?.agent) {
      await this.stopRuntime(wsInfo.claudeSessionId, session.agent);
    }
  }


  protected async handleGetUsage(wsInfo: WebSocketInfo): Promise<void> {
    try {
      const currentSessionStats = await this.deps.usageReader.getCurrentSessionStats();
      const burnRateData = await this.deps.usageReader.calculateBurnRate(60);
      const overlappingSessions = await this.deps.usageReader.detectOverlappingSessions();
      const dailyStats = await this.deps.usageReader.getUsageStats(24);

      // Update analytics with current session data
      const stats = currentSessionStats as Record<string, unknown> | null;
      if (stats && stats.sessionStartTime) {
        this.deps.usageAnalytics.startSession(
          stats.sessionId as string,
          new Date(stats.sessionStartTime as string)
        );

        if ((stats.totalTokens as number) > 0) {
          const models = stats.models as Record<string, unknown>;
          this.deps.usageAnalytics.addUsageData({
            tokens: stats.totalTokens,
            inputTokens: stats.inputTokens,
            outputTokens: stats.outputTokens,
            cacheCreationTokens: stats.cacheCreationTokens,
            cacheReadTokens: stats.cacheReadTokens,
            cost: stats.totalCost,
            model: Object.keys(models)[0] || 'unknown',
            sessionId: stats.sessionId,
          });
        }
      }

      const analytics = this.deps.usageAnalytics.getAnalytics();

      // Calculate session timer
      let sessionTimer: Record<string, unknown> | null = null;
      if (stats && stats.sessionStartTime) {
        const startTime = new Date(stats.sessionStartTime as string);
        const now = new Date();
        const elapsedMs = now.getTime() - startTime.getTime();

        const sessionDurationMs = this.deps.sessionDurationHours * 60 * 60 * 1000;
        const remainingMs = Math.max(0, sessionDurationMs - elapsedMs);

        const hours = Math.floor(elapsedMs / (1000 * 60 * 60));
        const minutes = Math.floor((elapsedMs % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((elapsedMs % (1000 * 60)) / 1000);

        const remainingHours = Math.floor(remainingMs / (1000 * 60 * 60));
        const remainingMinutes = Math.floor(
          (remainingMs % (1000 * 60 * 60)) / (1000 * 60)
        );

        const burnRate = burnRateData as { rate?: unknown; confidence?: unknown };

        sessionTimer = {
          startTime: stats.sessionStartTime,
          elapsed: elapsedMs,
          remaining: remainingMs,
          formatted: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`,
          remainingFormatted: `${String(remainingHours).padStart(2, '0')}:${String(remainingMinutes).padStart(2, '0')}`,
          hours,
          minutes,
          seconds,
          remainingMs,
          sessionDurationHours: this.deps.sessionDurationHours,
          sessionNumber: (stats.sessionNumber as number) || 1,
          isExpired: remainingMs === 0,
          burnRate: burnRate.rate,
          burnRateConfidence: burnRate.confidence,
        };
      }

      sendToWebSocket(wsInfo.ws, {
        type: 'usage_update',
        sessionStats: stats || {
          requests: 0,
          totalTokens: 0,
          totalCost: 0,
          message: 'No active Claude session',
        },
        dailyStats,
        sessionTimer,
        analytics,
        burnRate: burnRateData,
        overlappingSessions: overlappingSessions.length,
        // No `plan` and no `limits`. This used to answer with the `--plan`
        // flag's value and the row of the hand-written allowance table it
        // selected, neither of which was ever a fact about anybody's account
        // (#137). What a provider actually states about an account travels on
        // the chat session's `limits` event instead.
      });
    } catch (error) {
      console.error('Error getting usage stats:', error);
      sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: 'Failed to retrieve usage statistics',
      });
    }
  }

}
