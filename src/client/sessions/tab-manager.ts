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
  projectId?: string | null;
  projectName?: string | null;
  /**
   * Where this tab falls in the order they were opened on this screen.
   *
   * Read by `reconcile`, and only there. A tab created while the reconcile's
   * own listing was already in flight is missing from that listing through no
   * fault of its own, and removing it would take away the session the user just
   * started — so a tab younger than the question is left alone.
   *
   * A counter rather than a clock. `Date.now()` is accurate to the millisecond
   * and a server on the same machine answers well inside one, so timestamps
   * cannot order a tab against a request that has just returned: both readings
   * come back equal and whichever way the comparison is written is wrong half
   * the time. This is exact by construction.
   */
  openedSeq: number;
}

/**
 * A session as the server describes it.
 *
 * The same shape whether it arrived in the listing or in an announcement that
 * one came into existence somewhere else, so one method can turn either into a
 * tab. `active` and `surface` are optional because the listing has always
 * allowed them to be absent, and absent means "not running" and "a terminal".
 */
export interface ListedSession {
  id: string;
  name: string;
  workingDir: string | null;
  active?: boolean;
  surface?: 'terminal' | 'chat';
  customName?: string | null;
  bypassPermissions?: boolean;
  projectId?: string | null;
  projectName?: string | null;
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

function sameOrder(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/**
 * The browser-local close list written by builds before tab membership belonged
 * to the account.
 *
 * New builds normally read it only during startup migration. It also becomes
 * the temporary authority when a newly loaded client is still talking to a
 * server from before the account-level tab endpoint existed. That compatibility
 * mode ends as soon as a tab write reaches a server that supports the endpoint.
 */
const LEGACY_CLOSED_TABS_KEY = 'cc-web-closed-conversations';

function readLegacyClosedTabs(): Set<string> {
  try {
    const raw = localStorage.getItem(LEGACY_CLOSED_TABS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeLegacyClosedTabs(ids: Set<string>): void {
  try {
    if (ids.size === 0) localStorage.removeItem(LEGACY_CLOSED_TABS_KEY);
    else localStorage.setItem(LEGACY_CLOSED_TABS_KEY, JSON.stringify(Array.from(ids)));
  } catch {
    // A blocked store cannot be migrated. On an old server the close still
    // lasts for this page; it simply cannot survive a reload.
  }
}

type TabVisibilityMutationResult =
  | { kind: 'synced'; open: boolean }
  | { kind: 'unsupported' };

class TabVisibilityMutationError extends Error {
  constructor(message: string, readonly endpointAvailable: boolean) {
    super(message);
    this.name = 'TabVisibilityMutationError';
  }
}

/**
 * Tell an old server's missing route from the new route saying the session is
 * missing. Express' route-level 404 is JSON; its default "Cannot PATCH" 404 is
 * HTML. A generic JSON 404 from an older deployment is treated as unsupported
 * too, while the current server's exact ownership-safe answer remains an error.
 */
async function tabVisibilityEndpointUnsupported(response: Response): Promise<boolean> {
  if (response.status === 405) return true;
  if (response.status !== 404) return false;

  try {
    const body = await response.json() as { error?: unknown };
    return body?.error !== 'Session not found';
  } catch {
    return true;
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
  /** How many tabs this screen has ever opened; see `TabRecord.openedSeq`. */
  private tabsOpened = 0;
  /** Invalidates a session-list photograph when membership changed in flight. */
  private membershipRevision = 0;
  /**
   * One write chain per session.
   *
   * Closing and immediately reopening are two HTTP requests. Without a queue,
   * the faster request can reach the server first and the slower close can win
   * afterwards, leaving every screen in the opposite state to the last click.
   */
  private readonly tabMutations = new Map<string, Promise<TabVisibilityMutationResult>>();
  /** Local closes that the account endpoint has not answered yet. */
  private readonly pendingTabCloses = new Set<string>();
  /** Opens held back until a pending close's server order can be reconciled. */
  private readonly opensDuringPendingClose = new Set<string>();
  /** Serializes rapid drags so their HTTP arrival order matches user intent. */
  private tabOrderMutationTail: Promise<void> = Promise.resolve();
  /** Older own broadcasts cannot rewind the newest optimistic drag. */
  private pendingTabOrderMutations = 0;
  /**
   * Whether this page has discovered a server from before account tab syncing.
   *
   * The flag is deliberately learned from the write itself instead of a version
   * number. During a rolling restart the HTML and server can briefly come from
   * different releases; endpoint behaviour is the capability that matters.
   */
  private usingLegacyTabVisibility = false;

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
          void this.reopenAndSwitch(sessionId).catch((error) => {
            console.error('Failed to open notification target:', error);
          });
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

        // A chat process stays alive between turns so it can accept the next
        // message. The session endpoint therefore reports `active: true` even
        // while the conversation itself is ready, which made a completed chat
        // spin forever in the tab beside a header that correctly said Ready.
        // Once a controller exists, its transcript is the same authority the
        // header uses and must win over the process-liveness fallback.
        const transcript = record.surface === 'chat'
          ? this.app.chats.get?.(id)?.transcript
          : undefined;
        const chatState = transcript?.chatState;
        const hasCompletedReply = chatState === 'idle'
          && Boolean(transcript?.messages.some((message) => message.role === 'assistant'));
        const status: ShellTab['status'] =
          session.hasError || session.status === 'error' || chatState === 'error'
            ? 'error'
            : chatState === 'starting' || chatState === 'thinking' || chatState === 'running'
              ? 'running'
              : hasCompletedReply
                ? 'success'
                : chatState
                  ? 'idle'
                  : session.status === 'active'
                    ? 'running'
                    : 'idle';

        return {
          id,
          title: record.displayName,
          surface: record.surface,
          status,
          // Not yet tracked per session; the server's SessionRecord.agent would
          // have to be plumbed through the list endpoint first.
          kind: '',
          workingDir: session.workingDir,
          unread: session.unreadOutput,
          attention: session.attention ?? null,
          projectId: record.projectId,
          projectName: record.projectName,
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
    const next = this.mergeTabOrder(ids);
    if (sameOrder(next, this.tabOrder)) return;

    // The drag is immediate; persistence follows in its serialized turn. A
    // socket event or reconnect list can then apply the same order without
    // sending it back and creating an echo loop.
    this.membershipRevision++;
    this.setTabOrder(next);
    this.persistTabOrder(next);
  }

  /** Apply the account authority's order without echoing another PATCH. */
  applyRemoteOrder(ids: string[]): void {
    this.membershipRevision++;
    if (this.pendingTabOrderMutations > 0) return;
    this.setTabOrder(this.mergeTabOrder(ids));
  }

  /** Merge an older strip snapshot without losing tabs it did not know yet. */
  private mergeTabOrder(ids: string[]): string[] {
    const known: string[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      if (!this.tabs.has(id) || seen.has(id)) continue;
      seen.add(id);
      known.push(id);
    }
    const missing = this.tabOrder.filter((id) => this.tabs.has(id) && !seen.has(id));
    return [...known, ...missing];
  }

  private setTabOrder(ids: string[]): void {
    this.tabOrder = [...ids];
    this.syncShell();
  }

  private persistTabOrder(sessionIds: string[]): void {
    this.pendingTabOrderMutations++;
    const mutation = this.tabOrderMutationTail
      .catch(() => undefined)
      .then(async () => {
        const response = await this.app.authFetch('/api/sessions/tabs/order', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionIds }),
        });
        if (!response.ok) throw new Error(`Tab order was refused (${response.status})`);
      });

    this.tabOrderMutationTail = mutation;
    void mutation.then(
      () => this.finishTabOrderMutation(),
      (error) => {
        console.error('Failed to save tab order:', error);
        this.finishTabOrderMutation();
      },
    );
  }

  private finishTabOrderMutation(): void {
    this.pendingTabOrderMutations--;
    if (this.pendingTabOrderMutations !== 0) return;
    // The final list settles successful HTTP vs WebSocket delivery as well as
    // failures: an older own broadcast may have arrived while a newer drag was
    // pending, and the socket carrying the newer event may then have dropped.
    void this.reconcile();
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
    await this.loadSessions({ migrateLegacyClosedTabs: true });
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

  /**
   * Read one account-strip snapshot that was not overtaken while in flight.
   *
   * HTTP and WebSocket delivery are independent. A close can arrive over the
   * socket while an older `/list` response is still crossing the network; that
   * response is discarded in full and retried. Yield after a short burst so a
   * deliberately busy account cannot monopolise the browser's microtask queue.
   */
  private async stableSessionList(): Promise<{
    listed: ListedSession[];
    asked: number;
  } | null> {
    let invalidations = 0;
    // Keep the age of the original question across retries. A tab created while
    // any attempt was in flight is younger than this reconciliation as a whole,
    // not suddenly old because the first photograph was invalidated.
    const asked = this.tabsOpened;
    for (;;) {
      const revision = this.membershipRevision;
      try {
        const response = await this.app.authFetch('/api/sessions/list');
        if (!response.ok) return null;
        const data = await response.json();
        if (this.membershipRevision !== revision) {
          invalidations++;
          if (invalidations % 4 === 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
          }
          continue;
        }
        return {
          listed: Array.isArray(data?.sessions) ? (data.sessions as ListedSession[]) : [],
          asked,
        };
      } catch {
        return null;
      }
    }
  }

  async loadSessions(
    { migrateLegacyClosedTabs = false }: { migrateLegacyClosedTabs?: boolean } = {},
  ): Promise<unknown[]> {
    try {
      let snapshot = await this.stableSessionList();
      if (!snapshot) throw new Error('Failed to load sessions');

      // The server owns tab visibility for the account. A conversation closed
      // on any screen is absent here on every screen, including after a reload.
      // If an old browser-local close list exists, transfer it first and then
      // take a new photograph. That second read handles every outcome without
      // guessing: applied closes are absent, ignored stale tombstones remain
      // present, and an old server is filtered by the compatibility set below.
      if (migrateLegacyClosedTabs && readLegacyClosedTabs().size > 0) {
        await this.migrateLegacyClosedTabs();
        snapshot = await this.stableSessionList();
        if (!snapshot) throw new Error('Failed to reload sessions after tab migration');
      }

      const compatibilityClosed = this.usingLegacyTabVisibility
        ? readLegacyClosedTabs()
        : new Set<string>();
      const sessions = snapshot.listed.filter((session) => (
        !this.pendingTabCloses.has(session.id)
        && !(session.surface === 'chat' && compatibilityClosed.has(session.id))
      ));

      sessions.forEach((raw, index: number) => {
        const session = raw as unknown as ListedSession;
        this.adopt(session);
        const sessionData = this.activeSessions.get(session.id);
        if (sessionData) {
          sessionData.lastAccessed = Date.now() - (sessions.length - index) * 1000;
        }
      });
      // The list is already in account order. This is deliberately true on
      // mobile too: screen width may change how the strip scrolls, never where
      // another device says a tab belongs.
      this.setTabOrder(this.mergeTabOrder(sessions.map((session) => session.id)));

      return sessions;
    } catch (error) {
      console.error('Failed to load sessions:', error);
      return [];
    }
  }

  /**
   * Reconcile the strip against what the server actually has.
   *
   * The strip is otherwise built once, at page load, and then only ever changed
   * by something this screen did or was told about. A socket that was away
   * missed both, so a reconnect used to come back to whatever the strip
   * remembered from before the drop — a session started elsewhere still absent,
   * one ended elsewhere still there.
   *
   * The listing is the authority, with one deliberate exception. A tab younger
   * than the question is kept whatever the answer says: it was created after the
   * listing was asked for, so its absence is the age of the answer rather than a
   * fact about the session.
   */
  async reconcile(): Promise<boolean> {
    let snapshot = await this.stableSessionList();
    // Offline, unauthenticated, or the server is coming back up. The strip is
    // left exactly as it is: a failed question is not evidence anything left.
    if (!snapshot) return false;

    // A reconnect is also the first opportunity to finish a close that fell
    // back while the old server was still running. If the restart brought up a
    // supporting server, these writes migrate the temporary browser state and
    // the returned IDs filter the pre-migration list photograph. If it is still
    // the old server, they remain local and are filtered the same way.
    if (this.usingLegacyTabVisibility && readLegacyClosedTabs().size > 0) {
      await this.migrateLegacyClosedTabs();
      // Never apply the pre-migration photograph. On a new server the migration
      // changed durable membership; on an old one a session may still have been
      // created or deleted while the capability probe was in flight.
      snapshot = await this.stableSessionList();
      if (!snapshot) return false;
    }
    const compatibilityClosed = this.usingLegacyTabVisibility
      ? readLegacyClosedTabs()
      : new Set<string>();
    const visible = snapshot.listed.filter((session) => (
      !this.pendingTabCloses.has(session.id)
      && !(session.surface === 'chat' && compatibilityClosed.has(session.id))
    ));

    const live = new Set<string>();

    for (const session of visible) {
      live.add(session.id);
      const known = this.tabs.has(session.id);
      this.adopt(session);
      if (known) {
        // Without the unread mark. A session that went quiet while this socket
        // was away did not go quiet *at this screen*, and a reconnect that lit
        // up half the strip would be reporting the disconnection, not the work.
        this.updateTabStatus(session.id, session.active ? 'active' : 'idle', {
          markUnread: false,
        });
      }
    }

    for (const record of Array.from(this.tabs.values())) {
      if (live.has(record.id) || record.openedSeq > snapshot.asked) continue;
      this.closeSession(record.id, { skipServerRequest: true });
    }

    this.setTabOrder(this.mergeTabOrder(visible.map((session) => session.id)));
    return true;
  }

  /**
   * Put a session the server has described onto the strip.
   *
   * One place, because the three callers — the page load, a reconcile and an
   * announcement from another screen — have to produce the same tab from the
   * same description, and the ordering inside is load-bearing.
   */
  private adopt(session: ListedSession): void {
    const wasChat = this.tabs.get(session.id)?.surface === 'chat';

    // Never switching to it. Every caller here is describing a session rather
    // than acting on one — a page load restores its own tab afterwards, and
    // somebody starting a conversation on their laptop is not asking the phone
    // in their pocket to change what it is showing.
    this.addTab(
      session.id,
      session.name,
      session.active ? 'active' : 'idle',
      session.workingDir,
      false,
      session.customName ?? undefined,
      session.projectId,
      session.projectName,
    );

    if (session.surface !== 'chat') return;

    // Before the subscribe inside setTabSurface, so the pane's very first paint
    // already states the mode this conversation is in rather than claiming
    // "asks first" until a snapshot comes back over the socket. Only as the
    // surface turns: a conversation already on this screen has been following
    // its own events and does not want an older answer written over them.
    if (!wasChat) {
      this.app.chats.ensure(session.id).seedBypass(session.bypassPermissions === true);
    }
    this.setTabSurface(session.id, 'chat');
  }

  /**
   * Take a session that came into existence somewhere else.
   *
   * Quietly: the tab appears beside whatever this screen is already showing and
   * never takes it over. Somebody starting a conversation on their laptop is not
   * asking the phone in their pocket to change what it is displaying.
   *
   * The announcement is also how a conversation reopened on one screen returns
   * to every other one. It folds into an existing tab when this screen already
   * has it and otherwise adopts it without changing this window's active tab.
   */
  applyRemoteOpen(session: ListedSession): void {
    // Even an idempotent announcement makes an older reconcile response stale:
    // it says the server has processed an explicit open after that list began.
    this.membershipRevision++;
    // The close this window just asked for outranks an older open announcement
    // or an old-server runtime announcement while the capability probe is in
    // flight. A refusal removes this guard and reconciles; an explicit reopen
    // removes it before queuing its newer intent.
    if (this.pendingTabCloses.has(session.id)) {
      this.opensDuringPendingClose.add(session.id);
      return;
    }
    if (this.usingLegacyTabVisibility && readLegacyClosedTabs().has(session.id)) return;
    this.adopt(session);
  }

  /** Apply an account-wide close without sending the same mutation back. */
  applyRemoteClose(sessionId: string): void {
    // Bumped even when this screen has no such tab. A stale list already in
    // flight may still contain it, and must not put it back after this event.
    this.membershipRevision++;
    this.closeSession(sessionId, { skipServerRequest: true });
  }

  /**
   * Take the working / idle state of a session from the server.
   *
   * Ignored on the screen attached to the session, which has the output itself
   * and is already running this exact rule off it. Everywhere else this is the
   * only sign of life there is: output goes to whoever is driving, so without it
   * a session that has been building for a minute reads as idle on every other
   * screen — and stays that way until somebody reloads.
   */
  applyRemoteActivity(sessionId: string, active: boolean): void {
    if (!this.tabs.has(sessionId)) return;
    if (sessionId === this.app.currentClaudeSessionId) return;

    if (active) this.markSessionActivity(sessionId, true);
    else this.updateTabStatus(sessionId, 'idle');
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
    projectId?: string | null,
    projectName?: string | null,
  ): void {
    const existing = this.tabs.get(sessionId);
    if (existing) {
      // Announcements race the create response and the initial session list.
      // A later payload may be the first one carrying project identity, so an
      // existing tab must absorb metadata instead of freezing its first shape.
      let changed = false;
      if (projectId !== undefined && existing.projectId !== projectId) {
        existing.projectId = projectId;
        changed = true;
      }
      if (projectName !== undefined && existing.projectName !== projectName) {
        existing.projectName = projectName;
        changed = true;
      }
      if (changed) this.syncShell();
      return;
    }
    this.membershipRevision++;

    const isDefaultSessionName = sessionName.startsWith('Session ') && sessionName.includes(':');
    const folderName = workingDir ? workingDir.split('/').pop() || '/' : null;
    const generated = !isDefaultSessionName ? sessionName : (folderName || sessionName);
    // A chosen name wins outright: it is the one thing about a tab the user said
    // out loud, so it is not run through the generated-name rules.
    const displayName = customName || generated;

    this.tabs.set(sessionId, {
      id: sessionId,
      displayName,
      customName,
      surface: 'terminal',
      projectId,
      projectName,
      openedSeq: ++this.tabsOpened,
    });
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

  /**
   * Put a stored conversation back on the account's tab strip.
   *
   * The server answers by broadcasting the ordinary `session_opened` message,
   * so every screen adopts the same tab. This method deliberately does not
   * select it: which tab is active remains a property of each window, and the
   * caller that initiated the reopen switches only its own window afterwards.
   */
  async reopenSession(sessionId: string): Promise<boolean> {
    const alreadyOnThisScreen = this.tabs.has(sessionId);
    // An explicit reopen is newer than this window's own pending/local close.
    this.pendingTabCloses.delete(sessionId);
    this.opensDuringPendingClose.delete(sessionId);
    this.membershipRevision++;
    const intentRevision = this.membershipRevision;
    const result = await this.mutateTabVisibility(sessionId, true);

    // A reopen is explicit user intent in both versions. Clear an old local
    // tombstone after either a real account write or the compatibility no-op so
    // it cannot hide the tab again on this page or the next one.
    const legacyClosed = readLegacyClosedTabs();
    if (legacyClosed.delete(sessionId)) writeLegacyClosedTabs(legacyClosed);
    if (legacyClosed.size === 0) this.usingLegacyTabVisibility = false;

    if (result.kind === 'unsupported') return true;
    if (!result.open) return false;

    // Every supported open is followed by the sorted account snapshot. This
    // covers both kinds of stale client: one that retained the tab at an old
    // position, and a disconnected one that missed an earlier open/order and
    // has no local copy even though the server says this open is idempotent.
    // `reconcile` never changes this window's selected tab.
    const reconciled = await this.reconcile();

    if (reconciled) return this.tabs.has(sessionId);

    // A WebSocket membership event that landed around the HTTP answer is newer
    // than the intent's starting point. In that case the reconciled membership,
    // not the older successful response, decides whether a caller may draw it.
    if (this.membershipRevision !== intentRevision) return this.tabs.has(sessionId);
    // If the list itself was unavailable immediately after the successful
    // write, let the caller use the success; the next reconnect fixes order.
    return alreadyOnThisScreen || result.open;
  }

  /** Reopen a missing notification target, then select it in this window only. */
  async reopenAndSwitch(sessionId: string): Promise<void> {
    // A terminal tab has no non-destructive reopen endpoint. Conversation
    // targets always restate account state, including a stale local tab from a
    // close announcement this window missed while disconnected.
    const known = this.tabs.get(sessionId);
    if (known?.surface !== 'terminal') {
      const open = await this.reopenSession(sessionId);
      if (!open) return;
    }
    // The server broadcasts `session_opened`, but a disconnected socket cannot
    // hear it. Reconcile deterministically obtains and adopts the same record.
    if (!this.tabs.has(sessionId)) await this.reconcile();
    await this.switchToTab(sessionId);
  }

  closeSession(sessionId: string, { skipServerRequest = false } = {}): void {
    const record = this.tabs.get(sessionId);
    if (!record) return;
    this.membershipRevision++;

    // A fallback switch is asynchronous: closing A can start joining B, then a
    // close for B can arrive before its `session_joined` answer. Settle and
    // forget that request now so the vanished tab cannot remain the app's
    // pending destination (and so the switch promise does not hang until its
    // timeout). A late answer is rejected by MessageHandler as an orphan.
    if (this.app.pendingJoinSessionId === sessionId) {
      const resolve = this.app.pendingJoinResolve;
      this.app.pendingJoinResolve = null;
      this.app.pendingJoinSessionId = null;
      resolve?.();
    }

    /**
     * Closing a conversation takes it off the account's tab strip, and no more.
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

    if (!skipServerRequest) {
      if (detachOnly) {
        this.pendingTabCloses.add(sessionId);
        void this.mutateTabVisibility(sessionId, false)
          .then((result) => {
            const legacyClosed = readLegacyClosedTabs();
            if (result.kind === 'unsupported') legacyClosed.add(sessionId);
            else legacyClosed.delete(sessionId);
            writeLegacyClosedTabs(legacyClosed);
            if (legacyClosed.size === 0) this.usingLegacyTabVisibility = false;
            this.pendingTabCloses.delete(sessionId);
            if (this.opensDuringPendingClose.delete(sessionId)) {
              // HTTP and WebSocket are separate ordered streams. The ignored
              // open may have been either side of this close on the server;
              // the durable list is the only unambiguous final answer.
              void this.reconcile();
            }
          })
          .catch((err) => {
            this.pendingTabCloses.delete(sessionId);
            this.opensDuringPendingClose.delete(sessionId);
            console.error('Failed to close conversation tab:', err);
            // Optimism was wrong: ask the authority and put the tab back if the
            // server supports syncing but refused this write. A missing route is
            // handled above as the old browser-local behaviour instead.
            void this.reconcile();
          });
      } else {
        void this.app.authFetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
          .then(async (response) => {
            if (response.ok) return;
            console.error(`Failed to delete session: server returned ${response.status}`);
            const reconciled = await this.reconcile();
            // A refused deletion means the terminal still exists. If closing it
            // left this window blank, put that restored tab back in front; this
            // is local focus recovery, not account-wide selection sync.
            if (reconciled && !this.activeTabId && this.tabs.has(sessionId)) {
              await this.switchToTab(sessionId);
            }
          })
          .catch(async (error) => {
            console.error('Failed to delete session:', error);
            await this.reconcile();
          });
      }
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

  /** Queue one account-level tab mutation behind earlier writes for this id. */
  private mutateTabVisibility(
    sessionId: string,
    open: boolean,
    { legacy = false }: { legacy?: boolean } = {},
  ): Promise<TabVisibilityMutationResult> {
    const previous = this.tabMutations.get(sessionId);
    const mutation = (previous ? previous.catch(() => undefined) : Promise.resolve())
      // A failed earlier intent must not prevent a newer one from being tried.
      .then(async (): Promise<TabVisibilityMutationResult> => {
        const response = await this.app.authFetch(`/api/sessions/${encodeURIComponent(sessionId)}/tab`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(legacy ? { open, legacy: true } : { open }),
        });
        if (!response.ok) {
          if (await tabVisibilityEndpointUnsupported(response)) {
            this.usingLegacyTabVisibility = true;
            return { kind: 'unsupported' };
          }
          throw new TabVisibilityMutationError(
            open
              ? 'That conversation could not be reopened'
              : 'The server refused to close that conversation tab',
            response.status >= 400 && response.status < 500,
          );
        }
        let body: { open?: unknown } = {};
        try {
          body = await response.json() as { open?: unknown };
        } catch {
          // The first supporting builds did not need a response field. Their
          // successful write still means the requested state won.
        }
        return {
          kind: 'synced',
          open: typeof body.open === 'boolean' ? body.open : open,
        };
      });

    this.tabMutations.set(sessionId, mutation);
    void mutation.then(
      () => {
        if (this.tabMutations.get(sessionId) === mutation) this.tabMutations.delete(sessionId);
      },
      () => {
        if (this.tabMutations.get(sessionId) === mutation) this.tabMutations.delete(sessionId);
      },
    );
    return mutation;
  }

  /**
   * Move the old browser-local close list to the account before first paint.
   *
   * Only IDs the endpoint recognizes for this account are removed. The old key
   * was shared by every account using the same browser profile, so a missing ID
   * might still belong to another account. A supporting server leaves those
   * unknown values harmlessly in place for that account to claim later.
   *
   * An ordinary failed write likewise stays in the legacy key for one retry on
   * the next page load, but does not hide the server-open tab on this one. The
   * one exception is a missing endpoint: while that old server is running, the
   * key deliberately retains the pre-sync browser-local behaviour.
   */
  private async migrateLegacyClosedTabs(): Promise<Set<string>> {
    const remaining = readLegacyClosedTabs();
    if (remaining.size === 0) {
      // Also clears malformed/non-array legacy values, whose parsed set is empty.
      writeLegacyClosedTabs(remaining);
      return new Set();
    }

    const migrated = new Set<string>();
    const wasUsingLegacy = this.usingLegacyTabVisibility;
    let attempted = false;
    let sawUnsupported = false;
    let sawFailure = false;
    let sawSupportedResponse = false;

    const migrateOne = async (sessionId: string): Promise<void> => {
      attempted = true;
      this.membershipRevision++;
      try {
        const result = await this.mutateTabVisibility(sessionId, false, { legacy: true });
        // An old server cannot absorb the tombstone yet. Keep it for the local
        // fallback and retry it after the server restarts; a supporting server
        // owns the state now, so the browser copy can be retired. The response's
        // final state matters: a stale tombstone ignored after an explicit
        // account reopen must not hide the conversation in this first list.
        if (result.kind === 'synced') {
          sawSupportedResponse = true;
          remaining.delete(sessionId);
          if (!result.open) migrated.add(sessionId);
        } else {
          sawUnsupported = true;
          migrated.add(sessionId);
        }
      } catch (error) {
        sawFailure = true;
        if (error instanceof TabVisibilityMutationError && error.endpointAvailable) {
          sawSupportedResponse = true;
        }
        // A legacy key was shared by every account on the origin. Missing,
        // foreign and no-longer-chat IDs are expected leftovers, not failures
        // worth logging on every page load; they stay for the account they may
        // belong to. Network and server failures still deserve a diagnostic.
        if (!(error instanceof TabVisibilityMutationError && error.endpointAvailable)) {
          console.warn(`Could not migrate closed tab ${sessionId}:`, error);
        }
      }
    };

    // The old key is user-editable origin storage and can be arbitrarily large.
    // Each accepted ID persists the session map, so do not turn a corrupted key
    // into hundreds of simultaneous full-database writes at startup.
    const ids = Array.from(remaining);
    for (let index = 0; index < ids.length; index += 4) {
      await Promise.all(ids.slice(index, index + 4).map(migrateOne));
    }

    writeLegacyClosedTabs(remaining);
    if (attempted) {
      // A startup migration that gets an ordinary 5xx still leaves the server
      // authoritative, as before. Once this page has positively identified an
      // old server, however, a transient failure during its post-restart retry
      // must not make locally closed tabs spring back onto the strip.
      this.usingLegacyTabVisibility = sawUnsupported
        || (sawFailure && wasUsingLegacy && !sawSupportedResponse);
    }
    return migrated;
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
  async initialTabId(): Promise<string | null> {
    // A window opened by acting on a notification, when there was no window to
    // bring forward. It outranks the remembered tab: the user asked for this
    // conversation a second ago, and the remembered one is where they happened
    // to be last time. Read once — see `takeRequestedConversation` — so a
    // reload does not drag them back here.
    const requested = takeRequestedConversation();
    if (requested && !this.tabs.has(requested)) {
      try {
        const reopened = await this.reopenSession(requested);
        // A cold-started page has not established its websocket yet, so it
        // cannot rely on the `session_opened` broadcast to supply the tab.
        // Read the now-open account strip before deciding where to land.
        if (reopened && !this.tabs.has(requested)) await this.reconcile();
      } catch (error) {
        console.error('Failed to reopen requested conversation:', error);
        showNotification('That conversation could not be opened');
      }
    }
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

  updateTabStatus(
    sessionId: string,
    status: SessionInfo['status'],
    { markUnread = true } = {},
  ): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    const wasActive = session.status === 'active';

    session.status = status;
    session.lastActivity = Date.now();
    if (status !== 'error') session.hasError = false;

    // A session that was working and has gone quiet in the background is the
    // one signal worth carrying on the tab, so the dot survives the transition.
    // `markUnread: false` is for catching up rather than watching — see
    // `reconcile`, where the transition being noticed is this screen's, not the
    // session's.
    if (markUnread && wasActive && status === 'idle' && sessionId !== this.activeTabId) {
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
