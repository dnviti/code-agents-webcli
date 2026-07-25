// Session tab management: create, switch, reorder, and close tabs
//
// The strip is rendered by the Relay `TabBar` from `shellStore`. This class no
// longer builds or reads any DOM: `tabs` used to be `Map<string, HTMLElement>`
// and several methods read state back out of those nodes (a tab's name came
// from its `.tab-name` textContent, unread came from a CSS class). It is a
// plain record now, and `syncShell()` is the only way any of it reaches the
// screen.

import type { App } from '../app';
import type { SessionInfo } from '../types';
import { clearChatSurface } from '../chat/surface';
import { shellStore, type ShellTab } from '../shell/store';
import { playNotificationSound, showNotification } from '../ui/notifications';

/** What the strip needs about a tab that `SessionInfo` does not already say. */
interface TabRecord {
  id: string;
  /** The label shown on the tab, which is not always the session name. */
  displayName: string;
  /**
   * Which surface the session runs on, as far as this client knows.
   *
   * Learned from the session list at boot and from `session_joined` /
   * `chat_started` afterwards. It decides whether the browser subscribes to the
   * conversation's event stream, which is what keeps a chat tab live while the
   * user is looking at a different one.
   */
  surface: 'terminal' | 'chat';
}

export class SessionTabManager {
  app: App;
  tabs: Map<string, TabRecord>;
  activeSessions: Map<string, SessionInfo>;
  activeTabId: string | null;
  tabOrder: string[];
  tabHistory: string[];
  notificationsEnabled: boolean;

  constructor(app: App) {
    this.app = app;
    this.tabs = new Map();
    this.activeSessions = new Map();
    this.activeTabId = null;
    this.tabOrder = [];
    this.tabHistory = [];
    this.notificationsEnabled = false;
    this.requestNotificationPermission();
  }

  getAlias(kind: string): string {
    return this.app.getAlias(kind as never);
  }

  // ---------------------------------------------------------------------------
  // Notifications
  // ---------------------------------------------------------------------------

