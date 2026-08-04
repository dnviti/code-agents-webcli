import * as React from 'react';

import { TOUCH_TARGET, usePhone } from '../touch.js';
import { Icon } from './Icon';

export interface DialogProps {
  open?: boolean;
  title?: React.ReactNode;
  description?: React.ReactNode;
  footer?: React.ReactNode;
  onClose?: React.MouseEventHandler<HTMLElement>;
  width?: React.CSSProperties['width'];
  /**
   * `bottom` anchors the panel to the bottom edge full-width — the sheet a
   * touch UI expects, where a centred panel puts its controls out of thumb
   * reach. Everything else about the dialog is unchanged, which is the point:
   * focus handling, stacked Escape and the labelling all come along.
   */
  placement?: 'center' | 'bottom';
  /**
   * Let the user move, resize and maximise the panel.
   *
   * Off by default, and deliberately so: a dialog that asks one question wants
   * to be where it was put. This is for the panels a user *works* in — a file
   * they are reading beside the conversation, an issue they are checking
   * against the code — where being able to shove it aside is the difference
   * between a dialog and a window.
   *
   * Ignored for `bottom` placement: a sheet is already the full width of a
   * phone, and dragging it around a screen it already fills is nothing.
   */
  movable?: boolean;
  /**
   * A definite height for the panel, before the user resizes it.
   *
   * Needed by any dialog whose content should *fill* it rather than size it: a
   * percentage resolves against nothing when the panel's own height is `auto`,
   * which is why an editor inside one had to be sized in viewport units — and
   * then stayed that size no matter how large the window was dragged.
   */
  height?: React.CSSProperties['height'];
  /**
   * Make the body a flex column, so a child with `flex: 1` fills it.
   *
   * Opt-in: the ordinary dialog body is a block that scrolls, and turning every
   * one of them into a flex container would quietly restyle content that was
   * laid out as prose.
   */
  bodyFill?: boolean;
  /** Extra controls for the title row, left of maximise and close. */
  headerActions?: React.ReactNode;
  /**
   * The plain-text form of a rich title, for the hover tooltip.
   *
   * A `title` that is a node — an icon, a number, a name, a badge — has no
   * string the browser could put in a tooltip, and the one thing a cut title
   * owes the reader is a way to see the rest of it. A plain-string `title`
   * needs nothing here; it becomes its own tooltip.
   */
  titleText?: string;
  children?: React.ReactNode;
}

interface PanelBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Keeps a moved panel reachable: its title row may never leave the viewport. */
const KEEP_ON_SCREEN = 48;
const MIN_PANEL = { width: 320, height: 200 };

/** The minimum wins over the maximum: a tiny viewport must still be usable. */
function clampSpan(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function clampBox(box: PanelBox): PanelBox {
  const maxX = Math.max(0, window.innerWidth - KEEP_ON_SCREEN);
  const maxY = Math.max(0, window.innerHeight - KEEP_ON_SCREEN);
  return {
    ...box,
    // Negative x is allowed up to a point — dragging a wide panel left so its
    // right-hand side is readable is a normal thing to want — but never so far
    // that the header it is dragged by is gone.
    x: Math.min(Math.max(box.x, KEEP_ON_SCREEN - box.width), maxX),
    y: Math.min(Math.max(box.y, 0), maxY),
  };
}

// `matches(':focus-visible')` throws a SyntaxError on engines that do not know the
// pseudo-class (Safari < 15.4, and jsdom depending on its nwsapi), and an exception
// thrown out of a React event handler takes the surrounding tree down with it. Fail
// open the way Switch.tsx and Checkbox.tsx do: showing the ring to a mouse user is a
// cosmetic wart, hiding it from a keyboard user is an accessibility failure.
function matchesFocusVisible(element: Element): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true;
  }
}

