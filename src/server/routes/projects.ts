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
import { getCompositionCatalog } from '../services/composition/catalog.js';
import type {
  CompositionConfirmResult,
  CompositionCreateResult,
  CompositionReadResult,
  CompositionRetryResult,
  CompositionSaveResult,
} from '../services/projects/manager.js';

export type CreateResult =
  | { ok: true; project: Project; state: 'building' | 'running' }
  | { ok: false; reason: 'validation'; message: string }
  | { ok: false; reason: 'no_target'; message: string }
  | { ok: false; reason: 'shutting_down'; message: string }
  | { ok: false; reason: 'credential_required'; host: string }
  | { ok: false; reason: 'repo_unreachable'; message: string }
  | { ok: false; reason: 'run_limit'; project: Project; running: RunningProjectInfo[] };

export type StartResult =
  | { ok: true; state: 'building' | 'running' }
  | { ok: false; reason: 'not_found' | 'conflict' | 'invalid_state' | 'blocked' | 'shutting_down'; detail?: string }
  | { ok: false; reason: 'run_limit'; running: RunningProjectInfo[] };

export type SimpleResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'invalid_state' | 'preserve_failed' | 'shutting_down'; detail?: string };

export type UpdateResult =
  | { ok: true; project: Project }
  | { ok: false; reason: 'not_found' | 'invalid_state' | 'preserve_failed' | 'shutting_down'; detail?: string }
  | { ok: false; reason: 'validation'; message: string }
  | { ok: false; reason: 'credential_required'; host: string }
  | { ok: false; reason: 'repo_unreachable'; message: string };

export type SessionEnvResult =
  | { ok: true; environment: UserEnvironment; workingDir: string }
  | { ok: false; reason: 'not_found' | 'run_limit' | 'failed' | 'building' | 'shutting_down'; running?: RunningProjectInfo[]; detail?: string };

/**
 * Structural quote of the ProjectManager API pinned in the issue checklist.
 * S2 does not import services/projects/manager.js; integration passes the
 * real class and TypeScript's structural typing lines them up.
 */
export interface ProjectsRoutesManager {
  readonly events: EventEmitter;
  createAndStart(ownerUserId: number, input: { name: string; repoUrl?: string | null; local?: boolean }): Promise<CreateResult>;
  createForComposition?(ownerUserId: number, input: { name: string; repoUrl?: string | null; local?: boolean }): Promise<CompositionCreateResult>;
  getComposition?(ownerUserId: number, projectId: string): CompositionReadResult;
  saveComposition?(ownerUserId: number, projectId: string, input: { expectedRevision: string | null; runtimes: Array<{ runtimeId: string; version: string }>; agents?: Array<{ runtimeId: string; version: string }>; forgeKind?: string | null }): Promise<CompositionSaveResult>;
  confirmComposition?(ownerUserId: number, projectId: string, input: { revision: string; expectedRevision: string | null; acknowledgeRebuild: boolean; stopProjectId?: string }): Promise<CompositionConfirmResult>;
  retryComposition?(ownerUserId: number, projectId: string): Promise<CompositionRetryResult>;
  reinspectComposition?(ownerUserId: number, projectId: string): Promise<CompositionReadResult> | CompositionReadResult;
  start(ownerUserId: number, projectId: string, opts?: { stopProjectId?: string }): Promise<StartResult>;
  stop(ownerUserId: number, projectId: string, opts?: { stopActive?: boolean }): Promise<SimpleResult>;
  retry(ownerUserId: number, projectId: string): Promise<StartResult>;
  update(ownerUserId: number, projectId: string, input: { name?: string; repoUrl?: string | null }): Promise<UpdateResult>;
  remove(ownerUserId: number, projectId: string, opts?: { force?: boolean; stopActive?: boolean }): Promise<SimpleResult>;
  release(ownerUserId: number, projectId: string, opts?: { discard?: boolean }): Promise<SimpleResult>;
  listForUser(ownerUserId: number): Array<Project & { hasActiveWork: boolean; targetName?: string | null }>;
  getForUser(ownerUserId: number, projectId: string): Project | null;
  ensureForSession(ownerUserId: number, projectId: string): Promise<SessionEnvResult>;
  reconcileOnBoot(): Promise<void>;
  startSweep(): void;
  stopSweep(): void;
}

