import * as React from 'react';

import type { ServerTarget } from '../../controller/types';
import type { SessionListItem } from '../../types';
import { Button } from '../../ui/relay/Button';
import { Dialog } from '../../ui/relay/Dialog';
import { Icon } from '../../ui/relay/Icon';
import { IconButton } from '../../ui/relay/IconButton';
import { Select } from '../../ui/relay/Select';
import { PHONE_TEXT, TOUCH_GAP, TOUCH_TARGET, usePhone } from '../../ui/touch';
import { ServerTargetBadge, serverTargetAvailability } from '../ServerTargetBadge';

export type ControllerSessionListItem = SessionListItem & {
  runtime?: string;
  runtimeLabel?: string;
};

export interface SessionsDialogProps {
  open: boolean;
  sessions: ControllerSessionListItem[];
  activeId: string | null;
  activeServerId?: string | null;
  onJoin(id: string, serverId?: string): void;
  onLeave(serverId?: string): void;
  onDelete(id: string, target?: { serverId?: string; serverName?: string }): void;
  onNew(): void;
  onClose(): void;
  serverTargets?: ServerTarget[];
  onRetryServer?: (serverId: string) => void;
  onEditServer?: (serverId: string) => void;
}

const cardStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 12px',
  background: 'var(--card)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius)',
};

function clientsLabel(count: number | undefined): string {
  if (!Number.isFinite(count)) return 'Cached metadata';
  return count === 1 ? '1 client' : `${count} clients`;
}

/** Last path segment; `/` keeps a label when the session sits at the root. */
function folderLabel(workingDir: string): string {
  return workingDir.split(/[\\/]/).filter(Boolean).pop() || '/';
}

function lastActivityValue(session: ControllerSessionListItem): number {
  const value = new Date(session.lastActivity ?? session.created).getTime();
  return Number.isFinite(value) ? value : 0;
}

function activityLabel(session: ControllerSessionListItem): string {
  const value = lastActivityValue(session);
  return value > 0 ? new Date(value).toLocaleString() : 'Last activity unknown';
}

function sessionAvailability(
  session: ControllerSessionListItem,
  target: ServerTarget | undefined,
): string | null {
  if (target) return serverTargetAvailability(target);
  if (session.serverStatus === 'offline' || session.serverStatus === 'error') return 'Server offline';
  if (session.serverStatus === 'connecting') return 'Connecting';
  if (session.serverStatus === 'unknown') return 'Availability unknown';
  return null;
}

