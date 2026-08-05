import * as React from 'react';

import {
  agentCatalogEntry,
  type AgentMaintenanceId,
  type AgentMaintenanceOperation,
  type AgentMaintenanceStatus,
} from '../../shared/agent-maintenance.js';
import { Button } from '../ui/relay/Button.js';

type Action = () => void | Promise<void>;
export type AgentRestartMode = 'none' | 'safe' | 'confirmation_required';

export interface AgentMaintenanceStripProps {
  agentId: AgentMaintenanceId;
  targetName: string;
  status?: AgentMaintenanceStatus | null;
  /** A session-captured running version overrides host status when available. */
  runningVersion?: string | null;
  operation?: AgentMaintenanceOperation | null;
  checking?: boolean;
  error?: string | null;
  /** Explains why this row cannot start while another durable operation owns the target. */
  blockedReason?: string | null;
  restartMode?: AgentRestartMode;
  onInstall?: Action;
  onUpdate?: Action;
  onRetry?: Action;
  onCancel?: Action;
  onRestart?: Action;
  /** Opens the product-owned confirmation for a busy/chat or terminal restart. */
  onConfirm?: Action;
}

export interface AgentMaintenancePickerRowProps {
  status: AgentMaintenanceStatus;
  targetName: string;
  operation?: AgentMaintenanceOperation | null;
  checking?: boolean;
  error?: string | null;
  blockedReason?: string | null;
  onInstall?(agentId: AgentMaintenanceId): void | Promise<void>;
  onUpdate?(agentId: AgentMaintenanceId): void | Promise<void>;
  onRetry?(agentId: AgentMaintenanceId): void | Promise<void>;
  onCancel?(): void | Promise<void>;
}

const FINISHED_PHASES = new Set(['complete', 'failed', 'cancelled']);

