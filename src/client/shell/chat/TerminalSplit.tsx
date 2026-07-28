import * as React from 'react';
import {
  ChatTerminal,
  closeTerminal,
  rememberTerminals,
  rememberedTerminals,
  terminalsFor,
} from '../../chat/chat-terminal.js';
import {
  TERMINAL_MIN_HEIGHT,
  TERMINAL_VIEWPORT_RESERVE,
  clampTerminalHeight,
} from '../../chat/view-settings.js';
import { toggleCtrlLatch } from '../../ui/mobile.js';
import { Icon } from '../../ui/relay/Icon.js';
import { KeyStrip } from '../KeyStrip.js';
import { shellStore } from '../store.js';

/**
 * A shell at the bottom of the conversation, in the same working directory.
 *
 * The point of the split is not that a terminal exists — the app has always had
 * one — it is that this one is *here*: you can read what the agent said it did
 * and check it without leaving the conversation, losing the scroll position or
 * switching tabs.
 *
 * Sized by a drag handle, clamped so the transcript keeps a readable height on
 * any viewport. The clamp is against the live window height rather than a fixed
 * ceiling, because a 560px terminal restored onto an 800px laptop screen would
 * leave the conversation with nothing.
 */

export interface TerminalSplitProps {
  /** The conversation this belongs to. Panes are recreated when it changes. */
  chatSessionId: string;
  workingDir: string;
  height: number;
  onResize(height: number): void;
  onClose(): void;
  isMobile?: boolean;
  /**
   * The app's current theme.
   *
   * Not used for styling here — every surrounding surface reads the tokens
   * directly. It is a *signal*: xterm renders from a JavaScript theme object to
   * canvas and cannot see CSS custom properties, so toggling `.light` restyles
   * the chrome around this pane and leaves the terminal in the old palette
   * until something hands it the new one.
   */
  theme?: 'dark' | 'light';
}

interface TabView {
  id: string;
  label: string;
  phase: ChatTerminal['phase'];
  cols: number;
  rows: number;
}

