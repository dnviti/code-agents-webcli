import * as React from 'react';

export interface TabMenuItem {
  label: string;
  onSelect(): void;
  destructive?: boolean;
  disabled?: boolean;
}

export interface TabContextMenuProps {
  x: number;
  y: number;
  items: TabMenuItem[];
  onClose(): void;
}

/**
 * The tab strip's right-click menu.
 *
 * It calls itself a menu, so it has to behave like one for the keyboard too:
 * `contextmenu` is not a mouse-only event — Shift+F10 and the Menu key fire it
 * on whatever has focus. Before this the menu opened, took no focus and offered
 * no arrow keys, so a keyboard user could summon a panel they could not reach
 * and could only dismiss.
 *
 * Positioned in viewport coordinates, then nudged back inside the window once
 * measured: a menu opened near the right or bottom edge would otherwise render
 * half off-screen, which is where it is most likely to be opened from on a
 * narrow window.
 */
export function TabContextMenu({ x, y, items, onClose }: TabContextMenuProps): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const itemRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const [pos, setPos] = React.useState({ left: x, top: y });

  const enabled = React.useMemo(
    () => items.map((item, i) => (item.disabled ? -1 : i)).filter((i) => i !== -1),
    [items],
  );

  React.useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - rect.height - 4)),
    });
  }, [x, y]);

  // Focus the first item it is actually possible to choose, and hand focus back
  // to whatever opened the menu when it goes.
  React.useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = enabled[0];
    if (first !== undefined) itemRefs.current[first]?.focus();
    return () => {
      // Only if focus is still inside the menu: if something else took it in
      // the meantime, that is probably what closed the menu.
      const active = document.activeElement;
      const ours = active === null || active === document.body || ref.current?.contains(active);
      if (ours) opener?.focus();
    };
    // Deliberately once per menu, not per items change: re-running would yank
    // focus back to the top while the user is arrowing through.
  }, []);

  React.useEffect(() => {
    // Capture phase: a click on a control underneath should close the menu and
    // still reach that control, but a click that lands inside the menu must not
    // close it before the item's own handler has run.
    const onPointerDown = (event: MouseEvent) => {
      if (ref.current?.contains(event.target as Node)) return;
      onClose();
    };
    document.addEventListener('mousedown', onPointerDown, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  const focusAt = (index: number): void => {
    const target = enabled[(index + enabled.length) % enabled.length];
    if (target !== undefined) itemRefs.current[target]?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const current = enabled.indexOf(
      itemRefs.current.findIndex((node) => node === document.activeElement),
    );

    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        onClose();
        return;
      case 'ArrowDown':
        event.preventDefault();
        focusAt(current + 1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        focusAt(current - 1);
        return;
      case 'Home':
        event.preventDefault();
        focusAt(0);
        return;
      case 'End':
        event.preventDefault();
        focusAt(enabled.length - 1);
        return;
      case 'Tab':
        // A menu is modal over the page; moving past it dismisses it rather
        // than leaving it hanging open behind the next control.
        onClose();
        return;
      default:
    }
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Session actions"
      onKeyDown={onKeyDown}
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        zIndex: 'var(--z-dropdown)' as unknown as number,
        minWidth: 180,
        padding: 4,
        background: 'var(--popover)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        boxShadow: 'var(--shadow-popover)',
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--text-ui)',
      }}
    >
      {items.map((item, i) => (
        <MenuItem
          key={item.label}
          item={item}
          onDone={onClose}
          registerRef={(node) => { itemRefs.current[i] = node; }}
        />
      ))}
    </div>
  );
}

function MenuItem({
  item, onDone, registerRef,
}: {
  item: TabMenuItem;
  onDone(): void;
  registerRef(node: HTMLButtonElement | null): void;
}): React.JSX.Element {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      ref={registerRef}
      type="button"
      role="menuitem"
      disabled={item.disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => {
        // The menu closes even if the action throws; leaving it open over a
        // failed action is worse than losing the error's context.
        try { item.onSelect(); } finally { onDone(); }
      }}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '7px 10px',
        border: 'none',
        borderRadius: 'var(--radius)',
        background: hover && !item.disabled ? 'var(--accent)' : 'transparent',
        color: item.destructive ? 'var(--destructive)' : 'var(--foreground)',
        opacity: item.disabled ? 0.5 : 1,
        cursor: item.disabled ? 'not-allowed' : 'pointer',
        font: 'inherit',
      }}
    >
      {item.label}
    </button>
  );
}
