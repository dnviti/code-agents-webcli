import express from 'express';
import http from 'http';
import https from 'https';
import net from 'net';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
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
  SessionStorageScope,
} from './types.js';
import { createConfig, createUsageAnalyticsOptions } from './config.js';
import { registerRoutes } from './routes/index.js';
import {
  retireProjectSessions,
  suspendProjectSessions,
  type SessionRoutesDeps,
} from './routes/sessions.js';
import {
  ResolvedProfile,
  resolveConversationRung,
} from '../shared/runtime-profiles.js';
import { RuntimeProfileStore } from './services/runtime-profiles.js';
import {
  TierWriterContext,
  applyTiers,
  defaultTierContext,
  supportsTiers,
  tierCapableRuntimes,
} from './services/tier-writer.js';
import { WebSocketHandler } from './websocket/handler.js';
import { MessageProcessor } from './websocket/messages.js';
import { AccountTabCoordinator } from './services/account-tab-coordinator.js';
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
import { AntigravityBridge } from './bridges/antigravity.js';
import { TerminalBridge } from './bridges/terminal.js';
import { AppDatabase, resolveAppDataDir } from './services/database.js';
import {
  DATA_DIR_LEASE_LOST_EXIT_CODE,
  DataDirLease,
} from './services/data-dir-lease.js';
import { SessionStore } from './services/session-store.js';
import { canonicalExistingRoot, WorkspaceCatalog } from './services/workspace-catalog.js';
import {
  closeWorkspaceSessionDirectoryLease,
  closeWorkspaceSessionDirectoryLeases,
  closeWorkspaceSessionDirectoryLeasesForScope,
  openWorkspaceStorageDirectorySync,
} from './services/workspace-session-storage.js';
import { closeWorkspaceCwdHelpers } from './services/workspace-cwd-helper.js';
import { UsageStore } from './services/usage-store.js';
import { CodexPricing } from './services/codex-pricing.js';
import { TranscriptStore } from './services/transcript-store.js';
import { HistoryStore } from './services/history-store.js';
import { SessionTeardownRegistry } from './services/session-teardown.js';
import { PasteStore } from './services/paste-store.js';
import { AttachmentStore, type AttachmentStoreLike } from './services/attachment-store.js';
import { ProjectAwareAttachmentStore } from './services/project-attachment-store.js';
import { isChatAttachmentUploadRequest } from './routes/chat-attachments.js';
import { readBuildInfo } from './services/build-info.js';
import {
  createServerIdentity,
  normalizeDiscoverableAddress,
  registerServerIdentityRoute,
  type ServerIdentity,
} from './services/server-identity.js';
import { LanDiscoveryResponder } from './services/lan-discovery.js';
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
import { AuthService, DESKTOP_AUTH_COOKIE_NAME } from './services/auth.js';
import {
  APP_MOUNT,
  EnvironmentManager,
  SOCKET_MOUNT,
  createContainerConfig,
  createEngine,
  ensureRoot,
} from './services/environments/index.js';
import { ContainerConfig, Mount, UserEnvironment } from './services/environments/types.js';
import { ActiveTargetResolution, EnvironmentEngine } from './services/environments/index.js';
import { EncryptionKeyRing, validateEncryptionKeyMaterial } from './services/encryption.js';
import { DeployTargetStore } from './services/deploy-targets.js';
import { ProjectStore, type Project } from './services/projects/store.js';
import {
  ProjectManager,
  type ProjectWorkspaceReplacementAuthority,
} from './services/projects/manager.js';
import {
  ProjectEnvironmentManager,
  ProjectWorkspaceSessionStorageError,
  type WorkspaceSessionStorageIdentity,
} from './services/projects/environment.js';
import { RepositoryInspector } from './services/composition/repository-inspector.js';
import { DefaultCompositionRuntime } from './services/composition/runtime.js';
import { StorageUsageManager } from './services/storage-usage-manager.js';
import { ConnectedHostValidator } from './services/connected-host-validator.js';
import { UsageReader } from './services/usage-reader.js';
import { UsageAnalytics } from './services/usage-analytics.js';
import { readCachedClaudeAccount } from './services/claude-account.js';
import { UserPreferenceStore } from './services/user-preferences.js';
import {
  AgentMaintenanceService,
  agentMaintenanceExecutionKey,
  type AgentMaintenanceTarget,
  managedVersionRoot,
} from './services/agent-maintenance.js';
import {
  EnvironmentAgentRuntime,
  JsonFileAgentMaintenanceStore,
  OfficialAgentReleaseSource,
  OfficialScriptAgentInstaller,
  childProcessRunner,
  officialFetch,
  safeProcessEnvironment,
  type AgentCommandRunner,
} from './services/agent-maintenance-runtime.js';
import {
  AGENT_MAINTENANCE_IDS,
  agentCatalogEntry,
  type AgentArchitecture,
  type AgentMaintenanceId,
  type AgentPlatform,
} from '../shared/agent-maintenance.js';

