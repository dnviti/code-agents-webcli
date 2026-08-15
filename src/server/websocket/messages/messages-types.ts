import {
  AgentKind,
  Aliases,
  BridgeInterface,
  PathValidation,
  SessionRecord,
  SessionStorageScope,
  WebSocketInfo,
} from '../../types.js';
import { TranscriptStoreLike } from '../../services/workspace/artifacts/transcript-store.js';
import { HistoryStoreLike } from '../../services/workspace/artifacts/history-store.js';
import { AccountTabCoordinatorLike } from '../../services/identity/account-tab-coordinator.js';
import { ChatAttachment, BuiltInWorkflowId } from '../../../shared/chat-events.js';
import { UserPreferences } from '../../../shared/user-preferences.js';
import { UserEnvironment } from '../../services/environments/types.js';
import type { ProjectsSessionApi } from '../../services/projects/working-dir.js';
import { LadderRung, ModelTier, ResolvedProfile } from '../../../shared/runtime-profiles.js';

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
  /** Project sessions resolve only through this manager, never through a user environment. */
  projectsManager?: ProjectsSessionApi;
  /** Active-state DB truth for project run-limit checks. */
  sessionStore?: {
    setActive(id: string, active: boolean, scope?: SessionStorageScope): Promise<void>;
  };
  getSelectedWorkingDir(userId: number): string | null;
  createSessionRecord(params: {
    id: string;
    ownerUserId: number;
    name?: string;
    workingDir: string;
    connections?: string[];
    /** Canonical server-validated folder used for project-artifact persistence. */
    storageRoot?: string;
  }): SessionRecord;
  /** Authorise a trusted artifact root before the first project-file access. */
  loadWorkspaceSessions?(ownerUserId: number, storageRoot: string): Promise<void>;
  /** Shared with HTTP tab routes so creation cannot cross a tentative close/reorder. */
  tabCoordinator?: AccountTabCoordinatorLike;
  getRuntimeBridge(agentKind: AgentKind): BridgeInterface | null;
  /** Select an app-managed executable for this exact session environment. */
  resolveAgentLaunch?(
    session: SessionRecord,
    environment: UserEnvironment,
    agentKind: AgentKind,
  ): { command: string; version: string } | null;
  /** Resolve the exact immutable environment already occupied by a live session. */
  resolveAgentEnvironment?(session: SessionRecord): Promise<UserEnvironment>;
  /** Probe the executable used by a successful spawn; pointer metadata is not process identity. */
  probeAgentLaunchVersion?(
    environment: UserEnvironment,
    agentKind: AgentKind,
    command?: string,
  ): Promise<string | null>;
  saveSessionsToDisk(): Promise<boolean | void>;
  /**
   * Launch configuration for this runtime, already resolved from the active
   * profile: model, extra args and environment. Returns null when no profile
   * is active, which is the default and must stay a plain unmodified launch.
   */
  resolveRuntimeProfile(agentKind: AgentKind, workingDir?: string): ResolvedProfile | null;
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
  /** Resolve one sanitized attachment URL to server-owned metadata and path. */
  resolveChatAttachment?(
    session: SessionRecord,
    attachment: ChatAttachment,
  ): Promise<ChatAttachment | null>;
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
      command?: string;
      workingDir: string;
      cwdKind?: 'host' | 'container';
      fileAccess?: {
        readFile(filePath: string): Promise<string>;
        writeFile(filePath: string, contents: string): Promise<void>;
      };
      model?: string;
      effort?: string;
      extraArgs?: string[];
      env?: Record<string, string>;
      bypassPermissions?: boolean;
      resumeSessionId?: string;
      startFresh?: boolean;
      planMode?: boolean;
      /** Where the runtime runs; absent means this host. */
      environment?: UserEnvironment;
      /** Rechecked synchronously at the adapter's final pre-spawn boundary. */
      cancelled?: () => boolean;
      /** The rung this conversation runs on, and the ladder it can move up. */
      ladder?: { tier: ModelTier; tiers: Partial<Record<ModelTier, string>> };
    },
  ): Promise<{
    runtimeKind: string;
    currentCapabilities: unknown;
    bypassing: boolean;
    /** False when the adapter exited before start() finished resolving. */
    live?: boolean;
  }>;
  /**
   * The transcript, forwarded whole. `live` is the one field this layer reads
   * for itself — whether a process is answering right now — because a join has
   * to say what is in force and the record's own `active` flag is not the same
   * question: it survives an adapter that died through its error path, and it
   * is cleared by a probe abandoned in favour of a fallback that is running.
   */
  snapshot(record: SessionRecord): Promise<{
    live?: boolean;
    runtime?: string;
    planMode?: boolean;
    planDocument?: { markdown: string; revision: number; ts: number } | null;
  }>;
  send(
    sessionId: string,
    turn: { text: string; attachments?: unknown[]; workflow?: BuiltInWorkflowId },
  ): Promise<'accepted' | 'queued'>;
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
  setPlanMode?(
    sessionId: string,
    on: boolean,
  ): Promise<{ planMode: boolean; changed: boolean; detail: string } | null>;
  rememberPlanMode?(sessionId: string, on: boolean): void;
  acceptPlan?(
    sessionId: string,
    revision: number,
  ): Promise<{
    accepted: boolean;
    action: 'accept' | 'reject';
    planMode: boolean;
    revision?: number;
    detail: string;
  } | null>;
  rejectPlan?(
    sessionId: string,
    revision: number,
  ): Promise<{
    accepted: boolean;
    action: 'accept' | 'reject';
    planMode: boolean;
    revision?: number;
    detail: string;
  } | null>;
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
  ): boolean | Promise<boolean>;
  stop(sessionId: string): Promise<void>;
  restartForAgentUpdate?(
    sessionId: string,
    input: { automatic: boolean; allowFreshContext: boolean; command?: string },
  ): Promise<{ ok: true; resumed: boolean } | { ok: false; reason: 'not_running' | 'busy' | 'cannot_resume' }>;
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
