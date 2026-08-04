import { Router, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import WebSocket from 'ws';
import {
  SessionRecord,
  SessionListItem,
  AgentKind,
  BridgeInterface,
  PathValidation,
  WebSocketInfo,
  AuthContext,
  AuthenticatedUser,
} from '../types.js';
import { TranscriptStoreLike } from '../services/transcript-store.js';
import { HistoryStoreLike } from '../services/history-store.js';
import { SessionTeardownLike } from '../services/session-teardown.js';
import {
  AccountTabCoordinator,
  AccountTabCoordinatorLike,
} from '../services/account-tab-coordinator.js';
import { stripAnsi } from '../services/ansi.js';
import { ChatEvent } from '../../shared/chat-events.js';
import {
  ConversationProject,
  ConversationSummary,
  projectName,
} from '../../shared/conversations.js';
import { planBranch, tooLargeMessage } from '../chat/branch.js';
import { TurnCut } from '../chat/store.js';
import { getOwnedSession, requireUser } from './helpers.js';
import {
  announceSessionClosed,
  announceSessionOpened,
  announceSessionTabClosed,
  announceSessionTabsReordered,
} from '../websocket/handler.js';
import {
  canonicalProjectContainerWorkingDir,
  canonicalProjectWorkingDir,
  classifyProjectContainerPath,
  projectWorkingDirOrDefault,
  restoreProjectWorkingDir,
  releaseProjectSessionLease,
  type ProjectSessionEnvironmentResult,
  type ProjectSessionLease,
  type ProjectsSessionApi,
} from '../services/projects/working-dir.js';

/**
 * How many past conversations one folder offers.
 *
 * A list to choose from, not an archive to browse: past this many the useful
 * one is not findable by scrolling anyway, and every entry costs a read.
 */
const MAX_RESUMABLE = 25;

/**
 * How many conversations one full listing describes.
 *
 * Far above the "hundreds across a dozen projects" this is built for, and it is
 * a backstop rather than a design: every described conversation costs a bounded
 * read of its log, and an account with ten thousand of them must not be able to
 * turn opening a list into a minute of disk. What is dropped is always the least
 * recently active, and the answer says it was dropped.
 */
const MAX_LISTED_CONVERSATIONS = 400;

/**
 * How many logs are read at once while describing a list.
 *
 * Unbounded `Promise.all` over four hundred conversations opens four hundred
 * logs, four hundred indexes and four hundred stats at the same instant, which
 * on a default 1024-descriptor limit is how a listing turns into EMFILE — and
 * EMFILE does not fail only this request, it fails whatever else the server was
 * doing. Sixteen at a time keeps the whole listing well inside a hundred
 * milliseconds without ever holding more than a few dozen handles.
 */
const DESCRIBE_CONCURRENCY = 16;

/** Long enough for any label worth reading on a tab, short enough to store freely. */
const MAX_NAME_LENGTH = 200;

/**
 * Process-local coordination for the one race persistence cannot express:
 * creating a hidden child while its owning conversation is being retired.
 *
 * `retireProjectSessions()` is called with a freshly assembled deps object, so
 * the shared sessions map is the stable identity that lets it join the same
 * gate as the HTTP router.
 */
interface SessionRouteCoordination {
  pendingOwnedCreates: Map<string, Set<Promise<void>>>;
  retiringTrees: WeakMap<SessionRecord, Promise<boolean>>;
  destroyedSessions: WeakMap<SessionRecord, Promise<void>>;
}

const sessionRouteCoordinations = new WeakMap<
  Map<string, SessionRecord>,
  SessionRouteCoordination
>();

function coordinationFor(deps: SessionRoutesDeps): SessionRouteCoordination {
  let coordination = sessionRouteCoordinations.get(deps.claudeSessions);
  if (!coordination) {
    coordination = {
      pendingOwnedCreates: new Map(),
      retiringTrees: new WeakMap(),
      destroyedSessions: new WeakMap(),
    };
    sessionRouteCoordinations.set(deps.claudeSessions, coordination);
  }
  return coordination;
}

export interface SessionRoutesDeps {
  claudeSessions: Map<string, SessionRecord>;
  webSocketConnections: Map<string, WebSocketInfo>;
  baseFolder: string;
  dev: boolean;
  validatePath(targetPath: string, userId?: number): PathValidation;
  /** Optional: without it the single shared base folder is used, as before. */
  getUserBaseFolder?(userId?: number): string;
  createSessionRecord(params: {
    id: string;
    ownerUserId: number;
    name?: string;
    workingDir: string;
    connections?: string[];
    ownerSessionId?: string;
    projectId?: string | null;
    projectWorkingDirKind?: 'host' | 'container';
  }): SessionRecord;
  getRuntimeBridge(agentKind: AgentKind): BridgeInterface | null;
  /**
   * Stop whichever process owns this record. The real composition root routes
   * chats through ChatSessionManager and terminals through their bridge.
   */
  stopSessionRuntime?(session: SessionRecord): Promise<void>;
  /** `false` means the SQLite write was attempted but did not commit. */
  saveSessionsToDisk(): Promise<boolean | void>;
  transcriptStore: TranscriptStoreLike;
  historyStore: HistoryStoreLike;
  /** Lines still on screen, not yet scrolled into history. */
  getScreenSnapshot(sessionId: string): string[];
  /** Tear down the scrollback emulator held for a session. */
  disposeRecorder(sessionId: string): void;
  getSelectedWorkingDir(userId: number): string | null;
  /**
   * The active profile for a runtime, read without writing its tier files.
   *
   * Only the branch needs it, and only as the last resort behind the source's
   * own recorded model — see there. Deliberately not paired with a reader for
   * the account's standing choice: the source's record already says which model
   * it ran, whichever layer decided it, and asking the layers again would answer
   * a different question than "what was this history measured against".
   *
   * Optional so the hand-built deps literals in the existing tests keep
   * compiling; a server without one simply pins nothing for a source recorded
   * before pins existed, which is what branching did before.
   */
  activeProfileFor?(runtime: string): { profileName: string; model?: string } | null;
  sessionStore: {
    getSessionMetadata(): Promise<any>;
    /** Write-through for the runtime active flag. Optional for tests. */
    setActive?(id: string, active: boolean): Promise<void>;
    /** Boot reset for stale active flags. Optional for tests. */
    resetActiveFlags?(): Promise<void>;
  };
  /**
   * Optional project manager seam. When absent, project-aware create is not
   * available and project-less sessions behave exactly as today. (#168)
   */
  projectsManager?: ProjectsSessionApi;
  /** Release runtime, join and subscription leases before deleting a record. */
  releaseProjectSessionResources?(sessionId: string): void;
  /**
   * Optional so the hand-built deps literals in the existing tests keep
   * compiling; the server always supplies one.
   */
  sessionTeardown?: SessionTeardownLike;
  /** Shared with socket-created sessions so all account tab writes serialize. */
  tabCoordinator?: AccountTabCoordinatorLike;
  /**
   * The chat log, for listing past conversations in a folder.
   *
   * Optional for the same reason as `sessionTeardown` — the hand-built deps in
   * the tests predate it — and a server without one simply has nothing to
   * resume, which the route reports as an empty list rather than an error.
   */
  chatStore?: {
    stat(session: { id: string; ownerUserId: number }): Promise<{ firstSeq: number; cursor: number }>;
    describe(session: { id: string; ownerUserId: number }): Promise<{
      nativeSessionId: string | null;
      firstMessage: string | null;
    }>;
    /**
     * The three calls a branch needs, optional for the same reason the store
     * itself is: a deployment without a chat log has no conversation to branch
     * and the route says so rather than throwing.
     */
    turnCut?(session: { id: string; ownerUserId: number }, turnId: string): Promise<TurnCut | null>;
    append?(session: { id: string; ownerUserId: number }, events: ChatEvent[]): void;
    setOpeningContext?(session: { id: string; ownerUserId: number }, context: string): Promise<void>;
  };
}

export function createSessionRoutes(deps: SessionRoutesDeps): Router {
  const router = Router();
  // Membership and order are one account-owned value. Serialize every such
  // mutation for a user: a reorder must validate the same open set it persists,
  // and a failed older write must never roll back a newer close or reopen.
  const tabCoordinator = deps.tabCoordinator ?? new AccountTabCoordinator();
  const acquireTabMutation = (userId: number): Promise<() => void> =>
    tabCoordinator.acquire(userId);

  router.get('/api/sessions/persistence', async (_req: Request, res: Response): Promise<void> => {
    const user = requireUser(res);
    if (!user) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }

    const metadata = await deps.sessionStore.getSessionMetadata();
    const currentSessions = countUserSessions(deps.claudeSessions, user.id);

    res.json({
      ...metadata,
      currentSessions,
      autoSaveEnabled: true,
      autoSaveInterval: 30000,
    });
  });

  /**
   * Past conversations in a folder, to pick up instead of starting over.
   *
   * The web counterpart of `claude --resume`: choose a directory, then choose a
   * conversation. Scoped to one directory on purpose — a conversation is about
   * a project, and a list mixing every folder a person has ever opened is a
   * list nobody reads.
   *
   * Only sessions this user owns, and only ones that actually have a chat log:
   * a session record with an empty transcript is a folder someone opened and
   * walked away from, and offering to "resume" it would resume nothing.
   */
  router.get('/api/sessions/resumable', async (req: Request, res: Response): Promise<void> => {
    const user = requireUser(res);
    if (!user) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }

    const requested = typeof req.query.dir === 'string' ? req.query.dir : '';
    if (!requested) {
      res.status(400).json({ error: 'No folder was named' });
      return;
    }

    const hasProjectId = Object.prototype.hasOwnProperty.call(req.query, 'projectId');
    if (hasProjectId && (typeof req.query.projectId !== 'string' || !req.query.projectId.trim())) {
      res.status(400).json({ error: 'A project id must be a non-empty string' });
      return;
    }
    const projectId = typeof req.query.projectId === 'string'
      ? req.query.projectId.trim()
      : '';
    const requestedKind = typeof req.query.workingDirKind === 'string'
      ? req.query.workingDirKind
      : undefined;

    let canonicalDir = requested;
    let workingDirKind: 'host' | 'container' = 'host';
    if (projectId) {
      if (requestedKind !== 'host' && requestedKind !== 'container') {
        res.status(400).json({ error: 'A project folder namespace is required' });
        return;
      }
      const project = deps.projectsManager?.getForUser(user.id, projectId);
      if (!project) {
        // Same answer for an absent project and another user's project.
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      workingDirKind = requestedKind;
      // This endpoint reads no filesystem data: it matches an exact directory
      // against this user's already-owned records. Still require an absolute,
      // unambiguous name so a relative container path cannot alias another
      // folder after a later cwd change.
      if (requested.includes('\0') || (workingDirKind === 'container'
        ? !requested.startsWith('/')
        : !path.isAbsolute(requested))) {
        res.status(400).json({ error: 'An absolute project folder is required' });
        return;
      }
      canonicalDir = workingDirKind === 'container'
        ? path.posix.normalize(requested)
        : path.resolve(requested);
    } else {
      if (requestedKind !== undefined) {
        res.status(400).json({ error: 'A folder namespace requires a project' });
        return;
      }
      // Legacy/host folders keep the same host confinement they have always
      // used. Project folders are authorised by project identity above because
      // their bind mount intentionally sits outside the user's legacy base.
      const validation = deps.validatePath(requested, user.id);
      if (!validation.valid || !validation.path) {
        res.status(403).json({ error: 'That folder is outside the allowed base' });
        return;
      }
      canonicalDir = validation.path;
    }

    const candidates = chatRecords(deps, user.id)
      .filter((session) => session.workingDir === canonicalDir)
      .filter((session) => (session.projectId || '') === projectId)
      .filter((session) => !projectId
        || (session.projectWorkingDirKind ?? 'host') === workingDirKind)
      .slice(0, MAX_RESUMABLE);

    const conversations = await describeAll(deps, candidates);

    res.json({
      dir: canonicalDir,
      projectId: projectId || null,
      workingDirKind,
      conversations: conversations.filter((entry) => entry.events > 0),
    });
  });

  /**
   * Every conversation this user has, grouped by the project it belongs to.
   *
   * The answer to "what conversations do I have?", which until now the app had
   * nowhere to put. The resume list above answers a narrower question — "in this
   * folder, is there one to carry on with" — and it is reachable only on the way
   * to starting a new session in a folder already chosen. That makes it useless
   * for the two things people actually ask: where the conversation about the
   * release script was, and how to get back into the one closed yesterday (#127).
   *
   * Grouped here rather than in the browser because the ordering is a decision,
   * not a rendering: conversations run newest-first inside a project, and the
   * projects themselves run by their own newest conversation, so the folder
   * somebody was working in this morning is at the top whichever folder it is.
   * Both orders fall out of one sort, which is why there is only one.
   *
   * Not grouped by anything the filesystem says, either: a project with no
   * conversations does not appear, because this is a list of conversations that
   * happen to be filed under folders rather than a folder browser.
   */
  router.get('/api/sessions/conversations', async (_req: Request, res: Response): Promise<void> => {
    const user = requireUser(res);
    if (!user) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }

    const owned = chatRecords(deps, user.id);
    const described = await describeAll(deps, owned.slice(0, MAX_LISTED_CONVERSATIONS));
    // A record with an empty log is a folder somebody opened and walked away
    // from. It is not a conversation, and listing it would put a row with nothing
    // to read in front of the ones that matter — the same rule the resume list
    // applies, for the same reason.
    const conversations = described.filter((entry) => entry.events > 0);

    // Insertion order carries the grouping: `owned` is already newest-first, so
    // the first time a directory is seen is at its most recent conversation, and
    // every group's contents arrive in order behind it.
    const groups = new Map<string, ConversationProject>();
    for (const conversation of conversations) {
      // JSON framing makes the tuple unambiguous even when a path itself
      // contains punctuation. Project, namespace and cwd are all part of the
      // identity: `/workspace` in project A is unrelated to `/workspace` in B.
      const groupKey = JSON.stringify([
        conversation.projectId || null,
        conversation.workingDirKind || 'host',
        conversation.workingDir,
      ]);
      const existing = groups.get(groupKey);
      if (existing) {
        existing.conversations.push(conversation);
        continue;
      }
      groups.set(groupKey, {
        key: groupKey,
        projectId: conversation.projectId || null,
        workingDirKind: conversation.workingDirKind || 'host',
        dir: conversation.workingDir,
        name: conversation.projectName || projectName(conversation.workingDir),
        lastActivity: conversation.lastActivity,
        conversations: [conversation],
      });
    }

    res.json({
      projects: Array.from(groups.values()),
      total: conversations.length,
      truncated: owned.length > MAX_LISTED_CONVERSATIONS,
    });
  });

  /**
   * The user's standalone sessions — everything the tab strip and the session
   * dialogs are built from.
   *
   * A shell that belongs to a conversation is deliberately not here. It is a
   * real session, but it is reached through its conversation and only there;
   * listing it would put a top-level tab and a session row in front of every
   * client the user has open, including ones with no relation to the
   * conversation that opened it.
   */
  router.get('/api/sessions/list', async (_req: Request, res: Response): Promise<void> => {
    const user = requireUser(res);
    if (!user) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }

    // A mutation updates the in-memory records before awaiting SQLite. Wait for
    // that transaction to commit or roll back so reconnecting clients can never
    // photograph tentative membership/order that durability later refused.
    const release = await acquireTabMutation(user.id);
    try {
      const sessionList: SessionListItem[] = orderedAccountTabs(deps.claudeSessions, user.id)
        .map((session) => ({
        id: session.id,
        name: session.name,
        created: session.created,
        active: session.active,
        agent: session.agent,
        lastAgent: session.lastAgent,
        runtimeLabel: session.runtimeLabel,
        workingDir: session.workingDir,
        projectId: session.projectId,
        projectName: session.projectId
          ? deps.projectsManager?.getForUser(session.ownerUserId, session.projectId)?.name || null
          : null,
        projectWorkingDirKind: session.projectWorkingDirKind,
        connectedClients: session.connections.size,
        lastActivity: session.lastActivity,
        surface: session.surface || 'terminal',
        customName: session.customName,
        // So a tab restored on page load can show the mode it is really in from
        // its first paint. `summarise` already does this for the conversations
        // dialog; the tab strip was the one place the fact was known and not
        // carried.
        bypassPermissions: session.chatBypassPermissions === true,
        }));

      res.json({ sessions: sessionList });
    } finally {
      release();
    }
  });

  /** Replace the order of this account's complete, currently open tab set. */
  router.patch(
    '/api/sessions/tabs/order',
    async (req: Request, res: Response): Promise<void> => {
      const user = requireUser(res);
      if (!user) {
        res.status(401).json({ error: 'authentication_required' });
        return;
      }

      const requested = req.body?.sessionIds;
      if (
        !Array.isArray(requested)
        || requested.some((id) => typeof id !== 'string' || id.length === 0)
        || new Set(requested).size !== requested.length
      ) {
        res.status(400).json({
          error: 'invalid_tab_order',
          message: 'Tab order must contain each open session exactly once',
        });
        return;
      }

      const sessionIds = requested as string[];
      const release = await acquireTabMutation(user.id);
      try {
        const current = orderedAccountTabs(deps.claudeSessions, user.id);
        const currentIds = new Set(current.map((session) => session.id));
        if (
          sessionIds.length !== current.length
          || sessionIds.some((id) => !currentIds.has(id))
        ) {
          // Includes missing, foreign, closed and newly opened IDs without
          // revealing which one caused the mismatch. A stale reorder can never
          // reopen or close anything by implication.
          res.status(409).json({
            error: 'tab_set_changed',
            message: 'The open tab set changed; reload it before reordering',
          });
          return;
        }

        const byId = new Map(current.map((session) => [session.id, session]));
        const previous = current.map((session) => [session, session.tabOrder] as const);
        sessionIds.forEach((id, index) => { byId.get(id)!.tabOrder = index; });

        let saved = false;
        try {
          saved = (await deps.saveSessionsToDisk()) !== false;
        } catch (error) {
          console.error('Failed to persist conversation tab order:', error);
        }
        if (!saved) {
          for (const [session, order] of previous) session.tabOrder = order;
          res.status(503).json({
            error: 'tab_order_not_saved',
            message: 'The tab order could not be saved',
          });
          return;
        }

        announceSessionTabsReordered(user.id, sessionIds, deps.webSocketConnections);
        res.json({ success: true, sessionIds });
      } finally {
        release();
      }
    },
  );

  /**
   * Rename a session.
   *
   * The chosen label is stored beside the created name rather than over it, so
   * a session that was never renamed keeps the name — and the folder-name
   * substitution — it has today.
   *
   * Every one of this user's sockets is told, not just the one that asked: two
   * windows open on the same sessions disagreeing about what a tab is called
   * until somebody reloads is the same complaint as losing the name entirely.
   */
  router.patch('/api/sessions/:sessionId/name', (req: Request, res: Response): void => {
    const user = requireUser(res);
    if (!user) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }

    const session = getOwnedSession(deps.claudeSessions, req.params.sessionId as string, user);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const { name } = req.body ?? {};
    if (typeof name !== 'string') {
      res.status(400).json({ error: 'invalid_name', message: 'Session name must be a string' });
      return;
    }

    // A name is what the user typed with the whitespace taken off, and a name
    // that is nothing but whitespace is not a name. Capped because this label is
    // rendered in a fixed-width strip and stored on every autosave, and neither
    // has any use for a paragraph.
    const trimmed = name.trim().slice(0, MAX_NAME_LENGTH);
    if (!trimmed) {
      res.status(400).json({ error: 'empty_name', message: 'Session name cannot be empty' });
      return;
    }

    session.customName = trimmed;
    void deps.saveSessionsToDisk();

    for (const wsInfo of deps.webSocketConnections.values()) {
      if (wsInfo.userId !== user.id) continue;
      if (wsInfo.ws.readyState !== WebSocket.OPEN) continue;
      wsInfo.ws.send(
        JSON.stringify({ type: 'session_renamed', sessionId: session.id, name: trimmed }),
      );
    }

    res.json({ success: true, name: trimmed });
  });

  /**
   * Open or close one conversation tab for the whole account.
   *
   * This changes only strip membership. Deleting a conversation remains the
   * separate DELETE endpoint below; terminal tabs still take that path because
   * a terminal with no tab would be an unreachable live PTY.
   */
  router.patch(
    '/api/sessions/:sessionId/tab',
    async (req: Request, res: Response): Promise<void> => {
      const user = requireUser(res);
      if (!user) {
        res.status(401).json({ error: 'authentication_required' });
        return;
      }

      const sessionId = req.params.sessionId as string;
      const session = getOwnedSession(deps.claudeSessions, sessionId, user);
      if (!session) {
        // The same answer for a missing session and another account's session:
        // ownership must not become an existence oracle.
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      if (
        typeof req.body?.open !== 'boolean'
        || (req.body?.legacy !== undefined && typeof req.body.legacy !== 'boolean')
        || (req.body?.legacy === true && req.body.open !== false)
      ) {
        res.status(400).json({
          error: 'invalid_tab_state',
          message: 'Tab state must name whether the tab is open',
        });
        return;
      }

      if (session.surface !== 'chat' || session.ownerSessionId) {
        res.status(400).json({
          error: 'unsupported_tab_session',
          message: 'Only standalone conversation tabs can be opened or closed',
        });
        return;
      }

      const release = await acquireTabMutation(user.id);
      try {
        // It may have been deleted while this request waited behind an earlier
        // device. Re-read under the mutation turn instead of writing through a
        // stale object that is no longer in the authoritative map.
        const current = getOwnedSession(deps.claudeSessions, sessionId, user);
        if (!current) {
          res.status(404).json({ error: 'Session not found' });
          return;
        }

        const open = req.body.open as boolean;
        const legacy = req.body.legacy === true;

        // The retired browser-local close list can exist on several devices.
        // Apply one of those old tombstones only while the persisted row still
        // says no account-level decision has ever been recorded. Once any
        // device migrated, closed or explicitly reopened it, another stale
        // browser must not get to close it merely because it started later.
        if (legacy && current.tabOpen !== undefined) {
          res.json({ success: true, open: current.tabOpen, applied: false });
          return;
        }

        const previousOpen = current.tabOpen;
        const previousOrder = current.tabOrder;
        const genuinelyReopened = open && current.tabOpen === false;
        const appendedOrder = genuinelyReopened
          ? nextAccountTabOrder(deps.claudeSessions, user.id)
          : current.tabOrder;
        current.tabOpen = open;
        if (genuinelyReopened) current.tabOrder = appendedOrder;
        let saved = false;
        try {
          saved = (await deps.saveSessionsToDisk()) !== false;
        } catch (error) {
          console.error('Failed to persist conversation tab state:', error);
        }
        if (!saved) {
          current.tabOpen = previousOpen;
          current.tabOrder = previousOrder;
          res.status(503).json({
            error: 'tab_state_not_saved',
            message: 'The tab state could not be saved',
          });
          return;
        }

        // Durability comes before visibility. A client that receives this event
        // may immediately disconnect; its reconnect list must already agree.
        if (open) {
          announceSessionOpened(current, deps.webSocketConnections);
          // State the complete order even for an idempotent open. A stale live
          // client may be missing this tab and append the announcement locally,
          // while the server already has it in the middle of the strip.
          announceSessionTabsReordered(
            user.id,
            orderedAccountTabs(deps.claudeSessions, user.id).map((item) => item.id),
            deps.webSocketConnections,
          );
        } else {
          announceSessionTabClosed(current, deps.webSocketConnections);
        }

        res.json({ success: true, open, applied: true });
      } finally {
        release();
      }
    },
  );
  router.post('/api/sessions/create', async (req: Request, res: Response): Promise<void> => {
    const user = requireUser(res);
    if (!user) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }

    const { name, workingDir, ownerSessionId, projectId, projectWorkingDirKind } = req.body;
    const sessionId = randomUUID();

    // The name is bound into a SQLite statement on every autosave, and SQLite
    // refuses to bind anything that is not a string, number, null, bigint or
    // buffer. One bad value therefore throws inside the replaceAll transaction
    // and aborts the save — for every user's sessions, not just this one, since
    // they are all written in that single transaction. Rejecting it here keeps
    // the failure at the request that caused it.
    if (name !== undefined && typeof name !== 'string') {
      res.status(400).json({ error: 'invalid_name', message: 'Session name must be a string' });
      return;
    }
    if (workingDir !== undefined && workingDir !== null && typeof workingDir !== 'string') {
      res.status(400).json({
        error: 'invalid_working_dir',
        message: 'Working directory must be a string',
      });
      return;
    }
    if (projectId !== undefined && projectId !== null && typeof projectId !== 'string') {
      res.status(400).json({ error: 'invalid_project_id', message: 'Project id must be a string' });
      return;
    }
    if (typeof projectId === 'string' && projectId.trim().length === 0) {
      res.status(400).json({ error: 'invalid_project_id', message: 'Project id cannot be empty' });
      return;
    }
    if (
      projectWorkingDirKind !== undefined
      && projectWorkingDirKind !== 'host'
      && projectWorkingDirKind !== 'container'
    ) {
      res.status(400).json({
        error: 'invalid_project_working_dir_kind',
        message: 'Project working directory kind must be host or container',
      });
      return;
    }

    // A session can declare that it belongs to a conversation, which is what
    // keeps it out of the listings and ties its lifetime to that conversation's.
    // Only a conversation this user owns will do: accepting an arbitrary id
    // would let one request hide a session from its own owner's tab strip, or
    // attach it to somebody else's teardown.
    let owner: string | undefined;
    let ownerRecord: SessionRecord | undefined;
    if (ownerSessionId !== undefined && ownerSessionId !== null) {
      if (typeof ownerSessionId !== 'string') {
        res.status(400).json({
          error: 'invalid_owner_session',
          message: 'Owner session id must be a string',
        });
        return;
      }
      const parent = getOwnedSession(deps.claudeSessions, ownerSessionId, user);
      if (!parent || parent.surface !== 'chat') {
        res.status(400).json({
          error: 'unknown_owner_session',
          message: 'That conversation does not exist',
        });
        return;
      }
      if (parent.retiring) {
        res.status(409).json({
          error: 'owner_session_retiring',
          message: 'That conversation is being deleted',
        });
        return;
      }
      owner = parent.id;
      ownerRecord = parent;
    }

    const submittedProjectId = typeof projectId === 'string' ? projectId.trim() : undefined;
    const inheritedProjectId = ownerRecord?.projectId || undefined;
    if (
      ownerRecord
      && projectId !== undefined
      && (projectId === null ? undefined : submittedProjectId) !== inheritedProjectId
    ) {
      res.status(400).json({
        error: 'owner_project_mismatch',
        message: 'A conversation terminal must use the conversation project',
      });
      return;
    }
    const effectiveProjectId = ownerRecord ? inheritedProjectId : submittedProjectId;
    if (projectWorkingDirKind !== undefined && !effectiveProjectId) {
      res.status(400).json({
        error: 'project_working_dir_without_project',
        message: 'A container working directory requires a project',
      });
      return;
    }
    if (projectWorkingDirKind !== undefined && !workingDir) {
      res.status(400).json({
        error: 'project_working_dir_kind_without_path',
        message: 'A project working directory kind requires a working directory',
      });
      return;
    }

    // Register before the first await. A deletion marks the owner retiring and
    // drains this promise before it scans children, so this request either
    // commits in full and is found by that scan or observes retirement and
    // commits nothing.
    const completeOwnedCreate = owner
      ? trackOwnedSessionCreate(coordinationFor(deps), owner)
      : undefined;
    let projectLease: ProjectSessionLease | undefined;
    try {
      let persistedProjectId: string | undefined;
      let persistedProjectName: string | null = null;
      let preparedProject:
        | Extract<ProjectSessionEnvironmentResult, { ok: true }>
        | undefined;
      let validWorkingDir = (deps.getUserBaseFolder?.(user.id) ?? deps.baseFolder);
      let validWorkingDirKind: 'host' | 'container' | undefined;
      let projectWorkingDirLifetime: 'workspace' | 'owner_home' | 'disposable' | undefined;
      if (effectiveProjectId) {
        // Check owner scope before provisioning anything. A guessed id must not
        // start another user's project or disclose whether it can be started.
        const projects = deps.projectsManager;
        const ownedProject = projects?.getForUser(user.id, effectiveProjectId);
        if (!projects || !ownedProject) {
          res.status(404).json({ error: 'project_not_found', message: 'Project not found' });
          return;
        }

        const prepared = await projects.ensureForSession(user.id, effectiveProjectId);
        if (!prepared.ok) {
          if (prepared.reason === 'not_found') {
            res.status(404).json({ error: 'project_not_found', message: 'Project not found' });
          } else if (prepared.reason === 'run_limit') {
            res.status(409).json({ error: 'run_limit', running: prepared.running || [] });
          } else if (prepared.reason === 'shutting_down') {
            res.status(503).json({
              error: 'project_unavailable',
              detail: prepared.detail || 'The project service is shutting down',
            });
          } else {
            res.status(409).json({
              error: prepared.reason === 'building' ? 'project_building' : 'project_unavailable',
              detail: prepared.detail,
            });
          }
          return;
        }
        projectLease = {
          ownerUserId: user.id,
          projectId: effectiveProjectId,
          leaseId: prepared.leaseId,
        };
        persistedProjectId = effectiveProjectId;
        persistedProjectName = ownedProject.name || null;
        preparedProject = prepared;
        if (ownerRecord?.projectId === effectiveProjectId && !workingDir) {
          // A split terminal stays in its conversation's exact namespace. A
          // disposable container path that vanished on rebuild safely falls
          // back to the current checkout and changes its discriminator too.
          const inherited = await restoreProjectWorkingDir(
            projects,
            prepared,
            ownerRecord.workingDir,
            ownerRecord.projectWorkingDirKind,
          );
          validWorkingDir = inherited.workingDir;
          validWorkingDirKind = inherited.kind;
        } else {
          validWorkingDir = await projectWorkingDirOrDefault(prepared);
          validWorkingDirKind = 'host';
        }
      }

      if (workingDir) {
        if (persistedProjectId && preparedProject) {
          const requestedKind = projectWorkingDirKind
            ?? ownerRecord?.projectWorkingDirKind
            ?? 'host';
          const confined = requestedKind === 'container'
            ? await canonicalProjectContainerWorkingDir(
                deps.projectsManager!,
                preparedProject,
                workingDir,
              )
            : await canonicalProjectWorkingDir(
                preparedProject.allowedWorkingDirs,
                workingDir,
              );
          if (!confined) {
            res.status(403).json({
              error: 'invalid_project_working_dir',
              message: requestedKind === 'container'
                ? 'That directory does not exist in the project container'
                : 'That host directory is not mounted into this project',
            });
            return;
          }
          validWorkingDir = confined;
          validWorkingDirKind = requestedKind;
        } else {
          const validation = deps.validatePath(workingDir, user.id);
          if (!validation.valid) {
            res.status(403).json({
              error: validation.error,
              message: 'Cannot create session with working directory outside the allowed area',
            });
            return;
          }
          validWorkingDir = validation.path!;
        }
      } else if (!persistedProjectId) {
        const selected = deps.getSelectedWorkingDir(user.id);
        validWorkingDir = selected && deps.validatePath(selected, user.id).valid
          ? selected
          : (deps.getUserBaseFolder?.(user.id) ?? deps.baseFolder);
      }

      if (preparedProject?.containerAccess && validWorkingDirKind === 'container') {
        projectWorkingDirLifetime = classifyProjectContainerPath(
          preparedProject.containerAccess,
          validWorkingDir,
        );
      }

      // The owner was authorised before project provisioning and cwd
      // canonicalisation, both of which may await. Bind the child to the exact
      // same owned record at commit time; an id removed and reused meanwhile is
      // not the conversation this request was allowed to join.
      if (ownerRecord) {
        const currentOwner = deps.claudeSessions.get(ownerRecord.id);
        if (
          currentOwner !== ownerRecord
          || currentOwner.ownerUserId !== user.id
          || currentOwner.surface !== 'chat'
          || currentOwner.retiring
        ) {
          res.status(409).json({
            error: 'owner_session_retiring',
            message: 'That conversation is being deleted',
          });
          return;
        }
      }

      const release = await acquireTabMutation(user.id);
      let session: SessionRecord;
      try {
        // Project preparation may await for long enough that the owner is
        // retired or replaced. Revalidate the exact record under the same
        // account turn that allocates tab membership and persists it.
        if (ownerRecord) {
          const currentOwner = deps.claudeSessions.get(ownerRecord.id);
          if (
            currentOwner !== ownerRecord
            || currentOwner.ownerUserId !== user.id
            || currentOwner.surface !== 'chat'
            || currentOwner.retiring
          ) {
            res.status(409).json({
              error: 'owner_session_retiring',
              message: 'That conversation is being deleted',
            });
            return;
          }
        }

        // Allocate and insert inside the same account turn as visibility/order.
        // Otherwise a close that later rolls back can leave this new tab sharing
        // its tentative append position.
        session = deps.createSessionRecord({
          id: sessionId,
          ownerUserId: user.id,
          name,
          workingDir: validWorkingDir,
          ownerSessionId: owner,
          projectId: persistedProjectId,
          projectWorkingDirKind: persistedProjectId ? validWorkingDirKind : undefined,
        });
        if (!owner) session.tabOrder = nextAccountTabOrder(deps.claudeSessions, user.id);
        deps.claudeSessions.set(sessionId, session);

        // Keep both the project admission lease and the account tab turn until
        // the association is durable. A refused SQLite save commits nothing and
        // must not leak a visible tab or transcript.
        let saved = false;
        try {
          saved = (await deps.saveSessionsToDisk()) !== false;
        } catch (error) {
          console.error('Failed to persist new session:', error);
        }
        if (!saved) {
          deps.claudeSessions.delete(sessionId);
          res.status(503).json({
            error: 'session_not_saved',
            message: 'The new session could not be saved',
          });
          return;
        }

        void deps.transcriptStore.ensureTranscript(session);
        // Every screen this person has open, including the one that asked — which
        // adds the tab from this response and folds the announcement into it. A
        // shell created *inside* a conversation announces nothing; see the helper.
        announceSessionOpened(
          session,
          deps.webSocketConnections,
          persistedProjectId ? persistedProjectName : undefined,
        );
      } finally {
        release();
      }

      if (deps.dev) {
        console.log(`Created new session: ${sessionId} for GitHub user ${user.githubLogin}`);
      }

      res.json({
        success: true,
        sessionId,
        session: {
          id: sessionId,
          name: session.name,
          workingDir: session.workingDir,
          projectId: session.projectId,
          projectName: persistedProjectName,
          projectWorkingDirKind: session.projectWorkingDirKind,
          projectWorkingDirLifetime,
          lastAgent: session.lastAgent,
          runtimeLabel: session.runtimeLabel,
        },
      });
    } finally {
      // Creating an inactive record is not active project work. The lease only
      // closes the admission-vs-stop race while the record and its cwd are
      // validated and persisted; runtime and socket paths take their own.
      try {
        releaseProjectSessionLease(deps.projectsManager, projectLease);
      } finally {
        completeOwnedCreate?.();
      }
    }
  });

  /**
   * Start a new conversation from a turn of this one.
   *
   * The new conversation gets the history up to and including that turn in its
   * own log — so it is there to read — and the same history waiting as the
   * opening context of its first turn, so the agent it is handed to knows what
   * came before rather than reading over the user's shoulder. See chat/branch.ts
   * for what is actually sent and why it is a rendition.
   *
   * The conversation branched from is not touched. Not one event: the cut is a
   * read, and everything written lands in the record created here.
   *
   * A branch that will not fit the model's window is refused with the figures
   * rather than trimmed to size, and a conversation whose runtime never
   * reported a window is branched with the check skipped and *said* to have
   * been — the alternative is measuring against a ceiling nobody stated, which
   * is the wrong ceiling this app declines to invent everywhere else.
   */
  router.post('/api/sessions/:sessionId/branch', async (req: Request, res: Response): Promise<void> => {
    const user = requireUser(res);
    if (!user) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }

    const source = getOwnedSession(deps.claudeSessions, req.params.sessionId as string, user);
    if (!source || source.surface !== 'chat') {
      res.status(404).json({ error: 'unknown_conversation', message: 'That conversation does not exist' });
      return;
    }

    const turnId = typeof req.body?.turnId === 'string' ? req.body.turnId.trim() : '';
    if (!turnId) {
      res.status(400).json({ error: 'invalid_turn', message: 'No turn was named' });
      return;
    }

    const store = deps.chatStore;
    if (!store?.turnCut || !store.append || !store.setOpeningContext) {
      res.status(501).json({
        error: 'branching_unavailable',
        message: 'This server cannot branch conversations',
      });
      return;
    }

    try {
      const cut = await store.turnCut({ id: source.id, ownerUserId: source.ownerUserId }, turnId);
      if (!cut) {
        res.status(404).json({
          error: 'unknown_turn',
          message: 'That turn is no longer in this conversation',
        });
        return;
      }

      const plan = planBranch(cut);
      if (!plan.fits) {
        // 413 rather than 400: the request was perfectly well formed and the
        // thing it asked for is too big, which is the one distinction that
        // tells a caller retrying with an earlier turn would help.
        res.status(413).json({
          error: 'context_too_large',
          message: tooLargeMessage(plan, cut.turn.index),
          estimatedTokens: plan.estimatedTokens,
          contextWindow: plan.contextWindow,
          budgetTokens: plan.budgetTokens,
        });
        return;
      }

      const sessionId = randomUUID();
      const branch = deps.createSessionRecord({
        id: sessionId,
        ownerUserId: user.id,
        name: branchName(source, cut.turn.index),
        workingDir: source.workingDir,
        // A branch is a continuation in the same checkout. Losing this would
        // make its next launch silently fall back to the user's environment.
        projectId: source.projectId,
        projectWorkingDirKind: source.projectWorkingDirKind,
      });
      // The conversation this one came from, running the same agent in the same
      // place. Not `agent`, which says a process is up: nothing is running here
      // until the browser launches it.
      branch.surface = 'chat';
      branch.lastAgent = source.lastAgent;
      branch.runtimeLabel = source.runtimeLabel;
      // The model and the effort level travel with it, because they are how
      // this line of work was being done and the branch is a continuation of
      // it — and because the window the history was just measured against is
      // that model's. The bypass flag deliberately does not, and now the reason
      // is complete: a branch is a conversation that is *beginning*, so it takes
      // the owner's preference at launch like every other beginning (#134).
      // Copying the source's grant would instead let one old answer spread from
      // conversation to conversation, outliving the preference that produced it.
      branch.chatModelOverride = source.chatModelOverride;
      // A source with no override of its own still has to arrive fixed, not
      // blank: a blank branch is a conversation that has never chatted, so its
      // launch would take the brancher's *standing* model (#135) — a different
      // model from the one the history above was just measured against, which
      // is the one thing this route is not allowed to get wrong.
      //
      // What the source is fixed to, not what any default now says. The pin the
      // source's own launch left is the only record of which model it actually
      // ran, and it already accounts for every layer that decided it — a
      // standing choice, a profile, or nothing at all. Asking the profile again
      // here would answer a different question, and would answer it wrongly for
      // every source that was launched on a standing choice instead.
      //
      // As a pin rather than as an override, because the user chose nothing:
      // an override would make the branch's picker report a model as "chosen for
      // this conversation" and offer a clear that wipes the account's standing
      // choice along with it.
      //
      // The profile stays as the last resort, for a source recorded before pins
      // existed: it has no pin to copy and the profile is what it launched on.
      // Tested against `undefined` rather than with `??`, because a source
      // pinned to `null` ran with no model flag at all and the branch has to
      // inherit that answer instead of picking up a profile the source never had.
      branch.chatModelPinned =
        source.chatModelPinned !== undefined
          ? source.chatModelPinned
          : deps.activeProfileFor?.(source.lastAgent || '')?.model;
      branch.chatEffortOverride = source.chatEffortOverride;

      const ref = { id: sessionId, ownerUserId: user.id };
      store.append(ref, plan.events);
      // `append` is fire-and-forget by contract — it runs on the event path and
      // may not fail a live conversation — so the write is confirmed here
      // instead, through the store's own per-log queue: a stat cannot answer
      // until the append ahead of it has finished, and an append that threw
      // leaves nothing behind it to count.
      const stats = await store.stat(ref);
      if (stats.cursor < plan.events.length) {
        res.status(500).json({
          error: 'branch_not_written',
          message: 'The branch could not be written to disk',
        });
        return;
      }
      await store.setOpeningContext(ref, plan.context);

      const branchProjectName = branch.projectId
        ? deps.projectsManager?.getForUser(branch.ownerUserId, branch.projectId)?.name || null
        : null;
      const release = await acquireTabMutation(user.id);
      try {
        // Creating the record happened before the durable branch log was built,
        // which can take long enough for another device to reorder or close
        // tabs. Allocate and insert only after that account mutation commits or
        // rolls back, never against its tentative positions.
        branch.tabOrder = nextAccountTabOrder(deps.claudeSessions, user.id);
        deps.claudeSessions.set(sessionId, branch);

        let saved = false;
        try {
          saved = (await deps.saveSessionsToDisk()) !== false;
        } catch (error) {
          console.error('Failed to persist branched session:', error);
        }
        if (!saved) {
          deps.claudeSessions.delete(sessionId);
          res.status(503).json({
            error: 'branch_not_saved',
            message: 'The branch could not be saved',
          });
          return;
        }

        void deps.transcriptStore.ensureTranscript(branch);
        // A branch is a conversation that now exists, so it reaches the user's
        // other screens on the same terms as one started from scratch.
        announceSessionOpened(
          branch,
          deps.webSocketConnections,
          branch.projectId ? branchProjectName : undefined,
        );
      } finally {
        release();
      }

      res.json({
        success: true,
        sessionId,
        name: branch.name,
        workingDir: branch.workingDir,
        projectId: branch.projectId,
        projectName: branchProjectName,
        projectWorkingDirKind: branch.projectWorkingDirKind,
        runtime: branch.lastAgent,
        turnIndex: cut.turn.index,
        turns: plan.turns,
        estimatedTokens: plan.estimatedTokens,
        // Absent means no window was ever reported, so nothing was measured.
        // Named rather than left to be inferred from a missing number: a caller
        // has to be able to tell a branch that fits from one nobody could size.
        contextWindow: plan.contextWindow,
        sizeChecked: plan.budgetTokens !== undefined,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to branch session ${source.id}:`, error);
      res.status(500).json({ error: 'branch_failed', message });
    }
  });

  router.get('/api/sessions/:sessionId', (req: Request, res: Response): void => {
    const user = requireUser(res);
    if (!user) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }

    const session = getOwnedSession(deps.claudeSessions, req.params.sessionId as string, user);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    res.json({
      id: session.id,
      name: session.name,
      customName: session.customName,
      created: session.created,
      active: session.active,
      agent: session.agent,
      lastAgent: session.lastAgent,
      runtimeLabel: session.runtimeLabel,
      workingDir: session.workingDir,
      projectId: session.projectId,
      projectWorkingDirKind: session.projectWorkingDirKind,
      connectedClients: session.connections.size,
      lastActivity: session.lastActivity,
    });
  });

  router.delete('/api/sessions/:sessionId', async (req: Request, res: Response): Promise<void> => {
    const user = requireUser(res);
    if (!user) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }

    const sessionId = req.params.sessionId as string;
    const session = getOwnedSession(deps.claudeSessions, sessionId, user);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    // Close child admission before looking for children. A create that already
    // passed owner validation is drained, then either appears in this cascade
    // or rolls itself back; a later create sees `retiring` and is rejected.
    // Concurrent deletes join the same cascade instead of tearing records down
    // twice.
    const saved = await retireSessionTree(deps, session, () => acquireTabMutation(user.id));
    if (!saved) {
      res.status(503).json({
        error: 'session_delete_not_saved',
        message: 'The session could not be deleted',
      });
      return;
    }

    res.json({ success: true, message: 'Session deleted' });
  });

  /**
   * Download the whole session as Markdown.
   *
   * Streamed in pages straight from the history index rather than buffered:
   * a long session is tens of megabytes, and holding all of it in memory to
   * serve one download would be the same mistake the scrollback paging exists
   * to avoid.
   */
  router.get(
    '/api/sessions/:sessionId/export.md',
    async (req: Request, res: Response): Promise<void> => {
      const user = requireUser(res);
      if (!user) {
        res.status(401).json({ error: 'authentication_required' });
        return;
      }

      const sessionId = req.params.sessionId as string;
      const session = getOwnedSession(deps.claudeSessions, sessionId, user);
      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${exportFileName(session)}"`,
      );

      res.write(`# ${displayName(session)}\n\n`);
      res.write(`- Directory: \`${session.workingDir}\`\n`);
      res.write(`- Created: ${session.created.toISOString()}\n`);
      res.write(`- Last activity: ${session.lastActivity.toISOString()}\n\n`);
      res.write(`${FENCE}\n`);

      try {
        const { firstLine, totalLines } = await deps.historyStore.stat(session);
        if (firstLine > 0) {
          res.write(`[... ${firstLine} earlier lines no longer retained ...]\n`);
        }

        for (let cursor = firstLine; cursor < totalLines; ) {
          const page = await deps.historyStore.read(session, cursor, EXPORT_PAGE_LINES);
          if (page.lines.length === 0) {
            break;
          }
          res.write(`${page.lines.map(toPlainText).join('\n')}\n`);
          cursor = page.fromLine + page.lines.length;
        }

        // The newest lines are still on the emulator's screen and have not
        // scrolled into history yet. Taking them from the raw output buffer
        // instead would re-emit whatever of the session that buffer still
        // holds, duplicating most of the export.
        const tail = deps.getScreenSnapshot(sessionId);
        if (tail.length > 0) {
          res.write(`${tail.map(toPlainText).join('\n')}\n`);
        }
      } catch (error) {
        console.error(`Failed to export session ${sessionId}:`, error);
        res.write('\n[... export interrupted by an error ...]\n');
      }

      res.write(`${FENCE}\n`);
      res.end();
    },
  );

  return router;
}

