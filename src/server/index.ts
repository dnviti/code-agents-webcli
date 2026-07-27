import express from 'express';
import http from 'http';
import https from 'https';
import net from 'net';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import cors from 'cors';

import {
  Aliases,
  ServerOptions,
  SessionRecord,
  WebSocketInfo,
  AgentKind,
  BridgeInterface,
  PathValidation,
} from './types.js';
import { createConfig, createUsageAnalyticsOptions } from './config.js';
import { registerRoutes } from './routes/index.js';
import { RuntimeProfileStore } from './services/runtime-profiles.js';
import { TierWriterContext, applyTiers, defaultTierContext } from './services/tier-writer.js';
import { WebSocketHandler } from './websocket/handler.js';
import { MessageProcessor } from './websocket/messages.js';
import { PromptSession } from './setup/prompts.js';
import { runRunModeWizard } from './setup/wizard.js';
import { INSTALL_COMMAND } from '../shared/update.js';

import { ClaudeBridge } from './bridges/claude.js';
import { CodexBridge } from './bridges/codex.js';
import { AgentBridge } from './bridges/agent.js';
import { PiBridge } from './bridges/pi.js';
import { GrokBridge } from './bridges/grok.js';
import { QwenBridge } from './bridges/qwen.js';
import { KimiBridge } from './bridges/kimi.js';
import { OmpBridge } from './bridges/omp.js';
import { TerminalBridge } from './bridges/terminal.js';
import { AppDatabase } from './services/database.js';
import { SessionStore } from './services/session-store.js';
import { TranscriptStore } from './services/transcript-store.js';
import { HistoryStore } from './services/history-store.js';
import { SessionTeardownRegistry } from './services/session-teardown.js';
import { PasteStore } from './services/paste-store.js';
import { AttachmentStore } from './services/attachment-store.js';
import { readBuildInfo } from './services/build-info.js';
import { UpdateChecker } from './services/update-check.js';
import { ensureCertificates, createHttpsOnlyPort, caCertificateHandler } from './services/tls.js';
import {
  InterruptedUpdate,
  SelfUpdateRunner,
  UpdateModeResult,
  detectUpdateMode,
} from './services/self-update.js';
import { broadcastChat, broadcastToAllConnections, sendToUser } from './websocket/handler.js';
import { ChatStore } from './chat/store.js';
import { ChatSessionManager } from './chat/manager.js';
import { AuthService } from './services/auth.js';
import {
  APP_MOUNT,
  EnvironmentManager,
  SOCKET_MOUNT,
  createContainerConfig,
  ensureRoot,
} from './services/environments/index.js';
import { UserEnvironment } from './services/environments/types.js';
import { UsageReader } from './services/usage-reader.js';
import { UsageAnalytics } from './services/usage-analytics.js';

/**
 * The installed package's own root.
 *
 * Mounted read-only into every environment so a runtime running there can
 * execute the approval hook and the question MCP server, which are files of
 * this app rather than of the image. `__dirname` is `<root>/dist/server`.
 */
function appRootDir(): string {
  return path.resolve(__dirname, '..', '..');
}

export class ClaudeCodeWebServer {
  private port: number;
  private dev: boolean;
  private useHttps: boolean;
  private certFile: string | undefined;
  private keyFile: string | undefined;
  private setup: boolean;
  private dataDir: string | null;
  private folderMode: boolean;
  private baseFolder: string;
  private publicBaseUrl: string | null;
  private sessionDurationHours: number;
  private aliases: Aliases;

  private startTime: number;
  private isShuttingDown: boolean;
  private autoSaveInterval: ReturnType<typeof setInterval> | null;

  private claudeSessions: Map<string, SessionRecord>;
  private webSocketConnections: Map<string, WebSocketInfo>;

