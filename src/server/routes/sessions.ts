import { Router, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
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

export interface SessionRoutesDeps {
  claudeSessions: Map<string, SessionRecord>;
  webSocketConnections: Map<string, WebSocketInfo>;
  baseFolder: string;
  dev: boolean;
  validatePath(targetPath: string): PathValidation;
  createSessionRecord(params: {
    id: string;
    ownerUserId: number;
    name?: string;
    workingDir: string;
    connections?: string[];
    ownerSessionId?: string;
  }): SessionRecord;
  getRuntimeBridge(agentKind: AgentKind): BridgeInterface | null;
  saveSessionsToDisk(): Promise<void>;
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
  };
  /**
   * Optional so the hand-built deps literals in the existing tests keep
   * compiling; the server always supplies one.
   */
  sessionTeardown?: SessionTeardownLike;
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

    // The same check every other path in this app goes through. A directory
    // that fails it cannot have had a session in it anyway, so this is about
    // refusing to answer questions about the rest of the disk.
    const validation = deps.validatePath(requested);
    if (!validation.valid || !validation.path) {
      res.status(403).json({ error: 'That folder is outside the allowed base' });
      return;
    }

    const candidates = chatRecords(deps, user.id)
      .filter((session) => session.workingDir === validation.path)
      .slice(0, MAX_RESUMABLE);

    const conversations = await describeAll(deps, candidates);

    res.json({
      dir: validation.path,
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
      const existing = groups.get(conversation.workingDir);
      if (existing) {
        existing.conversations.push(conversation);
        continue;
      }
      groups.set(conversation.workingDir, {
        dir: conversation.workingDir,
        name: projectName(conversation.workingDir),
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
  router.get('/api/sessions/list', (_req: Request, res: Response): void => {
    const user = requireUser(res);
    if (!user) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }

    const sessionList: SessionListItem[] = Array.from(deps.claudeSessions.entries())
      .filter(([, session]) => session.ownerUserId === user.id)
      .filter(([, session]) => !session.ownerSessionId)
      .map(([id, session]) => ({
        id,
        name: session.name,
        created: session.created,
        active: session.active,
        agent: session.agent,
        lastAgent: session.lastAgent,
        runtimeLabel: session.runtimeLabel,
        workingDir: session.workingDir,
        connectedClients: session.connections.size,
        lastActivity: session.lastActivity,
        surface: session.surface || 'terminal',
        customName: session.customName,
      }));

    res.json({ sessions: sessionList });
  });

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

  router.post('/api/sessions/create', (req: Request, res: Response): void => {
    const user = requireUser(res);
    if (!user) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }

    const { name, workingDir, ownerSessionId } = req.body;
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

    // A session can declare that it belongs to a conversation, which is what
    // keeps it out of the listings and ties its lifetime to that conversation's.
    // Only a conversation this user owns will do: accepting an arbitrary id
    // would let one request hide a session from its own owner's tab strip, or
    // attach it to somebody else's teardown.
    let owner: string | undefined;
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
      owner = parent.id;
    }

    let validWorkingDir = deps.baseFolder;
    if (workingDir) {
      const validation = deps.validatePath(workingDir);
      if (!validation.valid) {
        res.status(403).json({
          error: validation.error,
          message: 'Cannot create session with working directory outside the allowed area',
        });
        return;
      }
      validWorkingDir = validation.path!;
    } else {
      validWorkingDir = deps.getSelectedWorkingDir(user.id) || deps.baseFolder;
    }

    const session = deps.createSessionRecord({
      id: sessionId,
      ownerUserId: user.id,
      name,
      workingDir: validWorkingDir,
      ownerSessionId: owner,
    });

    deps.claudeSessions.set(sessionId, session);
    void deps.transcriptStore.ensureTranscript(session);
    void deps.saveSessionsToDisk();

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
        lastAgent: session.lastAgent,
        runtimeLabel: session.runtimeLabel,
      },
    });
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
      // that model's. The bypass flag deliberately does not: it is a standing
      // permission granted to the conversation that asked for it, and a
      // conversation that inherited one would be acting without being asked on
      // the strength of somebody else's answer.
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

      deps.claudeSessions.set(sessionId, branch);
      void deps.transcriptStore.ensureTranscript(branch);
      void deps.saveSessionsToDisk();

      res.json({
        success: true,
        sessionId,
        name: branch.name,
        workingDir: branch.workingDir,
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
      connectedClients: session.connections.size,
      lastActivity: session.lastActivity,
    });
  });

  router.delete('/api/sessions/:sessionId', (req: Request, res: Response): void => {
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

    // The conversation's own shells go with it. They are only reachable through
    // it, so a conversation deleted without them would leave ptys running that
    // nothing in the app — no tab, no listing, no pane — can ever reach again.
    for (const owned of deps.claudeSessions.values()) {
      if (owned.ownerSessionId === sessionId) {
        destroySession(deps, owned);
      }
    }

    destroySession(deps, session);
    void deps.saveSessionsToDisk();

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

/**
 * End one session: its process, its sockets, its record and everything stored
 * for it.
 *
 * Its own function because a delete is no longer one session — a conversation
 * takes the shells opened inside it with it — and doing that inline would mean
 * two copies of a teardown where a missed line leaks a pty.
 *
 * Not responsible for persisting the map: the caller saves once for the whole
 * cascade rather than once per session torn down.
 */
function destroySession(deps: SessionRoutesDeps, session: SessionRecord): void {
  if (session.active && session.agent) {
    const bridge = deps.getRuntimeBridge(session.agent);
    if (bridge) {
      void bridge.stopSession(session.id);
    }
  }

  session.connections.forEach((wsId) => {
    const wsInfo = deps.webSocketConnections.get(wsId);
    if (wsInfo && wsInfo.ws.readyState === WebSocket.OPEN) {
      wsInfo.claudeSessionId = null;
      wsInfo.ws.send(
        JSON.stringify({
          type: 'session_deleted',
          sessionId: session.id,
          message: 'Session has been deleted',
        }),
      );
    }
  });

  session.connections.clear();
  deps.claudeSessions.delete(session.id);
  // Without this the headless emulator for a deleted session would live for
  // as long as the process does.
  deps.disposeRecorder(session.id);
  void deps.transcriptStore.deleteTranscript(session);
  void deps.historyStore.deleteHistory(session);
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
