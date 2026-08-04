/** Owner-scoped global and project Git identity overrides. */

import { Request, Response, Router } from 'express';
import { requireUser } from './helpers.js';
import type { AuthenticatedUser } from '../types.js';
import type { GitIdentity } from '../services/projects/store.js';

type IdentitySource = 'project' | 'global' | 'provider' | 'incomplete';
type ResolvedIdentity = { identity: GitIdentity | { name: string; email: string; source: 'provider' } | null; source: IdentitySource };

export interface GitIdentityRoutesDeps {
  projectStore: {
    getProjectForUser(projectId: string, userId: number): unknown | null;
    upsertGitIdentity(input: { userId: number; projectId?: string | null; name: string; email: string }): GitIdentity;
    resolveGitIdentity(input: { userId: number; projectId?: string | null; providerDefault?: { name: string; email: string } | null }): ResolvedIdentity;
  };
  /** #170 can replace this with provider-agnostic identity metadata. */
  providerDefault?(user: AuthenticatedUser): { name: string; email: string } | null;
}

function sameOrigin(req: Request): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

function auth(req: Request, res: Response, write: boolean): AuthenticatedUser | null {
  const user = requireUser(res);
  if (!user) { res.status(401).json({ error: 'authentication_required' }); return null; }
  if (write && !sameOrigin(req)) { res.status(403).json({ error: 'cross_origin' }); return null; }
  return user;
}

function saneName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name && name.length <= 200 && !/[\0-\x1f\x7f]/u.test(name) ? name : null;
}

function saneEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim();
  // This intentionally validates a practical Git identity, not all RFC 5322.
  return email.length <= 254 && !/[\0-\x1f\x7f\s]/u.test(email)
    && /^[^@]+@[^@]+\.[^@]+$/u.test(email) ? email : null;
}

function defaultFor(user: AuthenticatedUser): { name: string; email: string } | null {
  const name = (user.githubName || user.githubLogin).trim();
  if (!name) return null;
  const email = user.email?.trim() || `${user.githubId}+${user.githubLogin}@users.noreply.github.com`;
  return saneEmail(email) ? { name, email } : null;
}

function view(resolution: ResolvedIdentity): { identity: { name: string; email: string } | null; source: IdentitySource } {
  return {
    identity: resolution.identity ? { name: resolution.identity.name, email: resolution.identity.email } : null,
    source: resolution.source,
  };
}

export function createGitIdentityRoutes(deps: GitIdentityRoutesDeps): Router {
  const router = Router();
  const resolve = (user: AuthenticatedUser, projectId?: string) => deps.projectStore.resolveGitIdentity({
    userId: user.id, projectId: projectId ?? null, providerDefault: deps.providerDefault?.(user) ?? defaultFor(user),
  });
  const project = (user: AuthenticatedUser, id: string) => deps.projectStore.getProjectForUser(id, user.id);
  const notFound = (res: Response) => res.status(404).json({ error: 'not_found', message: 'Project not found.' });

  router.get('/api/git-identity', (req, res) => {
    const user = auth(req, res, false); if (!user) return;
    res.json(view(resolve(user)));
  });
  router.put('/api/git-identity', (req, res) => {
    const user = auth(req, res, true); if (!user) return;
    const body = (req.body ?? {}) as Record<string, unknown>; const name = saneName(body.name); const email = saneEmail(body.email);
    if (!name || !email) { res.status(400).json({ error: 'validation', message: 'name and email must be valid, non-control-character strings.' }); return; }
    deps.projectStore.upsertGitIdentity({ userId: user.id, name, email });
    res.json(view(resolve(user)));
  });
  router.get('/api/projects/:id/git-identity', (req, res) => {
    const user = auth(req, res, false); if (!user) return;
    const id = String(req.params.id); if (!project(user, id)) { notFound(res); return; }
    res.json(view(resolve(user, id)));
  });
  router.put('/api/projects/:id/git-identity', (req, res) => {
    const user = auth(req, res, true); if (!user) return;
    const id = String(req.params.id); if (!project(user, id)) { notFound(res); return; }
    const body = (req.body ?? {}) as Record<string, unknown>; const name = saneName(body.name); const email = saneEmail(body.email);
    if (!name || !email) { res.status(400).json({ error: 'validation', message: 'name and email must be valid, non-control-character strings.' }); return; }
    deps.projectStore.upsertGitIdentity({ userId: user.id, projectId: id, name, email });
    res.json(view(resolve(user, id)));
  });
  return router;
}
