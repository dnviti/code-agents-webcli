import * as React from 'react';

import { usePhone } from '../touch';

export interface SettingRowProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'style' | 'children'> {
  label: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}

export function SettingRow({ label, description, children, style }: SettingRowProps) {
  // Side by side is a desktop shape. On a phone the control keeps its own width
  // — a select, a slider, a column of switches — and what gives way is the
  // explanation beside it, which ends up set one word to a line: "Sets / the /
  // terminal / palette / and / the / light/dark / side". Stacked, the sentence
  // gets the width of the screen and the control sits under it.
  const isPhone = usePhone();

  return (
    <div style={{
      display: 'flex',
      flexDirection: isPhone ? 'column' : 'row',
      alignItems: isPhone ? 'stretch' : 'center',
      justifyContent: 'space-between',
      gap: isPhone ? 12 : 24,
      padding: '14px 0',
      borderBottom: '1px solid var(--border)',
      ...style,
    }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--text-ui)', fontWeight: 'var(--font-medium)', color: 'var(--foreground)' }}>{label}</div>
        {description ? <div style={{ marginTop: 2, fontFamily: 'var(--font-sans)', fontSize: 'var(--text-sm)', color: 'var(--muted-foreground)', lineHeight: 'var(--leading-snug)' }}>{description}</div> : null}
      </div>
      <div style={{ flex: '0 0 auto', alignSelf: isPhone ? 'flex-start' : undefined }}>{children}</div>
    </div>
  );
}
