import express from 'express';
import http from 'http';
import https from 'https';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import cors from 'cors';

import {
  ServerOptions,
  SessionRecord,
  WebSocketInfo,
  AgentKind,
  BridgeInterface,
  PathValidation,
} from './types.js';
import { createConfig, createUsageAnalyticsOptions } from './config.js';
import { registerRoutes } from './routes/index.js';
import { WebSocketHandler } from './websocket/handler.js';
import { MessageProcessor } from './websocket/messages.js';

import { ClaudeBridge } from './bridges/claude.js';
import { CodexBridge } from './bridges/codex.js';
import { AgentBridge } from './bridges/agent.js';
import { TerminalBridge } from './bridges/terminal.js';
import { AppDatabase } from './services/database.js';
import { SessionStore } from './services/session-store.js';
import { AuthService } from './services/auth.js';
import { UsageReader } from './services/usage-reader.js';
import { UsageAnalytics } from './services/usage-analytics.js';

export class ClaudeCodeWebServer {
  private port: number;
  private dev: boolean;
  private useHttps: boolean;
  private certFile: string | undefined;
  private keyFile: string | undefined;
  private setup: boolean;
  private folderMode: boolean;
  private baseFolder: string;
  private publicBaseUrl: string | null;
  private sessionDurationHours: number;
  private aliases: { claude: string; codex: string; agent: string };

  private startTime: number;
  private isShuttingDown: boolean;
  private autoSaveInterval: ReturnType<typeof setInterval> | null;

  private claudeSessions: Map<string, SessionRecord>;
  private webSocketConnections: Map<string, WebSocketInfo>;

  private claudeBridge: BridgeInterface;
  private codexBridge: BridgeInterface;
  private agentBridge: BridgeInterface;
  private terminalBridge: BridgeInterface;

  private database: AppDatabase;
  private sessionStore: SessionStore;
  private authService: AuthService;
  private usageReader: UsageReader;
  private usageAnalytics: UsageAnalytics;

  private app: express.Express;
  private server: http.Server | https.Server | null;
  private wss: WebSocket.Server | null;

  private wsHandler: WebSocketHandler;
  private messageProcessor: MessageProcessor;

  constructor(options: ServerOptions = {}) {
    const config = createConfig(options);
    this.port = config.port;
    this.dev = config.dev;
    this.useHttps = config.useHttps;
    this.certFile = config.certFile;
    this.keyFile = config.keyFile;
    this.setup = config.setup;
    this.folderMode = config.folderMode;
    this.baseFolder = config.baseFolder;
    this.publicBaseUrl = config.publicBaseUrl;
    this.sessionDurationHours = config.sessionDurationHours;
    this.aliases = config.aliases;
    this.startTime = config.startTime;
    this.isShuttingDown = config.isShuttingDown;

    this.autoSaveInterval = null;
    this.server = null;
    this.wss = null;

    this.claudeSessions = new Map();
    this.webSocketConnections = new Map();

    this.claudeBridge = new ClaudeBridge();
    this.codexBridge = new CodexBridge();
    this.agentBridge = new AgentBridge();
    this.terminalBridge = new TerminalBridge();

    this.database = new AppDatabase({ dataDir: config.dataDir });
    this.sessionStore = new SessionStore({ database: this.database });
    this.authService = new AuthService({
      database: this.database,
      dev: this.dev,
      port: this.port,
      useHttps: this.useHttps,
      publicBaseUrl: config.publicBaseUrl,
      githubClientId: config.githubClientId,
      githubClientSecret: config.githubClientSecret,
      githubAppToken: config.githubAppToken,
      allowedGitHubIds: config.allowedGitHubIds,
    });
    this.usageReader = new UsageReader(this.sessionDurationHours);
    this.usageAnalytics = new UsageAnalytics(
      createUsageAnalyticsOptions(options, this.sessionDurationHours),
    );

    this.messageProcessor = new MessageProcessor({
      dev: this.dev,
      claudeSessions: this.claudeSessions,
      webSocketConnections: this.webSocketConnections,
      baseFolder: this.baseFolder,
      sessionDurationHours: this.sessionDurationHours,
      aliases: this.aliases,
      validatePath: (targetPath: string) => this.validatePath(targetPath),
      getSelectedWorkingDir: (userId: number) => this.getSelectedWorkingDir(userId),
      createSessionRecord: (params) => this.createSessionRecord(params),
      getRuntimeBridge: (agentKind: AgentKind) => this.getRuntimeBridge(agentKind),
      saveSessionsToDisk: () => this.saveSessionsToDisk(),
      usageReader: this.usageReader,
      usageAnalytics: this.usageAnalytics,
    });

    this.wsHandler = new WebSocketHandler(
      {
        dev: this.dev,
        claudeSessions: this.claudeSessions,
        webSocketConnections: this.webSocketConnections,
        getAuthContext: (message) => this.authService.getAuthContextFromIncomingMessage(message),
      },
      this.messageProcessor,
    );

    this.app = express();
    this.setupExpress();
    this.setupAutoSave();
  }

