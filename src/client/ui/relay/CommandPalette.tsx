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
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const listId = React.useId();

  const needle = q.toLowerCase();
  const filtered = groups
    .map((g) => ({ ...g, items: g.items.filter((it) => (it.label || '').toLowerCase().includes(needle)) }))
    .filter((g) => g.items.length);
  const flat: CommandPaletteItem[] = [];
  filtered.forEach((g) => g.items.forEach((it) => flat.push(it)));

  // The stored index is clamped rather than trusted: when the filter text shrinks the
  // result set the old index can point past the end, and a stale index would highlight
  // nothing while Enter selected nothing. -1 means "no results, nothing to activate".
  const active = flat.length === 0 ? -1 : Math.min(idx, flat.length - 1);

  // Keep the active row inside the scroll box. Looked up by data attribute instead of a
  // ref array because refs go stale when the filter reshuffles which item owns an index.
  React.useEffect(() => {
    const list = listRef.current;
    if (!list || active < 0) return;
    const el = list.querySelector<HTMLElement>(`[data-relay-cmd-index="${active}"]`);
    if (!el) return;
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    // The first row scrolls the box to 0, not to its own offsetTop: otherwise the group
    // heading sitting above it stays clipped and the list looks like it starts mid-group.
    if (top < list.scrollTop) list.scrollTop = active === 0 ? 0 : top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }, [active, flat.length, open]);

  if (!open) return null;

  const move = (delta: number) => {
    if (flat.length === 0) return;
    // Wrap-around: the list is short, bounded, and reached by a keyboard shortcut, so a
    // single ArrowUp landing on the last command is the cheapest way to reach the bottom.
    setIdx(((active + delta) % flat.length + flat.length) % flat.length);
  };

  const invoke = (i: number) => {
    const it = flat[i];
    if (!it) return;
    it.onSelect && it.onSelect();
    onClose && onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Home') { e.preventDefault(); setIdx(0); }
    else if (e.key === 'End') { e.preventDefault(); setIdx(Math.max(0, flat.length - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (active >= 0) invoke(active); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose && onClose(); }
  };

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 'var(--z-modal)' as unknown as React.CSSProperties['zIndex'], display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: '12vh', background: 'var(--overlay)', animation: 'relay-fade-in var(--duration-fast)' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        // Every key handler here lives on this panel, so it only ever runs while focus is
        // inside it. Pressing on a group heading or the padding would otherwise blur the
        // input to <body> and leave the palette with no arrows, no Enter and no Escape.
        // Cancelling mousedown away from the input keeps focus where it already was.
        onMouseDown={(e) => { if (e.target !== inputRef.current) e.preventDefault(); }}
        style={{ width: 560, maxWidth: '92%', background: 'var(--popover)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)', borderRadius: 'var(--radius)', overflow: 'hidden', animation: 'relay-scale-in var(--duration-base) var(--ease-out)', ...style }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 14px', height: 46, borderBottom: '1px solid var(--border)' }}>
          <span style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-mono)', fontSize: 15 }}>⌕</span>
          <input ref={inputRef} autoFocus value={q} onChange={(e) => { setQ(e.target.value); setIdx(0); }} placeholder={placeholder}
            role="combobox" aria-expanded aria-controls={listId} aria-autocomplete="list"
            aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
            style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', color: 'var(--foreground)', fontFamily: 'var(--font-sans)', fontSize: 'var(--text-body)' }} />
          <kbd style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--muted-foreground)', border: '1px solid var(--border)', padding: '2px 5px', borderRadius: 'var(--radius)' }}>esc</kbd>
        </div>
        <div ref={listRef} id={listId} role="listbox"
          style={{ position: 'relative', maxHeight: 336, overflow: 'auto', padding: '6px 0' }}>
          {filtered.length === 0 ? <div style={{ padding: '22px 16px', textAlign: 'center', color: 'var(--muted-foreground)', fontFamily: 'var(--font-sans)', fontSize: 'var(--text-ui)' }}>No results</div> : null}
          {(() => {
            // One counter walked across every group: the flat index has to keep counting
            // over group boundaries, and identity lookups would collide on repeated items.
            let n = -1;
            return filtered.map((g, gi) => (
              <div key={gi} role="group">
                <div style={{ padding: '8px 16px 4px', fontFamily: 'var(--font-sans)', fontSize: 'var(--text-2xs)', textTransform: 'uppercase', letterSpacing: 'var(--tracking-caps)', color: 'var(--muted-foreground)' }}>{g.label}</div>
                {g.items.map((it, ii) => {
                  n += 1;
                  const i = n;
                  const cur = i === active;
                  return (
                    <div key={ii}
                      id={`${listId}-${i}`}
                      role="option"
                      aria-selected={cur}
                      data-relay-cmd-index={i}
                      onMouseEnter={() => setIdx(i)}
                      onClick={() => invoke(i)}
                      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px', height: 36, cursor: 'pointer', background: cur ? 'var(--accent)' : 'transparent', color: 'var(--foreground)' }}
                    >
                      <span style={{ width: 16, textAlign: 'center', color: 'var(--muted-foreground)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>{it.icon || '›'}</span>
                      <span style={{ flex: 1, fontFamily: 'var(--font-sans)', fontSize: 'var(--text-ui)' }}>{it.label}</span>
                      {it.shortcut ? <span style={{ display: 'flex', gap: 3 }}>{it.shortcut.map((k, ki) => <kbd key={ki} style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--muted-foreground)', background: 'var(--muted)', border: '1px solid var(--border)', padding: '1px 5px', borderRadius: 'var(--radius)' }}>{k}</kbd>)}</span> : null}
                    </div>
                  );
                })}
              </div>
            ));
          })()}
        </div>
      </div>
    </div>
  );
}
