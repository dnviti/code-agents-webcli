import * as React from 'react';

import {
  AGENT_MAINTENANCE_IDS,
  type AgentMaintenanceId,
  type AgentMaintenanceOperation,
  type AgentMaintenanceStatus,
} from '../../shared/agent-maintenance.js';
import {
  createAgentMaintenanceApi,
  type AgentMaintenanceApi,
  type AgentMaintenanceBinding,
  type AgentMaintenanceCheck,
} from './api.js';

const DAY_MS = 24 * 60 * 60 * 1_000;
const OPERATION_POLL_MS = 1_000;
const FINISHED_PHASES = new Set(['complete', 'failed', 'cancelled']);

export interface UseAgentMaintenanceOptions extends AgentMaintenanceBinding {
  /** Limit checks to the active/picker-row agent. Omit to check the full catalog. */
  agentId?: AgentMaintenanceId;
  enabled?: boolean;
  /** Restores polling for a durable operation remembered by the shell. */
  operationId?: string | null;
  onOperationId?(operationId: string): void;
  onOperationSettled?(operation: AgentMaintenanceOperation): void;
  /** Test seams. Production callers should use the defaults. */
  refreshIntervalMs?: number;
  operationPollMs?: number;
}

export interface AgentMaintenanceHook {
  readonly api: AgentMaintenanceApi;
  readonly statuses: Partial<Record<AgentMaintenanceId, AgentMaintenanceStatus>>;
  readonly targetKey: string | null;
  readonly loading: boolean;
  readonly checking: readonly AgentMaintenanceId[];
  readonly errors: Partial<Record<AgentMaintenanceId, string>>;
  readonly error: string | null;
  readonly operation: AgentMaintenanceOperation | null;
  /** Present while restoring, starting, or polling the target's one visible operation. */
  readonly operationBusyReason: string | null;
  refresh(): Promise<void>;
  check(agentId?: AgentMaintenanceId, force?: boolean): Promise<void>;
  install(agentId: AgentMaintenanceId, confirmed?: boolean): Promise<AgentMaintenanceOperation | null>;
  update(agentId: AgentMaintenanceId, confirmed?: boolean): Promise<AgentMaintenanceOperation | null>;
  retry(): Promise<void>;
  cancel(): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Agent maintenance is unavailable.';
}

function aborted(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';
}

function operationActive(operation: AgentMaintenanceOperation | null | undefined): operation is AgentMaintenanceOperation {
  return Boolean(operation && !FINISHED_PHASES.has(operation.phase));
}

export function agentMaintenanceBusyReason(input: {
  operation?: AgentMaintenanceOperation | null;
  restoring?: boolean;
  startingAgentId?: AgentMaintenanceId | null;
}): string | null {
  if (input.restoring) {
    return 'Restoring the existing agent operation. Install and update actions will unlock when its state is known.';
  }
  if (input.startingAgentId) {
    return `Starting maintenance for ${input.startingAgentId}. Wait for the operation to appear before starting another.`;
  }
  if (operationActive(input.operation)) {
    return `${input.operation.kind === 'install' ? 'Install' : 'Update'} for ${input.operation.agentId} is ${input.operation.phase}. Wait for it to finish or cancel it before starting another.`;
  }
  return null;
}

/**
 * Loads status opportunistically and owns checks/operation polling while its
 * surface is mounted. The initial binding is deliberately captured once: a
 * later controller selection cannot retarget work belonging to this session.
 * Remount (normally with `key={sessionId}`) to show a different session.
 */
