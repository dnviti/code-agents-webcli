import { WebSocket } from 'ws';

export type AgentKind = 'claude' | 'codex' | 'agent' | 'terminal';

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
  publicBaseUrl?: string;
  githubClientId?: string;
  githubClientSecret?: string;
  githubAppToken?: string;
  allowedGitHubIds?: string;
  dataDir?: string;
}

export interface Aliases {
  claude: string;
  codex: string;
  agent: string;
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
  terminalOptions: TerminalOptions | null;
  stopRequested: boolean;
  workingDir: string;
  connections: Set<string>;
  outputBuffer: string[];
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
  claudeSessionId: string | null;
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
