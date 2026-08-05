import * as React from 'react';

import { controllerTargetAvailability, type ServerTarget } from '../controller/types';
import { Badge, type BadgeVariant } from '../ui/relay/Badge';
import { Icon } from '../ui/relay/Icon';

type TargetState = Pick<
  ServerTarget,
  'name' | 'connection' | 'auth' | 'compatibility' | 'certificate' | 'insecure'
>;

export interface ServerTargetBadgeProps {
  target: TargetState;
  compact?: boolean;
}

/**
 * Why a target cannot safely accept work right now.
 *
 * Kept as one shared decision for the server list, the session list and the
 * new-session chooser. Otherwise a signed-out server can be disabled in one
 * place and accidentally remain launchable in another.
 */
export function serverTargetAvailability(
  target: Pick<ServerTarget, 'connection' | 'auth' | 'compatibility' | 'certificate'>,
): string | null {
  return controllerTargetAvailability(target);
}

function badgePresentation(target: TargetState): {
  label: string;
  icon: string;
  variant: BadgeVariant;
} {
  const unavailable = serverTargetAvailability(target);
  if (unavailable) {
    const waiting = unavailable === 'Connecting';
    return {
      label: unavailable,
      icon: waiting ? 'loader-circle' : 'circle-alert',
      variant: waiting ? 'warning' : 'destructive',
    };
  }
  if (target.insecure || target.certificate === 'overridden') {
    return { label: 'Insecure connection', icon: 'shield', variant: 'warning' };
  }
  return { label: 'Ready', icon: 'circle-check', variant: 'success' };
}

/** A server name and its state, both visible without relying on colour. */
export function ServerTargetBadge({ target, compact = false }: ServerTargetBadgeProps): React.JSX.Element {
  const presentation = badgePresentation(target);
  const label = `${target.name}: ${presentation.label}`;
  return (
    <Badge variant={presentation.variant} aria-label={label} style={compact ? { maxWidth: '100%' } : undefined}>
      <Icon name={presentation.icon} size={11} />
      <span style={compact ? { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } : undefined}>
        {target.name} · {presentation.label}
      </span>
    </Badge>
  );
}
