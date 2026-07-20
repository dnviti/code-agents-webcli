import * as React from 'react';

export type ProfileSidebarItemStatus = 'online' | 'busy' | 'error' | (string & {});

export interface ProfileSidebarItem {
  id: string;
  label: React.ReactNode;
  meta?: React.ReactNode;
  status?: ProfileSidebarItemStatus;
}

export interface ProfileSidebarGroup {
  label: React.ReactNode;
  items: ProfileSidebarItem[];
}

interface RowProps {
  it: ProfileSidebarItem;
  active: boolean;
  onSelect?: (id: string) => void;
}

function Row({ it, active, onSelect }: RowProps): React.JSX.Element {
  const [h, setH] = React.useState(false);
  const dot =
    it.status === 'online'
      ? 'var(--ansi-green)'
      : it.status === 'busy'
        ? 'var(--warning)'
        : it.status === 'error'
          ? 'var(--destructive)'
          : 'var(--neutral-500)';
  const rowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    padding: '0 12px',
    height: 32,
    cursor: 'pointer',
    background: active ? 'var(--accent)' : h ? 'var(--muted)' : 'transparent',
    boxShadow: active ? 'inset 2px 0 0 var(--foreground)' : 'none',
  };
  const dotStyle: React.CSSProperties = {
    width: 6,
    height: 6,
    flex: '0 0 auto',
    borderRadius: 'var(--radius-full)',
    background: dot,
  };
  const labelStyle: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-sm)',
    color: active ? 'var(--foreground)' : 'var(--sidebar-foreground)',
  };
  const metaStyle: React.CSSProperties = {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-2xs)',
    color: 'var(--sidebar-muted)',
  };
  return (
    <div
      onClick={() => onSelect && onSelect(it.id)}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      style={rowStyle}
    >
      <span style={dotStyle} />
      <span style={labelStyle}>{it.label}</span>
      {it.meta ? <span style={metaStyle}>{it.meta}</span> : null}
    </div>
  );
}

export interface ProfileSidebarProps {
  groups?: ProfileSidebarGroup[];
  activeId?: string;
  onSelect?: (id: string) => void;
  title?: React.ReactNode;
  width?: number;
  style?: React.CSSProperties;
}

export function ProfileSidebar({
  groups = [],
  activeId,
  onSelect,
  title = 'Connections',
  width = 232,
  style,
}: ProfileSidebarProps): React.JSX.Element {
  const rootStyle: React.CSSProperties = {
    width,
    flex: '0 0 ' + width + 'px',
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    background: 'var(--sidebar)',
    borderRight: '1px solid var(--border)',
    ...style,
  };
  const headerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 8px 0 12px',
    height: 38,
    borderBottom: '1px solid var(--border)',
  };
  const titleStyle: React.CSSProperties = {
    fontFamily: 'var(--font-sans)',
    fontSize: 'var(--text-2xs)',
    textTransform: 'uppercase',
    letterSpacing: 'var(--tracking-caps)',
    color: 'var(--muted-foreground)',
  };
  const plusStyle: React.CSSProperties = {
    color: 'var(--muted-foreground)',
    fontSize: 15,
    cursor: 'pointer',
    padding: '2px 6px',
  };
  const listStyle: React.CSSProperties = { flex: 1, overflow: 'auto', padding: '6px 0' };
  const groupLabelStyle: React.CSSProperties = {
    padding: '6px 12px 3px',
    fontFamily: 'var(--font-sans)',
    fontSize: 'var(--text-2xs)',
    textTransform: 'uppercase',
    letterSpacing: 'var(--tracking-caps)',
    color: 'var(--sidebar-muted)',
  };
  return (
    <div style={rootStyle}>
      <div style={headerStyle}>
        <span style={titleStyle}>{title}</span>
        <span style={plusStyle}>+</span>
      </div>
      <div style={listStyle}>
        {groups.map((g, gi) => (
          <div key={gi} style={{ marginBottom: 4 }}>
            <div style={groupLabelStyle}>{g.label}</div>
            {g.items.map((it) => (
              <Row key={it.id} it={it} active={it.id === activeId} onSelect={onSelect} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
