import express from 'express';
import http from 'http';
import https from 'https';
import net from 'net';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

import { type Aliases, type ServerOptions, type SessionRecord, type WebSocketInfo, type AgentKind, type BridgeInterface, type PathValidation, type SessionStorageScope } from './types.js';
import { createConfig, createUsageAnalyticsOptions } from './config.js';
import { retireProjectSessions, suspendProjectSessions, type SessionRoutesDeps } from './routes/sessions.js';
import { type ResolvedProfile } from '../shared/runtime-profiles.js';
import { RuntimeProfileStore } from './services/runtime/profiles/runtime-profiles.js';
import { type TierWriterContext, defaultTierContext } from './services/runtime/profiles/tier-writer.js';
import { WebSocketHandler, broadcastChat, broadcastToAllConnections, sendToUser } from './websocket/handler.js';
import { MessageProcessor } from './websocket/messages.js';
import { AccountTabCoordinator } from './services/identity/account-tab-coordinator.js';
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
import { AppDatabase, resolveAppDataDir } from './services/persistence/app/database.js';
import { DataDirLease } from './services/persistence/app/data-dir-lease.js';
import { SessionStore } from './services/workspace/session/session-store.js';
import { WorkspaceCatalog } from './services/workspace/catalog/workspace-catalog.js';
import { closeWorkspaceSessionDirectoryLease } from './services/workspace/session/workspace-session-storage.js';
import { UsageStore } from './services/usage/usage-store.js';
import { CodexPricing } from './services/usage/codex-pricing.js';
import { TranscriptStore } from './services/workspace/artifacts/transcript-store.js';
import { HistoryStore } from './services/workspace/artifacts/history-store.js';
import { SessionTeardownRegistry } from './services/workspace/session/session-teardown.js';
import { PasteStore } from './services/workspace/artifacts/paste-store.js';
import { AttachmentStore, type AttachmentStoreLike } from './services/workspace/artifacts/attachment-store.js';
import { ProjectAwareAttachmentStore } from './services/projects/attachments/project-attachment-store.js';
import { readBuildInfo } from './services/release/build-info.js';
import { createServerIdentity, normalizeDiscoverableAddress, type ServerIdentity } from './services/network/server-identity.js';
import { LanDiscoveryResponder } from './services/network/lan-discovery.js';
import { UpdateChecker } from './services/release/update-check.js';
import { InterruptedUpdate, SelfUpdateRunner, UpdateModeResult } from './services/release/self-update.js';
import { ChatStore } from './chat/store.js';
import { ChatSessionManager } from './chat/manager.js';
import { AuthService } from './services/identity/auth.js';
import { APP_MOUNT, EnvironmentManager, SOCKET_MOUNT, createContainerConfig, ensureRoot, type ActiveTargetResolution, type EnvironmentEngine } from './services/environments/index.js';
import { type ContainerConfig, type Mount, type UserEnvironment } from './services/environments/types.js';
import { EncryptionKeyRing, validateEncryptionKeyMaterial } from './services/persistence/security/encryption.js';
import { DeployTargetStore } from './services/projects/deployment/deploy-targets.js';
import { ProjectStore, type Project } from './services/projects/store.js';
import { ProjectManager, type ProjectWorkspaceReplacementAuthority } from './services/projects/manager.js';
import { ProjectEnvironmentManager, type WorkspaceSessionStorageIdentity } from './services/projects/environment.js';
import { RepositoryInspector } from './services/composition/repository-inspector.js';
import { DefaultCompositionRuntime } from './services/composition/runtime.js';
import { StorageUsageManager } from './services/storage/storage-usage-manager.js';
import { ConnectedHostValidator } from './services/projects/connections/connected-host-validator.js';
import { UsageReader } from './services/usage/usage-reader.js';
import { UsageAnalytics } from './services/usage/usage-analytics.js';
import { UserPreferenceStore } from './services/identity/user-preferences.js';
import { AgentMaintenanceService, type AgentMaintenanceTarget, managedVersionRoot } from './services/runtime/agents/agent-maintenance.js';
import { EnvironmentAgentRuntime, JsonFileAgentMaintenanceStore, OfficialAgentReleaseSource, OfficialScriptAgentInstaller, officialFetch } from './services/runtime/agents/agent-maintenance-runtime.js';
import { type AgentArchitecture } from '../shared/agent-maintenance.js';
import { applyChatLifecycle } from './server-functions.js';

/** The installed package's own root. */
function appRootDir(): string {
  return path.resolve(__dirname, '..', '..');
}