  requestNotificationPermission(): void {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') {
      this.notificationsEnabled = true;
    } else if (Notification.permission === 'default') {
      Notification.requestPermission().then((permission) => {
        this.notificationsEnabled = permission === 'granted';
      });
    }
  }

  sendNotification(title: string, body: string, sessionId: string): void {
    if (sessionId === this.activeTabId) return;
    if (document.visibilityState === 'visible') return;

    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        const notification = new Notification(title, {
          body,
          icon: '/favicon.ico',
          tag: sessionId,
          requireInteraction: false,
          silent: false,
        });

        notification.onclick = () => {
          window.focus();
          this.switchToTab(sessionId);
          notification.close();
        };

        setTimeout(() => notification.close(), 5000);
        return;
      } catch {
        // fall through to the in-page fallback
      }
    }

    this.showInPageNotification(title, body);
  }

  /**
   * Fallback for a device that refuses system notifications.
   *
   * It used to build its own fixed-position div with an inline stylesheet and
   * its own keyframes. It is the app's toast now — one primitive, one place
   * where the styling and the screen-reader announcement are decided.
   */
  private showInPageNotification(title: string, body: string): void {
    const originalTitle = document.title;
    let flashCount = 0;
    const flashInterval = setInterval(() => {
      document.title = flashCount % 2 === 0 ? `• ${title}` : originalTitle;
      flashCount++;
      if (flashCount > 6) {
        clearInterval(flashInterval);
        document.title = originalTitle;
      }
    }, 1000);

    if ('vibrate' in navigator) {
      try { navigator.vibrate([200, 100, 200]); } catch { /* unsupported */ }
    }

    showNotification(`${title} — ${body}`);
    playNotificationSound();
  }

  // ---------------------------------------------------------------------------
  // Tab ordering helpers
  // ---------------------------------------------------------------------------

  /**
   * Publish tab state to the React shell.
   *
   * The store drops no-op updates, so the duplicate calls that come from a
   * single logical change (a switch touches order, history and status) collapse
   * into one render.
   */
  syncShell(): void {
    const tabs: ShellTab[] = this.getOrderedTabIds()
      .map((id) => {
        const session = this.activeSessions.get(id);
        const record = this.tabs.get(id);
        if (!session || !record) return null;
        return {
          id,
          title: record.displayName,
          surface: record.surface,
          status:
            session.hasError || session.status === 'error'
              ? 'error'
              : session.status === 'active'
                ? 'running'
                : 'idle',
          // Not yet tracked per session; the server's SessionRecord.agent would
          // have to be plumbed through the list endpoint first.
          kind: '',
          workingDir: session.workingDir,
          unread: session.unreadOutput,
        } satisfies ShellTab;
      })
      .filter((tab): tab is ShellTab => tab !== null);

    shellStore.setState({ tabs, activeId: this.activeTabId });
  }

  getOrderedTabIds(): string[] {
    this.tabOrder = this.tabOrder.filter((id) => this.tabs.has(id));
    return [...this.tabOrder];
  }

  /**
   * Apply an order the tab strip produced by dragging.
   *
   * Ids the strip does not know about are appended rather than dropped: a tab
   * created while a drag was in flight must not disappear because the dragged
   * order predates it.
   */
  applyOrder(ids: string[]): void {
    const known = ids.filter((id) => this.tabs.has(id));
    const missing = this.tabOrder.filter((id) => this.tabs.has(id) && !known.includes(id));
    this.tabOrder = [...known, ...missing];
    this.syncShell();
  }

  updateTabHistory(sessionId: string): void {
    this.tabHistory = this.tabHistory.filter((id) => id !== sessionId && this.tabs.has(id));
    this.tabHistory.unshift(sessionId);
    if (this.tabHistory.length > 50) this.tabHistory.length = 50;
  }

  removeFromHistory(sessionId: string): void {
    this.tabHistory = this.tabHistory.filter((id) => id !== sessionId);
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  async init(): Promise<void> {
    this.setupKeyboardShortcuts();
    await this.loadSessions();
    this.syncShell();
  }

  setupKeyboardShortcuts(): void {
    document.addEventListener('keydown', (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 't') {
        e.preventDefault();
        this.createNewSession();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'w') {
        e.preventDefault();
        if (this.activeTabId) this.closeSession(this.activeTabId);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        this.switchToNextTab();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Tab' && e.shiftKey) {
        e.preventDefault();
        this.switchToPreviousTab();
      }
      if (e.altKey && e.key >= '1' && e.key <= '9') {
        e.preventDefault();
        this.switchToTabByIndex(parseInt(e.key) - 1);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Session loading
  // ---------------------------------------------------------------------------

  async loadSessions(): Promise<unknown[]> {
    try {
      const response = await fetch('/api/sessions/list');
      const data = await response.json();
      const sessions: Array<Record<string, never>> = data.sessions || [];

      sessions.forEach((raw, index: number) => {
        const session = raw as unknown as {
          id: string; name: string; active: boolean; workingDir: string | null;
          surface?: 'terminal' | 'chat';
        };
        this.addTab(
          session.id,
          session.name,
          session.active ? 'active' : 'idle',
          session.workingDir,
          false,
        );
        if (session.surface === 'chat') {
          this.setTabSurface(session.id, 'chat');
        }
        const sessionData = this.activeSessions.get(session.id);
        if (sessionData) {
          sessionData.lastAccessed = Date.now() - (sessions.length - index) * 1000;
        }
      });

      if (this.app.isMobile) {
        this.reorderTabsByLastAccessed();
      }

      return sessions;
    } catch (error) {
      console.error('Failed to load sessions:', error);
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Tab CRUD
  // ---------------------------------------------------------------------------

  addTab(
    sessionId: string,
    sessionName: string,
    status: SessionInfo['status'] = 'idle',
    workingDir: string | null = null,
    autoSwitch = true,
  ): void {
    if (this.tabs.has(sessionId)) return;

    const isDefaultSessionName = sessionName.startsWith('Session ') && sessionName.includes(':');
    const folderName = workingDir ? workingDir.split('/').pop() || '/' : null;
    const displayName = !isDefaultSessionName ? sessionName : (folderName || sessionName);

    this.tabs.set(sessionId, { id: sessionId, displayName, surface: 'terminal' });
    if (!this.tabOrder.includes(sessionId)) {
      this.tabOrder.push(sessionId);
    }

    this.activeSessions.set(sessionId, {
      id: sessionId,
      name: sessionName,
      status,
      workingDir,
      lastAccessed: Date.now(),
      lastActivity: Date.now(),
      unreadOutput: false,
      hasError: false,
    });

    this.syncShell();

    if (this.tabs.size === 1 && autoSwitch) {
      this.switchToTab(sessionId);
    }
  }

  /**
   * Record that a session runs on the chat surface, and start watching it.
   *
   * Subscribing here rather than on tab switch is the whole point: a browser
   * follows every conversation it has a tab for, so the one it is not looking
   * at still streams, still moves its tab, and is still there — complete — when
   * the user comes back to it. Idempotent, because the same fact arrives from
   * the session list, from `session_joined` and from `chat_started`.
   */
  setTabSurface(sessionId: string, surface: 'terminal' | 'chat'): void {
    const record = this.tabs.get(sessionId);
    if (!record || record.surface === surface) return;

    record.surface = surface;
    if (surface === 'chat') {
      this.app.chats.subscribe(sessionId);
    }
    this.syncShell();
  }

  /** Re-establish every chat subscription, e.g. after the socket reconnected. */
  resubscribeChats(): void {
    for (const record of this.tabs.values()) {
      if (record.surface === 'chat') {
        this.app.chats.subscribe(record.id);
      }
    }
  }

  async switchToTab(sessionId: string, options: { skipHistoryUpdate?: boolean } = {}): Promise<void> {
    if (!this.tabs.has(sessionId)) return;

    if (
      this.activeTabId === sessionId &&
      this.app.currentClaudeSessionId === sessionId
    ) {
      this.updateHeaderInfo(sessionId);
      return;
    }

    this.activeTabId = sessionId;

    const session = this.activeSessions.get(sessionId);
    if (session) {
      session.lastAccessed = Date.now();
      if (session.unreadOutput) this.updateUnreadIndicator(sessionId, false);
    }

    if (!options.skipHistoryUpdate) {
      this.updateTabHistory(sessionId);
    }

    // The strip scrolls the active tab into view itself, so there is no longer
    // any reason to shuffle the order on a narrow screen — reordering under a
    // user who just tapped a tab is exactly the thing that made the old mobile
    // strip feel unpredictable.
    this.syncShell();

    await this.app.joinSession(sessionId);
    this.updateHeaderInfo(sessionId);
  }

  reorderTabsByLastAccessed(): void {
    this.tabOrder = this.getOrderedTabIds().sort((a, b) => {
      const sa = this.activeSessions.get(a);
      const sb = this.activeSessions.get(b);
      return (sb?.lastAccessed ?? 0) - (sa?.lastAccessed ?? 0);
    });
    this.syncShell();
  }

  closeSession(sessionId: string, { skipServerRequest = false } = {}): void {
    if (!this.tabs.has(sessionId)) return;

    const orderedIds = this.getOrderedTabIds();
    const closedIndex = orderedIds.indexOf(sessionId);

    this.tabs.delete(sessionId);
    this.activeSessions.delete(sessionId);
    this.tabOrder = orderedIds.filter((id) => id !== sessionId);
    this.removeFromHistory(sessionId);
    // Closing the tab is the client saying it no longer wants this
    // conversation's events; without this the socket keeps receiving them for
    // a transcript nothing will ever render.
    this.app.chats.drop(sessionId);

    // And take it off the screen. The surface is only ever *replaced* by
    // joining another session, so closing the last tab — or closing a chat
    // while the fallback is another chat that has not joined yet — left the
    // dead conversation sitting there, complete with a composer that could
    // not send anything.
    if (shellStore.getSnapshot().chat.sessionId === sessionId) {
      clearChatSurface();
    }

    this.syncShell();

    if (!skipServerRequest) {
      fetch(`/api/sessions/${sessionId}`, { method: 'DELETE' }).catch(
        (err) => console.error('Failed to delete session:', err),
      );
    }

    if (this.activeTabId === sessionId) {
      this.activeTabId = null;
      let fallbackId = this.tabHistory.find((id) => this.tabs.has(id));
      if (!fallbackId && this.tabOrder.length > 0) {
        const nextIndex = closedIndex >= 0 ? Math.min(closedIndex, this.tabOrder.length - 1) : 0;
        fallbackId = this.tabOrder[nextIndex];
      }
      if (fallbackId) {
        this.switchToTab(fallbackId);
      } else {
        this.syncShell();
      }
    }
  }

  /**
   * Rename a tab.
   *
   * The label used to be edited in place by swapping the span for an input,
   * which meant the name lived in the DOM and the rename was lost on any
   * re-render. `RenameDialog` collects the name; this stores it.
   */
  renameTab(sessionId: string, newName: string): void {
    const record = this.tabs.get(sessionId);
    const name = newName.trim();
    if (!record || !name) return;

    record.displayName = name;
    const session = this.activeSessions.get(sessionId);
    if (session) session.name = name;
    this.syncShell();
  }

  closeOthers(sessionId: string): void {
    this.getOrderedTabIds().forEach((id) => {
      if (id !== sessionId) this.closeSession(id);
    });
  }

  createNewSession(): void {
    this.app.isCreatingNewSession = true;
    void this.app.folderBrowser.show();
  }

  // ---------------------------------------------------------------------------
  // Tab navigation
  // ---------------------------------------------------------------------------

  switchToNextTab(): void {
    if (this.tabHistory.length > 1) {
      const nextId = this.tabHistory.find((id) => id !== this.activeTabId && this.tabs.has(id));
      if (nextId) { this.switchToTab(nextId); return; }
    }
    const tabIds = this.getOrderedTabIds();
    if (tabIds.length === 0) return;
    const currentIndex = tabIds.indexOf(this.activeTabId || '');
    const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % tabIds.length : 0;
    this.switchToTab(tabIds[nextIndex]);
  }

  switchToPreviousTab(): void {
    const tabIds = this.getOrderedTabIds();
    if (tabIds.length === 0) return;
    const currentIndex = tabIds.indexOf(this.activeTabId || '');
    const prevIndex = currentIndex >= 0 ? (currentIndex - 1 + tabIds.length) % tabIds.length : tabIds.length - 1;
    this.switchToTab(tabIds[prevIndex]);
  }

  switchToTabByIndex(index: number): void {
    const tabIds = this.getOrderedTabIds();
    if (index < tabIds.length) this.switchToTab(tabIds[index]);
  }

  // ---------------------------------------------------------------------------
  // Status updates
  // ---------------------------------------------------------------------------

  /**
   * Publish the active session's working directory to the status bar.
   *
   * It used to write into `#workingDir`, an element that has not existed in the
   * markup for some time — the lookup was defensive, so the feature had simply
   * stopped happening without anything failing.
   */
  updateHeaderInfo(sessionId: string): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;
    const { connection } = shellStore.getSnapshot();
    shellStore.setState({
      connection: { ...connection, workingDir: session.workingDir },
    });
  }

  updateTabStatus(sessionId: string, status: SessionInfo['status']): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    const wasActive = session.status === 'active';

    session.status = status;
    session.lastActivity = Date.now();
    if (status !== 'error') session.hasError = false;

    // A session that was working and has gone quiet in the background is the
    // one signal worth carrying on the tab, so the dot survives the transition.
    if (wasActive && status === 'idle' && sessionId !== this.activeTabId) {
      session.unreadOutput = true;
    }

    this.syncShell();
  }

  markSessionActivity(sessionId: string, hasOutput = false, outputData = ''): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    const previousActivity = session.lastActivity || 0;
    const wasActive = session.status === 'active';
    session.lastActivity = Date.now();

    if (hasOutput) {
      this.updateTabStatus(sessionId, 'active');

      clearTimeout(session.idleTimeout);
      clearTimeout(session.workCompleteTimeout);

      session.workCompleteTimeout = setTimeout(() => {
        const s = this.activeSessions.get(sessionId);
        if (s && s.status === 'active') {
          this.updateTabStatus(sessionId, 'idle');
          if (wasActive && sessionId !== this.activeTabId) {
            const sessionName = s.name || 'Session';
            const duration = Date.now() - previousActivity;
            this.updateUnreadIndicator(sessionId, true);
            this.sendNotification(
              `${sessionName} -- ${this.getAlias('claude')} appears finished`,
              `No output for 90 seconds (worked for ${Math.round(duration / 1000)}s)`,
              sessionId,
            );
          }
        }
      }, 90000);

      session.idleTimeout = setTimeout(() => {
        // 5-minute backstop; the 90-second timeout handles the transition
      }, 300000);
    }

    if (hasOutput && outputData) {
      this.checkForCommandCompletion(sessionId, outputData);
    }
  }

  private checkForCommandCompletion(sessionId: string, outputData: string): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    const completionPatterns = [
      /build\s+successful/i,
      /compilation\s+finished/i,
      /tests?\s+passed/i,
      /deployment\s+complete/i,
      /npm\s+install.*completed/i,
      /successfully\s+compiled/i,
      /✓\s+All\s+tests\s+passed/i,
      /Done\s+in\s+\d+\.\d+s/i,
    ];

    const hasCompletion = completionPatterns.some((p) => p.test(outputData));

    if (hasCompletion && sessionId !== this.activeTabId) {
      let message = 'Task completed successfully';
      if (/build\s+successful/i.test(outputData)) message = 'Build completed successfully';
      else if (/tests?\s+passed/i.test(outputData)) message = 'All tests passed';
      else if (/deployment\s+complete/i.test(outputData)) message = 'Deployment completed';

      this.updateUnreadIndicator(sessionId, true);
      this.sendNotification(session.name || 'Session', message, sessionId);
    }
  }

  updateUnreadIndicator(sessionId: string, hasUnread: boolean): void {
    const session = this.activeSessions.get(sessionId);
    if (!session || session.unreadOutput === hasUnread) return;
    session.unreadOutput = hasUnread;
    this.syncShell();
  }

  markSessionError(sessionId: string, hasError = true): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    session.hasError = hasError;
    if (hasError) {
      this.updateTabStatus(sessionId, 'error');
      this.sendNotification(
        `Error in ${session.name || 'Session'}`,
        'A command has failed or the session encountered an error',
        sessionId,
      );
    } else {
      this.syncShell();
    }
  }
}
