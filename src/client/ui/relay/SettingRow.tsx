import * as React from 'react';

export interface SettingRowProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'style' | 'children'> {
  label: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}

export function SettingRow({ label, description, children, style }: SettingRowProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24, padding: '14px 0', borderBottom: '1px solid var(--border)', ...style }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--text-ui)', fontWeight: 'var(--font-medium)', color: 'var(--foreground)' }}>{label}</div>
        {description ? <div style={{ marginTop: 2, fontFamily: 'var(--font-sans)', fontSize: 'var(--text-sm)', color: 'var(--muted-foreground)', lineHeight: 'var(--leading-snug)' }}>{description}</div> : null}
      </div>
      <div style={{ flex: '0 0 auto' }}>{children}</div>
    </div>
  );
}
