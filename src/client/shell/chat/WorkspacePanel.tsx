import * as React from 'react';
import {
  CHAT_PANEL_ICONS,
  CHAT_PANEL_LABELS,
  PANEL_DEFAULT_WIDTH,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  clampPanelWidth,
  enabledPanels,
  type ChatPanelId,
  type ChatViewSettings,
} from '../../chat/view-settings.js';
import type { ChatTranscript } from '../../chat/transcript.js';
import { fetchFiles, type WorkspaceFiles } from '../../chat/workspace-api.js';
import { Icon } from '../../ui/relay/Icon.js';
import { IconButton } from '../../ui/relay/IconButton.js';
import { PHONE_TEXT, TOUCH_GAP, TOUCH_TARGET, usePhone } from '../../ui/touch.js';
import { AgentsPanel } from './AgentsPanel.js';
import { FileTreePanel, type FileTreeEntry } from './FileTreePanel.js';
import { GitChangesPanel } from './GitChangesPanel.js';
import { GitHubPanel } from './GitHubPanel.js';
import { FileEditorDialog } from './FileEditorDialog.js';
import { LinksPanel } from './LinksPanel.js';
import { StatusPanel } from './StatusPanel.js';
import { PanelNote, useWorkspaceData } from './PanelShell.js';

/**
 * The rail beside the conversation: the working tree, what changed in it, the
 * repository's open work, what the agent has delegated, and any app it started.
 *
 * One rail with tabs rather than five stacked sections. A chat is already a tall
 * column of text; adding four more scrolling regions to the same axis makes
 * every one of them too short to be worth reading.
 *
 * Which tabs exist is the user's choice (see ChatSettingsDialog) and a panel
 * that is switched off is not rendered — so it costs no fetch, no polling and no
 * request against somebody's GitHub rate limit.
 */

export interface WorkspacePanelProps {
  sessionId: string;
  workingDir: string;
  transcript: ChatTranscript;
  settings: ChatViewSettings;
  onSelectTab: (tab: ChatPanelId) => void;
  onClose: () => void;
  /** Persist a new rail width, once the drag has settled. */
  onResize?: (width: number) => void;
  /** Full-width sheet instead of a fixed rail. */
  isMobile?: boolean;
  /**
   * The `trace` tab's contents, built by the caller.
   *
   * Passed in rather than composed here: the plan and the activity projection
   * are derived from the transcript the chat root already holds, and rebuilding
   * them inside the rail would mean two components deriving the same list from
   * the same version counter on every token of a streaming turn.
   */
  trace?: React.ReactNode;
}

