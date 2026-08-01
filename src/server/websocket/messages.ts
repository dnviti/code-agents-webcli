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
import { AccountTabCoordinatorLike } from '../services/account-tab-coordinator.js';
import {
  sendToWebSocket,
  broadcastChat,
  broadcastToSession,
  announceSessionActivity,
  announceSessionOpened,
} from './handler.js';
import { chatUnavailableReason, isChatRuntime } from '../../shared/chat-runtimes.js';
import {
  ChatDraft,
  ChatModelDefault,
  ChatModelOrigin,
  MAX_QUESTION_ANSWER_TEXT,
} from '../../shared/chat-events.js';
import { LadderRung, ModelTier, ResolvedProfile } from '../../shared/runtime-profiles.js';

/**
 * The rung a *running* session is actually on, told as an origin.
 *
 * Null when nothing is running, or when what is running is not on a rung. The
 * profile is only consulted for the name to put on it.
 */
function ladderOf(
  manager: ChatManagerLike,
  sessionId: string,
  profile: ResolvedProfile | null,
): ChatModelOrigin | null {
  const rung = manager.ladderOf?.(sessionId);
  if (!rung) return null;
  // Which rung is running is the session's to answer; which rung was *asked
  // for* is only ever the profile's, because falling to the nearest filled one
  // happens while the profile is being resolved and the session is handed the
  // answer rather than the question. Grafted on only while the two still
  // describe the same resolution, so a conversation moved to another rung since
  // does not inherit an explanation that belongs to a rung it left.
  const requested =
    profile?.ladder?.requested && profile.ladder.tier === rung.tier
      ? profile.ladder.requested
      : undefined;
  return ladderOrigin(requested ? { ...rung, requested } : rung, profile);
}

/** One rung, told as an origin — the same three facts, said the way the UI reads them. */
function ladderOrigin(rung: LadderRung, profile: ResolvedProfile | null): ChatModelOrigin {
  return {
    model: rung.model,
    source: 'ladder',
    ...(profile?.profileName ? { profileName: profile.profileName } : {}),
    tier: rung.tier,
    ...(rung.requested ? { requestedTier: rung.requested } : {}),
  };
}
import { applyDraft, clearDraft, draftOf, readDraft } from '../chat/drafts.js';
import { UserPreferences, resolveApprovalMode } from '../../shared/user-preferences.js';
import { ChatNotRunningError } from '../chat/session.js';
import { UserEnvironment } from '../services/environments/types.js';
import { HostEnvironment } from '../services/environments/manager.js';

/**
 * The longest model name worth storing. Real ones are far shorter; this only
 * has to stop an unbounded string from being persisted and then handed to a
 * spawn on every future launch of the conversation.
 */
const MAX_MODEL_NAME = 200;

/**
 * How often a working session says so to the screens that are not attached to it.
 *
 * Not a latency budget: the tab strip calls a session quiet after ninety
 * seconds without a sign of life, so anything comfortably under that keeps
 * every screen agreeing. A second is the point where the announcement costs
 * nothing measurable next to the output it stands in for.
 */
