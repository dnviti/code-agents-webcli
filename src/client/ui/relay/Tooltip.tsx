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
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }} onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      {children}
      {show ? (
        <span style={{
          position: 'absolute', zIndex: 'var(--z-tooltip)' as unknown as React.CSSProperties['zIndex'], whiteSpace: 'nowrap', pointerEvents: 'none',
          padding: '4px 8px', fontFamily: 'var(--font-sans)', fontSize: 'var(--text-xs)', color: 'var(--popover-foreground)',
          background: 'var(--popover)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-md)',
          borderRadius: 'var(--radius)', animation: 'relay-fade-in var(--duration-fast) var(--ease-out)', ...POS[side], ...style,
        }}>{label}</span>
      ) : null}
    </span>
  );
}
