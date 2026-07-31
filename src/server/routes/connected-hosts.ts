/**
 * Personal connected-host credentials for project clone/push.
 *
 * Tokens are never returned; the list only shows which hosts have a stored
 * credential. Writes are same-origin, matching the other state-changing
 * routes.
 */

import { Request, Response, Router } from 'express';
import { requireUser } from './helpers.js';
import type { AuthenticatedUser } from '../types.js';
import type { ConnectedHost } from '../services/projects/store.js';

export interface ConnectedHostRoutesDeps {
  projectStore: {
    listConnectedHosts(userId: number): ConnectedHost[];
    upsertConnectedHostToken(userId: number, host: string, token: string): ConnectedHost;
    deleteConnectedHost(userId: number, host: string): boolean;
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

function paramHost(req: Request): string {
  return String(req.params.host).trim().toLowerCase();
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

export function createConnectedHostRoutes(deps: ConnectedHostRoutesDeps): Router {
  const router = Router();

  router.get('/api/connected-hosts', (req: Request, res: Response): void => {
    const user = requireAuth(req, res, false);
    if (!user) return;
    res.json({ hosts: deps.projectStore.listConnectedHosts(user.id) });
  });

  router.post('/api/connected-hosts', (req: Request, res: Response): void => {
    const user = requireAuth(req, res, true);
    if (!user) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const host = typeof body.host === 'string' ? body.host.trim().toLowerCase() : '';
    const token = typeof body.token === 'string' ? body.token : '';

    if (!host) {
      res.status(400).json({ error: 'validation', message: 'host is required.' });
      return;
    }
    if (!token) {
      res.status(400).json({ error: 'validation', message: 'token is required.' });
      return;
    }

    try {
      const hostRecord = deps.projectStore.upsertConnectedHostToken(user.id, host, token);
      res.status(200).json({ host: hostRecord });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: 'validation', message });
    }
  });

  router.delete('/api/connected-hosts/:host', (req: Request, res: Response): void => {
    const user = requireAuth(req, res, true);
    if (!user) return;

    const removed = deps.projectStore.deleteConnectedHost(user.id, paramHost(req));
    if (!removed) {
      res.status(404).json({ error: 'not_found', message: 'Host not found.' });
      return;
    }
    res.status(204).send();
  });

  return router;
}
