/**
 * The user's own view of their environment, and the one thing they may change.
 *
 * Scoped to the caller throughout: there is no path here that names a user, so
 * no request can read or resize somebody else's environment. Operators use the
 * `env` subcommands, which talk to the engine directly and are not exposed over
 * HTTP at all — creating and destroying environments is not a capability worth
 * putting behind a browser session.
 */

import { Router, Request, Response } from 'express';
import { requireUser } from './helpers.js';
import { EnvironmentManager } from '../services/environments/manager.js';
import { AUTO_TIER } from '../services/environments/tiers.js';

export interface EnvironmentRoutesDeps {
  /** Absent on a server built without the feature; every route then answers "off". */
  environments?: EnvironmentManager;
  /** Persist the user's choice. */
  setUserEnvironmentTier(userId: number, tier: string | null): void;
  getUserEnvironmentTier(userId: number): string | null;
  /** Whether this user has something running, which decides if a change waits. */
  userHasLiveSession(userId: number): boolean;
}

export function createEnvironmentRoutes(deps: EnvironmentRoutesDeps): Router {
  const router = Router();

  router.get('/api/environment', (_req: Request, res: Response): void => {
    const user = requireUser(res);
    if (!user) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }

    const manager = deps.environments;
    if (!manager || !manager.enabled) {
      // Not an error: this is the shape of an ordinary single-machine install,
      // and the browser uses it to leave the whole section out.
      res.json({ enabled: false });
      return;
    }

    const chosen = deps.getUserEnvironmentTier(user.id) || null;
    const applied = manager.appliedTierFor(user.id);
    const pending = manager.pendingTierFor(user.id);
    const intended = manager.intendedTierFor(user.id);

    res.json({
      enabled: true,
      canChoose: manager.userTierChoiceAllowed,
      tiers: manager.tiers,
      defaultTier: manager.defaultTierId,
      /** What the user picked: a tier id, `auto`, or null meaning the default. */
      tier: chosen,
      /** What it is running at now, when it is running. */
      appliedTier: applied ? applied.id : null,
      /** What it would be built at if it started now. */
      intendedTier: intended ? intended.id : null,
      /** Set when a change is waiting for this user to stop working. */
      pendingTier: pending ? pending.id : null,
      running: Boolean(applied),
    });
  });

  router.put('/api/environment/tier', async (req: Request, res: Response): Promise<void> => {
    const user = requireUser(res);
    if (!user) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }

    const manager = deps.environments;
    if (!manager || !manager.enabled) {
      res.status(409).json({
        error: 'environments_disabled',
        message: 'This server runs everything on the host, so there is no environment to size.',
      });
      return;
    }

    if (!manager.userTierChoiceAllowed) {
      res.status(403).json({
        error: 'tier_choice_disabled',
        message: 'An administrator sets the size of every environment on this server.',
      });
      return;
    }

    const requested = typeof (req.body as { tier?: unknown })?.tier === 'string'
      ? String((req.body as { tier: string }).tier).trim()
      : '';

    if (!requested) {
      res.status(400).json({ error: 'tier_required', message: 'Name a size, or "auto".' });
      return;
    }

    const known = requested === AUTO_TIER
      || manager.tiers.some((tier) => tier.id === requested);
    if (!known) {
      // Named rather than a bare 400: the catalog is configuration, and a user
      // looking at a stale page needs to know their choice no longer exists.
      res.status(400).json({
        error: 'unknown_tier',
        message: `This server offers ${manager.tiers.map((tier) => tier.id).join(', ')} or auto.`,
      });
      return;
    }

    deps.setUserEnvironmentTier(user.id, requested);

    const intended = manager.intendedTierFor(user.id);
    if (!intended) {
      res.json({ tier: requested, outcome: 'applied' });
      return;
    }

    let outcome: string;
    try {
      outcome = await manager.applyTier(user.id, intended, {
        busy: deps.userHasLiveSession(user.id),
      });
    } catch (error) {
      console.error(`Could not resize the environment for ${user.githubLogin}:`, error);
      res.status(500).json({
        error: 'resize_failed',
        message: 'The size was saved, but the environment could not be changed. It will be built at the new size next time it starts.',
        tier: requested,
      });
      return;
    }

    res.json({
      tier: requested,
      appliedTier: intended.id,
      outcome,
      message: outcome === 'deferred'
        ? 'Saved. Your environment changes size once nothing is running in it.'
        : 'Saved.',
    });
  });

  return router;
}