export function WorkspacePanel({
  sessionId,
  workingDir,
  transcript,
  settings,
  onSelectTab,
  onClose,
  onResize,
  isMobile = false,
  trace,
}: WorkspacePanelProps): React.JSX.Element | null {
  const tabs = enabledPanels(settings);
  const active = tabs.includes(settings.panelTab) ? settings.panelTab : tabs[0];

  // The file the editor is showing, or null. Held here rather than inside the
  // Files tab so a file opened from Changes uses the same dialog — one editor,
  // one place that knows whether it has unsaved work.
  const [editing, setEditing] = React.useState<string | null>(null);

  // Live during a drag, committed on release. Dragging straight into the
  // persisted settings would write localStorage on every pointer move and
  // re-render the whole surface through the store to do it.
  const [dragWidth, setDragWidth] = React.useState<number | null>(null);
  const width = dragWidth ?? clampPanelWidth(settings.panelWidth);

  // The changes panel is polled off the conversation's own activity: when the
  // agent goes idle it has just finished touching files, which is exactly when
  // `git status` is worth re-reading. Polling on a timer instead would either
  // lag behind the agent or run `git status` forever on an idle session.
  const revision = useIdleRevision(transcript);

  const editor = (
    <FileEditorDialog
      // Keyed on the file: without it, reopening the editor paints the last
      // file's text and its "unsaved" badge for a frame before the new fetch
      // lands, which reads as the wrong file having been opened.
      key={editing ?? 'none'}
      open={editing !== null}
      sessionId={sessionId}
      filePath={editing ?? ''}
      onClose={() => setEditing(null)}
      isMobile={isMobile}
    />
  );

  if (tabs.length === 0) {
    return (
      <Rail isMobile={isMobile} width={width} onResize={onResize} onDragWidth={setDragWidth}>
        <RailHeader tabs={[]} active={undefined} onSelectTab={onSelectTab} onClose={onClose} />
        <PanelNote icon="settings">
          Every panel is switched off. Turn one back on from the chat settings.
        </PanelNote>
      </Rail>
    );
  }

  return (
    <Rail isMobile={isMobile} width={width} onResize={onResize} onDragWidth={setDragWidth}>
      <RailHeader tabs={tabs} active={active} onSelectTab={onSelectTab} onClose={onClose} />
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {active === 'trace' ? (
          trace ?? (
            <PanelNote icon="list-todo">
              Reasoning and tool calls appear here as the agent works.
            </PanelNote>
          )
        ) : null}
        {active === 'files' ? (
          <FilesTab sessionId={sessionId} root={workingDir} onOpenFile={setEditing} />
        ) : null}
        {active === 'changes' ? (
          <GitChangesPanel sessionId={sessionId} revision={revision} onOpenFile={setEditing} />
        ) : null}
        {active === 'github' ? <GitHubPanel sessionId={sessionId} /> : null}
        {active === 'agents' ? <AgentsPanel transcript={transcript} /> : null}
        {active === 'links' ? <LinksPanel transcript={transcript} /> : null}
        {active === 'status' ? (
          <StatusPanel sessionId={sessionId} transcript={transcript} revision={revision} />
        ) : null}
      </div>
      {editor}
    </Rail>
  );
}

/** The most of the surface the rail may take, so the conversation keeps room. */
const RAIL_MAX_FRACTION = 0.7;

function Rail({
  isMobile,
  width,
  onResize,
  onDragWidth,
  children,
}: {
  isMobile: boolean;
  width: number;
  onResize?: (width: number) => void;
  onDragWidth: (width: number | null) => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const ref = React.useRef<HTMLElement | null>(null);
  const available = useAvailableWidth(ref);

  // Measured rather than expressed as `max-width: 70%`.
  //
  // A CSS cap makes the *rendered* width disagree with the stored one: the
  // handle keeps dragging a number the rail is no longer that wide, the aria
  // value reports it, and on the way back there is a dead zone the width of
  // the difference before anything moves again.
  const ceiling = available
    ? Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, Math.round(available * RAIL_MAX_FRACTION)))
    : PANEL_MAX_WIDTH;
  const applied = Math.min(width, ceiling);

  return (
    <aside
      ref={ref as React.RefObject<HTMLElement>}
      aria-label="Workspace"
      style={{
        flex: isMobile ? 1 : '0 0 auto',
        width: isMobile ? '100%' : applied,
        maxWidth: '100%',
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        borderLeft: isMobile ? 'none' : '1px solid var(--border)',
        background: 'var(--sidebar)',
        position: 'relative',
      }}
    >
      {children}
      {/* No handle on a phone: the rail is the whole screen there, and a
          drag target on its edge would fight the transcript's own scrolling. */}
      {isMobile ? null : (
        <ResizeHandle
          width={applied}
          max={ceiling}
          onResize={onResize}
          onDragWidth={onDragWidth}
        />
      )}
    </aside>
  );
}

/**
 * How much horizontal room the rail's container has.
 *
 * Zero until measured — including under `react-dom/server`, which has no layout
 * and no ResizeObserver — and callers fall back to the static bound for that
 * case rather than rendering a rail of width zero.
 */
function useAvailableWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = React.useState(0);

  React.useEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent || typeof ResizeObserver === 'undefined') return;

    const measure = (): void => setWidth(parent.getBoundingClientRect().width);
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [ref]);

  return width;
}

