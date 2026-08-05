import * as React from 'react';

import { PHONE_TEXT, TOUCH_TARGET, usePhone } from '../touch.js';

export type SelectSize = 'sm' | 'md' | 'lg';

export interface SelectOption {
  value: string;
  label: React.ReactNode;
  disabled?: boolean;
}

export interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'style' | 'size'> {
  options?: Array<string | SelectOption>;
  size?: SelectSize;
  disabled?: boolean;
  style?: React.CSSProperties;
}

const H: Record<SelectSize, number> = { sm: 28, md: 32, lg: 38 };

export function Select({ options = [], size = 'md', disabled = false, style, ...rest }: SelectProps) {
  const [focus, setFocus] = React.useState(false);
  const isPhone = usePhone();
  return (
    <div style={{ position: 'relative', display: 'inline-flex', width: '100%' }}>
      <select
        disabled={disabled} onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
        style={{
          appearance: 'none', WebkitAppearance: 'none', width: '100%',
          height: isPhone ? TOUCH_TARGET : H[size] || H.md,
          background: 'var(--input)', color: 'var(--foreground)', fontFamily: 'var(--font-sans)',
          // 16px on a phone, not 15: iOS Safari zooms the page in when a
          // focused field is smaller, and a select counts. See PHONE_TEXT.
          fontSize: isPhone ? PHONE_TEXT.input : 'var(--text-ui)', border: '1px solid ' + (focus ? 'var(--ring)' : 'var(--border)'),
          borderRadius: 'var(--radius)', padding: '0 28px 0 10px', cursor: disabled ? 'not-allowed' : 'pointer',
          outline: 'none', boxShadow: focus ? '0 0 0 1px var(--ring)' : 'none', opacity: disabled ? 0.5 : 1, ...style,
        }}
        {...rest}
      >
        {options.map((o) => (typeof o === 'string'
          ? <option key={o} value={o}>{o}</option>
          : <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>))}
      </select>
      <span style={{ position: 'absolute', right: 9, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'var(--muted-foreground)', fontSize: isPhone ? PHONE_TEXT.meta : 10 }}>▾</span>
    </div>
  );
}