const PHASE_LABELS: Record<AgentMaintenanceOperation['phase'], string> = {
  queued: 'Queued',
  downloading: 'Downloading',
  installing: 'Installing',
  verifying: 'Verifying',
  activating: 'Activating',
  complete: 'Complete',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

interface Presentation {
  label: string;
  color: string;
}

export function agentMaintenancePresentation(
  status: AgentMaintenanceStatus | null | undefined,
  operation: AgentMaintenanceOperation | null | undefined,
  checking = false,
  error?: string | null,
): Presentation {
  if (status?.state === 'project_managed') return { label: 'Project managed', color: 'var(--muted-foreground)' };
  if (operation) {
    const color = operation.phase === 'failed' ? 'var(--destructive)'
      : operation.phase === 'cancelled' ? 'var(--muted-foreground)'
        : operation.phase === 'complete' ? 'var(--success)'
          : 'var(--info)';
    return { label: PHASE_LABELS[operation.phase], color };
  }
  if (checking || status?.check === 'checking') return { label: 'Checking', color: 'var(--info)' };
  if (error || !status || status.check === 'unable_to_check') {
    return { label: 'Unable to check', color: 'var(--warning)' };
  }
  if (status.managedVersion && status.managedVersion !== status.version) {
    return { label: 'Restart to use', color: 'var(--warning)' };
  }
  if (status.check === 'update_available') return { label: 'Update available', color: 'var(--warning)' };
  return { label: 'Current', color: 'var(--success)' };
}

function versionLabel(version: string | null | undefined): string {
  return version ? `Version ${version}` : 'Version unknown';
}

function installStateLabel(status: AgentMaintenanceStatus | null | undefined): string {
  switch (status?.state) {
    case 'managed': return 'Managed';
    case 'external': return 'External copy';
    case 'missing': return 'Not installed';
    case 'project_managed': return 'Project managed';
    default: return 'Source unknown';
  }
}

function actionable(
  status: AgentMaintenanceStatus | null | undefined,
  operation: AgentMaintenanceOperation | null | undefined,
): 'install' | 'managed-copy' | 'update' | null {
  if (!status || (operation && !FINISHED_PHASES.has(operation.phase))) return null;
  if (status.state === 'missing' && status.canInstall) return 'install';
  if (status.canManageCopy && status.state === 'external') return 'managed-copy';
  if (status.state === 'managed' && status.check === 'update_available' && status.canInstall) return 'update';
  return null;
}

function ActionButtons({
  status,
  operation,
  error,
  blockedReason,
  restartMode = 'none',
  onInstall,
  onUpdate,
  onRetry,
  onCancel,
  onRestart,
  onConfirm,
  blockedDescriptionId,
}: Omit<AgentMaintenanceStripProps, 'agentId' | 'targetName' | 'runningVersion' | 'checking'> & {
  blockedDescriptionId?: string;
}): React.JSX.Element | null {
  const next = actionable(status, operation);
  const failed = operation?.phase === 'failed' || operation?.phase === 'cancelled';
  const unable = Boolean(error) || status?.check === 'unable_to_check';
  const controls: React.ReactNode[] = [];

  if ((next === 'install' || next === 'managed-copy') && onInstall) {
    controls.push(
      <Button
        key="install"
        size="sm"
        variant="outline"
        disabled={Boolean(blockedReason)}
        title={blockedReason || undefined}
        aria-describedby={blockedReason ? blockedDescriptionId : undefined}
        onClick={() => { if (!blockedReason) void onInstall(); }}
      >
        {next === 'managed-copy' ? 'Install managed copy' : 'Install'}
      </Button>,
    );
  } else if (next === 'update' && onUpdate) {
    controls.push(
      <Button
        key="update"
        size="sm"
        disabled={Boolean(blockedReason)}
        title={blockedReason || undefined}
        aria-describedby={blockedReason ? blockedDescriptionId : undefined}
        onClick={() => { if (!blockedReason) void onUpdate(); }}
      >
        Update
      </Button>,
    );
  }
  if (operation && !FINISHED_PHASES.has(operation.phase) && onCancel) {
    controls.push(
      <Button
        key="cancel"
        size="sm"
        variant="ghost"
        disabled={!operation.canCancel}
        title={!operation.canCancel ? operation.cancelReason || undefined : undefined}
        onClick={() => { if (operation.canCancel) void onCancel(); }}
      >
        Cancel
      </Button>,
    );
  }
  if ((unable || failed) && onRetry) {
    controls.push(<Button key="retry" size="sm" variant="outline" onClick={() => { void onRetry(); }}>Retry</Button>);
  }
  if (restartMode === 'safe' && onRestart) {
    controls.push(<Button key="restart" size="sm" onClick={() => { void onRestart(); }}>Restart agent</Button>);
  } else if (restartMode === 'confirmation_required' && onConfirm) {
    controls.push(<Button key="confirm" size="sm" variant="outline" onClick={() => { void onConfirm(); }}>Restart…</Button>);
  }

  if (controls.length === 0) return null;
  return <div role="group" aria-label="Agent maintenance actions" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>{controls}</div>;
}

function OfficialGuideLink({ agentId }: { agentId: AgentMaintenanceId }): React.JSX.Element | null {
  const entry = agentCatalogEntry(agentId);
  if (!entry) return null;
  return (
    <a
      href={entry.officialSource}
      target="_blank"
      rel="noopener noreferrer"
      style={{ color: 'var(--info)', textDecoration: 'underline', textUnderlineOffset: 2, whiteSpace: 'nowrap' }}
    >
      Official install guide
    </a>
  );
}

/**
 * Persistent, non-dismissible session notice. The inset rail borrows the
 * terminal cursor's single hard edge; words carry every state so color is
 * never the only signal.
 */
export function AgentMaintenanceStrip({
  agentId,
  targetName,
  status,
  runningVersion,
  operation,
  checking = false,
  error,
  blockedReason,
  restartMode = 'none',
  onInstall,
  onUpdate,
  onRetry,
  onCancel,
  onRestart,
  onConfirm,
}: AgentMaintenanceStripProps): React.JSX.Element {
  const entry = agentCatalogEntry(agentId);
  const presentation = agentMaintenancePresentation(status, operation, checking, error);
  const shownVersion = runningVersion !== undefined ? runningVersion : status?.version;
  const detail = operation?.error
    || (operation && !FINISHED_PHASES.has(operation.phase) && !operation.canCancel ? operation.cancelReason : null)
    || blockedReason || error || status?.disabledReason || status?.guidance;
  const manualFallback = Boolean(
    error || status?.check === 'unable_to_check' || status?.disabledReason || status?.guidance,
  );
  const descriptionId = React.useId();

  return (
    <section
      aria-label={`${entry?.label ?? agentId} version on ${targetName}`}
      aria-describedby={detail ? descriptionId : undefined}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        minHeight: 38,
        padding: '6px 10px 6px 13px',
        color: 'var(--foreground)',
        background: 'color-mix(in srgb, var(--secondary) 62%, var(--background))',
        borderBottom: '1px solid var(--border)',
        boxShadow: `inset 3px 0 0 ${presentation.color}`,
        fontFamily: 'var(--font-sans)',
        flexWrap: 'wrap',
      }}
    >
      <div style={{ display: 'grid', gap: 2, minWidth: 0, flex: '1 1 260px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, minWidth: 0, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--font-semibold)' }}>
            {entry?.label ?? agentId}
          </strong>
          {entry ? (
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: entry.channel === 'preview' ? 'var(--warning)' : 'var(--muted-foreground)' }}>
              {entry.channelLabel}
            </span>
          ) : null}
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--muted-foreground)' }}>
            {versionLabel(shownVersion)}
          </span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--muted-foreground)' }}>
            {installStateLabel(status)}
          </span>
          {(operation?.version || status?.latestVersion) && (operation?.version || status?.latestVersion) !== shownVersion ? (
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--muted-foreground)' }}>
              Target {operation?.version || status?.latestVersion}
            </span>
          ) : null}
          <span aria-hidden="true" style={{ color: 'var(--border-strong)' }}>·</span>
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--muted-foreground)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {targetName}
          </span>
          <span
            role="status"
            aria-live="polite"
            aria-atomic="true"
            style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: presentation.color }}
          >
            {presentation.label}
          </span>
        </div>
        {detail ? (
          <span id={descriptionId} style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', fontSize: 'var(--text-2xs)', lineHeight: 1.35, color: operation?.error || error ? 'var(--destructive)' : 'var(--muted-foreground)' }}>
            <span>{detail}</span>
            {manualFallback ? <OfficialGuideLink agentId={agentId} /> : null}
          </span>
        ) : null}
      </div>
      <ActionButtons
        status={status}
        operation={operation}
        error={error}
        blockedReason={blockedReason}
        blockedDescriptionId={descriptionId}
        restartMode={restartMode}
        onInstall={onInstall}
        onUpdate={onUpdate}
        onRetry={onRetry}
        onCancel={onCancel}
        onRestart={onRestart}
        onConfirm={onConfirm}
      />
    </section>
  );
}

