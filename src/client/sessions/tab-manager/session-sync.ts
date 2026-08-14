import type { App } from '../../app';
import type { SessionInfo } from '../../types';
import {
  getControllerSnapshot,
  parseQualifiedSessionId,
} from '../../controller/transport';
import { showNotification } from '../../ui/notifications';
import { sameOrder } from './helpers';
import type { TabRecord, ListedSession, TabVisibilityMutationResult } from './types';
import { TabVisibilityMutationError, tabVisibilityEndpointUnsupported } from './types';
import { TabManagerCore } from './core';

/**
 * Second partial: session loading, tab mutation, ordering persistence, and
 * tab CRUD that depends on abstract lifecycle methods (reconcile, switchToTab,
 * setTabSurface, setTabRuntime).
 */
export abstract class TabManagerSessionSync extends TabManagerCore {
  // ---------------------------------------------------------------------------
  // Tab ordering persistence
  // ---------------------------------------------------------------------------

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
    const controller = getControllerSnapshot();
    const owner = controller.enabled ? parseQualifiedSessionId(ids[0] || '')?.serverId : null;
    if (!owner || ids.some((id) => parseQualifiedSessionId(id)?.serverId !== owner)) {
      this.setTabOrder(this.mergeTabOrder(ids));
      return;
    }
    const ordered = ids.filter((id, index) => this.tabs.has(id) && ids.indexOf(id) === index);
    const remaining = [...ordered];
    const next = this.tabOrder.map((id) => (
      parseQualifiedSessionId(id)?.serverId === owner ? remaining.shift() || id : id
    ));
    for (const id of remaining) if (!next.includes(id)) next.push(id);
    this.setTabOrder(next);
  }

  private persistTabOrder(sessionIds: string[]): void {
    this.pendingTabOrderMutations++;
    const mutation = this.tabOrderMutationTail
      .catch(() => undefined)
      .then(async () => {
        const controller = getControllerSnapshot();
        const groups = new Map<string | null, string[]>();
        for (const sessionId of sessionIds) {
          const owner = controller.enabled ? parseQualifiedSessionId(sessionId)?.serverId || null : null;
          const values = groups.get(owner) || [];
          values.push(sessionId);
          groups.set(owner, values);
        }
        const responses = await Promise.all([...groups].map(([serverId, ids]) =>
          this.app.authFetch('/api/sessions/tabs/order', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionIds: ids }),
          }, serverId)));
        const refused = responses.find((response) => !response.ok);
        if (refused) throw new Error(`Tab order was refused (${refused.status})`);
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
  protected async stableSessionList(): Promise<{
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
      if (migrateLegacyClosedTabs && this.readLegacyClosedTabs().size > 0) {
        await this.migrateLegacyClosedTabs();
        snapshot = await this.stableSessionList();
        if (!snapshot) throw new Error('Failed to reload sessions after tab migration');
      }

      const compatibilityClosed = this.usingLegacyTabVisibility
        ? this.readLegacyClosedTabs()
        : new Set<string>();
      const sessions = snapshot.listed.filter((session) => (
        session.offline !== true
        &&
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
   * Put a session the server has described onto the strip.
   *
   * One place, because the three callers — the page load, a reconcile and an
   * announcement from another screen — have to produce the same tab from the
   * same description, and the ordering inside is load-bearing.
   */
  protected adopt(session: ListedSession): void {
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
      session.projectWorkingDirKind,
    );
    this.setTabRuntime(session.id, session.agent || session.lastAgent || '');

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

  addTab(
    sessionId: string,
    sessionName: string,
    status: SessionInfo['status'] = 'idle',
    workingDir: string | null = null,
    autoSwitch = true,
    customName?: string,
    projectId?: string | null,
    projectName?: string | null,
    projectWorkingDirKind?: 'host' | 'container',
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
      if (
        projectWorkingDirKind !== undefined
        && existing.projectWorkingDirKind !== projectWorkingDirKind
      ) {
        existing.projectWorkingDirKind = projectWorkingDirKind;
        changed = true;
      }
      const active = this.activeSessions.get(sessionId);
      if (active && workingDir !== null && active.workingDir !== workingDir) {
        active.workingDir = workingDir;
        changed = true;
      }
      if (
        active
        && projectWorkingDirKind !== undefined
        && active.projectWorkingDirKind !== projectWorkingDirKind
      ) {
        active.projectWorkingDirKind = projectWorkingDirKind;
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
      kind: '',
      projectId,
      projectName,
      projectWorkingDirKind,
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
      projectWorkingDirKind,
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
    void this.app.authFetch(`/api/sessions/${sessionId}/name`, {
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

  // ---------------------------------------------------------------------------
  // Tab visibility mutations
  // ---------------------------------------------------------------------------

  /** Queue one account-level tab mutation behind earlier writes for this id. */
  protected mutateTabVisibility(
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
  protected async migrateLegacyClosedTabs(): Promise<Set<string>> {
    const remaining = this.readLegacyClosedTabs();
    if (remaining.size === 0) {
      // Also clears malformed/non-array legacy values, whose parsed set is empty.
      this.writeLegacyClosedTabs(remaining);
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

    this.writeLegacyClosedTabs(remaining);
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

  // Abstract forward declarations for lifecycle methods implemented in the
  // next partial.
  protected abstract reconcile(): Promise<boolean>;
  protected abstract switchToTab(sessionId: string, options?: { skipHistoryUpdate?: boolean }): Promise<void>;
  protected abstract setTabSurface(sessionId: string, surface: 'terminal' | 'chat'): void;
  protected abstract setTabRuntime(sessionId: string, kind: string): void;
}