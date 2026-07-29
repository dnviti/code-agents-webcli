import { randomUUID } from 'node:crypto';
import {
  AgentKind,
  Aliases,
  BridgeInterface,
  PathValidation,
  RuntimeSession,
  SessionRecord,
  WebSocketInfo,
} from '../types.js';
import { TranscriptStoreLike } from '../services/transcript-store.js';
import { HistoryStoreLike } from '../services/history-store.js';
import { ScrollbackRecorder } from '../services/scrollback.js';
import { sendToWebSocket, broadcastChat, broadcastToSession } from './handler.js';
import { chatUnavailableReason, isChatRuntime } from '../../shared/chat-runtimes.js';
import { ChatNotRunningError } from '../chat/session.js';

/**
 * The longest model name worth storing. Real ones are far shorter; this only
 * has to stop an unbounded string from being persisted and then handed to a
 * spawn on every future launch of the conversation.
 */
const MAX_MODEL_NAME = 200;

/**
 * Tidy a typed model name into something safe to keep.
 *
 * Names are never validated against a list — a runtime knows its own models
 * and new ones appear without us — so this only removes what can't belong in
 * one: control characters, which would otherwise ride into the best-effort
 * `/model <name>` turn as extra lines, and unbounded length.
 */
function normaliseModelName(raw: string): string | undefined {
  const stripped = raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();
  // Sliced by code point, not by code unit: cutting mid-character would store
  // half a surrogate pair.
  const cleaned = [...stripped].slice(0, MAX_MODEL_NAME).join('').trim();
  return cleaned || undefined;
}

/**
 * Tidy a reasoning-effort level into something safe to keep.
 *
 * Far stricter than the model equivalent, and deliberately so. A model name is
 * free text because only the runtime knows its own catalogue; an effort level is
 * not — every one this app will ever send came out of a list the runtime
 * published, and the whole set observed across the six runtimes is a handful of
 * bare words: `off`, `on`, `auto`, `none`, `minimal`, `low`, `medium`, `high`,
 * `xhigh`, `max`, `ultra`. So anything that is not a short lower-case token is
 * not a level anybody offered, and is dropped rather than stored and then pushed
 * onto the command line of every future launch of this conversation.
 */
function normaliseEffortLevel(raw: string): string | undefined {
  const cleaned = raw.trim().toLowerCase();
  return /^[a-z][a-z0-9_-]{0,31}$/.test(cleaned) ? cleaned : undefined;
}

export interface MessageProcessorDeps {
  dev: boolean;
  claudeSessions: Map<string, SessionRecord>;
  webSocketConnections: Map<string, WebSocketInfo>;
  baseFolder: string;
  sessionDurationHours: number;
  aliases: Aliases;
  validatePath(targetPath: string): PathValidation;
  getSelectedWorkingDir(userId: number): string | null;
  createSessionRecord(params: {
    id: string;
    ownerUserId: number;
    name?: string;
    workingDir: string;
    connections?: string[];
  }): SessionRecord;
  getRuntimeBridge(agentKind: AgentKind): BridgeInterface | null;
  saveSessionsToDisk(): Promise<void>;
  /**
   * Launch configuration for this runtime, already resolved from the active
   * profile: model, extra args and environment. Returns null when no profile
   * is active, which is the default and must stay a plain unmodified launch.
   */
  resolveRuntimeProfile(agentKind: AgentKind, workingDir: string): {
    profileName: string;
    model?: string;
    extraArgs?: string[];
    env?: Record<string, string>;
  } | null;
  transcriptStore: TranscriptStoreLike;
  historyStore: HistoryStoreLike;
  /**
   * Live chat sessions, when chat mode is available.
   *
   * Optional so a server built without it — and every existing test that
   * constructs a MessageProcessor — keeps working unchanged; chat messages
   * then answer with a plain "unavailable" rather than throwing.
   */
  chatManager?: ChatManagerLike;
  usageReader: {
    getCurrentSessionStats(): Promise<any>;
    calculateBurnRate(minutes: number): Promise<any>;
    detectOverlappingSessions(): Promise<any[]>;
    getUsageStats(hours: number): Promise<any>;
  };
  usageAnalytics: {
    startSession(sessionId: string, startTime: Date): void;
    addUsageData(data: any): void;
    getAnalytics(): any;
  };
}

/** What the message processor needs from the chat manager, and nothing more. */
export interface ChatManagerLike {
  has(sessionId: string): boolean;
  start(
    record: SessionRecord,
    options: {
      runtime: string;
      workingDir: string;
      model?: string;
      effort?: string;
      extraArgs?: string[];
      env?: Record<string, string>;
      bypassPermissions?: boolean;
      resumeSessionId?: string;
      startFresh?: boolean;
    },
  ): Promise<{ runtimeKind: string; currentCapabilities: unknown; bypassing: boolean }>;
  snapshot(record: SessionRecord): Promise<unknown>;
  send(sessionId: string, turn: { text: string; attachments?: unknown[] }): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  /** Switch a live session's model. False when nothing is running, or the adapter cannot. */
  setModel(sessionId: string, model: string): Promise<boolean>;
  /** Carry a new model into the options an in-place `/clear` restart replays. */
  rememberModel(sessionId: string, model: string | undefined): void;
  /** Switch a live session's reasoning effort. False when nothing is running, or the adapter cannot. */
  setEffort(sessionId: string, effort: string): Promise<boolean>;
  /** Carry a new effort level into the options an in-place `/clear` restart replays. */
  rememberEffort(sessionId: string, effort: string | undefined): void;
  cancelQueued(sessionId: string, queuedId: string): boolean;
  /** Interrupt what is running and deliver one waiting turn immediately. */
  sendQueuedNow(sessionId: string, queuedId: string): Promise<boolean>;
  retryQueued(sessionId: string, queuedId: string): boolean;
  respondPermission(sessionId: string, requestId: string, optionId: string): boolean;
  answerQuestion(
    sessionId: string,
    requestId: string,
    optionIds: string[],
    skipped?: boolean,
  ): boolean;
  stop(sessionId: string): Promise<void>;
  readPage(
    record: SessionRecord,
    fromSeq: number,
    count: number,
  ): Promise<{ events: unknown[]; firstSeq: number; from?: number; cursor: number }>;
  turnIndex(record: SessionRecord): Promise<{
    turns: unknown[];
    firstSeq: number;
    complete: boolean;
  }>;
}

