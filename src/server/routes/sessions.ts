import { Router } from 'express';
import { AccountTabCoordinator } from '../services/account-tab-coordinator.js';
import type { SessionRoutesDeps } from './sessions-common.js';
import {
  handlePersistence,
  handleResumable,
  handleConversations,
  handleList,
  handleTabsOrder,
  handleName,
  handleTab,
  handleChildren,
  handleGet,
} from './sessions-handlers-account.js';
import { handleCreate } from './sessions-handlers-create.js';
import { handleBranch } from './sessions-handlers-branch.js';
import { handleDelete, handleExport } from './sessions-handlers-delete.js';

export type { SessionRoutesDeps } from './sessions-common.js';
export { suspendProjectSessions, retireProjectSessions } from './sessions-teardown.js';

export function createSessionRoutes(deps: SessionRoutesDeps): Router {
  const router = Router();
  // Membership and order are one account-owned value. Serialize every such
  // mutation for a user: a reorder must validate the same open set it persists,
  // and a failed older write must never roll back a newer close or reopen.
  const tabCoordinator = deps.tabCoordinator ?? new AccountTabCoordinator();
  const acquireTabMutation = (userId: number): Promise<() => void> =>
    tabCoordinator.acquire(userId);

  router.get('/api/sessions/persistence', (req, res) => handlePersistence(deps, req, res));
  router.get('/api/sessions/resumable', (req, res) => handleResumable(deps, req, res));
  router.get('/api/sessions/conversations', (req, res) => handleConversations(deps, req, res));
  router.get('/api/sessions/list', (req, res) => handleList(deps, acquireTabMutation, req, res));
  router.patch('/api/sessions/tabs/order', (req, res) => handleTabsOrder(deps, acquireTabMutation, req, res));
  router.patch('/api/sessions/:sessionId/name', (req, res) => handleName(deps, req, res));
  router.patch('/api/sessions/:sessionId/tab', (req, res) => handleTab(deps, acquireTabMutation, req, res));
  router.post('/api/sessions/create', (req, res) => handleCreate(deps, acquireTabMutation, req, res));
  router.post('/api/sessions/:sessionId/branch', (req, res) => handleBranch(deps, acquireTabMutation, req, res));
  router.get('/api/sessions/:sessionId/children', (req, res) => handleChildren(deps, req, res));
  router.get('/api/sessions/:sessionId', (req, res) => handleGet(deps, req, res));
  router.delete('/api/sessions/:sessionId', (req, res) => handleDelete(deps, acquireTabMutation, req, res));
  router.get('/api/sessions/:sessionId/export.md', (req, res) => handleExport(deps, req, res));

  return router;
}