/** Restore staged deletions at their exact Map positions after a refused save. */
function restoreSessionMapOrder(
  sessions: Map<string, SessionRecord>,
  removed: SessionRecord[],
  originalIds: string[],
): void {
  const current = new Map(sessions);
  const staged = new Map(removed.map((session) => [session.id, session]));
  sessions.clear();

  for (const id of originalIds) {
    const session = current.get(id) ?? staged.get(id);
    if (session) sessions.set(id, session);
    current.delete(id);
    staged.delete(id);
  }
  // Preserve mutations from other accounts that legitimately completed while
  // this user's persistence was in flight.
  for (const [id, session] of current) sessions.set(id, session);
  for (const [id, session] of staged) sessions.set(id, session);
}

/** Record one child create from owner validation through persistence/rollback. */
function trackOwnedSessionCreate(
  coordination: SessionRouteCoordination,
  ownerSessionId: string,
): () => void {
  let resolveCompletion!: () => void;
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });
  let pending = coordination.pendingOwnedCreates.get(ownerSessionId);
  if (!pending) {
    pending = new Set();
    coordination.pendingOwnedCreates.set(ownerSessionId, pending);
  }
  pending.add(completion);

  let completed = false;
  return () => {
    if (completed) return;
    completed = true;
    pending!.delete(completion);
    if (pending!.size === 0) coordination.pendingOwnedCreates.delete(ownerSessionId);
    resolveCompletion();
  };
}

