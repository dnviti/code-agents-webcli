import * as React from 'react';

export type TabStatus = 'running' | 'error' | (string & {});

export interface TabItem {
  id: string;
  title?: React.ReactNode;
  status?: TabStatus;
}

// `matches(':focus-visible')` throws a SyntaxError on engines that do not know the
// pseudo-class, and an exception thrown out of a React event handler takes the
// surrounding tree down with it. Fail open the way Switch.tsx and Checkbox.tsx do:
// showing the ring to a mouse user is a cosmetic wart, hiding it from a keyboard
// user is an accessibility failure.
function matchesFocusVisible(element: Element): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true;
  }
}

type TabNavKey = 'prev' | 'next' | 'first' | 'last';

interface TabProps {
  tab: TabItem;
  active: boolean;
  /**
   * Roving tabindex: exactly one tab in the strip is in the document tab order,
   * and the arrow keys move focus between them. Without this the whole strip
   * would cost one Tab press per session, which is how tab bars become unusable.
   */
  tabbable: boolean;
  onSelect?: (id: string) => void;
  onClose?: (id: string) => void;
  onNavigate?: (to: TabNavKey) => void;
  registerRef?: (element: HTMLDivElement | null) => void;
}

function Tab({ tab, active, tabbable, onSelect, onClose, onNavigate, registerRef }: TabProps): React.JSX.Element {
  const [hover, setHover] = React.useState(false);
  // Keyboard focus anywhere inside the tab reveals the close button, so a keyboard
  // user is never asked to Tab onto a control that is invisible.
  const [focusWithin, setFocusWithin] = React.useState(false);
  // The ring is drawn only for real keyboard focus, so a mouse click leaves the
  // default look untouched.
  const [focusVisible, setFocusVisible] = React.useState(false);

  const closeVisible = hover || active || focusWithin;

  const dot = tab.status === 'running' ? 'var(--ansi-green)' : tab.status === 'error' ? 'var(--destructive)' : 'var(--muted-foreground)';
  const activeShadow = active ? 'inset 0 2px 0 var(--foreground)' : '';
  const wrapperStyle: React.CSSProperties = {
    position: 'relative', display: 'flex', alignItems: 'center', gap: 8, padding: '0 8px 0 12px',
    minWidth: 128, maxWidth: 208, height: '100%', cursor: 'pointer', borderRight: '1px solid var(--border)',
    background: active ? 'var(--tab-active)' : (hover ? 'var(--tab-inactive)' : 'transparent'),
    color: active ? 'var(--tab-active-foreground)' : 'var(--tab-inactive-foreground)',
    outline: 'none',
    boxShadow: focusVisible
      ? (activeShadow ? activeShadow + ', var(--shadow-focus)' : 'var(--shadow-focus)')
      : (activeShadow || 'none'),
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
    cursor: 'pointer', fontSize: 11, lineHeight: 1,
    opacity: closeVisible ? 1 : 0,
    // Opacity alone leaves the button clickable and focusable. An invisible control
    // that closes the user's session is a trap, so while it is transparent it is
    // taken out of hit testing, out of the tab order and out of the a11y tree.
    pointerEvents: closeVisible ? 'auto' : 'none',
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      // Swallowed so Space cannot scroll the strip out from under the control.
      event.preventDefault();
      if (onSelect) onSelect(tab.id);
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      // The only way to close a tab without a pointer when the close button is
      // hidden; harmless when it is visible.
      event.preventDefault();
      if (onClose) onClose(tab.id);
      return;
    }
    const nav: TabNavKey | undefined =
      event.key === 'ArrowLeft' ? 'prev'
        : event.key === 'ArrowRight' ? 'next'
          : event.key === 'Home' ? 'first'
            : event.key === 'End' ? 'last'
              : undefined;
    if (nav && onNavigate) {
      event.preventDefault();
      onNavigate(nav);
    }
  };

  const onFocus = (event: React.FocusEvent<HTMLDivElement>) => {
    setFocusWithin(true);
    // focusin bubbles, so this also fires for the close button; only the tab
    // itself should draw the strip's focus ring.
    if (event.target === event.currentTarget) setFocusVisible(matchesFocusVisible(event.currentTarget));
  };

  const onBlur = (event: React.FocusEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) setFocusVisible(false);
    const next = event.relatedTarget;
    // Moving between the tab and its own close button must not hide the button
    // mid-focus, so focus-within only drops when focus leaves the whole tab.
    if (!(next instanceof Node) || !event.currentTarget.contains(next)) setFocusWithin(false);
  };

  return (
    <div
      ref={registerRef}
      role="tab"
      aria-selected={active}
      tabIndex={tabbable ? 0 : -1}
      onClick={() => onSelect && onSelect(tab.id)}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onBlur={onBlur}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={wrapperStyle}
    >
      {tab.status ? <span style={dotStyle} /> : null}
      <span style={labelStyle}>{tab.title}</span>
      <button
        type="button"
        onClick={(e: React.MouseEvent<HTMLButtonElement>) => { e.stopPropagation(); onClose && onClose(tab.id); }}
        onKeyDown={(e: React.KeyboardEvent<HTMLButtonElement>) => { e.stopPropagation(); }}
        aria-label="Close tab"
        aria-hidden={closeVisible ? undefined : true}
        tabIndex={closeVisible ? 0 : -1}
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
  /** Accessible name for the tab strip, for pages that render more than one. */
  ariaLabel?: string;
  style?: React.CSSProperties;
}

export function TabBar({ tabs = [], activeId, onSelect, onClose, onNew, ariaLabel = 'Tabs', style }: TabBarProps): React.JSX.Element {
  const [hoverNew, setHoverNew] = React.useState(false);
  const tabRefs = React.useRef<Array<HTMLDivElement | null>>([]);

  const activeIndex = tabs.findIndex((t) => t.id === activeId);
  // With no active tab the strip would otherwise have no tab stop at all.
  const tabbableIndex = activeIndex >= 0 ? activeIndex : 0;

  const navigate = (from: number, to: TabNavKey) => {
    if (tabs.length === 0) return;
    const last = tabs.length - 1;
    const target = to === 'first' ? 0
      : to === 'last' ? last
        : to === 'prev' ? (from === 0 ? last : from - 1)
          : (from === last ? 0 : from + 1);
    const next = tabs[target];
    if (!next) return;
    // Follow-focus activation, the standard behaviour for a tab strip whose tabs
    // are the thing being switched.
    if (onSelect) onSelect(next.id);
    tabRefs.current[target]?.focus();
  };

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
      <div role="tablist" aria-label={ariaLabel} aria-orientation="horizontal" style={listStyle}>
        {tabs.map((t, i) => (
          <Tab
            key={t.id}
            tab={t}
            active={t.id === activeId}
            tabbable={i === tabbableIndex}
            onSelect={onSelect}
            onClose={onClose}
            onNavigate={(to) => navigate(i, to)}
            registerRef={(el) => { tabRefs.current[i] = el; }}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={onNew} onMouseEnter={() => setHoverNew(true)} onMouseLeave={() => setHoverNew(false)}
        aria-label="New tab" title="New tab"
        style={newStyle}
      >+</button>
      <div style={{ flex: 1 }} />
    </div>
  );
}
