import * as React from 'react';

export type IconButtonSize = 'sm' | 'md' | 'lg';
export type IconButtonVariant = 'ghost' | 'outline';

const SIZES: Record<IconButtonSize, number> = { sm: 26, md: 30, lg: 34 };

export interface IconButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'style'> {
  size?: IconButtonSize;
  variant?: IconButtonVariant;
  active?: boolean;
  disabled?: boolean;
  label?: string;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}

export function IconButton({
  size = 'md',
  variant = 'ghost',
  active = false,
  disabled = false,
  label,
  children,
  style,
  ...rest
}: IconButtonProps) {
  const [hover, setHover] = React.useState(false);
  const dim = SIZES[size] || SIZES.md;
  const outlined = variant === 'outline';
  return (
    <button
      aria-label={label}
      title={label}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: dim,
        height: dim,
        borderRadius: 'var(--radius)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        color: active ? 'var(--foreground)' : 'var(--muted-foreground)',
        background: active || (hover && !disabled) ? 'var(--accent)' : 'transparent',
        border: outlined ? '1px solid var(--border)' : '1px solid transparent',
        transition: 'background var(--duration-fast), color var(--duration-fast)',
        opacity: disabled ? 0.5 : 1,
        ...style,
      }}
      {...rest}
    >
      {children}
    </button>
  );
}
