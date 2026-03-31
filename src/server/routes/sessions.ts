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
    void deps.transcriptStore.deleteTranscript(session);
    void deps.saveSessionsToDisk();

    res.json({ success: true, message: 'Session deleted' });
  });

  return router;
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
