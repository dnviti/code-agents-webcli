import { WebSocket } from 'ws';

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

export interface ServerOptions {
  port?: number;
  dev?: boolean;
  https?: boolean;
  cert?: string;
  key?: string;
  setup?: boolean;
  folderMode?: boolean;
  sessionHours?: number;
  plan?: string;
  customCostLimit?: number;
  claudeAlias?: string;
  codexAlias?: string;
  agentAlias?: string;
  piAlias?: string;
  grokAlias?: string;
  qwenAlias?: string;
  kimiAlias?: string;
  ompAlias?: string;
  publicBaseUrl?: string;
  githubClientId?: string;
  githubClientSecret?: string;
  githubAppToken?: string;
  allowedGitHubIds?: string;
  allowAnyGitHubUser?: boolean;
  dataDir?: string;
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
}

export interface SessionRecord {
  id: string;
  ownerUserId: number;
  name: string;
  created: Date;
  lastActivity: Date;
  active: boolean;
  agent: AgentKind | null;
  lastAgent: AgentKind | null;
  runtimeLabel: string | null;
  /**
   * Which surface this session runs on, fixed when the runtime is started.
   *
   * Absent on every session created before chat mode existed, and on every
   * terminal session since, so `undefined` reads as 'terminal' everywhere
   * rather than needing a migration to backfill.
   */
  surface?: 'terminal' | 'chat';
  /**
   * The conversation this session belongs to, when it is not a session of its
   * own.
   *
   * A shell opened inside a conversation is a real session with a real pty —
   * that is how it gets scrollback, history and a working directory — but it is
   * not a *standalone* one: it is reached through the conversation that opened
   * it and through nothing else. Set here, it is the one fact that lets the
   * listing leave it out and the teardown take it with the conversation.
   *
   * Absent on every ordinary session, so `undefined` reads as "standalone"
   * without a backfill.
   */
  ownerSessionId?: string;
  /**
   * The runtime's own id for this conversation, when it reported one.
   *
   * Kept so a chat can be resumed *with its context* after the server restarts:
   * the transcript survives on disk regardless, but without this the agent that
   * reads it back would be a stranger to it.
   */
  nativeChatSessionId?: string;
  /**
   * Whether this conversation runs with tool approvals bypassed.
   *
   * Part of how the user set the conversation up, not a property of the process
   * that happens to be serving it: a chat started in bypass mode and then
   * brought back — after a reconnect, a restart, or a resume from the launcher —
   * has to come back in the mode it was in, and the header has to be able to
   * say so while nothing is running at all.
   *
   * Absent on every session that predates this and on every terminal session,
   * so `undefined` reads as "asks first" — the safe direction — without a
   * backfill. Only ever set from an explicit choice made for *this* record, so a
   * standing permission can never be inherited by another conversation.
   */
  chatBypassPermissions?: boolean;
  /**
   * The model this conversation runs with, independent of the runtime's own
   * default or the active profile.
   *
   * Set from a free-typed choice in the composer, not validated against
   * anything: the acceptance test for a model name is whether the runtime
   * accepts it, not whether it looks plausible before it is tried. Scoped to
   * this record only — it is never written back as a profile or personal
   * default, so it cannot leak into another conversation's launch.
   *
   * Absent means "no override", which reads as the profile default exactly
   * like every row written before this existed.
   */
  chatModelOverride?: string;
  terminalOptions: TerminalOptions | null;
  stopRequested: boolean;
  /** Identifies the current PTY run so late callbacks from a previous run are ignored. */
  runId?: string;
  workingDir: string;
  connections: Set<string>;
  outputBuffer: string[];
  /**
   * Geometry the session's PTY is (or was last) running at. The scrollback
   * recorder must emulate at exactly this size or stored lines are wrapped at
   * a width the program never rendered.
   */
  termCols: number;
  termRows: number;
  sessionStartTime: Date | null;
  sessionUsage: SessionUsage;
  maxBufferSize: number;
  lastAccessed?: number;
}

export interface TerminalOptions {
  mode: 'shell' | 'command';
  shell: string;
  command: string | null;
}

export interface SessionUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  totalCost: number;
  models: Record<string, unknown>;
}

export interface WebSocketInfo {
  id: string;
  ws: WebSocket;
  userId: number;
  githubLogin: string;
  /**
   * The session this socket is *driving*: where input, resize and start go.
   * One at a time, because there is one terminal on the page.
   */
  claudeSessionId: string | null;
  /**
   * Chat sessions this socket is *watching*.
   *
   * Separate from `claudeSessionId` because a chat surface has no shared
   * device to contend for: its events are session-tagged and land in a
   * per-session transcript, so a browser can follow every chat it has a tab
   * for while driving only one. Without this a second chat tab silently
   * unsubscribed the first, and its conversation went blank while its agent
   * carried on working.
   */
  chatSessionIds: Set<string>;
  created: Date;
}

export interface SessionListItem {
  id: string;
  name: string;
  created: Date;
  active: boolean;
  agent: AgentKind | null;
  lastAgent: AgentKind | null;
  runtimeLabel: string | null;
  workingDir: string;
  connectedClients: number;
  lastActivity: Date;
  /** Absent means terminal; the client needs it to watch chat sessions it is not driving. */
  surface?: 'terminal' | 'chat';
}

export interface BridgeInterface {
  startSession(sessionId: string, options: Record<string, unknown>): Promise<unknown>;
  sendInput(sessionId: string, data: string): Promise<void>;
  resize(sessionId: string, cols: number, rows: number): Promise<void>;
  stopSession(sessionId: string): Promise<void>;
}

export interface RuntimeSession {
  runtimeLabel?: string;
  terminalMode?: string;
  shell?: string;
}

export interface PathValidation {
  valid: boolean;
  error?: string;
  path?: string;
}

export interface ServerState {
  port: number;
  dev: boolean;
  useHttps: boolean;
  certFile: string | undefined;
  keyFile: string | undefined;
  setup: boolean;
  folderMode: boolean;
  selectedWorkingDir: string | null;
  baseFolder: string;
  publicBaseUrl: string | null;
  githubClientId: string | null;
  githubClientSecret: string | null;
  githubAppToken: string | null;
  allowedGitHubIds: string[];
  allowAnyGitHubUser: boolean;
  dataDir: string | null;
  sessionDurationHours: number;
  aliases: Aliases;
  startTime: number;
  isShuttingDown: boolean;
}

export interface AuthenticatedUser {
  id: number;
  githubId: string;
  githubLogin: string;
  githubName: string | null;
  avatarUrl: string | null;
  email: string | null;
}

export interface AuthContext {
  user: AuthenticatedUser | null;
  authSessionId: string | null;
}
