import * as React from 'react';

export interface KbdProps {
  children?: React.ReactNode;
  style?: React.CSSProperties;
}

export function Kbd({ children, style }: KbdProps) {
  return (
    <kbd
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 18,
        height: 18,
        padding: '0 5px',
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--text-2xs)',
        color: 'var(--muted-foreground)',
        lineHeight: 1,
        background: 'var(--muted)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        ...style,
      }}
    >
      {children}
    </kbd>
  );
}
