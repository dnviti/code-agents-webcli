/**
 * Project lifecycle routes.
 *
 * Every endpoint is owner-scoped: asking for another user's project returns
 * the same 404 shape as asking for one that does not exist. Writes are also
 * same-origin, matching the deploy-targets and profiles routes.
 */

import { Request, Response, Router } from 'express';
import { EventEmitter } from 'node:events';
import { requireUser } from './helpers.js';
import type { AuthenticatedUser } from '../types.js';
import type { Project, RunningProjectInfo } from '../services/projects/store.js';
import type { UserEnvironment } from '../services/environments/types.js';

export type CreateResult =
  | { ok: true; project: Project; state: 'building' | 'running' }
  | { ok: false; reason: 'validation'; message: string }
  | { ok: false; reason: 'credential_required'; host: string }
  | { ok: false; reason: 'repo_unreachable'; message: string }
  | { ok: false; reason: 'run_limit'; project: Project; running: RunningProjectInfo[] };

export type StartResult =
  | { ok: true; state: 'building' | 'running' }
  | { ok: false; reason: 'not_found' | 'invalid_state' | 'blocked'; detail?: string }
  | { ok: false; reason: 'run_limit'; running: RunningProjectInfo[] };

export type SimpleResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'invalid_state' | 'preserve_failed'; detail?: string };

export type SessionEnvResult =
  | { ok: true; environment: UserEnvironment; workingDir: string }
  | { ok: false; reason: 'not_found' | 'run_limit' | 'failed' | 'building'; running?: RunningProjectInfo[]; detail?: string };

/**
 * Structural quote of the ProjectManager API pinned in the issue checklist.
 * S2 does not import services/projects/manager.js; integration passes the
 * real class and TypeScript's structural typing lines them up.
 */
export interface ProjectsRoutesManager {
  readonly events: EventEmitter;
  createAndStart(ownerUserId: number, input: { name: string; repoUrl?: string | null }): Promise<CreateResult>;
  start(ownerUserId: number, projectId: string, opts?: { stopProjectId?: string }): Promise<StartResult>;
  stop(ownerUserId: number, projectId: string): Promise<SimpleResult>;
  remove(ownerUserId: number, projectId: string, opts?: { force?: boolean }): Promise<SimpleResult>;
  release(ownerUserId: number, projectId: string, opts?: { discard?: boolean }): Promise<SimpleResult>;
  listForUser(ownerUserId: number): Array<Project & { hasActiveWork: boolean }>;
  getForUser(ownerUserId: number, projectId: string): Project | null;
  ensureForSession(ownerUserId: number, projectId: string): Promise<SessionEnvResult>;
  reconcileOnBoot(): Promise<void>;
  startSweep(): void;
  stopSweep(): void;
}

export interface ProjectsRoutesDeps {
  manager: ProjectsRoutesManager;
}

function isSameOrigin(req: Request): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function paramId(req: Request): string {
  return String(req.params.id);
}

function requireAuth(req: Request, res: Response, write: boolean): AuthenticatedUser | null {
  const user = requireUser(res);
  if (!user) {
    res.status(401).json({ error: 'authentication_required' });
    return null;
  }
  if (write && !isSameOrigin(req)) {
    res.status(403).json({ error: 'cross_origin' });
    return null;
  }
  return user;
}

function notFound(res: Response): void {
  res.status(404).json({ error: 'not_found', message: 'Project not found.' });
}

