// Main application class: holds state and wires together all modules

import type { Terminal } from '@xterm/xterm';
import type {
  Aliases,
  AgentKind,
  RuntimeStartOptions,
  SessionListItem,
  WsMessage,
  PlanData,
} from './types';
import type { TerminalController } from './terminal/controller';

import {
  loadConfig,
  getAlias as configGetAlias,
  getRuntimeLabel as configGetRuntimeLabel,
  getRuntimeStartMessage as configGetRuntimeStartMessage,
  applyAliasesToUI,
} from './config';
import { setupTerminal, fitTerminal } from './terminal/setup';
import { WebSocketConnection } from './terminal/connection';
import { MessageHandler } from './terminal/message-handler';
import { SessionTabManager } from './sessions/tab-manager';
import {
  loadSessions as sessionsLoadSessions,
  joinSession as sessionsJoinSession,
  leaveSession as sessionsLeaveSession,
  deleteSession as sessionsDeleteSession,
  startRuntimeSession,
  startClaudeSession as sessionsStartClaude,
  startCodexSession as sessionsStartCodex,
  startAgentSession as sessionsStartAgent,
  startPiSession as sessionsStartPi,
  startGrokSession as sessionsStartGrok,
  startQwenSession as sessionsStartQwen,
  startKimiSession as sessionsStartKimi,
  startTerminalSession as sessionsStartTerminal,
  closeSession as sessionsCloseSession,
} from './sessions/actions';
import { FolderBrowser } from './ui/folder-browser';
import { PlanDetector } from './ui/plan-detector';
import { showOverlay, hideOverlay, showError } from './ui/overlay';
import {
  setupSettingsModal,
  showSettings as settingsShow,
  loadSettings,
  applySettings,
} from './ui/settings';
import {
  setupNewSessionModal,
  showNewSessionModal as modalsShowNewSession,
  setupTerminalOptionsModal,
  showTerminalOptionsModal as modalsShowTerminalOptions,
} from './ui/modals';
import {
  detectMobile,
  disablePullToRefresh,
  showModeSwitcher,
  closeMobileMenu,
  showMobileSessionsModal,
  setupMobileSessionsModal,
} from './ui/mobile';
import { showNotification, playNotificationSound } from './ui/notifications';
import { setupUpdateBanner } from './ui/update-banner';
import { pickImage, type ImagePasteTarget } from './terminal/paste';
import { SplitContainer } from './splits/split-container';
import { mountShell } from './shell/mount';
import type { HistoryView, HistoryRange } from './terminal/history-view';

export class App {
  // Terminal
  terminal: Terminal | null;
  terminalController: TerminalController | null;
  /** Lets the mobile menu reach the same upload path as paste and drop. */
  imagePasteTarget: ImagePasteTarget | null;

  // Server-paged scrollback
  historyView: HistoryView | null;
  historyRange: HistoryRange;
  historyRequests: Map<string, (lines: string[]) => void>;
  historyRequestSeq: number;
  socket: WebSocket | null;
  connectionId: string | null;

  // Session state
  currentClaudeSessionId: string | null;
  currentClaudeSessionName: string | null;
  claudeSessions: SessionListItem[];
  isCreatingNewSession: boolean;
  startPromptRequested: boolean;
  pendingRuntimeStart: { kind: AgentKind; options: RuntimeStartOptions } | null;
  pendingJoinResolve: (() => void) | null;
  pendingJoinSessionId: string | null;

  // Connection
  reconnectAttempts: number;
  readonly maxReconnectAttempts: number;
  readonly reconnectDelay: number;

  // Folders
  folderMode: boolean;
  currentFolderPath: string | null;
  selectedWorkingDir: string | null;

  // Config
  aliases: Aliases;

  // Mobile
  isMobile: boolean;
  currentMode: string;

  // Modules
  wsConnection: WebSocketConnection;
  messageHandler: MessageHandler;
  sessionTabManager!: SessionTabManager;
  folderBrowser: FolderBrowser;
  planDetector: PlanDetector;
  splitContainer: SplitContainer | null;

  // Usage (kept as opaque; UI removed)
  private usageUpdateTimer: ReturnType<typeof setInterval> | null;