interface IncomingMessage {
  type: string;
  name?: string;
  workingDir?: string;
  sessionId?: string;
  options?: Record<string, unknown>;
  data?: string;
  cols?: number;
  rows?: number;
  command?: string;
  fromLine?: number;
  count?: number;
  requestId?: string;
  text?: string;
  attachments?: unknown[];
  optionId?: string;
  /** Every option picked for a multiple-choice question the model asked. */
  optionIds?: unknown[];
  /** True when the user chose to answer a question with nothing. */
  skipped?: boolean;
  fromSeq?: number;
  agentKind?: string;
  /** Identifies one turn waiting in the send-ahead queue. */
  queuedId?: string;
  /** A conversation-scoped model to switch to, or null/empty to clear the override. */
  model?: string | null;
  /**
   * A conversation-scoped reasoning-effort level, or null/empty to clear it.
   *
   * Unlike the model this is never free text: the control only offers levels the
   * running runtime published, so anything arriving here that the runtime does
   * not know is a bug or a hand-crafted socket frame, and is refused rather than
   * stored and replayed into every future launch.
   */
  effort?: string | null;
}

export class MessageProcessor {
  private deps: MessageProcessorDeps;
  /** One scrollback emulator per session, rebuilding history from the PTY stream. */
  private recorders = new Map<string, ScrollbackRecorder>();

  constructor(deps: MessageProcessorDeps) {
    this.deps = deps;
  }

  async handleMessage(wsId: string, data: IncomingMessage): Promise<void> {
    const wsInfo = this.deps.webSocketConnections.get(wsId);
    if (!wsInfo) return;

    switch (data.type) {
      case 'create_session':
        await this.createAndJoinSession(wsId, data.name, data.workingDir);
        break;

      case 'join_session':
        await this.joinSession(wsId, data.sessionId!);
        break;

      case 'leave_session':
        await this.leaveSession(wsId);
        break;

      case 'start_claude':
        await this.startRuntime(wsId, 'claude', data.options || {});
        break;

      case 'start_codex':
        await this.startRuntime(wsId, 'codex', data.options || {});
        break;

      case 'start_agent':
        await this.startRuntime(wsId, 'agent', data.options || {});
        break;

      case 'start_pi':
        await this.startRuntime(wsId, 'pi', data.options || {});
        break;

      case 'start_grok':
        await this.startRuntime(wsId, 'grok', data.options || {});
        break;

      case 'start_qwen':
        await this.startRuntime(wsId, 'qwen', data.options || {});
        break;

      case 'start_kimi':
        await this.startRuntime(wsId, 'kimi', data.options || {});
        break;

      case 'start_omp':
        await this.startRuntime(wsId, 'omp', data.options || {});
        break;

      case 'start_terminal':
        await this.startRuntime(wsId, 'terminal', data.options || {});
        break;

      case 'start_chat':
        await this.startChat(
          wsId,
          String(data.agentKind || ''),
          data.options || {},
          typeof data.sessionId === 'string' ? data.sessionId : undefined,
        );
        break;

      case 'chat_send':
        await this.handleChatSend(wsInfo, data);
        break;

      case 'chat_interrupt':
        await this.handleChatInterrupt(wsInfo, data);
        break;

      case 'chat_set_model':
        await this.handleChatSetModel(wsInfo, data);
        break;

      case 'chat_set_effort':
        await this.handleChatSetEffort(wsInfo, data);
        break;

      case 'chat_queue_cancel':
        this.handleChatQueueCancel(wsInfo, data);
        break;

      case 'chat_queue_send_now':
        await this.handleChatQueueSendNow(wsInfo, data);
        break;

      case 'chat_queue_retry':
        this.handleChatQueueRetry(wsInfo, data);
        break;

      case 'chat_permission_response':
        this.handleChatPermission(wsInfo, data);
        break;

      case 'chat_question_answer':
        this.handleChatQuestion(wsInfo, data);
        break;

      case 'chat_history_request':
        await this.handleChatHistory(wsInfo, data);
        break;

      case 'chat_turn_index_request':
        await this.handleChatTurnIndex(wsInfo, data);
        break;

      case 'chat_subscribe':
        await this.subscribeChat(wsInfo, data.sessionId || '');
        break;

      case 'chat_unsubscribe':
        if (data.sessionId) wsInfo.chatSessionIds.delete(data.sessionId);
        break;

      case 'input':
        await this.handleInput(wsId, wsInfo, data.data || '');
        break;

      case 'resize':
        await this.handleResize(wsId, wsInfo, data.cols || 80, data.rows || 24);
        break;

      case 'stop':
        await this.handleStop(wsInfo);
        break;

      case 'history_request':
        await this.handleHistoryRequest(wsInfo, data);
        break;

      case 'ping':
        sendToWebSocket(wsInfo.ws, { type: 'pong' });
        break;

      case 'get_usage':
        await this.handleGetUsage(wsInfo);
        break;

      // Closing is done over HTTP; the socket message is the client's older
      // half of that call and still arrives. Named explicitly so it stays a
      // no-op rather than being reported as unknown below.
      case 'close_session':
        break;

      default:
        if (this.deps.dev) {
          console.log(`Unknown message type: ${data.type}`);
        }
        // Answered rather than dropped. A request this server has never heard
        // of is almost always a page built against newer code than the running
        // process — which loads its own code once, at boot. Silence left the
        // browser waiting on a reply that was never coming; saying so turns an
        // indefinite spinner into a sentence naming the fix.
        sendToWebSocket(wsInfo.ws, {
          type: 'error',
          message:
            `This server does not understand "${data.type}". It is probably running ` +
            'an older version than this page — restart the server and reload.',
        });
    }
  }

