import * as React from 'react';

import { Icon } from './Icon';

export type TabStatus = 'running' | 'error' | (string & {});

export interface TabItem {
  id: string;
  title?: React.ReactNode;
  status?: TabStatus;
  /** Output arrived while this tab was in the background. */
  unread?: boolean;
  /**
   * This session has stopped and cannot go on until the user answers it.
   *
   * Ranks above unread, and reads differently: unread is "something happened
   * here", this is "nothing will happen here until you come back".
   */
  attention?: 'approval' | 'question' | null;
  /** Shown on hover; the strip truncates titles aggressively. */
  tooltip?: string;
}

/** What the dot means when a tab is waiting, said in words as well as colour. */
const ATTENTION_LABEL: Record<'approval' | 'question', string> = {
  approval: 'Waiting for approval',
  question: 'Asked you a question',
};

function tabDotColour(tab: TabItem): string {
  return tab.status === 'error' ? 'var(--destructive)'
    : tab.attention === 'approval' ? 'var(--warning)'
      : tab.attention === 'question' ? 'var(--info)'
        : tab.status === 'running' ? 'var(--ansi-green)'
          : tab.unread ? 'var(--primary)' : 'var(--muted-foreground)';
}

/** Words for the state dot when it carries information rather than decoration. */
function tabDotLabel(tab: TabItem): string | undefined {
  if (tab.attention) return ATTENTION_LABEL[tab.attention];
  if (tab.status === 'error') return 'Error';
  if (tab.status === 'running') return 'Running';
  if (tab.unread) return 'Unread output';
  return undefined;
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

  // Waiting outranks running, which is not the obvious order and is the whole
  // point. `status` here does not mean "the agent is working": for a
  // conversation it is the server's `active` flag, which means the process is
  // alive and is true of an agent that has been stopped for an approval since
  // yesterday. So a blocked conversation whose tab was joined, or whose page
  // was reloaded, painted a working green dot while the very same element told
  // a screen reader it was waiting for approval.
  //
  // It outranks unread for a different reason: unread is cleared by looking at
  // the tab, and this is not — the dot goes when the approval is answered, not
  // when it is noticed.
  const dot = tabDotColour(tab);
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
    // And nothing pulses while it is stopped: the pulse is what reads as
    // progress, on a session that is making none until somebody answers it.
    animation: tab.status === 'running' && !tab.attention
      ? 'relay-pulse 1.6s ease-in-out infinite'
      : 'none',
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
      {tab.status ? (
        // Named when it is carrying something, unnamed when it is only
        // decoration: a dot announced as "idle" on every tab in the strip is
        // noise, and a waiting session that says nothing at all is the failure
        // this row is here to prevent.
        tab.attention ? (
          <span role="img" aria-label={ATTENTION_LABEL[tab.attention]} style={dotStyle} />
        ) : (
          <span style={dotStyle} />
        )
      ) : null}
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

interface TabOverflowMenuProps {
  id: string;
  tabs: TabItem[];
  activeId?: string;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  onSelect: (id: string) => void;
  onDismiss: (restoreFocus?: boolean) => void;
}

/**
 * Every open tab in one compact, stable list.
 *
 * This deliberately lists all tabs rather than trying to calculate which
 * pixels are currently hidden. A menu whose contents change while the strip is
 * wheeled is disorienting; the open-tab order is the useful invariant.
 */
function TabOverflowMenu({
  id, tabs, activeId, triggerRef, onSelect, onDismiss,
}: TabOverflowMenuProps): React.JSX.Element {
  const menuRef = React.useRef<HTMLDivElement | null>(null);
  const itemRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const [hoveredId, setHoveredId] = React.useState<string | null>(null);
  const activeIndex = Math.max(0, tabs.findIndex((tab) => tab.id === activeId));

  React.useEffect(() => {
    // Focus follows the menu open, landing on the current session so keyboard
    // use starts from the same place as pointer use.
    itemRefs.current[activeIndex]?.focus();
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      onDismiss(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onDismiss(true);
    };

    // Capture makes an outside control that stops propagation behave like any
    // other outside click. Escape is captured for the same reason: the active
    // surface beneath the menu must not also consume it.
    document.addEventListener('mousedown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [activeIndex, onDismiss, triggerRef]);

  const focusItem = (index: number): void => {
    const count = tabs.length;
    if (count === 0) return;
    itemRefs.current[(index + count) % count]?.focus();
  };

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const index = itemRefs.current.findIndex((item) => item === document.activeElement);
    const target = index >= 0 ? index : activeIndex;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault();
      focusItem(target + 1);
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault();
      focusItem(target - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusItem(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusItem(tabs.length - 1);
    }
  };

  return (
    <div
      ref={menuRef}
      id={id}
      role="menu"
      aria-label="Open tabs"
      onKeyDown={onMenuKeyDown}
      style={{
        position: 'absolute',
        top: 'calc(100% + 2px)',
        right: 0,
        width: 280,
        maxWidth: 'min(360px, calc(100vw - 16px))',
        maxHeight: 'min(420px, calc(100vh - 52px))',
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        padding: 'var(--space-1)',
        background: 'var(--popover)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        boxShadow: 'var(--shadow-popover)',
        animation: 'relay-scale-in var(--duration-fast) var(--ease-out)',
        zIndex: 'var(--z-dropdown)' as unknown as number,
      }}
    >
      {tabs.map((tab, index) => {
        const selected = tab.id === activeId;
        const cue = tabDotLabel(tab);
        return (
          <button
            ref={(element) => { itemRefs.current[index] = element; }}
            key={tab.id}
            type="button"
            role="menuitemradio"
            aria-checked={selected}
            tabIndex={index === activeIndex ? 0 : -1}
            title={tab.tooltip}
            onMouseEnter={() => setHoveredId(tab.id)}
            onMouseLeave={() => setHoveredId(null)}
            onClick={() => {
              onDismiss(true);
              onSelect(tab.id);
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              width: '100%',
              minHeight: 30,
              padding: '0 8px',
              background: selected || hoveredId === tab.id ? 'var(--accent)' : 'transparent',
              border: 'none',
              borderRadius: 'var(--radius)',
              color: selected ? 'var(--foreground)' : 'var(--muted-foreground)',
              font: 'inherit',
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-xs)',
              textAlign: 'left',
              cursor: 'pointer',
            }}
          >
            <span
              role={cue ? 'img' : undefined}
              aria-label={cue}
              style={{
                width: 6,
                height: 6,
                flex: '0 0 auto',
                borderRadius: 'var(--radius-full)',
                background: tabDotColour(tab),
              }}
            />
            <span
              style={{
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontWeight: tab.unread && !selected
                  ? 'var(--font-semibold)' as React.CSSProperties['fontWeight']
                  : undefined,
              }}
            >
              {tab.title ?? tab.id}
            </span>
            {selected ? <Icon name="check" size={12} /> : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Whether the session row has more tabs than it can currently show.
 *
 * The control this enables is outside `ref`, so revealing it can only make an
 * already-overflowing strip narrower. It cannot become part of its own
 * measurement and blink in and out at the threshold.
 */
function useTabStripOverflow(
  ref: React.RefObject<HTMLElement | null>,
  contentKey: string,
): boolean {
  const [overflowing, setOverflowing] = React.useState(false);

  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;

    // Fractional zoom can report a fraction of a pixel of overflow for a row
    // that visually fits. One pixel of slack keeps the affordance honest.
    const measure = (): void => setOverflowing(element.scrollWidth > element.clientWidth + 1);
    measure();
    window.addEventListener('resize', measure);

    if (typeof ResizeObserver === 'undefined') {
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    // The flex item can keep the same observed content box while its parent is
    // negotiating space with leading/trailing controls. Watching the bar as
    // well makes any change in the actual width budget a measurement trigger.
    if (element.parentElement) observer.observe(element.parentElement);
    for (const child of Array.from(element.children)) observer.observe(child);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [contentKey, ref]);

  return overflowing;
}

function scrollTabStripWithWheel(strip: HTMLElement, event: WheelEvent): void {
  if (strip.scrollWidth <= strip.clientWidth + 1 || event.deltaY === 0) return;
  // Horizontal or diagonal input is already natively correct. Leaving it
  // alone preserves the fine-grained movement and momentum of a trackpad;
  // only a vertical-only mouse wheel is remapped into this horizontal row.
  if (Math.abs(event.deltaX) > 0.01) return;

  const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? strip.clientWidth : 1;
  const maximum = Math.max(0, strip.scrollWidth - strip.clientWidth);
  const next = Math.max(0, Math.min(maximum, strip.scrollLeft + event.deltaY * scale));
  // At either end the page keeps its normal vertical wheel behaviour instead
  // of trapping the pointer over a strip that cannot move any farther.
  if (next === strip.scrollLeft) return;
  event.preventDefault();
  strip.scrollLeft = next;
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
  const [hoverOverflow, setHoverOverflow] = React.useState(false);
  const [overflowFocusVisible, setOverflowFocusVisible] = React.useState(false);
  const [overflowMenuOpen, setOverflowMenuOpen] = React.useState(false);
  const tabRefs = React.useRef<Array<HTMLDivElement | null>>([]);
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const overflowButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const overflowMenuId = React.useId();

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

  const overflowing = useTabStripOverflow(listRef, shown.map((tab) => tab.id).join('\u0000'));

  const dismissOverflowMenu = React.useCallback((restoreFocus = false): void => {
    setOverflowMenuOpen(false);
    if (restoreFocus) overflowButtonRef.current?.focus();
  }, []);

  // A resize or a close from another device can make every tab fit while the
  // chooser is open. The chooser cannot outlive the overflow-only button that
  // owns it.
  React.useEffect(() => {
    if (!overflowing) setOverflowMenuOpen(false);
  }, [overflowing]);

  React.useEffect(() => {
    const strip = listRef.current;
    if (!strip) return;
    const onWheel = (event: WheelEvent): void => scrollTabStripWithWheel(strip, event);
    // React delegates wheel events passively in modern browsers. This one must
    // be non-passive because remapping a vertical wheel without cancelling the
    // original would move the page and the tab row at the same time.
    strip.addEventListener('wheel', onWheel, { passive: false });
    return () => strip.removeEventListener('wheel', onWheel);
  }, []);

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
    // third of its height. Keep native two-axis gesture negotiation so a
    // horizontal swipe moves the tabs while a vertical swipe can still belong
    // to the surrounding page. The WebKit property preserves momentum on
    // older iOS browsers, and containment prevents a swipe at either end from
    // becoming browser back/forward navigation.
    scrollbarWidth: 'none',
    touchAction: 'pan-x pan-y pinch-zoom',
    WebkitOverflowScrolling: 'touch',
    overscrollBehaviorX: 'contain',
  };
  const newStyle: React.CSSProperties = {
    width: 34, flex: '0 0 auto', border: 'none', borderRight: '1px solid var(--border)',
    background: hoverNew ? 'var(--accent)' : 'transparent', color: 'var(--muted-foreground)',
    cursor: 'pointer', fontSize: 16, lineHeight: 1,
  };
  const overflowStyle: React.CSSProperties = {
    width: 34,
    height: '100%',
    flex: '0 0 auto',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    borderRight: '1px solid var(--border)',
    background: overflowMenuOpen || hoverOverflow ? 'var(--accent)' : 'transparent',
    color: overflowMenuOpen ? 'var(--foreground)' : 'var(--muted-foreground)',
    cursor: 'pointer',
    outline: 'none',
    boxShadow: overflowFocusVisible ? 'var(--shadow-focus)' : 'none',
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
      {/* Outside the measured scroller on purpose. If it took part in the
          measurement, showing the button could make the row overflow and
          hiding it could make the row fit, causing an endless oscillation. */}
      {overflowing && onSelect ? (
        <div style={{ position: 'relative', flex: '0 0 auto', height: '100%' }}>
          <button
            ref={overflowButtonRef}
            type="button"
            aria-label="All open tabs"
            title="All open tabs"
            aria-haspopup="menu"
            aria-expanded={overflowMenuOpen}
            aria-controls={overflowMenuOpen ? overflowMenuId : undefined}
            onClick={() => setOverflowMenuOpen((open) => !open)}
            onMouseEnter={() => setHoverOverflow(true)}
            onMouseLeave={() => setHoverOverflow(false)}
            onFocus={(event) => setOverflowFocusVisible(matchesFocusVisible(event.currentTarget))}
            onBlur={() => setOverflowFocusVisible(false)}
            style={overflowStyle}
          >
            <Icon name="layout-list" size={14} />
          </button>
          {overflowMenuOpen ? (
            <TabOverflowMenu
              id={overflowMenuId}
              tabs={shown}
              activeId={activeId}
              triggerRef={overflowButtonRef}
              onSelect={onSelect}
              onDismiss={dismissOverflowMenu}
            />
          ) : null}
        </div>
      ) : null}
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
