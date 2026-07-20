import * as React from 'react';

import { Icon } from './Icon';
import { Kbd } from './Kbd';

export interface LaunchCardProps {
  icon: string;
  label: string;
  meta?: React.ReactNode;
  keys?: string[];
  onClick?: () => void;
  /** Rendered at the right edge, after any keys. Its own click target. */
  action?: React.ReactNode;
  style?: React.CSSProperties;
}

export function LaunchCard({
  icon,
  label,
  meta,
  keys,
  onClick,
  action,
  style,
}: LaunchCardProps): React.JSX.Element {
  const [hover, setHover] = React.useState(false);
  const [focus, setFocus] = React.useState(false);

  const activate = (): void => {
    onClick?.();
  };

  return (
    <div
      // A real button role rather than a bare div: this is the primary way to
      // start a session, so it has to be reachable without a mouse.
      role="button"
      tabIndex={0}
      onClick={activate}
      onKeyDown={(e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activate();
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 14px',
        cursor: 'pointer',
        outline: 'none',
        background: hover ? 'var(--accent)' : 'var(--card)',
        border: `1px solid ${hover ? 'var(--border-strong)' : 'var(--border)'}`,
        boxShadow: focus ? 'var(--shadow-focus)' : undefined,
        transition: 'background var(--duration-fast), border-color var(--duration-fast)',
        ...style,
      }}
    >
      <span
        style={{
          width: 30,
          height: 30,
          flex: '0 0 auto',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--foreground)',
          background: 'var(--muted)',
          border: '1px solid var(--border)',
        }}
      >
        <Icon name={icon} size={16} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontFamily: 'var(--font-sans)',
            fontSize: 'var(--text-ui)',
            fontWeight: 'var(--font-medium)',
            color: 'var(--foreground)',
          }}
        >
          {label}
        </div>
        {meta ? (
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-2xs)',
              color: 'var(--muted-foreground)',
              marginTop: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {meta}
          </div>
        ) : null}
      </span>
      {keys ? (
        <span style={{ display: 'flex', gap: 3, flex: '0 0 auto' }}>
          {keys.map((k) => (
            <Kbd key={k}>{k}</Kbd>
          ))}
        </span>
      ) : null}
      {action ? <span style={{ flex: '0 0 auto' }}>{action}</span> : null}
    </div>
  );
}