/** A one-agent launcher row; actions never close or retarget the surrounding picker. */
export function AgentMaintenancePickerRow({
  status,
  targetName,
  operation,
  checking = false,
  error,
  blockedReason,
  onInstall,
  onUpdate,
  onRetry,
  onCancel,
}: AgentMaintenancePickerRowProps): React.JSX.Element {
  const entry = agentCatalogEntry(status.agentId);
  const presentation = agentMaintenancePresentation(status, operation, checking, error);
  const detail = operation?.error
    || (operation && !FINISHED_PHASES.has(operation.phase) && !operation.canCancel ? operation.cancelReason : null)
    || blockedReason || error || status.disabledReason || status.guidance;
  const manualFallback = Boolean(
    error || status.check === 'unable_to_check' || status.disabledReason || status.guidance,
  );
  const descriptionId = React.useId();
  return (
    <div
      role="group"
      aria-label={`${entry?.label ?? status.agentId} maintenance on ${targetName}`}
      aria-describedby={detail ? descriptionId : undefined}
      title={detail || undefined}
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) auto',
        alignItems: 'center',
        gap: 10,
        padding: '7px 9px',
        borderTop: '1px solid var(--border)',
        boxShadow: `inset 2px 0 0 ${presentation.color}`,
      }}
    >
      <div style={{ minWidth: 0, display: 'grid', gap: 2 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--foreground)' }}>{entry?.label ?? status.agentId}</span>
          {entry ? (
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: entry.channel === 'preview' ? 'var(--warning)' : 'var(--muted-foreground)' }}>
              {entry.channelLabel}
            </span>
          ) : null}
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--muted-foreground)' }}>
            {versionLabel(status.version)}
          </span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--muted-foreground)' }}>
            {installStateLabel(status)}
          </span>
          {(operation?.version || status.latestVersion) && (operation?.version || status.latestVersion) !== status.version ? (
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--muted-foreground)' }}>
              Target {operation?.version || status.latestVersion}
            </span>
          ) : null}
          <span role="status" aria-live="polite" style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: presentation.color }}>
            {presentation.label}
          </span>
        </div>
        {detail ? (
          <span id={descriptionId} style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', fontSize: 'var(--text-2xs)', lineHeight: 1.35, color: operation?.error || error ? 'var(--destructive)' : 'var(--muted-foreground)' }}>
            <span>{detail}</span>
            {manualFallback ? <OfficialGuideLink agentId={status.agentId} /> : null}
          </span>
        ) : null}
      </div>
      <ActionButtons
        status={status}
        operation={operation}
        error={error}
        blockedReason={blockedReason}
        blockedDescriptionId={descriptionId}
        onInstall={onInstall ? () => onInstall(status.agentId) : undefined}
        onUpdate={onUpdate ? () => onUpdate(status.agentId) : undefined}
        onRetry={onRetry ? () => onRetry(status.agentId) : undefined}
        onCancel={onCancel}
      />
    </div>
  );
}