  constructor() {
    this.terminal = null;
    this.terminalController = null;
    this.historyView = null;
    this.imagePasteTarget = null;
    this.historyRange = { firstLine: 0, totalLines: 0 };
    this.historyRequests = new Map();
    this.historyRequestSeq = 0;
    this.socket = null;
    this.connectionId = null;

    this.currentClaudeSessionId = null;
    this.currentClaudeSessionName = null;
    this.claudeSessions = [];
    this.isCreatingNewSession = false;
    this.startPromptRequested = false;
    this.pendingRuntimeStart = null;
    this.pendingJoinResolve = null;
    this.pendingJoinSessionId = null;

    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 1000;

    this.folderMode = true;
    this.currentFolderPath = null;
    this.selectedWorkingDir = null;

    this.aliases = {
      claude: 'Claude',
      codex: 'Codex',
      agent: 'Cursor',
      pi: 'Pi',
      grok: 'Grok',
      qwen: 'Qwen',
      kimi: 'Kimi',
      terminal: 'Terminal',
    };

    this.isMobile = detectMobile();
    this.currentMode = 'chat';

    this.wsConnection = new WebSocketConnection(this);
    this.messageHandler = new MessageHandler(this);
    this.folderBrowser = new FolderBrowser(this);
    this.planDetector = new PlanDetector();
    this.splitContainer = null;

    this.usageUpdateTimer = null;

    this.init();
  }

  // ---------------------------------------------------------------------------
  // Authenticated fetch helper
  // ---------------------------------------------------------------------------