const ACTIVITY_ANNOUNCE_MS = 1000;

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
  validatePath(targetPath: string, userId?: number): PathValidation;
  /**
   * The root this user's paths are measured against; their own home with
   * per-user environments on.
   *
   * Optional, and falling back to `baseFolder`: a deployment (or a test) that
   * does not know about environments must keep behaving exactly as it did,
   * which is the same promise the feature flag makes.
   */
  getUserBaseFolder?(userId?: number): string;
  /** Prepare (creating or starting if needed) the environment a user's processes run in. */
  ensureEnvironment?(userId?: number): Promise<UserEnvironment>;
  getSelectedWorkingDir(userId: number): string | null;
  createSessionRecord(params: {
    id: string;
    ownerUserId: number;
    name?: string;
    workingDir: string;
    connections?: string[];
  }): SessionRecord;
  /** Shared with HTTP tab routes so creation cannot cross a tentative close/reorder. */
  tabCoordinator?: AccountTabCoordinatorLike;
  getRuntimeBridge(agentKind: AgentKind): BridgeInterface | null;
  saveSessionsToDisk(): Promise<boolean | void>;
  /**
   * Launch configuration for this runtime, already resolved from the active
   * profile: model, extra args and environment. Returns null when no profile
   * is active, which is the default and must stay a plain unmodified launch.
   */
  resolveRuntimeProfile(agentKind: AgentKind, workingDir: string): ResolvedProfile | null;
  /**
   * The active profile for a runtime, read without writing anything.
   *
   * The read-only twin of `resolveRuntimeProfile`, which is not side-effect
   * free: it writes the profile's tier files to disk so they exist before the
   * process starts. Naming the profile on a *join* is a question, not a launch,
   * and asking it through the other accessor would rewrite a runtime's config
   * every time a browser opened a tab.
   */
  activeProfileFor?(runtime: string): ResolvedProfile | null;
  /**
   * This account's standing model choice for a runtime, and the write that
   * records one. `null` from the setter forgets it.
   *
   * On the server rather than in the browser, which is where the effort
   * preference lives, and the difference is not taste: claude, codex and pi fix
   * the model when the process is spawned, so a browser-held default could only
   * ever be sent *after* the launch — on claude that is a visible `/model` turn
   * pushed into a conversation nobody has typed in yet, and on the other two a
   * "will be used next time" that this conversation never reaches. The store
   * namespaces its keys by user id, so isolation is a property of the key
   * rather than of a filter someone has to remember to write.
   *
   * Optional, like `chatManager` above and for the same reason: without them
   * the chain is exactly what it always was — the conversation's own override,
   * then the profile, then the runtime's own default.
   */
  getUserModelDefault?(userId: number, runtime: string): string | null;
  setUserModelDefault?(userId: number, runtime: string, model: string | null): void;
  /**
   * The owner's standing preferences, for the one decision that reads them: the
   * approval mode a conversation begins in.
   *
   * Optional so a server — or a test — built without it keeps working; absent
   * means no preference could be read, which the rule treats as "ask", the same
   * as every other unreadable answer.
   */
  getUserPreferences?(userId: number): UserPreferences;
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
      /** Where the runtime runs; absent means this host. */
      environment?: UserEnvironment;
      /** The rung this conversation runs on, and the ladder it can move up. */
      ladder?: { tier: ModelTier; tiers: Partial<Record<ModelTier, string>> };
    },
  ): Promise<{ runtimeKind: string; currentCapabilities: unknown; bypassing: boolean }>;
  /**
   * The transcript, forwarded whole. `live` is the one field this layer reads
   * for itself — whether a process is answering right now — because a join has
   * to say what is in force and the record's own `active` flag is not the same
   * question: it survives an adapter that died through its error path, and it
   * is cleared by a probe abandoned in favour of a fallback that is running.
   */
  snapshot(record: SessionRecord): Promise<{ live?: boolean }>;
  send(sessionId: string, turn: { text: string; attachments?: unknown[] }): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  /** Switch a live session's model. False when nothing is running, or the adapter cannot. */
  setModel(sessionId: string, model: string): Promise<boolean>;
  /** Carry a new model into the options an in-place `/clear` restart replays. */
  rememberModel(sessionId: string, model: string | undefined): void;
  /** The rung a running session is on, or null when it is not on one. */
  ladderOf?(sessionId: string): LadderRung | null;
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
    text?: string,
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
  /**
   * The one free-text field a frame carries: a turn on `chat_send`, and what
   * the user typed in their own words on `chat_question_answer`. Shared rather
   * than split in two, because the handler that reads it knows which message it
   * is holding and a second name would only be the same string twice.
   */
  text?: string;
  attachments?: unknown[];
  /**
   * Whether this turn is the composer being emptied, rather than a turn from
   * the transcript being asked again.
   *
   * Only the first empties the conversation's shared draft. Absent on every
   * frame from a page that predates the shared composer, which then behaves
   * exactly as it did: nothing to clear, because nothing was being shared.
   */
  fromComposer?: boolean;
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
  private activityAnnounced = new Map<string, number>();

  constructor(deps: MessageProcessorDeps) {
    this.deps = deps;
  }

  /**
   * Say "this session is working", at most once a second.
   *
   * The clock is only ever read here, so a session that goes quiet simply stops
   * being announced; nothing has to be cancelled and nothing fires late.
   */
  private noteActivity(session: SessionRecord): void {
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
  private noteStopped(session: SessionRecord): void {
    this.activityAnnounced.delete(session.id);
    announceSessionActivity(session, false, this.deps.webSocketConnections);
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
        await this.leaveSession(wsId, data.sessionId);
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

      case 'start_antigravity':
        await this.startRuntime(wsId, 'antigravity', data.options || {});
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

      case 'chat_draft':
        this.handleChatDraft(wsInfo, data);
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

  /** The user's own root, or the single shared one when environments are off. */
  private userBaseFolder(userId?: number): string {
    return this.deps.getUserBaseFolder?.(userId) ?? this.deps.baseFolder;
  }

  /** The environment a user's processes run in; this host when there are none. */
  private async userEnvironment(userId?: number): Promise<UserEnvironment> {
    return this.deps.ensureEnvironment
      ? this.deps.ensureEnvironment(userId)
      : new HostEnvironment(this.deps.baseFolder);
  }

  async createAndJoinSession(
    wsId: string,
    name?: string,
    workingDir?: string
  ): Promise<void> {
    const wsInfo = this.deps.webSocketConnections.get(wsId);
    if (!wsInfo) return;
    const requestedFromSessionId = wsInfo.claudeSessionId;

    let validWorkingDir = this.userBaseFolder(wsInfo.userId);
    if (workingDir) {
      const validation = this.deps.validatePath(workingDir, wsInfo.userId);
      if (!validation.valid) {
        sendToWebSocket(wsInfo.ws, {
          type: 'error',
          message: 'Cannot create session with working directory outside the allowed area',
        });
        return;
      }
      validWorkingDir = validation.path!;
    } else {
      const selected = this.deps.getSelectedWorkingDir(wsInfo.userId);
      // A directory chosen before per-user environments were switched on can
      // point outside the user's own home; re-checked here rather than trusted,
      // so enabling the feature cannot leave anyone pointed at the host.
      validWorkingDir = selected && this.deps.validatePath(selected, wsInfo.userId).valid
        ? selected
        : this.userBaseFolder(wsInfo.userId);
    }

    const release = this.deps.tabCoordinator
      ? await this.deps.tabCoordinator.acquire(wsInfo.userId)
      : () => {};
    try {
      // Waiting behind an account write gives this socket time to disconnect or
      // choose a newer destination. A delayed create must not overwrite that
      // newer join (nor create an unattached session for a dead socket).
      const currentInfo = this.deps.webSocketConnections.get(wsId);
      if (currentInfo !== wsInfo || wsInfo.claudeSessionId !== requestedFromSessionId) return;

      const sessionId = randomUUID();
      // Construct inside the account turn: the real factory allocates the
      // append position from the live map, which is now guaranteed committed.
      const session = this.deps.createSessionRecord({
        id: sessionId,
        ownerUserId: wsInfo.userId,
        name,
        workingDir: validWorkingDir,
      });

      this.deps.claudeSessions.set(sessionId, session);
      let saved = false;
      try {
        saved = (await this.deps.saveSessionsToDisk()) !== false;
      } catch (error) {
        console.error('Failed to persist socket-created session:', error);
      }
      if (!saved) {
        this.deps.claudeSessions.delete(sessionId);
        sendToWebSocket(wsInfo.ws, {
          type: 'error',
          message: 'The new session could not be saved',
        });
        return;
      }

      void this.deps.transcriptStore.ensureTranscript(session);
      // Persistence itself can be deferred. Recheck once more before attaching:
      // a newer join that won while SQLite was pending must stay the destination.
      const intentStillCurrent =
        this.deps.webSocketConnections.get(wsId) === wsInfo
        && wsInfo.claudeSessionId === requestedFromSessionId;
      if (intentStillCurrent) {
        session.connections.add(wsId);
        wsInfo.claudeSessionId = sessionId;
        sendToWebSocket(wsInfo.ws, {
          type: 'session_created',
          sessionId,
          sessionName: session.name,
          workingDir: session.workingDir,
          lastAgent: session.lastAgent,
          runtimeLabel: session.runtimeLabel,
        });
      }

      // And every other screen this person has open. After `session_created`,
      // so the asking socket has switched before the account announcement. If
      // it moved meanwhile, this is deliberately the only message it receives:
      // the new tab still exists account-wide but never steals that newer focus.
      announceSessionOpened(session, this.deps.webSocketConnections);
    } finally {
      release();
    }
  }

  async joinSession(wsId: string, claudeSessionId: string): Promise<void> {
    const wsInfo = this.deps.webSocketConnections.get(wsId);
    if (!wsInfo) return;

    const session = this.deps.claudeSessions.get(claudeSessionId);
    if (!session || session.ownerUserId !== wsInfo.userId) {
      // Named rather than reported as a generic error, because the client can
      // only act on the specific answer. An `error` says nothing about *which*
      // session failed, so the page attributed it to the session it was still
      // on — painting a healthy tab red for a click on a dead one, and leaving
      // the dead tab in the strip to do it again. `session_gone` says which,
      // and the tab goes.
      //
      // The same answer for a session that belongs to somebody else: as far as
      // this user is concerned there is no such session, and saying more would
      // be telling them one exists.
      sendToWebSocket(wsInfo.ws, {
        type: 'session_gone',
        sessionId: claudeSessionId,
        message: 'This session no longer exists.',
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

    // Joins for one socket can overlap because WebSocket message callbacks are
    // async. If a newer join won while transcript/history reads were awaited,
    // this answer is obsolete: emitting it would paint the old destination and
    // prompt the client to leave the newer one as an "orphan".
    if (wsInfo.claudeSessionId !== claudeSessionId || !session.connections.has(wsId)) return;

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

  async leaveSession(wsId: string, expectedSessionId?: string): Promise<void> {
    const wsInfo = this.deps.webSocketConnections.get(wsId);
    if (!wsInfo || !wsInfo.claudeSessionId) return;
    // A client rejecting a late join names the obsolete destination. If the
    // socket has already joined something newer, that cleanup must not detach
    // the winner.
    if (expectedSessionId && wsInfo.claudeSessionId !== expectedSessionId) return;

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
    session.runId = runId;

    // A session created before per-user environments were switched on points at
    // a folder on the host, which this user's environment cannot see. Moved to
    // their own root rather than refused: the alternative is a tab that can
    // never be started again and no way to say why from inside it.
    if (!this.deps.validatePath(session.workingDir, wsInfo.userId).valid) {
      session.workingDir = this.userBaseFolder(wsInfo.userId);
    }

    // Prepared before the pty, not alongside it: creating a container takes a
    // moment the first time, and a bridge started against an environment that
    // is not up yet fails with an engine error the user cannot act on.
    let environment;
    try {
      environment = await this.userEnvironment(wsInfo.userId);
    } catch {
      session.runId = previousRunId;
      sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message:
          'Your workspace environment could not be started. '
          + 'Ask an administrator to check the container engine on the server.',
      });
      return;
    }

    try {
      const runtimeSession = (await bridge.startSession(sessionId, {
        ...safeOptions,
        environment,
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
          currentSession.active = false;
          currentSession.agent = null;
          currentSession.stopRequested = false;
          currentSession.lastActivity = new Date();

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
          currentSession.active = false;
          currentSession.agent = null;
          currentSession.stopRequested = false;
          currentSession.lastActivity = new Date();

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
   * Which model a *new* conversation on this runtime would open on, and why.
   *
   * Three layers, in this order: the account's own standing choice, a model
   * typed into the active profile, then that profile's ladder rung. The personal
   * one wins because a per-conversation override has always outranked the
   * profile (see the launch below), so a profile was never a pin an installer
   * could stop a user escaping — and because the only ordering under which the
   * picker's "Use the default for this runtime" entry does anything is one where
   * the thing it clears is above the profile.
   *
   * The rung sits *below* the typed model, which #171 asks for in as many
   * words: a ladder is what answers when nobody typed anything. Both of the
   * layers above it are reported by name so the dialog can say which one is
   * overriding a ladder somebody configured and cannot see working.
   *
   * Re-normalised on the way out. What comes back is a database row, and a
   * hand-edited one must not become an argv on every future launch.
   *
   * `profile` is passed in rather than looked up: a launch has already resolved
   * it (through the accessor that writes tier files, which it must), and a join
   * resolves it through the read-only one. Same answer, two different costs.
   */
  private modelDefaultFor(
    runtime: string | null,
    userId: number,
    profile: ResolvedProfile | null,
  ): ChatModelDefault {
    const stored = runtime ? this.deps.getUserModelDefault?.(userId, runtime) || '' : '';
    const personal = stored ? normaliseModelName(stored) : undefined;
    if (personal) return { model: personal, source: 'personal' };
    if (profile?.model) {
      return { model: profile.model, source: 'profile', profileName: profile.profileName };
    }
    if (profile?.ladder) {
      return {
        model: profile.ladder.model,
        source: 'ladder',
        profileName: profile.profileName,
        tier: profile.ladder.tier,
        ...(profile.ladder.requested ? { requestedTier: profile.ladder.requested } : {}),
      };
    }
    return { model: null, source: 'runtime' };
  }

  /**
   * Has this conversation ever actually been a conversation?
   *
   * `sessionStartTime` alone is not the test, and getting that wrong is a real
   * failure rather than a nicety: the terminal launch path sets it too, so a
   * session whose first run was a shell command would have its first *chat*
   * treated as a continuation and silently skip the account's default. The
   * surface is what says which kind of run it was, and it is only ever set to
   * 'chat' by the launch below.
   *
   * Both halves are needed. A chat launch that failed leaves the surface on
   * 'chat' with no start time behind it — the retry is still this
   * conversation's first, and must still take the user's default.
   */
  private hasNeverChatted(session: SessionRecord): boolean {
    return session.surface !== 'chat' || !session.sessionStartTime;
  }

  /**
   * Remember, or forget, this account's standing model for a runtime.
   *
   * Only from a name the runtime is known to take. A model is free text —
   * nothing here can pre-judge one, and that is deliberate — but the cost of a
   * typo is different once the name outlives the conversation it was typed in:
   * an override lasts until the next pick, a standing default becomes
   * `--model <typo>` on every new chat for that runtime until somebody finds
   * the entry that clears it. So the evidence has to be positive: either the
   * adapter took the switch live, or the name is on the list the session
   * published. A runtime that published no list at all is recorded from — there
   * is nothing to check against, exactly as the effort handler treats a runtime
   * that published no ladder, and claude publishes no model list at all.
   *
   * The clear is unconditional: forgetting takes no evidence.
   */
  private async rememberUserModel(
    session: SessionRecord,
    model: string | undefined,
    appliedLive: boolean,
  ): Promise<void> {
    const write = this.deps.setUserModelDefault;
    const runtime = session.agent || session.lastAgent;
    if (!write || !runtime) return;

    if (!model) {
      // Clearing an override in one chat also drops the standing default, which
      // is what makes "Use the default for this runtime" mean what it says: the
      // conversation, and every new one after it, falls back to the profile and
      // then to the runtime's own default. Nothing else in the app can undo a
      // standing choice, so this entry has to be able to.
      write(session.ownerUserId, runtime, null);
      return;
    }

    if (!appliedLive) {
      const published = (await this.deps.chatManager?.snapshot(session).catch(() => null)) as
        | { capabilities?: { models?: { value: string; name: string }[] } }
        | null;
      const listed = published?.capabilities?.models;
      if (listed?.length && !listed.some((m) => m.value === model || m.name === model)) return;
    }

    write(session.ownerUserId, runtime, model);
  }

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

    // Nothing that shapes the launch is taken from the browser any more. Model,
    // arguments and environment come from the server-side profile below, for the
    // same reason they do on the terminal path — a client must not be able to
    // forge a launch configuration — and since #134 the approval mode comes from
    // the owner's stored preference rather than from a flag the page sends. The
    // one thing still honoured from the browser is a `false`, because narrowing
    // is safe from anywhere.
    //
    // Two ways to relaunch a chat whose process is gone, and the difference is
    // the whole point of the choice the user is offered: resume hands the agent
    // back its own context, so the conversation on screen is one it remembers;
    // without it the transcript stays but the agent is new to it.
    const resumeSessionId =
      options.resume === true ? session.nativeChatSessionId : undefined;
    // Only when the browser said so: see ChatSessionStartOptions.startFresh.
    const startFresh = options.resume === false;

    // The rule, and it is decided by the route rather than by what happens to be
    // on the record: only `resume: true` continues a conversation, and every
    // other way in — a first launch, a branch, a start-over — begins one. A
    // conversation that is beginning takes the owner's preference; one that is
    // continuing replays its own recorded grant and re-reads nothing.
    //
    // Keying on the record instead ("has this ever been granted anything?") is
    // the trap: every launched conversation carries a grant, so *Start a new
    // chat* would inherit the bypass of the conversation it had just abandoned.
    //
    // The preference is read for the record's owner, which is also the socket's
    // user — the ownership check above refuses anything else — so one account's
    // preference can never decide another's conversation.
    const bypassPermissions = resolveApprovalMode({
      beginning: options.resume !== true,
      granted: session.chatBypassPermissions,
      preference: this.deps.getUserPreferences?.(session.ownerUserId).chatBypassPermissions,
      explicit: options.dangerouslySkipPermissions === false ? false : undefined,
    });

    const profile = this.deps.resolveRuntimeProfile(
      agentKind as AgentKind,
      session.workingDir,
    );
    const modelDefault = this.modelDefaultFor(agentKind, wsInfo.userId, profile);
    // Read before `surface` is set below, because that is half of what it reads.
    //
    // A standing preference is for opening the *next* conversation, never for
    // reaching back into one already under way. The pin below is what enforces
    // that for every conversation launched since #135; this remains the answer
    // for the ones that predate it, whose records carry no pin at all and which
    // must keep falling to the profile rather than picking up a default they
    // were never launched on.
    const seedFromAccount = this.hasNeverChatted(session);

    // A model name is only ever the vocabulary of the runtime that took it, so
    // a pin left by another runtime is not a fact about this launch. Keyed on
    // `lastAgent`, not `agent`: `agent` is null on every record restored from
    // disk, and a server restart is precisely when conversations are relaunched.
    if (session.lastAgent && session.lastAgent !== agentKind) {
      session.chatModelPinned = undefined;
    }

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

    if (!this.deps.validatePath(session.workingDir, session.ownerUserId).valid) {
      // Same reasoning as the pty path above.
      session.workingDir = this.userBaseFolder(session.ownerUserId);
    }

    let chatEnvironment;
    try {
      chatEnvironment = await this.userEnvironment(session.ownerUserId);
    } catch {
      sendToWebSocket(wsInfo.ws, {
        type: 'error',
        message:
          'Your workspace environment could not be started. '
          + 'Ask an administrator to check the container engine on the server.',
      });
      return;
    }

    /**
     * Which model this launch actually uses — resolved once, because the record
     * has to be told what it was.
     *
     * The conversation's own choice first. Then whatever it is already fixed to,
     * which is the whole guarantee: a relaunch, a resume from the launcher and
     * the recovery banner's restart are continuations, and a continuation must
     * not be re-modelled by a standing choice or a profile that changed
     * somewhere else since. A branch arrives here already pinned to its source's
     * model, so it opens on the model its carried history was measured against.
     *
     * Only a conversation with no pin at all reaches a default: the account's
     * standing choice if it has never chatted, and otherwise — a record written
     * before pins existed — the profile, exactly as before #135.
     *
     * `pinned === undefined` is "nothing recorded"; a recorded `null` is the
     * answer "it launched with no flag", and it has to outrank the *profile* or
     * a profile configured mid-conversation would retcon a conversation that had
     * deliberately run bare. That is why this is not a chain of `||`.
     *
     * The ladder is the one thing a `null` pin does not outrank, and #171 asks
     * for that in as many words: "conversations that predate this change move
     * onto the ladder the next time they are relaunched". Every one of them
     * carries `null`, so honouring it here would mean the ladder never reached a
     * single conversation that existed before the upgrade. The exception is
     * narrow — it is only the rung, never `profile.model`, so the guarantee
     * #135 bought is intact — and it cannot misfire afterwards: once a laddered
     * runtime is launched, the rung *is* the model, so a fresh `null` pin can
     * only be recorded for a profile that has no ladder to fall to.
     */
    const pinned = session.chatModelPinned;
    const ladder = profile?.ladder ?? null;

    // The chain, resolved to a model *and* the layer that supplied it in one
    // pass. Deriving the layer afterwards by comparing the answer to each
    // candidate reads well and is wrong twice over: a pin that happens to equal
    // the current rung is credited to the ladder — and then not pinned, so a
    // string coincidence quietly enrolls a conversation in every future ladder
    // edit — and a pin that matches nothing is credited to an override the user
    // never made, which the picker renders as "chosen for this conversation
    // only" with no way to clear it.
    let decided: ChatModelOrigin;
    if (session.chatModelOverride) {
      decided = { model: session.chatModelOverride, source: 'override' };
    } else if (pinned) {
      // A continuation. It is on this model because it launched on it, whatever
      // the layers below would say today.
      decided = { model: pinned, source: 'override' };
    } else if (pinned === null && ladder) {
      decided = ladderOrigin(ladder, profile);
    } else if (pinned === null) {
      decided = { model: null, source: 'runtime' };
    } else if (seedFromAccount && modelDefault.model) {
      decided = { ...modelDefault };
    } else if (profile?.model) {
      decided = { model: profile.model, source: 'profile', profileName: profile.profileName };
    } else if (ladder) {
      decided = ladderOrigin(ladder, profile);
    } else {
      decided = { model: null, source: 'runtime' };
    }

    // Not const: a rung the provider refuses is retried bare below, and what
    // the record and the browser are told has to be what actually started.
    let launchModel = decided.model || undefined;
    let modelOrigin = decided;
    let ladderError = profile?.ladderError ?? null;

    try {
      const startWith = async (model: string | undefined) => manager.start(session, {
        runtime: agentKind,
        environment: chatEnvironment,
        workingDir: session.workingDir,
        model,
        // No profile fallback behind it: profiles are server-wide and keyed by
        // runtime, and an effort level is a per-conversation decision that has
        // never had a profile default to fall back to. Absent means the runtime
        // gets no flag at all and uses whatever it considers normal.
        effort: session.chatEffortOverride,
        extraArgs: profile?.extraArgs,
        env: profile?.env,
        // Only when the rung is what this conversation is actually running on.
        // A profile-typed model or an account's standing choice outranks the
        // ladder, and offering an escalation from a rung nobody is on would ask
        // the user to approve a move that changes nothing they can see.
        ladder:
          modelOrigin.source === 'ladder' && profile?.ladder && profile.tiers
            ? { tier: profile.ladder.tier, tiers: profile.tiers }
            : undefined,
        bypassPermissions,
        resumeSessionId,
        startFresh,
      });

      let chat;
      try {
        chat = await startWith(launchModel);
      } catch (error: unknown) {
        // A rung whose model the provider will not serve — retired, not on this
        // account's plan, spelled for a gateway this install is not pointed at.
        // The conversation carries on at the runtime's own default rather than
        // refusing to open, and says which of the two it is on. Only for the
        // ladder: a model somebody typed in themselves is a request to make,
        // and quietly starting on a different one would answer their question
        // wrongly rather than not at all.
        if (modelOrigin.source !== 'ladder') throw error;
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`runtime profiles: ${agentKind} refused ${launchModel}: ${message}`);
        // Corrected *before* the retry, not after it. `startWith` reads the
        // origin to decide whether to install the ladder on the session, so a
        // retry launched while it still said 'ladder' put the conversation on a
        // rung it had just been refused: the escalation tool would be offered
        // from a rung nobody is on, and a browser rejoining would be told by
        // `ladderOf` that it is running the very model the provider would not
        // serve — contradicting the launch, which said the opposite.
        launchModel = undefined;
        modelOrigin = { model: null, source: 'runtime' };
        ladderError =
          `${agentKind} would not start on the ${profile?.ladder?.tier} rung’s model `
          + `(${message.trim()}), so this conversation is on its own default instead.`;
        chat = await startWith(undefined);
      }

      session.active = true;
      session.stopRequested = false;
      session.sessionStartTime = session.sessionStartTime || new Date();
      // Recorded on the record, not just handed to the process: the process is
      // the thing that will be gone when this has to be answered again. After
      // the launch rather than before it, so a bypass that never actually ran
      // does not become the standing answer for the next attempt — persisting a
      // permission has to follow from a conversation that really started in it.
      //
      // A real boolean either way, never `undefined`: "this conversation was
      // granted approvals" is a decision the record has to be able to hold, or
      // a preference switched on afterwards would silently widen a conversation
      // that had already chosen to ask.
      session.chatBypassPermissions = chat.bypassing === true;
      // And what it launched on, for the same reason and on the same terms: the
      // answer has to survive the process that is about to hold it. After the
      // launch, so a model that never actually started does not become the one
      // this conversation is fixed to. `null` rather than absent when there was
      // no flag — "the runtime's own default" is an answer, and it is the one a
      // profile added later must not be allowed to overwrite.
      //
      // A rung is deliberately *not* pinned. The pin exists so an unrelated
      // profile edit cannot re-model a conversation already under way, but the
      // rung is not an unrelated edit — it is the profile's standing answer to
      // the question "which model runs this conversation", and #171 asks for a
      // changed ladder to reach conversations that are already open. Recording
      // `null` leaves the rung to be re-read on every relaunch, which is the
      // same thing one restart later.
      session.chatModelPinned = modelOrigin.source === 'ladder' ? null : launchModel ?? null;
      // Beside it, and for the same reason: the browser that asked for the
      // launch is told this in `chat_started`, and every other screen — a
      // reload, a reconnect, a second tab — arrives at a `chat_snapshot`
      // instead. Without it on the record the badge saying the ladder is not
      // applied lasts exactly as long as the tab that watched it start.
      session.chatLadderError = ladderError;

      // Before the broadcast, so the socket that asked for the launch is
      // already a watcher when the very first event goes out.
      wsInfo.chatSessionIds.add(session.id);

      // The session already existed as a terminal on every other screen — this
      // is where it becomes a conversation, and a screen that still thinks it is
      // a terminal never subscribes to its events, so the tab sits there frozen
      // at whatever it looked like when it was one. Re-announced rather than
      // given its own message: "here is a session, and here is what it is" is
      // one fact, and the client already folds a repeat into the tab it has.
      announceSessionOpened(session, this.deps.webSocketConnections);

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
          // What this conversation is actually running on, when nothing the user
          // chose and nothing the runtime says can answer that. On claude the
          // runtime never reports a model at all, so without this the chip has
          // only the *default* to fall back on — and a default is not a fact
          // about this conversation, which is how the chip came to name a
          // standing choice that had never been applied to it (#135).
          modelPinned: launchModel ?? null,
          // What a new conversation on this runtime would open on, so the
          // picker can say where the model came from instead of leaving a
          // profile-pinned default indistinguishable from no default at all.
          modelDefault,
          // And where *this* conversation's model came from, which is a
          // different question the moment a ladder can answer either one.
          modelOrigin,
          // Said rather than swallowed: a ladder that could not be written
          // through has not configured the delegated helpers, so a conversation
          // that reported the rung anyway would be claiming half a feature.
          ladderError,
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
      const runtime = session.agent || session.lastAgent;
      const active = this.deps.activeProfileFor?.(runtime || '') ?? null;
      const modelDefault = this.modelDefaultFor(runtime, session.ownerUserId, active);
      sendToWebSocket(wsInfo.ws, {
        type: 'chat_snapshot',
        sessionId,
        snapshot,
        modelOverride: session.chatModelOverride || null,
        // The model this conversation is fixed to, from the record rather than
        // from the process: a reload is exactly the case where the runtime has
        // reported nothing to this browser yet, and it is the case in which the
        // chip used to fall through to a default it was never launched on.
        // `undefined` — a conversation that has not launched since pins existed
        // — goes out as null, so the client reads it as "unsaid" and degrades to
        // the wording that shipped before rather than asserting a model.
        modelPinned: session.chatModelPinned ?? null,
        // Re-sent on every join, because it is the only thing on the wire that
        // can tell the picker why a model is in force. Resolved through the
        // read-only profile accessor — see the dep — since a join must not
        // rewrite a runtime's tier files.
        modelDefault,
        // And where the model this conversation is on came from, which a join
        // has to answer from the record: the process may be gone, and a rung is
        // exactly the kind of provenance no runtime reports about itself.
        //
        // A pin of `null` under a laddered profile is the rung — that is what
        // the launch records for one, so it can be re-read — and the origin has
        // to reach the same conclusion the next launch will, or a reload would
        // rename the model between one screen and the next.
        //
        // The rung comes from the *running* session rather than from the
        // profile, and that distinction is the whole of #135 said again: a
        // conversation that launched bare also carries a null pin, so reading
        // the profile's current rung here would draw the chip as running a model
        // the process is not on. A session that is not running has no rung in
        // force to report, and says nothing rather than guessing one.
        //
        // Which is why the last branch is gated on the conversation being live.
        // A null pin says "launched with no model flag" and nothing more: under
        // a ladder that is what a rung records, so the two are indistinguishable
        // once the process is gone. While it runs they are not — a rung answers
        // through `ladderOf` above and never reaches here — but a stopped
        // laddered conversation would otherwise be announced as running on the
        // runtime's own default, which is a different model from the one it was
        // on and from the one its next launch will use. A conversation whose
        // model was chosen, or which is pinned to one, is still answered for
        // when it is not running: those are facts the record holds outright.
        //
        // The snapshot's own liveness, not `session.active`. They disagree in
        // both directions and the snapshot is the half that agrees with
        // `ladderOf`, since both read the chat session: a process that died
        // through the adapter's error path never reports `exited`, so the
        // record still calls it active, and codex's abandoned handshake probe
        // reports one for a conversation whose fallback is running fine.
        modelOrigin: ladderOf(manager, sessionId, active)
          ?? (session.chatModelOverride
            ? { model: session.chatModelOverride, source: 'override' }
            : session.chatModelPinned
              ? { model: session.chatModelPinned, source: 'override' }
              : session.chatModelPinned === null && snapshot.live
                ? { model: null, source: 'runtime' }
                : null),
        // The same answer the launch gave, for a screen that was not there for
        // it. A conversation that has launched under this server speaks for
        // itself — including when it has nothing to report, which is why this
        // tests for `undefined` rather than falsiness: a clean launch under a
        // profile that has failed to write since must not inherit a failure
        // that was not its own. One that has not launched here falls back to
        // the profile, which is the same answer its next launch would give.
        ladderError:
          session.chatLadderError !== undefined
            ? session.chatLadderError
            : active?.ladderError ?? null,
        // Rides on the join for the same reason the model does: the snapshot
        // carries the runtime's own reported level only if it ever reported one,
        // and a conversation whose process has since died reports nothing at
        // all. The record is the only thing that still knows what was chosen.
        effortOverride: session.chatEffortOverride || null,
        // What is in the composer, so a screen that has just opened this
        // conversation opens it at the sentence the other screen is in the
        // middle of. Null means nothing has been typed since the server came
        // up, which is what tells the joining browser it may keep the copy it
        // has in session storage rather than being cleared by a server that
        // simply has not heard yet.
        draft: draftOf(session),
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

  /**
   * Take one screen's composer as the conversation's, and tell the others.
   *
   * Routed through `broadcastChat` rather than `sendToUser`, so it follows the
   * conversation: a person may have six tabs open and only some of them are
   * looking at this chat, and the ones that are not have no composer to put it
   * in. Everyone watching gets it, including the screen it came from — which is
   * how that screen learns the revision its own edit was given, and why the
   * origin rides along for it to recognise itself by.
   *
   * Silent on anything it will not take. A draft that arrives malformed, or too
   * large to be worth carrying, leaves the screen that holds it working exactly
   * as it did before any of this existed; an error toast per keystroke would be
   * a worse answer than a feature that quietly stops applying.
   */
  private handleChatDraft(wsInfo: WebSocketInfo, data: IncomingMessage): void {
    const session = this.chatSessionFor(wsInfo, data.sessionId);
    if (!session || session.surface !== 'chat') return;

    const input = readDraft(data.text, data.attachments, session.id);
    if (!input) return;

    this.broadcastDraft(session, applyDraft(session, input), wsInfo.id);
  }

  /**
   * Announce a composer to every screen watching this conversation.
   *
   * `origin` is the socket the edit came from, or null when it was not a screen
   * that caused it — a turn being sent empties the composer, and no browser
   * should treat that as its own echo and skip it.
   */
  private broadcastDraft(
    session: SessionRecord,
    draft: ChatDraft,
    origin: string | null,
  ): void {
    broadcastChat(
      session.id,
      { type: 'chat_draft', sessionId: session.id, draft, origin },
      this.deps.claudeSessions,
      this.deps.webSocketConnections,
    );
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
        // And the standing default too, on the same terms the picker records
        // one (#135): the two doors reach the same decision, so they have to
        // leave the same trace, or which one the user happened to use would
        // decide whether the next new chat remembered anything.
        await this.rememberUserModel(session, model, false);
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

    // Read before the send, because the send is not instant: `/clear` restarts
    // the agent's whole process behind it, and anything typed on any screen
    // while that runs is a *different* message from the one being sent. Clearing
    // whatever the composer holds when the await finally returns would throw
    // that away.
    const draftAtSend = draftOf(session)?.revision ?? 0;

    try {
      await manager.send(session.id, {
        text,
        attachments: Array.isArray(data.attachments) ? data.attachments : undefined,
      });
      session.lastActivity = new Date();
      // The composer that held this turn is empty now, on every screen. The one
      // that sent it emptied its own box the moment the button was pressed;
      // without this the others would go on offering a prompt that has already
      // been asked, and the next person to press send there would ask it twice.
      //
      // Only for a turn that came *from* a composer. "Send this turn again"
      // takes its text from the transcript and leaves the input alone (see
      // ChatView.retryTurn), so clearing on every accepted turn would blank a
      // message somebody was halfway through writing — on every screen at once,
      // for pressing retry on something else entirely.
      //
      // Tagged with the screen it came from, which is not the throwaway detail
      // it looks like: that screen emptied its own box a round trip ago and may
      // already be typing the next question into it, and applying this would
      // take those keystrokes back out.
      if (data.fromComposer === true && (draftOf(session)?.revision ?? 0) === draftAtSend) {
        const cleared = clearDraft(session);
        if (cleared) this.broadcastDraft(session, cleared, wsInfo.id);
      }
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
   * a turn, or merely saved for the next launch.
   *
   * It is also, since #135, where this account's standing model for the runtime
   * is set — a pick made here is the only place in the app anybody says which
   * model they want, and forgetting it the moment the conversation ended was
   * the whole complaint. The override still belongs to this conversation alone;
   * what travels is a *separate* preference that seeds the next new chat, and
   * only when the runtime is known to take the name. See rememberUserModel.
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
    // Clearing drops the pin as well, and that is what makes "Use the default
    // for this runtime" mean what it says: the pin is the model this
    // conversation happened to be launched on, so leaving it would make the
    // clear fall back to that instead of to the profile and then the runtime's
    // own default. Unlike the seeding above, this is the user asking, in this
    // conversation, for the defaults to decide again — the one case where
    // re-reading them is not a retcon.
    if (!model) session.chatModelPinned = undefined;
    await this.deps.saveSessionsToDisk();

    // A live session keeps the options it was launched with so that `/clear`
    // can restart the process in place. The model is the one thing in there
    // this handler can change, so it has to be carried across too — otherwise
    // the next `/clear` reinstates the model the conversation opened with,
    // after the browser has already been told the switch was applied. Resolved
    // the way a launch resolves it, so clearing lands on the profile default.
    //
    // Through the read-only accessor. The other one writes the profile's tier
    // files to disk every time it is called, and picking a model from the chip
    // is a question about this conversation, not a launch — asking it that way
    // rewrote the project's `.pi/agents/*.md` on every click (#171).
    const profile = this.deps.activeProfileFor?.(session.agent || '') ?? null;
    this.deps.chatManager?.rememberModel(
      session.id,
      model || profile?.model || profile?.ladder?.model,
    );

    /**
     * Every answer carries the default as it stands *after* this pick.
     *
     * Without it the picker's source line and its "use the default" entry go
     * stale the moment they matter most: they would still be describing the
     * state the conversation launched in, one click after the user changed it.
     */
    const answer = (
      applied: 'live' | 'sent' | 'pending' | 'cleared',
      value: string | null,
      message: string,
    ): void => {
      sendToWebSocket(wsInfo.ws, {
        type: 'chat_model_result',
        sessionId: session.id,
        model: value,
        applied,
        message,
        modelDefault: this.modelDefaultFor(
          session.agent || session.lastAgent,
          session.ownerUserId,
          profile,
        ),
      });
    };

    if (!model) {
      await this.rememberUserModel(session, undefined, false);
      // What it actually falls back to, which a ladder changes: the rung is the
      // profile's standing answer for this runtime, so clearing lands there
      // rather than on the CLI's own default.
      const cleared = this.deps.activeProfileFor?.(session.agent || '') ?? null;
      const under = cleared?.model
        ? `the "${cleared.profileName}" profile’s model, ${cleared.model}`
        : cleared?.ladder
          ? `the ${cleared.ladder.tier} rung of the "${cleared.profileName}" ladder, ${cleared.ladder.model}`
          : 'the runtime default';
      answer(
        'cleared',
        null,
        `Cleared the model override. The next session for this conversation will use ${under}.`,
      );
      return;
    }

    const manager = this.deps.chatManager;
    if (!manager) {
      await this.rememberUserModel(session, model, false);
      answer(
        'pending',
        model,
        `Saved. ${model} will be used the next time a session starts for this conversation.`,
      );
      return;
    }

    try {
      const applied = await manager.setModel(session.id, model);
      if (applied) {
        await this.rememberUserModel(session, model, true);
        answer('live', model, `Switched to ${model} for this conversation.`);
        return;
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.rememberUserModel(session, model, false);
      answer(
        'pending',
        model,
        `Saved, but switching live failed (${message}). ${model} will be used the next time a session starts.`,
      );
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
        await this.rememberUserModel(session, model, false);
        answer(
          'sent',
          model,
          `Sent "/model ${model}" to the session — check the transcript to confirm it took.`,
        );
        return;
      } catch {
        // Falls through to the saved-for-next-time answer below.
      }
    }

    await this.rememberUserModel(session, model, false);
    answer(
      'pending',
      model,
      `Saved. This runtime cannot change model mid-session — ${model} will be used the next time a new session starts for this conversation.`,
    );
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
    // Free text the user typed instead of picking. Trimmed and bounded here
    // rather than trusted: it is written to the conversation log and handed to
    // the model, and this is the edge of the system that a browser writes to.
    const text =
      typeof data.text === 'string'
        ? data.text.trim().slice(0, MAX_QUESTION_ANSWER_TEXT)
        : undefined;
    manager.answerQuestion(session.id, requestId, optionIds, data.skipped === true, text);
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
      case 'antigravity':
        return this.deps.aliases.antigravity;
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
