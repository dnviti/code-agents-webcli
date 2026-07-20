import * as React from 'react';

export interface SwitchProps {
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  label?: React.ReactNode;
  /**
   * Accessible name for the switch when it is rendered without visible `label`
   * text. Without one of the two, the track is a focusable control that screen
   * readers announce as an unnamed "switch, on".
   */
  ariaLabel?: string;
  style?: React.CSSProperties;
}

export function Switch({ checked = false, onChange, disabled = false, label, ariaLabel, style }: SwitchProps) {
  // The track is a styled <span>, not an <input>, so nothing about it is a control to
  // assistive tech or to the keyboard. The role/aria/tabIndex/key handling below is what
  // buys back the semantics and operability a real checkbox would have given us for free.
  const labelId = React.useId();
  const [keyboardFocus, setKeyboardFocus] = React.useState(false);

  const toggle = () => {
    if (!disabled && onChange) onChange(!checked);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLSpanElement>) => {
    // Space is the switch convention and Enter is what people try anyway; both are
    // swallowed so Space cannot scroll the page out from under the control.
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      toggle();
    }
  };

  const onFocus = (event: React.FocusEvent<HTMLSpanElement>) => {
    // A ring drawn on every mouse press reads as a rendering glitch, so it is shown only
    // for the keyboard users who actually need to know where focus is.
    let visible = true;
    try {
      visible = event.currentTarget.matches(':focus-visible');
    } catch {
      visible = true;
    }
    setKeyboardFocus(visible);
  };

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
    outline: 'none',
    boxShadow: keyboardFocus ? 'var(--shadow-focus)' : undefined,
  };

  const thumbStyle: React.CSSProperties = {
    position: 'absolute', top: 1, left: checked ? 15 : 1, width: 14, height: 14, borderRadius: 'var(--radius-full)',
    background: checked ? 'var(--primary-foreground)' : 'var(--neutral-300)',
    transition: 'left var(--duration-base) var(--ease-standard)',
  };

  return (
    // The click lives on the wrapper so the label text is part of the hit target, the way
    // a native <label> would extend it; the track only forwards keyboard activation.
    <label style={labelStyle} onClick={toggle}>
      <span
        role="switch"
        aria-checked={checked}
        aria-disabled={disabled || undefined}
        aria-labelledby={label ? labelId : undefined}
        aria-label={label ? undefined : ariaLabel}
        tabIndex={disabled ? -1 : 0}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onBlur={() => setKeyboardFocus(false)}
        style={trackStyle}
      >
        <span style={thumbStyle} />
      </span>
      {label ? <span id={labelId}>{label}</span> : null}
    </label>
  );
}
