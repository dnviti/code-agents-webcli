import * as React from 'react';

export type TabStatus = 'running' | 'error' | (string & {});

export interface TabItem {
  id: string;
  title?: React.ReactNode;
  status?: TabStatus;
  /** Output arrived while this tab was in the background. */
  unread?: boolean;
  /** Shown on hover; the strip truncates titles aggressively. */
  tooltip?: string;
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
  /** Set only when the strip is reorderable; also turns the tab into a drag source. */
  drag?: TabDragHandlers;
  onContextMenu?: (id: string, x: number, y: number) => void;
  onDoubleClick?: (id: string) => void;
  /** Middle-click close, the convention every browser tab strip follows. */
  onAuxClose?: (id: string) => void;
}

interface TabDragHandlers {
  onDragStart: (id: string, event: React.DragEvent<HTMLDivElement>) => void;
  onDragEnter: (id: string) => void;
  onDragEnd: () => void;
  dragging: boolean;
}

function Tab({
  tab, active, tabbable, onSelect, onClose, onNavigate, registerRef,
  drag, onContextMenu, onDoubleClick, onAuxClose,
}: TabProps): React.JSX.Element {
  const [hover, setHover] = React.useState(false);
  // Keyboard focus anywhere inside the tab reveals the close button, so a keyboard
  // user is never asked to Tab onto a control that is invisible.
  const [focusWithin, setFocusWithin] = React.useState(false);
  // The ring is drawn only for real keyboard focus, so a mouse click leaves the
  // default look untouched.
  const [focusVisible, setFocusVisible] = React.useState(false);

  const closeVisible = hover || active || focusWithin;

  const dot = tab.status === 'running' ? 'var(--ansi-green)'
    : tab.status === 'error' ? 'var(--destructive)'
      : tab.unread ? 'var(--primary)' : 'var(--muted-foreground)';
  const activeShadow = active ? 'inset 0 2px 0 var(--foreground)' : '';
  const wrapperStyle: React.CSSProperties = {
    position: 'relative', display: 'flex', alignItems: 'center', gap: 8, padding: '0 8px 0 12px',
    minWidth: 128, maxWidth: 208, height: '100%', cursor: 'pointer', borderRight: '1px solid var(--border)',
    background: active ? 'var(--tab-active)' : (hover ? 'var(--tab-inactive)' : 'transparent'),
    color: active ? 'var(--tab-active-foreground)' : 'var(--tab-inactive-foreground)',
    outline: 'none',
    // A tab dragged out of the strip keeps its slot until the drop lands, so the
    // row does not reflow under the pointer mid-drag.
    opacity: drag?.dragging ? 0.4 : 1,
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
    fontWeight: tab.unread && !active ? 'var(--font-semibold)' as React.CSSProperties['fontWeight'] : undefined,
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
      title={tab.tooltip}
      draggable={drag ? true : undefined}
      onDragStart={drag ? (e) => drag.onDragStart(tab.id, e) : undefined}
      // dragenter rather than dragover: the swap only needs to happen once per
      // tab crossed, and dragover fires continuously while the pointer sits
      // still, which turns a hesitant drag into a flicker.
      onDragEnter={drag ? () => drag.onDragEnter(tab.id) : undefined}
      onDragOver={drag ? (e) => e.preventDefault() : undefined}
      onDragEnd={drag ? () => drag.onDragEnd() : undefined}
      onClick={() => onSelect && onSelect(tab.id)}
      onDoubleClick={onDoubleClick ? () => onDoubleClick(tab.id) : undefined}
      onAuxClick={onAuxClose ? (e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        onAuxClose(tab.id);
      } : undefined}
      onContextMenu={onContextMenu ? (e) => {
        e.preventDefault();
        // Shift+F10 and the Menu key fire `contextmenu` with no pointer, so the
        // coordinates are 0,0 — anchoring to them would open the menu in the
        // corner of the window, nowhere near the tab it belongs to.
        if (e.clientX === 0 && e.clientY === 0) {
          const rect = e.currentTarget.getBoundingClientRect();
          onContextMenu(tab.id, rect.left, rect.bottom);
          return;
        }
        onContextMenu(tab.id, e.clientX, e.clientY);
      } : undefined}
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
  /**
   * Enables drag-to-reorder. Called with the full id order once the drag ends,
   * so the owner of the list applies the move rather than the strip mutating a
   * prop it does not own.
   */
  onReorder?: (ids: string[]) => void;
  /**
   * Extra `dataTransfer` entries to publish when a tab is dragged, keyed by MIME
   * type. This app's split view reads `application/x-session-id` off the drop,
   * so a drag that does not carry it silently stops being able to open a split.
   */
  dragPayload?: (id: string) => Record<string, string>;
  onTabContextMenu?: (id: string, x: number, y: number) => void;
  onTabDoubleClick?: (id: string) => void;
  /** Middle-click close. Separate from `onClose` so a host can opt out. */
  onTabAuxClose?: (id: string) => void;
  /** Rendered before the tabs, inside the same bar (a brand mark, a back button). */
  leading?: React.ReactNode;
  /** Rendered after the flexible gap, at the far end of the bar. */
  trailing?: React.ReactNode;
  /** Accessible name for the tab strip, for pages that render more than one. */
  ariaLabel?: string;
  style?: React.CSSProperties;
}

export function TabBar({
  tabs = [], activeId, onSelect, onClose, onNew, onReorder, dragPayload,
  onTabContextMenu, onTabDoubleClick, onTabAuxClose, leading, trailing,
  ariaLabel = 'Tabs', style,
}: TabBarProps): React.JSX.Element {
  const [hoverNew, setHoverNew] = React.useState(false);
  const tabRefs = React.useRef<Array<HTMLDivElement | null>>([]);
  const listRef = React.useRef<HTMLDivElement | null>(null);

  // The order shown while a drag is in flight. Null the rest of the time, so the
  // strip renders straight from props and cannot drift from the owner's list.
  const [dragOrder, setDragOrder] = React.useState<string[] | null>(null);
  const [draggingId, setDraggingId] = React.useState<string | null>(null);

  const shown = React.useMemo(() => {
    if (!dragOrder) return tabs;
    const byId = new Map(tabs.map((t) => [t.id, t]));
    const ordered = dragOrder.map((id) => byId.get(id)).filter((t): t is TabItem => t !== undefined);
    // A tab that arrived or left mid-drag would otherwise vanish from the strip.
    return ordered.length === tabs.length ? ordered : tabs;
  }, [tabs, dragOrder]);

  const activeIndex = shown.findIndex((t) => t.id === activeId);
  // With no active tab the strip would otherwise have no tab stop at all.
  const tabbableIndex = activeIndex >= 0 ? activeIndex : 0;

  // The strip scrolls, so on a narrow window the active session can sit entirely
  // outside the visible run. Nearest, not centre: re-centring on every status
  // change would drag the strip around under a user who is reading it.
  React.useEffect(() => {
    if (activeIndex < 0 || draggingId) return;
    tabRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeIndex, activeId, draggingId]);

  const navigate = (from: number, to: TabNavKey) => {
    if (shown.length === 0) return;
    const last = shown.length - 1;
    const target = to === 'first' ? 0
      : to === 'last' ? last
        : to === 'prev' ? (from === 0 ? last : from - 1)
          : (from === last ? 0 : from + 1);
    const next = shown[target];
    if (!next) return;
    // Follow-focus activation, the standard behaviour for a tab strip whose tabs
    // are the thing being switched.
    if (onSelect) onSelect(next.id);
    tabRefs.current[target]?.focus();
  };

  const drag = onReorder || dragPayload ? {
    onDragStart: (id: string, event: React.DragEvent<HTMLDivElement>) => {
      event.dataTransfer.effectAllowed = 'copyMove';
      event.dataTransfer.setData('text/plain', id);
      if (dragPayload) {
        for (const [type, value] of Object.entries(dragPayload(id))) {
          event.dataTransfer.setData(type, value);
        }
      }
      setDraggingId(id);
      setDragOrder(tabs.map((t) => t.id));
    },
    onDragEnter: (id: string) => {
      if (!onReorder || !draggingId || id === draggingId) return;
      setDragOrder((current) => {
        const order = current ?? tabs.map((t) => t.id);
        const from = order.indexOf(draggingId);
        const to = order.indexOf(id);
        if (from === -1 || to === -1) return order;
        const next = [...order];
        next.splice(to, 0, ...next.splice(from, 1));
        return next;
      });
    },
    onDragEnd: () => {
      // dragend fires for a drop anywhere, including onto the split drop zone.
      // Committing the order there too is right: the strip did reorder visually.
      if (onReorder && dragOrder) onReorder(dragOrder);
      setDraggingId(null);
      setDragOrder(null);
    },
  } : undefined;

  const barStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'stretch', height: 36, background: 'var(--tab-bar)', borderBottom: '1px solid var(--border)', ...style,
  };
  const listStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'stretch', minWidth: 0, overflowX: 'auto', overflowY: 'hidden',
    // The strip is one row tall; a horizontal scrollbar inside it would eat a
    // third of its height. Wheel and touch scrolling still work.
    scrollbarWidth: 'none',
  };
  const newStyle: React.CSSProperties = {
    width: 34, flex: '0 0 auto', border: 'none', borderRight: '1px solid var(--border)',
    background: hoverNew ? 'var(--accent)' : 'transparent', color: 'var(--muted-foreground)',
    cursor: 'pointer', fontSize: 16, lineHeight: 1,
  };
  return (
    <div style={barStyle}>
      {leading}
      <div
        ref={listRef}
        role="tablist"
        aria-label={ariaLabel}
        aria-orientation="horizontal"
        className="relay-tabstrip"
        style={listStyle}
      >
        {shown.map((t, i) => (
          <Tab
            key={t.id}
            tab={t}
            active={t.id === activeId}
            tabbable={i === tabbableIndex}
            onSelect={onSelect}
            onClose={onClose}
            onNavigate={(to) => navigate(i, to)}
            registerRef={(el) => { tabRefs.current[i] = el; }}
            drag={drag ? { ...drag, dragging: draggingId === t.id } : undefined}
            onContextMenu={onTabContextMenu}
            onDoubleClick={onTabDoubleClick}
            onAuxClose={onTabAuxClose}
          />
        ))}
      </div>
      {/* Rendered only when there is something to do. Without a handler it was
          still a focusable control announcing itself as "New tab" and doing
          nothing when activated — the same defect as the sidebar's "+". */}
      {onNew ? (
        <button
          type="button"
          onClick={onNew} onMouseEnter={() => setHoverNew(true)} onMouseLeave={() => setHoverNew(false)}
          aria-label="New tab" title="New tab"
          style={newStyle}
        >+</button>
      ) : null}
      <div style={{ flex: 1, minWidth: 8 }} />
      {trailing}
    </div>
  );
}
