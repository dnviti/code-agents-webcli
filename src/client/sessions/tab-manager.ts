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
import type { ConversationAttention } from '../../shared/chat-alerts';
import { clearChatSurface } from '../chat/surface';
import { noteConversationClosed, noteConversationOpened } from '../chat/attention';
import { releaseTerminals } from '../chat/chat-terminal';
import { shellStore, type ShellTab } from '../shell/store';
import { playNotificationSound, showNotification } from '../ui/notifications';
import { takeRequestedConversation } from '../ui/notify';

/** What the strip needs about a tab that `SessionInfo` does not already say. */
interface TabRecord {
  id: string;
  /** The label shown on the tab, which is not always the session name. */
  displayName: string;
  /**
   * The label the user chose, if they chose one.
   *
   * Kept apart from `displayName` so a rename that the server refuses can be
   * put back the way it was, and so a session the user never renamed still goes
   * through the generated-name rules rather than being pinned to whatever the
   * strip happened to be showing.
   */
  customName?: string;
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

/**
 * Where this browser remembers the tab it was last on.
 *
 * In the browser and not on the server, because which tab you are looking at is
 * a property of the window you are looking at it in — a shared answer would have
 * a second window dragging the first one around.
 *
 * Written to both stores and read from sessionStorage first. sessionStorage is
 * per window, which is what lets two windows sit on different sessions and each
 * come back to its own after a reload. localStorage is the fallback for a window
 * that has no session storage to read yet — a newly opened one, or a browser
 * started fresh — which would otherwise always land on the first tab.
 */
const ACTIVE_TAB_KEY = 'cc-web-active-tab';

function rememberActiveTab(sessionId: string): void {
  for (const store of storages()) {
    try {
      store.setItem(ACTIVE_TAB_KEY, sessionId);
    } catch {
      // Private mode, a full quota, storage switched off. Losing the memory of
      // which tab was open is not a reason to fail a tab switch.
    }
  }
}

function recallActiveTab(): string | null {
  for (const store of storages()) {
    try {
      const stored = store.getItem(ACTIVE_TAB_KEY);
      if (stored) return stored;
    } catch {
      // Same as above, and the next store still gets its turn.
    }
  }
  return null;
}

/**
 * Which conversations this browser has been told to take off the screen.
 *
 * Closing a conversation no longer deletes it (#127), which on its own would
 * have made closing useless: the strip is rebuilt from `/api/sessions/list` on
 * every page load, so every conversation ever started would come back on the
 * next reload and the strip would still grow forever — the exact complaint, with
 * the one remedy removed.
 *
 * In the browser rather than on the server because it is a fact about a screen,
 * not about a conversation: another device's strip is not this one's. Browser-wide
 * rather than per-window so a reload keeps what was closed, which is the whole
 * point of storing it at all.
 *
 * Only ever conversations. A terminal is still ended when its tab closes, so
 * there is nothing to remember about it — and remembering one would hide a
 * session that is genuinely still there from the only list that offers it.
 */
const CLOSED_TABS_KEY = 'cc-web-closed-conversations';

function readClosed(): Set<string> {
  try {
    const raw = localStorage.getItem(CLOSED_TABS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []);
  } catch {
    // No storage, or something else wrote nonsense here. Showing every
    // conversation is the honest fallback: it is what the app did before this.
    return new Set();
  }
}

function writeClosed(ids: Set<string>): void {
  try {
    if (ids.size === 0) localStorage.removeItem(CLOSED_TABS_KEY);
    else localStorage.setItem(CLOSED_TABS_KEY, JSON.stringify(Array.from(ids)));
  } catch {
    // Private mode, a full quota, storage switched off. The tab closes either
    // way; it simply comes back on the next reload.
  }
}

/** This window's memory first, then the browser-wide one. */
function storages(): Storage[] {
  const found: Storage[] = [];
  try {
    if (typeof sessionStorage !== 'undefined') found.push(sessionStorage);
  } catch { /* blocked */ }
  try {
    if (typeof localStorage !== 'undefined') found.push(localStorage);
  } catch { /* blocked */ }
  return found;
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
          attention: session.attention ?? null,
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
      const all: Array<Record<string, never>> = data.sessions || [];

      // A conversation this browser closed stays closed. Pruned against what the
      // server actually reported at the same time, so the memory cannot outlive
      // the conversations it is about and grow without limit.
      const closed = readClosed();
      const sessions = all.filter((raw) => {
        const session = raw as unknown as { id: string; surface?: 'terminal' | 'chat' };
        return !(session.surface === 'chat' && closed.has(session.id));
      });
      const live = new Set(all.map((raw) => (raw as unknown as { id: string }).id));
      const kept = new Set(Array.from(closed).filter((id) => live.has(id)));
      if (kept.size !== closed.size) writeClosed(kept);

      sessions.forEach((raw, index: number) => {
        const session = raw as unknown as {
          id: string; name: string; active: boolean; workingDir: string | null;
          surface?: 'terminal' | 'chat'; customName?: string; bypassPermissions?: boolean;
        };
        this.addTab(
          session.id,
          session.name,
          session.active ? 'active' : 'idle',
          session.workingDir,
          false,
          session.customName,
        );
        if (session.surface === 'chat') {
          // Before the subscribe inside setTabSurface, so the pane's very first
          // paint already states the mode this conversation is in rather than
          // claiming "asks first" until a snapshot comes back over the socket.
          this.app.chats.ensure(session.id).seedBypass(session.bypassPermissions === true);
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
    customName?: string,
  ): void {
    if (this.tabs.has(sessionId)) return;

    // Whatever the reason for a tab appearing — a fresh session, a branch, or a
    // conversation picked out of the list — it is now on the screen, so the note
    // that it was taken off has to go. Left behind, reopening a conversation
    // would work until the next reload and then quietly vanish again.
    const closed = readClosed();
    if (closed.delete(sessionId)) writeClosed(closed);

    const isDefaultSessionName = sessionName.startsWith('Session ') && sessionName.includes(':');
    const folderName = workingDir ? workingDir.split('/').pop() || '/' : null;
    const generated = !isDefaultSessionName ? sessionName : (folderName || sessionName);
    // A chosen name wins outright: it is the one thing about a tab the user said
    // out loud, so it is not run through the generated-name rules.
    const displayName = customName || generated;

    this.tabs.set(sessionId, { id: sessionId, displayName, customName, surface: 'terminal' });
    if (!this.tabOrder.includes(sessionId)) {
      this.tabOrder.push(sessionId);
    }

    this.activeSessions.set(sessionId, {
      id: sessionId,
      // What a notification calls this session, which is the user's name for it
      // when they have given one.
      name: customName || sessionName,
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
    rememberActiveTab(sessionId);

    const session = this.activeSessions.get(sessionId);
    if (session) {
      session.lastAccessed = Date.now();
      if (session.unreadOutput) this.updateUnreadIndicator(sessionId, false);
    }

    // The user is here; whatever was said about this conversation outside the
    // app has been acted on. The tab's own mark is left alone — a conversation
    // still waiting for an approval is still waiting for it.
    noteConversationOpened(sessionId);

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
    const record = this.tabs.get(sessionId);
    if (!record) return;

    /**
     * Closing a conversation takes it off this screen, and no more.
     *
     * It used to delete it: the tab was the only route back to a conversation,
     * so the one way to shorten a strip that grows forever was to destroy
     * something you might want next week (#127). Now the conversation list is
     * the route back, so closing can mean what the word means — the record, the
     * transcript, whatever is running and whatever shells it opened all stay
     * exactly where they are.
     *
     * Still a delete for a terminal, and that is not an oversight. A pty is
     * reached through its tab and nowhere else, so a terminal closed without
     * being ended is a shell holding a working directory open that nothing in
     * the app can ever reach again — the very failure this change removes for
     * conversations, in the one place it would create.
     */
    const detachOnly = record.surface === 'chat';
    if (detachOnly) {
      const closed = readClosed();
      closed.add(sessionId);
      writeClosed(closed);
    }

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
    // And anything outstanding about it. Nothing will ever arrive to end the
    // alert now — the events it would have ended on are no longer being
    // delivered — so a closed conversation would go on being counted in the
    // summary for the rest of the session.
    noteConversationClosed(sessionId);
    // This page's half of the conversation's shells: live xterms and open
    // sockets, released because nothing is drawing them any more. The note of
    // *which* ptys they were attached to is deliberately kept — those sessions
    // are still running on the server, and reopening this conversation rejoins
    // them rather than opening a second shell beside each one. A conversation
    // with no shells is a no-op.
    releaseTerminals(sessionId);

    // And take it off the screen. The surface is only ever *replaced* by
    // joining another session, so closing the last tab — or closing a chat
    // while the fallback is another chat that has not joined yet — left the
    // dead conversation sitting there, complete with a composer that could
    // not send anything.
    if (shellStore.getSnapshot().chat.sessionId === sessionId) {
      clearChatSurface();
    }

    this.syncShell();

    if (!skipServerRequest && !detachOnly) {
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
        // Joining the fallback detaches from this one on the way, so there is
        // nothing further to do: the server leaves the previous session before
        // it joins the next.
        this.switchToTab(fallbackId);
      } else {
        // Only for a conversation. A terminal has just been deleted, and the
        // server's own `session_deleted` is what tidies up after that — a
        // richer teardown than this, and one that would race with a
        // `leave_session` sent alongside it.
        if (detachOnly) this.detachFrom(sessionId);
        this.syncShell();
      }
    }
  }

  /**
   * Let go of a conversation this socket is still attached to.
   *
   * Only reached when the closed tab was the one in focus and there is no other
   * tab to join — because a join is what would otherwise have detached us. A
   * delete used to do this from the other end: the server answered with
   * `session_deleted` and the client forgot which session it was on.
   *
   * Without it the socket stays joined to a conversation that has left the
   * screen, and `ensureSessionForStart` reads exactly that field to decide where
   * the next runtime goes — so picking an agent from the launcher would have
   * launched it into the conversation the user had just closed.
   */
  private detachFrom(sessionId: string): void {
    if (this.app.currentClaudeSessionId !== sessionId) return;
    this.app.currentClaudeSessionId = null;
    this.app.currentClaudeSessionName = null;
    this.app.leaveSession();
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

    const previous = { displayName: record.displayName, customName: record.customName };
    this.applyName(sessionId, name, name);

    // The label moves now and the server is told afterwards: a rename is the
    // user restating something they already know, and making them watch a round
    // trip for it would be the slowest part of the interaction. If the server
    // refuses — a session that has since been deleted, a name it will not take —
    // the old label goes back, so the strip never keeps a name that was not
    // stored.
    void fetch(`/api/sessions/${sessionId}/name`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
      .then(async (response) => {
        if (!response.ok) {
          this.applyName(sessionId, previous.displayName, previous.customName);
          showNotification('That name could not be saved');
          return;
        }
        // What was stored, which is not always what was typed: the server caps
        // a very long name, and the strip showing one thing while every other
        // window shows another is the disagreement this whole change is about.
        const stored = await response.json().catch(() => null);
        if (stored && typeof stored.name === 'string') {
          this.applyRemoteName(sessionId, stored.name);
        }
      })
      .catch(() => {
        // Offline or mid-reconnect. The tab keeps the new name for this page —
        // reverting a rename because the network blinked is the more annoying
        // failure — and a reload shows what was actually stored.
      });
  }

  /**
   * Take a rename that happened somewhere else: another window, another device.
   *
   * Same store the local rename writes to, so two windows on the same sessions
   * cannot end up disagreeing about what a tab is called.
   */
  applyRemoteName(sessionId: string, name: string): void {
    const trimmed = name.trim();
    const record = this.tabs.get(sessionId);
    if (!record || !trimmed || record.displayName === trimmed) return;
    this.applyName(sessionId, trimmed, trimmed);
  }

  /** Write a label into the tab, the session and the strip. */
  private applyName(
    sessionId: string,
    displayName: string,
    customName: string | undefined,
  ): void {
    const record = this.tabs.get(sessionId);
    if (!record) return;

    record.displayName = displayName;
    record.customName = customName;
    const session = this.activeSessions.get(sessionId);
    if (session) session.name = displayName;
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

  /**
   * The tab a freshly loaded page should open on.
   *
   * The one this browser was last on, if it is still there — coming back to a
   * set of long-running sessions and having to find the one you were in again
   * is the whole complaint. A remembered id that names a session which has since
   * been closed, or ended on another device, falls back to the first tab, which
   * is what the app has always done.
   */
  initialTabId(): string | null {
    // A window opened by acting on a notification, when there was no window to
    // bring forward. It outranks the remembered tab: the user asked for this
    // conversation a second ago, and the remembered one is where they happened
    // to be last time. Read once — see `takeRequestedConversation` — so a
    // reload does not drag them back here.
    const requested = takeRequestedConversation();
    if (requested && this.tabs.has(requested)) return requested;

    const remembered = recallActiveTab();
    if (remembered && this.tabs.has(remembered)) return remembered;
    return this.getOrderedTabIds()[0] ?? this.tabs.keys().next().value ?? null;
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

  /**
   * Record that a conversation is stopped, waiting on a person.
   *
   * Not cleared by looking at the tab, unlike unread: this is derived from the
   * conversation's own state and stops being true when the thing it is waiting
   * for is answered — which may happen in another window, or on a phone.
   */
  setAttention(sessionId: string, attention: ConversationAttention | null): void {
    const session = this.activeSessions.get(sessionId);
    if (!session || (session.attention ?? null) === attention) return;
    session.attention = attention;
    this.syncShell();
  }

  /**
   * What a notification should call this conversation.
   *
   * The tab's own label rather than the raw session name, so a conversation
   * nobody has renamed is announced as the folder it is working in instead of
   * as "Session 7/23/2026, 10:26:39 AM".
   */
  conversationLabel(sessionId: string): string {
    const record = this.tabs.get(sessionId);
    if (record?.displayName) return record.displayName;
    return this.activeSessions.get(sessionId)?.name || 'Conversation';
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
