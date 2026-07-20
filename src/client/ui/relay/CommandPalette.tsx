import * as React from 'react';

export interface CommandPaletteItem {
  label?: string;
  icon?: React.ReactNode;
  shortcut?: string[];
  onSelect?: () => void;
}

export interface CommandPaletteGroup {
  label?: React.ReactNode;
  items: CommandPaletteItem[];
}

export interface CommandPaletteProps {
  open?: boolean;
  groups?: CommandPaletteGroup[];
  placeholder?: string;
  onClose?: () => void;
  style?: React.CSSProperties;
}

export function CommandPalette({
  open = true,
  groups = [],
  placeholder = 'Type a command or search...',
  onClose,
  style,
}: CommandPaletteProps) {
  const [q, setQ] = React.useState('');
  const [idx, setIdx] = React.useState(0);
  if (!open) return null;
  const filtered = groups
    .map((g) => ({ ...g, items: g.items.filter((it) => (it.label || '').toLowerCase().includes(q.toLowerCase())) }))
    .filter((g) => g.items.length);
  const flat: CommandPaletteItem[] = [];
  filtered.forEach((g) => g.items.forEach((it) => flat.push(it)));
  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 'var(--z-modal)' as unknown as React.CSSProperties['zIndex'], display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: '12vh', background: 'var(--overlay)', animation: 'relay-fade-in var(--duration-fast)' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: 560, maxWidth: '92%', background: 'var(--popover)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)', borderRadius: 'var(--radius)', overflow: 'hidden', animation: 'relay-scale-in var(--duration-base) var(--ease-out)', ...style }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 14px', height: 46, borderBottom: '1px solid var(--border)' }}>
          <span style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-mono)', fontSize: 15 }}>⌕</span>
          <input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setIdx(0); }} placeholder={placeholder}
            style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', color: 'var(--foreground)', fontFamily: 'var(--font-sans)', fontSize: 'var(--text-body)' }} />
          <kbd style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--muted-foreground)', border: '1px solid var(--border)', padding: '2px 5px', borderRadius: 'var(--radius)' }}>esc</kbd>
        </div>
        <div style={{ maxHeight: 336, overflow: 'auto', padding: '6px 0' }}>
          {filtered.length === 0 ? <div style={{ padding: '22px 16px', textAlign: 'center', color: 'var(--muted-foreground)', fontFamily: 'var(--font-sans)', fontSize: 'var(--text-ui)' }}>No results</div> : null}
          {filtered.map((g, gi) => (
            <div key={gi}>
              <div style={{ padding: '8px 16px 4px', fontFamily: 'var(--font-sans)', fontSize: 'var(--text-2xs)', textTransform: 'uppercase', letterSpacing: 'var(--tracking-caps)', color: 'var(--muted-foreground)' }}>{g.label}</div>
              {g.items.map((it, ii) => {
                const cur = flat.indexOf(it) === idx;
                return (
                  <div key={ii}
                    onMouseEnter={() => setIdx(flat.indexOf(it))}
                    onClick={() => { it.onSelect && it.onSelect(); onClose && onClose(); }}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px', height: 36, cursor: 'pointer', background: cur ? 'var(--accent)' : 'transparent', color: 'var(--foreground)' }}
                  >
                    <span style={{ width: 16, textAlign: 'center', color: 'var(--muted-foreground)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>{it.icon || '›'}</span>
                    <span style={{ flex: 1, fontFamily: 'var(--font-sans)', fontSize: 'var(--text-ui)' }}>{it.label}</span>
                    {it.shortcut ? <span style={{ display: 'flex', gap: 3 }}>{it.shortcut.map((k, ki) => <kbd key={ki} style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--muted-foreground)', background: 'var(--muted)', border: '1px solid var(--border)', padding: '1px 5px', borderRadius: 'var(--radius)' }}>{k}</kbd>)}</span> : null}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