  private isPathWithinBase(targetPath: string): boolean {
    try {
      const resolvedTarget = path.resolve(targetPath);
      const resolvedBase = path.resolve(this.baseFolder);
      return (
        resolvedTarget === resolvedBase
        || resolvedTarget.startsWith(`${resolvedBase}${path.sep}`)
      );
    } catch {
      return false;
    }
  }

  private validatePath(targetPath: string): PathValidation {
    if (!targetPath) {
      return { valid: false, error: 'Path is required' };
    }

    const resolvedPath = path.resolve(targetPath);
    if (!this.isPathWithinBase(resolvedPath)) {
      return {
        valid: false,
        error: 'Access denied: Path is outside the allowed directory',
      };
    }

    return { valid: true, path: resolvedPath };
  }

  private createSessionRecord(params: {
    id: string;
    ownerUserId: number;
    name?: string;
    workingDir: string;
    connections?: string[];
  }): SessionRecord {
    return {
      id: params.id,
      ownerUserId: params.ownerUserId,
      name: params.name || `Session ${new Date().toLocaleString()}`,
      created: new Date(),
      lastActivity: new Date(),
      active: false,
      agent: null,
      lastAgent: null,
      runtimeLabel: null,
      terminalOptions: null,
      stopRequested: false,
      workingDir: params.workingDir,
      connections: new Set(params.connections || []),
      outputBuffer: [],
      sessionStartTime: null,
      sessionUsage: {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheTokens: 0,
        totalCost: 0,
        models: {},
      },
      maxBufferSize: 1000,
    };
  }

  private getRuntimeBridge(agentKind: AgentKind): BridgeInterface | null {
    switch (agentKind) {
      case 'codex':
        return this.codexBridge;
      case 'agent':
        return this.agentBridge;
      case 'terminal':
        return this.terminalBridge;
      case 'claude':
        return this.claudeBridge;
      default:
        return null;
    }
  }

  private getSelectedWorkingDir(userId: number): string | null {
    return this.database.getUserSetting(userId, 'selectedWorkingDir');
  }

  private setSelectedWorkingDir(userId: number, value: string | null): void {
    if (value) {
      this.database.setUserSetting(userId, 'selectedWorkingDir', value);
    } else {
      this.database.deleteUserSetting(userId, 'selectedWorkingDir');
    }
  }

  private async loadPersistedSessions(): Promise<void> {
    try {
      const sessions = await this.sessionStore.loadSessions();
      this.claudeSessions.clear();
      for (const [id, session] of sessions) {
        this.claudeSessions.set(id, session);
      }
      if (sessions.size > 0) {
        console.log(`Loaded ${sessions.size} persisted sessions`);
      }
    } catch (error) {
      console.error('Failed to load persisted sessions:', error);
    }
  }

  private setupAutoSave(): void {
    this.autoSaveInterval = setInterval(() => {
      void this.saveSessionsToDisk();
    }, 30000);
    process.on('beforeExit', () => {
      void this.saveSessionsToDisk();
    });
  }

  private async saveSessionsToDisk(): Promise<void> {
    await this.sessionStore.saveSessions(this.claudeSessions);
  }