/**
 * The rail's left edge, draggable.
 *
 * Pointer events rather than mouse events: one code path then covers a mouse, a
 * trackpad, a pen and a touch, and `setPointerCapture` keeps the drag attached
 * to this element even when the pointer outruns it — which it will, because the
 * whole gesture is about moving faster than a 6px strip.
 *
 * It is a real `separator` with a value, so it can also be moved from the
 * keyboard. A resize that only exists for people holding a mouse is a resize
 * half the users of this app cannot perform.
 */
function ResizeHandle({
  width,
  max,
  onResize,
  onDragWidth,
}: {
  width: number;
  /** The widest the rail can actually be right now, from its container. */
  max: number;
  onResize?: (width: number) => void;
  onDragWidth: (width: number | null) => void;
}): React.JSX.Element {
  const [hover, setHover] = React.useState(false);
  const [focused, setFocused] = React.useState(false);
  /** The pointer that owns the drag, or null. */
  const drag = React.useRef<{ id: number; x: number; width: number } | null>(null);
  const keyTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const clamp = React.useCallback(
    (next: number) => Math.min(max, clampPanelWidth(next)),
    [max],
  );

  // A pending keyboard commit must not outlive the component, or it writes a
  // width for a rail that is gone; a stranded live width must not either, or
  // the parent keeps rendering it in place of every later setting.
  React.useEffect(
    () => () => {
      if (keyTimer.current !== null) clearTimeout(keyTimer.current);
      onDragWidth(null);
    },
    [onDragWidth],
  );

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    // Only the primary button; a right-click here is a context menu, not a drag.
    if (event.button !== 0 || drag.current) return;
    event.preventDefault();
    drag.current = { id: event.pointerId, x: event.clientX, width };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Capture is an optimisation; the drag still works without it.
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const active = drag.current;
    // Only the pointer that started this drag. A second finger landing on the
    // strip used to rewrite the origin, so releasing committed a width that was
    // never on screen.
    if (!active || active.id !== event.pointerId) return;
    // The rail is on the right, so dragging *left* makes it wider — the
    // delta is subtracted, not added.
    onDragWidth(clamp(active.width - (event.clientX - active.x)));
  };

  const finish = (event: React.PointerEvent<HTMLDivElement>): void => {
    const active = drag.current;
    if (!active || active.id !== event.pointerId) return;
    drag.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Capture already lost, which is exactly the case this guards.
    }

    onDragWidth(null);
    const next = clamp(active.width - (event.clientX - active.x));
    // Compared against the width this drag *started* from, not the current
    // prop: during a drag the prop already carries the live width, so `next`
    // always equalled it and the commit never fired — the rail followed the
    // pointer and then snapped straight back on release.
    //
    // A press with no travel still skips: there `next === active.width`.
    if (next !== active.width) onResize?.(next);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    // Shift is the coarse step; the rest belong to the browser. Alt+Left is
    // Back, and swallowing it from a focusable strip is not this control's
    // decision to make.
    if (event.altKey || event.ctrlKey || event.metaKey) return;

    const step = event.shiftKey ? 64 : 16;
    let next: number | null = null;
    // The key moves the separator, not the width: on a right-hand rail those
    // are opposite, and an arrow that widened the panel it is pointing away
    // from would be the wrong way round for everyone who watched it move.
    if (event.key === 'ArrowLeft') next = width + step;
    else if (event.key === 'ArrowRight') next = width - step;
    else if (event.key === 'Home') next = PANEL_MIN_WIDTH;
    else if (event.key === 'End') next = max;
    else if (event.key === 'Enter' || event.key === ' ') next = PANEL_DEFAULT_WIDTH;
    if (next === null) return;

    event.preventDefault();
    const target = clamp(next);
    // Shown immediately, written once the keys stop. Held down, an arrow key
    // repeats ~30 times a second, and each of those was a JSON.stringify into
    // localStorage plus a re-render of the whole chat surface.
    onDragWidth(target);
    if (keyTimer.current !== null) clearTimeout(keyTimer.current);
    keyTimer.current = setTimeout(() => {
      keyTimer.current = null;
      onDragWidth(null);
      onResize?.(target);
    }, 250);
  };

  const lit = drag.current !== null || hover || focused;

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the workspace panel"
      aria-valuenow={width}
      aria-valuemin={PANEL_MIN_WIDTH}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onKeyDown={onKeyDown}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={(event) => setFocused(isKeyboardFocus(event.currentTarget))}
      onBlur={() => setFocused(false)}
      // Double-click to reset is the convention every split view has.
      onDoubleClick={() => {
        const target = clamp(PANEL_DEFAULT_WIDTH);
        if (target !== width) onResize?.(target);
      }}
      style={{
        position: 'absolute',
        top: 0,
        bottom: 0,
        // Straddles the border, but only just: every pixel of overhang is a
        // pixel of the transcript that swallows clicks and text selection.
        left: -3,
        width: 7,
        cursor: 'col-resize',
        // Without this a drag selects the text it passes over, and the pointer
        // ends up dragging a selection instead of the rail.
        touchAction: 'none',
        userSelect: 'none',
        zIndex: 1,
        background: 'transparent',
        outline: 'none',
        // A focusable control with no focus indicator is a tab stop that
        // vanishes for the one person who needs to see it.
        boxShadow: focused ? 'var(--shadow-focus)' : undefined,
      }}
    >
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: 3,
          width: 1,
          background: lit ? 'var(--ring)' : 'transparent',
          transition: 'background var(--duration-fast) var(--ease-standard)',
        }}
      />
    </div>
  );
}

