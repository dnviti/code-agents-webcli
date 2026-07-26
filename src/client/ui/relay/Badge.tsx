import * as React from 'react';

export type BadgeVariant =
  | 'neutral'
  | 'outline'
  | 'solid'
  | 'success'
  | 'warning'
  | 'destructive';

const V: Record<BadgeVariant, React.CSSProperties> = {
  neutral: { background: 'var(--secondary)', color: 'var(--secondary-foreground)', border: '1px solid var(--border)' },
  outline: { background: 'transparent', color: 'var(--muted-foreground)', border: '1px solid var(--border)' },
  solid: { background: 'var(--primary)', color: 'var(--primary-foreground)', border: '1px solid var(--primary)' },
  success: { background: 'transparent', color: 'var(--success)', border: '1px solid color-mix(in oklab, var(--success) 38%, transparent)' },
  warning: { background: 'transparent', color: 'var(--warning)', border: '1px solid color-mix(in oklab, var(--warning) 38%, transparent)' },
  destructive: { background: 'transparent', color: 'var(--destructive)', border: '1px solid color-mix(in oklab, var(--destructive) 38%, transparent)' },
};

export interface BadgeProps {
  variant?: BadgeVariant;
  dot?: boolean;
  children?: React.ReactNode;
  style?: React.CSSProperties;
  /**
   * A stable name for a badge whose text is written for the space available.
   *
   * "Approvals bypassed" and "bypassed" are the same fact at two widths; only
   * an explicit name lets a screen reader — or a check asserting that the fact
   * is legible — ask for it without knowing which width was drawn.
   */
  'aria-label'?: string;
}

export function Badge({ variant = 'neutral', dot = false, children, style, ...rest }: BadgeProps) {
  // Fall back to `neutral` so an out-of-range variant still renders a valid badge.
  const v = V[variant] || V.neutral;
  return (
    <span {...rest} style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, height: 18, padding: '0 7px',
      fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', fontWeight: 'var(--font-medium)',
      letterSpacing: '0.02em', borderRadius: 'var(--radius)', lineHeight: 1, ...v, ...style,
    }}>
      {dot ? <span style={{ width: 5, height: 5, borderRadius: 'var(--radius-full)', background: 'currentColor' }} /> : null}
      {children}
    </span>
  );
}
