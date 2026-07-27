// Client-side type definitions for Code Agents Web CLI

export interface AppSettings {
  fontSize: number;
  theme: ThemePresetId;
  terminalFontFamily: TerminalFontFamilyId;
  /**
   * Launch web chats with tool approvals bypassed.
   *
   * A launch-time property of the session, not a live switch: the runtime is
   * told once, on the command line, and a session that started asking keeps
   * asking. Stored here so the choice survives a reload rather than having to
   * be re-made for every conversation.
   */
  chatBypassPermissions: boolean;
}

export type ThemePresetId =
  | 'github-dark'
  | 'github-dark-dimmed'
  | 'github-dark-high-contrast'
  | 'github-light'
  | 'github-light-high-contrast';

export type TerminalFontFamilyId =
  | 'jetbrains-mono'
  | 'fira-code'
  | 'source-code-pro'
  | 'ibm-plex-mono'
  | 'cascadia-code-nf'
  | 'hack-nf'
  | 'meslo-nf'
  | 'sauce-code-pro-nf';

export interface SessionInfo {
  id: string;
  name: string;
  status: 'idle' | 'active' | 'error' | 'disconnected';
  workingDir: string | null;
  lastAccessed: number;
  lastActivity: number;
  unreadOutput: boolean;
  hasError: boolean;
  idleTimeout?: ReturnType<typeof setTimeout>;
  workCompleteTimeout?: ReturnType<typeof setTimeout>;
}

export interface Aliases {
  claude: string;
  codex: string;
  agent: string;
  pi: string;
  grok: string;
  qwen: string;
  kimi: string;
  omp: string;
  terminal: string;
}

export type AgentKind =
  | 'claude'
  | 'codex'
  | 'agent'
  | 'pi'
  | 'grok'
  | 'qwen'
  | 'kimi'
  | 'omp'
  | 'terminal';

export interface PlanData {
  content: string;
  timestamp: number;
  raw: string;
}

export interface RuntimeStartOptions {
  dangerouslySkipPermissions?: boolean;
  mode?: 'shell' | 'command';
  shell?: string;
  command?: string;
  /**
   * Which surface to open the session on.
   *
   * Absent means terminal, so every existing caller keeps its behaviour. Set
   * once at launch and never changed: the two surfaces run the runtime as
   * different processes — a TUI in a PTY versus a headless protocol stream —
   * so there is nothing to switch between afterwards.
   */
  surface?: 'terminal' | 'chat';
}

export interface SessionCreateResponse {
  sessionId: string;
  session: {
    name: string;
    workingDir: string;
  };
}

export interface SessionListItem {
  id: string;
  name: string;
  active: boolean;
  workingDir: string;
  connectedClients: number;
  created: string;
  /** Absent means terminal, so a server that predates chat mode still reads. */
  surface?: 'terminal' | 'chat';
  /** The user's chosen label, when there is one. Absent means "never renamed". */
  customName?: string;
}

export interface FolderData {
  currentPath: string;
  parentPath: string | null;
  folders: Array<{
    name: string;
    path: string;
  }>;
}

// WebSocket message types
export interface WsConnectedMessage {
  type: 'connected';
  connectionId: string;
  /**
   * Optional protocol extensions this server understands.
   *
   * Absent on a server that predates the handshake, which is exactly the case
   * the list exists for: the client then asks for nothing optional.
   */
  features?: string[];
}

export interface WsSessionCreatedMessage {
  type: 'session_created';
  sessionId: string;
  sessionName: string;
  workingDir: string;
}

export interface WsSessionJoinedMessage {
  type: 'session_joined';
  sessionId: string;
  sessionName: string;
  workingDir: string;
  active: boolean;
  outputBuffer?: string[];
  lastAgent?: AgentKind;
  runtimeLabel?: string;
  agent?: AgentKind;
  /**
   * Which surface this session runs on. Absent means terminal, so a server
   * that predates chat mode still reads correctly.
   */
  surface?: 'terminal' | 'chat';
  /** How far back the server can page this session's scrollback. */
  history?: { firstLine: number; totalLines: number };
}

/**
 * The chat surface's message family.
 *
 * Typed loosely on purpose at this boundary: the payloads are ChatEvent and
 * ChatSnapshot from src/shared, and the chat controller is the only thing that
 * looks inside them. Restating those shapes here would create a second
 * definition to keep in step with the shared one.
 */
export interface WsChatStartedMessage {
  type: 'chat_started';
  sessionId: string;
  agent: AgentKind;
  runtimeLabel: string;
  workingDir?: string;
  capabilities?: unknown;
  bypassPermissions?: boolean;
}

export interface WsChatSnapshotMessage {
  type: 'chat_snapshot';
  sessionId: string;
  snapshot: unknown;
}

export interface WsChatEventMessage {
  type: 'chat_event';
  sessionId: string;
  event: unknown;
}