/**
 * `:focus-visible` is unsupported in some older engines and in jsdom, where
 * `matches` throws on the selector. Failing open shows the ring rather than
 * silently stranding keyboard users — the same call the file tree makes.
 */
function isKeyboardFocus(element: Element): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true;
  }
}

function RailHeader({
  tabs,
  active,
  onSelectTab,
  onClose,
}: {
  tabs: ChatPanelId[];
  active: ChatPanelId | undefined;
  onSelectTab: (tab: ChatPanelId) => void;
  onClose: () => void;
}): React.JSX.Element {
  const scroller = React.useRef<HTMLDivElement | null>(null);
  const overflowing = useOverflowing(scroller, [tabs.join(' ')]);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const isPhone = usePhone();

  // A rail dragged back out until every tab fits again must not leave a menu
  // hanging under a button that is no longer there.
  React.useEffect(() => {
    if (!overflowing) setMenuOpen(false);
  }, [overflowing]);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        minHeight: isPhone ? TOUCH_TARGET + 8 : 34,
        borderBottom: '1px solid var(--border)',
        flex: '0 0 auto',
      }}
    >
      {/* The scroller holds only the tabs. It used to hold the close button
          too, which meant that at five tabs the one control that dismisses the
          panel had scrolled off the edge of it. */}
      <div
        ref={scroller}
        role="tablist"
        aria-label="Workspace panels"
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          gap: isPhone ? TOUCH_GAP : 2,
          padding: isPhone ? '0 4px 0 8px' : '0 2px 0 4px',
          overflowX: 'auto',
          scrollbarWidth: 'none',
        }}
      >
        {tabs.map((tab) => (
          <TabButton
            key={tab}
            id={tab}
            selected={tab === active}
            onSelect={() => onSelectTab(tab)}
          />
        ))}
      </div>

      {/* Narrowing the rail used to hide tabs with no way back to them: the
          strip scrolls, but `scrollbar-width: none` means there is nothing on
          screen that says so, and a tab you cannot see and cannot scroll to is
          simply gone. This is the way back. */}
      {overflowing ? (
        <div style={{ flex: '0 0 auto', position: 'relative', marginLeft: isPhone ? TOUCH_GAP : 0 }}>
          <IconButton
            label="All workspace panels"
            size={isPhone ? 'lg' : 'sm'}
            style={isPhone ? { width: TOUCH_TARGET, height: TOUCH_TARGET } : undefined}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            active={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <Icon name="chevrons-up-down" />
          </IconButton>
          {menuOpen ? (
            <TabMenu
              tabs={tabs}
              active={active}
              onSelect={(tab) => {
                setMenuOpen(false);
                onSelectTab(tab);
              }}
              onDismiss={() => setMenuOpen(false)}
            />
          ) : null}
        </div>
      ) : null}

      <div
        style={{
          flex: '0 0 auto',
          padding: isPhone ? '0 6px' : '0 4px',
          marginLeft: isPhone ? TOUCH_GAP : 0,
        }}
      >
        <IconButton
          label="Close workspace panel"
          size={isPhone ? 'lg' : 'sm'}
          style={isPhone ? { width: TOUCH_TARGET, height: TOUCH_TARGET } : undefined}
          onClick={onClose}
        >
          <Icon name="x" />
        </IconButton>
      </div>
    </div>
  );
}

