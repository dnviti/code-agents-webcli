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

/**
 * `:focus-visible` is unsupported in some older engines and in jsdom, where
 * `matches` throws on the selector. Failing open shows the ring rather than
 * silently stranding keyboard users with no focus indicator at all.
 */
function isKeyboardFocus(element: Element): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true;
  }
}

function Row({ it, active, onSelect }: RowProps): React.JSX.Element {
  const [h, setH] = React.useState(false);
  const [keyboardFocus, setKeyboardFocus] = React.useState(false);
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
    // The selected marker and the focus ring are independent, so both are kept
    // when a selected row is also the focused one.
    boxShadow:
      [active ? 'inset 2px 0 0 var(--foreground)' : '', keyboardFocus ? 'var(--shadow-focus)' : '']
        .filter(Boolean)
        .join(', ') || 'none',
    outline: 'none',
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
    // A <div> is not a control, so role/tabIndex/onKeyDown buy back the button
    // semantics and operability a real <button> would have given for free.
    // aria-pressed is bound to `active`, so the announced selection follows the
    // real selection instead of being a constant.
    <div
      role="button"
      tabIndex={0}
      aria-pressed={active}
      onClick={() => onSelect && onSelect(it.id)}
      onKeyDown={(event: React.KeyboardEvent<HTMLDivElement>) => {
        // Both are swallowed so Space cannot scroll the sidebar out from under
        // the row the user just activated.
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          if (onSelect) onSelect(it.id);
        }
      }}
      onFocus={(event: React.FocusEvent<HTMLDivElement>) =>
        setKeyboardFocus(isKeyboardFocus(event.currentTarget))
      }
      onBlur={() => setKeyboardFocus(false)}
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
  /**
   * Invoked by the header "+". Supplying it turns the glyph into a real
   * keyboard-operable button labelled "New session"; omitting it leaves the
   * glyph as pure decoration, non-interactive and hidden from assistive tech,
   * so the affordance never promises an action nothing is listening for.
   */
  onNew?: () => void;
  /** Accessible name for the header "+" button. Only used when `onNew` is set. */
  newLabel?: string;
  title?: React.ReactNode;
  width?: number;
  style?: React.CSSProperties;
}

export function ProfileSidebar({
  groups = [],
  activeId,
  onSelect,
  onNew,
  newLabel = 'New session',
  title = 'Connections',
  width = 232,
  style,
}: ProfileSidebarProps): React.JSX.Element {
  const [plusFocus, setPlusFocus] = React.useState(false);
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
    // Only a "+" that actually does something gets to look clickable.
    cursor: onNew ? 'pointer' : 'default',
    padding: '2px 6px',
    outline: 'none',
    borderRadius: 'var(--radius-sm)',
    boxShadow: plusFocus ? 'var(--shadow-focus)' : undefined,
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
        {onNew ? (
          <span
            role="button"
            tabIndex={0}
            aria-label={newLabel}
            onClick={onNew}
            onKeyDown={(event: React.KeyboardEvent<HTMLSpanElement>) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onNew();
              }
            }}
            onFocus={(event: React.FocusEvent<HTMLSpanElement>) =>
              setPlusFocus(isKeyboardFocus(event.currentTarget))
            }
            onBlur={() => setPlusFocus(false)}
            style={plusStyle}
          >
            +
          </span>
        ) : (
          <span aria-hidden="true" style={plusStyle}>
            +
          </span>
        )}
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
