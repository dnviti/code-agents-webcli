import { Router, Request, Response } from 'express';
import { SessionRecord, Aliases, WebSocketInfo, AuthContext } from '../types.js';
import { UserPreferences } from '../../shared/user-preferences.js';

export interface HealthRoutesDeps {
  claudeSessions: Map<string, SessionRecord>;
  webSocketConnections: Map<string, WebSocketInfo>;
  folderMode: boolean;
  baseFolder: string;
  aliases: Aliases;
  /** Whether containerized environments and deploy-target administration are exposed. */
  containerizedEnvironmentsEnabled: boolean;
  getSelectedWorkingDir(userId: number): string | null;
  getUserPreferences(userId: number): UserPreferences;
}

export function createHealthRoutes(deps: HealthRoutesDeps): Router {
  const router = Router();

  router.get('/api/health', (_req: Request, res: Response): void => {
    const authContext = (res.locals.authContext as AuthContext | undefined) || {
      user: null,
      authSessionId: null,
    };

    // Stay usable as an unauthenticated liveness probe, but only disclose
    // session and connection counts to a signed-in user.
    if (!authContext.user) {
      res.json({ status: 'ok' });
      return;
    }

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
      containerizedEnvironmentsEnabled: deps.containerizedEnvironmentsEnabled,
      currentUser: authContext.user,
      logoutUrl: '/auth/logout',
      // On the boot request rather than a second one of its own, so the first
      // paint of the launcher already knows which mode its chat button is about
      // to produce. A preference fetched afterwards would leave an interval in
      // which the control states the opposite of what it does.
      preferences: deps.getUserPreferences(authContext.user.id),
    });
  });

  return router;
}
