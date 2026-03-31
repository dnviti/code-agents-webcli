// Client-side type definitions for Code Agents Web CLI

export interface AppSettings {
  fontSize: number;
  theme: ThemePresetId;
  terminalFontFamily: TerminalFontFamilyId;
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
  terminal: string;
}

export type AgentKind = 'claude' | 'codex' | 'agent' | 'terminal';

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
}

export interface WsSessionLeftMessage {
  type: 'session_left';
  sessionId: string;
}

export interface WsRuntimeStartedMessage {
  type: 'claude_started' | 'codex_started' | 'agent_started' | 'terminal_started';
  agent?: AgentKind;
}

export interface WsRuntimeStoppedMessage {
  type: 'claude_stopped' | 'codex_stopped' | 'agent_stopped' | 'terminal_stopped';
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
  | WsPongMessage
  | WsUsageUpdateMessage;