export interface WsChatPageMessage {
  type: 'chat_page';
  sessionId: string;
  requestId: string | null;
  events: unknown[];
  firstSeq: number;
  /** Lowest seq this page covers once the server clamped the request. */
  from?: number;
  cursor: number;
}

/** A page read that failed server-side, so the requesting tab stops waiting. */
export interface WsChatPageFailedMessage {
  type: 'chat_page_failed';
  sessionId: string;
  requestId: string | null;
  message: string;
}

export interface WsHistoryChunkMessage {
  type: 'history_chunk';
  sessionId: string;
  requestId: string | null;
  fromLine: number;
  lines: string[];
  firstLine: number;
  totalLines: number;
}

export interface WsSessionLeftMessage {
  type: 'session_left';
  sessionId: string;
}

export interface WsRuntimeStartedMessage {
  type:
    | 'claude_started'
    | 'codex_started'
    | 'agent_started'
    | 'pi_started'
    | 'grok_started'
    | 'qwen_started'
    | 'kimi_started'
    | 'omp_started'
    | 'terminal_started';
  agent?: AgentKind;
}

export interface WsRuntimeStoppedMessage {
  type:
    | 'claude_stopped'
    | 'codex_stopped'
    | 'agent_stopped'
    | 'pi_stopped'
    | 'grok_stopped'
    | 'qwen_stopped'
    | 'kimi_stopped'
    | 'omp_stopped'
    | 'terminal_stopped';
  agent?: AgentKind;
  runtimeLabel?: string;
}

export interface WsOutputMessage {
  type: 'output';
  data: string;
}

export interface WsExitMessage {
  type: 'exit';
  code: number;
  agent?: AgentKind;
  runtimeLabel?: string;
}

export interface WsErrorMessage {
  type: 'error';
  message: string;
}

export interface WsInfoMessage {
  type: 'info';
  message: string;
}

export interface WsSessionDeletedMessage {
  type: 'session_deleted';
  sessionId: string;
  message: string;
}

/**
 * Sent to every one of the user's sockets when a session is renamed, including
 * the one that asked, so a second window follows the new label without a reload.
 */
export interface WsSessionRenamedMessage {
  type: 'session_renamed';
  sessionId: string;
  name: string;
}

/** Sent when a reattach targets a session the server no longer has. */
export interface WsSessionGoneMessage {
  type: 'session_gone';
  sessionId: string;
  message: string;
}

export interface WsPongMessage {
  type: 'pong';
}

export interface WsUsageUpdateMessage {
  type: 'usage_update';
  sessionStats: unknown;
  dailyStats: unknown;
  sessionTimer: unknown;
  analytics: unknown;
  burnRate: unknown;
  plan: unknown;
  limits: unknown;
}

// The server and the banner share one definition of these; see src/shared/update.ts.
export type {
  UpdateMode,
  UpdateState,
  UpdateStatus,
  UpdateStatusResponse,
} from '../shared/update';
import type { UpdateStatus } from '../shared/update';

/** Broadcast to every client; the button is gated per-user by the status route. */
export interface WsUpdateStatusMessage {
  type: 'update_status';
  status: UpdateStatus;
}

/** Installer's sockets only: npm output carries host paths. */
export interface WsUpdateOutputMessage {
  type: 'update_output';
  stream: 'stdout' | 'stderr';
  data: string;
}

export interface WsUpdateDoneMessage {
  type: 'update_done';
  ok: boolean;
  code: number | null;
  restarting: boolean;
  restartRequired: boolean;
  message: string;
}

/** Broadcast: a restart ends every user's agent sessions, not just the installer's. */
export interface WsUpdateRestartingMessage {
  type: 'update_restarting';
}

/**
 * Automatic sizing moved this user's environment.
 *
 * Sent rather than left to be discovered: a machine that changes size under
 * someone with no explanation reads as a fault, and the reason is exactly what
 * makes it read as a feature instead.
 */
export interface WsEnvironmentTierChangedMessage {
  type: 'environment_tier_changed';
  tier: string;
  previousTier: string;
  reason: string;
  /** `applied` now, or `deferred` until nothing is running. */
  outcome: string;
}

export type WsMessage =
  | WsConnectedMessage
  | WsSessionCreatedMessage
  | WsSessionJoinedMessage
  | WsSessionLeftMessage
  | WsRuntimeStartedMessage
  | WsRuntimeStoppedMessage
  | WsOutputMessage
  | WsExitMessage
  | WsErrorMessage
  | WsInfoMessage
  | WsSessionDeletedMessage
  | WsSessionRenamedMessage
  | WsSessionGoneMessage
  | WsPongMessage
  | WsHistoryChunkMessage
  | WsUsageUpdateMessage
  | WsUpdateStatusMessage
  | WsUpdateOutputMessage
  | WsUpdateDoneMessage
  | WsUpdateRestartingMessage
  | WsEnvironmentTierChangedMessage
  | WsChatStartedMessage
  | WsChatSnapshotMessage
  | WsChatEventMessage
  | WsChatPageMessage
  | WsChatPageFailedMessage;
