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

  router.get('/api/sessions/list', (_req: Request, res: Response): void => {
    const user = requireUser(res);
    if (!user) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }

    const sessionList: SessionListItem[] = Array.from(deps.claudeSessions.entries())
      .filter(([, session]) => session.ownerUserId === user.id)
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
      }));

    res.json({ sessions: sessionList });
  });

  router.post('/api/sessions/create', (req: Request, res: Response): void => {
    const user = requireUser(res);
    if (!user) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }

    const { name, workingDir } = req.body;
    const sessionId = randomUUID();

    // The name is bound into a SQLite statement on every autosave. A non-string
    // makes better-sqlite3 throw inside the replaceAll transaction, which runs
    // after a DELETE, so one bad value would wipe every user's persisted
    // sessions on the next save.
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

    if (session.active && session.agent) {
      const bridge = deps.getRuntimeBridge(session.agent);
      if (bridge) {
        void bridge.stopSession(sessionId);
      }
    }

    session.connections.forEach((wsId) => {
      const wsInfo = deps.webSocketConnections.get(wsId);
      if (wsInfo && wsInfo.ws.readyState === WebSocket.OPEN) {
        wsInfo.claudeSessionId = null;
        wsInfo.ws.send(
          JSON.stringify({
            type: 'session_deleted',
            sessionId,
            message: 'Session has been deleted',
          }),
        );
      }
    });

    session.connections.clear();
    deps.claudeSessions.delete(sessionId);
    // Without this the headless emulator for a deleted session would live for
    // as long as the process does.
    deps.disposeRecorder(sessionId);
    void deps.transcriptStore.deleteTranscript(session);
    void deps.historyStore.deleteHistory(session);
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
      res.write(`- Creata: ${session.created.toISOString()}\n`);
      res.write(`- Ultima attività: ${session.lastActivity.toISOString()}\n\n`);
      res.write(`${FENCE}\n`);

      try {
        const { firstLine, totalLines } = await deps.historyStore.stat(session);
        if (firstLine > 0) {
          res.write(`[... ${firstLine} righe precedenti non più conservate ...]\n`);
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
        res.write('\n[... esportazione interrotta da un errore ...]\n');
      }

      res.write(`${FENCE}\n`);
      res.end();
    },
  );

  return router;
}

const EXPORT_PAGE_LINES = 500;
/** Long enough that ordinary fenced output inside the transcript cannot close it. */
const FENCE = '``````````';

// CSI/OSC and the rest of the escape vocabulary a PTY emits. Markdown is plain
// text, so all of it goes.
const ANSI_PATTERN =
  // CSI (colours, cursor moves, including colon-separated and private
  // parameters), OSC and the other string-terminated escapes with their whole
  // body, single-character escapes, and stray control bytes. Tab, LF and CR
  // are deliberately left in.
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b[P^_X][^\x07\x1b]*(?:\x07|\x1b\\|$)|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)|\x1b[ -/]*[0-~]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

function toPlainText(value: string): string {
  return value
    .replace(ANSI_PATTERN, '')
    .replace(/\r\n?/g, '\n')
    // Shorten any run that could close the fence; 9 still renders as backticks.
    .replace(/`{10,}/g, '`````````');
}

function exportFileName(session: SessionRecord): string {
  const safe = session.name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  const stamp = session.created.toISOString().slice(0, 10);
  return `${safe || 'sessione'}-${stamp}.md`;
}

function requireUser(res: Response): AuthenticatedUser | null {
  const authContext = (res.locals.authContext as AuthContext | undefined) || {
    user: null,
    authSessionId: null,
  };
  return authContext.user;
}

function getOwnedSession(
  sessions: Map<string, SessionRecord>,
  sessionId: string,
  user: AuthenticatedUser,
): SessionRecord | null {
  const session = sessions.get(sessionId);
  if (!session || session.ownerUserId !== user.id) {
    return null;
  }

  return session;
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
