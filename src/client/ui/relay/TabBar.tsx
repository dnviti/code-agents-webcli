import * as React from 'react';

export type TabStatus = 'running' | 'error' | (string & {});

export interface TabItem {
  id: string;
  title?: React.ReactNode;
  status?: TabStatus;
}

interface TabProps {
  tab: TabItem;
  active: boolean;
  onSelect?: (id: string) => void;
  onClose?: (id: string) => void;
}

function Tab({ tab, active, onSelect, onClose }: TabProps): React.JSX.Element {
  const [hover, setHover] = React.useState(false);
  const dot = tab.status === 'running' ? 'var(--ansi-green)' : tab.status === 'error' ? 'var(--destructive)' : 'var(--muted-foreground)';
  const wrapperStyle: React.CSSProperties = {
    position: 'relative', display: 'flex', alignItems: 'center', gap: 8, padding: '0 8px 0 12px',
    minWidth: 128, maxWidth: 208, height: '100%', cursor: 'pointer', borderRight: '1px solid var(--border)',
    background: active ? 'var(--tab-active)' : (hover ? 'var(--tab-inactive)' : 'transparent'),
    color: active ? 'var(--tab-active-foreground)' : 'var(--tab-inactive-foreground)',
    boxShadow: active ? 'inset 0 2px 0 var(--foreground)' : 'none',
  };
  const dotStyle: React.CSSProperties = {
    width: 6, height: 6, flex: '0 0 auto', borderRadius: 'var(--radius-full)', background: dot,
    animation: tab.status === 'running' ? 'relay-pulse 1.6s ease-in-out infinite' : 'none',
  };
  const labelStyle: React.CSSProperties = {
    flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)',
  };
  const closeStyle: React.CSSProperties = {
    flex: '0 0 auto', width: 16, height: 16, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    border: 'none', background: 'transparent', color: 'var(--muted-foreground)', borderRadius: 'var(--radius)',
    cursor: 'pointer', fontSize: 11, lineHeight: 1, opacity: hover || active ? 1 : 0,
  };
  return (
    <div
      onClick={() => onSelect && onSelect(tab.id)}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={wrapperStyle}
    >
      {tab.status ? <span style={dotStyle} /> : null}
      <span style={labelStyle}>{tab.title}</span>
      <button
        onClick={(e: React.MouseEvent<HTMLButtonElement>) => { e.stopPropagation(); onClose && onClose(tab.id); }}
        aria-label="Close tab"
        style={closeStyle}
      >✕</button>
    </div>
  );
}

export interface TabBarProps {
  tabs?: TabItem[];
  activeId?: string;
  onSelect?: (id: string) => void;
  onClose?: (id: string) => void;
  onNew?: React.MouseEventHandler<HTMLButtonElement>;
  style?: React.CSSProperties;
}

export function TabBar({ tabs = [], activeId, onSelect, onClose, onNew, style }: TabBarProps): React.JSX.Element {
  const [hoverNew, setHoverNew] = React.useState(false);
  const barStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'stretch', height: 36, background: 'var(--tab-bar)', borderBottom: '1px solid var(--border)', ...style,
  };
  const listStyle: React.CSSProperties = { display: 'flex', alignItems: 'stretch', overflow: 'hidden' };
  const newStyle: React.CSSProperties = {
    width: 34, flex: '0 0 auto', border: 'none', borderRight: '1px solid var(--border)',
    background: hoverNew ? 'var(--accent)' : 'transparent', color: 'var(--muted-foreground)',
    cursor: 'pointer', fontSize: 16, lineHeight: 1,
  };
  return (
    <div style={barStyle}>
      <div style={listStyle}>
        {tabs.map((t) => <Tab key={t.id} tab={t} active={t.id === activeId} onSelect={onSelect} onClose={onClose} />)}
      </div>
      <button
        onClick={onNew} onMouseEnter={() => setHoverNew(true)} onMouseLeave={() => setHoverNew(false)}
        aria-label="New tab" title="New tab"
        style={newStyle}
      >+</button>
      <div style={{ flex: 1 }} />
    </div>
  );
}
