import * as React from 'react';

export interface SwitchProps {
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  label?: React.ReactNode;
  style?: React.CSSProperties;
}

export function Switch({ checked = false, onChange, disabled = false, label, style }: SwitchProps) {
  const labelStyle: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 9, cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1, fontFamily: 'var(--font-sans)', fontSize: 'var(--text-ui)',
    color: 'var(--foreground)', userSelect: 'none', ...style,
  };

  const trackStyle: React.CSSProperties = {
    position: 'relative', width: 32, height: 18, flex: '0 0 auto', borderRadius: 'var(--radius-full)',
    background: checked ? 'var(--primary)' : 'var(--neutral-700)',
    border: '1px solid ' + (checked ? 'var(--primary)' : 'var(--border-strong)'),
    transition: 'background var(--duration-base)',
  };

  const thumbStyle: React.CSSProperties = {
    position: 'absolute', top: 1, left: checked ? 15 : 1, width: 14, height: 14, borderRadius: 'var(--radius-full)',
    background: checked ? 'var(--primary-foreground)' : 'var(--neutral-300)',
    transition: 'left var(--duration-base) var(--ease-standard)',
  };

  return (
    <label style={labelStyle}>
      <span onClick={() => !disabled && onChange && onChange(!checked)} style={trackStyle}>
        <span style={thumbStyle} />
      </span>
      {label ? <span>{label}</span> : null}
    </label>
  );
}
