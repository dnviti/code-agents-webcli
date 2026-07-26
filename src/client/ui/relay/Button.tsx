import * as React from 'react';

import { PHONE_TEXT, TOUCH_TARGET, usePhone } from '../touch.js';

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'destructive';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANTS: Record<ButtonVariant, React.CSSProperties> = {
  primary: { background: 'var(--primary)', color: 'var(--primary-foreground)', border: '1px solid var(--primary)' },
  secondary: { background: 'var(--secondary)', color: 'var(--secondary-foreground)', border: '1px solid var(--border)' },
  outline: { background: 'transparent', color: 'var(--foreground)', border: '1px solid var(--border)' },
  ghost: { background: 'transparent', color: 'var(--foreground)', border: '1px solid transparent' },
  destructive: { background: 'var(--destructive)', color: 'var(--destructive-foreground)', border: '1px solid var(--destructive)' },
};
const HOVER: Record<ButtonVariant, React.CSSProperties> = {
  primary: { filter: 'brightness(0.9)' },
  secondary: { background: 'var(--accent)' },
  outline: { background: 'var(--accent)' },
  ghost: { background: 'var(--accent)' },
  destructive: { filter: 'brightness(1.1)' },
};
const SIZES: Record<ButtonSize, React.CSSProperties> = {
  sm: { height: 26, padding: '0 10px', fontSize: 'var(--text-sm)', gap: 6 },
  md: { height: 32, padding: '0 14px', fontSize: 'var(--text-ui)', gap: 7 },
  lg: { height: 38, padding: '0 18px', fontSize: 'var(--text-body)', gap: 8 },
};

export interface ButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'style'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  iconLeft?: React.ReactNode;
  iconRight?: React.ReactNode;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}

export function Button({ variant = 'primary', size = 'md', disabled = false, iconLeft, iconRight, children, style, ...rest }: ButtonProps) {
  const [hover, setHover] = React.useState(false);
  const [active, setActive] = React.useState(false);
  const v = VARIANTS[variant] || VARIANTS.primary;
  const s = SIZES[size] || SIZES.md;
  // On a phone every size steps up to the touch floor. Doing it here rather
  // than at each call site is the point of a design system: a dialog reached
  // from the bottom bar gets it without knowing it is on a phone.
  const isPhone = usePhone();
  return (
    <button
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setActive(false); }}
      onMouseDown={() => setActive(true)}
      onMouseUp={() => setActive(false)}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: s.gap,
        height: isPhone ? TOUCH_TARGET : s.height,
        padding: s.padding,
        fontSize: isPhone ? PHONE_TEXT.body : s.fontSize,
        fontFamily: 'var(--font-sans)',
        fontWeight: 'var(--font-medium)' as React.CSSProperties['fontWeight'], lineHeight: 1, letterSpacing: '0.01em', whiteSpace: 'nowrap',
        borderRadius: 'var(--radius)', cursor: disabled ? 'not-allowed' : 'pointer', userSelect: 'none',
        transition: 'background var(--duration-fast) var(--ease-standard), filter var(--duration-fast)',
        opacity: disabled ? 0.5 : 1, transform: active && !disabled ? 'translateY(0.5px)' : 'none',
        ...v, ...(hover && !disabled ? HOVER[variant] : null), ...style,
      }}
      {...rest}
    >
      {iconLeft}{children}{iconRight}
    </button>
  );
}
