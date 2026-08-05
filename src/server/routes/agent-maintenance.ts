/** HTTP adapter for target-bound agent maintenance. Integration owns target resolution. */
import { Request, Response, Router } from 'express';
import { AGENT_MAINTENANCE_IDS, AgentMaintenanceId } from '../../shared/agent-maintenance.js';
import { requireUser } from './helpers.js';
import type { AgentMaintenanceService, AgentMaintenanceTarget } from '../services/agent-maintenance.js';

export interface AgentMaintenanceRoutesDeps {
  maintenance: AgentMaintenanceService;
  getInstallerUserId(): number | null;
  /** Must bind the requested server/environment/ownership identity, never controller selection. */
  resolveTarget(input: { userId: number; targetId: string }): Promise<AgentMaintenanceTarget | null>;
}
function sameOrigin(req: Request): boolean { const origin = req.headers.origin; if (!origin) return true; try { return new URL(origin).host === req.headers.host; } catch { return false; } }
function user(req: Request, res: Response, write = false): number | null { const account = requireUser(res); if (!account) { res.status(401).json({ error: 'authentication_required' }); return null; } if (write && !sameOrigin(req)) { res.status(403).json({ error: 'cross_origin' }); return null; } return account.id; }
function agent(value: unknown): AgentMaintenanceId | null { return typeof value === 'string' && (AGENT_MAINTENANCE_IDS as readonly string[]).includes(value) ? value as AgentMaintenanceId : null; }
function targetId(value: unknown): string | null { return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/u.test(value) ? value : null; }
function operationId(value: unknown): string | null { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(value) ? value : null; }
async function target(deps: AgentMaintenanceRoutesDeps, res: Response, userId: number, value: unknown): Promise<AgentMaintenanceTarget | null> { const id = targetId(value); if (!id) { res.status(400).json({ error: 'validation', message: 'A valid targetId is required.' }); return null; } const resolved = await deps.resolveTarget({ userId, targetId: id }); if (!resolved) { res.status(404).json({ error: 'target_not_found' }); return null; } return resolved; }
function sharedConfirmed(res: Response, resolved: AgentMaintenanceTarget, value: unknown): boolean { if (resolved.scope !== 'shared' || value === true) return true; res.status(409).json({ error: 'confirmation_required', message: 'Confirm this shared-host change before continuing.' }); return false; }

export function createAgentMaintenanceRoutes(deps: AgentMaintenanceRoutesDeps): Router {
  const router = Router();
  router.get('/api/agent-maintenance', async (req, res) => { const id = user(req, res); if (id === null) return; const t = await target(deps, res, id, req.query.targetId); if (!t) return; const statuses = await Promise.all(AGENT_MAINTENANCE_IDS.map((item) => deps.maintenance.status(t, item, id, deps.getInstallerUserId()))); res.json({ targetKey: t.key, agents: statuses }); });
  router.get('/api/agent-maintenance/:agentId', async (req, res) => { const id = user(req, res); const item = agent(req.params.agentId); if (id === null) return; if (!item) { res.status(400).json({ error: 'validation' }); return; } const t = await target(deps, res, id, req.query.targetId); if (!t) return; res.json({ status: await deps.maintenance.status(t, item, id, deps.getInstallerUserId()) }); });
  router.post('/api/agent-maintenance/:agentId/check', async (req, res) => { const id = user(req, res, true); const item = agent(req.params.agentId); if (id === null) return; if (!item) { res.status(400).json({ error: 'validation' }); return; } const body = req.body as { targetId?: unknown; force?: unknown }; const t = await target(deps, res, id, body?.targetId); if (!t) return; res.json({ check: await deps.maintenance.check(t, item, body?.force === true) }); });
  router.post('/api/agent-maintenance/:agentId/:kind', async (req, res) => { const id = user(req, res, true); const item = agent(req.params.agentId); const kind = req.params.kind === 'update' ? 'update' : req.params.kind === 'install' ? 'install' : null; if (id === null) return; if (!item || !kind) { res.status(400).json({ error: 'validation' }); return; } const body = req.body as { targetId?: unknown; confirmed?: unknown }; const t = await target(deps, res, id, body?.targetId); if (!t || !sharedConfirmed(res, t, body?.confirmed)) return; try { res.status(202).json({ operation: deps.maintenance.start(t, item, id, deps.getInstallerUserId(), kind) }); } catch (error) { res.status(403).json({ error: 'operation_disabled', disabledReason: error instanceof Error ? error.message : 'Operation unavailable.' }); } });
  router.post('/api/agent-maintenance/operations/:id/cancel', async (req, res) => { const id = user(req, res, true); if (id === null) return; const opId = operationId(req.params.id); if (!opId) { res.status(400).json({ error: 'validation' }); return; } const t = await target(deps, res, id, (req.body as { targetId?: unknown })?.targetId); if (!t) return; const existing = deps.maintenance.operation(opId); if (!existing || existing.targetKey !== t.key || existing.ownerUserId !== id) { res.status(404).json({ error: 'not_found' }); return; } const operation = deps.maintenance.cancel(opId); res.json({ operation }); });
  router.get('/api/agent-maintenance/operations/:id', async (req, res) => { const id = user(req, res); if (id === null) return; const opId = operationId(req.params.id); if (!opId) { res.status(400).json({ error: 'validation' }); return; } const t = await target(deps, res, id, req.query.targetId); if (!t) return; const operation = deps.maintenance.operation(opId); if (!operation || operation.targetKey !== t.key || operation.ownerUserId !== id) { res.status(404).json({ error: 'not_found' }); return; } res.json({ operation }); });
  return router;
}