  private claudeBridge: BridgeInterface;
  private codexBridge: BridgeInterface;
  private agentBridge: BridgeInterface;
  private piBridge: BridgeInterface;
  private grokBridge: BridgeInterface;
  private qwenBridge: BridgeInterface;
  private kimiBridge: BridgeInterface;
  private ompBridge: BridgeInterface;
  private terminalBridge: BridgeInterface;

  private database: AppDatabase;
  private sessionStore: SessionStore;
  private transcriptStore: TranscriptStore;
  private chatStore: ChatStore;
  private chatManager: ChatSessionManager;
  private historyStore: HistoryStore;
  private pasteStore: PasteStore;
  private attachmentStore: AttachmentStore;
  private runtimeProfiles: RuntimeProfileStore;
  private tierContext: TierWriterContext;
  private sessionTeardown: SessionTeardownRegistry;
  private authService: AuthService;
  private usageReader: UsageReader;
  private usageAnalytics: UsageAnalytics;
  private updateChecker: UpdateChecker;
  private selfUpdate: SelfUpdateRunner;
  private updateMode: UpdateModeResult | null;
  private interruptedUpdate: InterruptedUpdate | null;

  private app: express.Express;
  private server: http.Server | https.Server | null;
  /**
   * The socket actually bound to the port. It is not the https server: that one
   * is fed connections by the demultiplexer in createTlsPort(), so it never
   * listens and closing it alone would leave the port held.
   */
  private listener: net.Server | null;
  /** The local CA, when one was generated; offered at /ca.crt for other devices. */
  private caFile: string | undefined;
  private wss: WebSocket.Server | null;

  private wsHandler: WebSocketHandler;
  private messageProcessor: MessageProcessor;
  private environments: EnvironmentManager;
  private environmentSweep: ReturnType<typeof setInterval> | null = null;
  private environmentScale: ReturnType<typeof setInterval> | null = null;

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
    this.listener = null;
    this.caFile = undefined;
    this.wss = null;

    this.claudeSessions = new Map();
    this.webSocketConnections = new Map();

    this.claudeBridge = new ClaudeBridge();
    this.codexBridge = new CodexBridge();
    this.agentBridge = new AgentBridge();
    this.piBridge = new PiBridge();
    this.grokBridge = new GrokBridge();
    this.qwenBridge = new QwenBridge();
    this.kimiBridge = new KimiBridge();
    this.ompBridge = new OmpBridge();
    this.terminalBridge = new TerminalBridge();

    this.dataDir = config.dataDir;
    this.database = new AppDatabase({ dataDir: config.dataDir });

