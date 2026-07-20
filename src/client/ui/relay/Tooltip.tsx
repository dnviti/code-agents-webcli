import * as React from 'react';

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right';

const POS: Record<TooltipSide, React.CSSProperties> = {
  top: { bottom: 'calc(100% + 6px)', left: '50%', transform: 'translateX(-50%)' },
  bottom: { top: 'calc(100% + 6px)', left: '50%', transform: 'translateX(-50%)' },
  left: { right: 'calc(100% + 6px)', top: '50%', transform: 'translateY(-50%)' },
  right: { left: 'calc(100% + 6px)', top: '50%', transform: 'translateY(-50%)' },
};

export interface TooltipProps {
  label: React.ReactNode;
  side?: TooltipSide;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}

export function Tooltip({ label, side = 'top', children, style }: TooltipProps) {
  const [show, setShow] = React.useState(false);
  const tooltipId = React.useId();

  // Hover alone strands keyboard and screen-reader users: the tooltip carries the only
  // description of the trigger for icon-only buttons, so it has to surface on focus too.
  // focus/blur are used (they bubble in React) because children is arbitrary — the real
  // focusable element is somewhere inside, not the wrapper. Escape is offered as the
  // documented escape hatch for a tooltip that covers content the user is trying to read.
  React.useEffect(() => {
    if (!show) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShow(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [show]);

  // Describe the trigger itself where possible so the description is announced with it;
  // only while visible, since the tooltip node does not exist otherwise.
  // A trigger may already carry its own description (an error hint, a shortcut readout).
  // Appending rather than assigning keeps that one announced instead of silently replacing it.
  const trigger = React.isValidElement<{ 'aria-describedby'?: string }>(children)
    ? React.cloneElement(children, {
        'aria-describedby':
          [children.props['aria-describedby'], show ? tooltipId : null].filter(Boolean).join(' ') ||
          undefined,
      })
    : children;

  return (
    <span
      style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
      onFocus={() => setShow(true)}
      onBlur={() => setShow(false)}
      aria-describedby={show && !React.isValidElement(children) ? tooltipId : undefined}
    >
      {trigger}
      {show ? (
        <span id={tooltipId} role="tooltip" style={{
          position: 'absolute', zIndex: 'var(--z-tooltip)' as unknown as React.CSSProperties['zIndex'], whiteSpace: 'nowrap', pointerEvents: 'none',
          padding: '4px 8px', fontFamily: 'var(--font-sans)', fontSize: 'var(--text-xs)', color: 'var(--popover-foreground)',
          background: 'var(--popover)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-md)',
          borderRadius: 'var(--radius)', animation: 'relay-fade-in var(--duration-fast) var(--ease-out)', ...POS[side], ...style,
        }}>{label}</span>
      ) : null}
    </span>
  );
}