/** Await every create that was admitted before these owners began retiring. */
async function drainOwnedSessionCreates(
  coordination: SessionRouteCoordination,
  ownerSessionIds: Set<string>,
): Promise<void> {
  for (;;) {
    const pending = new Set<Promise<void>>();
    for (const ownerSessionId of ownerSessionIds) {
      for (const completion of coordination.pendingOwnedCreates.get(ownerSessionId) || []) {
        pending.add(completion);
      }
    }
    if (pending.size === 0) return;
    await Promise.all(pending);
  }
}

/**
 * Close admission, drain it, then follow owner links to a fixed point.
 *
 * The loop matters for future child surfaces that may themselves own a child:
 * each newly found record is marked before its own in-flight creates are
 * drained, so no generation can materialise behind the scan.
 */
async function collectRetiringSessionTree(
  deps: SessionRoutesDeps,
  roots: SessionRecord[],
): Promise<Set<string>> {
  const coordination = coordinationFor(deps);
  const ids = new Set<string>();
  for (const root of roots) {
    root.retiring = true;
    ids.add(root.id);
  }

  for (;;) {
    await drainOwnedSessionCreates(coordination, ids);
    let changed = false;
    for (const session of deps.claudeSessions.values()) {
      if (!session.ownerSessionId || !ids.has(session.ownerSessionId) || ids.has(session.id)) {
        continue;
      }
      session.retiring = true;
      ids.add(session.id);
      changed = true;
    }
    if (!changed) return ids;
  }
}