/**
 * Whether a scroller has more in it than it is showing.
 *
 * Watches the element and its contents, because both move: the rail is
 * dragged, and switching a panel off in settings removes a tab.
 *
 * Note the direction this is used in. The button it reveals lives *outside*
 * the measured element, so showing it makes the scroller narrower — which can
 * only ever increase the overflow it was shown for, never remove it. Hiding it
 * makes the scroller wider, which can only reduce overflow. Neither direction
 * can undo its own cause, so this cannot oscillate.
 */
function useOverflowing(ref: React.RefObject<HTMLElement | null>, deps: React.DependencyList): boolean {
  const [overflowing, setOverflowing] = React.useState(false);

  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;

    // The 1px slack is for sub-pixel layout: a row that fits exactly reports a
    // scrollWidth a fraction over its clientWidth on fractional zoom levels,
    // and a chevron that appears at 110% zoom on a rail nobody resized is a bug.
    const measure = (): void => setOverflowing(element.scrollWidth > element.clientWidth + 1);
    measure();

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const child of Array.from(element.children)) observer.observe(child);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, ...deps]);

  return overflowing;
}

/**
 * Every panel, listed.
 *
 * All of them rather than only the hidden ones: which tabs happen to have
 * scrolled out of view is an accident of pixel width, and a menu whose contents
 * change as you drag is harder to use than one that always says the same thing.
 */
