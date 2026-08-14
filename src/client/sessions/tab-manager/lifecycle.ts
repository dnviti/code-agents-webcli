import {
  parseQualifiedSessionId,
  selectControllerServer,
  getControllerSnapshot,
} from '../../controller/transport';
import { forgetStoredActiveTab, recallActiveTab } from './helpers';
import { noteConversationOpened, noteConversationClosed } from '../../chat/attention';
import { releaseTerminals } from '../../chat/chat-terminal';
import { clearChatSurface } from '../../chat/surface';
import { shellStore } from '../../shell/store';
import { takeRequestedConversation } from '../../ui/notify';
import { showNotification } from '../../ui/notifications';
import type { ListedSession } from './types';
import { TabManagerSessionSync } from './session-sync';

/**
 * Third partial: session lifecycle, reconcile, close/open, tab navigation,
 * and keyboard shortcuts. Implements the abstract forward declarations made by
 * TabManagerSessionSync.
 */
export abstract class TabManagerLifecycle extends TabManagerSessionSync {
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
  // Tab switching (implements abstract declarations)
  // ---------------------------------------------------------------------------

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
    const owner = parseQualifiedSessionId(sessionId)?.serverId;
    if (owner) selectControllerServer(owner);
    forgetStoredActiveTab();

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

  setTabSurface(sessionId: string, surface: 'terminal' | 'chat'): void {
    const record = this.tabs.get(sessionId);
    if (!record || record.surface === surface) return;

    record.surface = surface;
    if (surface === 'chat') {
      this.app.chats.subscribe(sessionId);
    }
    this.syncShell();
  }

  /** Keep maintenance status attached to the tab whose runtime owns it. */
  setTabRuntime(sessionId: string, kind: string): void {
    const record = this.tabs.get(sessionId);
    if (!record || record.kind === kind) return;
    record.kind = kind;
    this.syncShell();
  }

  // ---------------------------------------------------------------------------
  // Reconcile
  // ---------------------------------------------------------------------------

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
    if (this.usingLegacyTabVisibility && this.readLegacyClosedTabs().size > 0) {
      await this.migrateLegacyClosedTabs();
      // Never apply the pre-migration photograph. On a new server the migration
      // changed durable membership; on an old one a session may still have been
      // created or deleted while the capability probe was in flight.
      snapshot = await this.stableSessionList();
      if (!snapshot) return false;
    }
    const compatibilityClosed = this.usingLegacyTabVisibility
      ? this.readLegacyClosedTabs()
      : new Set<string>();
    const visible = snapshot.listed.filter((session) => (
      session.offline !== true
      &&
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
      const owner = parseQualifiedSessionId(record.id)?.serverId;
      const target = owner
        ? getControllerSnapshot().targets.find((item) => item.id === owner) : undefined;
      if (target && target.connection !== 'connected') continue;
      this.closeSession(record.id, { skipServerRequest: true });
    }

    this.setTabOrder(this.mergeTabOrder(visible.map((session) => session.id)));
    return true;
  }

  // ---------------------------------------------------------------------------
  // Close / open
  // ---------------------------------------------------------------------------

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
    if (this.usingLegacyTabVisibility && this.readLegacyClosedTabs().has(session.id)) return;
    this.adopt(session);
  }

  /** Apply an account-wide close without sending the same mutation back. */
  applyRemoteClose(sessionId: string): void {
    // Bumped even when this screen has no such tab. A stale list already in
    // flight may still contain it, and must not put it back after this event.
    this.membershipRevision++;
    this.closeSession(sessionId, { skipServerRequest: true });
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
            const legacyClosed = this.readLegacyClosedTabs();
            if (result.kind === 'unsupported') legacyClosed.add(sessionId);
            else legacyClosed.delete(sessionId);
            this.writeLegacyClosedTabs(legacyClosed);
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
    const legacyClosed = this.readLegacyClosedTabs();
    if (legacyClosed.delete(sessionId)) this.writeLegacyClosedTabs(legacyClosed);
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

  closeOthers(sessionId: string): void {
    this.getOrderedTabIds().forEach((id) => {
      if (id !== sessionId) this.closeSession(id);
    });
  }

  /** Drop only local visibility for a server whose auth or catalog entry went away. */
  retireServer(serverId: string): void {
    for (const sessionId of Array.from(this.tabs.keys())) {
      if (parseQualifiedSessionId(sessionId)?.serverId !== serverId) continue;
      this.closeSession(sessionId, { skipServerRequest: true });
    }
    if (parseQualifiedSessionId(this.app.currentClaudeSessionId || '')?.serverId === serverId) {
      this.app.currentClaudeSessionId = null;
      this.app.currentClaudeSessionName = null;
      this.app.terminal?.reset();
      shellStore.setState({
        connection: { state: 'disconnected', workingDir: null },
      });
    }
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

    if (this.activeTabId && this.tabs.has(this.activeTabId)) return this.activeTabId;
    const remembered = recallActiveTab();
    if (remembered && this.tabs.has(remembered)) return remembered;
    return this.getOrderedTabIds()[0] ?? this.tabs.keys().next().value ?? null;
  }
}