/**
 * Stop every live runtime attached to a project while retaining its session
 * records and transcripts. Admission is closed before any await, then socket
 * claims are detached only after every runtime has been verified as stopped.
 */
export async function suspendProjectSessions(
  deps: SessionRoutesDeps,
  projectId: string,
): Promise<string[]> {
  const roots = Array.from(deps.claudeSessions.values())
    .filter((session) => session.projectId === projectId);
  for (const session of roots) session.retiring = true;
  const ids = await collectRetiringSessionTree(deps, roots);
  const sessions = Array.from(deps.claudeSessions.values())
    .filter((session) => ids.has(session.id));

  try {
    for (const session of sessions) {
      if (deps.stopSessionRuntime) {
        await deps.stopSessionRuntime(session);
      } else if (session.active && session.agent) {
        if (session.surface === 'chat') {
          throw new Error('Cannot stop an active chat session without a chat stop hook');
        }
        const bridge = deps.getRuntimeBridge(session.agent);
        if (!bridge) throw new Error(`Cannot stop runtime ${session.agent}`);
        await bridge.stopSession(session.id);
        session.active = false;
        session.agent = null;
      }
    }

    for (const session of sessions) {
      deps.releaseProjectSessionResources?.(session.id);
      session.connections.clear();
    }
    const saved = (await deps.saveSessionsToDisk()) !== false;
    if (!saved) throw new Error('The stopped project sessions could not be saved');
    return sessions.map((session) => session.id);
  } finally {
    for (const session of sessions) session.retiring = false;
  }
}

