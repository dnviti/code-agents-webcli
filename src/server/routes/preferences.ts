import { Request, Response, Router } from 'express';
import { UserPreferenceStore } from '../services/user-preferences.js';
import { requireUser } from './helpers.js';

export interface PreferenceRoutesDeps {
  userPreferences: UserPreferenceStore;
}

/**
 * Reject a cross-origin write.
 *
 * Same reasoning as the profile and paste routes: the auth cookie is
 * SameSite=Lax, which is site-scoped rather than origin-scoped, and this
 * endpoint decides whether the next conversation runs shell commands without
 * asking.
 */
function isSameOrigin(req: Request): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function createPreferenceRoutes(deps: PreferenceRoutesDeps): Router {
  const router = Router();

  router.get('/api/preferences', (_req: Request, res: Response): void => {
    const user = requireUser(res);
    if (!user) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }

    res.json({ preferences: deps.userPreferences.get(user.id) });
  });

  router.put('/api/preferences', (req: Request, res: Response): void => {
    const user = requireUser(res);
    if (!user) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }

    if (!isSameOrigin(req)) {
      res.status(403).json({ error: 'Cross-origin write rejected' });
      return;
    }

    // Keyed on the signed-in user and never on anything in the body. There is
    // no id to send: one account cannot grant another a standing permission,
    // and the route offers no shape in which to try.
    res.json({ preferences: deps.userPreferences.set(user.id, req.body?.preferences) });
  });

  return router;
}
