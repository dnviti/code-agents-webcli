import * as React from 'react';

import {
  AGENT_MAINTENANCE_IDS,
  agentCatalogEntry,
  type AgentMaintenanceId,
  type AgentMaintenanceOperation,
  type AgentMaintenanceStatus,
} from '../../shared/agent-maintenance';
import type { ChatController } from '../chat/controller';
import { useAgentMaintenance } from '../agent-maintenance/useAgentMaintenance';
import { showConfirm } from '../ui/confirm';
import { AgentMaintenanceStrip, type AgentRestartMode } from './AgentMaintenanceStrip';

export interface ActiveAgentMaintenanceProps {
  sessionId: string;
  serverId: string;
  targetName: string;
  agentKind: string;
  surface: 'terminal' | 'chat';
  chatController: ChatController | null;
  restartAgent(sessionId: string, automatic: boolean, allowFreshContext: boolean): void;
}

function maintenanceAgent(value: string): AgentMaintenanceId | null {
  return (AGENT_MAINTENANCE_IDS as readonly string[]).includes(value)
    ? value as AgentMaintenanceId
    : null;
}

export function chatLooksAutomaticSafe(controller: ChatController | null): boolean {
  if (!controller) return false;
  const transcript = controller.transcript;
  return transcript.chatState === 'idle'
    && transcript.capabilities.resume === true
    && transcript.pendingPermissions.length === 0
    && transcript.pendingQuestions.length === 0
    && transcript.queuedTurns.length === 0;
}

/**
 * The active-session strip is an exception surface, not permanent chrome.
 * Unknown/loading state renders nothing: only confirmed work, a failed check,
 * or a lifecycle error earns space above the session.
 */
export function shouldShowActiveAgentMaintenance(input: {
  status?: AgentMaintenanceStatus | null;
  operation?: AgentMaintenanceOperation | null;
  error?: string | null;
}): boolean {
  if (input.error) return true;
  if (input.operation && !['complete', 'cancelled'].includes(input.operation.phase)) return true;
  const status = input.status;
  if (!status) return false;
  if (status.state === 'missing') return true;
  if (status.check === 'update_available') return true;
  if (status.managedVersion && status.managedVersion !== status.version) return true;
  return status.check === 'unable_to_check' && status.checkedAt !== null;
}

/**
 * Session-bound agent maintenance. Key this component by session id: the hook
 * deliberately captures its initial server and target so a later desktop
 * selection cannot redirect an in-flight operation.
 */
export function ActiveAgentMaintenance({
  sessionId,
  serverId,
  targetName,
  agentKind,
  surface,
  chatController,
  restartAgent,
}: ActiveAgentMaintenanceProps): React.JSX.Element | null {
  const agentId = maintenanceAgent(agentKind);
  const operationKey = `cc-agent-maintenance-operation:${sessionId}`;
  const [operationId, setOperationId] = React.useState<string | null>(() => {
    try { return localStorage.getItem(operationKey); } catch { return null; }
  });
  const operationSettled = React.useCallback((operation: AgentMaintenanceOperation): void => {
    if (operation.phase !== 'complete') return;
    setOperationId(null);
    try { localStorage.removeItem(operationKey); } catch { /* optional */ }
    if (surface === 'chat' && chatLooksAutomaticSafe(chatController)) {
      restartAgent(sessionId, true, false);
    }
  }, [chatController, operationKey, restartAgent, sessionId, surface]);
  const maintenance = useAgentMaintenance({
    targetId: sessionId,
    serverId,
    agentId: agentId ?? undefined,
    enabled: Boolean(agentId),
    operationId,
    onOperationId: (id) => {
      setOperationId(id);
      try { localStorage.setItem(operationKey, id); } catch { /* optional */ }
    },
    onOperationSettled: operationSettled,
  });

  if (!agentId) return null;
  const status = maintenance.statuses[agentId];
  const operation = maintenance.operation?.agentId === agentId ? maintenance.operation : null;
  const error = maintenance.errors[agentId] || maintenance.error;
  if (!shouldShowActiveAgentMaintenance({ status, operation, error })) return null;
  const entry = agentCatalogEntry(agentId);
  const changedManagedCopy = Boolean(
    status?.managedVersion
    && status.managedVersion !== status.version,
  );
  let restartMode: AgentRestartMode = 'none';
  if (changedManagedCopy) {
    if (surface === 'chat' && chatController) {
      restartMode = chatLooksAutomaticSafe(chatController)
        ? 'safe'
        : 'confirmation_required';
    } else {
      restartMode = 'confirmation_required';
    }
  }

  const start = async (kind: 'install' | 'update'): Promise<void> => {
    let confirmed = false;
    if (status?.requiresConfirmation) {
      confirmed = await showConfirm({
        title: `${kind === 'update' ? 'Update' : 'Install'} ${entry?.label ?? agentId} on this shared host?`,
        description: 'This changes the installer-owned copy for every session using this shared host. Existing agent processes keep running until they are restarted.',
        confirmLabel: kind === 'update' ? 'Update shared copy' : 'Install shared copy',
        sessionId,
      });
      if (!confirmed) return;
    }
    if (kind === 'update') await maintenance.update(agentId, confirmed);
    else await maintenance.install(agentId, confirmed);
  };

  const confirmRestart = async (): Promise<void> => {
    const terminal = surface === 'terminal';
    const confirmed = await showConfirm({
      title: `Restart ${entry?.label ?? agentId}?`,
      description: terminal
        ? 'The agent process will stop and restart on the managed version. This tab, its working directory, and terminal scrollback stay in place, but the agent’s own in-progress interaction may not resume.'
        : 'Any running turn, queued message, approval, or question will stop with the current agent process. CODE AGENTS keeps the app transcript and resumes the agent when supported; otherwise the replacement starts with fresh agent context and may not remember the prior conversation.',
      confirmLabel: 'Restart agent',
      sessionId,
    });
    if (confirmed) restartAgent(sessionId, false, true);
  };

  return (
    <AgentMaintenanceStrip
      agentId={agentId}
      targetName={targetName}
      status={status}
      operation={operation}
      checking={maintenance.checking.includes(agentId) || maintenance.loading}
      error={error}
      blockedReason={maintenance.operationBusyReason}
      restartMode={restartMode}
      onInstall={() => start('install')}
      onUpdate={() => start('update')}
      onRetry={() => maintenance.operation?.retryable
        ? start(maintenance.operation.kind)
        : maintenance.check(agentId, true)}
      onCancel={() => maintenance.cancel()}
      onRestart={() => restartAgent(sessionId, true, false)}
      onConfirm={confirmRestart}
    />
  );
}
