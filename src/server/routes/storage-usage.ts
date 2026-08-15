/** Owner-scoped and installer-scoped views of warning-only storage usage. */

import { Request, Response, Router } from 'express';
import type { AuthenticatedUser } from '../types.js';
import type { StorageCacheAction, StorageUsageReport } from '../services/storage/storage-usage.js';
import { STORAGE_CACHE_ACTIONS } from '../services/storage/storage-usage.js';
import { requireUser } from './helpers.js';

export interface AdminStorageUsage {
  userId: number;
  login: string;
  report: StorageUsageReport;
}

export interface StorageUsageRoutesDeps {
  storageUsage: {
    reportForUser(userId: number, refresh: boolean): Promise<StorageUsageReport>;
    reportsForAdmin(refresh: boolean): Promise<AdminStorageUsage[]>;
    reportForAdmin(userId: number, refresh: boolean): Promise<AdminStorageUsage | null>;
    clearCache(userId: number, action: StorageCacheAction): Promise<StorageUsageReport>;
  };
  getInstallerUserId(): number | null;
}

function sameOrigin(req: Request): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function authenticated(res: Response): AuthenticatedUser | null {
  const user = requireUser(res);
  if (!user) res.status(401).json({ error: 'authentication_required' });
  return user;
}

function installer(deps: StorageUsageRoutesDeps, res: Response): AuthenticatedUser | null {
  const user = authenticated(res);
  if (!user) return null;
  const installerUserId = deps.getInstallerUserId();
  if (installerUserId === null || installerUserId !== user.id) {
    res.status(403).json({ error: 'not_installer' });
    return null;
  }
  return user;
}

function refreshRequested(req: Request): boolean {
  return req.query.refresh === '1' || req.query.refresh === 'true';
}

function userIdParam(req: Request): number | null {
  const value = Number(String(req.params.userId));
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function storageFailure(res: Response, _error: unknown): void {
  res.status(503).json({
    error: 'storage_measurement_failed',
    message: 'Storage usage could not be measured right now. Try again.',
  });
}

export function createStorageUsageRoutes(deps: StorageUsageRoutesDeps): Router {
  const router = Router();

  router.get('/api/usage/storage', async (req: Request, res: Response): Promise<void> => {
    const user = authenticated(res);
    if (!user) return;
    try {
      res.json({ report: await deps.storageUsage.reportForUser(user.id, refreshRequested(req)) });
    } catch (error) {
      storageFailure(res, error);
    }
  });

  router.get('/api/admin/usage/storage', async (req: Request, res: Response): Promise<void> => {
    if (!installer(deps, res)) return;
    try {
      res.json({ users: await deps.storageUsage.reportsForAdmin(refreshRequested(req)) });
    } catch (error) {
      storageFailure(res, error);
    }
  });

  router.get('/api/admin/usage/storage/:userId', async (req: Request, res: Response): Promise<void> => {
    if (!installer(deps, res)) return;
    const userId = userIdParam(req);
    if (userId === null) {
      res.status(400).json({ error: 'validation', message: 'userId must be a positive integer.' });
      return;
    }
    try {
      const usage = await deps.storageUsage.reportForAdmin(userId, refreshRequested(req));
      if (!usage) {
        res.status(404).json({ error: 'not_found', message: 'User not found.' });
        return;
      }
      res.json({ user: usage });
    } catch (error) {
      storageFailure(res, error);
    }
  });

  router.delete('/api/usage/storage/cache/:action', async (req: Request, res: Response): Promise<void> => {
    const user = authenticated(res);
    if (!user) return;
    if (!sameOrigin(req)) {
      res.status(403).json({ error: 'cross_origin' });
      return;
    }
    const action = String(req.params.action);
    if (!Object.prototype.hasOwnProperty.call(STORAGE_CACHE_ACTIONS, action)) {
      res.status(400).json({ error: 'validation', message: 'Unknown storage cleanup action.' });
      return;
    }
    try {
      const report = await deps.storageUsage.clearCache(user.id, action as StorageCacheAction);
      res.json({ report });
    } catch (error) {
      storageFailure(res, error);
    }
  });

  return router;
}