/** Probe exactly the launch executable without inheriting server/provider secrets. */
export async function probeLaunchedAgentVersion(
  environment: UserEnvironment,
  agentKind: AgentKind,
  selectedCommand?: string,
  runner: AgentCommandRunner = childProcessRunner,
): Promise<string | null> {
  if (agentKind === 'terminal') return null;
  const entry = agentCatalogEntry(agentKind);
  if (!entry) return null;
  const command = selectedCommand || entry.binary;
  try {
    const wrapped = environment.wrap(command, [...entry.versionArgs], {
      env: environment.kind === 'host' ? safeProcessEnvironment() : {},
      inheritHostEnv: false,
    });
    const result = await runner.run(wrapped.command, wrapped.args, {
      env: wrapped.env,
      timeoutMs: 2_000,
      inheritEnv: false,
      windowsVerbatimArguments: wrapped.windowsVerbatimArguments,
    });
    const match = `${result.stdout}\n${result.stderr}`
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '')
      .match(/v?([0-9]+(?:\.[0-9A-Za-z.+-]+)+)/u);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Fold what a chat session learned about itself into the record that outlives it.
 *
 * Free-standing so the rule it encodes can be checked without a server: an
 * absent `nativeSessionId` is "nothing to say about the id", and a null one is
 * "this conversation no longer has one". The distinction is the whole of #43 —
 * while only a truthy id could be written here, a cleared conversation kept the
 * id of the conversation it replaced, and the resume banner offered to take the
 * user back into the memory the clear had just destroyed.
 */
export function applyChatLifecycle(
  record: SessionRecord,
  change: {
    nativeSessionId?: string | null;
    exited?: boolean;
    bypassing?: boolean;
    planMode?: boolean;
  },
  writeActive?: (sessionId: string, active: boolean) => void | Promise<void>,
): void {
  if (change.nativeSessionId !== undefined) {
    record.nativeChatSessionId = change.nativeSessionId || undefined;
  }
  if (change.bypassing !== undefined) {
    // A conversation replaced in place decides its own approval mode again, so
    // the grant on the record has to be corrected to the one actually running.
    // Without it, a conversation cleared down to asking would still be recorded
    // as bypassing, and the next resume would restore a permission it no longer
    // had — the exact silent widening this rule exists to prevent (#134).
    record.chatBypassPermissions = change.bypassing;
  }
  if (change.planMode !== undefined) {
    record.chatPlanMode = change.planMode;
  }
  if (change.exited === true) {
    // Frees the session for a relaunch in the same tab. Without it the
    // record still claims a process that is gone, and `start_chat`
    // refuses with "A process is already running in this session".
    record.active = false;
  }
  if (change.exited === false) {
    // A conversation replaced in place — `/clear` and the composer's New
    // chat button — never passes through the launcher, so this is the
    // only thing that puts the record back. Without it a tab you are
    // sitting in, with an agent answering, is listed as finished.
    record.active = true;
    record.lastActivity = new Date();
  }
  if (change.exited !== undefined) {
    void writeActive?.(record.id, !change.exited);
  }
}

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
  private host: string | undefined;
  private dev: boolean;
  private useHttps: boolean;
  private readonly desktop: ServerOptions['desktop'] | null;
  private certFile: string | undefined;
  private keyFile: string | undefined;
  private setup: boolean;
  private dataDir: string | null;
  private folderMode: boolean;
  private baseFolder: string;
  private publicBaseUrl: string | null;
  private readonly serverIdentity: ServerIdentity;
  private readonly lanDiscovery: LanDiscoveryResponder;
  private sessionDurationHours: number;
  private aliases: Aliases;

  private startTime: number;
  private isShuttingDown: boolean;
  private autoSaveInterval: ReturnType<typeof setInterval> | null;

  private claudeSessions: Map<string, SessionRecord>;
  private webSocketConnections: Map<string, WebSocketInfo>;
  private tabCoordinator: AccountTabCoordinator;

  private claudeBridge: BridgeInterface;
  private codexBridge: BridgeInterface;
  private agentBridge: BridgeInterface;
  private piBridge: BridgeInterface;
  private grokBridge: BridgeInterface;
  private qwenBridge: BridgeInterface;
  private kimiBridge: BridgeInterface;
  private ompBridge: BridgeInterface;
  private antigravityBridge: BridgeInterface;
  private terminalBridge: TerminalBridge;

  private database: AppDatabase;
  /** Held before AppDatabase opens and until every data-directory writer closes. */
  private dataDirLease: DataDirLease | null;
  private dataDirWritersClosed: boolean;
  private startAttempted: boolean;
  private startInProgress: boolean;
  private shutdownRequested: boolean;
  private shutdownExecution: Promise<void> | null;
  /** True only after runtime/network teardown reached retryable storage closes. */
  private shutdownFinalizationPending: boolean;
  private shutdownTerminalError: unknown | null;
  private shutdownWaiter: {
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: unknown) => void;
  } | null;
  private usageStore: UsageStore;
  private codexPricing: CodexPricing;
  private sessionStore: SessionStore;
  private workspaceCatalog: WorkspaceCatalog;
  private transcriptStore: TranscriptStore;
  private chatStore: ChatStore;
  private chatManager: ChatSessionManager;
  private historyStore: HistoryStore;
  private pasteStore: PasteStore;
  private attachmentStore: AttachmentStoreLike;
  private runtimeProfiles: RuntimeProfileStore;
  private userPreferences: UserPreferenceStore;
  private tierContext: TierWriterContext;
  private sessionTeardown: SessionTeardownRegistry;
  private authService: AuthService;
  private usageReader: UsageReader;
  private usageAnalytics: UsageAnalytics;
  private updateChecker: UpdateChecker;
  private selfUpdate: SelfUpdateRunner;
  private updateMode: UpdateModeResult | null;
  private interruptedUpdate: InterruptedUpdate | null;
  private agentMaintenance: AgentMaintenanceService;
  private agentMaintenanceRuntime: EnvironmentAgentRuntime;
  /** Exact environments captured by target resolution; operations outlive requests. */
  private agentMaintenanceEnvironments: Map<string, UserEnvironment>;
  private agentMaintenanceArchitectures: Map<string, AgentArchitecture>;

  private app: express.Express;
  private server: http.Server | https.Server | null;
  /**
   * The socket actually bound to the port. It is not the https server: that one
   * is fed connections by the demultiplexer in createTlsPort(), so it never
   * listens and closing it alone would leave the port held.
   */
  private listener: net.Server | null;
  /** Raw demultiplexer sockets, including clients that have sent no TLS byte. */
  private listenerSockets: Set<net.Socket>;
  /** The local CA, when one was generated; offered at /ca.crt for other devices. */
  private caFile: string | undefined;
  private wss: WebSocket.Server | null;

  private wsHandler: WebSocketHandler;
  private messageProcessor: MessageProcessor;
  private environments: EnvironmentManager;
  private readonly containerizedEnvironmentsEnabled: boolean;
  private encryptionKeyRing: EncryptionKeyRing;
  private deployTargets: DeployTargetStore;
  private projectStore: ProjectStore;
  private projects: ProjectManager;
  private projectPaths: ProjectEnvironmentManager;
  private loadedWorkspaceScopes: Set<string>;
  private workspacePersistenceErrors: Map<string, string>;
  /** Exact `.cc-web` inode admitted for each live global metadata scope. */
  private workspaceArtifactIdentities: Map<string, WorkspaceSessionStorageIdentity>;
  private suspendedProjectScopes: Map<string, SessionStorageScope>;
  /** Project archives whose crash-staging slot could not be restored safely. */
  private unrestoredProjectScopes: Set<string>;
  /** Cold-start intents awaiting a database open bound to their exact inode. */
  private storageUsage: StorageUsageManager;
  private connectedHostValidator: ConnectedHostValidator;
  /** The startup-flag configuration: the 'legacy' entry in the target maps. */
  private legacyContainerConfig: ContainerConfig;
  /** Mounts every environment gets, targets included: app code and the socket dir. */
  private environmentExtraMounts: Mount[];
  /**
   * The target set the manager currently places work with.
   *
   * Doubles as the cache `resolveActiveDeployTarget` reads: `enabled` and the
   * tier getters consult it on every call, so the "targets exist?" and
   * "which is active?" answers are memoized here and rebuilt by
   * `reloadDeployTargets` — the one path every target mutation goes through —
   * rather than re-queried from SQLite each time.
   */
  private deployTargetMaps: {
    engines: Map<string, EnvironmentEngine>;
    configs: Map<string, ContainerConfig>;
    activeKey: string | null;
    targetsExist: boolean;
    targetNames: Map<string, string>;
  };
  private environmentSweep: ReturnType<typeof setInterval> | null = null;
  private environmentScale: ReturnType<typeof setInterval> | null = null;

  constructor(options: ServerOptions = {}) {
    const config = createConfig(options);
    if (config.desktop && config.host !== '127.0.0.1') {
      throw new Error('Desktop mode must bind exactly to 127.0.0.1.');
    }
    if (config.certFile && !config.keyFile) {
      throw new Error('--cert was given without --key; a certificate needs both.');
    }
    if (config.keyFile && !config.certFile) {
      throw new Error('--key was given without --cert; a certificate needs both.');
    }
    if (config.encryptionKey) validateEncryptionKeyMaterial(config.encryptionKey);
    // AppDatabase performs schema migrations in its constructor. The
    // installation-wide lease must therefore precede even that constructor,
    // not merely the later workspace-session restoration in start().
    this.dataDirLease = DataDirLease.acquireSync(resolveAppDataDir(config.dataDir), {
      onLost: (error) => this.failStopDataDirLease(error),
    });
    this.dataDirWritersClosed = false;
    this.startAttempted = false;
    this.startInProgress = false;
    this.shutdownRequested = false;
    this.shutdownExecution = null;
    this.shutdownFinalizationPending = false;
    this.shutdownTerminalError = null;
    this.shutdownWaiter = null;
    let dataDirWriterConstructionStarted = false;
    try {
    this.port = config.port;
    this.host = config.host;
    this.desktop = config.desktop;
    this.dev = config.dev;
    this.useHttps = config.useHttps;
    this.certFile = config.certFile;
    this.keyFile = config.keyFile;
    this.setup = config.setup;
    this.folderMode = config.folderMode;
    this.baseFolder = config.baseFolder;
    this.publicBaseUrl = config.publicBaseUrl;
    this.serverIdentity = createServerIdentity({
      serverName: config.serverName,
      // `publicDiscoverableUrl` is the deliberately explicit contract. The
      // OAuth base URL remains a compatibility fallback for existing hosted
      // installations, and localhost is safe but never advertised over LAN.
      address: config.publicDiscoverableUrl
        || normalizeDiscoverableAddress(config.publicBaseUrl)
        || `https://localhost:${config.port}`,
      version: readBuildInfo().version,
    });
    this.lanDiscovery = new LanDiscoveryResponder({
      enabled: !config.desktop && config.lanDiscoverable && config.publicDiscoverableUrl !== null,
      identity: this.serverIdentity,
      onError: (error) => console.warn(`LAN discovery responder error: ${error.message}`),
    });
    this.sessionDurationHours = config.sessionDurationHours;
    this.aliases = config.aliases;
    this.startTime = config.startTime;
    this.isShuttingDown = config.isShuttingDown;
    this.containerizedEnvironmentsEnabled = config.containerizedEnvironmentsEnabled;

    this.autoSaveInterval = null;
    this.server = null;
    this.listener = null;
    this.listenerSockets = new Set();
    this.caFile = undefined;
    this.wss = null;

    this.claudeSessions = new Map();
    this.webSocketConnections = new Map();
    this.tabCoordinator = new AccountTabCoordinator();
    this.loadedWorkspaceScopes = new Set();
    this.workspacePersistenceErrors = new Map();
    this.workspaceArtifactIdentities = new Map();
    this.suspendedProjectScopes = new Map();
    this.unrestoredProjectScopes = new Set();

    this.claudeBridge = new ClaudeBridge();
    this.codexBridge = new CodexBridge();
    this.agentBridge = new AgentBridge();
    this.piBridge = new PiBridge();
    this.grokBridge = new GrokBridge();
    this.qwenBridge = new QwenBridge();
    this.kimiBridge = new KimiBridge();
    this.ompBridge = new OmpBridge();
    this.antigravityBridge = new AntigravityBridge();
    this.terminalBridge = new TerminalBridge();

    this.dataDir = config.dataDir;
    dataDirWriterConstructionStarted = true;
    // One per-user database owns global configuration, session metadata and
    // usage. Project `.cc-web` trees contain only project-scoped file bodies.
    this.database = new AppDatabase({ dataDir: config.dataDir });
    this.workspaceCatalog = new WorkspaceCatalog(this.database);
    this.usageStore = new UsageStore(this.database);
    // The codex list-price catalogue (issue #182). Constructed with the app
    // database so fetched official prices persist across restarts; `start()` is
    // called once the server is up (see setupExpress) and `stop()` on shutdown.
    this.codexPricing = new CodexPricing({ database: this.database });

    // Per-user environments. Off unless an administrator asked for them, in
    // which case every process this server starts on a user's behalf goes into
    // that user's container instead of onto this machine.
    //
    // Two host directories travel with every environment besides the user's
    // home: the app's own compiled code, so the approval hook and the question
    // MCP server can be executed by a runtime that is not on this machine, and
    // the directory their unix sockets live in, so it can dial back.
    this.environmentExtraMounts = [
      { hostPath: appRootDir(), containerPath: APP_MOUNT, readOnly: true },
      { hostPath: path.join(this.database.storageDir, 'cs'), containerPath: SOCKET_MOUNT },
    ];
    const containerConfig = createContainerConfig({
      featureEnabled: this.containerizedEnvironmentsEnabled,
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
      extraMounts: this.environmentExtraMounts,
    });
    this.legacyContainerConfig = containerConfig;

    // Deploy targets: where containers run once an administrator configures
    // them. The key ring comes first — the store encrypts every secret it
    // saves with it — and the legacy seed runs once ever, capturing the
    // startup flags as a 'default' target before the manager is built so the
    // very first boot already resolves through the table.
    this.encryptionKeyRing = new EncryptionKeyRing({
      settings: this.database,
      key: config.encryptionKey,
      warn: (message) => console.warn(message),
    });
    this.deployTargets = new DeployTargetStore({
      database: this.database,
      keyRing: this.encryptionKeyRing,
      dataDir: this.database.storageDir,
    });
    this.projectStore = new ProjectStore({
      database: this.database,
      keyRing: this.encryptionKeyRing,
    });
    this.projectStore.failInterruptedCompositionInstallations();
    if (this.containerizedEnvironmentsEnabled) {
      this.deployTargets.seedLegacyTarget(
        containerConfig,
        this.database.getInstallerUserId() ?? undefined,
      );
      // Plaintext materialization (kubeconfig, TLS PEMs) exists only to drive
      // engines; it is refreshed here so an edit made offline still reaches the
      // engine after a restart.
      this.deployTargets.materializeAllSecrets();
    }

    const targetsExist = this.containerizedEnvironmentsEnabled
      && this.deployTargets.listTargets().length > 0;
    if (containerConfig.enabled || targetsExist) {
      ensureRoot(containerConfig.enabled
        ? containerConfig.rootDir
        : path.join(this.database.storageDir, 'environments'));
      // The socket directory is mounted, so it has to exist before the first
      // container is created rather than lazily when the first chat starts:
      // a bind mount of a missing path is created as a root-owned directory by
      // the engine, which the server then cannot write into.
      fs.mkdirSync(path.join(this.database.storageDir, 'cs'), { recursive: true, mode: 0o700 });
    }
    this.deployTargetMaps = this.buildDeployTargetMaps();
    this.environments = new EnvironmentManager({
      config: containerConfig,
      featureEnabled: this.containerizedEnvironmentsEnabled,
      hostHome: this.baseFolder,
      // Read on every provision rather than cached: the user may change it
      // from another window between two of their own sessions.
      getUserTier: (userId) => this.database.getUserSetting(userId, 'environmentTier'),
      // Consulted on every ensure: an empty table resolves to the startup
      // configuration exactly as before this feature existed, a table without
      // an active target resolves to nothing and work fails loudly.
      resolveActive: () => this.resolveActiveDeployTarget(),
      engines: this.deployTargetMaps.engines,
      configs: this.deployTargetMaps.configs,
      activeKey: this.deployTargetMaps.activeKey,
    });
    this.agentMaintenanceEnvironments = new Map();
    this.agentMaintenanceArchitectures = new Map();
    this.agentMaintenanceRuntime = new EnvironmentAgentRuntime({
      dataDir: this.database.storageDir,
      environmentFor: async (target) => {
        const environment = this.agentMaintenanceEnvironments.get(target.key);
        if (!environment) throw new Error('The selected execution environment is no longer available.');
        return environment;
      },
    });
    const maintenanceInstaller = new OfficialScriptAgentInstaller({
      runtime: this.agentMaintenanceRuntime,
      fetcher: officialFetch,
    });
    this.agentMaintenance = new AgentMaintenanceService({
      store: new JsonFileAgentMaintenanceStore(
        path.join(this.database.storageDir, 'agent-maintenance'),
      ),
      probe: this.agentMaintenanceRuntime,
      releases: new OfficialAgentReleaseSource(officialFetch),
      installer: maintenanceInstaller,
      rootFor: (target, agent, version) => {
        const environment = this.agentMaintenanceEnvironments.get(target.key);
        const base = target.scope === 'private' && environment
          ? path.join(environment.homeDir, '.code-agents')
          : this.database.storageDir;
        return managedVersionRoot(base, target, agent, version);
      },
    });
    this.sessionStore = new SessionStore({
      database: this.database,
      scopedGlobalStore: true,
    });
    this.transcriptStore = new TranscriptStore({ storageDir: this.database.storageDir });
    this.historyStore = new HistoryStore({ storageDir: this.database.storageDir });
    this.pasteStore = new PasteStore({ storageDir: this.database.storageDir });
    // No storageDir: unlike a paste, an attachment is never swept up when the
    // session ends — a transcript still points at it — so there is no manifest
    // to keep. See services/attachment-store.ts.
    this.attachmentStore = new AttachmentStore();
    this.chatStore = new ChatStore({ storageDir: this.database.storageDir });
    // Before the chat manager, which reads it: `/clear` starts a new
    // conversation and has to resolve the approval mode for itself.
    this.userPreferences = new UserPreferenceStore({ database: this.database });
    this.chatManager = new ChatSessionManager({
      store: this.chatStore,
      // The seam between a conversation and the ledger it is billed to. The
      // chat subsystem knows what a job cost; it does not know SQLite, and the
      // login it files the work under is not something it can look up.
      usageFor: (record) => {
        return {
          record: (job) => { this.usageStore.record(job); },
          consumedFor: (nativeSessionId) => this.usageStore.consumedFor(nativeSessionId),
          costBaselineFor: (nativeSessionId) =>
            this.usageStore.costBaselineFor(nativeSessionId),
          loginFor: (userId) => this.database.getUserById(userId)?.githubLogin ?? String(userId),
          spendByTurn: (sessionId, userId) =>
            this.usageStore.spendByTurn(sessionId, userId),
        };
      },
      storageDir: this.database.storageDir,
      broadcast: (sessionId, message) => broadcastChat(
        sessionId,
        message,
        this.claudeSessions,
        this.webSocketConnections,
      ),
      // Whose preference decides the mode of a conversation restarted from
      // inside itself. The chat subsystem has no idea who owns anything.
      chatBypassPreference: (userId) =>
        this.userPreferences.get(userId).chatBypassPermissions,
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
        if (record) {
          applyChatLifecycle(
            record,
            change,
            (id, active) => this.sessionStore.setActive(id, active, record.storageScope),
          );
        }
        // Apply the record transition first: exited=false is an in-place chat
        // restart, and project re-admission must observe active=true.
        this.messageProcessor?.handleChatLifecycle(sessionId, change);
        if (!record) return;
        // Written through rather than left to the thirty-second autosave: the
        // conversation this is about is one that was cleared and then left
        // alone, and what it is protected from is the process going away. The
        // record is only half of it — a record with no id sends the manager to
        // the head of the log for one — but the session has already truncated
        // that log by the time it says this, so the two agree (#43).
        // Likewise a mode that changed under a `/clear`: it is a standing
        // permission, and one that only exists in memory is one a restart
        // silently rewrites.
        if (
          change.nativeSessionId === null
          || change.bypassing !== undefined
          || change.planMode !== undefined
        ) {
          void this.saveSessionsToDisk();
        }
      },
      // The outer edge of what an agent may read and write on its user's
      // behalf, and the same one the file browser draws. Answered here because
      // this is the only layer that knows whether per-user environments are on,
      // and therefore whether "the browsable area" is one shared folder or a
      // different home for every account.
      userBaseFolder: (userId) => this.getUserBaseFolder(userId),
      // Issues codex list-price estimates to every session (issue #182).
      codexPricing: this.codexPricing,
    });
    this.runtimeProfiles = new RuntimeProfileStore({ database: this.database });
    this.tierContext = defaultTierContext(this.database.storageDir);
    this.sessionTeardown = new SessionTeardownRegistry();
    // Registered rather than appended to the DELETE handler, so the next
    // feature that needs teardown does not collide on the same line.
    this.sessionTeardown.register('pasted-images', (session) =>
      this.pasteStore.deletePastes(session));
    this.sessionTeardown.register('chat-log', (session) =>
      this.chatStore.deleteChat(session));
    this.sessionTeardown.register('chat-attachments', (session, context) =>
      this.attachmentStore.deleteSessionAttachments({
        id: session.id,
        ownerUserId: session.ownerUserId,
        workingDir: session.workingDir,
        projectId: session.projectId,
        projectWorkingDirKind: session.projectWorkingDirKind,
        storageScope: session.storageScope,
      }, {
        projectLifecycleExclusive: context?.projectLifecycleExclusive,
      }));
    // Registered last and executed in order: artifact stores finish their
    // final descriptor-relative deletes before the cached directory inode is
    // released.
    this.sessionTeardown.register('workspace-directory-lease', (session) =>
      closeWorkspaceSessionDirectoryLease(session));
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
      desktop: this.desktop,
      onGitHubCredential: async (userId, accessToken) => {
        await this.projects.synchronizeHostCredentialReplacement(userId, 'github.com', () => {
          const host = this.projectStore.upsertConnectedHostOAuth(userId, 'github.com', accessToken);
          this.projectStore.setConnectedHostValidation({
            userId,
            host: 'github.com',
            kind: 'oauth',
            expectedCredentialRevision: host.credentialRevision,
            forgeKind: 'github',
            status: 'valid',
            scopes: ['read:user', 'user:email'],
          });
        });
      },
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

    this.projects = new ProjectManager({
      store: this.projectStore,
      environments: this.environments,
      deployTargets: this.deployTargets,
      ownerFor: (userId: number) => this.getEnvironmentOwner(userId),
      authorFor: (userId: number) => this.projectAuthorFor(userId),
      broadcast: (userId: number, payload: unknown) => {
        sendToUser(
          userId,
          payload as Record<string, unknown>,
          this.webSocketConnections,
        );
      },
      // Use the same awaited teardown as an explicit session deletion. The
      // helper follows owned shells to a fixed point before the project row and
      // its workspace are removed.
      deleteProjectSessions: async (projectId: string) => {
        await retireProjectSessions(this.sessionRouteDeps(), projectId);
      },
      suspendProjectSessions: async (projectId: string) => {
        await suspendProjectSessions(this.sessionRouteDeps(), projectId);
      },
      beforeWorkspaceReplacement: (project) =>
        this.beforeProjectWorkspaceReplacement(project),
      afterWorkspaceRestored: (project, expected) =>
        this.afterProjectWorkspaceRestored(project, expected),
      confirmWorkspaceRestored: (project, expected) =>
        this.confirmProjectWorkspaceRestored(project, expected),
      rejectWorkspaceRestore: (project, reason) =>
        this.rejectProjectWorkspaceRestore(project, reason),
      beforeWorkspaceDeletion: (project) =>
        this.beforeProjectWorkspaceDeletion(project),
      hasUnavailableProjectSessionStorage: (project) =>
        this.projectSessionStorageIsUnavailable(project),
      // Durable active flags and atomic admission leases live in ProjectStore.
      // This closes the remaining process-local observation gaps.
      hasLiveProjectWork: (projectId: string) => this.hasLiveProjectWork(projectId),
      repositoryInspector: new RepositoryInspector({
        tempRoot: path.join(this.database.storageDir, 'tmp'),
      }),
      compositionRuntime: new DefaultCompositionRuntime(this.projectStore),
    });
    this.attachmentStore = new ProjectAwareAttachmentStore(
      this.attachmentStore,
      this.projects,
      () => this.saveSessionsToDisk(),
    );
    this.projectPaths = new ProjectEnvironmentManager(this.environments);
    this.storageUsage = new StorageUsageManager({
      database: this.database,
      store: this.projectStore,
      paths: {
        ownerHomePath: (user) => {
          try {
            const active = this.environments.activeProjectTarget();
            const targetId = active.key === 'legacy' ? null : active.key;
            return this.environments.ownerHomeOnTarget(user, targetId).hostPath;
          } catch {
            // Durable homes remain reportable after the last project or while
            // an administrator is between active targets.
            return this.environments.ownerHomeOnTarget(user, null).hostPath;
          }
        },
        ownerHomePaths: (user, ownedProjects) => {
          // A durable home can outlive the user's last project on a target.
          // Enumerate configured placements as well as recorded projects; a
          // current-project-only scan would silently lose those retained bytes.
          const targetIds = new Set<string | null>([
            null,
            ...this.deployTargets.listTargets().map((target) => target.id),
            ...ownedProjects.map((project) => project.targetId),
          ]);
          const homes = new Set<string>();
          for (const targetId of targetIds) {
            try {
              homes.add(this.environments.ownerHomeOnTarget(user, targetId).hostPath);
            } catch {
              // Unreachable/deleted target placements remain represented by a
              // project's own path when resolvable; unknown roots cannot be
              // guessed safely from browser or stale metadata.
            }
          }
          return [...homes];
        },
        projectPaths: (project, user) => ({
          workspacePath: this.projectPaths.worktreePath(project, user),
          overlayPath: this.projectPaths.overlayPath(project),
        }),
      },
    });
    this.connectedHostValidator = new ConnectedHostValidator();

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
      projectsManager: this.projects,
      sessionStore: this.sessionStore,
      getSelectedWorkingDir: (userId: number) => this.getSelectedWorkingDir(userId),
      createSessionRecord: (params) => this.createSessionRecord(params),
      loadWorkspaceSessions: (userId, storageRoot) =>
        this.loadWorkspaceSessions(userId, storageRoot),
      tabCoordinator: this.tabCoordinator,
      getRuntimeBridge: (agentKind: AgentKind) => this.getRuntimeBridge(agentKind),
      resolveAgentLaunch: (session, environment, agentKind) =>
        this.resolveManagedAgentLaunch(session, environment, agentKind),
      resolveAgentEnvironment: (session) => this.agentMaintenanceEnvironmentForSession(session),
      probeAgentLaunchVersion: (environment, agentKind, command) =>
        this.probeAgentLaunchVersion(environment, agentKind, command),
      saveSessionsToDisk: () => this.saveSessionsToDisk(),
      resolveRuntimeProfile: (agentKind: AgentKind, workingDir: string) =>
        this.resolveRuntimeProfile(agentKind, workingDir),
      activeProfileFor: (runtime: string) => this.activeProfileFor(runtime),
      getUserModelDefault: (userId: number, runtime: string) =>
        this.database.getUserSetting(userId, `chatModel:${runtime}`),
      setUserModelDefault: (userId: number, runtime: string, model: string | null) => {
        if (model) this.database.setUserSetting(userId, `chatModel:${runtime}`, model);
        else this.database.deleteUserSetting(userId, `chatModel:${runtime}`);
      },
      getUserPreferences: (userId: number) => this.userPreferences.get(userId),
      transcriptStore: this.transcriptStore,
      historyStore: this.historyStore,
      chatManager: this.chatManager,
      resolveChatAttachment: (session, attachment) =>
        this.attachmentStore.resolveForTurn(
          session.projectId
            ? Object.assign(session, {
                projectId: session.projectId,
                projectWorkingDirKind: session.projectWorkingDirKind,
              })
            : {
                id: session.id,
                ownerUserId: session.ownerUserId,
                workingDir: session.workingDir,
                projectId: session.projectId,
                projectWorkingDirKind: session.projectWorkingDirKind,
                storageScope: session.storageScope,
              },
          attachment,
        ),
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
    this.setupEnvironmentSweep();
    // Kick off the daily OpenAI list-price refresh (issue #182) once the server
    // is up; the interval is unref'd and torn down on shutdown.
    this.codexPricing.start();
    // One-time retrospective backfill of historical codex turns in app.sqlite.
    // Unpriced rows are retried once a rate exists; priced rows are untouched.
    try {
      this.usageStore.backfillCodexEstimates(this.codexPricing);
    } catch (error) {
      console.warn(`codex cost backfill failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    } catch (error) {
      // Before the first possible writer, cleanup is provably safe. Once
      // AppDatabase construction began, a partially-created native handle may
      // be unreachable; retain the lease and let only dead-process + stale
      // heartbeat recovery admit a replacement.
      if (!dataDirWriterConstructionStarted) {
        const lease = this.dataDirLease;
        this.dataDirLease = null;
        lease?.releaseSync();
      }
      throw error;
    }
  }

  /**
   * Continuing after the lease inode/token changes would create two writers.
   * Do not run normal shutdown: its final persistence write is precisely what
   * is no longer authorised. Stop admission synchronously and terminate this
   * process so the OS closes every native SQLite/runtime handle.
   */
  private failStopDataDirLease(error: Error): never {
    console.error(`Fatal: lost the installation data-directory lease: ${error.message}`);
    this.isShuttingDown = true;
    try { this.projects?.stopSweep(); } catch { /* fail-stop continues */ }
    if (this.autoSaveInterval) clearInterval(this.autoSaveInterval);
    if (this.environmentSweep) clearInterval(this.environmentSweep);
    if (this.environmentScale) clearInterval(this.environmentScale);
    try { this.codexPricing?.stop(); } catch { /* fail-stop continues */ }
    try { this.listener?.close(); } catch { /* fail-stop continues */ }
    try { this.server?.closeAllConnections?.(); } catch { /* fail-stop continues */ }
    for (const socket of this.listenerSockets || []) {
      try { socket.destroy(); } catch { /* fail-stop continues */ }
    }
    process.exit(DATA_DIR_LEASE_LOST_EXIT_CODE);
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

  /** Git identity used by the preservation commit before a project rebuild. */
  private projectAuthorFor(userId: number): { name: string; email: string } {
    const user = this.database.getUserById(userId);
    if (!user) {
      throw new Error(`project owner ${userId} is unavailable for preservation`);
    }
    const clean = (value: string): string => value
      .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim();
    const login = clean(user.githubLogin) || `user-${user.id}`;
    const name = clean(user.githubName || '') || login;
    const suppliedEmail = clean(user.email || '');
    const safeLogin = login.replace(/[^a-zA-Z0-9_.-]+/gu, '-') || `user-${user.id}`;
    const safeGitHubId = user.githubId.replace(/[^a-zA-Z0-9]+/gu, '') || String(user.id);
    const email = /^[^\s<>@]+@[^\s<>@]+$/u.test(suppliedEmail)
      ? suppliedEmail
      : `${safeGitHubId}+${safeLogin}@users.noreply.github.com`;
    return { name, email };
  }

  /**
   * Process-local work protected from project stop/reclaim.
   *
   * A dormant persisted session alone does not keep a project running forever.
   * Active runtimes and sockets do, including shells whose only project link is
   * a chain of owner-session ids. Durable active rows and admission leases are
   * checked independently by ProjectStore.
   */
  private hasLiveProjectWork(projectId: string): boolean {
    if (this.messageProcessor?.hasPendingProjectWork(projectId)) return true;
    const related = new Set<string>();
    for (const session of this.claudeSessions.values()) {
      if (session.projectId === projectId) related.add(session.id);
    }

    for (let changed = true; changed;) {
      changed = false;
      for (const session of this.claudeSessions.values()) {
        if (session.ownerSessionId && related.has(session.ownerSessionId) && !related.has(session.id)) {
          related.add(session.id);
          changed = true;
        }
      }
    }

    if (related.size === 0) return false;
    for (const sessionId of related) {
      const session = this.claudeSessions.get(sessionId);
      if (session?.active || (session?.connections.size ?? 0) > 0) return true;
    }
    for (const socket of this.webSocketConnections.values()) {
      if (socket.claudeSessionId && related.has(socket.claudeSessionId)) return true;
      for (const watched of socket.chatSessionIds) {
        if (related.has(watched)) return true;
      }
    }
    return false;
  }

  /**
   * Where new environments go, asked by the manager on every ensure.
   *
   * An empty targets table resolves to the startup configuration under the
   * well-known 'legacy' key — the pre-feature behavior, down to the engine.
   * A table with no active target resolves to null: the administrator has
   * selected host-local execution for new work.
   */
  private resolveActiveDeployTarget(): ActiveTargetResolution | null {
    // Read from the cached maps, not the store: this runs on every `enabled`
    // check and tier lookup, and the cache is invalidated by the same reload
    // that applies any target change, so it cannot go stale.
    const maps = this.deployTargetMaps;
    if (!maps.targetsExist) {
      return { key: 'legacy', config: this.legacyContainerConfig, name: 'startup configuration' };
    }
    if (!maps.activeKey) {
      return null;
    }
    const config = maps.configs.get(maps.activeKey);
    if (!config) {
      return null;
    }
    return { key: maps.activeKey, config, name: maps.targetNames.get(maps.activeKey) };
  }

  /**
   * Engines and configs for every stored target, keyed by target id.
   *
   * A target whose secrets no longer decrypt (the encryption key changed
   * under it) is skipped with a warning rather than taking the server down:
   * every other target, and the startup configuration, still work.
   */
  private buildDeployTargetMaps(): {
    engines: Map<string, EnvironmentEngine>;
    configs: Map<string, ContainerConfig>;
    activeKey: string | null;
    targetsExist: boolean;
    targetNames: Map<string, string>;
  } {
    const engines = new Map<string, EnvironmentEngine>();
    const configs = new Map<string, ContainerConfig>();
    if (!this.containerizedEnvironmentsEnabled) {
      return {
        engines,
        configs,
        activeKey: 'legacy',
        targetsExist: false,
        targetNames: new Map(),
      };
    }
    const targets = this.deployTargets.listTargets();
    for (const summary of targets) {
      try {
        const targetConfig = this.deployTargets.configForTarget(
          summary.id,
          this.database.storageDir,
          this.environmentExtraMounts,
        );
        configs.set(summary.id, targetConfig);
        engines.set(summary.id, createEngine(targetConfig));
      } catch (error) {
        console.warn(`deploy target "${summary.name}" is unusable and was skipped:`, error);
      }
    }
    const activeKey = targets.length === 0
      ? 'legacy'
      : this.deployTargets.getActiveTargetId();
    return {
      engines,
      configs,
      activeKey,
      targetsExist: targets.length > 0,
      targetNames: new Map(targets.map((target) => [target.id, target.name])),
    };
  }

  /**
   * Re-read the targets table into the manager after any change. Engines
   * that still own containers survive the swap inside the manager, so an
   * edit or a switch never strands running work.
   */
  private reloadDeployTargets(): void {
    this.deployTargetMaps = this.buildDeployTargetMaps();
    this.environments.reloadTargets(this.deployTargetMaps);
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

  private agentMaintenanceKey(session: SessionRecord, environment: UserEnvironment): string {
    if (session.projectId) return `project:${session.ownerUserId}:${session.projectId}`;
    return agentMaintenanceExecutionKey(session.ownerUserId, environment);
  }

  private agentMaintenancePlatform(environment: UserEnvironment): AgentPlatform {
    if (environment.kind === 'container') return 'linux';
    if (process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32') {
      return process.platform;
    }
    return 'unsupported';
  }

  private async agentMaintenanceArchitecture(
    key: string,
    environment: UserEnvironment,
  ): Promise<AgentArchitecture> {
    const cached = this.agentMaintenanceArchitectures.get(key);
    if (cached) return cached;
    let raw: string = process.arch;
    if (environment.kind === 'container') {
      try {
        const wrapped = environment.wrap('uname', ['-m']);
        const result = await childProcessRunner.run(wrapped.command, wrapped.args, {
          env: wrapped.env,
          timeoutMs: 2_000,
          windowsVerbatimArguments: wrapped.windowsVerbatimArguments,
        });
        raw = result.stdout.trim();
      } catch {
        raw = '';
      }
    }
    const architecture: AgentArchitecture = /^(?:arm64|aarch64)$/iu.test(raw)
      ? 'arm64'
      : /^(?:x64|x86_64|amd64)$/iu.test(raw) ? 'x64' : 'unsupported';
    this.agentMaintenanceArchitectures.set(key, architecture);
    return architecture;
  }

  private async agentMaintenanceTarget(
    session: SessionRecord,
    environment?: UserEnvironment,
  ): Promise<AgentMaintenanceTarget> {
    const resolvedEnvironment = environment || await this.agentMaintenanceEnvironmentForSession(session);
    const key = this.agentMaintenanceKey(session, resolvedEnvironment);
    const runningAgentId = session.agent
      && (AGENT_MAINTENANCE_IDS as readonly string[]).includes(session.agent)
      ? session.agent as AgentMaintenanceId
      : null;
    if (!session.projectId) this.agentMaintenanceEnvironments.set(key, resolvedEnvironment);
    const resolved: AgentMaintenanceTarget = {
      key,
      platform: this.agentMaintenancePlatform(resolvedEnvironment),
      architecture: await this.agentMaintenanceArchitecture(key, resolvedEnvironment),
      scope: resolvedEnvironment.kind === 'container' ? 'private' : 'shared',
      ownerUserId: resolvedEnvironment.kind === 'container' ? session.ownerUserId : null,
      projectManaged: Boolean(session.projectId),
      ...(runningAgentId
        ? {
            runningAgentId,
            ...(session.runningAgentVersion !== undefined
              ? { runningVersion: session.runningAgentVersion }
              : {}),
          }
        : {}),
    };
    // A process started before version capture existed cannot be identified by
    // probing the command now: the active pointer or PATH may have changed in
    // the meantime. Unknown is the only truthful answer until that process is
    // restarted and its launch path is verified.
    if (
      !session.projectId
      && session.active
      && runningAgentId
      && session.runningAgentVersion === undefined
    ) {
      session.runningAgentVersion = null;
      session.runningManagedAgentVersion = null;
      resolved.runningAgentId = runningAgentId;
      resolved.runningVersion = null;
    }
    return resolved;
  }

  private async agentMaintenanceEnvironmentForSession(
    session: SessionRecord,
  ): Promise<UserEnvironment> {
    if (session.active) {
      if (session.runtimeEnvironmentKey) {
        const captured = this.agentMaintenanceEnvironments.get(session.runtimeEnvironmentKey);
        if (!captured) {
          throw new Error('The original execution environment is no longer available.');
        }
        return captured;
      }
      const current = await this.ensureEnvironment(session.ownerUserId);
      if (current.kind === 'container') {
        throw new Error('The running process has no captured immutable environment identity.');
      }
      return current;
    }
    return this.ensureEnvironment(session.ownerUserId);
  }

  private async probeAgentLaunchVersion(
    environment: UserEnvironment,
    agentKind: AgentKind,
    selectedCommand?: string,
  ): Promise<string | null> {
    const bridge = this.getRuntimeBridge(agentKind) as BridgeInterface & {
      command?: string;
      defaultCommand?: string;
    };
    const actualCommand = selectedCommand || (environment.kind === 'container'
      ? bridge?.defaultCommand
      : bridge?.command);
    return probeLaunchedAgentVersion(environment, agentKind, actualCommand);
  }

  private async resolveAgentMaintenanceTarget(input: {
    userId: number;
    targetId: string;
  }): Promise<AgentMaintenanceTarget | null> {
    const session = this.claudeSessions.get(input.targetId);
    if (!session || session.ownerUserId !== input.userId) return null;
    // Project composition is the authority. Status needs no environment and
    // must not start a dormant project merely because its picker was opened.
    if (session.projectId) {
      const environment = this.environments.host();
      return this.agentMaintenanceTarget(session, environment);
    }
    return this.agentMaintenanceTarget(session);
  }

  private resolveManagedAgentLaunch(
    session: SessionRecord,
    environment: UserEnvironment,
    agentKind: AgentKind,
  ): { command: string; version: string } | null {
    if (session.projectId || agentKind === 'terminal') return null;
    const entry = agentCatalogEntry(agentKind);
    if (!entry) return null;
    const key = this.agentMaintenanceKey(session, environment);
    this.agentMaintenanceEnvironments.set(key, environment);
    session.runtimeEnvironmentKey = key;
    const target: AgentMaintenanceTarget = {
      key,
      platform: this.agentMaintenancePlatform(environment),
      architecture: this.agentMaintenanceArchitectures.get(key)
        || (process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : 'unsupported'),
      scope: environment.kind === 'container' ? 'private' : 'shared',
      ownerUserId: environment.kind === 'container' ? session.ownerUserId : null,
    };
    const selected = this.agentMaintenanceRuntime.resolveManagedCommand(target, entry, environment);
    return selected?.version ? { command: selected.command, version: selected.version } : null;
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
    projectId?: string | null;
    projectWorkingDirKind?: 'host' | 'container';
    /** Trusted canonical workspace root; never accepted from the browser. */
    storageRoot?: string;
  }): SessionRecord {
    const parent = params.ownerSessionId
      ? this.claudeSessions.get(params.ownerSessionId)
      : undefined;
    if (params.ownerSessionId && (!parent || parent.ownerUserId !== params.ownerUserId)) {
      throw new Error('Owner conversation is unavailable for workspace storage');
    }
    const project = !parent && params.projectId
      ? this.projectStore.getProjectForUser(params.projectId, params.ownerUserId)
      : null;
    if (!parent && params.projectId && !project) {
      throw new Error('Project workspace is unavailable for session storage');
    }
    const storageScope = parent?.storageScope
      || (project
        ? this.projectSessionStorageScope(project)
        : this.sessionStorageScope(params.ownerUserId, params.storageRoot || params.workingDir));
    this.assertWorkspaceScopeWritable(storageScope);
    return {
      id: params.id,
      storageScope,
      ownerSessionId: params.ownerSessionId,
      projectId: params.projectId,
      projectWorkingDirKind: params.projectWorkingDirKind,
      ownerUserId: params.ownerUserId,
      name: params.name || `Session ${new Date().toLocaleString()}`,
      created: new Date(),
      lastActivity: new Date(),
      active: false,
      agent: null,
      lastAgent: null,
      runtimeLabel: null,
      // A new standalone session is a new tab, so it comes after every tab the
      // account already has. Nested shells are not part of the top-level strip.
      tabOrder: params.ownerSessionId
        ? undefined
        : nextAccountTabOrder(this.claudeSessions, params.ownerUserId),
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

  /** Resolve once; later cwd changes cannot move a session to another archive. */
  private sessionStorageScope(ownerUserId: number, root: string): SessionStorageScope {
    const ownerKey = this.sessionOwnerKey(ownerUserId);
    return {
      workspaceRoot: this.workspaceCatalog.register(
        ownerKey,
        this.authorizeWorkspaceRoot(ownerUserId, root),
      ),
      ownerKey,
    };
  }

  private workspaceScopeKey(scope: SessionStorageScope): string {
    return `${scope.ownerKey}\u0000${scope.workspaceRoot}`;
  }

  private sameWorkspaceScope(left: SessionStorageScope, right: SessionStorageScope): boolean {
    return left.ownerKey === right.ownerKey && left.workspaceRoot === right.workspaceRoot;
  }

  /** A staged/rejected project archive is a scope-level gate, not a row hint. */
  private workspaceScopeGateReason(scope: SessionStorageScope): string | null {
    const key = this.workspaceScopeKey(scope);
    if (this.unrestoredProjectScopes.has(key)) {
      return this.workspacePersistenceErrors.get(key)
        || 'Project session artifacts are crash-staged and have not been restored';
    }
    for (const suspended of this.suspendedProjectScopes.values()) {
      if (this.sameWorkspaceScope(suspended, scope)) {
        return this.workspacePersistenceErrors.get(key)
          || 'Project session artifacts are temporarily unavailable';
      }
    }
    return null;
  }

  private assertWorkspaceScopeWritable(scope: SessionStorageScope): void {
    const reason = this.workspaceScopeGateReason(scope);
    if (reason) throw new ProjectWorkspaceSessionStorageError(reason);
  }

  /**
   * Admit one exact artifact archive and remember its inode for the lifetime of
   * this process. A later same-name directory is never silently substituted.
   */
  private admitWorkspaceArtifactArchive(
    scope: SessionStorageScope,
    createIfMissing: boolean,
  ): WorkspaceSessionStorageIdentity {
    const key = this.workspaceScopeKey(scope);
    const expected = this.workspaceArtifactIdentities.get(key);
    const lease = openWorkspaceStorageDirectorySync(scope.workspaceRoot, {
      createIfMissing,
      ...(expected ? { expectedIdentity: expected } : {}),
    });
    try {
      lease.verify();
      const opened = fs.fstatSync(lease.fd, { bigint: true });
      if (!opened.isDirectory() || opened.ino === 0n) {
        throw new Error('Workspace artifact directory has no stable identity');
      }
      const identity = { dev: opened.dev, ino: opened.ino };
      if (expected && (identity.dev !== expected.dev || identity.ino !== expected.ino)) {
        throw new Error('Workspace artifact directory changed after admission');
      }
      this.workspaceArtifactIdentities.set(key, identity);
      return identity;
    } finally {
      lease.close();
    }
  }

  /** A catalog entry locates a candidate; current policy still authorises it. */
  private authorizeWorkspaceRoot(ownerUserId: number, root: string): string {
    const canonical = canonicalExistingRoot(root);
    const owner = this.getEnvironmentOwner(ownerUserId);
    if (owner) {
      for (const project of this.projectStore.listProjectsForUser(ownerUserId)) {
        const projectRoot = path.resolve(this.projectPaths.worktreePath(project, owner));
        if (canonical === projectRoot) return canonical;
      }
    }
    const validation = this.validatePath(canonical, ownerUserId);
    if (validation.valid && validation.path && path.resolve(validation.path) === canonical) {
      return canonical;
    }
    throw new Error('Workspace root is no longer authorised for this account');
  }

  private sessionOwnerKey(ownerUserId: number): string {
    const owner = this.database.getUserById(ownerUserId);
    if (!owner) throw new Error(`session owner ${ownerUserId} is unavailable`);
    return createHash('sha256')
      .update(`cc-web-session-owner:v1:${owner.githubId}`)
      .digest('hex');
  }

  /** Rebuild runtime/path authority from the global project catalogue, never from a checkout DB. */
  private revalidateRestoredSession(
    session: SessionRecord,
    scope: SessionStorageScope,
    ownerUserId: number,
  ): void {
    if (session.projectId) {
      const project = this.projectStore.getProjectForUser(session.projectId, ownerUserId);
      const owner = this.getEnvironmentOwner(ownerUserId);
      if (!project || !owner) throw new Error(`Session ${session.id} names an unavailable project`);
      const projectRoot = path.resolve(this.projectPaths.worktreePath(project, owner));
      if (projectRoot !== scope.workspaceRoot) {
        throw new Error(`Session ${session.id} project does not own this workspace archive`);
      }
      if (project.executionKind === 'host') {
        session.projectWorkingDirKind = 'host';
        const candidate = path.resolve(session.workingDir || projectRoot);
        const relative = path.relative(projectRoot, candidate);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          session.workingDir = this.projectPaths.checkoutPath(project, owner);
        } else {
          session.workingDir = candidate;
        }
      } else {
        session.projectWorkingDirKind = 'container';
        if (
          typeof session.workingDir !== 'string'
          || !session.workingDir
          || session.workingDir.includes('\0')
          || !path.posix.isAbsolute(session.workingDir)
        ) {
          session.workingDir = this.projectPaths.checkoutContainerPath(project);
        } else {
          session.workingDir = path.posix.normalize(session.workingDir);
        }
      }
      return;
    }

    session.projectWorkingDirKind = undefined;
    const validation = typeof session.workingDir === 'string'
      ? this.validatePath(session.workingDir, ownerUserId)
      : { valid: false };
    if (!validation.valid || !validation.path) session.workingDir = scope.workspaceRoot;
    else session.workingDir = validation.path;
  }

  /** Retire one structured project gate only after its exact archive is back. */
  private clearVerifiedProjectScopeGate(
    project: Project,
    scope: SessionStorageScope,
    identity: WorkspaceSessionStorageIdentity,
  ): void {
    const key = this.workspaceScopeKey(scope);
    this.workspaceArtifactIdentities.set(key, identity);
    this.suspendedProjectScopes.delete(project.id);
    this.unrestoredProjectScopes.delete(key);
    this.loadedWorkspaceScopes.add(key);
    this.workspacePersistenceErrors.delete(key);
    for (const session of this.claudeSessions.values()) {
      if (!session.storageScope || !this.sameWorkspaceScope(session.storageScope, scope)) continue;
      try {
        this.revalidateRestoredSession(session, scope, session.ownerUserId);
        session.persistenceUnavailable = undefined;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        session.persistenceUnavailable = reason;
        this.workspacePersistenceErrors.set(key, reason);
      }
    }
  }

  /** Open one authorised archive and merge it without last-wins collisions. */
  private async loadWorkspaceSessions(
    ownerUserId: number,
    storageRoot: string,
  ): Promise<void> {
    try {
      const scope = this.sessionStorageScope(ownerUserId, storageRoot);
      const key = this.workspaceScopeKey(scope);
      this.assertWorkspaceScopeWritable(scope);
      this.admitWorkspaceArtifactArchive(scope, true);
      this.loadedWorkspaceScopes.add(key);
      const blocked = [...this.claudeSessions.values()].some((session) =>
        session.storageScope?.ownerKey === scope.ownerKey
        && session.storageScope.workspaceRoot === scope.workspaceRoot
        && Boolean(session.persistenceUnavailable));
      if (!blocked) this.workspacePersistenceErrors.delete(key);
    } catch (error) {
      const ownerKey = this.sessionOwnerKey(ownerUserId);
      this.workspacePersistenceErrors.set(
        `${ownerKey}\u0000${path.resolve(storageRoot)}`,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  private async loadProjectWorkspaceSessions(ownerUserId: number, projectId: string): Promise<void> {
    const project = this.projectStore.getProjectForUser(projectId, ownerUserId);
    const owner = this.getEnvironmentOwner(ownerUserId);
    if (!project || !owner) throw new Error('Project workspace is unavailable');
    await this.loadWorkspaceSessions(
      ownerUserId,
      this.projectPaths.worktreePath(project, owner),
    );
  }

  private projectSessionStorageScope(project: Project): SessionStorageScope {
    const owner = this.getEnvironmentOwner(project.ownerUserId);
    if (!owner) throw new Error('Project workspace owner is unavailable');
    return {
      workspaceRoot: path.resolve(this.projectPaths.worktreePath(project, owner)),
      ownerKey: this.sessionOwnerKey(project.ownerUserId),
    };
  }

  /**
   * Recover archives left in the deterministic project staging slot by a
   * process crash.
   *
   * This runs only after boot reconciliation has made every reachable managed
   * runtime non-executable. Restoring sooner would put plaintext session data
   * back into a bind-mounted workspace while an old container could still
   * mutate it. A failed restore remains an explicit unavailable scope and is
   * excluded from discovery; startup never creates a replacement database.
   */
  private async restoreStagedProjectSessionArchives(): Promise<void> {
    for (const user of this.database.listUsers()) {
      const owner = this.getEnvironmentOwner(user.id);
      if (!owner) continue;
      for (const project of this.projectStore.listProjectsForUser(user.id)) {
        const scope = this.projectSessionStorageScope(project);
        const key = `${scope.ownerKey}\u0000${scope.workspaceRoot}`;
        // With project environments disabled we deliberately do not contact or
        // make assumptions about old container runtimes. Host projects have no
        // such runtime and are safe to recover locally; a staged container
        // archive remains outside its mount and is reported unavailable.
        if (!this.containerizedEnvironmentsEnabled && project.executionKind !== 'host') {
          try {
            if (await this.projectPaths.hasStagedWorkspaceSessionStorage(project, owner)) {
              this.unrestoredProjectScopes.add(key);
              this.workspacePersistenceErrors.set(
                key,
                'Project session archive is crash-staged; enable project environments to quiesce its runtime and recover it safely',
              );
            }
          } catch (error) {
            this.unrestoredProjectScopes.add(key);
            this.workspacePersistenceErrors.set(
              key,
              `Project session archive staging state is unsafe: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          continue;
        }
        try {
          await this.projectPaths.restoreWorkspaceSessionStorage(project, owner);
          const recoveryIdentity = await this.projectPaths.workspaceSessionStorageRecoveryIdentity(
            project,
            owner,
          );
          if (recoveryIdentity) {
            const reopened = await this.projectPaths.workspaceSessionStorageIdentity(project, owner);
            if (!reopened || reopened.dev !== recoveryIdentity.dev || reopened.ino !== recoveryIdentity.ino) {
              throw new ProjectWorkspaceSessionStorageError(
                'Cold-restored project artifacts did not retain their archive inode',
              );
            }
            await this.projectPaths.completeWorkspaceSessionStorageRestore(project, owner, reopened);
            this.clearVerifiedProjectScopeGate(project, scope, reopened);
          } else {
            this.unrestoredProjectScopes.delete(key);
            const diagnostic = this.workspacePersistenceErrors.get(key);
            if (diagnostic?.startsWith('Project session archive crash recovery failed:')) {
              this.workspacePersistenceErrors.delete(key);
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.unrestoredProjectScopes.add(key);
          this.workspacePersistenceErrors.set(
            key,
            `Project session archive crash recovery failed: ${message}`,
          );
        }
      }
    }
  }

  private async projectSessionStorageIsUnavailable(project: Project): Promise<boolean> {
    const scope = this.projectSessionStorageScope(project);
    const key = this.workspaceScopeKey(scope);
    const owner = this.getEnvironmentOwner(project.ownerUserId);
    if (!owner) throw new Error('Project workspace owner is unavailable');
    try {
      await this.projectPaths.restoreWorkspaceSessionStorage(project, owner);
      const recoveryIdentity = await this.projectPaths.workspaceSessionStorageRecoveryIdentity(
        project,
        owner,
      );
      if (recoveryIdentity) {
        const reopened = await this.projectPaths.workspaceSessionStorageIdentity(project, owner);
        if (!reopened || reopened.dev !== recoveryIdentity.dev || reopened.ino !== recoveryIdentity.ino) {
          throw new ProjectWorkspaceSessionStorageError(
            'Restored project artifacts did not prove the retained archive inode',
          );
        }
        await this.projectPaths.completeWorkspaceSessionStorageRestore(project, owner, reopened);
        this.clearVerifiedProjectScopeGate(project, scope, reopened);
      } else if (this.workspaceScopeGateReason(scope)) {
        return true;
      }
      await this.loadWorkspaceSessions(project.ownerUserId, scope.workspaceRoot);
    } catch (error) {
      this.rejectProjectWorkspaceRestore(
        project,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
    return this.workspacePersistenceErrors.has(key)
      || this.unrestoredProjectScopes.has(key)
      || this.suspendedProjectScopes.has(project.id);
  }

  private async beforeProjectWorkspaceReplacement(
    project: Project,
  ): Promise<boolean | ProjectWorkspaceReplacementAuthority> {
    if (await this.projectSessionStorageIsUnavailable(project)) {
      throw new ProjectWorkspaceSessionStorageError(
        'Project session storage is unavailable; restore the archive before replacing the workspace',
      );
    }
    const scope = this.projectSessionStorageScope(project);
    const key = `${scope.ownerKey}\u0000${scope.workspaceRoot}`;
    const owner = this.getEnvironmentOwner(project.ownerUserId);
    if (!owner) throw new Error('Project workspace owner is unavailable');
    // Capture the artifact archive before lifecycle admission is closed and
    // before any asynchronous flush. The same inode is required again below;
    // a same-name replacement must never become preservation authority merely
    // because it appeared while the already-admitted writers were draining.
    const admittedIdentity = await this.projectPaths.workspaceSessionStorageIdentity(project, owner);
    if (!admittedIdentity) return false;
    const retainedIdentity = this.workspaceArtifactIdentities.get(key);
    if (retainedIdentity && (
      retainedIdentity.dev !== admittedIdentity.dev
      || retainedIdentity.ino !== admittedIdentity.ino
    )) {
      throw new Error('Project artifact directory changed after workspace admission');
    }
    this.workspaceArtifactIdentities.set(key, admittedIdentity);
    // Close scope-wide admission before the first await below. A concurrent
    // standalone create targeting this managed root must not recreate
    // `.cc-web` while its authoritative inode is being staged.
    this.suspendedProjectScopes.set(project.id, scope);
    // From this point until the exact archive has been restored and reloaded,
    // the in-memory records are only read-only signposts.  A lifecycle failure
    // can leave the authoritative `.cc-web` inode in its deterministic sibling
    // staging slot; allowing an upload, branch, rename, or runtime turn through
    // one of these records would recreate the canonical name and permanently
    // obstruct recovery.  The verified reload below replaces these objects
    // with the clean rows from the restored database.
    const suspendedReason = 'Project workspace session storage is temporarily unavailable during project replacement';
    const affected: Array<{ session: SessionRecord; previous: string | undefined }> = [];
    for (const session of this.claudeSessions.values()) {
      if (
        session.ownerUserId === project.ownerUserId
        && session.storageScope?.ownerKey === scope.ownerKey
        && session.storageScope?.workspaceRoot === scope.workspaceRoot
      ) {
        affected.push({ session, previous: session.persistenceUnavailable });
        session.persistenceUnavailable = suspendedReason;
      }
    }
    const previousDiagnostic = this.workspacePersistenceErrors.get(key);
    this.workspacePersistenceErrors.set(key, suspendedReason);
    let intentCommitted = false;
    try {
      // Store-level no-op queue entries form a per-session barrier. Calls
      // admitted before the synchronous gate finish first; later calls reject
      // from `persistenceUnavailable` and cannot queue behind the barrier.
      await Promise.all(affected.flatMap(({ session }) => [
        this.chatStore.flush?.(session),
        this.transcriptStore.flush?.(session),
        this.historyStore.flush?.(session),
        this.pasteStore.flush?.(session),
        this.attachmentStore.flush?.({
          ...session,
          projectId: session.projectId,
          projectWorkingDirKind: session.projectWorkingDirKind,
        }),
      ].filter((pending): pending is Promise<void> => Boolean(pending))));
      // Keep the live records gated, but persist their current state as it was
      // immediately before this lifecycle suspension. This is deliberately an
      // explicit snapshot: the general coordinator must continue to ignore
      // storage-blocked/read-only records during unrelated autosaves.
      const persistenceSnapshot = new Map(this.claudeSessions);
      for (const { session, previous } of affected) {
        persistenceSnapshot.set(session.id, {
          ...session,
          persistenceUnavailable: previous,
        });
      }
      if (!(await this.saveSessionsToDisk(persistenceSnapshot))) {
        throw new Error('Workspace storage authority could not be flushed before project replacement');
      }
      // Cached direct-child handles must be gone before the project manager can
      // move the complete `.cc-web` tree into its deterministic staging slot.
      await closeWorkspaceSessionDirectoryLeasesForScope(scope);
      const identity = await this.projectPaths.workspaceSessionStorageIdentity(project, owner);
      if (
        !identity
        || identity.dev !== admittedIdentity.dev
        || identity.ino !== admittedIdentity.ino
      ) {
        throw new Error('Project artifact directory changed while lifecycle writers were draining');
      }
      // The sibling intent is durable before the artifact tree is moved.
      // A crash in the following suspension gap therefore cannot make a
      // same-name replacement look like the authoritative archive at boot.
      await this.projectPaths.recordWorkspaceSessionStorageIntent(project, owner, identity);
      intentCommitted = true;
      this.loadedWorkspaceScopes.delete(key);
      return { required: true, identity };
    } catch (error) {
      if (!intentCommitted) {
        this.suspendedProjectScopes.delete(project.id);
        for (const { session, previous } of affected) {
          session.persistenceUnavailable = previous;
        }
        if (previousDiagnostic === undefined) this.workspacePersistenceErrors.delete(key);
        else this.workspacePersistenceErrors.set(key, previousDiagnostic);
      }
      throw error;
    }
  }

  private async afterProjectWorkspaceRestored(
    project: Project,
    expected?: WorkspaceSessionStorageIdentity,
  ): Promise<WorkspaceSessionStorageIdentity | void> {
    const scope = this.suspendedProjectScopes.get(project.id);
    if (!scope) return;
    try {
      const owner = this.getEnvironmentOwner(project.ownerUserId);
      if (!owner) throw new Error('Project workspace owner is unavailable');
      const reopened = await this.projectPaths.workspaceSessionStorageIdentity(project, owner);
      if (!reopened) throw new Error('Restored project artifact directory is unavailable');
      if (expected && (reopened.dev !== expected.dev || reopened.ino !== expected.ino)) {
        throw new Error('Restored project artifact directory changed identity');
      }
      return reopened;
    } catch (error) {
      this.workspacePersistenceErrors.set(
        `${scope.ownerKey}\u0000${scope.workspaceRoot}`,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  private async confirmProjectWorkspaceRestored(
    project: Project,
    expected: WorkspaceSessionStorageIdentity,
  ): Promise<WorkspaceSessionStorageIdentity> {
    const scope = this.suspendedProjectScopes.get(project.id);
    if (!scope) throw new Error('Project workspace restore is not awaiting confirmation');
    const owner = this.getEnvironmentOwner(project.ownerUserId);
    if (!owner) throw new Error('Project workspace owner is unavailable');
    const confirmed = await this.projectPaths.workspaceSessionStorageIdentity(project, owner);
    if (!confirmed || confirmed.dev !== expected.dev || confirmed.ino !== expected.ino) {
      throw new Error('Restored project artifact directory changed after confirmation');
    }
    this.clearVerifiedProjectScopeGate(project, scope, confirmed);
    return confirmed;
  }

  private rejectProjectWorkspaceRestore(project: Project, reason: string): void {
    const scope = this.suspendedProjectScopes.get(project.id)
      || this.projectSessionStorageScope(project);
    const key = `${scope.ownerKey}\u0000${scope.workspaceRoot}`;
    const suspendedReason = `Project workspace session storage restore was rejected: ${reason}`;
    for (const session of this.claudeSessions.values()) {
      if (
        session.ownerUserId === project.ownerUserId
        && session.storageScope?.ownerKey === scope.ownerKey
        && session.storageScope?.workspaceRoot === scope.workspaceRoot
      ) {
        session.persistenceUnavailable = suspendedReason;
      }
    }
    this.loadedWorkspaceScopes.delete(key);
    this.suspendedProjectScopes.set(project.id, scope);
    this.workspacePersistenceErrors.set(key, suspendedReason);
  }

  private async beforeProjectWorkspaceDeletion(project: Project): Promise<void> {
    const scope = this.projectSessionStorageScope(project);
    const key = this.workspaceScopeKey(scope);
    await closeWorkspaceSessionDirectoryLeasesForScope(scope);
    this.loadedWorkspaceScopes.delete(key);
    this.workspaceArtifactIdentities.delete(key);
    this.suspendedProjectScopes.delete(project.id);
    this.workspaceCatalog.unregister(scope.ownerKey, scope.workspaceRoot);
  }

  private async workspaceSessionMetadata(ownerUserId?: number): Promise<Record<string, unknown>> {
    const ownerKey = ownerUserId === undefined ? null : this.sessionOwnerKey(ownerUserId);
    const metadata = await this.sessionStore.getSessionMetadata();
    const counts = new Map<string, { ownerKey: string; root: string; sessionCount: number }>();
    for (const session of this.claudeSessions.values()) {
      const scope = session.storageScope;
      if (!scope || (ownerKey && scope.ownerKey !== ownerKey)) continue;
      const key = `${scope.ownerKey}\u0000${scope.workspaceRoot}`;
      const entry = counts.get(key) ?? {
        ownerKey: scope.ownerKey,
        root: scope.workspaceRoot,
        sessionCount: 0,
      };
      entry.sessionCount += 1;
      counts.set(key, entry);
    }
    const workspaces = [...counts.values()].map(({ ownerKey: scopeOwner, root, sessionCount }) => {
      const error = this.workspacePersistenceErrors.get(`${scopeOwner}\u0000${root}`);
      return {
        root,
        available: !error,
        sessionCount,
        ...(error ? { error } : {}),
      };
    });
    const unavailableByScope = new Map<string, { ownerKey: string; root: string; error: string }>();
    for (const [key, error] of this.workspacePersistenceErrors) {
      const separator = key.indexOf('\u0000');
      unavailableByScope.set(key, {
        ownerKey: key.slice(0, separator),
        root: key.slice(separator + 1),
        error,
      });
    }
    const unavailable = Array.from(unavailableByScope.values())
      .filter((entry) => !ownerKey || entry.ownerKey === ownerKey)
      .map(({ root, error }) => ({ root, error }));
    return {
      exists: metadata.exists,
      storage: 'shared-app-sqlite',
      layoutVersion: 2,
      sessionCount: ownerUserId === undefined
        ? metadata.sessionCount ?? 0
        : [...this.claudeSessions.values()].filter((session) => session.ownerUserId === ownerUserId).length,
      savedAt: metadata.savedAt,
      version: metadata.version,
      workspaces,
      unavailable,
      allAvailable: unavailable.length === 0,
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
      case 'antigravity':
        return this.antigravityBridge;
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
  private resolveRuntimeProfile(
    agentKind: AgentKind,
    workingDir?: string,
  ): ResolvedProfile | null {
    const profile = this.runtimeProfiles.activeFor(agentKind);
    if (!profile) return null;

    // The session's directory is where pi's tier agents go, so it is part of
    // the context rather than something the writer could guess.
    const tierResult = applyTiers(profile, { ...this.tierContext, workingDir });
    for (const replaced of tierResult.replaced) {
      console.warn(
        `Runtime profile "${profile.name}": replaced ${replaced.file} (${replaced.reason})`,
      );
    }

    const extraArgs = [...tierResult.args, ...(profile.args || [])];

    // A rung is only in force if the ladder behind it reached the runtime. When
    // the write-through failed, the delegated helpers are not configured and the
    // conversation's own model would be the only half of the ladder that landed
    // — so the launch says so and falls back rather than reporting a rung it
    // half applied.
    // `unsupported` is a runtime with no way to express a ladder at all — the
    // non-goal the issue states outright: those launch exactly as they do now.
    // A rung applied anyway would put a `--model` on a claude session whose
    // helper rungs were written nowhere, from a ladder saved for a different
    // runtime and carried across by changing the Runtime dropdown.
    const ladder = tierResult.unsupported ? null : resolveConversationRung(profile);
    // Runtime launches normally always name a host-visible working directory.
    // An omitted one here is the explicit container-only namespace used by a
    // project session. Pi's ladder files cannot be written with host fs in that
    // case; reporting the ladder as active would be a more dangerous lie than
    // starting on the profile's ordinary model without delegated rungs.
    const ladderError = ladder
      ? tierResult.failed
        || (!workingDir && tierResult.deferred
          ? 'Capability tiers cannot be written into this container-only working directory.'
          : undefined)
      : undefined;

    return {
      profileId: profile.id,
      profileName: profile.name,
      model: profile.model,
      extraArgs: extraArgs.length ? extraArgs : undefined,
      env: profile.env,
      ladder: ladderError ? null : ladder,
      tiers: profile.tiers,
      ladderError,
    };
  }

  /**
   * The active profile for a runtime, and nothing written down.
   *
   * The read-only half of `resolveRuntimeProfile` above, which cannot serve
   * this: it writes the profile's tier files every time it is called, and the
   * callers here are questions — a browser joining a conversation, a branch
   * being cut — not launches. Answering them through the other one would
   * rewrite a runtime's config on every tab that opened.
   */
  private activeProfileFor(runtime: string): ResolvedProfile | null {
    const profile = this.runtimeProfiles.activeFor(runtime);
    if (!profile) return null;
    // The rung is resolved here too: reading a ladder is pure arithmetic over
    // four strings, and it is only *writing* it through that the caller of this
    // one must not trigger.
    const laddered = supportsTiers(runtime);
    return {
      profileId: profile.id,
      profileName: profile.name,
      model: profile.model,
      // Same gate as the launch above, and it has to be: this answers the
      // picker's "where did this model come from", and a rung reported for a
      // runtime that cannot express one would name a model nothing applied.
      ladder: laddered ? resolveConversationRung(profile) : null,
      ...(laddered ? { tiers: profile.tiers } : {}),
    };
  }

  /**
   * Carry edited ladders into the conversations that are open right now.
   *
   * Every tier-capable runtime, not only the ones whose profile changed: a save
   * rewrites the whole configuration at once, and working out which runtimes
   * actually moved would mean diffing a config against itself. The sessions
   * decide — one already on the rung it is being offered declines, so an
   * unrelated save interrupts nobody.
   */
  private async applyProfilesToOpenChats(): Promise<void> {
    for (const runtime of tierCapableRuntimes()) {
      const profile = this.activeProfileFor(runtime);
      // Only when the ladder is what decides: a model typed into the profile,
      // like an account's standing choice, outranks it, and a conversation
      // running on one of those was never the ladder's to move.
      const ladder = profile && !profile.model && profile.ladder && profile.tiers
        ? { tier: profile.ladder.tier, tiers: profile.tiers }
        : null;
      const moved = await this.chatManager.reapplyLadder(runtime, ladder);
      if (moved.length) {
        console.log(`Runtime profiles: moved ${moved.length} open ${runtime} conversation(s)`);
      }
    }
  }

  /** This account's standing model per runtime, for the profiles dialog. */
  private getUserModelDefaults(userId: number): Record<string, string> {
    const defaults: Record<string, string> = {};
    for (const runtime of tierCapableRuntimes()) {
      const model = this.database.getUserSetting(userId, `chatModel:${runtime}`);
      if (model) defaults[runtime] = model;
    }
    return defaults;
  }

  /**
   * Cached: detection shells out to `npm root -g` and `systemctl is-active`,
   * and neither answer changes while the process is alive.
   */
  private getUpdateMode(): UpdateModeResult {
    if (this.desktop) {
      // A packaged app must never run npm over its own asar/resources tree.
      // Desktop releases notify here and are replaced by their OS installer.
      return { mode: 'desktop', packageDir: null };
    }
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
    this.claudeSessions.clear();
    try {
      await this.sessionStore.resetActiveFlags();
      const loaded = await this.sessionStore.loadSessions();
      for (const session of loaded.values()) {
        const scope = session.storageScope;
        // Rows written before the global-scope layout are not imported. They
        // remain untouched in app.sqlite and cannot select a filesystem path.
        if (!scope) continue;
        try {
          if (scope.ownerKey !== this.sessionOwnerKey(session.ownerUserId)) {
            throw new Error('Stored workspace owner does not match the global account identity');
          }
          const admitted = this.sessionStorageScope(session.ownerUserId, scope.workspaceRoot);
          if (admitted.ownerKey !== scope.ownerKey || admitted.workspaceRoot !== scope.workspaceRoot) {
            throw new Error('Stored workspace scope is no longer canonical');
          }
          this.assertWorkspaceScopeWritable(admitted);
          this.revalidateRestoredSession(session, admitted, session.ownerUserId);
          this.admitWorkspaceArtifactArchive(admitted, false);
          const key = this.workspaceScopeKey(admitted);
          this.loadedWorkspaceScopes.add(key);
          const earlierBlocked = [...this.claudeSessions.values()].some((entry) =>
            entry.storageScope && this.sameWorkspaceScope(entry.storageScope, admitted)
            && Boolean(entry.persistenceUnavailable));
          if (!earlierBlocked) this.workspacePersistenceErrors.delete(key);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          session.persistenceUnavailable = reason;
          this.workspacePersistenceErrors.set(
            `${scope.ownerKey}\u0000${scope.workspaceRoot}`,
            reason,
          );
        }
        this.claudeSessions.set(session.id, session);
      }
      if (this.claudeSessions.size > 0) {
        console.log(`Loaded ${this.claudeSessions.size} sessions from shared app SQLite`);
      }
    } catch (error) {
      console.error('Failed to load persisted sessions:', error);
      this.claudeSessions.clear();
      throw error;
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
    if (this.autoSaveInterval) return;
    this.autoSaveInterval = setInterval(() => {
      void this.saveSessionsToDisk();
    }, 30000);
    process.on('beforeExit', () => {
      if (!this.isShuttingDown) void this.saveSessionsToDisk();
    });
  }

  private async saveSessionsToDisk(
    sessions: Map<string, SessionRecord> = this.claudeSessions,
  ): Promise<boolean> {
    return this.sessionStore.saveSessions(sessions);
  }

  /**
   * One composition object for both public session routes and project
   * retirement, so deletion cannot accidentally take a weaker teardown path.
   */
  private sessionRouteDeps(): SessionRoutesDeps {
    return {
      claudeSessions: this.claudeSessions,
      webSocketConnections: this.webSocketConnections,
      baseFolder: this.baseFolder,
      dev: this.dev,
      validatePath: (targetPath: string, userId?: number) => this.validatePath(targetPath, userId),
      getUserBaseFolder: (userId?: number) => this.getUserBaseFolder(userId),
      createSessionRecord: (params) => this.createSessionRecord(params),
      loadWorkspaceSessions: (userId, storageRoot) =>
        this.loadWorkspaceSessions(userId, storageRoot),
      loadProjectWorkspaceSessions: (userId, projectId) =>
        this.loadProjectWorkspaceSessions(userId, projectId),
      getRuntimeBridge: (agentKind: AgentKind) => this.getRuntimeBridge(agentKind),
      stopSessionRuntime: (session) =>
        this.messageProcessor.retireSessionRuntime(session),
      saveSessionsToDisk: () => this.saveSessionsToDisk(),
      transcriptStore: this.transcriptStore,
      historyStore: this.historyStore,
      getScreenSnapshot: (sessionId: string) => this.messageProcessor.getScreenSnapshot(sessionId),
      disposeRecorder: (sessionId: string) => this.messageProcessor.disposeRecorder(sessionId),
      getSelectedWorkingDir: (userId: number) => this.getSelectedWorkingDir(userId),
      activeProfileFor: (runtime: string) => this.activeProfileFor(runtime),
      tabCoordinator: this.tabCoordinator,
      sessionStore: {
        getSessionMetadata: (userId) => this.workspaceSessionMetadata(userId),
        setActive: (id, active) => this.sessionStore.setActive(
          id,
          active,
          this.claudeSessions.get(id)?.storageScope,
        ),
        resetActiveFlags: () => this.sessionStore.resetActiveFlags(),
      },
      projectsManager: this.projects,
      releaseProjectSessionResources: (sessionId) =>
        this.messageProcessor.releaseProjectSessionResources(sessionId),
      sessionTeardown: this.sessionTeardown,
      attachmentStore: this.attachmentStore,
      chatStore: this.chatStore,
    };
  }

  async shutdown(): Promise<void> {
    this.shutdownRequested = true;
    this.isShuttingDown = true;
    if (this.shutdownExecution) return await this.shutdownExecution;
    if (this.startInProgress) {
      return await this.waitForShutdownExecution();
    }
    return await this.beginShutdown();
  }

  private waitForShutdownExecution(): Promise<void> {
    if (this.shutdownExecution) return this.shutdownExecution;
    if (!this.shutdownWaiter) {
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      this.shutdownWaiter = { promise, resolve, reject };
    }
    return this.shutdownWaiter.promise;
  }

  private beginShutdown(): Promise<void> {
    if (this.shutdownExecution) return this.shutdownExecution;
    this.shutdownRequested = true;
    this.isShuttingDown = true;
    const execution = this.shutdownAndReleaseDataDirLease();
    this.shutdownExecution = execution;
    void execution.then(
      () => this.shutdownWaiter?.resolve(),
      (error) => {
        this.shutdownWaiter?.reject(error);
        this.shutdownWaiter = null;
        // A provider close may fail transiently while deliberately retaining
        // its workspace authority and facade. Permit a later shutdown() call
        // to retry only these idempotent finalizers; never replay runtime or
        // listener teardown after an earlier-stage failure.
        if (this.shutdownFinalizationPending && this.shutdownExecution === execution) {
          this.shutdownExecution = null;
        }
      },
    );
    return execution;
  }

  private async shutdownAndReleaseDataDirLease(): Promise<void> {

    let shutdownError: unknown;
    try {
      if (this.shutdownFinalizationPending) await this.finishShutdownStorage();
      else await this.shutdownWithDataDirLeaseHeld();
    } catch (error) {
      shutdownError = error;
    }

    let leaseError: unknown;
    // Releasing after an early teardown failure could admit another process
    // while this one still owns a timer, SQLite handle, or runtime writer. A
    // normal shutdown (including a failed final flush) reaches the explicit
    // writers-closed marker below and is safe to release.
    if (this.dataDirWritersClosed && this.dataDirLease) {
      const lease = this.dataDirLease;
      try {
        if (!await lease.release()) {
          leaseError = new Error('Data-directory lease ownership changed before shutdown');
        } else {
          this.dataDirLease = null;
        }
      } catch (error) {
        leaseError = error;
      }
    }

    if (shutdownError) {
      if (leaseError && shutdownError instanceof Error) {
        Object.assign(shutdownError, { leaseReleaseError: leaseError });
      }
      throw shutdownError;
    }
    if (leaseError) throw leaseError;
  }

  private async shutdownWithDataDirLeaseHeld(): Promise<void> {

    console.log('\nGracefully shutting down...');
    // Stop project policy work and new network admission first. `close()`
    // stops accepting synchronously; its promise settles once the live sockets
    // terminated below have released the listener.
    this.projects.stopSweep();
    const closeListener = new Promise<void>((resolve) => {
      const bound = this.listener || this.server;
      if (!bound || !bound.listening) {
        resolve();
        return;
      }
      const timeout = setTimeout(() => {
        // A response that ignores graceful close must not hold the port
        // forever. Destroy both HTTP(S)-tracked connections and raw demux
        // sockets (including clients that connected but sent no first byte),
        // then keep waiting for the server's real close callback below.
        this.server?.closeAllConnections?.();
        for (const socket of this.listenerSockets) socket.destroy();
        const closable = bound as net.Server & { closeAllConnections?(): void };
        closable.closeAllConnections?.();
      }, 5000);
      timeout.unref?.();
      bound.close(() => {
        clearTimeout(timeout);
        resolve();
      });
    });

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
    this.updateChecker.stop();
    this.lanDiscovery.stop();
    this.codexPricing.stop();

    if (this.wss) {
      // Stop already-connected clients from creating more work while the rest
      // of shutdown drains. The network listener above blocks new handshakes.
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

    // The close event normally takes this path. Run it explicitly as well so
    // every attachment lease is released before persistence and runtime drain.
    await Promise.all(
      [...this.webSocketConnections.keys()].map((wsId) => this.wsHandler.cleanupConnection(wsId)),
    );

    // Let the emulators finish parsing and flush; a bare flush would miss
    // whatever is still queued in the parser.
    await this.messageProcessor.drainAllRecorders();

    // A launch admitted just before its socket closed can still be awaiting an
    // environment or bridge spawn. Wait it out before taking the one final
    // snapshot of active runtimes, or it could appear after the scan.
    await this.messageProcessor.drainPendingRuntimeStarts();

    for (const [sessionId, session] of this.claudeSessions.entries()) {
      if (session.active && session.agent) {
        await this.messageProcessor.stopRuntime(sessionId, session.agent);
      }
    }

    // A failed earlier teardown deliberately leaves its ChatSessionManager
    // handle reachable even if a stale record says inactive. Retry every such
    // owner before releasing admission or clearing maps; rejection aborts
    // shutdown rather than orphaning an unverified container process.
    // Structured question handoffs have no live tool call to settle. Preserve
    // them across an orderly server restart so a resumed runtime can receive
    // the answer when the user comes back.
    await this.chatManager.stopAll({ preserveHandoffs: true });

    for (const sessionId of this.claudeSessions.keys()) {
      // Defensive and idempotent: covers an admission acquired immediately
      // before an already-finished runtime reported its final lifecycle event.
      this.messageProcessor.releaseProjectSessionResources(sessionId);
    }

    let finalPersistenceError: Error | null = null;
    try {
      if ((await this.saveSessionsToDisk()) === false) {
        finalPersistenceError = new Error(
          'Workspace session state could not be flushed during shutdown',
        );
      }
    } catch (error) {
      finalPersistenceError = Object.assign(
        new Error('Workspace session state could not be flushed during shutdown'),
        { cause: error },
      );
    }

    // Existing workspace requests can own short project leases. Let their
    // responses finish before closing lifecycle admission and SQLite. The
    // five-second listener backstop prevents a broken client from hanging
    // shutdown forever; a forced close can still interrupt that client's work.
    await closeListener;

    this.claudeSessions.clear();
    this.webSocketConnections.clear();

    // Builds and queued lifecycle finalizers still write SQLite. Drain them
    // after runtime/attachment release and before either environments or the
    // database can disappear underneath them.
    await this.projects.shutdown();

    // Stopped, never removed: the containers are this server's to start and
    // stop, but the data in them is the users' and a restart has to find it.
    if (this.environments.enabled) {
      await this.environments.stopAll();
    }

    this.listener = null;
    this.server = null;
    this.listenerSockets.clear();
    // Artifact directory leases are independent from the shared app.sqlite
    // handle, which remains the final storage object closed below.
    this.shutdownTerminalError = finalPersistenceError;
    this.shutdownFinalizationPending = true;
    await this.finishShutdownStorage();
  }

  private async finishShutdownStorage(): Promise<void> {
    let shutdownFailure: unknown = null;
    const finish = async (operation: () => void | Promise<void>): Promise<void> => {
      try { await operation(); } catch (error) { shutdownFailure ??= error; }
    };
    await finish(() => this.sessionStore.closeWorkspaces());
    await finish(() => closeWorkspaceSessionDirectoryLeases());
    await finish(() => closeWorkspaceCwdHelpers());
    try {
      this.database.close();
      this.dataDirWritersClosed = true;
    } catch (error) {
      shutdownFailure ??= error;
    }
    if (shutdownFailure) throw shutdownFailure;
    this.shutdownFinalizationPending = false;
    if (this.shutdownTerminalError) throw this.shutdownTerminalError;
  }

  private setupExpress(): void {
    const publicDir = path.join(__dirname, '..', 'public');

    if (this.desktop) {
      this.app.use((req, res, next) => {
        const expected = this.localUrl;
        const origin = req.headers.origin;
        const fetchSite = req.headers['sec-fetch-site'];
        if (
          !expected
          || req.headers.host !== new URL(expected).host
          || (origin !== undefined && origin !== expected)
          // SameSite cookies intentionally ignore ports. Fetch Metadata does
          // not: a browser page on another loopback port reports `same-site`,
          // while this renderer reports `same-origin` (or `none` for its first
          // top-level navigation). Non-browser embedder probes omit the header.
          || (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none')
        ) {
          res.status(403).json({ error: 'desktop_origin_required' });
          return;
        }
        next();
      });
    } else {
      // Browser/server deployments retain their existing cross-origin read
      // behavior. Desktop is a local capability endpoint and is exact-origin.
      this.app.use(cors());
    }
    // API responses can contain conversation/session data. Even without an
    // explicit freshness lifetime a browser may write a revalidation entry to
    // its disk cache, which would create an installation/profile copy outside
    // the workspace's `.cc-web`. Individual routes may make the policy stricter
    // but session APIs inherit this durable-storage prohibition by default.
    this.app.use('/api', (_req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      next();
    });
    const jsonParser = express.json();
    this.app.use((req, res, next) => {
      // Attachment uploads are opaque bytes even when the selected file is a
      // JSON document. Leave this one exact route unread so its route-scoped
      // raw parser receives byte-identical input and the 20 MiB limit.
      if (
        isChatAttachmentUploadRequest(req.method, req.path)
      ) {
        next();
        return;
      }
      jsonParser(req, res, next);
    });
    registerServerIdentityRoute(this.app, this.serverIdentity);
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
      ...this.sessionRouteDeps(),
      folderMode: this.folderMode,
      aliases: this.aliases,
      supportedShells: this.terminalBridge.getSupportedShells(),
      logoutUrl: this.desktop ? null : '/auth/logout',
      repositoryInspectionSupported: process.platform !== 'win32',
      containerizedEnvironmentsEnabled: this.containerizedEnvironmentsEnabled,
      isPathWithinBase: (targetPath: string, userId?: number) =>
        this.isPathWithinBase(targetPath, userId),
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
      setSelectedWorkingDir: (userId: number, value: string | null) =>
        this.setSelectedWorkingDir(userId, value),
      pasteStore: this.pasteStore,
      attachmentStore: this.attachmentStore,
      runtimeProfiles: this.runtimeProfiles,
      userPreferences: this.userPreferences,
      getUserPreferences: (userId: number) => this.userPreferences.get(userId),
      tierContext: this.tierContext,
      applyProfilesToOpenChats: () => this.applyProfilesToOpenChats(),
      getUserModelDefaults: (userId: number) => this.getUserModelDefaults(userId),
      updateChecker: this.updateChecker,
      selfUpdate: this.selfUpdate,
      getUpdateMode: () => this.getUpdateMode(),
      getInstallerUserId: () => this.database.getInstallerUserId(),
      maintenance: this.agentMaintenance,
      resolveTarget: (input) => this.resolveAgentMaintenanceTarget(input),
      deployTargetsEnabled: this.containerizedEnvironmentsEnabled,
      deployTargets: this.deployTargets,
      deployTargetDataDir: this.database.storageDir,
      createDeployEngine: (deployConfig) => createEngine(deployConfig),
      // The authoritative engine set for the in-use checks: the manager's own,
      // which retains engines for containers of edited or deleted targets —
      // a check that only saw the current target set would be blind to them.
      enginesForDeployTargets: () => this.environments.reachableEngines(),
      legacyContainersEnabled: this.legacyContainerConfig.enabled,
      reloadDeployTargets: () => this.reloadDeployTargets(),
      projectIdsForTarget: (targetId: string) => this.projectStore.projectIdsForTarget(targetId),
      getDeploySetting: (key: string) => this.database.getSetting(key),
      setDeploySetting: (key: string, value: string) => this.database.setSetting(key, value),
      deleteDeploySetting: (key: string) => this.database.deleteSetting(key),
      manager: this.projects,
      projectStore: this.projectStore,
      storageUsage: this.storageUsage,
      tokenValidator: this.connectedHostValidator,
      synchronizeHostCredentialReplacement: (userId, host, mutation) =>
        this.projects.synchronizeHostCredentialReplacement(userId, host, mutation),
      disconnectHostCredentials: async (userId: number, host: string) => {
        const result = await this.projects.disconnectHostCredentials(userId, host);
        if (!result.ok) throw new Error(result.detail || result.reason);
        return true;
      },
      providerDefault: (user) => this.projectAuthorFor(user.id),
      targetNameFor: (project) => this.projects.targetNameFor(project),
      projectAvailability: () => {
        try {
          return {
            available: true,
            defaultExecutionKind: this.environments.newProjectPlacement().kind,
          };
        } catch (error) {
          return {
            available: false,
            message: error instanceof Error ? error.message : 'Project placement is unavailable.',
          };
        }
      },
      getInterruptedUpdate: () => {
        // Reported once and then forgotten. Left set, it would keep the banner
        // in its error state — which offers no Update button — for the rest of
        // the process's life, so the interrupted update could never be
        // retried from the browser.
        const interrupted = this.interruptedUpdate;
        this.interruptedUpdate = null;
        return interrupted;
      },
      // For the status panel's "measured here" half. Passed rather than reached
      // for so a build that does not track usage simply omits the figure,
      // instead of showing a zero that reads as "you have spent nothing".
      usageStore: this.usageStore,
      usageBurn: (userId, agent, hours) => this.usageStore.burn(userId, agent, hours),
      readCachedClaudeAccount: () => readCachedClaudeAccount(),
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
    if (this.desktop) return true;
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

  /** Actual loopback URL after start; useful when port: 0 was requested. */
  get localUrl(): string | null {
    const address = this.listener?.address();
    if (!address || typeof address === 'string') return null;
    return `${this.useHttps ? 'https' : 'http'}://${address.address}:${address.port}`;
  }

  /** Cookie metadata for an Electron/WebView session API to set before loading. */
  get desktopAuthCookie(): { name: string; value: string; httpOnly: true; sameSite: 'strict' } | null {
    if (!this.desktop) return null;
    return {
      name: DESKTOP_AUTH_COOKIE_NAME,
      value: this.desktop.authToken,
      httpOnly: true,
      sameSite: 'strict',
    };
  }

  async start(): Promise<http.Server | https.Server> {
    if (this.startAttempted || this.isShuttingDown || !this.dataDirLease) {
      throw new Error('This server instance cannot be started more than once');
    }
    this.startAttempted = true;
    this.startInProgress = true;
    try {
      const server = await this.startWithDataDirLeaseHeld();
      this.throwIfStartupWasCancelled();
      return server;
    } catch (error) {
      this.shutdownRequested = true;
      this.isShuttingDown = true;
      try {
        // Call the private executor directly. Public shutdown deliberately
        // waits for an in-flight start, so using it from start's own catch
        // would deadlock with itself.
        await this.beginShutdown();
      } catch (cleanupError) {
        if (error instanceof Error) Object.assign(error, { cleanupError });
      }
      throw error;
    } finally {
      this.startInProgress = false;
    }
  }

  private throwIfStartupWasCancelled(): void {
    if (!this.shutdownRequested) return;
    throw Object.assign(new Error('Server startup was cancelled by shutdown'), {
      code: 'server_shutdown',
    });
  }

  private async startWithDataDirLeaseHeld(): Promise<http.Server | https.Server> {
    // A crash may leave `.cc-web` in a sibling staging slot while an old
    // container is still executable. Quiesce every reachable managed runtime
    // before putting that plaintext archive back into its bind-mounted name.
    if (this.containerizedEnvironmentsEnabled) {
      await this.projects.reconcileOnBoot();
      this.throwIfStartupWasCancelled();
    } else {
      // Reconciliation scans every reachable deploy engine and can retire
      // recorded runtimes. A dark feature must not contact those engines.
      this.projectStore.clearSessionLeases();
    }
    await this.restoreStagedProjectSessionArchives();
    this.throwIfStartupWasCancelled();
    // No process-local session survives a restart. Load only after staged
    // project archives are either restored exactly or marked unavailable.
    await this.loadPersistedSessions();
    this.throwIfStartupWasCancelled();
    // Startup restoration and workspace discovery must finish before any timer is able
    // to interpret an archive missing from the live map as a deletion.
    this.setupAutoSave();

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

    if (!this.desktop) {
      // Deliberately not awaited, and delayed: a first-run install should reach
      // "listening" without waiting on GitHub. Packaged desktop releases use
      // the Electron main-process updater instead; their embedded server must
      // never poll the commit-based server update channel.
      const firstCheck = setTimeout(() => {
        void this.updateChecker.check(false).catch(() => undefined);
      }, 60_000);
      firstCheck.unref?.();
      this.updateChecker.start();
    }

    // Embedders may call start() directly without going through
    // runSetupIfNeeded(); this stays as the safety net.
    await this.authService.ensureConfiguredInteractive(false);
    this.throwIfStartupWasCancelled();

    if (this.desktop) {
      const server = http.createServer(this.app);
      this.wss = new WebSocket.Server({ server });
      this.wss.on('connection', (ws: WebSocket, req) => {
        const expected = this.localUrl;
        if (
          !expected
          || req.headers.host !== new URL(expected).host
          || req.headers.origin !== expected
        ) {
          ws.close(4403, 'Desktop origin required');
          return;
        }
        this.wsHandler.handleConnection(ws, req);
      });
      server.on('connection', (socket) => {
        this.listenerSockets.add(socket);
        socket.once('close', () => this.listenerSockets.delete(socket));
      });
      this.projects.startSweep();
      return await new Promise((resolve, reject) => {
        const onError = (error: Error): void => {
          this.projects.stopSweep();
          reject(error);
        };
        server.once('error', onError);
        server.listen(this.port, this.host, () => {
          server.off('error', onError);
          this.server = server;
          this.listener = server;
          if (this.shutdownRequested) {
            reject(Object.assign(new Error('Server startup was cancelled by shutdown'), {
              code: 'server_shutdown',
            }));
            return;
          }
          // This only binds an opt-in responder. It never probes the LAN or
          // sends a packet until another device sends the exact protocol request.
          this.lanDiscovery.start();
          resolve(server);
        });
      });
    }

    // HTTPS is not optional. A plain-http origin that is not localhost is not a
    // secure context, and the browser then withholds the service worker — so no
    // installable app, no offline shell, no clipboard, no notifications. Those
    // all worked when tested at http://localhost and were missing for anyone
    // opening the same server at http://192.168.x.x, which is the normal way to
    // use it. An explicit --cert/--key pair still wins; otherwise a local CA is
    // generated in the data directory.
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
    server.on('connection', (socket) => {
      this.listenerSockets.add(socket);
      socket.once('close', () => this.listenerSockets.delete(socket));
    });

    // Startup has now passed every operation that can throw before binding.
    // Starting here avoids leaving an idle sweep behind when auth or
    // certificate preparation fails.
    this.throwIfStartupWasCancelled();
    this.projects.startSweep();
    return await new Promise((resolve, reject) => {
      const onError = (error: Error): void => {
        this.projects.stopSweep();
        reject(error);
      };
      server.once('error', onError);
      server.listen(this.port, this.host, () => {
        server.off('error', onError);
        this.server = secure;
        this.listener = server;
        if (this.shutdownRequested) {
          reject(Object.assign(new Error('Server startup was cancelled by shutdown'), {
            code: 'server_shutdown',
          }));
          return;
        }
        // The HTTP(S) listener is live before discovery can advertise it.
        this.lanDiscovery.start();
        resolve(secure);
      });
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

/** Position a newly created standalone session after this account's tabs. */
function nextAccountTabOrder(sessions: Map<string, SessionRecord>, userId: number): number {
  let maximum = -1;
  for (const session of sessions.values()) {
    if (session.ownerUserId !== userId || session.ownerSessionId || session.tabOpen === false) {
      continue;
    }
    if (Number.isFinite(session.tabOrder)) maximum = Math.max(maximum, session.tabOrder!);
  }
  return maximum + 1;
}