export function createProjectRoutes(deps: ProjectsRoutesDeps): Router {
  const router = Router();

  router.get('/api/projects', (req: Request, res: Response): void => {
    const user = requireAuth(req, res, false);
    if (!user) return;
    res.json({ projects: deps.manager.listForUser(user.id) });
  });

  router.post('/api/projects', async (req: Request, res: Response): Promise<void> => {
    const user = requireAuth(req, res, true);
    if (!user) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const repoUrl = body.repoUrl === undefined || body.repoUrl === null
      ? null
      : typeof body.repoUrl === 'string' ? body.repoUrl.trim() : undefined;

    if (!name) {
      res.status(400).json({ error: 'validation', message: 'name is required.' });
      return;
    }
    if (repoUrl === undefined) {
      res.status(400).json({ error: 'validation', message: 'repoUrl must be a string or omitted.' });
      return;
    }

    const result = await deps.manager.createAndStart(user.id, { name, repoUrl });
    if (!result.ok) {
      if (result.reason === 'credential_required') {
        res.status(428).json({ error: 'credential_required', host: result.host });
        return;
      }
      if (result.reason === 'run_limit') {
        res.status(409).json({ error: 'run_limit', running: result.running });
        return;
      }
      res.status(400).json({ error: result.reason, message: result.message });
      return;
    }

    res.status(202).json({ project: result.project });
  });

  router.get('/api/projects/:id', (req: Request, res: Response): void => {
    const user = requireAuth(req, res, false);
    if (!user) return;

    const project = deps.manager.getForUser(user.id, paramId(req));
    if (!project) {
      notFound(res);
      return;
    }
    res.json({ project });
  });

  router.delete('/api/projects/:id', async (req: Request, res: Response): Promise<void> => {
    const user = requireAuth(req, res, true);
    if (!user) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const force = body.force === true;
    const result = await deps.manager.remove(user.id, paramId(req), { force });
    if (!result.ok) {
      if (result.reason === 'not_found') {
        notFound(res);
        return;
      }
      if (result.reason === 'preserve_failed') {
        res.status(409).json({ error: 'preserve_failed', detail: result.detail });
        return;
      }
      res.status(400).json({ error: result.reason, detail: result.detail });
      return;
    }

    res.status(204).send();
  });

  router.post('/api/projects/:id/start', async (req: Request, res: Response): Promise<void> => {
    const user = requireAuth(req, res, true);
    if (!user) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const stopProjectId = typeof body.stopProjectId === 'string' ? body.stopProjectId : undefined;
    const result = await deps.manager.start(user.id, paramId(req), { stopProjectId });
    if (!result.ok) {
      if (result.reason === 'not_found') {
        notFound(res);
        return;
      }
      if (result.reason === 'run_limit') {
        res.status(409).json({ error: 'run_limit', running: result.running });
        return;
      }
      if (result.reason === 'blocked') {
        res.status(409).json({ error: 'blocked', detail: result.detail });
        return;
      }
      res.status(400).json({ error: result.reason, detail: result.detail });
      return;
    }

    res.status(202).json({ state: result.state });
  });

  router.post('/api/projects/:id/stop', async (req: Request, res: Response): Promise<void> => {
    const user = requireAuth(req, res, true);
    if (!user) return;

    const result = await deps.manager.stop(user.id, paramId(req));
    if (!result.ok) {
      if (result.reason === 'not_found') {
        notFound(res);
        return;
      }
      res.status(400).json({ error: result.reason, detail: result.detail });
      return;
    }

    res.status(202).json({ ok: true });
  });

  router.post('/api/projects/:id/release', async (req: Request, res: Response): Promise<void> => {
    const user = requireAuth(req, res, true);
    if (!user) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const discard = body.discard === true;
    const result = await deps.manager.release(user.id, paramId(req), { discard });
    if (!result.ok) {
      if (result.reason === 'not_found') {
        notFound(res);
        return;
      }
      res.status(400).json({ error: result.reason, detail: result.detail });
      return;
    }

    res.status(202).json({ ok: true });
  });

  router.get('/api/projects/:id/build', (req: Request, res: Response): void => {
    const user = requireAuth(req, res, false);
    if (!user) return;

    const projectId = paramId(req);
    const project = deps.manager.getForUser(user.id, projectId);
    if (!project) {
      notFound(res);
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (event: unknown): void => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // Replay the persisted build log first.
    for (const event of project.buildLog) {
      send(event);
    }

    const onBuild = (payload: { projectId: string; event: unknown }): void => {
      if (payload.projectId !== projectId) return;
      send(payload.event);

      // A state event that reaches a terminal state means the stream can end
      // soon; give the client a moment to read the frame.
      const terminalStates = ['stopped', 'failed', 'unavailable', 'blocked'];
      const state = (payload.event as Record<string, unknown> | undefined)?.state;
      if (typeof state === 'string' && terminalStates.includes(state)) {
        setTimeout(() => {
          cleanup();
          res.end();
        }, 1000).unref();
      }
    };

    deps.manager.events.on('build', onBuild);

    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 15000);

    const cleanup = (): void => {
      deps.manager.events.off('build', onBuild);
      clearInterval(heartbeat);
    };

    req.on('close', () => {
      cleanup();
      res.end();
    });
  });

  return router;
}
