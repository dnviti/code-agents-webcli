import { Router, Request, Response } from 'express';
import { SessionRecord, Aliases, WebSocketInfo, AuthContext } from '../types.js';

export interface HealthRoutesDeps {
  claudeSessions: Map<string, SessionRecord>;
  webSocketConnections: Map<string, WebSocketInfo>;
  folderMode: boolean;
  baseFolder: string;
  aliases: Aliases;
  getSelectedWorkingDir(userId: number): string | null;
}

export function createHealthRoutes(deps: HealthRoutesDeps): Router {
  const router = Router();

  router.get('/api/health', (_req: Request, res: Response): void => {
    res.json({
      status: 'ok',
      claudeSessions: deps.claudeSessions.size,
      activeConnections: deps.webSocketConnections.size,
    });
  });

  router.get('/api/config', (_req: Request, res: Response): void => {
    const authContext = (res.locals.authContext as AuthContext | undefined) || {
      user: null,
      authSessionId: null,
    };

    if (!authContext.user) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }

    res.json({
      folderMode: deps.folderMode,
      selectedWorkingDir: deps.getSelectedWorkingDir(authContext.user.id),
      baseFolder: deps.baseFolder,
      aliases: deps.aliases,
      currentUser: authContext.user,
      logoutUrl: '/auth/logout',
    });
  });

  return router;
}