export abstract class ServerCore {
  protected port: number;
  protected host: string | undefined;
  protected dev: boolean;
  protected useHttps: boolean;
  protected readonly desktop: ServerOptions['desktop'] | null;
  protected certFile: string | undefined;
  protected keyFile: string | undefined;
  protected setup: boolean;
  protected dataDir: string | null;
  protected folderMode: boolean;
  protected baseFolder: string;
  protected publicBaseUrl: string | null;
  protected readonly serverIdentity: ServerIdentity;
  protected readonly lanDiscovery: LanDiscoveryResponder;
  protected sessionDurationHours: number;
  protected aliases: Aliases;

  protected startTime: number;
  protected isShuttingDown: boolean;
  protected autoSaveInterval: ReturnType<typeof setInterval> | null;

  protected claudeSessions: Map<string, SessionRecord>;
  protected webSocketConnections: Map<string, WebSocketInfo>;
  protected tabCoordinator: AccountTabCoordinator;

  protected runtimeBridges: ReadonlyMap<AgentKind, BridgeInterface>;
  protected terminalBridge: TerminalBridge;

  protected database: AppDatabase;
  /** Held before AppDatabase opens and until every data-directory writer closes. */
  protected dataDirLease: DataDirLease | null;
  protected dataDirWritersClosed: boolean;
  protected startAttempted: boolean;
  protected startInProgress: boolean;
  protected shutdownRequested: boolean;
  protected shutdownExecution: Promise<void> | null;
  /** True only after runtime/network teardown reached retryable storage closes. */
  protected shutdownFinalizationPending: boolean;
  protected shutdownTerminalError: unknown | null;
  protected shutdownWaiter: { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void; } | null;
  protected usageStore: UsageStore;
  protected codexPricing: CodexPricing;
  protected sessionStore: SessionStore;
  protected workspaceCatalog: WorkspaceCatalog;
  protected transcriptStore: TranscriptStore;
  protected chatStore: ChatStore;
  protected chatManager: ChatSessionManager;
  protected historyStore: HistoryStore;
  protected pasteStore: PasteStore;
  protected attachmentStore: AttachmentStoreLike;
  protected runtimeProfiles: RuntimeProfileStore;
  protected userPreferences: UserPreferenceStore;
  protected tierContext: TierWriterContext;
  protected sessionTeardown: SessionTeardownRegistry;
  protected authService: AuthService;
  protected usageReader: UsageReader;
  protected usageAnalytics: UsageAnalytics;
  protected updateChecker: UpdateChecker;
  protected selfUpdate: SelfUpdateRunner;
  protected updateMode: UpdateModeResult | null;
  protected interruptedUpdate: InterruptedUpdate | null;
  protected agentMaintenance: AgentMaintenanceService;
  protected agentMaintenanceRuntime: EnvironmentAgentRuntime;
  /** Exact environments captured by target resolution; operations outlive requests. */
  protected agentMaintenanceEnvironments: Map<string, UserEnvironment>;
  protected agentMaintenanceArchitectures: Map<string, AgentArchitecture>;

  protected app: express.Express;
  protected server: http.Server | https.Server | null;
  /** The socket actually bound to the port. */
  protected listener: net.Server | null;
  /** Raw demultiplexer sockets, including clients that have sent no TLS byte. */
  protected listenerSockets: Set<net.Socket>;
  /** The local CA, when one was generated; offered at /ca.crt for other devices. */
  protected caFile: string | undefined;
  protected wss: WebSocket.Server | null;

  protected wsHandler: WebSocketHandler;
  protected messageProcessor: MessageProcessor;
  protected environments: EnvironmentManager;
  protected readonly containerizedEnvironmentsEnabled: boolean;
  protected encryptionKeyRing: EncryptionKeyRing;
  protected deployTargets: DeployTargetStore;
  protected projectStore: ProjectStore;
  protected projects: ProjectManager;
  protected projectPaths: ProjectEnvironmentManager;
  protected loadedWorkspaceScopes: Set<string>;
  protected workspacePersistenceErrors: Map<string, string>;
  /** Exact `.cc-web` inode admitted for each live global metadata scope. */
  protected workspaceArtifactIdentities: Map<string, WorkspaceSessionStorageIdentity>;
  protected suspendedProjectScopes: Map<string, SessionStorageScope>;
  /** Project archives whose crash-staging slot could not be restored safely. */
  protected unrestoredProjectScopes: Set<string>;
  protected storageUsage: StorageUsageManager;
  protected connectedHostValidator: ConnectedHostValidator;
  /** The startup-flag configuration: the 'legacy' entry in the target maps. */
  protected legacyContainerConfig: ContainerConfig;
  /** Mounts every environment gets, targets included: app code and the socket dir. */
  protected environmentExtraMounts: Mount[];
  protected deployTargetMaps: {
    engines: Map<string, EnvironmentEngine>;
    configs: Map<string, ContainerConfig>;
    activeKey: string | null;
    targetsExist: boolean;
    targetNames: Map<string, string>;
  };
  protected environmentSweep: ReturnType<typeof setInterval> | null = null;
  protected environmentScale: ReturnType<typeof setInterval> | null = null;

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

