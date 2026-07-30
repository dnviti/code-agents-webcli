import { Request, Response, Router } from 'express';
import { RuntimeProfileStore } from '../services/runtime-profiles.js';
import {
  TierWriterContext,
  applyTiers,
  tierCapableRuntimes,
} from '../services/tier-writer.js';
import { requireUser } from './helpers.js';

export interface ProfileRoutesDeps {
  runtimeProfiles: RuntimeProfileStore;
  tierContext: TierWriterContext;
  getInstallerUserId(): number | null;
}

/**
 * Reject a cross-origin write.
 *
 * Same reasoning as the paste route: the auth cookie is SameSite=Lax, which is
 * site-scoped rather than origin-scoped, and this endpoint decides what
 * arguments and environment every future agent process is spawned with.
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

export function createProfileRoutes(deps: ProfileRoutesDeps): Router {
  const router = Router();

  router.get('/api/runtime-profiles', (_req: Request, res: Response): void => {
    const user = requireUser(res);
    if (!user) {
      res.status(401).json({ error: 'Not signed in' });
      return;
    }

    const installerUserId = deps.getInstallerUserId();
    res.json({
      config: deps.runtimeProfiles.get(),
      tierCapableRuntimes: tierCapableRuntimes(),
      // Everyone can see the configuration; only the installer may change it,
      // and the UI needs to know which it is so it can render read-only rather
      // than offering a Save that will 403.
      canEdit: installerUserId !== null && user.id === installerUserId,
    });
  });

  router.put('/api/runtime-profiles', (req: Request, res: Response): void => {
    const user = requireUser(res);
    if (!user) {
      res.status(401).json({ error: 'Not signed in' });
      return;
    }

    if (!isSameOrigin(req)) {
      res.status(403).json({ error: 'Cross-origin write rejected' });
      return;
    }

    // Profiles are app-wide but sessions are per-user, so a writer here changes
    // how *everyone's* agents launch. That is installer-only, the same bar as
    // applying a self-update.
    const installerUserId = deps.getInstallerUserId();
    if (installerUserId === null || user.id !== installerUserId) {
      res.status(403).json({ error: 'Only the installer can change runtime profiles' });
      return;
    }

    const config = deps.runtimeProfiles.save(req.body?.config);

    // Write tiers through immediately rather than at launch, so the user finds
    // out here whether their tier config actually landed — a runtime that
    // cannot express tiers, or an agent file we refused to overwrite, is
    // something to see while editing, not to discover from a silent no-op.
    const tierResults: Record<string, unknown> = {};
    for (const profile of config.profiles) {
      if (!profile.tiers) continue;
      const result = applyTiers(profile, deps.tierContext);
      tierResults[profile.id] = {
        written: result.written,
        replaced: result.replaced,
        unsupported: result.unsupported === true,
        failed: result.failed,
        // A writer that places its files per session cannot act on a save; the
        // sentence it hands back is what the dialog shows instead of silence.
        deferred: result.deferred,
      };
    }

    res.json({ config, tierResults });
  });

  return router;
}