function TabMenu({
  tabs,
  active,
  onSelect,
  onDismiss,
}: {
  tabs: ChatPanelId[];
  active: ChatPanelId | undefined;
  onSelect: (tab: ChatPanelId) => void;
  onDismiss: () => void;
}): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const onPointerDown = (event: MouseEvent): void => {
      if (!ref.current?.contains(event.target as Node)) onDismiss();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onDismiss();
    };
    // Capture, so a click on a control that stops propagation still closes it.
    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [onDismiss]);

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Workspace panels"
      style={{
        position: 'absolute',
        top: '100%',
        right: 0,
        marginTop: 2,
        minWidth: 160,
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        padding: 'var(--space-1)',
        background: 'var(--popover)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        boxShadow: 'var(--shadow-popover)',
        animation: 'relay-scale-in var(--duration-fast) var(--ease-out)',
        zIndex: 'var(--z-dropdown)' as unknown as number,
      }}
    >
      {tabs.map((tab) => {
        const selected = tab === active;
        return (
          <button
            key={tab}
            type="button"
            role="menuitemradio"
            aria-checked={selected}
            onClick={() => onSelect(tab)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              width: '100%',
              minHeight: 28,
              padding: '0 8px',
              background: selected ? 'var(--accent)' : 'transparent',
              border: 'none',
              borderRadius: 'var(--radius)',
              color: selected ? 'var(--foreground)' : 'var(--muted-foreground)',
              font: 'inherit',
              fontSize: 'var(--text-xs)',
              textAlign: 'left',
              cursor: 'pointer',
            }}
          >
            <Icon name={CHAT_PANEL_ICONS[tab]} size={12} />
            {CHAT_PANEL_LABELS[tab]}
            {selected ? (
              <span style={{ marginLeft: 'auto', display: 'inline-flex' }}>
                <Icon name="check" size={11} />
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function TabButton({
  id,
  selected,
  onSelect,
}: {
  id: ChatPanelId;
  selected: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  const ref = React.useRef<HTMLButtonElement | null>(null);
  const isPhone = usePhone();

  // Five tabs do not fit 320px, so the row scrolls — and a selection restored
  // from storage could sit outside it, leaving the panel showing content whose
  // tab was nowhere on screen.
  React.useEffect(() => {
    if (!selected) return;
    ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selected]);

  return (
    <button
      ref={ref}
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onSelect}
      title={CHAT_PANEL_LABELS[id]}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        height: isPhone ? TOUCH_TARGET : 28,
        padding: isPhone ? '0 12px' : '0 8px',
        background: 'transparent',
        border: 0,
        borderRadius: 'var(--radius)',
        color: selected ? 'var(--foreground)' : 'var(--muted-foreground)',
        boxShadow: selected ? 'inset 0 -2px 0 var(--foreground)' : 'none',
        font: 'inherit',
        fontSize: isPhone ? PHONE_TEXT.body : 'var(--text-xs)',
        fontWeight: selected
          ? ('var(--font-medium)' as React.CSSProperties['fontWeight'])
          : undefined,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      <Icon name={CHAT_PANEL_ICONS[id]} size={isPhone ? 16 : 12} />
      {CHAT_PANEL_LABELS[id]}
    </button>
  );
}

/**
 * The file tree, fed by the workspace route.
 *
 * `FileTreePanel` handles expansion, caching and keyboard navigation; all it
 * needs from here is the root listing and a function that fetches one level.
 */
function FilesTab({
  sessionId,
  root,
  onOpenFile,
}: {
  sessionId: string;
  root: string;
  onOpenFile: (path: string) => void;
}): React.JSX.Element {
  const { data, error, busy, reload } = useWorkspaceData<WorkspaceFiles>(
    () => fetchFiles(sessionId),
    [sessionId],
    Boolean(sessionId),
  );

  const expand = React.useCallback(
    async (path: string): Promise<FileTreeEntry[]> => {
      const page = await fetchFiles(sessionId, path);
      return page.entries;
    },
    [sessionId],
  );

  // An upload from the right-click menu happens outside this tree — the menu
  // lives at the top of the shell and has no way to reach in here. It announces
  // instead, and the tree that is now out of date listens.
  React.useEffect(() => {
    const onChanged = (): void => reload();
    window.addEventListener('ccweb:workspace-changed', onChanged);
    return () => window.removeEventListener('ccweb:workspace-changed', onChanged);
  }, [reload]);

  if (error) {
    return <PanelNote tone="destructive" icon="circle-alert">{error}</PanelNote>;
  }

  return (
    <FileTreePanel
      root={data?.root || root}
      entries={data?.entries || []}
      onExpand={expand}
      // The tree already routes a click on a file here rather than toggling it;
      // it just had nowhere to send it until now.
      onOpen={onOpenFile}
      loading={busy && !data}
      onRefresh={reload}
    />
  );
}

/**
 * A counter that advances each time the session finishes working.
 *
 * The git panel re-reads when this moves. Tying it to the transition into an
 * idle state is what makes the file list refresh right after an edit lands
 * without asking the panel to poll a repository nobody is touching.
 */
function useIdleRevision(transcript: ChatTranscript): number {
  const version = React.useSyncExternalStore(transcript.subscribe, transcript.getVersion, ZERO);
  const [revision, setRevision] = React.useState(0);
  const wasBusy = React.useRef(false);

  React.useEffect(() => {
    const busy = transcript.busy;
    if (wasBusy.current && !busy) setRevision((value) => value + 1);
    wasBusy.current = busy;
  }, [transcript, version]);

  return revision;
}

const ZERO = (): number => 0;