/** One user delete cascade, shared by concurrent requests for the same root. */
function retireSessionTree(
  deps: SessionRoutesDeps,
  root: SessionRecord,
  acquireTabMutation: () => Promise<() => void>,
): Promise<boolean> {
  const coordination = coordinationFor(deps);
  const existing = coordination.retiringTrees.get(root);
  if (existing) return existing;

  // This assignment is deliberately before the async collector's first yield:
  // a create arriving immediately after DELETE cannot pass owner validation.
  root.retiring = true;
  const retirement = (async (): Promise<boolean> => {
    const ids = await collectRetiringSessionTree(deps, [root]);
    const release = await acquireTabMutation();
    try {
      const originalIds = Array.from(deps.claudeSessions.keys());
      const descendants = Array.from(deps.claudeSessions.values())
        .filter((session) => session !== root && ids.has(session.id));
      const removed = [...descendants, root];
      for (const session of removed) deps.claudeSessions.delete(session.id);

      let saved = false;
      try {
        saved = (await deps.saveSessionsToDisk()) !== false;
      } catch (error) {
        console.error('Failed to persist session deletion:', error);
      }
      if (!saved) {
        restoreSessionMapOrder(deps.claudeSessions, removed, originalIds);
        for (const session of removed) session.retiring = false;
        return false;
      }

      // Persistence is the irreversible boundary. Only after SQLite accepts
      // the removal may runtimes, logs and client-visible membership be torn
      // down; a refused save restores the exact Map order above.
      for (const session of descendants) await destroySessionOnce(deps, session);
      await destroySessionOnce(deps, root);
      return true;
    } finally {
      release();
    }
  })();
  coordination.retiringTrees.set(root, retirement);
  void retirement.then(
    () => coordination.retiringTrees.delete(root),
    () => coordination.retiringTrees.delete(root),
  );
  return retirement;
}

