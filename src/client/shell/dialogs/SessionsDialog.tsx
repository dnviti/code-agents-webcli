import * as React from 'react';

import type { SessionListItem } from '../../types';
import { Button } from '../../ui/relay/Button';
import { Dialog } from '../../ui/relay/Dialog';
import { Icon } from '../../ui/relay/Icon';
import { IconButton } from '../../ui/relay/IconButton';

export interface SessionsDialogProps {
  open: boolean;
  sessions: SessionListItem[];
  activeId: string | null;
  onJoin(id: string): void;
  onLeave(): void;
  onDelete(id: string): void;
  onNew(): void;
  onClose(): void;
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

function clientsLabel(count: number): string {
  return count === 1 ? '1 client' : `${count} clients`;
}

/** Last path segment; `/` keeps a label when the session sits at the root. */
function folderLabel(workingDir: string): string {
  return workingDir.split('/').filter(Boolean).pop() || '/';
}

function SessionCard({
  session,
  isActive,
  onJoin,
  onLeave,
  onDelete,
}: {
  session: SessionListItem;
  isActive: boolean;
  onJoin(id: string): void;
  onLeave(): void;
  onDelete(id: string): void;
}): React.JSX.Element {
  return (
    <div style={{ ...cardStyle, borderColor: isActive ? 'var(--ring)' : 'var(--border)' }}>
      <span
        aria-hidden="true"
        style={{
          width: 7,
          height: 7,
          flex: '0 0 auto',
          borderRadius: 'var(--radius-full)',
          background: session.active ? 'var(--ansi-green)' : 'var(--muted-foreground)',
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
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
          {session.name}
        </div>
        <div style={{ marginTop: 2, fontSize: 'var(--text-xs)', color: 'var(--muted-foreground)' }}>
          {clientsLabel(session.connectedClients)} · {new Date(session.created).toLocaleTimeString()}
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
              fontSize: 'var(--text-2xs)',
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, flex: '0 0 auto' }}>
        {isActive ? (
          <IconButton label="Leave session" onClick={onLeave}>
            <Icon name="log-out" size={15} />
          </IconButton>
        ) : (
          <IconButton label="Join session" onClick={() => onJoin(session.id)}>
            <Icon name="chevron-right" size={15} />
          </IconButton>
        )}
        <IconButton label="Delete session" onClick={() => onDelete(session.id)}>
          <Icon name="trash-2" size={15} />
        </IconButton>
      </div>
    </div>
  );
}

export function SessionsDialog({
  open,
  sessions,
  activeId,
  onJoin,
  onLeave,
  onDelete,
  onNew,
  onClose,
}: SessionsDialogProps): React.JSX.Element | null {
  if (!open) return null;

  return (
    <Dialog
      open={open}
      title="Sessions"
      onClose={onClose}
      width={560}
      footer={
        <Button variant="primary" iconLeft={<Icon name="plus" size={14} />} onClick={onNew}>
          New session
        </Button>
      }
    >
      {sessions.length === 0 ? (
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
          No active sessions
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
          {sessions.map((session) => (
            <SessionCard
              key={session.id}
              session={session}
              isActive={session.id === activeId}
              onJoin={onJoin}
              onLeave={onLeave}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </Dialog>
  );
}
