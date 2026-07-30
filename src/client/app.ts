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
import { ChatRegistry } from './chat/registry';
import { syncChatSurface } from './chat/surface';
import { noteChatEvent, syncConversationAttention, watchAttention } from './chat/attention';
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
  startOmpSession as sessionsStartOmp,
  startTerminalSession as sessionsStartTerminal,
  closeSession as sessionsCloseSession,
} from './sessions/actions';
import { FolderBrowser } from './ui/folder-browser';
import { PlanDetector } from './ui/plan-detector';
import { showOverlay, hideOverlay } from './ui/overlay';
import { setConversationOpener, startNotifyRouting } from './ui/notify';
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
import { watchKeyboardInset } from './terminal/keyboard';
import { installBrowserShortcutGuard } from './ui/browser-shortcuts';
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
  /**
   * Watchdog for a launch the server never answers.
   *
   * A start request is fire-and-forget over the socket, so a server that does
   * not understand it drops it and the spinner covers the screen forever with
   * nothing to click. That is not hypothetical: the server loads its code once
   * at boot, so a long-running process paired with a freshly built page is
   * exactly a client that speaks a message the server has never heard of.
   */
  runtimeStartTimer: ReturnType<typeof setTimeout> | null;
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
  /**
   * Every chat conversation this page is watching, keyed by session id.
   *
   * A registry rather than a single controller: the browser can hold a tab per
   * conversation and each one keeps its own transcript and its own live
   * subscription, so switching tabs shows a different conversation instead of
   * overwriting the one that was there.
   */
  chats: ChatRegistry;
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
    this.runtimeStartTimer = null;
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
      omp: 'Oh My Pi',
      terminal: 'Terminal',
    };

    this.isMobile = detectMobile();
    this.currentMode = 'chat';

    this.wsConnection = new WebSocketConnection(this);
    this.messageHandler = new MessageHandler(this);
    this.chats = new ChatRegistry({
      send: (message) => this.send(message),
      onChange: (sessionId) => {
        syncChatSurface(this);
        // The id was being dropped here, which is what kept every conversation
        // this browser is not looking at invisible to the rest of the app. A
        // snapshot arriving for a background chat is how a reloaded page learns
        // that one of its conversations has been sitting blocked all along.
        syncConversationAttention(this, sessionId);
      },
      onEvent: (sessionId, event) => noteChatEvent(this, sessionId, event),
    });
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
    // Same reason: a notification outlives the page that raised it, so one can
    // be clicked while this window is still fetching its session list. The
    // worker posts once and does not retry — the id is held until the tab
    // manager exists to act on it.
    startNotifyRouting();

    await loadConfig(this);
    setupTerminal(this);
    // One listener for the page. Which surfaces it applies to is decided by
    // the `data-claims-shortcuts` attribute, not by this call — the composer,
    // the dialogs and every ordinary text field keep the browser's defaults.
    installBrowserShortcutGuard();
    this.setupPlanDetector();
    applySettings(this, loadSettings());
    disablePullToRefresh();
    watchViewport(this);
    // The keyboard must lift the app, not cover it: Android Chrome handles
    // that via the viewport meta, iOS Safari via this visualViewport watcher.
    const appEl = document.getElementById('app');
    if (appEl) watchKeyboardInset(appEl, () => this.fitTerminal());
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
      // The tab this browser was last on, or the first one if that session is
      // gone — not always the first one, which sent every reload back to the
      // start of the strip. A notification acted on during startup outranks
      // both, and is consumed here rather than switching twice.
      const initialTabId = this.sessionTabManager.initialTabId();
      if (initialTabId) await this.sessionTabManager.switchToTab(initialTabId);
      hideOverlay();
      // After the initial switch, so a click that landed mid-boot is the tab
      // this window opens on rather than one it moves off a moment later. A
      // click after this point goes straight through.
      this.wireConversationOpener();
    } else {
      hideOverlay();
      this.wireConversationOpener();
      // A window with nothing open still has to be reachable. The socket used
      // to be opened by joining a session, so a browser with no tabs — a phone
      // signed in for the first time, or one whose conversations are all closed
      // — had no connection at all, and nothing could tell it that a session had
      // been started on another screen (#163). It sat on the folder browser
      // until someone reloaded it.
      //
      // Without a session id, which is a connection the server is happy to
      // accept: it only auto-joins when one is named.
      void this.connect().catch(() => {
        // Offline, or the server is still coming up. The reconnect loop owns
        // it from here, and nothing on the screen depends on this having
        // succeeded.
      });
      void this.folderBrowser.show();
    }

    window.addEventListener('resize', () => this.fitTerminal());
    window.addEventListener('beforeunload', () => this.wsConnection.disconnect());
  }

  /**
   * Where acting on a conversation notification lands.
   *
   * Wired once the opening tab has been decided, because setting it is what
   * delivers a click the service worker made while this window was still
   * starting up — and a switch delivered before the initial tab is chosen would
   * be immediately overridden by it.
   */
  private wireConversationOpener(): void {
    setConversationOpener((sessionId) => {
      try {
        window.focus();
      } catch {
        // Focusing is a courtesy; switching is the part that matters.
      }
      void this.sessionTabManager.switchToTab(sessionId);
    });
    watchAttention(this);
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

  /** Resolves true when the session was actually deleted. */
  deleteSession(sessionId: string, options?: { confirm?: boolean }): Promise<boolean> {
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

  startOmpSession(options: RuntimeStartOptions = {}): Promise<void> {
    return sessionsStartOmp(this, options);
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