    // Per-user environments. Off unless an administrator asked for them, in
    // which case every process this server starts on a user's behalf goes into
    // that user's container instead of onto this machine.
    //
    // Two host directories travel with every environment besides the user's
    // home: the app's own compiled code, so the approval hook and the question
    // MCP server can be executed by a runtime that is not on this machine, and
    // the directory their unix sockets live in, so it can dial back.
    const containerConfig = createContainerConfig({
      containers: options.containers,
      containerEngine: options.containerEngine,
      containerImage: options.containerImage,
      containerCpus: options.containerCpus,
      containerMemory: options.containerMemory,
      containerIdleMinutes: options.containerIdleMinutes,
      containerSetupCommand: options.containerSetupCommand,
      containerTiers: options.containerTiers,
      containerDefaultTier: options.containerDefaultTier,
      containerUserTierChoice: options.containerUserTierChoice,
      kubeContext: options.kubeContext,
      kubeNamespace: options.kubeNamespace,
      kubeStorageClaim: options.kubeStorageClaim,
      kubeServiceAccount: options.kubeServiceAccount,
      dataDir: config.dataDir,
      extraMounts: [
        { hostPath: appRootDir(), containerPath: APP_MOUNT, readOnly: true },
        { hostPath: path.join(this.database.storageDir, 'cs'), containerPath: SOCKET_MOUNT },
      ],
    });
    if (containerConfig.enabled) {
      ensureRoot(containerConfig.rootDir);
      // The socket directory is mounted, so it has to exist before the first
      // container is created rather than lazily when the first chat starts:
      // a bind mount of a missing path is created as a root-owned directory by
      // the engine, which the server then cannot write into.
      fs.mkdirSync(path.join(this.database.storageDir, 'cs'), { recursive: true, mode: 0o700 });
    }
    this.environments = new EnvironmentManager({
      config: containerConfig,
      hostHome: this.baseFolder,
      // Read on every provision rather than cached: the user may change it
      // from another window between two of their own sessions.
      getUserTier: (userId) => this.database.getUserSetting(userId, 'environmentTier'),
    });
    this.sessionStore = new SessionStore({ database: this.database });
    this.transcriptStore = new TranscriptStore({ storageDir: this.database.storageDir });
    this.historyStore = new HistoryStore({ storageDir: this.database.storageDir });
    this.pasteStore = new PasteStore({ storageDir: this.database.storageDir });
    // No storageDir: unlike a paste, an attachment is never swept up when the
    // session ends — a transcript still points at it — so there is no manifest
    // to keep. See services/attachment-store.ts.
    this.attachmentStore = new AttachmentStore();
    this.chatStore = new ChatStore({ storageDir: this.database.storageDir });
    this.chatManager = new ChatSessionManager({
      store: this.chatStore,
      storageDir: this.database.storageDir,
      broadcast: (sessionId, message) =>
        broadcastChat(
          sessionId,
          message,
          this.claudeSessions,
          this.webSocketConnections,
        ),
      // Chat mode spawns the same binary the terminal mode would; the bridges
      // already own that lookup and it must not be duplicated here, where it
      // would drift the first time a CLI moved.
      resolveCommand: (runtime) => {
        const bridge = this.getRuntimeBridge(runtime as AgentKind);
        const resolved = (bridge as unknown as { command?: string })?.command;
        return resolved || runtime;
      },
      // The same lookup, stopping at the name. A runtime running in a
      // container needs the name, not this machine's path to it — and the name
      // is not always the runtime's key (`agent` is `cursor-agent`).
      resolveCommandName: (runtime) => {
        const bridge = this.getRuntimeBridge(runtime as AgentKind);
        const name = (bridge as unknown as { defaultCommand?: string })?.defaultCommand;
        return name || runtime;
      },
      // The chat subsystem does not know about session records, and should not:
      // this is the one seam where a fact it learns has to outlive its process.
      onLifecycle: (sessionId, change) => {
        const record = this.claudeSessions.get(sessionId);
        if (!record) return;
        if (change.nativeSessionId) {
          record.nativeChatSessionId = change.nativeSessionId;
        }
        if (change.exited) {
          // Frees the session for a relaunch in the same tab. Without it the
          // record still claims a process that is gone, and `start_chat`
          // refuses with "A process is already running in this session".
          record.active = false;
        }
      },
    });
    this.runtimeProfiles = new RuntimeProfileStore({ database: this.database });
    this.tierContext = defaultTierContext(this.database.storageDir);
    this.sessionTeardown = new SessionTeardownRegistry();
    // Registered rather than appended to the DELETE handler, so the next
    // feature that needs teardown does not collide on the same line.
    this.sessionTeardown.register('pasted-images', (session) =>
      this.pasteStore.deletePastes(session));
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
      allowAnyGitHubUser: config.allowAnyGitHubUser,
    });
    // Installer rights follow the allow-list: a stored account that can no
    // longer sign in must not hold them, or the installer-only screens are
    // read-only for everybody.
    this.database.setInstallerEligibility((githubId) =>
      this.authService.isGitHubUserAllowed(githubId),
    );
    this.usageReader = new UsageReader(this.sessionDurationHours);
    this.usageAnalytics = new UsageAnalytics(
      createUsageAnalyticsOptions(options, this.sessionDurationHours),
    );

    this.updateChecker = new UpdateChecker({
      buildInfo: readBuildInfo(),
      settings: {
        getSetting: (key) => this.database.getSetting(key),
        setSetting: (key, value) => this.database.setSetting(key, value),
      },
      // Everyone is told a newer build exists; only the installer is offered
      // the button, and that is decided per-user in the status route rather
      // than baked into this broadcast.
      onStatus: (status) => {
        broadcastToAllConnections(
          { type: 'update_status', status },
          this.webSocketConnections,
        );
      },
    });

    this.updateMode = null;
    this.interruptedUpdate = null;
    this.selfUpdate = new SelfUpdateRunner({
      settings: {
        getSetting: (key) => this.database.getSetting(key),
        setSetting: (key, value) => this.database.setSetting(key, value),
        deleteSetting: (key) => this.database.deleteSetting(key),
      },
      onOutput: (stream, line) => {
        const installerUserId = this.database.getInstallerUserId();
        if (installerUserId !== null) {
          sendToUser(
            installerUserId,
            { type: 'update_output', stream, data: line },
            this.webSocketConnections,
          );
        }
      },
      onDone: (result) => {
        const installerUserId = this.database.getInstallerUserId();
        if (installerUserId !== null) {
          sendToUser(
            installerUserId,
            { type: 'update_done', ...result },
            this.webSocketConnections,
          );
        }
      },
      onRestarting: () => {
        // Everyone loses their agent sessions to this, not just the installer,
        // so everyone gets told before it happens.
        broadcastToAllConnections(
          { type: 'update_restarting' },
          this.webSocketConnections,
        );
      },
      beforeRestart: async () => {
        await this.saveSessionsToDisk();
        await this.messageProcessor.drainAllRecorders();
      },
    });

    this.messageProcessor = new MessageProcessor({
      dev: this.dev,
      claudeSessions: this.claudeSessions,
      webSocketConnections: this.webSocketConnections,
      baseFolder: this.baseFolder,
      sessionDurationHours: this.sessionDurationHours,
      aliases: this.aliases,
      validatePath: (targetPath: string, userId?: number) => this.validatePath(targetPath, userId),
      getUserBaseFolder: (userId?: number) => this.getUserBaseFolder(userId),
      ensureEnvironment: (userId?: number) => this.ensureEnvironment(userId),
      getSelectedWorkingDir: (userId: number) => this.getSelectedWorkingDir(userId),
      createSessionRecord: (params) => this.createSessionRecord(params),
      getRuntimeBridge: (agentKind: AgentKind) => this.getRuntimeBridge(agentKind),
      saveSessionsToDisk: () => this.saveSessionsToDisk(),
      resolveRuntimeProfile: (agentKind: AgentKind, workingDir: string) =>
        this.resolveRuntimeProfile(agentKind, workingDir),
      transcriptStore: this.transcriptStore,
      historyStore: this.historyStore,
      chatManager: this.chatManager,
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
    this.setupEnvironmentSweep();
  }

  /**
   * The root a user's paths are measured against.
   *
   * With per-user environments on, that is the user's own home — which is what
   * makes "files a user creates are invisible to another user" a property of
   * the app and not only of the container: every path check below is against a
   * different directory for every account. Without them it is the single
   * folder the server was started in, exactly as before.
   */
  private getUserBaseFolder(userId?: number): string {
    if (!this.environments.enabled || userId === undefined) {
      return this.baseFolder;
    }
    const owner = this.getEnvironmentOwner(userId);
    return owner ? this.environments.homeDirFor(owner) : this.baseFolder;
  }

  private getEnvironmentOwner(userId: number): { id: number; githubLogin: string } | null {
    const user = this.database.getUserById(userId);
    return user ? { id: user.id, githubLogin: user.githubLogin } : null;
  }

  /**
   * The environment for a user, ready to run something in.
   *
   * Falls back to the host when the engine cannot produce one: a broken Docker
   * is an operational failure, and dropping the user onto the host silently
   * would be an isolation failure — so it is loud in the log and the caller
   * still gets a usable session rather than a blank screen.
   */
  private async ensureEnvironment(userId?: number): Promise<UserEnvironment> {
    if (!this.environments.enabled || userId === undefined) {
      return this.environments.host();
    }
    const owner = this.getEnvironmentOwner(userId);
    if (!owner) {
      return this.environments.host();
    }
    try {
      return await this.environments.ensureFor(owner);
    } catch (error) {
      console.error(`Could not prepare an environment for ${owner.githubLogin}:`, error);
      throw error;
    }
  }

  private isPathWithinBase(targetPath: string, userId?: number): boolean {
    try {
      const resolvedTarget = path.resolve(targetPath);
      const resolvedBase = path.resolve(this.getUserBaseFolder(userId));
      return (
        resolvedTarget === resolvedBase
        || resolvedTarget.startsWith(`${resolvedBase}${path.sep}`)
      );
    } catch {
      return false;
    }
  }

  private validatePath(targetPath: string, userId?: number): PathValidation {
    if (!targetPath) {
      return { valid: false, error: 'Path is required' };
    }

    const resolvedPath = path.resolve(targetPath);
    if (!this.isPathWithinBase(resolvedPath, userId)) {
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
    ownerSessionId?: string;
  }): SessionRecord {
    return {
      id: params.id,
      ownerSessionId: params.ownerSessionId,
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
      termCols: 80,
      termRows: 24,
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
      case 'pi':
        return this.piBridge;
      case 'grok':
        return this.grokBridge;
      case 'qwen':
        return this.qwenBridge;
      case 'kimi':
        return this.kimiBridge;
      case 'omp':
        return this.ompBridge;
      case 'terminal':
        return this.terminalBridge;
      case 'claude':
        return this.claudeBridge;
      default:
        return null;
    }
  }

  /**
   * Resolve the active profile for a runtime into launch parameters.
   *
   * Tiers are written through here as well as on save: the generated file has
   * to exist on disk before the process starts, and a profile saved by an
   * earlier build (or a data directory restored from backup) may never have
   * been through the save path at all.
   */
  private resolveRuntimeProfile(agentKind: AgentKind, workingDir: string): {
    profileName: string;
    model?: string;
    extraArgs?: string[];
    env?: Record<string, string>;
  } | null {
    const profile = this.runtimeProfiles.activeFor(agentKind);
    if (!profile) return null;

    // The session's directory is where pi's tier agents go, so it is part of
    // the context rather than something the writer could guess.
    const tierResult = applyTiers(profile, { ...this.tierContext, workingDir });
    for (const skipped of tierResult.skipped) {
      console.warn(
        `Runtime profile "${profile.name}": left ${skipped.file} alone (${skipped.reason})`,
      );
    }

    const extraArgs = [...tierResult.args, ...(profile.args || [])];

    return {
      profileName: profile.name,
      model: profile.model,
      extraArgs: extraArgs.length ? extraArgs : undefined,
      env: profile.env,
    };
  }

  /**
   * Cached: detection shells out to `npm root -g` and `systemctl is-active`,
   * and neither answer changes while the process is alive.
   */
  private getUpdateMode(): UpdateModeResult {
    if (!this.updateMode) {
      this.updateMode = detectUpdateMode();
    }
    return this.updateMode;
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
      let discarded = 0;
      for (const [id, session] of sessions) {
        // A shell that belonged to a conversation is not restored. Its pty died
        // with the previous process, and nothing lists it: the only thing that
        // ever pointed at it was one browser's note of which session its pane
        // was attached to, which is no longer true. Keeping the record would
        // leave a row nobody can reach and a transcript nobody will read.
        if (session.ownerSessionId) {
          discarded++;
          void this.transcriptStore.deleteTranscript(session);
          void this.historyStore.deleteHistory(session);
          this.sessionTeardown.dispose(session);
          continue;
        }
        this.claudeSessions.set(id, session);
      }
      if (this.claudeSessions.size > 0) {
        console.log(`Loaded ${this.claudeSessions.size} persisted sessions`);
      }
      if (discarded > 0) {
        // The rows go on the next autosave, which prunes anything not in the map.
        void this.saveSessionsToDisk();
      }
    } catch (error) {
      console.error('Failed to load persisted sessions:', error);
    }
  }

  /**
   * Stop environments nobody has used lately.
   *
   * Safe because the data is on the host: a stopped environment starts again
   * on the owner's next session with their home exactly as they left it, so
   * this is a resource decision rather than a lifecycle one. Runs on a
   * fixed minute tick rather than at the configured interval so that changing
   * the idle window does not mean restarting the server to feel it.
   */
  private setupEnvironmentSweep(): void {
    if (!this.environments.enabled) {
      return;
    }
    this.environmentScale = setInterval(() => {
      void this.environments.sampleAndScale((userId) => this.userHasLiveSession(userId))
        .then((changes) => {
          for (const change of changes) {
            console.log(
              `Environment ${change.name}: ${change.from} → ${change.to} (${change.reason}) [${change.outcome}]`,
            );
            // Told, not discovered: a size that changes under someone without
            // a word is indistinguishable from the machine misbehaving.
            sendToUser(
              change.userId,
              {
                type: 'environment_tier_changed',
                tier: change.to,
                previousTier: change.from,
                reason: change.reason,
                outcome: change.outcome,
              },
              this.webSocketConnections,
            );
          }
        })
        .catch((error) => {
          console.error('Automatic environment sizing failed:', error);
        });
    }, 30_000);
    this.environmentScale.unref?.();

    this.environmentSweep = setInterval(() => {
      void this.environments.sweepIdle((userId) => this.userHasLiveSession(userId)).then((stopped) => {
        for (const name of stopped) {
          console.log(`Stopped idle environment ${name}`);
        }
      }).catch((error) => {
        console.error('Idle environment sweep failed:', error);
      });
    }, 60_000);
    // Never the reason the process stays up.
    this.environmentSweep.unref?.();
  }

  /** Whether anything is running for this user right now. */
  private userHasLiveSession(userId: number): boolean {
    for (const session of this.claudeSessions.values()) {
      if (session.ownerUserId === userId && session.active) {
        return true;
      }
    }
    return false;
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
    // Let the emulators finish parsing and flush; a bare flush would miss
    // whatever is still queued in the parser.
    await this.messageProcessor.drainAllRecorders();
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval);
      this.autoSaveInterval = null;
    }
    if (this.environmentSweep) {
      clearInterval(this.environmentSweep);
      this.environmentSweep = null;
    }
    if (this.environmentScale) {
      clearInterval(this.environmentScale);
      this.environmentScale = null;
    }
    // Stopped, never removed: the containers are this server's to start and
    // stop, but the data in them is the users' and a restart has to find it.
    if (this.environments.enabled) {
      await this.environments.stopAll();
    }
    this.updateChecker.stop();

    if (this.wss) {
      // close() stops accepting new connections but leaves established ones
      // open, which keeps the HTTP server from ever closing.
      for (const client of this.wss.clients) {
        try {
          client.terminate();
        } catch {
          // Already gone.
        }
      }
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
      // The port is held by the demultiplexer, not by the https server, so it
      // is the one that has to be closed; closing the https server would return
      // immediately and leave the address in use on the next start.
      const bound = this.listener || this.server;
      if (bound && bound.listening) {
        // close() waits for every open connection, and a WebSocket is never
        // idle, so shutdown would hang forever with any client attached. Close
        // the WebSocket server (which terminates its sockets) first, and keep a
        // deadline as a backstop.
        const timeout = setTimeout(() => resolve(), 5000);
        timeout.unref?.();

        bound.close(() => {
          clearTimeout(timeout);
          resolve();
        });
      } else {
        resolve();
      }
    });

    this.listener = null;
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

    // The local CA, offered before sign-in on purpose: a device that does not
    // trust it cannot complete a TLS handshake it would believe, so requiring a
    // login first would be a lock whose key is behind the lock. It is a public
    // certificate and carries no private key.
    this.app.get('/ca.crt', caCertificateHandler(() => this.caFile));

    this.app.get('/manifest.json', (_req, res) => {
      res.setHeader('Content-Type', 'application/manifest+json');
      res.sendFile('manifest.json', { root: publicDir });
    });

    // Must come before express.static: `index: false` only disables directory
    // index resolution, so a direct GET /index.html would still be served by
    // the static middleware and skip requireAuth entirely.
    this.app.get(
      ['/', '/index.html'],
      this.authService.requireAuth(),
      (_req, res) => {
        res.sendFile('index.html', { root: publicDir });
      },
    );

    this.app.use(express.static(publicDir, { index: false }));

    // The icons used to be generated here: one route answered both /icon-N.svg
    // and /icon-N.png with the same SVG document. That is why the app could not
    // be installed on iOS — apple-touch-icon must be a real PNG and Safari
    // ignores anything else — and why the mark was still the old palette long
    // after the UI stopped using it. They are designed assets under
    // src/public/icons now, rasterised from assets/icon.svg at build time and
    // served by express.static above with the right content types.

    registerRoutes(this.app, {
      claudeSessions: this.claudeSessions,
      webSocketConnections: this.webSocketConnections,
      folderMode: this.folderMode,
      baseFolder: this.baseFolder,
      aliases: this.aliases,
      dev: this.dev,
      validatePath: (targetPath: string, userId?: number) => this.validatePath(targetPath, userId),
      isPathWithinBase: (targetPath: string, userId?: number) =>
        this.isPathWithinBase(targetPath, userId),
      getUserBaseFolder: (userId?: number) => this.getUserBaseFolder(userId),
      ensureEnvironment: (userId?: number) => this.ensureEnvironment(userId),
      environments: this.environments,
      getUserEnvironmentTier: (userId: number) => this.database.getUserSetting(userId, 'environmentTier'),
      setUserEnvironmentTier: (userId: number, tier: string | null) => {
        if (tier) {
          this.database.setUserSetting(userId, 'environmentTier', tier);
        } else {
          this.database.deleteUserSetting(userId, 'environmentTier');
        }
      },
      userHasLiveSession: (userId: number) => this.userHasLiveSession(userId),
      getSelectedWorkingDir: (userId: number) => this.getSelectedWorkingDir(userId),
      setSelectedWorkingDir: (userId: number, value: string | null) =>
        this.setSelectedWorkingDir(userId, value),
      createSessionRecord: (params) => this.createSessionRecord(params),
      getRuntimeBridge: (agentKind: AgentKind) => this.getRuntimeBridge(agentKind),
      saveSessionsToDisk: () => this.saveSessionsToDisk(),
      transcriptStore: this.transcriptStore,
      historyStore: this.historyStore,
      sessionTeardown: this.sessionTeardown,
      pasteStore: this.pasteStore,
      attachmentStore: this.attachmentStore,
      runtimeProfiles: this.runtimeProfiles,
      tierContext: this.tierContext,
      updateChecker: this.updateChecker,
      selfUpdate: this.selfUpdate,
      getUpdateMode: () => this.getUpdateMode(),
      getInstallerUserId: () => this.database.getInstallerUserId(),
      getInterruptedUpdate: () => {
        // Reported once and then forgotten. Left set, it would keep the banner
        // in its error state — which offers no Update button — for the rest of
        // the process's life, so the interrupted update could never be
        // retried from the browser.
        const interrupted = this.interruptedUpdate;
        this.interruptedUpdate = null;
        return interrupted;
      },
      getScreenSnapshot: (sessionId: string) =>
        this.messageProcessor.getScreenSnapshot(sessionId),
      disposeRecorder: (sessionId: string) => this.messageProcessor.disposeRecorder(sessionId),
      sessionStore: this.sessionStore,
      // For listing past conversations in a folder.
      chatStore: this.chatStore,
      // For the status panel. Passed rather than reached for so a build that
      // does not track usage simply has no plan section, instead of a section
      // full of zeros that reads as "nothing left".
      usageAnalytics: this.usageAnalytics,
      usageReader: this.usageReader,
    });

  }

  /**
   * Run the interactive setup when needed, and let the caller know whether the
   * server should still be started in this process.
   *
   * Returns false when the user chose to install a background service: the
   * systemd unit now owns the port, so binding it here too would fail with
   * EADDRINUSE immediately after a success message.
   */
  async runSetupIfNeeded(): Promise<boolean> {
    const needsAuthSetup = this.setup || !this.authService.isConfigured();
    if (!needsAuthSetup) {
      return true;
    }

    const session = new PromptSession();
    try {
      await this.authService.ensureConfiguredInteractive(this.setup, session);

      const action = await runRunModeWizard(
        {
          port: this.port,
          dataDir: this.dataDir,
          cwd: process.cwd(),
        },
        session,
      );
      return action === 'run-foreground';
    } finally {
      session.close();
    }
  }

  async start(): Promise<http.Server | https.Server> {
    await this.loadPersistedSessions();

    // A marker left behind means a previous update was killed part-way — host
    // reboot, OOM, an outside restart — so the global prefix may be half
    // written. Surface it instead of letting the banner claim all is well.
    this.interruptedUpdate = this.selfUpdate.takeInterrupted();
    if (this.interruptedUpdate) {
      console.warn(
        'A previous self-update did not finish. If the server misbehaves, reinstall with:\n'
        + `  ${INSTALL_COMMAND}`,
      );
    }

    // Deliberately not awaited, and delayed: a first-run install should reach
    // "listening" without waiting on GitHub.
    const firstCheck = setTimeout(() => {
      void this.updateChecker.check(false).catch(() => undefined);
    }, 60_000);
    firstCheck.unref?.();
    this.updateChecker.start();

    // Embedders may call start() directly without going through
    // runSetupIfNeeded(); this stays as the safety net.
    await this.authService.ensureConfiguredInteractive(false);

    // HTTPS is not optional. A plain-http origin that is not localhost is not a
    // secure context, and the browser then withholds the service worker — so no
    // installable app, no offline shell, no clipboard, no notifications. Those
    // all worked when tested at http://localhost and were missing for anyone
    // opening the same server at http://192.168.x.x, which is the normal way to
    // use it. An explicit --cert/--key pair still wins; otherwise a local CA is
    // generated in the data directory.
    if (this.certFile && !this.keyFile) {
      throw new Error('--cert was given without --key; a certificate needs both.');
    }
    if (this.keyFile && !this.certFile) {
      throw new Error('--key was given without --cert; a certificate needs both.');
    }

    if (!this.certFile || !this.keyFile) {
      const material = ensureCertificates(this.dataDir);
      this.certFile = material.certFile;
      this.keyFile = material.keyFile;
      this.caFile = material.caFile;
      if (material.issued) {
        console.log(`Issued a TLS certificate for: ${material.hosts.join(', ')}`);
      }
    }

    const secure = https.createServer(
      { cert: fs.readFileSync(this.certFile), key: fs.readFileSync(this.keyFile) },
      this.app,
    );

    this.wss = new WebSocket.Server({ server: secure });
    this.wss.on('connection', (ws: WebSocket, req) => {
      this.wsHandler.handleConnection(ws, req);
    });

    const server = createHttpsOnlyPort(secure);

    return await new Promise((resolve, reject) => {
      server.listen(this.port, () => {
        this.server = secure;
        this.listener = server;
        resolve(secure);
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