  async shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }
    this.isShuttingDown = true;

    console.log('\nGracefully shutting down...');
    await this.saveSessionsToDisk();
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval);
      this.autoSaveInterval = null;
    }

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    for (const [sessionId, session] of this.claudeSessions.entries()) {
      if (session.active && session.agent) {
        const bridge = this.getRuntimeBridge(session.agent);
        if (bridge) {
          await bridge.stopSession(sessionId);
        }
      }
    }

    this.claudeSessions.clear();
    this.webSocketConnections.clear();

    await new Promise<void>((resolve) => {
      if (this.server && this.server.listening) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });

    this.server = null;
    this.database.close();
  }

  private setupExpress(): void {
    const publicDir = path.join(__dirname, '..', 'public');

    this.app.use(cors());
    this.app.use(express.json());
    this.app.use(this.authService.attachRequestContext());

    this.app.get('/login', this.authService.handleLoginPage);
    this.app.get('/auth/github/login', this.authService.handleGitHubLogin);
    this.app.get('/auth/github/callback', this.authService.handleGitHubCallback);
    this.app.get('/auth/logout', this.authService.handleLogout);
    this.app.get('/api/auth/me', this.authService.handleCurrentUser);

    this.app.get('/manifest.json', (_req, res) => {
      res.setHeader('Content-Type', 'application/manifest+json');
      res.sendFile(path.join(publicDir, 'manifest.json'));
    });

    this.app.use(express.static(publicDir, { index: false }));

    const iconSizes = [16, 32, 144, 180, 192, 512];
    iconSizes.forEach((size) => {
      this.app.get(`/icon-${size}.png`, (_req, res) => {
        const svg = `
          <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
            <rect width="${size}" height="${size}" fill="#0d1117" rx="${size * 0.12}"/>
            <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle"
                  font-family="monospace" font-size="${size * 0.36}px" font-weight="bold" fill="#58a6ff">
              CA
            </text>
          </svg>
        `;
        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader('Cache-Control', 'public, max-age=31536000');
        res.send(Buffer.from(svg));
      });
    });

    registerRoutes(this.app, {
      claudeSessions: this.claudeSessions,
      webSocketConnections: this.webSocketConnections,
      folderMode: this.folderMode,
      baseFolder: this.baseFolder,
      aliases: this.aliases,
      dev: this.dev,
      validatePath: (targetPath: string) => this.validatePath(targetPath),
      isPathWithinBase: (targetPath: string) => this.isPathWithinBase(targetPath),
      getSelectedWorkingDir: (userId: number) => this.getSelectedWorkingDir(userId),
      setSelectedWorkingDir: (userId: number, value: string | null) =>
        this.setSelectedWorkingDir(userId, value),
      createSessionRecord: (params) => this.createSessionRecord(params),
      getRuntimeBridge: (agentKind: AgentKind) => this.getRuntimeBridge(agentKind),
      saveSessionsToDisk: () => this.saveSessionsToDisk(),
      sessionStore: this.sessionStore,
    });

    this.app.get(
      ['/', '/index.html'],
      this.authService.requireAuth(),
      (_req, res) => {
        res.sendFile(path.join(publicDir, 'index.html'));
      },
    );
  }

  async start(): Promise<http.Server | https.Server> {
    await this.loadPersistedSessions();
    await this.authService.ensureConfiguredInteractive(this.setup);

    let server: http.Server | https.Server;
    if (this.useHttps) {
      if (!this.certFile || !this.keyFile) {
        throw new Error('HTTPS requires both --cert and --key options');
      }
      const cert = fs.readFileSync(this.certFile);
      const key = fs.readFileSync(this.keyFile);
      server = https.createServer({ cert, key }, this.app);
    } else {
      server = http.createServer(this.app);
    }

    this.wss = new WebSocket.Server({ server });
    this.wss.on('connection', (ws: WebSocket, req) => {
      this.wsHandler.handleConnection(ws, req);
    });

    return await new Promise((resolve, reject) => {
      server.listen(this.port, () => {
        this.server = server;
        resolve(server);
      });
      server.on('error', reject);
    });
  }

  close(): void {
    void this.shutdown();
  }
}

export async function startServer(options: ServerOptions): Promise<http.Server | https.Server> {
  const server = new ClaudeCodeWebServer(options);
  return await server.start();
}
