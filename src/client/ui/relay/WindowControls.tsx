import * as React from 'react';

/**
 * 'none' is an addition to the Relay kit, which assumes a native window and
 * offers only 'mac' and 'windows'. This app runs in a browser tab: rendering
 * traffic lights or caption glyphs would draw buttons that close, minimise and
 * maximise nothing. 'none' keeps the title bar and its toolbar slot and drops
 * the decoration.
 */
export type WindowControlsOS = 'mac' | 'windows' | 'none';

export interface WindowControlsProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'style' | 'title'> {
  title?: string;
  os?: WindowControlsOS;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}

export function WindowControls({ title = 'relay', os = 'mac', children, style }: WindowControlsProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', height: 38, background: 'var(--chrome)', borderBottom: '1px solid var(--border)', padding: '0 10px', gap: 12, userSelect: 'none', ...style }}>
      {os === 'mac' ? (
        <div style={{ display: 'flex', gap: 8 }}>
          {['#ff5f57', '#febc2e', '#28c840'].map((c) => <span key={c} style={{ width: 11, height: 11, borderRadius: 'var(--radius-full)', background: c }} />)}
        </div>
      ) : null}
      <div style={{ flex: 1, textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', color: 'var(--muted-foreground)', letterSpacing: '0.02em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</div>
      <div style={{ display: 'flex', gap: 2, alignItems: 'center' }}>{children}</div>
      {os === 'windows' ? (
        <div style={{ display: 'flex', marginLeft: 4 }}>
          {['—', '▢', '✕'].map((g, i) => <span key={i} style={{ width: 30, height: 38, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted-foreground)', fontSize: 11 }}>{g}</span>)}
        </div>
      ) : null}
    </div>
  );
}
