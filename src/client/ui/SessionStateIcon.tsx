import * as React from 'react';

import type { ConversationAttention } from '../../shared/chat-alerts';
import { Icon, type IconName } from './relay/Icon';

export type SessionDisplayState =
  | 'working'
  | 'waiting-approval'
  | 'waiting-input'
  | 'success'
  | 'error'
  | 'idle';

export interface SessionStateSource {
  status?: string;
  unread?: boolean;
  attention?: ConversationAttention | null;
}

export interface SessionStateVisual {
  state: SessionDisplayState;
  icon: IconName;
  color: string;
  label: string;
  spin?: boolean;
}

/**
 * One visual language for session state everywhere tabs appear.
 *
 * Priority is intentional: a live process can still be blocked on a person,
 * and an error must not be softened into an unread-success mark. Unread idle
 * output is the existing cross-tab completion signal; opening the tab clears
 * it and returns the icon to idle.
 */
export function sessionStateVisual(source: SessionStateSource): SessionStateVisual {
  if (source.status === 'error') {
    return {
      state: 'error',
      icon: 'circle-x',
      color: 'var(--destructive)',
      label: 'Error',
    };
  }
  if (source.attention === 'approval') {
    return {
      state: 'waiting-approval',
      icon: 'shield',
      color: 'var(--warning)',
      label: 'Waiting for approval',
    };
  }
  if (source.attention === 'question') {
    return {
      state: 'waiting-input',
      icon: 'circle-help',
      color: 'var(--info)',
      label: 'Waiting for input',
    };
  }
  if (source.status === 'running') {
    return {
      state: 'working',
      icon: 'loader-circle',
      color: 'var(--ansi-cyan)',
      label: 'Working',
      spin: true,
    };
  }
  if (source.status === 'success' || source.unread) {
    return {
      state: 'success',
      icon: 'circle-check',
      color: 'var(--success)',
      label: 'Completed',
    };
  }
  return {
    state: 'idle',
    icon: 'circle',
    color: 'var(--muted-foreground)',
    label: 'Idle',
  };
}

export interface SessionStateIconProps extends SessionStateSource {
  size?: number;
  style?: React.CSSProperties;
}

export function SessionStateIcon({
  status,
  unread,
  attention,
  size = 14,
  style,
}: SessionStateIconProps): React.JSX.Element {
  const visual = sessionStateVisual({ status, unread, attention });

  return (
    <span
      role="img"
      aria-label={visual.label}
      data-tab-state={visual.state}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: '0 0 auto',
        width: size,
        height: size,
        color: visual.color,
        ...style,
      }}
    >
      <Icon
        name={visual.icon}
        size={size}
        style={{ animation: visual.spin ? 'relay-spin 900ms linear infinite' : 'none' }}
      />
    </span>
  );
}