export function useAgentMaintenance(options: UseAgentMaintenanceOptions): AgentMaintenanceHook {
  const captured = React.useRef<{
    api: AgentMaintenanceApi;
    agentIds: readonly AgentMaintenanceId[];
    enabled: boolean;
    operationId: string | null;
    refreshIntervalMs: number;
    operationPollMs: number;
  } | null>(null);
  if (!captured.current) {
    captured.current = {
      api: createAgentMaintenanceApi({ targetId: options.targetId, serverId: options.serverId }),
      agentIds: options.agentId ? [options.agentId] : AGENT_MAINTENANCE_IDS,
      enabled: options.enabled !== false,
      operationId: options.operationId ?? null,
      refreshIntervalMs: options.refreshIntervalMs ?? DAY_MS,
      operationPollMs: options.operationPollMs ?? OPERATION_POLL_MS,
    };
  }
  const config = captured.current;
  const abortRef = React.useRef<AbortController | null>(null);
  const mountedRef = React.useRef(false);
  const checkResultsRef = React.useRef<Partial<Record<AgentMaintenanceId, AgentMaintenanceCheck>>>({});
  const [statuses, setStatuses] = React.useState<Partial<Record<AgentMaintenanceId, AgentMaintenanceStatus>>>({});
  const [targetKey, setTargetKey] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(config.enabled);
  const [checking, setChecking] = React.useState<readonly AgentMaintenanceId[]>([]);
  const [errors, setErrors] = React.useState<Partial<Record<AgentMaintenanceId, string>>>({});
  const [error, setError] = React.useState<string | null>(null);
  const [operation, setOperation] = React.useState<AgentMaintenanceOperation | null>(null);
  const [restoringOperation, setRestoringOperation] = React.useState(Boolean(config.enabled && config.operationId));
  const [startingAgentId, setStartingAgentId] = React.useState<AgentMaintenanceId | null>(null);
  const operationGateRef = React.useRef<'restoring' | 'starting' | AgentMaintenanceOperation | null>(
    config.enabled && config.operationId ? 'restoring' : null,
  );

  const signal = React.useCallback((): AbortSignal | undefined => abortRef.current?.signal, []);

  const refresh = React.useCallback(async (): Promise<void> => {
    if (!config.enabled) return;
    try {
      const result = await config.api.list(signal());
      if (!mountedRef.current) return;
      const next: Partial<Record<AgentMaintenanceId, AgentMaintenanceStatus>> = {};
      for (const status of result.agents) {
        const checked = checkResultsRef.current[status.agentId];
        next[status.agentId] = checked && checked.checkedAt >= (status.checkedAt ?? 0)
          ? {
              ...status,
              check: checked.state,
              latestVersion: checked.latestVersion,
              checkedAt: checked.checkedAt,
            }
          : status;
      }
      setStatuses((current) => {
        const merged = { ...next };
        for (const id of config.agentIds) {
          const previous = current[id];
          const incoming = next[id];
          if (previous && incoming && (previous.checkedAt ?? 0) > (incoming.checkedAt ?? 0)) {
            merged[id] = previous;
          }
        }
        return merged;
      });
      setTargetKey(result.targetKey);
      setError(null);
    } catch (caught) {
      if (!aborted(caught) && mountedRef.current) setError(errorMessage(caught));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [config, signal]);

  const check = React.useCallback(async (agentId?: AgentMaintenanceId, force = false): Promise<void> => {
    if (!config.enabled) return;
    const ids = agentId ? [agentId] : config.agentIds;
    setChecking((current) => [...new Set([...current, ...ids])]);
    await Promise.all(ids.map(async (id) => {
      try {
        const checked = await config.api.check(id, force, signal());
        if (!mountedRef.current) return;
        checkResultsRef.current[id] = checked;
        setStatuses((current) => current[id]
          ? {
              ...current,
              [id]: {
                ...current[id]!,
                check: checked.state,
                latestVersion: checked.latestVersion,
                checkedAt: checked.checkedAt,
              },
            }
          : current);
        setErrors((current) => {
          if (!(id in current)) return current;
          const next = { ...current };
          delete next[id];
          return next;
        });
        setError(null);
      } catch (caught) {
        if (!aborted(caught) && mountedRef.current) {
          setStatuses((current) => current[id]
            ? { ...current, [id]: { ...current[id]!, check: 'unable_to_check' } }
            : current);
          setErrors((current) => ({ ...current, [id]: errorMessage(caught) }));
          setError(errorMessage(caught));
        }
      } finally {
        if (mountedRef.current) setChecking((current) => current.filter((value) => value !== id));
      }
    }));
  }, [config, signal]);

  const start = React.useCallback(async (
    agentId: AgentMaintenanceId,
    kind: 'install' | 'update',
    confirmed = false,
  ): Promise<AgentMaintenanceOperation | null> => {
    if (!config.enabled) return null;
    if (operationGateRef.current) {
      const reason = agentMaintenanceBusyReason({
        operation: typeof operationGateRef.current === 'object' ? operationGateRef.current : null,
        restoring: operationGateRef.current === 'restoring',
        startingAgentId: operationGateRef.current === 'starting' ? agentId : null,
      }) || 'Another agent operation is already in progress on this target.';
      setErrors((current) => ({ ...current, [agentId]: reason }));
      return null;
    }
    // The ref closes the same-render double-click race; state supplies the
    // visible/accessibility explanation to every other picker row.
    operationGateRef.current = 'starting';
    setStartingAgentId(agentId);
    try {
      const next = await config.api.start(agentId, kind, confirmed, signal());
      if (!mountedRef.current) return next;
      operationGateRef.current = operationActive(next) ? next : null;
      setOperation(next);
      setError(null);
      setErrors((current) => {
        if (!(agentId in current)) return current;
        const nextErrors = { ...current };
        delete nextErrors[agentId];
        return nextErrors;
      });
      options.onOperationId?.(next.id);
      return next;
    } catch (caught) {
      operationGateRef.current = null;
      if (!aborted(caught) && mountedRef.current) {
        setErrors((current) => ({ ...current, [agentId]: errorMessage(caught) }));
        setError(errorMessage(caught));
      }
      return null;
    } finally {
      if (mountedRef.current) setStartingAgentId(null);
    }
  }, [config, options.onOperationId, signal]);

  const install = React.useCallback(
    (agentId: AgentMaintenanceId, confirmed = false) => start(agentId, 'install', confirmed),
    [start],
  );
  const update = React.useCallback(
    (agentId: AgentMaintenanceId, confirmed = false) => start(agentId, 'update', confirmed),
    [start],
  );

  const retry = React.useCallback(async (): Promise<void> => {
    if (operation?.retryable && FINISHED_PHASES.has(operation.phase)) {
      await start(operation.agentId, operation.kind);
      return;
    }
    await check(undefined, true);
    await refresh();
  }, [check, operation, refresh, start]);

  const cancel = React.useCallback(async (): Promise<void> => {
    if (!operation?.canCancel) return;
    try {
      const next = await config.api.cancel(operation.id, signal());
      if (mountedRef.current) {
        operationGateRef.current = operationActive(next) ? next : null;
        setOperation(next);
        if (FINISHED_PHASES.has(next.phase)) options.onOperationSettled?.(next);
      }
    } catch (caught) {
      if (!aborted(caught) && mountedRef.current) setError(errorMessage(caught));
    }
  }, [config, operation, options.onOperationSettled, signal]);

  React.useEffect(() => {
    mountedRef.current = true;
    abortRef.current = new AbortController();
    if (!config.enabled) {
      setLoading(false);
      return () => {
        mountedRef.current = false;
        abortRef.current?.abort();
      };
    }

    // These intentionally run together: rendering status never waits for a
    // publisher check, whose server-side deadline is five seconds.
    void refresh();
    void check();
    if (config.operationId) {
      void config.api.operation(config.operationId, signal()).then((restored) => {
        if (!mountedRef.current) return;
        operationGateRef.current = operationActive(restored) ? restored : null;
        setOperation(restored);
        if (restored.phase === 'complete') {
          void refresh().then(() => {
            if (!mountedRef.current) return;
            setOperation(null);
            options.onOperationSettled?.(restored);
          });
        } else if (restored.phase === 'cancelled') {
          options.onOperationSettled?.(restored);
        }
      }).catch((caught: unknown) => {
        operationGateRef.current = null;
        if (!aborted(caught) && mountedRef.current) setError(errorMessage(caught));
      }).finally(() => {
        if (mountedRef.current) setRestoringOperation(false);
      });
    }
    const timer = window.setInterval(() => {
      void check();
      void refresh();
    }, Math.max(1, config.refreshIntervalMs));
    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
      abortRef.current?.abort();
    };
  }, [check, config, refresh, signal]);

  React.useEffect(() => {
    if (!operation || FINISHED_PHASES.has(operation.phase)) return undefined;
    let stopped = false;
    let timer: number | null = null;
    const poll = async (): Promise<void> => {
      try {
        const next = await config.api.operation(operation.id, signal());
        if (stopped || !mountedRef.current) return;
        operationGateRef.current = operationActive(next) ? next : null;
        setOperation(next);
        if (FINISHED_PHASES.has(next.phase)) {
          if (next.phase === 'complete') {
            await refresh();
            if (mountedRef.current) setOperation(null);
          }
          options.onOperationSettled?.(next);
          if (next.phase === 'complete' && typeof window !== 'undefined') {
            window.dispatchEvent(new window.CustomEvent('cc-agent-maintenance-changed', {
              detail: { targetId: config.api.targetId },
            }));
          }
          return;
        }
      } catch (caught) {
        if (!aborted(caught) && !stopped && mountedRef.current) setError(errorMessage(caught));
      }
      if (!stopped && mountedRef.current) {
        timer = window.setTimeout(() => { void poll(); }, Math.max(1, config.operationPollMs));
      }
    };
    timer = window.setTimeout(() => { void poll(); }, Math.max(1, config.operationPollMs));
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [config, operation?.id, operation?.phase, options.onOperationSettled, refresh, signal]);

  React.useEffect(() => {
    const changed = (): void => { void refresh(); };
    window.addEventListener('cc-agent-maintenance-changed', changed);
    return () => window.removeEventListener('cc-agent-maintenance-changed', changed);
  }, [refresh]);

  const operationBusyReason = agentMaintenanceBusyReason({ operation, restoring: restoringOperation, startingAgentId });

  return {
    api: config.api,
    statuses,
    targetKey,
    loading,
    checking,
    errors,
    error,
    operation,
    operationBusyReason,
    refresh,
    check,
    install,
    update,
    retry,
    cancel,
  };
}