  async createAndJoinSession(
    wsId: string,
    name?: string,
    workingDir?: string
  ): Promise<void> {
    const wsInfo = this.deps.webSocketConnections.get(wsId);
    if (!wsInfo) return;

    let validWorkingDir = this.deps.baseFolder;
    if (workingDir) {
      const validation = this.deps.validatePath(workingDir);
      if (!validation.valid) {
        sendToWebSocket(wsInfo.ws, {
          type: 'error',
          message: 'Cannot create session with working directory outside the allowed area',
        });
        return;
      }
      validWorkingDir = validation.path!;
    } else {
      validWorkingDir = this.deps.getSelectedWorkingDir(wsInfo.userId) || this.deps.baseFolder;
    }

    const sessionId = randomUUID();
    const session = this.deps.createSessionRecord({
      id: sessionId,
      ownerUserId: wsInfo.userId,
      name,
      workingDir: validWorkingDir,
      connections: [wsId],
    });

    this.deps.claudeSessions.set(sessionId, session);
    wsInfo.claudeSessionId = sessionId;
    void this.deps.transcriptStore.ensureTranscript(session);

    this.deps.saveSessionsToDisk();

    sendToWebSocket(wsInfo.ws, {
      type: 'session_created',
      sessionId,
      sessionName: session.name,
      workingDir: session.workingDir,
      lastAgent: session.lastAgent,
      runtimeLabel: session.runtimeLabel,
    });
  }

