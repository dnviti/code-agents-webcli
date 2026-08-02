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

function normalizedHost(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || /[\\/?#@\s]/u.test(raw)) return null;

  try {
    const parsed = new URL(`https://${raw}`);
    if (
      !parsed.hostname
      || parsed.username
      || parsed.password
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash
    ) {
      return null;
    }
    return parsed.host.toLowerCase();
  } catch {
    return null;
  }
}

function paramHost(req: Request): string | null {
  return normalizedHost(String(req.params.host));
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
    const host = normalizedHost(body.host);
    const token = typeof body.token === 'string' ? body.token.trim() : '';

    if (!host) {
      res.status(400).json({
        error: 'validation',
        message: 'host must be a hostname or hostname:port, without a scheme or path.',
      });
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

    const host = paramHost(req);
    if (!host) {
      res.status(400).json({ error: 'validation', message: 'host is invalid.' });
      return;
    }
    const removed = deps.projectStore.deleteConnectedHost(user.id, host);
    if (!removed) {
      res.status(404).json({ error: 'not_found', message: 'Host not found.' });
      return;
    }
    res.status(204).send();
  });

  return router;
}
