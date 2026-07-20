import * as React from 'react';

export interface TabItem {
  value: string;
  label?: React.ReactNode;
}

export type TabsItem = TabItem | string;

export interface TabsProps {
  tabs?: TabsItem[];
  value?: string | null;
  onChange?: (value: string) => void;
  style?: React.CSSProperties;
}

function tabValue(t: TabsItem): string {
  return typeof t === 'string' ? t : t.value;
}

function tabLabel(t: TabsItem): React.ReactNode {
  return typeof t === 'string' ? t : (t.label ?? t.value);
}

export function Tabs({ tabs = [], value, onChange, style }: TabsProps) {
  const first = tabs[0] !== undefined ? tabValue(tabs[0]) : undefined;
  // Only `undefined` means uncontrolled. `null` is a value the prop type
  // admits, and it means "controlled, with nothing selected" — treating it as
  // uncontrolled left a parent no way to clear the selection, because the
  // component would quietly fall back to its own last choice.
  const isControlled = value !== undefined;
  const [internal, setInternal] = React.useState<string | undefined>(first);
  const cur = isControlled ? value : internal;
  const set = (v: string): void => {
    setInternal(v);
    onChange && onChange(v);
  };
  return (
    <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid var(--border)', ...style }}>
      {tabs.map((t) => {
        const val = tabValue(t);
        const label = tabLabel(t);
        const on = val === cur;
        const buttonStyle: React.CSSProperties = {
          position: 'relative',
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          padding: '8px 12px',
          fontFamily: 'var(--font-sans)',
          fontSize: 'var(--text-ui)',
          fontWeight: on ? 'var(--font-medium)' : 'var(--font-normal)',
          color: on ? 'var(--foreground)' : 'var(--muted-foreground)',
          boxShadow: on ? 'inset 0 -2px 0 var(--foreground)' : 'none',
          transition: 'color var(--duration-fast)',
        };
        return (
          <button key={val} onClick={() => set(val)} style={buttonStyle}>
            {label}
          </button>
        );
      })}
    </div>
  );
}