// Every panel that is currently open, so a single Escape only reaches the
// topmost one. `stopPropagation` cannot do this job: all of these listeners sit
// on `document`, and stopPropagation only stops the walk to the *next* node, not
// the other listeners on this one. `stopImmediatePropagation` would stop them,
// but it hands the win to whichever dialog registered first, which is the outer
// one for siblings — exactly backwards. Document order is the honest tiebreak:
// the panel that comes last is the one painted on top, for siblings and for a
// dialog nested inside another dialog's children alike.
const openPanels: HTMLElement[] = [];

// Keep the selector deliberately native: it covers the controls this app uses
// without treating every element with a click handler as keyboard-reachable.
// The latter is an especially easy way for a focus trap to get stuck on a
// decorative element after a harmless visual refactor.
const FOCUSABLE = [
  'a[href]', 'area[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])', 'summary',
  '[contenteditable="true"]', '[tabindex]:not([tabindex="-1"])',
].join(',');

function tabStops(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => (
    !element.hidden
    && element.getAttribute('aria-hidden') !== 'true'
    && element.tabIndex >= 0
  ));
}

function retainFocus(panel: HTMLElement, backwards = false): void {
  const stops = tabStops(panel);
  const next = backwards ? stops.at(-1) : stops[0];
  // A dialog with explanatory text only is still a real modal. Its panel is
  // intentionally focusable so Tab cannot escape to controls behind it.
  (next ?? panel).focus();
}

function isTopmostPanel(panel: HTMLElement): boolean {
  for (const other of openPanels) {
    if (other === panel) continue;
    // FOLLOWING is also set when `other` is contained by `panel`, which is what
    // makes a nested dialog outrank the one it sits inside.
    if (panel.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING) return false;
  }
  return true;
}