export interface ProjectsRoutesDeps {
  manager: ProjectsRoutesManager;
  /** Human-readable placement without exposing target connection details. */
  targetNameFor?(project: Project): string | null;
  projectAvailability?(): {
    available: boolean;
    message?: string;
    /** Placement used when a create does not explicitly request local mode. */
    defaultExecutionKind?: 'host' | 'container';
  };
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

function shuttingDown(res: Response, detail?: string): void {
  res.status(503).json({
    error: 'shutting_down',
    message: detail || 'Project service is shutting down.',
  });
}

function projectView(deps: ProjectsRoutesDeps, project: Project): Project & { targetName: string | null } {
  return {
    ...project,
    // listForUser already enriches the real manager's rows. Detail/create
    // responses carry plain Project rows and use the callback instead.
    targetName: 'targetName' in project && project.targetName !== undefined
      ? project.targetName as string | null
      : deps.targetNameFor?.(project) ?? null,
  };
}

export function createProjectRoutes(deps: ProjectsRoutesDeps): Router {
  const router = Router();

  router.get('/api/projects', (req: Request, res: Response): void => {
    const user = requireAuth(req, res, false);
    if (!user) return;
    res.json({
      projects: deps.manager.listForUser(user.id).map((project) => projectView(deps, project)),
      availability: deps.projectAvailability?.() ?? { available: true },
    });
  });

  router.post('/api/projects', async (req: Request, res: Response): Promise<void> => {
    const user = requireAuth(req, res, true);
    if (!user) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const repoUrl = body.repoUrl === undefined || body.repoUrl === null
      ? null
      : typeof body.repoUrl === 'string' ? body.repoUrl.trim() : undefined;
    const local = body.local === undefined ? false : body.local;

    if (!name) {
      res.status(400).json({ error: 'validation', message: 'name is required.' });
      return;
    }
    if (repoUrl === undefined) {
      res.status(400).json({ error: 'validation', message: 'repoUrl must be a string or omitted.' });
      return;
    }
    if (typeof local !== 'boolean') {
      res.status(400).json({ error: 'validation', message: 'local must be a boolean or omitted.' });
      return;
    }

    const result = deps.manager.createForComposition
      ? await deps.manager.createForComposition(user.id, { name, repoUrl, local })
      : await deps.manager.createAndStart(user.id, { name, repoUrl, local });
    if (!result.ok) {
      if (result.reason === 'shutting_down') {
        shuttingDown(res, result.message);
        return;
      }
      if (result.reason === 'credential_required') {
        res.status(428).json({ error: 'credential_required', host: result.host });
        return;
      }
      if (result.reason === 'run_limit') {
        // Creation itself is unlimited. The manager has already recorded the
        // stopped project, so return it and let the client complete the swap
        // through the ordinary, transactional start endpoint. Retrying create
        // would leave a duplicate project behind on every confirmation.
        res.status(409).json({
          error: 'run_limit',
          project: projectView(deps, result.project),
          running: result.running,
        });
        return;
      }
      if (result.reason === 'no_target') {
        res.status(409).json({ error: 'no_target', message: result.message });
        return;
      }
      res.status(400).json({ error: result.reason, message: result.message });
      return;
    }

    res.status(202).json({ project: projectView(deps, result.project) });
  });

  router.get('/api/projects/:id', (req: Request, res: Response): void => {
    const user = requireAuth(req, res, false);
    if (!user) return;

    const project = deps.manager.getForUser(user.id, paramId(req));
    if (!project) {
      notFound(res);
      return;
    }
    res.json({ project: projectView(deps, project) });
  });

  router.get('/api/projects/:id/composition', (req: Request, res: Response): void => {
    const user = requireAuth(req, res, false);
    if (!user) return;
    if (!deps.manager.getComposition) {
      res.status(503).json({ error: 'composition_unavailable' });
      return;
    }
    const result = deps.manager.getComposition(user.id, paramId(req));
    if (!result.ok) {
      notFound(res);
      return;
    }
    res.json({
      catalog: getCompositionCatalog(),
      project: projectView(deps, result.project),
      composition: result.composition,
    });
  });

  router.put('/api/projects/:id/composition', async (req: Request, res: Response): Promise<void> => {
    const user = requireAuth(req, res, true);
    if (!user) return;
    if (!deps.manager.saveComposition) {
      res.status(503).json({ error: 'composition_unavailable' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const expectedRevision = body.expectedCurrentRevision === null || typeof body.expectedCurrentRevision === 'string'
      ? body.expectedCurrentRevision
      : undefined;
    if (expectedRevision === undefined || !Array.isArray(body.runtimes)) {
      res.status(400).json({ error: 'validation', message: 'expectedCurrentRevision and runtimes are required.' });
      return;
    }
    const runtimes: Array<{ runtimeId: string; version: string }> = [];
    for (const item of body.runtimes) {
      if (!item || typeof item !== 'object') {
        res.status(400).json({ error: 'validation', message: 'Each runtime must have an id and version.' });
        return;
      }
      const runtime = item as Record<string, unknown>;
      if (typeof runtime.runtimeId !== 'string' || typeof runtime.version !== 'string') {
        res.status(400).json({ error: 'validation', message: 'Each runtime must have an id and version.' });
        return;
      }
      runtimes.push({ runtimeId: runtime.runtimeId, version: runtime.version });
    }
    const agents: Array<{ runtimeId: string; version: string }> = [];
    if (body.agents !== undefined && !Array.isArray(body.agents)) {
      res.status(400).json({ error: 'validation', message: 'agents must be an array.' });
      return;
    }
    for (const item of (body.agents as unknown[] | undefined) || []) {
      if (!item || typeof item !== 'object') {
        res.status(400).json({ error: 'validation', message: 'Each agent runtime must have an id and version.' });
        return;
      }
      const agent = item as Record<string, unknown>;
      if (typeof agent.runtimeId !== 'string' || typeof agent.version !== 'string') {
        res.status(400).json({ error: 'validation', message: 'Each agent runtime must have an id and version.' });
        return;
      }
      agents.push({ runtimeId: agent.runtimeId, version: agent.version });
    }
    if (body.forgeKind !== undefined && body.forgeKind !== null && typeof body.forgeKind !== 'string') {
      res.status(400).json({ error: 'validation', message: 'forgeKind must be a string or null.' });
      return;
    }
    const result = await deps.manager.saveComposition(user.id, paramId(req), {
      expectedRevision,
      runtimes,
      ...(body.agents !== undefined ? { agents } : {}),
      ...(body.forgeKind !== undefined ? { forgeKind: body.forgeKind as string | null } : {}),
    });
    if (!result.ok) {
      if (result.reason === 'not_found') return notFound(res);
      res.status(result.reason === 'conflict' || result.reason === 'invalid_state' ? 409 : 400).json({
        error: result.reason,
        message: result.detail,
      });
      return;
    }
    res.json({ composition: result.composition });
  });

  router.post('/api/projects/:id/composition/confirm', async (req: Request, res: Response): Promise<void> => {
    const user = requireAuth(req, res, true);
    if (!user) return;
    if (!deps.manager.confirmComposition) {
      res.status(503).json({ error: 'composition_unavailable' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.revision !== 'string'
      || (body.expectedRevision !== null && typeof body.expectedRevision !== 'string')
      || typeof body.acknowledgeRebuild !== 'boolean'
      || (body.stopProjectId !== undefined && typeof body.stopProjectId !== 'string')) {
      res.status(400).json({ error: 'validation', message: 'revision, expectedRevision and acknowledgeRebuild are required.' });
      return;
    }
    const result = await deps.manager.confirmComposition(user.id, paramId(req), {
      revision: body.revision,
      expectedRevision: body.expectedRevision as string | null,
      acknowledgeRebuild: body.acknowledgeRebuild,
      ...(typeof body.stopProjectId === 'string' ? { stopProjectId: body.stopProjectId } : {}),
    });
    if (!result.ok) {
      if (result.reason === 'not_found') return notFound(res);
      if (result.reason === 'shutting_down') return shuttingDown(res, result.detail);
      if (result.reason === 'run_limit') {
        res.status(409).json({ error: 'run_limit', running: result.running });
        return;
      }
      res.status(result.reason === 'identity_required' ? 422 : 409).json({
        error: result.reason,
        message: result.detail,
        ...('composition' in result && result.composition ? { composition: result.composition } : {}),
      });
      return;
    }
    res.status(202).json({ state: result.state });
  });

  router.post('/api/projects/:id/composition/retry', async (req: Request, res: Response): Promise<void> => {
    const user = requireAuth(req, res, true);
    if (!user) return;
    if (!deps.manager.retryComposition) {
      res.status(503).json({ error: 'composition_unavailable' });
      return;
    }
    const result = await deps.manager.retryComposition(user.id, paramId(req));
    if (!result.ok) {
      if (result.reason === 'not_found') return notFound(res);
      if (result.reason === 'shutting_down') return shuttingDown(res, result.detail);
      res.status(409).json({ error: result.reason, message: result.detail });
      return;
    }
    res.status(202).json({ installations: result.installations });
  });

  router.post('/api/projects/:id/composition/inspect', async (req: Request, res: Response): Promise<void> => {
    const user = requireAuth(req, res, true);
    if (!user) return;
    if (!deps.manager.reinspectComposition) {
      res.status(503).json({ error: 'composition_unavailable' });
      return;
    }
    const result = await deps.manager.reinspectComposition(user.id, paramId(req));
    if (!result.ok) {
      notFound(res);
      return;
    }
    res.status(202).json({ project: projectView(deps, result.project), composition: result.composition });
  });

  router.put('/api/projects/:id', async (req: Request, res: Response): Promise<void> => {
    const user = requireAuth(req, res, true);
    if (!user) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.name === undefined && body.repoUrl === undefined) {
      res.status(400).json({ error: 'validation', message: 'name or repoUrl is required.' });
      return;
    }
    if (body.name !== undefined && typeof body.name !== 'string') {
      res.status(400).json({ error: 'validation', message: 'name must be a string.' });
      return;
    }
    if (body.repoUrl !== undefined && body.repoUrl !== null && typeof body.repoUrl !== 'string') {
      res.status(400).json({ error: 'validation', message: 'repoUrl must be a string or null.' });
      return;
    }

    const result = await deps.manager.update(user.id, paramId(req), {
      ...(typeof body.name === 'string' ? { name: body.name } : {}),
      ...(body.repoUrl === null || typeof body.repoUrl === 'string' ? { repoUrl: body.repoUrl } : {}),
    });
    if (!result.ok) {
      if (result.reason === 'shutting_down') {
        shuttingDown(res, result.detail);
        return;
      }
      if (result.reason === 'not_found') {
        notFound(res);
        return;
      }
      if (result.reason === 'credential_required') {
        res.status(428).json({ error: 'credential_required', host: result.host });
        return;
      }
      if (result.reason === 'preserve_failed' || result.reason === 'invalid_state') {
        res.status(409).json({ error: result.reason, detail: result.detail });
        return;
      }
      res.status(400).json({
        error: result.reason,
        message: 'message' in result ? result.message : result.detail,
      });
      return;
    }
    res.json({ project: projectView(deps, result.project) });
  });

  router.delete('/api/projects/:id', async (req: Request, res: Response): Promise<void> => {
    const user = requireAuth(req, res, true);
    if (!user) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const force = body.force === true;
    const stopActive = body.stopActive === true;
    const result = await deps.manager.remove(user.id, paramId(req), { force, stopActive });
    if (!result.ok) {
      if (result.reason === 'shutting_down') {
        shuttingDown(res, result.detail);
        return;
      }
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
      if (result.reason === 'shutting_down') {
        shuttingDown(res, result.detail);
        return;
      }
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

  router.post('/api/projects/:id/retry', async (req: Request, res: Response): Promise<void> => {
    const user = requireAuth(req, res, true);
    if (!user) return;

    const result = await deps.manager.retry(user.id, paramId(req));
    if (!result.ok) {
      if (result.reason === 'shutting_down') {
        shuttingDown(res, result.detail);
        return;
      }
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

    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await deps.manager.stop(user.id, paramId(req), { stopActive: body.stopActive === true });
    if (!result.ok) {
      if (result.reason === 'shutting_down') {
        shuttingDown(res, result.detail);
        return;
      }
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
      if (result.reason === 'shutting_down') {
        shuttingDown(res, result.detail);
        return;
      }
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

    const terminalStates = new Set(['composition_pending', 'running', 'stopped', 'failed', 'unavailable', 'blocked']);
    const queued: unknown[] = [];
    let replaying = true;
    let ended = false;
    let closeTimer: NodeJS.Timeout | null = null;
    let latestState: string | null = null;
    const sentEvents = new Set<string>();

    const stateOf = (event: unknown): string | null => {
      const state = (event as Record<string, unknown> | undefined)?.state;
      return typeof state === 'string' ? state : null;
    };
    const send = (event: unknown): void => {
      if (ended) return;
      const serialized = JSON.stringify(event);
      // The refreshed replay snapshot can contain an event also captured by
      // the live listener. One frame is enough; EventSource reconnects replay
      // the same ring for the same reason.
      if (sentEvents.has(serialized)) return;
      sentEvents.add(serialized);
      res.write(`data: ${serialized}\n\n`);
    };
    const onBuild = (payload: { projectId: string; event: unknown }): void => {
      if (payload.projectId !== projectId || ended) return;
      if (replaying) {
        // Subscribe before replay so an event appended while the snapshot is
        // being written cannot fall into the replay/live gap. Queueing keeps
        // the persisted prefix before those newer events on the wire.
        queued.push(payload.event);
        return;
      }
      send(payload.event);
      latestState = stateOf(payload.event) ?? latestState;
      if (latestState && terminalStates.has(latestState)) {
        finishSoon();
      }
    };
    const heartbeat = setInterval(() => {
      if (!ended) {
        res.write(': heartbeat\n\n');
      }
    }, 15000);
    const cleanup = (): void => {
      if (ended) return;
      ended = true;
      deps.manager.events.off('build', onBuild);
      clearInterval(heartbeat);
      if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = null;
      }
    };
    function finishSoon(): void {
      if (ended || closeTimer) return;
      closeTimer = setTimeout(() => {
        cleanup();
        res.end();
      }, 50);
      closeTimer.unref();
    }

    deps.manager.events.on('build', onBuild);
    // IncomingMessage's `close` can describe the completed request stream;
    // the response is the long-lived half of an SSE exchange.
    res.on('close', cleanup);
    req.on('aborted', cleanup);
    res.flushHeaders?.();

    // Refresh after subscribing. An event emitted after the ownership lookup
    // but before the listener was attached is now in this second snapshot;
    // anything emitted after attachment is queued by onBuild.
    const replayProject = deps.manager.getForUser(user.id, projectId) || project;
    for (const event of replayProject.buildLog) {
      send(event);
      latestState = stateOf(event) ?? latestState;
    }
    replaying = false;
    for (const event of queued) {
      send(event);
      latestState = stateOf(event) ?? latestState;
    }

    // The row is authoritative even when a legacy/incomplete ring ends in an
    // old `building` frame and omitted its terminal event. Conversely, a live
    // terminal frame queued after the refreshed read is enough on its own.
    if (terminalStates.has(replayProject.state)
      || (latestState !== null && terminalStates.has(latestState))) {
      finishSoon();
    }
  });

  return router;
}
