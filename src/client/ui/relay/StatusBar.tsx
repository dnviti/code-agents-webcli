import * as React from 'react';

export interface StatusBarSegment {
  icon?: React.ReactNode;
  dot?: string;
  color?: string;
  title?: string;
  children?: React.ReactNode;
}

function Seg({ icon, dot, color, title, children }: StatusBarSegment): React.JSX.Element {
  const [h, setH] = React.useState(false);
  const segStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    height: '100%',
    padding: '0 8px',
    cursor: 'default',
    background: h ? 'var(--accent)' : 'transparent',
    color: color || 'var(--muted-foreground)',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-xs)',
  };
  const dotStyle: React.CSSProperties = {
    width: 6,
    height: 6,
    borderRadius: 'var(--radius-full)',
    background: dot,
  };
  return (
    <div title={title}
      onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
      style={segStyle}>
      {dot ? <span style={dotStyle} /> : null}
      {icon ? <span>{icon}</span> : null}
      {children}
    </div>
  );
}

export interface StatusBarProps {
  left?: StatusBarSegment[];
  right?: StatusBarSegment[];
  style?: React.CSSProperties;
}

export function StatusBar({ left = [], right = [], style }: StatusBarProps): React.JSX.Element {
  const rootStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 24,
    background: 'var(--chrome)',
    borderTop: '1px solid var(--border)',
    ...style,
  };
  const groupStyle: React.CSSProperties = { display: 'flex', alignItems: 'stretch', height: '100%' };
  return (
    <div style={rootStyle}>
      <div style={groupStyle}>{left.map((s, i) => <Seg key={i} {...s} />)}</div>
      <div style={groupStyle}>{right.map((s, i) => <Seg key={i} {...s} />)}</div>
    </div>
  );
}