export function TerminalSplit({
  chatSessionId,
  workingDir,
  height,
  onResize,
  onClose,
  isMobile = false,
  theme,
}: TerminalSplitProps): React.JSX.Element {
  // The panes belong to the conversation, not to this component. Collapsing the
  // split unmounts everything here, and a `npm run dev` the user started in it
  // must not die because they wanted the transcript taller for a minute.
  const panes = terminalsFor(chatSessionId);
  const [, force] = React.useReducer((n: number) => n + 1, 0);
  const [activeId, setActiveId] = React.useState<string | null>(panes[0]?.id ?? null);
  const host = React.useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = React.useState<number | null>(null);

  // Re-read on resize: the ceiling is a function of the window, and a stored
  // 560px split on a window dragged down to 700px tall would otherwise keep
  // squeezing the transcript until something else happened to re-render.
  const viewport = useViewportHeight();
  const applied = clampTerminalHeight(drag ?? height, viewport);

  // Read from the store rather than taken as a prop: the latch is shared state
  // that this pane's own `onData` already consumes, so threading it through
  // ChatView would only make the surface carry a value that belongs to neither
  // it nor the transcript.
  const ctrlLatched = React.useSyncExternalStore(
    shellStore.subscribe,
    () => shellStore.getSnapshot().ctrlLatched,
    () => false,
  );

  const open = React.useCallback(
    (label: string, existing?: string) => {
      const pane = new ChatTerminal({ chatSessionId, workingDir, label, onChange: force });
      panes.push(pane);
      setActiveId(pane.id);
      // Reattach where there is something to reattach to; otherwise create.
      if (existing) pane.attachExisting(existing);
      else void pane.start();
      force();
      return pane;
    },
    [panes, workingDir, chatSessionId],
  );

  // One pane the first time the split is opened for this conversation, and the
  // same panes every time after — re-pointed at *this* mount's re-render, since
  // the one they were built with unmounted when the split last closed.
  React.useEffect(() => {
    for (const pane of panes) pane.attach(force);
    if (panes.length) {
      if (!panes.some((pane) => pane.id === activeId)) setActiveId(panes[0].id);
      return;
    }
    // Nothing in memory: either this is the first open, or the page reloaded
    // and the ptys are still running on the server.
    const remembered = rememberedTerminals(chatSessionId);
    if (remembered.length) {
      remembered.forEach((sessionId, i) => {
        open(i === 0 ? `shell — ${basename(workingDir)}` : `shell ${i + 1}`, sessionId);
      });
    } else {
      open(`shell — ${basename(workingDir)}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatSessionId, workingDir]);

  // Whatever is attached right now, so a reload can find its way back.
  React.useEffect(() => {
    rememberTerminals(
      chatSessionId,
      panes.map((pane) => pane.sessionId).filter((id): id is string => Boolean(id)),
    );
  });

  // Mount whichever pane is active into the body. The elements are owned by the
  // ChatTerminal instances and are never re-parented across panes — that is the
  // one thing xterm does not survive.
  React.useEffect(() => {
    const box = host.current;
    const pane = panes.find((p) => p.id === activeId);
    if (!box || !pane) return;
    if (pane.element.parentElement !== box) {
      box.replaceChildren(pane.element);
    }
    pane.fit();
  }, [activeId]);

  // The pane has to reflow whenever the split's own height changes, and xterm
  // only reflows when it is told to.
  React.useEffect(() => {
    panes.find((p) => p.id === activeId)?.fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applied, activeId]);

  React.useEffect(() => {
    // After the class has landed on <html>, so the tokens read back as the new
    // theme rather than the one being left.
    const id = window.requestAnimationFrame(() => {
      for (const pane of panes) pane.applyTheme();
    });
    return () => window.cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);

  React.useEffect(() => {
    const onWindowResize = (): void => {
      for (const pane of panes) pane.fit();
    };
    window.addEventListener('resize', onWindowResize);
    return () => window.removeEventListener('resize', onWindowResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panes]);

  const tabs: TabView[] = panes.map((pane) => ({
    id: pane.id,
    label: pane.label,
    phase: pane.phase,
    cols: pane.cols,
    rows: pane.rows,
  }));
  const active = panes.find((pane) => pane.id === activeId) ?? null;

  const closeTab = (id: string): void => {
    const index = panes.findIndex((pane) => pane.id === id);
    if (index < 0) return;
    // Closing a *tab* ends the session on the server too. Without that, every
    // open of the split would leave a pty behind that nothing on screen refers
    // to — after an afternoon of toggling, a dozen of them.
    closeTerminal(chatSessionId, id);
    if (!panes.length) {
      // The last tab going is the split going: an empty terminal pane with a
      // `+` in it is a box that exists to be filled rather than a tool.
      onClose();
      return;
    }
    // Only when the tab that closed was the one on screen. Reassigning
    // unconditionally moved the user off the shell they were watching every
    // time they tidied up a background one.
    if (id === activeId) setActiveId(panes[Math.min(index, panes.length - 1)].id);
    force();
  };

  const startDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = applied;
    const target = event.currentTarget;
    try {
      target.setPointerCapture(event.pointerId);
    } catch {
      // Capture is an optimisation; the drag still works without it.
    }

    const move = (moveEvent: PointerEvent): void => {
      // Dragging *up* makes the terminal taller.
      setDrag(clampTerminalHeight(startHeight + (startY - moveEvent.clientY), viewportHeight()));
    };
    const finish = (upEvent: PointerEvent): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      const next = clampTerminalHeight(startHeight + (startY - upEvent.clientY), viewportHeight());
      setDrag(null);
      if (next !== startHeight) onResize(next);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };

  const nudge = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 64 : 16;
    let next: number | null = null;
    if (event.key === 'ArrowUp') next = applied + step;
    else if (event.key === 'ArrowDown') next = applied - step;
    if (next === null) return;
    event.preventDefault();
    onResize(clampTerminalHeight(next, viewportHeight()));
  };

  return (
    <div style={{ flex: '0 0 auto', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the terminal"
        aria-valuenow={applied}
        aria-valuemin={TERMINAL_MIN_HEIGHT}
        aria-valuemax={Math.max(TERMINAL_MIN_HEIGHT, viewport - TERMINAL_VIEWPORT_RESERVE)}
        tabIndex={0}
        onPointerDown={startDrag}
        onKeyDown={nudge}
        style={{
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: 7,
          background: 'var(--chrome)',
          borderTop: '1px solid var(--border)',
          cursor: 'row-resize',
          touchAction: 'none',
          userSelect: 'none',
        }}
      >
        <span aria-hidden="true" style={{ width: 26, height: 1, background: 'var(--border-strong)' }} />
      </div>

      <div
        style={{
          flex: '0 0 auto',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          height: applied,
          background: 'var(--terminal-bg)',
        }}
      >
        <div
          style={{
            flex: '0 0 auto',
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            minWidth: 0,
            height: 28,
            padding: '0 8px',
            background: 'var(--tab-bar)',
            borderTop: '1px solid var(--border)',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <div
            role="tablist"
            aria-label="Terminals"
            style={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0, overflowX: 'auto' }}
          >
            {tabs.map((tab) => (
              <TerminalTab
                key={tab.id}
                tab={tab}
                active={tab.id === activeId}
                onSelect={() => setActiveId(tab.id)}
                onClose={() => closeTab(tab.id)}
              />
            ))}
          </div>

          <TabAction
            label="Open another terminal here"
            icon="plus"
            onClick={() => open(`shell ${panes.length + 1}`)}
          />

          <span
            style={{
              marginLeft: 'auto',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              minWidth: 0,
            }}
          >
            {isMobile ? null : (
              <span
                title={workingDir}
                style={{
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  color: 'var(--muted-foreground)',
                }}
              >
                {active && active.cols
                  ? `${active.cols}×${active.rows} · same worktree as the chat`
                  : 'same worktree as the chat'}
              </span>
            )}
            <TabAction label="Clear this terminal" icon="eraser" onClick={() => active?.clear()} />
            <TabAction label="Close the terminal — Ctrl+`" icon="x" onClick={onClose} />
          </span>
        </div>

        <div
          ref={host}
          // Clicking the body hands the keyboard to the pty, which is the whole
          // contract of the split: the composer keeps focus until you ask.
          onMouseDown={() => active?.focus()}
          style={{
            flex: 1,
            minHeight: 0,
            padding: 'var(--terminal-padding)',
            background: 'var(--terminal-bg)',
            cursor: 'text',
          }}
        />

        {/* The same strip the terminal surface has, addressed at this pane.
            Inside the split's own height on purpose: it costs the shell a few
            rows rather than the conversation, and the drag handle keeps meaning
            what it says. A phone keyboard has no Escape, Tab or arrows, and
            since #21 a tap no longer summons it at all — without this the shell
            in a conversation is something you can read and cannot drive.

            Not gated on the `keysVisible` preference the terminal surface
            honours, because in chat mode that toggle has given up its slot in
            the bottom bar to the workspace panel: honouring it would let a
            preference set on another screen leave this pane undrivable with no
            way to say otherwise. This strip is scoped to a disclosure the user
            opened by hand and closes by closing it. */}
        {isMobile ? (
          <KeyStrip
            ctrlLatched={ctrlLatched}
            onKey={(key) => active?.sendKey(key)}
            onToggleCtrl={toggleCtrlLatch}
            onShowKeyboard={() => active?.showKeyboard()}
          />
        ) : null}
      </div>
    </div>
  );
}

const PHASE_DOT: Record<ChatTerminal['phase'], { color: string; pulse: boolean; word: string }> = {
  starting: { color: 'var(--warning)', pulse: true, word: 'starting' },
  live: { color: 'var(--success)', pulse: true, word: 'running' },
  exited: { color: 'var(--muted-foreground)', pulse: false, word: 'exited' },
  error: { color: 'var(--destructive)', pulse: false, word: 'failed' },
};

function TerminalTab({
  tab,
  active,
  onSelect,
  onClose,
}: {
  tab: TabView;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const dot = PHASE_DOT[tab.phase] || PHASE_DOT.exited;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        flex: '0 0 auto',
        height: 22,
        padding: '0 4px 0 9px',
        whiteSpace: 'nowrap',
        background: active ? 'var(--tab-active)' : 'var(--tab-inactive)',
        border: '1px solid var(--border)',
        borderBottomColor: active ? 'var(--tab-active)' : 'var(--border)',
        fontFamily: 'var(--font-mono)',
        fontSize: 10.5,
        color: active ? 'var(--tab-active-foreground)' : 'var(--tab-inactive-foreground)',
      }}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        onClick={onSelect}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          background: 'transparent',
          border: 0,
          padding: 0,
          font: 'inherit',
          color: 'inherit',
          cursor: 'pointer',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 5,
            height: 5,
            borderRadius: 'var(--radius-full)',
            background: dot.color,
            animation: dot.pulse ? 'relay-pulse 1.4s var(--ease-standard) infinite' : undefined,
          }}
        />
        {tab.label}
        {/* The dot's meaning, for anything that cannot see a dot. */}
        <span style={SR_ONLY}>{dot.word}</span>
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label={`Close ${tab.label}`}
        title={`Close ${tab.label}`}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 14,
          height: 14,
          background: 'transparent',
          border: 0,
          padding: 0,
          color: 'inherit',
          opacity: 0.7,
          cursor: 'pointer',
        }}
      >
        <Icon name="x" size={9} />
      </button>
    </span>
  );
}

function TabAction({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: string;
  onClick: () => void;
}): React.JSX.Element {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: '0 0 auto',
        width: 22,
        height: 22,
        background: hover ? 'var(--accent)' : 'transparent',
        border: 0,
        borderRadius: 'var(--radius)',
        color: hover ? 'var(--foreground)' : 'var(--muted-foreground)',
        cursor: 'pointer',
      }}
    >
      <Icon name={icon} size={11} />
    </button>
  );
}

function viewportHeight(): number {
  return typeof window === 'undefined' ? 900 : window.innerHeight;
}

/** The window's height, kept current. */
function useViewportHeight(): number {
  const [height, setHeight] = React.useState(viewportHeight);
  React.useEffect(() => {
    const measure = (): void => setHeight(viewportHeight());
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  return height;
}

/** Trailing-slash tolerant leaf of a path, in either separator style. */
function basename(dir: string): string {
  const trimmed = String(dir || '').replace(/[/\\]+$/, '');
  if (!trimmed) return dir || 'shell';
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return cut >= 0 ? trimmed.slice(cut + 1) || trimmed : trimmed;
}

const SR_ONLY: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0,0,0,0)',
};
