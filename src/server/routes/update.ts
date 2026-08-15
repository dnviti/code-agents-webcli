import { Router, Request, Response } from 'express';
import { SessionRecord } from '../types.js';
import { UpdateStatus } from '../services/release/update-check.js';
import { UpdateMode, canTriggerUpdate } from '../services/release/self-update.js';
import { requireUser } from './helpers.js';

export interface UpdateRoutesDeps {
  claudeSessions: Map<string, SessionRecord>;
  updateChecker: {
    getStatus(): UpdateStatus;
    check(force: boolean): Promise<UpdateStatus>;
  };
  selfUpdate: {
    isRunning(): boolean;
    getState(): 'idle' | 'running' | 'restarting';
    getLogTail(): string[];
    apply(mode: UpdateMode, packageDir: string | null, targetSha: string | null): Promise<void>;
  };
  getUpdateMode(): { mode: UpdateMode; packageDir: string | null };
  getInstallerUserId(): number | null;
  /** Set when a previous update was cut short; cleared once reported. */
  getInterruptedUpdate(): { startedAt: number; targetSha: string | null } | null;
}

function countActiveSessions(sessions: Map<string, SessionRecord>): number {
  let count = 0;
  for (const session of sessions.values()) {
    if (session.active) {
      count++;
    }
  }
  return count;
}

export function createUpdateRoutes(deps: UpdateRoutesDeps): Router {
  const router = Router();

  router.get('/api/update/status', (_req: Request, res: Response): void => {
    const user = requireUser(res);
    if (!user) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }

    const { mode } = deps.getUpdateMode();
    const installerUserId = deps.getInstallerUserId();
    const isInstaller = installerUserId !== null && user.id === installerUserId;

    res.json({
      status: deps.updateChecker.getStatus(),
      mode,
      canTrigger: isInstaller && canTriggerUpdate(mode),
      isInstaller,
      running: deps.selfUpdate.isRunning(),
      runnerState: deps.selfUpdate.getState(),
      activeSessions: countActiveSessions(deps.claudeSessions),
      interrupted: deps.getInterruptedUpdate(),
      // npm output carries absolute paths and toolchain detail. The installer
      // can already open a shell as this same uid, so it is no new disclosure
      // to them — but it is to everyone else.
      logTail: isInstaller ? deps.selfUpdate.getLogTail() : [],
    });
  });

  router.post('/api/update/check', async (_req: Request, res: Response): Promise<void> => {
    const user = requireUser(res);
    if (!user) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }

    // Any signed-in user may ask, but the checker's own interval floor decides
    // whether that turns into an outbound request.
    const status = await deps.updateChecker.check(true);
    res.json({ status });
  });

  router.post('/api/update/apply', async (req: Request, res: Response): Promise<void> => {
    const user = requireUser(res);
    if (!user) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }

    const installerUserId = deps.getInstallerUserId();
    if (installerUserId === null || user.id !== installerUserId) {
      // 403 rather than 404: this resource is global and its existence is
      // already disclosed by GET /api/update/status, so hiding it would only
      // make the refusal harder to debug.
      res.status(403).json({ error: 'not_installer' });
      return;
    }

    const { mode, packageDir } = deps.getUpdateMode();
    if (!canTriggerUpdate(mode)) {
      res.status(409).json({ error: `${mode}_install`, mode });
      return;
    }

    if (deps.selfUpdate.isRunning()) {
      res.status(409).json({ error: 'update_in_progress' });
      return;
    }

    const status = deps.updateChecker.getStatus();
    if (status.state !== 'behind') {
      res.status(409).json({ error: 'nothing_to_update', state: status.state });
      return;
    }

    // Restarting SIGTERMs every agent PTY on the host, including other users'.
    // The same courtesy the installer wizard already extends before restarting.
    const body = (req.body ?? {}) as { confirmed?: unknown };
    if (body.confirmed !== true) {
      res.status(409).json({
        error: 'confirmation_required',
        activeSessions: countActiveSessions(deps.claudeSessions),
      });
      return;
    }

    // Fire and forget: the work outlives this request, and progress arrives
    // over the WebSocket.
    void deps.selfUpdate.apply(mode, packageDir, status.remote.sha).catch((error: unknown) => {
      console.error('Self-update failed:', error);
    });

    res.status(202).json({ started: true });
  });

  return router;
}