  async authFetch(url: string, options: RequestInit = {}): Promise<Response> {
    const response = await fetch(url, options);
    if (response.status === 401) {
      const next = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = `/login?next=${next}`;
      throw new Error('Authentication required');
    }
    return response;
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  private async init(): Promise<void> {
    await loadConfig(this);
    setupTerminal(this);
    this.setupUI();
    this.setupPlanDetector();
    loadSettings(); // side-effect: reads from localStorage
    applySettings(this, loadSettings());
    applyAliasesToUI(this);
    disablePullToRefresh();
    setupUpdateBanner(this);

    showOverlay('loadingSpinner');

    this.sessionTabManager = new SessionTabManager(this);
    await this.sessionTabManager.init();

    // After setupTerminal and the tab manager, so the terminal node exists and
    // has xterm attached before TerminalHost adopts it, and so the first render
    // already has tabs to show.
    mountShell(this);

    this.splitContainer = new SplitContainer(this);
    this.splitContainer.setupDropZones();

    if (this.isMobile) {
      showModeSwitcher(this);
    }

    if (this.sessionTabManager.tabs.size > 0) {
      const firstTabId = this.sessionTabManager.tabs.keys().next().value;
      await this.sessionTabManager.switchToTab(firstTabId!);
      hideOverlay();
    } else {
      hideOverlay();
      this.folderBrowser.show();
    }

    window.addEventListener('resize', () => this.fitTerminal());
    window.addEventListener('beforeunload', () => this.wsConnection.disconnect());
  }

  // ---------------------------------------------------------------------------
  // UI wiring (button clicks -> module functions)
  // ---------------------------------------------------------------------------

  private setupUI(): void {
    const startBtn = document.getElementById('startBtn');
    const dangerousSkipBtn = document.getElementById('dangerousSkipBtn');
    const startCodexBtn = document.getElementById('startCodexBtn');
    const dangerousCodexBtn = document.getElementById('dangerousCodexBtn');
    const startAgentBtn = document.getElementById('startAgentBtn');
    const startPiBtn = document.getElementById('startPiBtn');
    const startGrokBtn = document.getElementById('startGrokBtn');
    const dangerousGrokBtn = document.getElementById('dangerousGrokBtn');
    const startQwenBtn = document.getElementById('startQwenBtn');
    const dangerousQwenBtn = document.getElementById('dangerousQwenBtn');
    const startKimiBtn = document.getElementById('startKimiBtn');
    const dangerousKimiBtn = document.getElementById('dangerousKimiBtn');
    const startTerminalBtn = document.getElementById('startTerminalBtn');
    const closeStartPromptBtn = document.getElementById('closeStartPromptBtn');
    const cancelStartPromptBtn = document.getElementById('cancelStartPromptBtn');
    const settingsBtn = document.getElementById('settingsBtn');
    const retryBtn = document.getElementById('retryBtn');
    const closeMenuBtn = document.getElementById('closeMenuBtn');
    const settingsBtnMobile = document.getElementById('settingsBtnMobile');
    const sessionsBtnMobile = document.getElementById('sessionsBtnMobile');
    const closeSessionBtnMobile = document.getElementById('closeSessionBtnMobile');
    const reconnectBtnMobile = document.getElementById('reconnectBtnMobile');
    const clearBtnMobile = document.getElementById('clearBtnMobile');
    const attachImageBtnMobile = document.getElementById('attachImageBtnMobile');

    startBtn?.addEventListener('click', () => this.startClaudeSession());
    dangerousSkipBtn?.addEventListener('click', () =>
      this.startClaudeSession({ dangerouslySkipPermissions: true }),
    );
    startCodexBtn?.addEventListener('click', () => this.startCodexSession());
    dangerousCodexBtn?.addEventListener('click', () =>
      this.startCodexSession({ dangerouslySkipPermissions: true }),
    );
    startAgentBtn?.addEventListener('click', () => this.startAgentSession());
    startPiBtn?.addEventListener('click', () => this.startPiSession());
    startGrokBtn?.addEventListener('click', () => this.startGrokSession());
    dangerousGrokBtn?.addEventListener('click', () =>
      this.startGrokSession({ dangerouslySkipPermissions: true }),
    );
    startQwenBtn?.addEventListener('click', () => this.startQwenSession());
    dangerousQwenBtn?.addEventListener('click', () =>
      this.startQwenSession({ dangerouslySkipPermissions: true }),
    );
    startKimiBtn?.addEventListener('click', () => this.startKimiSession());
    dangerousKimiBtn?.addEventListener('click', () =>
      this.startKimiSession({ dangerouslySkipPermissions: true }),
    );
    startTerminalBtn?.addEventListener('click', () => this.showTerminalOptionsModal());
    const cancelStartPrompt = async () => {
      if (!this.currentClaudeSessionId) {
        hideOverlay();
        return;
      }

      await this.deleteSession(this.currentClaudeSessionId, { confirm: false });
    };
    closeStartPromptBtn?.addEventListener('click', () => void cancelStartPrompt());
    cancelStartPromptBtn?.addEventListener('click', () => void cancelStartPrompt());
    settingsBtn?.addEventListener('click', () => this.showSettings());
    retryBtn?.addEventListener('click', () => this.wsConnection.reconnect());

    closeMenuBtn?.addEventListener('click', () => closeMobileMenu());
    settingsBtnMobile?.addEventListener('click', () => {
      this.showSettings();
      closeMobileMenu();
    });
    sessionsBtnMobile?.addEventListener('click', () => {
      showMobileSessionsModal(this);
      closeMobileMenu();
    });
    closeSessionBtnMobile?.addEventListener('click', async () => {
      await this.closeSession();
      closeMobileMenu();
    });
    reconnectBtnMobile?.addEventListener('click', () => {
      this.wsConnection.reconnect();
      closeMobileMenu();
    });
    clearBtnMobile?.addEventListener('click', () => {
      this.terminal?.reset();
      closeMobileMenu();
    });
    attachImageBtnMobile?.addEventListener('click', () => {
      if (this.imagePasteTarget) {
        pickImage(this.imagePasteTarget);
      }
      closeMobileMenu();
    });

    setupSettingsModal(this);
    this.folderBrowser.setup();
    setupNewSessionModal(this);
    setupTerminalOptionsModal(this);
    setupMobileSessionsModal(this);
  }

  // ---------------------------------------------------------------------------
  // Plan detection
  // ---------------------------------------------------------------------------

  private setupPlanDetector(): void {
    this.planDetector.onPlanDetected = (plan: PlanData) => this.showPlanModal(plan);
    this.planDetector.onPlanModeChange = (_isActive: boolean) => {
      // Plan mode indicator UI has been removed
    };

    const acceptBtn = document.getElementById('acceptPlanBtn');
    const rejectBtn = document.getElementById('rejectPlanBtn');
    const closeBtn = document.getElementById('closePlanBtn');

    acceptBtn?.addEventListener('click', () => this.acceptPlan());
    rejectBtn?.addEventListener('click', () => this.rejectPlan());
    closeBtn?.addEventListener('click', () => this.hidePlanModal());

    this.planDetector.startMonitoring();
  }

  private showPlanModal(plan: PlanData): void {
    const modal = document.getElementById('planModal');
    const content = document.getElementById('planContent');
    if (!content || !modal) return;

    // plan.content is raw terminal output: anything the agent prints (a file it
    // cats, a fetched page, a dependency README) reaches this sink. Escape
    // first, so only the tags produced below are live HTML.
    const escaped = plan.content
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

    const formatted = escaped
      .replace(/^### (.*?)$/gm, '<h3>$1</h3>')
      .replace(/^## (.*?)$/gm, '<h2>$1</h2>')
      .replace(/^- (.*?)$/gm, '\u2022 $1')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');

    content.innerHTML = formatted;
    modal.classList.add('active');
    playNotificationSound();
  }

  private hidePlanModal(): void {
    document.getElementById('planModal')?.classList.remove('active');
    // Without this the next output chunk re-detects the same plan and
    // immediately reopens the modal.
    this.planDetector.clearBuffer();
  }

  private acceptPlan(): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'input', data: 'y\n' }));
    }
    this.hidePlanModal();
    this.planDetector.clearBuffer();
    showNotification('Plan accepted! Claude will begin implementation.');
  }

  private rejectPlan(): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'input', data: 'n\n' }));
    }
    this.hidePlanModal();
    this.planDetector.clearBuffer();
    showNotification('Plan rejected. You can provide feedback to Claude.');
  }

  // ---------------------------------------------------------------------------
  // Delegate methods (public API consumed by other modules)
  // ---------------------------------------------------------------------------

  connect(sessionId: string | null = null): Promise<void> {
    return this.wsConnection.connect(sessionId);
  }

  disconnect(): void {
    this.wsConnection.disconnect();
  }

  send(data: Record<string, unknown>): void {
    this.wsConnection.send(data);
  }

  handleMessage(message: WsMessage): void {
    this.messageHandler.handle(message);
  }

  fitTerminal(): void {
    fitTerminal(this);
  }

  getAlias(kind: AgentKind | string): string {
    return configGetAlias(this, kind);
  }

  getRuntimeLabel(
    kind: AgentKind | string | undefined,
    runtimeLabel: string | undefined,
    fallback = 'Claude',
  ): string {
    return configGetRuntimeLabel(this, kind, runtimeLabel, fallback);
  }

  getRuntimeStartMessage(kind: AgentKind, options: RuntimeStartOptions = {}): string {
    return configGetRuntimeStartMessage(this, kind, options);
  }

  // Session actions
  loadSessions(): Promise<void> {
    return sessionsLoadSessions(this);
  }

  joinSession(sessionId: string): Promise<void> {
    return sessionsJoinSession(this, sessionId);
  }

  leaveSession(): void {
    sessionsLeaveSession(this);
  }

  deleteSession(sessionId: string, options?: { confirm?: boolean }): Promise<void> {
    return sessionsDeleteSession(this, sessionId, options);
  }

  startClaudeSession(options: RuntimeStartOptions = {}): Promise<void> {
    return sessionsStartClaude(this, options);
  }

  startCodexSession(options: RuntimeStartOptions = {}): Promise<void> {
    return sessionsStartCodex(this, options);
  }

  startAgentSession(options: RuntimeStartOptions = {}): Promise<void> {
    return sessionsStartAgent(this, options);
  }

  startPiSession(options: RuntimeStartOptions = {}): Promise<void> {
    return sessionsStartPi(this, options);
  }

  startGrokSession(options: RuntimeStartOptions = {}): Promise<void> {
    return sessionsStartGrok(this, options);
  }

  startQwenSession(options: RuntimeStartOptions = {}): Promise<void> {
    return sessionsStartQwen(this, options);
  }

  startKimiSession(options: RuntimeStartOptions = {}): Promise<void> {
    return sessionsStartKimi(this, options);
  }

  startTerminalSession(options: RuntimeStartOptions = {}): Promise<void> {
    return sessionsStartTerminal(this, options);
  }

  closeSession(): Promise<void> {
    return sessionsCloseSession(this);
  }

  // UI shortcuts
  showSettings(): void {
    settingsShow(this);
  }

  showNewSessionModal(): void {
    modalsShowNewSession(this);
  }

  showTerminalOptionsModal(): void {
    modalsShowTerminalOptions(this);
  }

  requestUsageStats(): void {
    // The usage panel was removed from the UI, so every response was discarded
    // while the 10s interval kept the server rescanning the whole
    // ~/.claude/projects corpus. Left as a no-op hook for when the UI returns.
  }

  startHeartbeat(): void {
    this.wsConnection.startHeartbeat();
  }
}
