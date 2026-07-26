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
import { getOwnedSession, requireUser } from './helpers.js';

/**
 * How many past conversations one folder offers.
 *
 * A list to choose from, not an archive to browse: past this many the useful
 * one is not findable by scrolling anyway, and every entry costs a read.
 */
const MAX_RESUMABLE = 25;

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

    const candidates = Array.from(deps.claudeSessions.values())
      .filter((session) => session.ownerUserId === user.id)
      .filter((session) => session.surface === 'chat')
      .filter((session) => session.workingDir === validation.path)
      .sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime())
      .slice(0, MAX_RESUMABLE);

    const store = deps.chatStore;
    const conversations = await Promise.all(
      candidates.map(async (session) => {
        const ref = { id: session.id, ownerUserId: session.ownerUserId };
        const [stats, description] = await Promise.all([
          store?.stat(ref).catch(() => null) ?? null,
          store?.describe(ref).catch(() => null) ?? null,
        ]);

        return {
          id: session.id,
          name: session.name,
          runtime: session.lastAgent,
          runtimeLabel: session.runtimeLabel,
          lastActivity: session.lastActivity.toISOString(),
          workingDir: session.workingDir,
          events: stats?.cursor ?? 0,
          firstMessage: description?.firstMessage ?? null,
          // The record first, then the log: the record is authoritative and the
          // head scan is the backfill for conversations that predate it.
          canResume: Boolean(session.nativeChatSessionId || description?.nativeSessionId),
          // A conversation that is already running is not one to resume; the
          // list says so rather than offering an action that would be refused.
          running: session.active === true,
        };
      }),
    );

    res.json({
      dir: validation.path,
      conversations: conversations.filter((entry) => entry.events > 0),
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
      }));

    res.json({ sessions: sessionList });
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

      res.write(`# ${session.name}\n\n`);
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

function exportFileName(session: SessionRecord): string {
  const safe = session.name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
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