    this.terminalBridge = new TerminalBridge();
    this.runtimeBridges = new Map<AgentKind, BridgeInterface>([
      ['claude', new ClaudeBridge()],
      ['codex', new CodexBridge()],
      ['agent', new AgentBridge()],
      ['pi', new PiBridge()],
      ['grok', new GrokBridge()],
      ['qwen', new QwenBridge()],
      ['kimi', new KimiBridge()],
      ['omp', new OmpBridge()],
      ['antigravity', new AntigravityBridge()],
      ['terminal', this.terminalBridge],
    ]);

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
    // them. The key ring comes first because the store encrypts every secret it
    // saves with it. The legacy seed runs once ever, capturing the
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
    // session ends while a transcript still points at it, so there is no manifest
    // to keep. See services/workspace/artifacts/attachment-store.ts.
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
      // container needs the name, not this machine's path to it; the name
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
        // record is only half of it: a record with no id sends the manager to
        // the head of the log for one, but the session has already truncated
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

  protected abstract failStopDataDirLease(error: Error): never;
  protected abstract getUserBaseFolder(userId?: number): string;
  protected abstract getEnvironmentOwner(userId: number): { id: number; githubLogin: string } | null;
  protected abstract projectAuthorFor(userId: number): { name: string; email: string };
  protected abstract hasLiveProjectWork(projectId: string): boolean;
  protected abstract resolveActiveDeployTarget(): ActiveTargetResolution | null;
  protected abstract buildDeployTargetMaps(): {
    engines: Map<string, EnvironmentEngine>;
    configs: Map<string, ContainerConfig>;
    activeKey: string | null;
    targetsExist: boolean;
    targetNames: Map<string, string>;
  };
  protected abstract ensureEnvironment(userId?: number): Promise<UserEnvironment>;
  protected abstract agentMaintenanceEnvironmentForSession(session: SessionRecord): Promise<UserEnvironment>;
  protected abstract probeAgentLaunchVersion(
    environment: UserEnvironment,
    agentKind: AgentKind,
    command?: string,
  ): Promise<string | null>;
  protected abstract resolveManagedAgentLaunch(
    session: SessionRecord,
    environment: UserEnvironment,
    agentKind: AgentKind,
  ): { command: string; version: string } | null;
  protected abstract validatePath(targetPath: string, userId?: number): PathValidation;
  protected abstract createSessionRecord(params: {
    id: string;
    ownerUserId: number;
    name?: string;
    workingDir: string;
    connections?: string[];
    ownerSessionId?: string;
    projectId?: string | null;
    projectWorkingDirKind?: 'host' | 'container';
    storageRoot?: string;
  }): SessionRecord;
  protected abstract loadWorkspaceSessions(userId: number, storageRoot: string): Promise<void>;
  protected abstract beforeProjectWorkspaceReplacement(
    project: Project,
  ): Promise<boolean | ProjectWorkspaceReplacementAuthority>;
  protected abstract afterProjectWorkspaceRestored(
    project: Project,
    expected?: WorkspaceSessionStorageIdentity,
  ): Promise<WorkspaceSessionStorageIdentity | void>;
  protected abstract confirmProjectWorkspaceRestored(
    project: Project,
    expected: WorkspaceSessionStorageIdentity,
  ): Promise<WorkspaceSessionStorageIdentity>;
  protected abstract rejectProjectWorkspaceRestore(project: Project, reason: string): void;
  protected abstract beforeProjectWorkspaceDeletion(project: Project): Promise<void>;
  protected abstract projectSessionStorageIsUnavailable(project: Project): Promise<boolean>;
  protected abstract sessionStorageScope(ownerUserId: number, root: string): SessionStorageScope;
  protected abstract projectSessionStorageScope(project: Project): SessionStorageScope;
  protected abstract assertWorkspaceScopeWritable(scope: SessionStorageScope): void;
  protected abstract getRuntimeBridge(agentKind: AgentKind): BridgeInterface | null;
  protected abstract resolveRuntimeProfile(
    agentKind: AgentKind,
    workingDir?: string,
  ): ResolvedProfile | null;
  protected abstract activeProfileFor(runtime: string): ResolvedProfile | null;
  protected abstract getSelectedWorkingDir(userId: number): string | null;
  protected abstract setupEnvironmentSweep(): void;
  protected abstract saveSessionsToDisk(sessions?: Map<string, SessionRecord>): Promise<boolean>;
  protected abstract sessionRouteDeps(): SessionRoutesDeps;
  protected abstract setupExpress(): void;
}