/** Share physical teardown when a child delete and a parent/project cascade meet. */
function destroySessionOnce(
  deps: SessionRoutesDeps,
  session: SessionRecord,
): Promise<void> {
  const coordination = coordinationFor(deps);
  const existing = coordination.destroyedSessions.get(session);
  if (existing) return existing;

  const destruction = destroySession(deps, session);
  coordination.destroyedSessions.set(session, destruction);
  // A failed stop must remain retryable. Successful promises stay associated
  // with the record object so a stale concurrent cascade cannot tear it down a
  // second time after another request removed it from the map.
  void destruction.catch(() => {
    if (coordination.destroyedSessions.get(session) === destruction) {
      coordination.destroyedSessions.delete(session);
    }
  });
  return destruction;
}

/**
 * Retire every session a deleted project owns, including shells whose only
 * link is their owning project conversation. The project manager calls this
 * before it destroys the project row; clearing `projectId` would turn a stale
 * tab into a legacy-host session on its next launch.
 */
export async function retireProjectSessions(
  deps: SessionRoutesDeps,
  projectId: string,
): Promise<string[]> {
  const roots = Array.from(deps.claudeSessions.values())
    .filter((session) => session.projectId === projectId);
  // Mark every project record synchronously, before the first drain yields.
  // Project deletion can therefore neither miss a child create already in
  // flight nor admit a new one while it is collecting the owned-session tree.
  for (const session of roots) session.retiring = true;
  const ids = await collectRetiringSessionTree(deps, roots);
  const sessions = Array.from(deps.claudeSessions.values())
    .filter((session) => ids.has(session.id));
  if (sessions.length === 0) return [];

  // A project cascade can remove several tabs at once. Hold each affected
  // account's tab turn in stable order while the shared session snapshot is
  // staged and persisted.
  const releases: Array<() => void> = [];
  try {
    if (deps.tabCoordinator) {
      const ownerIds = [...new Set(sessions.map((session) => session.ownerUserId))]
        .sort((left, right) => left - right);
      for (const ownerUserId of ownerIds) {
        releases.push(await deps.tabCoordinator.acquire(ownerUserId));
      }
    }

    const originalIds = Array.from(deps.claudeSessions.keys());
    for (const session of sessions) deps.claudeSessions.delete(session.id);
    try {
      const saved = (await deps.saveSessionsToDisk()) !== false;
      if (!saved) throw new Error('The project session deletion could not be saved');
    } catch (error) {
      restoreSessionMapOrder(deps.claudeSessions, sessions, originalIds);
      for (const session of sessions) session.retiring = false;
      throw error;
    }

    for (const session of sessions) await destroySessionOnce(deps, session);
  } finally {
    for (let index = releases.length - 1; index >= 0; index -= 1) releases[index]();
  }
  return sessions.map((session) => session.id);
}

