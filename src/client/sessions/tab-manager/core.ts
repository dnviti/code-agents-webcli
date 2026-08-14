import type { App } from '../../app';
import type { SessionInfo } from '../../types';
import type { ConversationAttention } from '../../../shared/chat-alerts';
import { shellStore, type ShellTab } from '../../shell/store';
import { showNotification, playNotificationSound } from '../../ui/notifications';
import {
  getControllerSnapshot,
  parseQualifiedSessionId,
} from '../../controller/transport';
import { LEGACY_CLOSED_TABS_KEY, takeLegacyClosedTabs } from './helpers';
import type { TabRecord, TabVisibilityMutationResult } from './types';

/**
 * Base partial: fields, constructor, and fundamental getters/setters that have
 * no dependencies on higher-level session lifecycle or ordering logic.
 */
export abstract class TabManagerCore {
  app: App;
  tabs: Map<string, TabRecord>;
  activeSessions: Map<string, SessionInfo>;
  activeTabId: string | null;
  tabOrder: string[];
  tabHistory: string[];
  /** How many tabs this screen has ever opened; see `TabRecord.openedSeq`. */
  protected tabsOpened = 0;
  /** Invalidates a session-list photograph when membership changed in flight. */
  protected membershipRevision = 0;
  /**
   * One write chain per session.
   *
   * Closing and immediately reopening are two HTTP requests. Without a queue,
   * the faster request can reach the server first and the slower close can win
   * afterwards, leaving every screen in the opposite state to the last click.
   */
  protected readonly tabMutations = new Map<string, Promise<TabVisibilityMutationResult>>();
  /** Local closes that the account endpoint has not answered yet. */
  protected readonly pendingTabCloses = new Set<string>();
  /** Opens held back until a pending close's server order can be reconciled. */
  protected readonly opensDuringPendingClose = new Set<string>();
  /** Serializes rapid drags so their HTTP arrival order matches user intent. */
  protected tabOrderMutationTail: Promise<void> = Promise.resolve();
  /** Older own broadcasts cannot rewind the newest optimistic drag. */
  protected pendingTabOrderMutations = 0;
  /**
   * Whether this page has discovered a server from before account tab syncing.
   *
   * The flag is deliberately learned from the write itself instead of a version
   * number. During a rolling restart the HTML and server can briefly come from
   * different releases; endpoint behaviour is the capability that matters.
   */
  protected usingLegacyTabVisibility = false;
  /** Compatibility state for an old server, kept only for this live page. */
  protected legacyClosedTabs: Set<string>;

  constructor(app: App) {
    this.app = app;
    this.tabs = new Map();
    this.activeSessions = new Map();
    this.activeTabId = null;
    this.tabOrder = [];
    this.tabHistory = [];
    this.legacyClosedTabs = takeLegacyClosedTabs();
  }

  protected readLegacyClosedTabs(): Set<string> {
    return new Set(this.legacyClosedTabs);
  }

  protected writeLegacyClosedTabs(ids: Set<string>): void {
    this.legacyClosedTabs = new Set(ids);
    // Never recreate the old profile-local list, even in rollout fallback.
    try { localStorage.removeItem(LEGACY_CLOSED_TABS_KEY); } catch { /* blocked */ }
  }

  getAlias(kind: string): string {
    return this.app.getAlias(kind as never);
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
    const controller = getControllerSnapshot();
    const tabs: ShellTab[] = this.getOrderedTabIds()
      .map((id): ShellTab | null => {
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

        const owner = parseQualifiedSessionId(id)?.serverId;
        const target = owner ? controller.targets.find((item) => item.id === owner) : undefined;
        return {
          id,
          title: record.displayName,
          surface: record.surface,
          status,
          kind: record.kind,
          workingDir: session.workingDir,
          projectWorkingDirKind: session.projectWorkingDirKind,
          unread: session.unreadOutput,
          attention: session.attention ?? null,
          projectId: record.projectId,
          projectName: record.projectName,
          ...(target ? {
            serverId: target.id,
            serverName: target.name,
            serverInsecure: target.insecure === true,
          } : {}),
        };
      })
      .filter((tab): tab is ShellTab => tab !== null);

    shellStore.setState({ tabs, activeId: this.activeTabId });
  }

  getOrderedTabIds(): string[] {
    this.tabOrder = this.tabOrder.filter((id) => this.tabs.has(id));
    return [...this.tabOrder];
  }

  /** Merge an older strip snapshot without losing tabs it did not know yet. */
  protected mergeTabOrder(ids: string[]): string[] {
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

  protected setTabOrder(ids: string[]): void {
    this.tabOrder = [...ids];
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

  reorderTabsByLastAccessed(): void {
    this.tabOrder = this.getOrderedTabIds().sort((a, b) => {
      const sa = this.activeSessions.get(a);
      const sb = this.activeSessions.get(b);
      return (sb?.lastAccessed ?? 0) - (sa?.lastAccessed ?? 0);
    });
    this.syncShell();
  }

  // ---------------------------------------------------------------------------
  // Surface and runtime
  // ---------------------------------------------------------------------------

  /** Re-establish every chat subscription, e.g. after the socket reconnected. */
  resubscribeChats(): void {
    for (const record of this.tabs.values()) {
      if (record.surface === 'chat') {
        this.app.chats.subscribe(record.id);
      }
    }
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
      connection: {
        ...connection,
        workingDir: session.workingDir,
        projectId: this.tabs.get(sessionId)?.projectId,
        projectWorkingDirKind: session.projectWorkingDirKind,
      },
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
    const label = record?.displayName || this.activeSessions.get(sessionId)?.name || 'Conversation';
    const owner = parseQualifiedSessionId(sessionId)?.serverId;
    const serverName = owner
      ? getControllerSnapshot().targets.find((target) => target.id === owner)?.name
      : undefined;
    return serverName ? `${label} · ${serverName}` : label;
  }

  // ---------------------------------------------------------------------------
  // Rename
  // ---------------------------------------------------------------------------

  /** Write a label into the tab, the session and the strip. */
  protected applyName(
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

  // ---------------------------------------------------------------------------
  // Session detachment
  // ---------------------------------------------------------------------------

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
  protected detachFrom(sessionId: string): void {
    if (this.app.currentClaudeSessionId !== sessionId) return;
    this.app.currentClaudeSessionId = null;
    this.app.currentClaudeSessionName = null;
    this.app.leaveSession();
  }

  // ---------------------------------------------------------------------------
  // New session
  // ---------------------------------------------------------------------------

  createNewSession(): void {
    this.app.isCreatingNewSession = true;
    shellStore.patchSlice('dialogs', { workspaceChooser: true });
  }

  // ---------------------------------------------------------------------------
  // Notifications
  // ---------------------------------------------------------------------------

  /**
   * Fallback for a device that refuses system notifications.
   *
   * It used to build its own fixed-position div with an inline stylesheet and
   * its own keyframes. It is the app's toast now — one primitive, one place
   * where the styling and the screen-reader announcement are decided.
   */
  protected showInPageNotification(title: string, body: string): void {
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

    showNotification([title, body].filter(Boolean).join(' — '));
    playNotificationSound();
  }
}