function SessionCard({
  session,
  isActive,
  target,
  controllerMode,
  onJoin,
  onLeave,
  onDelete,
  onRetryServer,
  onEditServer,
}: {
  session: ControllerSessionListItem;
  isActive: boolean;
  target?: ServerTarget;
  controllerMode: boolean;
  onJoin(id: string, serverId?: string): void;
  onLeave(serverId?: string): void;
  onDelete(id: string, target?: { serverId?: string; serverName?: string }): void;
  onRetryServer?: (serverId: string) => void;
  onEditServer?: (serverId: string) => void;
}): React.JSX.Element {
  const isPhone = usePhone();
  const unavailable = sessionAvailability(session, target);
  const disabled = Boolean(unavailable);
  const name = session.customName || session.name;
  const targetId = target?.id ?? session.serverId;
  const targetName = target?.name ?? session.serverName;
  const sessionState = session.active ? 'Running' : 'Idle';
  const insecure = target?.insecure === true || target?.certificate === 'overridden' || session.serverInsecure;

  return (
    <div
      style={{
        ...cardStyle,
        alignItems: isPhone ? 'flex-start' : 'center',
        flexWrap: isPhone ? 'wrap' : 'nowrap',
        borderColor: isActive ? 'var(--ring)' : 'var(--border)',
      }}
    >
      <span
        aria-label={sessionState}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          flex: '0 0 auto',
          color: session.active ? 'var(--success)' : 'var(--muted-foreground)',
          fontSize: isPhone ? PHONE_TEXT.meta : 'var(--text-xs)',
        }}
      >
        <Icon name={session.active ? 'circle-check' : 'circle'} size={12} />
        <span>{sessionState}</span>
      </span>

      <div style={{ flex: 1, minWidth: isPhone ? 'calc(100% - 90px)' : 0 }}>
        {/* Names and paths are user-controlled and shared between users here, so
            they are rendered as text children and never as markup. */}
        <div
          style={{
            fontSize: 'var(--text-ui)',
            color: 'var(--foreground)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {name}
        </div>

        {controllerMode || targetName ? (
          <div style={{ marginTop: 5, maxWidth: '100%' }}>
            {target ? (
              <ServerTargetBadge target={target} compact />
            ) : (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  fontSize: isPhone ? PHONE_TEXT.meta : 'var(--text-xs)',
                  color: unavailable ? 'var(--destructive)' : 'var(--muted-foreground)',
                }}
              >
                <Icon name={unavailable ? 'circle-alert' : 'server'} size={12} />
                Server: {targetName ?? 'Unknown server'} · {unavailable ?? 'Ready'}
              </span>
            )}
          </div>
        ) : null}

        {insecure && !target ? (
          <div
            role="note"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              marginTop: 4,
              color: 'var(--warning)',
              fontSize: isPhone ? PHONE_TEXT.meta : 'var(--text-xs)',
            }}
          >
            <Icon name="shield" size={12} /> Insecure connection
          </div>
        ) : null}

        {session.projectName || session.projectId ? (
          <div
            style={{
              marginTop: 4,
              fontSize: isPhone ? PHONE_TEXT.meta : 'var(--text-2xs)',
              color: 'var(--primary)',
            }}
          >
            Project: {session.projectName || session.projectId}
            {session.projectWorkingDirKind === 'container' ? ' · Container workspace' : ''}
          </div>
        ) : null}

        <div
          style={{
            marginTop: 3,
            fontSize: isPhone ? PHONE_TEXT.meta : 'var(--text-xs)',
            color: 'var(--muted-foreground)',
          }}
        >
          {session.runtimeLabel || session.runtime ? `${session.runtimeLabel || session.runtime} · ` : ''}
          {clientsLabel(session.connectedClients)} · {activityLabel(session)}
        </div>

        {session.workingDir ? (
          <div
            title={session.workingDir}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              marginTop: 6,
              maxWidth: '100%',
              padding: '2px 7px',
              background: 'var(--secondary)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-full)',
              fontFamily: 'var(--font-mono)',
              fontSize: isPhone ? PHONE_TEXT.meta : 'var(--text-2xs)',
              color: 'var(--muted-foreground)',
            }}
          >
            <Icon name="folder" size={11} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {folderLabel(session.workingDir)}
            </span>
          </div>
        ) : null}
      </div>

      <div
        aria-label={`Actions for ${name}`}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: isPhone ? TOUCH_GAP : 2,
          flex: isPhone ? '1 0 100%' : '0 0 auto',
        }}
      >
        {isActive ? (
          <IconButton label="Leave session" disabled={disabled} onClick={() => onLeave(targetId)}>
            <Icon name="log-out" size={15} />
          </IconButton>
        ) : (
          <IconButton
            label="Join session"
            disabled={disabled}
            onClick={() => onJoin(session.id, targetId)}
          >
            <Icon name="chevron-right" size={15} />
          </IconButton>
        )}
        <IconButton
          label={`Delete ${name}`}
          disabled={disabled}
          onClick={() => onDelete(session.id, { serverId: targetId, serverName: targetName })}
        >
          <Icon name="trash-2" size={15} />
        </IconButton>

        {disabled && targetId ? (
          <>
            <IconButton
              label={`Retry ${targetName ?? 'server'}`}
              disabled={!onRetryServer || target?.canRetry === false}
              onClick={() => onRetryServer?.(targetId)}
            >
              <Icon name="rotate-cw" size={15} />
            </IconButton>
            {target?.kind === 'remote' && target.canEdit !== false ? (
              <IconButton
                label={`Edit ${targetName ?? 'server'}`}
                disabled={!onEditServer}
                onClick={() => onEditServer?.(targetId)}
              >
                <Icon name="pencil" size={15} />
              </IconButton>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

export function SessionsDialog({
  open,
  sessions,
  activeId,
  activeServerId,
  onJoin,
  onLeave,
  onDelete,
  onNew,
  onClose,
  serverTargets,
  onRetryServer,
  onEditServer,
}: SessionsDialogProps): React.JSX.Element | null {
  const [serverFilter, setServerFilter] = React.useState('all');

  if (!open) return null;

  const visibleSessions = sessions
    .filter((session) => serverFilter === 'all' || session.serverId === serverFilter)
    .slice()
    .sort((left, right) => lastActivityValue(right) - lastActivityValue(left));

  return (
    <Dialog
      open
      title="Sessions"
      onClose={onClose}
      width={560}
      footer={
        <Button variant="primary" iconLeft={<Icon name="plus" size={14} />} onClick={onNew}>
          New session
        </Button>
      }
    >
      {serverTargets !== undefined ? (
        <label
          style={{
            display: 'grid',
            gap: 5,
            marginBottom: 12,
            fontSize: 'var(--text-sm)',
            color: 'var(--muted-foreground)',
          }}
        >
          Filter by server
          <Select
            aria-label="Filter sessions by server"
            value={serverFilter}
            onChange={(event) => setServerFilter(event.target.value)}
            style={{ minHeight: TOUCH_TARGET }}
            options={[
              { value: 'all', label: 'All servers' },
              ...serverTargets.map((target) => ({ value: target.id, label: target.name })),
            ]}
          />
        </label>
      ) : null}

      {visibleSessions.length === 0 ? (
        <div
          style={{
            padding: '28px 16px',
            textAlign: 'center',
            border: '1px dashed var(--border)',
            borderRadius: 'var(--radius)',
            fontSize: 'var(--text-sm)',
            color: 'var(--muted-foreground)',
          }}
        >
          {sessions.length === 0 ? 'No active sessions' : 'No sessions match this server.'}
        </div>
      ) : (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            maxHeight: '52vh',
            overflowY: 'auto',
          }}
        >
          {visibleSessions.map((session) => {
            const target = serverTargets?.find((candidate) => candidate.id === session.serverId);
            const isActive = session.id === activeId
              && (activeServerId === undefined || session.serverId === activeServerId);
            return (
              <SessionCard
                key={`${session.serverId ?? 'legacy'}:${session.id}`}
                session={session}
                isActive={isActive}
                target={target}
                controllerMode={serverTargets !== undefined}
                onJoin={onJoin}
                onLeave={onLeave}
                onDelete={onDelete}
                onRetryServer={onRetryServer}
                onEditServer={onEditServer}
              />
            );
          })}
        </div>
      )}
    </Dialog>
  );
}
