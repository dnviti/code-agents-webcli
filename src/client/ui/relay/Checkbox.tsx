import * as React from 'react';

export interface CheckboxProps {
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  label?: React.ReactNode;
  id?: string;
  style?: React.CSSProperties;
}

// `matches(':focus-visible')` throws a SyntaxError on engines that do not know the
// pseudo-class (Safari < 15.4, and jsdom depending on its nwsapi), and an exception
// thrown out of a React event handler takes the surrounding tree down with it. Fail
// open the way Switch.tsx does: showing the ring to a mouse user is a cosmetic wart,
// hiding it from a keyboard user is an accessibility failure.
function matchesFocusVisible(element: Element): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true;
  }
}

export function Checkbox({
  checked = false,
  onChange,
  disabled = false,
  label,
  id,
  style,
}: CheckboxProps) {
  // The box is drawn with spans, so a real (visually hidden) checkbox stays in the
  // markup to carry the semantics we cannot fake: assistive tech announces it as a
  // checkbox with its checked/disabled state, the wrapping <label> makes the text
  // clickable, and the browser gives us tab focus plus Space toggling for free.
  const generatedId = React.useId();
  const inputId = id ?? generatedId;

  // Only mirror focus when the browser considers it keyboard focus, so a mouse
  // click leaves the default look untouched.
  const [focusVisible, setFocusVisible] = React.useState(false);

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
    position: 'relative',
    ...style,
  };

  const inputStyle: React.CSSProperties = {
    position: 'absolute',
    width: 1,
    height: 1,
    margin: 0,
    padding: 0,
    border: 0,
    opacity: 0,
    pointerEvents: 'none',
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
    boxShadow: focusVisible ? 'var(--shadow-focus)' : undefined,
  };

  return (
    <label htmlFor={inputId} style={labelStyle}>
      <input
        id={inputId}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        style={inputStyle}
        onChange={(event) => onChange && onChange(event.currentTarget.checked)}
        onFocus={(event) => setFocusVisible(matchesFocusVisible(event.currentTarget))}
        onBlur={() => setFocusVisible(false)}
      />
      <span style={boxStyle}>
        {checked ? (
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
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
