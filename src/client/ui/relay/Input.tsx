import * as React from 'react';

import { PHONE_TEXT, TOUCH_TARGET, usePhone } from '../touch.js';

export type InputSize = 'sm' | 'md' | 'lg';

const H: Record<InputSize, number> = { sm: 28, md: 32, lg: 38 };

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'style' | 'size' | 'prefix'> {
  size?: InputSize;
  invalid?: boolean;
  mono?: boolean;
  prefix?: React.ReactNode;
  disabled?: boolean;
  style?: React.CSSProperties;
}

export function Input({ size = 'md', invalid = false, mono = false, prefix, disabled = false, style, ...rest }: InputProps) {
  const [focus, setFocus] = React.useState(false);
  const phone = usePhone();
  const borderColor = invalid ? 'var(--destructive)' : (focus ? 'var(--ring)' : 'var(--border)');
  // The touch floor on a phone, the same bump `Button` and `IconButton` take:
  // a field is something you aim at too. And 16px inside it, because iOS Safari
  // zooms into anything smaller when it takes focus and never zooms back out.
  const height = phone ? TOUCH_TARGET : H[size] || H.md;
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', width: '100%', height, gap: 8,
      background: 'var(--input)', border: '1px solid ' + borderColor, borderRadius: 'var(--radius)',
      padding: '0 10px', boxShadow: focus ? '0 0 0 1px var(--ring)' : 'none', opacity: disabled ? 0.5 : 1,
      transition: 'border-color var(--duration-fast), box-shadow var(--duration-fast)',
    }}>
      {prefix ? <span style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' }}>{prefix}</span> : null}
      <input
        disabled={disabled} onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
        style={{
          flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent',
          color: 'var(--foreground)', fontFamily: mono ? 'var(--font-mono)' : 'var(--font-sans)',
          fontSize: phone ? PHONE_TEXT.input : 'var(--text-ui)', ...style,
        }}
        {...rest}
      />
    </div>
  );
}