export function Dialog({
  open = true,
  title,
  description,
  footer,
  onClose,
  width = 440,
  placement = 'center',
  movable = false,
  height,
  bodyFill = false,
  headerActions,
  titleText,
  children,
}: DialogProps): React.JSX.Element | null {
  // Hooks run on every render, so the `open` bail-out has to come after them.
  const baseId = React.useId();
  const titleId = `${baseId}-title`;
  const descriptionId = `${baseId}-description`;

  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const closeRef = React.useRef<HTMLButtonElement | null>(null);
  const [closeFocusVisible, setCloseFocusVisible] = React.useState(false);
  // Up here with the rest of them, not down beside its first use: below the
  // `open` bail-out it is a conditional hook, and the first caller to render a
  // closed Dialog without remounting takes "rendered fewer hooks than expected".
  const isPhone = usePhone();

  // Null until the user moves or resizes it: the panel stays centred by the
  // overlay's flex until then, so the ordinary case involves no measurement and
  // no layout the browser was not already doing.
  const [box, setBox] = React.useState<PanelBox | null>(null);
  const [maximised, setMaximised] = React.useState(false);

  const startGesture = React.useCallback(
    (event: React.PointerEvent, mode: 'move' | 'resize') => {
      const panel = panelRef.current;
      // Primary button only: a right-click on the title bar belongs to the app
      // menu, and a middle-click drag is not a gesture anyone means.
      if (!panel || event.button !== 0) return;
      event.preventDefault();

      const rect = panel.getBoundingClientRect();
      const from = { x: event.clientX, y: event.clientY };
      // Measured once, here: reading the rect on every pointermove would make
      // the drag depend on the layout it is itself changing.
      const origin: PanelBox = { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
      setMaximised(false);
      setBox(origin);

      const onMove = (move: PointerEvent): void => {
        const dx = move.clientX - from.x;
        const dy = move.clientY - from.y;
        setBox(
          mode === 'move'
            ? clampBox({ ...origin, x: origin.x + dx, y: origin.y + dy })
            : {
                ...origin,
                // Capped at the viewport edge, not merely floored at a minimum.
                // A panel dragged taller than the window puts its own resize
                // grip below the bottom of the screen, and there is then no way
                // to make it smaller again — the one state a resize handle must
                // never be able to reach.
                width: clampSpan(origin.width + dx, MIN_PANEL.width, window.innerWidth - origin.x),
                height: clampSpan(origin.height + dy, MIN_PANEL.height, window.innerHeight - origin.y),
              },
        );
      };
      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
      };
      // On the window, not the handle: a fast drag outpaces the pointer and
      // leaves the element behind, and a listener on the handle would stop
      // getting moves exactly when the gesture is going fastest.
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },
    [],
  );

  // A window that was dragged to the right of a screen that then got narrower
  // is a window the user cannot reach.
  React.useEffect(() => {
    if (!box) return;
    const onResize = (): void => setBox((current) => (current ? clampBox(current) : current));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [box !== null]);

  // Focus moves into the panel on open and back out on close. The panel itself
  // takes focus (tabIndex={-1}) rather than the first focusable child, so a
  // dialog whose first control is destructive does not arrive pre-armed — but if
  // a child already claimed focus via autoFocus during mount, we leave it alone.
  React.useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;

    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!panel.contains(document.activeElement)) panel.focus();

    return () => {
      // Only hand focus back if it is still ours to give: if something outside
      // the dialog took focus in the meantime (that may well be what closed it),
      // yanking it back would be the surprising move. A detached panel no longer
      // contains anything, so the body/null case covers unmount.
      const active = document.activeElement;
      const ours = active === null || active === document.body || panel.contains(active);
      if (ours) previous?.focus();
    };
  }, [open]);

  // The modal owns keyboard focus. Escape and Tab are kept together because the
  // same topmost check matters for both when dialogs are stacked: the inner
  // dialog must trap focus without the outer one stealing it back. `focusin`
  // closes the remaining hole (scripted focus, browser chrome returning focus,
  // or a click on a non-closing backdrop) that a Tab-only trap would leave.
  React.useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;

    openPanels.push(panel);
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTopmostPanel(panel)) return;
      if (event.key === 'Tab') {
        const stops = tabStops(panel);
        const active = document.activeElement;
        const current = stops.indexOf(active as HTMLElement);
        const escapingBack = event.shiftKey && (current <= 0 || !panel.contains(active));
        const escapingForward = !event.shiftKey && (current === -1 || current === stops.length - 1);
        if (escapingBack || escapingForward) {
          event.preventDefault();
          event.stopPropagation();
          retainFocus(panel, event.shiftKey);
        }
        return;
      }
      if (event.key !== 'Escape') return;
      // A stacked dialog is modal over the one beneath it, so Escape belongs to
      // the top panel alone — and it stays swallowed there even when that panel
      // has no close button to run.
      const button = closeRef.current;
      if (!button) return;
      event.stopPropagation();
      button.click();
    };
    const onFocusIn = (event: FocusEvent) => {
      if (!isTopmostPanel(panel) || panel.contains(event.target as Node | null)) return;
      retainFocus(panel);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn, true);
    return () => {
      const index = openPanels.indexOf(panel);
      if (index !== -1) openPanels.splice(index, 1);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn, true);
    };
  }, [open]);

  if (!open) return null;

  const bottom = placement === 'bottom';
  const windowed = movable && !bottom;
  // Placed only once the user has actually moved or maximised it. Until then
  // the overlay's flex centring is left alone.
  const placed = windowed && (maximised || box !== null);
  const overlayStyle: React.CSSProperties = {
    position: 'fixed', inset: 0, zIndex: 'var(--z-modal)' as unknown as number, display: 'flex',
    alignItems: bottom ? 'flex-end' : 'center', justifyContent: 'center',
    padding: bottom ? 0 : 24, background: 'var(--overlay)', animation: 'relay-fade-in var(--duration-base)',
  };
  const panelStyle: React.CSSProperties = {
    width: bottom ? '100%' : width,
    maxWidth: '100%',
    // Before any drag. A panel with a definite height is what lets its body
    // hand a definite height to the content inside it; `maxHeight` alone
    // cannot, because a cap is not a size.
    height: bottom ? undefined : height,
    // Every panel is height-capped, centred ones included. Without a cap a tall
    // dialog simply grows past the viewport, and because the overlay centres it
    // the overflow goes off *both* edges — so the top of the content, title row
    // included, ends up above the window with nothing able to scroll to it. The
    // overlay is `position: fixed`, so the page behind cannot reach it either.
    // `- 48px` is the overlay's own 24px padding on each side.
    maxHeight: bottom ? '85dvh' : 'calc(100dvh - 48px)',
    // Header and footer keep their height, the body takes the rest and scrolls.
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--popover)',
    border: '1px solid var(--border)',
    borderWidth: bottom ? '1px 0 0' : '1px',
    // Clear of the home indicator on a phone; zero everywhere else.
    paddingBottom: bottom ? 'env(safe-area-inset-bottom, 0px)' : undefined,
    boxShadow: 'var(--shadow-lg)', borderRadius: 'var(--radius)',
    animation: bottom
      ? 'relay-slide-up var(--duration-base) var(--ease-out)'
      : 'relay-scale-in var(--duration-base) var(--ease-out)',
    // The panel is only ever focused programmatically, so it should not paint a
    // ring; the controls inside it carry their own.
    outline: 'none',
    // The containing block for the resize grip. Harmless for every other
    // dialog, which has none.
    position: 'relative',
    ...(placed
      ? {
          position: 'fixed' as const,
          left: maximised ? 8 : box?.x,
          top: maximised ? 8 : box?.y,
          width: maximised ? 'calc(100vw - 16px)' : box?.width,
          height: maximised ? 'calc(100dvh - 16px)' : box?.height,
          // The cap is what centring needed; a placed panel has an explicit
          // height and the cap would fight it.
          maxHeight: 'none',
          maxWidth: 'none',
          // A drag should feel immediate, and the open animation has long since
          // finished by the time one starts.
          animation: 'none',
        }
      : null),
  };
  // A flex item's default `min-height: auto` refuses to shrink below its
  // content, which would push the header and footer off a capped panel instead
  // of letting the body scroll. `flexShrink: 0` keeps them whole.
  const headerStyle: React.CSSProperties = { padding: '16px 18px', borderBottom: '1px solid var(--border)', flexShrink: 0 };
  const headerRowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 };
  // The title is the side that yields (#114). The controls beside it are
  // `flexShrink: 0` — they are the same size whatever the window is doing, and
  // a close button that has been squeezed to nothing is worse than a title that
  // has been cut. But a flex item's `min-width` is `auto`, so without these four
  // the h2 refuses to shrink past its own content: a title with a `nowrap` span
  // in it shoves the controls bodily out of the panel, and a plain string one
  // wraps and grows the title bar from one line to five. `overflow: hidden`
  // resolves the automatic minimum to zero, and the ellipsis says the cut
  // happened. The full string stays in `textContent`, so `aria-labelledby` and
  // the hover below both still have all of it.
  const titleStyle: React.CSSProperties = {
    margin: 0, fontFamily: 'var(--font-sans)', fontSize: 'var(--text-body)',
    fontWeight: 'var(--font-semibold)' as React.CSSProperties['fontWeight'], color: 'var(--foreground)',
    minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  };
  const closeStyle: React.CSSProperties = {
    border: 'none', background: 'transparent', color: 'var(--muted-foreground)', cursor: 'pointer', fontSize: bottom || isPhone ? 20 : 15, lineHeight: 1, padding: 2,
    borderRadius: 'var(--radius)',
    // A bottom sheet is always the phone form of this dialog — see `placement`
    // — and a centred one is too when the app says it is on a phone. Either
    // way its one control is sized for a thumb rather than a cursor: 17x19px of
    // glyph is what a finger has to find otherwise, in the corner of the
    // screen, next to nothing that would forgive a miss.
    ...(bottom || isPhone ? { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: TOUCH_TARGET, height: TOUCH_TARGET, marginRight: -10 } : null),
    boxShadow: closeFocusVisible ? 'var(--shadow-focus)' : undefined,
  };
  const descriptionStyle: React.CSSProperties = { margin: '6px 0 0', fontFamily: 'var(--font-sans)', fontSize: 'var(--text-sm)', color: 'var(--muted-foreground)', lineHeight: 'var(--leading-normal)' };
  const bodyStyle: React.CSSProperties = {
    padding: '16px 18px', fontFamily: 'var(--font-sans)', fontSize: 'var(--text-ui)', color: 'var(--foreground)',
    // The body is the part that scrolls, in every placement. `minHeight: 0` is
    // what actually allows it: without it the item cannot shrink below its
    // content, so the panel would overflow its own cap and nothing would scroll.
    flex: 1,
    minHeight: 0,
    // A filling body does not scroll itself: whatever fills it owns its own
    // overflow, and a scrollbar on both is a scrollbar inside a scrollbar.
    ...(bodyFill
      ? { display: 'flex', flexDirection: 'column' as const, overflowY: 'hidden' as const }
      : null),
    overflowY: bodyFill ? 'hidden' : 'auto',
    // Wide content — a long argument string, an env value — scrolls sideways in
    // here rather than stretching the panel past the window.
    overflowX: 'auto',
    // Anchoring keeps a growing list from dragging the viewport around as rows
    // are added or removed above the scroll position.
    overflowAnchor: 'auto',
  };
  const footerStyle: React.CSSProperties = { padding: '12px 18px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 8, flexShrink: 0 };

  return (
    <div onClick={onClose} style={overlayStyle}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        style={panelStyle}
      >
        <div
          style={{
            ...headerStyle,
            // The whole title row is the handle, which is the convention every
            // window manager uses; the buttons inside it stop the gesture
            // themselves so a click on Close is a click, not a one-pixel drag.
            cursor: windowed ? (maximised ? 'default' : 'move') : undefined,
            touchAction: windowed ? 'none' : undefined,
          }}
          onPointerDown={windowed && !maximised ? (e) => startGesture(e, 'move') : undefined}
        >
          <div style={headerRowStyle}>
            <h2
              id={titleId}
              title={titleText ?? (typeof title === 'string' ? title : undefined)}
              style={titleStyle}
            >
              {title}
            </h2>
            <div
              style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              {headerActions}
              {windowed ? (
                <button
                  type="button"
                  onClick={() => {
                    // Restoring drops the box as well: a panel that was
                    // maximised from centred should go back to centred, not to
                    // wherever it happened to be measured on the way in.
                    setMaximised((current) => !current);
                    if (maximised) setBox(null);
                  }}
                  aria-pressed={maximised}
                  aria-label={maximised ? 'Restore size' : 'Fill the window'}
                  title={maximised ? 'Restore size' : 'Fill the window'}
                  style={closeStyle}
                >
                  <Icon name={maximised ? 'minimize-2' : 'maximize-2'} size={13} />
                </button>
              ) : null}
              {onClose ? (
                <button
                  ref={closeRef}
                  type="button"
                  onClick={onClose}
                  onFocus={(e) => setCloseFocusVisible(matchesFocusVisible(e.currentTarget))}
                  onBlur={() => setCloseFocusVisible(false)}
                  aria-label="Close"
                  style={closeStyle}
                >
                  ✕
                </button>
              ) : null}
            </div>
          </div>
          {description ? <p id={descriptionId} style={descriptionStyle}>{description}</p> : null}
        </div>
        {children ? <div style={bodyStyle}>{children}</div> : null}
        {footer ? <div style={footerStyle}>{footer}</div> : null}
        {windowed && !maximised ? (
          <div
            role="presentation"
            aria-hidden="true"
            onPointerDown={(e) => startGesture(e, 'resize')}
            title="Drag to resize"
            style={{
              position: 'absolute',
              right: 0,
              bottom: 0,
              width: 18,
              height: 18,
              cursor: 'nwse-resize',
              touchAction: 'none',
              // Two hairlines rather than an icon: it reads as a grip at any
              // size and costs nothing to paint.
              background:
                'linear-gradient(135deg, transparent 0 45%, var(--border) 45% 55%, transparent 55% 70%, var(--border) 70% 80%, transparent 80%)',
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