  async joinSession(wsId: string, claudeSessionId: string): Promise<void> {
    const wsInfo = this.deps.webSocketConnections.get(wsId);
    if (!wsInfo) return;

    const session = this.deps.claudeSessions.get(claudeSessionId);
    if (!session || session.ownerUserId !== wsInfo.userId) {
      sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: 'Session not found',
      });
      return;
    }

    // Leave current session if any
    if (wsInfo.claudeSessionId) {
      await this.leaveSession(wsId);
    }

    // Join new session
    wsInfo.claudeSessionId = claudeSessionId;
    session.connections.add(wsId);
    session.lastActivity = new Date();
    session.lastAccessed = Date.now();

    const transcriptChunks = await this.deps.transcriptStore.readTranscriptChunks(session);
    const replayBuffer =
      transcriptChunks.length > 0 ? transcriptChunks : session.outputBuffer.slice(-200);

    // Tells the client how far back it can page. The replayed tail restores the
    // live terminal; anything above it is fetched a screen at a time.
    const history = await this.deps.historyStore.stat(session).catch(() => ({
      firstLine: 0,
      totalLines: 0,
    }));

    // Send session info and replay buffer
    sendToWebSocket(wsInfo.ws, {
      type: 'session_joined',
      history,
      sessionId: claudeSessionId,
      sessionName: session.name,
      workingDir: session.workingDir,
      active: session.active,
      agent: session.agent,
      lastAgent: session.lastAgent,
      runtimeLabel: session.runtimeLabel,
      surface: session.surface || 'terminal',
      outputBuffer: replayBuffer,
    });

    // A chat session's transcript is not in the PTY replay above — it is a
    // separate event log — so it is sent as its own snapshot. Sent after
    // session_joined so the client has already switched surfaces and has
    // somewhere to put it. Subscribing here as well as sending the snapshot is
    // what keeps the conversation live once the user moves to another tab.
    if (session.surface === 'chat') {
      await this.subscribeChat(wsInfo, claudeSessionId);
    }

    if (this.deps.dev) {
      console.log(`WebSocket ${wsId} joined Claude session ${claudeSessionId}`);
    }
  }

  async leaveSession(wsId: string): Promise<void> {
    const wsInfo = this.deps.webSocketConnections.get(wsId);
    if (!wsInfo || !wsInfo.claudeSessionId) return;

    const session = this.deps.claudeSessions.get(wsInfo.claudeSessionId);
    if (session) {
      session.connections.delete(wsId);
      session.lastActivity = new Date();
    }

    wsInfo.claudeSessionId = null;

    sendToWebSocket(wsInfo.ws, {
      type: 'session_left',
    });
  }

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
    const profile = this.deps.resolveRuntimeProfile(agentKind, session.workingDir);
    if (profile) {
      if (profile.model) safeOptions.model = profile.model;
      if (profile.extraArgs?.length) safeOptions.extraArgs = profile.extraArgs;
      if (profile.env && Object.keys(profile.env).length) safeOptions.env = profile.env;
      console.log(`Applying runtime profile "${profile.profileName}" to ${agentKind}`);
    }
    // A model chosen for this conversation beats the profile default, but only
    // for this one launch: it is never written back as a new profile or
    // personal default.
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
    session.runId = runId;

    try {
      const runtimeSession = (await bridge.startSession(sessionId, {
        ...safeOptions,
        workingDir: session.workingDir,
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
          currentSession.active = false;
          currentSession.agent = null;
          currentSession.stopRequested = false;
          currentSession.lastActivity = new Date();

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
          currentSession.active = false;
          currentSession.agent = null;
          currentSession.stopRequested = false;
          currentSession.lastActivity = new Date();

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

      session.active = true;
      session.agent = agentKind;
      session.lastAgent = agentKind;
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
    } catch (error: unknown) {
      session.outputBuffer = previousOutputBuffer;
      // The run never started, so hand the id back rather than leaving the
      // session tagged with a run that does not exist.
      if (session.runId === runId) {
        session.runId = previousRunId;
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
  }

  async stopRuntime(sessionId: string, agentKind: AgentKind): Promise<void> {
    const session = this.deps.claudeSessions.get(sessionId);
    if (!session || !session.active) return;

    const bridge = this.deps.getRuntimeBridge(agentKind);
    if (!bridge) return;

    session.stopRequested = true;
    await bridge.stopSession(sessionId);
    session.active = false;
    session.agent = null;
    session.lastActivity = new Date();

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

  private async handleInput(
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

  private async handleResize(
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

  private async handleStop(wsInfo: WebSocketInfo): Promise<void> {
    if (!wsInfo.claudeSessionId) return;

    const session = this.deps.claudeSessions.get(wsInfo.claudeSessionId);
    if (session?.active && session?.agent) {
      await this.stopRuntime(wsInfo.claudeSessionId, session.agent);
    }
  }

  private async handleGetUsage(wsInfo: WebSocketInfo): Promise<void> {
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

  private appendOutputToSession(sessionId: string, data: string): void {
    const session = this.deps.claudeSessions.get(sessionId);
    if (!session) return;

    session.outputBuffer.push(data);
    if (session.outputBuffer.length > session.maxBufferSize) {
      session.outputBuffer.shift();
    }

    this.deps.transcriptStore.appendOutput(session, data);
    this.getRecorder(session).write(data);
  }

  /**
   * Serve a page of scrollback.
   *
   * The ownership check is the important part: session ids are guessable enough
   * that without it any signed-in user could page through another user's
   * terminal history, which is exactly the content this app exists to protect.
   */

  // ----------------------------------------------------------------- chat mode

  /**
   * Open this session as a chat instead of a terminal.
   *
   * The surface is fixed on the session record here and never changes: the two
   * modes run the runtime as different processes — a TUI in a PTY versus a
   * headless protocol stream — so there is nothing meaningful to switch between
   * afterwards. A session that already ran as a terminal is refused rather than
   * converted, because its scrollback and a chat log are not the same history.
   */
  async startChat(
    wsId: string,
    agentKind: string,
    options: Record<string, unknown> = {},
    /**
     * Which conversation to (re)launch, when the browser names one.
     *
     * A relaunch is issued from the pane of a specific chat, and a socket can
     * be watching several — so falling back to "whichever session this socket
     * joined" would restart the wrong conversation. Absent for a first launch,
     * where the joined session is the only candidate.
     */
    targetSessionId?: string,
  ): Promise<void> {
    const wsInfo = this.deps.webSocketConnections.get(wsId);
    if (!wsInfo || !wsInfo.claudeSessionId) {
      if (wsInfo?.ws) {
        sendToWebSocket(wsInfo.ws, { type: 'error', message: 'No session joined' });
      }
      return;
    }

    const manager = this.deps.chatManager;
    if (!manager) {
      sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: 'Chat mode is not available on this server',
      });
      return;
    }

    // Same ownership rule either way: `chatSessionFor` refuses an id this
    // socket has neither joined nor subscribed to, so naming a session cannot
    // be used to reach one that is not this browser's to reach.
    const session = targetSessionId
      ? this.chatSessionFor(wsInfo, targetSessionId)
      : this.deps.claudeSessions.get(wsInfo.claudeSessionId);
    if (!session || session.ownerUserId !== wsInfo.userId) return;

    if (!isChatRuntime(agentKind)) {
      sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message:
          chatUnavailableReason(agentKind) || `${agentKind} cannot be opened as a chat`,
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

    // Only the bypass flag is taken from the browser. Everything else that
    // shapes the launch — model, arguments, environment — comes from the
    // server-side profile below, for the same reason it does on the terminal
    // path: the client must not be able to forge a launch configuration.
    //
    // Two ways to relaunch a chat whose process is gone, and the difference is
    // the whole point of the choice the user is offered: resume hands the agent
    // back its own context, so the conversation on screen is one it remembers;
    // without it the transcript stays but the agent is new to it.
    const resumeSessionId =
      options.resume === true ? session.nativeChatSessionId : undefined;
    // Only when the browser said so: see ChatSessionStartOptions.startFresh.
    const startFresh = options.resume === false;

    // Absent means "whatever this conversation was already running in", which is
    // what makes a relaunch or a resume from the launcher come back in the mode
    // the user left it in instead of quietly dropping to manual. The fallback
    // reads the record — this conversation's own, already checked to belong to
    // this user — so it can restore a mode but never widen or borrow one.
    //
    // Not for a fresh start, though: that deliberately leaves the conversation
    // behind, and a bypass is a standing permission granted to the conversation
    // that asked for it rather than to the session it was held in. Inheriting it
    // would let one choice carry into every later conversation in the same tab,
    // which is the one direction it must not travel. The browser can still ask
    // for a bypass outright, and the header states whichever mode is in force.
    const requestedBypass = options.dangerouslySkipPermissions;
    const bypassPermissions =
      typeof requestedBypass === 'boolean'
        ? requestedBypass
        : !startFresh && session.chatBypassPermissions === true;

    const profile = this.deps.resolveRuntimeProfile(
      agentKind as AgentKind,
      session.workingDir,
    );

    session.surface = 'chat';
    // A level is only ever a word one runtime published, so it means nothing to
    // the next one — and worse than nothing, because the runtimes that take it
    // as a flag do not refuse an unknown value. Both claude and pi print a
    // warning to a stream nobody is reading and then run at their own default,
    // so a codex `ultra` or a kimi `on` surviving into a claude launch would
    // leave the control reporting a level the conversation was never on.
    //
    // Cleared here rather than filtered at the adapter because this is the one
    // place the change of runtime is visible; the adapters guard themselves as
    // well, for the records this misses.
    if (session.agent && session.agent !== agentKind) {
      session.chatEffortOverride = undefined;
    }
    session.agent = agentKind as AgentKind;
    session.lastAgent = agentKind as AgentKind;
    session.runtimeLabel = this.getRuntimeLabel(agentKind as AgentKind, session);
    session.lastActivity = new Date();

    try {
      const chat = await manager.start(session, {
        runtime: agentKind,
        workingDir: session.workingDir,
        // Conversation-scoped override beats the profile default, for this
        // launch only — see chat_set_model.
        model: session.chatModelOverride || profile?.model,
        // No profile fallback behind it: profiles are server-wide and keyed by
        // runtime, and an effort level is a per-conversation decision that has
        // never had a profile default to fall back to. Absent means the runtime
        // gets no flag at all and uses whatever it considers normal.
        effort: session.chatEffortOverride,
        extraArgs: profile?.extraArgs,
        env: profile?.env,
        bypassPermissions,
        resumeSessionId,
        startFresh,
      });

      session.active = true;
      session.stopRequested = false;
      session.sessionStartTime = session.sessionStartTime || new Date();
      // Recorded on the record, not just handed to the process: the process is
      // the thing that will be gone when this has to be answered again. After
      // the launch rather than before it, so a bypass that never actually ran
      // does not become the standing answer for the next attempt — persisting a
      // permission has to follow from a conversation that really started in it.
      // Absent rather than false so the whole stack has one representation of
      // "asks first" and a manual relaunch cannot read as a recorded choice.
      session.chatBypassPermissions = chat.bypassing ? true : undefined;

      // Before the broadcast, so the socket that asked for the launch is
      // already a watcher when the very first event goes out.
      wsInfo.chatSessionIds.add(session.id);

      // `session.id`, not the socket's joined id: a relaunch names its own
      // conversation, and announcing it under the joined one would tell every
      // watcher the wrong chat had come back.
      broadcastChat(
        session.id,
        {
          type: 'chat_started',
          sessionId: session.id,
          agent: agentKind,
          runtimeLabel: session.runtimeLabel,
          workingDir: session.workingDir,
          capabilities: chat.currentCapabilities,
          bypassPermissions: chat.bypassing,
          modelOverride: session.chatModelOverride || null,
          effortOverride: session.chatEffortOverride || null,
        },
        this.deps.claudeSessions,
        this.deps.webSocketConnections,
      );

      await this.deps.saveSessionsToDisk();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      session.active = false;
      // Left on 'chat' deliberately: the conversation log for this session is
      // a chat log, and flipping the surface back would show the user an empty
      // terminal as the explanation for a failed chat launch.
      sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: `Could not start ${agentKind}: ${message}`,
      });
    }
  }

  /**
   * Start watching a chat session's event stream, and hand over its transcript.
   *
   * The reply is a full `chat_snapshot` rather than "subscribed": a tab that has
   * just been told it may watch has nothing to watch *from*, and asking it to
   * make a second round trip for the transcript would leave a window in which
   * live events arrive for a conversation the client cannot place them in.
   */
  async subscribeChat(wsInfo: WebSocketInfo, sessionId: string): Promise<void> {
    const manager = this.deps.chatManager;
    if (!manager || !sessionId) return;

    const session = this.deps.claudeSessions.get(sessionId);
    if (!session || session.ownerUserId !== wsInfo.userId) {
      sendToWebSocket(wsInfo.ws, { type: 'error', message: 'Session not found' });
      return;
    }
    if (session.surface !== 'chat') return;

    wsInfo.chatSessionIds.add(sessionId);

    try {
      const snapshot = await manager.snapshot(session);
      sendToWebSocket(wsInfo.ws, {
        type: 'chat_snapshot',
        sessionId,
        snapshot,
        modelOverride: session.chatModelOverride || null,
        // Rides on the join for the same reason the model does: the snapshot
        // carries the runtime's own reported level only if it ever reported one,
        // and a conversation whose process has since died reports nothing at
        // all. The record is the only thing that still knows what was chosen.
        effortOverride: session.chatEffortOverride || null,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: `Could not load the conversation: ${message}`,
      });
    }
  }

  /**
   * The chat session a message is aimed at.
   *
   * Explicit `sessionId` wins, because a browser with several chat tabs open is
   * watching more than the one it happens to be driving; the joined session is
   * the fallback so a client that predates per-tab addressing still works.
   */
  private chatSessionFor(
    wsInfo: WebSocketInfo,
    sessionId?: string,
  ): SessionRecord | null {
    const target = sessionId || wsInfo.claudeSessionId;
    if (!target) return null;
    // A socket may only address a chat it is driving or has subscribed to.
    if (target !== wsInfo.claudeSessionId && !wsInfo.chatSessionIds.has(target)) {
      return null;
    }
    const session = this.deps.claudeSessions.get(target);
    if (!session || session.ownerUserId !== wsInfo.userId) return null;
    return session;
  }

  private async handleChatSend(
    wsInfo: WebSocketInfo,
    data: IncomingMessage,
  ): Promise<void> {
    const manager = this.deps.chatManager;
    const session = this.chatSessionFor(wsInfo, data.sessionId);
    if (!manager || !session) return;

    const text = typeof data.text === 'string' ? data.text : '';
    if (!text.trim() && !(data.attachments || []).length) return;

    // The runtime's own `/model` reaches the same decision by the other door,
    // so it has to leave the same trace. Without this the command is forwarded
    // untouched, the conversation really does change model, and then the next
    // `/clear` restarts it on the model it opened with — the same silent
    // reversion the model picker was fixed for. Recorded, then forwarded
    // unchanged: the runtime still runs its own command, and whether it
    // accepted the name is still its answer to give, not ours.
    const typedModel = /^\/model[ \t]+(\S.*)$/.exec(text.trim());
    if (typedModel) {
      const model = normaliseModelName(typedModel[1]);
      if (model) {
        session.chatModelOverride = model;
        await this.deps.saveSessionsToDisk();
        manager.rememberModel(session.id, model);
      }
    }

    // And the same for a typed `/effort`, which claude answers itself. Recorded
    // for the same reason and forwarded just as unchanged: a level the user
    // typed is still the runtime's to accept or refuse, but if it accepts, the
    // next `/clear` must not put the conversation back where it started.
    const typedEffort = /^\/effort[ \t]+(\S+)\s*$/.exec(text.trim());
    if (typedEffort) {
      const effort = normaliseEffortLevel(typedEffort[1]);
      // Recorded only when the runtime published this level, which is a
      // narrower test than the one the model equivalent above applies — and it
      // has to be, because a runtime's slash command and its launch flag do not
      // accept the same words. Claude's `/effort` takes `auto` as well as the
      // six on its ladder, and `--effort auto` answers by warning on a stream
      // nobody reads and running at its default. So typing `/effort auto`
      // genuinely changes the running session, and storing it would have made
      // every launch after that one silently ignore the level while the chip
      // still claimed it. The published ladder is the only test that can tell
      // that case from `/effort ultracode`, which the flag does accept.
      //
      // The turn is forwarded either way. What the runtime does with a command
      // is the runtime's business; what this app is willing to *replay* is not.
      const ladder = effort
        ? ((await manager.snapshot(session).catch(() => null)) as {
            capabilities?: { efforts?: { value: string }[] };
          } | null)?.capabilities?.efforts
        : undefined;
      if (effort && ladder?.some((level) => level.value === effort)) {
        session.chatEffortOverride = effort;
        await this.deps.saveSessionsToDisk();
        manager.rememberEffort(session.id, effort);
      }
    }

    try {
      await manager.send(session.id, {
        text,
        attachments: Array.isArray(data.attachments) ? data.attachments : undefined,
      });
      session.lastActivity = new Date();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);

      // Not a connection failure, and not the whole app's problem: this one
      // session's process is gone, its transcript is intact, and there is
      // something the user can do about it. Reported as its own message so the
      // pane can say so and offer the choice, instead of the generic error
      // overlay covering a conversation with a Retry that cannot work.
      if (error instanceof ChatNotRunningError) {
        sendToWebSocket(wsInfo.ws, {
          type: 'chat_unavailable',
          sessionId: session.id,
          runtime: session.lastAgent || '',
          runtimeLabel: session.runtimeLabel || '',
          canResume: Boolean(session.nativeChatSessionId),
          message,
        });
        return;
      }

      sendToWebSocket(wsInfo.ws, { type: 'error', message });
    }
  }

  private async handleChatInterrupt(
    wsInfo: WebSocketInfo,
    data: IncomingMessage,
  ): Promise<void> {
    const manager = this.deps.chatManager;
    const session = this.chatSessionFor(wsInfo, data.sessionId);
    if (!manager || !session) return;
    await manager.interrupt(session.id).catch(() => undefined);
  }

  /**
   * Change the model for one conversation, independent of the runtime's own
   * default or the active profile.
   *
   * Never pre-validated: what a typed name actually does is only known by
   * trying it, so this always persists the choice and then reports what
   * happened, in order of how good an answer it is — live, best-effort sent as
   * a turn, or merely saved for the next launch. It is deliberately never
   * written back as a profile or personal default; the override belongs to
   * this conversation and nothing else.
   */
  private async handleChatSetModel(
    wsInfo: WebSocketInfo,
    data: IncomingMessage,
  ): Promise<void> {
    const session = this.chatSessionFor(wsInfo, data.sessionId);
    if (!session) return;

    const raw = typeof data.model === 'string' ? data.model.trim() : '';
    const model = raw ? normaliseModelName(raw) : undefined;
    session.chatModelOverride = model;
    await this.deps.saveSessionsToDisk();

    // A live session keeps the options it was launched with so that `/clear`
    // can restart the process in place. The model is the one thing in there
    // this handler can change, so it has to be carried across too — otherwise
    // the next `/clear` reinstates the model the conversation opened with,
    // after the browser has already been told the switch was applied. Resolved
    // the way a launch resolves it, so clearing lands on the profile default.
    const profile = this.deps.resolveRuntimeProfile(
      session.agent as AgentKind,
      session.workingDir,
    );
    this.deps.chatManager?.rememberModel(session.id, model || profile?.model);

    if (!model) {
      sendToWebSocket(wsInfo.ws, {
        type: 'chat_model_result',
        sessionId: session.id,
        model: null,
        applied: 'cleared',
        message: 'Cleared the model override. The next session for this conversation will use the runtime default.',
      });
      return;
    }

    const manager = this.deps.chatManager;
    if (!manager) {
      sendToWebSocket(wsInfo.ws, {
        type: 'chat_model_result',
        sessionId: session.id,
        model,
        applied: 'pending',
        message: `Saved. ${model} will be used the next time a session starts for this conversation.`,
      });
      return;
    }

    try {
      const applied = await manager.setModel(session.id, model);
      if (applied) {
        sendToWebSocket(wsInfo.ws, {
          type: 'chat_model_result',
          sessionId: session.id,
          model,
          applied: 'live',
          message: `Switched to ${model} for this conversation.`,
        });
        return;
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      sendToWebSocket(wsInfo.ws, {
        type: 'chat_model_result',
        sessionId: session.id,
        model,
        applied: 'pending',
        message: `Saved, but switching live failed (${message}). ${model} will be used the next time a session starts.`,
      });
      return;
    }

    // The adapter cannot switch live. If the runtime advertises its own
    // `/model` command, best-effort send it as an ordinary turn — the same
    // mechanism the old switchable picker used — and say so honestly: the
    // CLI's own reply is the real confirmation, not this message.
    const snapshot = await manager.snapshot(session).catch(() => null) as
      | { live?: boolean; capabilities?: { commands?: { name: string }[] } }
      | null;
    const live = snapshot?.live === true;
    const hasModelCommand = snapshot?.capabilities?.commands?.some((c) => c.name === 'model') ?? false;

    if (live && hasModelCommand) {
      try {
        await manager.send(session.id, { text: `/model ${model}` });
        sendToWebSocket(wsInfo.ws, {
          type: 'chat_model_result',
          sessionId: session.id,
          model,
          applied: 'sent',
          message: `Sent "/model ${model}" to the session — check the transcript to confirm it took.`,
        });
        return;
      } catch {
        // Falls through to the saved-for-next-time answer below.
      }
    }

    sendToWebSocket(wsInfo.ws, {
      type: 'chat_model_result',
      sessionId: session.id,
      model,
      applied: 'pending',
      message: `Saved. This runtime cannot change model mid-session — ${model} will be used the next time a new session starts for this conversation.`,
    });
  }

  /**
   * Change how hard the agent thinks, for one conversation.
   *
   * Shaped like the model handler and different from it in one deciding way:
   * this level *is* pre-validated. The control only ever offers what the running
   * runtime published, so a level that is not on that list did not come from the
   * control, and sending it on would be one of two bad outcomes — a runtime that
   * refuses it mid-turn, or pi, which prints a warning nobody sees and then
   * quietly runs at its default. Neither is a thing to find out about later.
   *
   * The ladder is only consulted when the session has actually published one.
   * Choosing a level before anything has launched is legitimate and lands in the
   * same saved-for-next-launch state a model choice does.
   */
  private async handleChatSetEffort(
    wsInfo: WebSocketInfo,
    data: IncomingMessage,
  ): Promise<void> {
    const session = this.chatSessionFor(wsInfo, data.sessionId);
    if (!session) return;

    const raw = typeof data.effort === 'string' ? data.effort.trim() : '';
    const effort = raw ? normaliseEffortLevel(raw) : undefined;
    const manager = this.deps.chatManager;

    const reply = (
      applied: 'live' | 'sent' | 'pending' | 'cleared' | 'refused',
      message: string,
      level: string | null,
    ): void => {
      sendToWebSocket(wsInfo.ws, {
        type: 'chat_effort_result',
        sessionId: session.id,
        effort: level,
        applied,
        message,
      });
    };

    // Nothing is stored on a refusal, so the conversation keeps running at
    // whatever it was already on rather than being moved somewhere neither the
    // user nor the runtime asked for.
    if (raw && !effort) {
      reply('refused', 'That is not a level any runtime here offers.', null);
      return;
    }

    const snapshot = manager
      ? ((await manager.snapshot(session).catch(() => null)) as {
          live?: boolean;
          capabilities?: { efforts?: { value: string }[]; commands?: { name: string }[] };
        } | null)
      : null;
    const ladder = snapshot?.capabilities?.efforts;

    if (effort && ladder?.length && !ladder.some((level) => level.value === effort)) {
      reply(
        'refused',
        `${session.agent} does not offer "${effort}". It accepts: ${ladder
          .map((level) => level.value)
          .join(', ')}.`,
        null,
      );
      return;
    }

    session.chatEffortOverride = effort;
    await this.deps.saveSessionsToDisk();
    // The same trap the model has, and the reason `rememberEffort` exists: a
    // `/clear` restarts the process in place from the options it was launched
    // with, so without this it would silently go back to the level the
    // conversation opened at after the browser was told the change was live.
    manager?.rememberEffort(session.id, effort);

    if (!effort) {
      reply(
        'cleared',
        'Back to the runtime’s own default. It applies from the next session for this conversation.',
        null,
      );
      return;
    }

    if (!manager) {
      reply('pending', `Saved. This conversation will run at ${effort} from its next session.`, effort);
      return;
    }

    try {
      if (await manager.setEffort(session.id, effort)) {
        reply('live', `Now thinking at ${effort}.`, effort);
        return;
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      reply(
        'pending',
        `Saved, but the running session would not take it (${message}). ${effort} applies from its next session.`,
        effort,
      );
      return;
    }

    // The adapter cannot change it on a live process. Where the runtime
    // advertises an `/effort` command of its own, send it as a turn and say so
    // honestly — the CLI's own reply in the transcript is the confirmation, not
    // this message. Claude is the one that answers this today, and it answers
    // for free; its adapter takes the direct road above, so this is the path a
    // future runtime with the command and no protocol for it will arrive on.
    const hasEffortCommand =
      snapshot?.capabilities?.commands?.some((command) => command.name === 'effort') ?? false;

    if (snapshot?.live === true && hasEffortCommand) {
      try {
        await manager.send(session.id, { text: `/effort ${effort}` });
        reply(
          'sent',
          `Sent "/effort ${effort}" to the session — the transcript will show whether it took.`,
          effort,
        );
        return;
      } catch {
        // Falls through to the saved-for-next-time answer below.
      }
    }

    reply(
      'pending',
      `Saved. This runtime cannot change how hard it thinks mid-session — ${effort} applies from its next session.`,
      effort,
    );
  }

  /**
   * Withdraw a turn the user typed ahead.
   *
   * Silent when the id is unknown: by the time a click arrives the turn may
   * already have started running, and the session's own `chat_queue` broadcast
   * has told every browser so. An error for that would be noise about a race
   * the user cannot lose in any way that matters.
   */
  private handleChatQueueCancel(wsInfo: WebSocketInfo, data: IncomingMessage): void {
    const manager = this.deps.chatManager;
    const session = this.chatSessionFor(wsInfo, data.sessionId);
    if (!manager || !session) return;

    const queuedId = typeof data.queuedId === 'string' ? data.queuedId : '';
    if (!queuedId) return;
    manager.cancelQueued(session.id, queuedId);
  }

  /**
   * Send a turn the user typed ahead, now, in front of whatever is running.
   *
   * Silent for the same reason the withdrawal above is: by the time the click
   * arrives that turn may already have started, and the session broadcasts the
   * queue on every change, so both browsers already agree on what is true. The
   * one thing that must not happen is a double delivery from a double click,
   * and that is settled in the session — the id leaves the queue before
   * anything is interrupted, so the second call finds nothing to promote.
   */
  private async handleChatQueueSendNow(
    wsInfo: WebSocketInfo,
    data: IncomingMessage,
  ): Promise<void> {
    const manager = this.deps.chatManager;
    const session = this.chatSessionFor(wsInfo, data.sessionId);
    if (!manager || !session) return;

    const queuedId = typeof data.queuedId === 'string' ? data.queuedId : '';
    if (!queuedId) return;
    await manager.sendQueuedNow(session.id, queuedId);
  }

  /**
   * Try a queued turn that could not be delivered again.
   *
   * Silent on an unknown id for the same reason as cancelling: the click races
   * the queue's own broadcast, and the session answers with the whole queue
   * either way.
   */
  private handleChatQueueRetry(wsInfo: WebSocketInfo, data: IncomingMessage): void {
    const manager = this.deps.chatManager;
    const session = this.chatSessionFor(wsInfo, data.sessionId);
    if (!manager || !session) return;

    const queuedId = typeof data.queuedId === 'string' ? data.queuedId : '';
    if (!queuedId) return;
    manager.retryQueued(session.id, queuedId);
  }

  private handleChatPermission(wsInfo: WebSocketInfo, data: IncomingMessage): void {
    const manager = this.deps.chatManager;
    const session = this.chatSessionFor(wsInfo, data.sessionId);
    if (!manager || !session) return;

    const requestId = typeof data.requestId === 'string' ? data.requestId : '';
    const optionId = typeof data.optionId === 'string' ? data.optionId : '';
    if (!requestId || !optionId) return;

    manager.respondPermission(session.id, requestId, optionId);
  }

  /**
   * Answer a multiple-choice question the model asked.
   *
   * Separate from the approval route rather than reusing it with a list: an
   * approval is one decision out of a set this app defines, and a question is an
   * arbitrary selection out of a set the model wrote. Routing both through one
   * handler would mean a browser could answer a question with an approval id.
   */
  private handleChatQuestion(wsInfo: WebSocketInfo, data: IncomingMessage): void {
    const manager = this.deps.chatManager;
    const session = this.chatSessionFor(wsInfo, data.sessionId);
    if (!manager || !session) return;

    const requestId = typeof data.requestId === 'string' ? data.requestId : '';
    if (!requestId) return;

    const optionIds = Array.isArray(data.optionIds)
      ? data.optionIds.filter((id): id is string => typeof id === 'string')
      : [];
    manager.answerQuestion(session.id, requestId, optionIds, data.skipped === true);
  }

  private async handleChatHistory(
    wsInfo: WebSocketInfo,
    data: IncomingMessage,
  ): Promise<void> {
    const manager = this.deps.chatManager;
    const session = this.chatSessionFor(wsInfo, data.sessionId);
    if (!manager || !session) return;

    const fromSeq = Math.max(0, Math.floor(Number(data.fromSeq) || 0));
    const count = Math.max(1, Math.floor(Number(data.count) || 200));

    try {
      const page = await manager.readPage(session, fromSeq, count);
      sendToWebSocket(wsInfo.ws, {
        type: 'chat_page',
        sessionId: session.id,
        requestId: data.requestId || null,
        ...page,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      // Answered on the chat channel too. A bare `error` leaves the requesting
      // tab's "loading earlier messages" spinner running against a reply that
      // is never coming, which is precisely the state it was stuck in.
      sendToWebSocket(wsInfo.ws, {
        type: 'chat_page_failed',
        sessionId: session.id,
        requestId: data.requestId || null,
        message,
      });
      sendToWebSocket(wsInfo.ws, { type: 'error', message });
    }
  }

  /**
   * The full turn index of one conversation.
   *
   * Answered from the recorded log, so the list is the same however much of the
   * conversation the asking browser has loaded (#86). A failure is answered on
   * the chat channel for the same reason a page failure is: the index shows a
   * spinner while it waits, and silence leaves it spinning forever.
   */
  private async handleChatTurnIndex(
    wsInfo: WebSocketInfo,
    data: IncomingMessage,
  ): Promise<void> {
    const manager = this.deps.chatManager;
    const session = this.chatSessionFor(wsInfo, data.sessionId);
    if (!manager || !session) return;

    try {
      const index = await manager.turnIndex(session);
      sendToWebSocket(wsInfo.ws, {
        type: 'chat_turn_index',
        sessionId: session.id,
        requestId: data.requestId || null,
        ...index,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      sendToWebSocket(wsInfo.ws, {
        type: 'chat_turn_index_failed',
        sessionId: session.id,
        requestId: data.requestId || null,
        message,
      });
    }
  }

  private async handleHistoryRequest(
    wsInfo: WebSocketInfo,
    data: IncomingMessage,
  ): Promise<void> {
    const sessionId = data.sessionId || wsInfo.claudeSessionId;
    if (!sessionId) {
      return;
    }

    const session = this.deps.claudeSessions.get(sessionId);
    if (!session || session.ownerUserId !== wsInfo.userId) {
      sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: 'Session not found',
      });
      return;
    }

    try {
      const page = await this.deps.historyStore.read(
        session,
        typeof data.fromLine === 'number' ? data.fromLine : 0,
        typeof data.count === 'number' ? data.count : 0,
      );

      sendToWebSocket(wsInfo.ws, {
        type: 'history_chunk',
        sessionId,
        requestId: data.requestId ?? null,
        ...page,
      });
    } catch (error) {
      console.error(`Failed to read history for session ${sessionId}:`, error);
      sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message: 'Failed to read session history',
      });
    }
  }

  private getRecorder(session: SessionRecord): ScrollbackRecorder {
    const existing = this.recorders.get(session.id);
    if (existing) {
      return existing;
    }

    const ref = { id: session.id, ownerUserId: session.ownerUserId };
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
  private retireRecorder(session: SessionRecord): void {
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
          { id: session.id, ownerUserId: session.ownerUserId },
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

  private getRuntimeLabel(agentKind: AgentKind, session: SessionRecord | null = null): string {
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
      case 'terminal':
        return session?.runtimeLabel || 'Terminal';
      case 'claude':
      default:
        return this.deps.aliases.claude;
    }
  }

  private getRuntimeErrorLabel(agentKind: AgentKind): string {
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
      case 'terminal':
        return 'terminal';
      case 'claude':
      default:
        return 'Claude Code';
    }
  }
}
