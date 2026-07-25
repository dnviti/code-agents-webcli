import * as React from 'react';

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
  children?: React.ReactNode;
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
  children,
}: DialogProps): React.JSX.Element | null {
  // Hooks run on every render, so the `open` bail-out has to come after them.
  const baseId = React.useId();
  const titleId = `${baseId}-title`;
  const descriptionId = `${baseId}-description`;

  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const closeRef = React.useRef<HTMLButtonElement | null>(null);
  const [closeFocusVisible, setCloseFocusVisible] = React.useState(false);

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

  // Escape closes. The component had no key handling at all before this, so
  // there is no duplicate handler to collide with. It routes through the close
  // button's own click rather than calling onClose directly: onClose is typed as
  // a MouseEventHandler and there is no honest MouseEvent to hand it from a
  // keystroke, and reusing the button keeps every close path identical. No close
  // button means the caller gave no way to close, and Escape respects that.
  React.useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;

    openPanels.push(panel);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // A stacked dialog is modal over the one beneath it, so Escape belongs to
      // the top panel alone — and it stays swallowed there even when that panel
      // has no close button to run.
      if (!isTopmostPanel(panel)) return;
      const button = closeRef.current;
      if (!button) return;
      event.stopPropagation();
      button.click();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      const index = openPanels.indexOf(panel);
      if (index !== -1) openPanels.splice(index, 1);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (!open) return null;

  const bottom = placement === 'bottom';
  const overlayStyle: React.CSSProperties = {
    position: 'fixed', inset: 0, zIndex: 'var(--z-modal)' as unknown as number, display: 'flex',
    alignItems: bottom ? 'flex-end' : 'center', justifyContent: 'center',
    padding: bottom ? 0 : 24, background: 'var(--overlay)', animation: 'relay-fade-in var(--duration-base)',
  };
  const panelStyle: React.CSSProperties = {
    width: bottom ? '100%' : width,
    maxWidth: '100%',
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
  };
  // A flex item's default `min-height: auto` refuses to shrink below its
  // content, which would push the header and footer off a capped panel instead
  // of letting the body scroll. `flexShrink: 0` keeps them whole.
  const headerStyle: React.CSSProperties = { padding: '16px 18px', borderBottom: '1px solid var(--border)', flexShrink: 0 };
  const headerRowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 };
  const titleStyle: React.CSSProperties = { margin: 0, fontFamily: 'var(--font-sans)', fontSize: 'var(--text-body)', fontWeight: 'var(--font-semibold)' as React.CSSProperties['fontWeight'], color: 'var(--foreground)' };
  const closeStyle: React.CSSProperties = {
    border: 'none', background: 'transparent', color: 'var(--muted-foreground)', cursor: 'pointer', fontSize: 15, lineHeight: 1, padding: 2,
    borderRadius: 'var(--radius)',
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
    overflowY: 'auto',
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
        <div style={headerStyle}>
          <div style={headerRowStyle}>
            <h2 id={titleId} style={titleStyle}>{title}</h2>
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
          {description ? <p id={descriptionId} style={descriptionStyle}>{description}</p> : null}
        </div>
        {children ? <div style={bodyStyle}>{children}</div> : null}
        {footer ? <div style={footerStyle}>{footer}</div> : null}
      </div>
    </div>
  );
}