/**
 * End one session: await its process, then remove its sockets, record and
 * stored transcript/history. The caller persists once for the whole cascade.
 */
async function destroySession(deps: SessionRoutesDeps, session: SessionRecord): Promise<void> {
  if (deps.stopSessionRuntime) {
    // The unified hook also closes launch admission and drains a start that is
    // still awaiting an environment/adapter while `active` is false. Calling
    // it unconditionally is what prevents deletion from orphaning that launch.
    await deps.stopSessionRuntime(session);
  } else if (session.active && session.agent) {
    // Compatibility for embedders/tests that predate the unified hook. Chat
    // sessions require the hook; a bridge is only a correct fallback for the
    // terminal surface.
    if (session.surface === 'chat') {
      throw new Error('Cannot retire an active chat session without a chat stop hook');
    }
    const bridge = deps.getRuntimeBridge(session.agent);
    if (!bridge) throw new Error(`Cannot stop runtime ${session.agent}`);
    await bridge.stopSession(session.id);
  }

  // Runtime teardown above releases the process lease. Clear every remaining
  // join/subscription lease before the record disappears, otherwise a socket
  // can keep a deleted project permanently protected from lifecycle work.
  deps.releaseProjectSessionResources?.(session.id);

  // Whoever was driving this session is no longer driving anything. Only them:
  // a screen that merely had a tab for it was never attached, and clearing a
  // field it does not hold would tell it to let go of the session it *is* on.
  session.connections.forEach((wsId) => {
    const wsInfo = deps.webSocketConnections.get(wsId);
    if (wsInfo) wsInfo.claudeSessionId = null;
  });

  // The news itself goes to every screen this user has open. It used to go down
  // `connections`, which is the set above — so a second device holding the tab
  // but looking elsewhere was never told, and went on offering a session that
  // had ceased to exist.
  announceSessionClosed(session, deps.webSocketConnections);

  session.connections.clear();
  deps.claudeSessions.delete(session.id);
  // Without this the headless emulator for a deleted session would live for
  // as long as the process does.
  deps.disposeRecorder(session.id);
  await Promise.all([
    deps.transcriptStore.deleteTranscript(session),
    deps.historyStore.deleteHistory(session),
  ]);
  // Subsystems that registered their own cleanup (pasted images, and
  // whatever comes next) rather than each appending a line here.
  deps.sessionTeardown?.dispose(session);
}

