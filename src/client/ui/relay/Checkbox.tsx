import * as React from 'react';

export interface CheckboxProps {
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  label?: React.ReactNode;
  id?: string;
  style?: React.CSSProperties;
}

export function Checkbox({
  checked = false,
  onChange,
  disabled = false,
  label,
  id,
  style,
}: CheckboxProps) {
  const labelStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    fontFamily: 'var(--font-sans)',
    fontSize: 'var(--text-ui)',
    color: 'var(--foreground)',
    userSelect: 'none',
    ...style,
  };

  const boxStyle: React.CSSProperties = {
    width: 16,
    height: 16,
    flex: '0 0 auto',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: checked ? 'var(--primary)' : 'var(--input)',
    border: '1px solid ' + (checked ? 'var(--primary)' : 'var(--border)'),
    borderRadius: 'var(--radius)',
    transition: 'all var(--duration-fast)',
  };

  return (
    <label htmlFor={id} style={labelStyle}>
      <span onClick={() => !disabled && onChange && onChange(!checked)} style={boxStyle}>
        {checked ? (
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
            <path
              d="M2.5 6.4L5 8.8L9.5 3.4"
              stroke="var(--primary-foreground)"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : null}
      </span>
      {label ? <span>{label}</span> : null}
    </label>
  );
}
