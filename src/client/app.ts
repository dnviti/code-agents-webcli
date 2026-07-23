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
import { showOverlay, hideOverlay } from './ui/overlay';
import {
  showSettings as settingsShow,
  loadSettings,
  applySettings,
} from './ui/settings';
import {
  showNewSessionModal as modalsShowNewSession,
  showTerminalOptionsModal as modalsShowTerminalOptions,
} from './ui/modals';
import {
  detectMobile,
  disablePullToRefresh,
  showMobileSessionsModal,
  watchViewport,
} from './ui/mobile';
import { showNotification, playNotificationSound } from './ui/notifications';
import { setupUpdateBanner } from './ui/update-banner';
import { pickImage, type ImagePasteTarget } from './terminal/paste';
import { SplitContainer } from './splits/split-container';
import { shellStore } from './shell/store';
import { setupInstallPrompt } from './shell/install-prompt';
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
    // Before anything renders: the shell lays itself out differently on a phone
    // (bottom bar instead of status bar), and a first paint in the wrong mode
    // would resize the terminal twice.
    shellStore.setState({ isMobile: this.isMobile });

    // Before the first await. `beforeinstallprompt` fires once and is not
    // replayed, so a listener attached after a network round trip is a listener
    // that can miss it outright.
    setupInstallPrompt();

    await loadConfig(this);
    setupTerminal(this);
    this.setupPlanDetector();
    applySettings(this, loadSettings());
    disablePullToRefresh();
    watchViewport(this);
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

    if (this.sessionTabManager.tabs.size > 0) {
      const firstTabId = this.sessionTabManager.tabs.keys().next().value;
      await this.sessionTabManager.switchToTab(firstTabId!);
      hideOverlay();
    } else {
      hideOverlay();
      void this.folderBrowser.show();
    }

    window.addEventListener('resize', () => this.fitTerminal());
    window.addEventListener('beforeunload', () => this.wsConnection.disconnect());
  }

  // ---------------------------------------------------------------------------
  // UI wiring (button clicks -> module functions)
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Plan detection
  // ---------------------------------------------------------------------------

  private setupPlanDetector(): void {
    this.planDetector.onPlanDetected = (plan: PlanData) => this.showPlanModal(plan);
    this.planDetector.onPlanModeChange = (_isActive: boolean) => {
      // Plan mode indicator UI has been removed
    };

    this.planDetector.startMonitoring();
  }

  private showPlanModal(plan: PlanData): void {
    // plan.content is raw terminal output: anything the agent prints (a file it
    // cats, a fetched page, a dependency README) reaches this sink. It used to
    // be escaped here and then re-parsed as HTML; PlanDialog builds React
    // elements from it instead, so it can never become markup at all.
    shellStore.setState({ plan: plan.content });
    playNotificationSound();
  }

  hidePlanModal(): void {
    shellStore.setState({ plan: null });
    // Without this the next output chunk re-detects the same plan and
    // immediately reopens the modal.
    this.planDetector.clearBuffer();
  }

  acceptPlan(): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'input', data: 'y\n' }));
    }
    this.hidePlanModal();
    this.planDetector.clearBuffer();
    showNotification('Plan accepted! Claude will begin implementation.');
  }

  rejectPlan(): void {
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

  /**
   * Back out of the runtime picker.
   *
   * Choosing a working directory creates the session before the runtime is
   * picked, so cancelling has to delete it again — otherwise an empty session
   * is left behind on the server every time someone changes their mind.
   */
  async cancelStartPrompt(): Promise<void> {
    if (!this.currentClaudeSessionId) {
      hideOverlay();
      return;
    }

    await this.deleteSession(this.currentClaudeSessionId, { confirm: false });
  }

  // UI shortcuts
  showSettings(): void {
    settingsShow();
  }

  showNewSessionModal(): void {
    modalsShowNewSession();
  }

  showTerminalOptionsModal(): void {
    modalsShowTerminalOptions();
  }

  showSessions(): void {
    showMobileSessionsModal(this);
  }

  /** Reachable from the palette, the mobile bar and the connection overlay. */
  reconnect(): void {
    this.wsConnection.reconnect();
  }

  clearTerminal(): void {
    this.terminal?.reset();
  }

  attachImage(): void {
    if (this.imagePasteTarget) {
      pickImage(this.imagePasteTarget);
    }
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