/**
 * Every chat conversation a user owns, most recently active first.
 *
 * The one definition of what a listable conversation is, so the resume list and
 * the full list cannot disagree about it. Three conditions, and each rules
 * something out that is not a conversation the user can open:
 *
 *   - not another user's, obviously.
 *   - not a terminal session, which has no transcript to come back to.
 *   - not a shell opened *inside* a conversation. It is a real session, but it is
 *     reached through the conversation that owns it and only there; a row of its
 *     own would offer a pty as though it were a chat.
 *
 * Sorting here rather than at each call site is what makes the grouping below
 * work: one order, read two ways.
 */
function chatRecords(deps: SessionRoutesDeps, userId: number): SessionRecord[] {
  return Array.from(deps.claudeSessions.values())
    .filter((session) => session.ownerUserId === userId)
    .filter((session) => session.surface === 'chat')
    .filter((session) => !session.ownerSessionId)
    .sort((a, b) => activityMs(b) - activityMs(a));
}

/** The exact tab-strip membership for one account, in its durable order. */
function orderedAccountTabs(
  sessions: Map<string, SessionRecord>,
  userId: number,
): SessionRecord[] {
  return Array.from(sessions.values())
    .filter((session) => session.ownerUserId === userId)
    .filter((session) => !session.ownerSessionId)
    // A closed conversation remains in the conversation list, not this strip.
    // Undefined is the pre-feature value and therefore still means open.
    .filter((session) => session.tabOpen !== false)
    .sort((left, right) => {
      const leftOrdered = Number.isFinite(left.tabOrder);
      const rightOrdered = Number.isFinite(right.tabOrder);
      // Legacy rows precede positions assigned to tabs created/reopened after
      // the upgrade. Returning zero preserves their Map order (and, after a
      // restart, SessionStore's created-at load order) exactly.
      if (!leftOrdered && !rightOrdered) return 0;
      if (!leftOrdered) return -1;
      if (!rightOrdered) return 1;
      return left.tabOrder! - right.tabOrder!;
    });
}

/** The append position for a new or genuinely reopened tab in this account. */
function nextAccountTabOrder(sessions: Map<string, SessionRecord>, userId: number): number {
  let maximum = -1;
  for (const session of sessions.values()) {
    if (session.ownerUserId !== userId || session.ownerSessionId || session.tabOpen === false) {
      continue;
    }
    if (Number.isFinite(session.tabOrder)) maximum = Math.max(maximum, session.tabOrder!);
  }
  return maximum + 1;
}

/**
 * Describe a run of conversations, a few logs at a time.
 *
 * The bounded concurrency is the whole point — see DESCRIBE_CONCURRENCY. A failed
 * read of one log costs that row its opening line and nothing else: a
 * conversation that cannot be described is still a conversation, and dropping it
 * from the list would be the one outcome the user cannot diagnose.
 */
async function describeAll(
  deps: SessionRoutesDeps,
  sessions: SessionRecord[],
): Promise<ConversationSummary[]> {
  const summaries: ConversationSummary[] = new Array(sessions.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const at = next++;
      if (at >= sessions.length) return;
      summaries[at] = await summarise(deps, sessions[at]);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(DESCRIBE_CONCURRENCY, sessions.length) }, worker),
  );
  return summaries;
}

/** One conversation, as every list of them describes it. */
async function summarise(
  deps: SessionRoutesDeps,
  session: SessionRecord,
): Promise<ConversationSummary> {
  const store = deps.chatStore;
  const ref = { id: session.id, ownerUserId: session.ownerUserId };
  const [stats, description] = await Promise.all([
    store?.stat(ref).catch(() => null) ?? null,
    store?.describe(ref).catch(() => null) ?? null,
  ]);

  return {
    id: session.id,
    name: displayName(session),
    runtime: session.lastAgent,
    runtimeLabel: session.runtimeLabel,
    lastActivity: new Date(activityMs(session)).toISOString(),
    workingDir: session.workingDir,
    projectId: session.projectId || null,
    projectName: session.projectId
      ? deps.projectsManager?.getForUser(session.ownerUserId, session.projectId)?.name || null
      : null,
    workingDirKind: session.projectId
      ? session.projectWorkingDirKind ?? 'host'
      : 'host',
    events: stats?.cursor ?? 0,
    firstMessage: description?.firstMessage ?? null,
    // The record first, then the log: the record is authoritative and the head
    // scan is the backfill for conversations that predate it.
    canResume: Boolean(session.nativeChatSessionId || description?.nativeSessionId),
    // Reported so the row can say which approval mode picking it will put back.
    // A restored bypass is a standing permission, and one that arrives silently
    // is no better than one that is silently dropped.
    bypassPermissions: session.chatBypassPermissions === true,
    // A conversation that is already running is not one to resume; the list says
    // so rather than offering an action that would be refused.
    running: session.active === true,
  };
}

/**
 * When a session was last active, in milliseconds.
 *
 * Tolerant of a string because the field crosses SQLite: `loadSessions` revives
 * it as a Date, but a record hand-built by a caller — or one revived by an older
 * build — can carry the ISO string it was stored as, and `.getTime()` on a string
 * is a TypeError that would take the whole listing down rather than one row's
 * timestamp.
 */
function activityMs(session: SessionRecord): number {
  const value = session.lastActivity as Date | string | undefined;
  const at = value instanceof Date ? value.getTime() : new Date(value ?? 0).getTime();
  return Number.isFinite(at) ? at : 0;
}

const EXPORT_PAGE_LINES = 500;
/** Long enough that ordinary fenced output inside the transcript cannot close it. */
const FENCE = '``````````';

function toPlainText(value: string): string {
  // Markdown is plain text, so the whole escape vocabulary goes.
  return stripAnsi(value)
    .replace(/\r\n?/g, '\n')
    // Shorten any run that could close the fence; 9 still renders as backticks.
    .replace(/`{10,}/g, '`````````');
}

/** What to call a session in front of the user: their name for it if they gave one. */
function displayName(session: SessionRecord): string {
  return session.customName || session.name;
}

/**
 * What a branch's tab is called.
 *
 * Named after where it came from, because that is the only thing that
 * distinguishes it from the conversation beside it in the strip: same folder,
 * same agent, same first thirty turns. Capped like any other stored name.
 */
function branchName(source: SessionRecord, turnIndex: number): string {
  return `${displayName(source)} — branch at turn ${turnIndex}`.slice(0, MAX_NAME_LENGTH);
}

function exportFileName(session: SessionRecord): string {
  const safe = displayName(session).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  const stamp = session.created.toISOString().slice(0, 10);
  return `${safe || 'session'}-${stamp}.md`;
}

function countUserSessions(
  sessions: Map<string, SessionRecord>,
  userId: number,
): number {
  let count = 0;
  for (const session of sessions.values()) {
    if (session.ownerUserId === userId) {
      count++;
    }
  }
  return count;
}
