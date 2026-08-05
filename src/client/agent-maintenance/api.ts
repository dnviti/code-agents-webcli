import type {
  AgentCheckState,
  AgentMaintenanceId,
  AgentMaintenanceOperation,
  AgentMaintenanceStatus,
} from '../../shared/agent-maintenance.js';
import { controllerFetch, parseQualifiedSessionId } from '../controller/transport.js';

export interface AgentMaintenanceBinding {
  /** A session/environment identifier. Qualified desktop ids are unwrapped before transport. */
  targetId: string;
  /** The owner captured from the active session, never the controller's current selection. */
  serverId: string;
}

export interface AgentMaintenanceList {
  targetKey: string;
  agents: AgentMaintenanceStatus[];
}

export interface AgentMaintenanceCheck {
  targetKey: string;
  agentId: AgentMaintenanceId;
  latestVersion: string | null;
  state: Exclude<AgentCheckState, 'checking'>;
  checkedAt: number;
}

export class AgentMaintenanceApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly disabledReason: string | null;

  constructor(message: string, status: number, body: Record<string, unknown>) {
    super(message);
    this.name = 'AgentMaintenanceApiError';
    this.status = status;
    this.code = typeof body.error === 'string' ? body.error : null;
    this.disabledReason = typeof body.disabledReason === 'string' ? body.disabledReason : null;
  }
}

export interface AgentMaintenanceApi {
  readonly targetId: string;
  readonly serverId: string;
  list(signal?: AbortSignal): Promise<AgentMaintenanceList>;
  status(agentId: AgentMaintenanceId, signal?: AbortSignal): Promise<AgentMaintenanceStatus>;
  check(agentId: AgentMaintenanceId, force?: boolean, signal?: AbortSignal): Promise<AgentMaintenanceCheck>;
  start(agentId: AgentMaintenanceId, kind: 'install' | 'update', confirmed?: boolean, signal?: AbortSignal): Promise<AgentMaintenanceOperation>;
  operation(operationId: string, signal?: AbortSignal): Promise<AgentMaintenanceOperation>;
  cancel(operationId: string, signal?: AbortSignal): Promise<AgentMaintenanceOperation>;
}

function required(value: string, label: string): string {
  const clean = value.trim();
  if (!clean) throw new TypeError(`${label} is required.`);
  return clean;
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  const value = await response.json().catch(() => ({})) as unknown;
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function messageOf(body: Record<string, unknown>, fallback: string): string {
  if (typeof body.message === 'string' && body.message.trim()) return body.message;
  if (typeof body.disabledReason === 'string' && body.disabledReason.trim()) return body.disabledReason;
  return fallback;
}

/**
 * Creates an immutable, session-qualified API handle.
 *
 * The gateway routes with `serverId`, while the selected server receives its
 * own raw session id as `targetId`. Keeping both values in this closure makes a
 * controller selection change unable to redirect an in-flight check/install.
 */
export function createAgentMaintenanceApi(binding: AgentMaintenanceBinding): AgentMaintenanceApi {
  const qualified = parseQualifiedSessionId(required(binding.targetId, 'targetId'));
  const serverId = required(binding.serverId, 'serverId');
  if (qualified && qualified.serverId !== serverId) {
    throw new Error('The maintenance target and server owner do not match.');
  }
  const targetId = required(qualified?.sessionId ?? binding.targetId, 'targetId');
  const targetQuery = new URLSearchParams({ targetId }).toString();

  async function request(path: string, init: RequestInit, fallback: string): Promise<Record<string, unknown>> {
    const response = await controllerFetch(path, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
      ...init,
    }, serverId);
    const body = await bodyOf(response);
    if (!response.ok) throw new AgentMaintenanceApiError(messageOf(body, fallback), response.status, body);
    return body;
  }

  return Object.freeze({
    targetId,
    serverId,
    async list(signal?: AbortSignal): Promise<AgentMaintenanceList> {
      const body = await request(`/api/agent-maintenance?${targetQuery}`, { signal }, 'Unable to load agent versions.');
      return {
        targetKey: typeof body.targetKey === 'string' ? body.targetKey : targetId,
        agents: Array.isArray(body.agents) ? body.agents as AgentMaintenanceStatus[] : [],
      };
    },
    async status(agentId: AgentMaintenanceId, signal?: AbortSignal): Promise<AgentMaintenanceStatus> {
      const body = await request(
        `/api/agent-maintenance/${encodeURIComponent(agentId)}?${targetQuery}`,
        { signal },
        'Unable to load the agent version.',
      );
      return body.status as AgentMaintenanceStatus;
    },
    async check(agentId: AgentMaintenanceId, force = false, signal?: AbortSignal): Promise<AgentMaintenanceCheck> {
      const body = await request(`/api/agent-maintenance/${encodeURIComponent(agentId)}/check`, {
        method: 'POST',
        signal,
        body: JSON.stringify({ targetId, force }),
      }, 'Unable to check for an agent update.');
      return body.check as AgentMaintenanceCheck;
    },
    async start(agentId: AgentMaintenanceId, kind: 'install' | 'update', confirmed = false, signal?: AbortSignal): Promise<AgentMaintenanceOperation> {
      const body = await request(`/api/agent-maintenance/${encodeURIComponent(agentId)}/${kind}`, {
        method: 'POST',
        signal,
        body: JSON.stringify({ targetId, confirmed }),
      }, `Unable to ${kind} the agent.`);
      return body.operation as AgentMaintenanceOperation;
    },
    async operation(operationId: string, signal?: AbortSignal): Promise<AgentMaintenanceOperation> {
      const body = await request(
        `/api/agent-maintenance/operations/${encodeURIComponent(required(operationId, 'operationId'))}?${targetQuery}`,
        { signal },
        'Unable to restore the agent operation.',
      );
      return body.operation as AgentMaintenanceOperation;
    },
    async cancel(operationId: string, signal?: AbortSignal): Promise<AgentMaintenanceOperation> {
      const body = await request(
        `/api/agent-maintenance/operations/${encodeURIComponent(required(operationId, 'operationId'))}/cancel`,
        { method: 'POST', signal, body: JSON.stringify({ targetId }) },
        'Unable to cancel the agent operation.',
      );
      return body.operation as AgentMaintenanceOperation;
    },
  });
}
