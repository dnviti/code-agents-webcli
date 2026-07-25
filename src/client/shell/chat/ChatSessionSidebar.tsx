import * as React from 'react';

import { ChatState } from '../../../shared/chat-events.js';
import { Badge } from '../../ui/relay/Badge.js';
import { Button } from '../../ui/relay/Button.js';
import { Dialog } from '../../ui/relay/Dialog.js';
import { Icon } from '../../ui/relay/Icon.js';
import { IconButton } from '../../ui/relay/IconButton.js';
import { Input } from '../../ui/relay/Input.js';
import { Tooltip } from '../../ui/relay/Tooltip.js';

/**
 * One conversation across the sidebar's grouped list.
 *
 * Deliberately a plain summary rather than a slice of ChatSnapshot: the
 * sidebar renders hundreds of sessions the browser has not loaded a
 * transcript for, and paying transcript-shape cost per row would make the
 * list the expensive part of chat mode instead of the conversation itself.
 */
export interface ChatSessionSummary {
  id: string;
  name: string;
  runtime: string;
  workingDir: string;
  /** Epoch ms of the most recent event, the sort and grouping key. */
  lastActivity: number;
  messageCount?: number;
  state?: ChatState;
  unread?: boolean;
}

export interface ChatSessionSidebarProps {
  sessions: ChatSessionSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  /** Omitting hides the header's new-session control, same convention as ProfileSidebar. */
  onNew?: () => void;
  /** Omitting hides delete everywhere, rail included: no promise of an action nothing serves. */
  onDelete?: (id: string) => void;
  /** Omitting hides rename everywhere; a read-only session list is a valid mode. */
  onRename?: (id: string, name: string) => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  loading?: boolean;
}

/** States where the agent is actively doing something, as opposed to waiting. */
const BUSY_STATES: ReadonlySet<ChatState> = new Set(['starting', 'thinking', 'running', 'awaiting_permission']);

function stateDotColor(state: ChatState | undefined): string {
  if (state === 'error') return 'var(--destructive)';
  if (state === 'awaiting_permission') return 'var(--warning)';
  if (state && BUSY_STATES.has(state)) return 'var(--ansi-green)';
  return 'var(--muted-foreground)';
}

/**
 * Short label for a state, shown as text alongside the dot.
 *
 * The dot alone would make "running" and "needs your input" both read as
 * "green thing is happening" to anyone not distinguishing hue at a glance —
 * this is the part that carries the meaning without relying on colour.
 */
function stateLabel(state: ChatState | undefined): string | undefined {
  switch (state) {
    case 'awaiting_permission': return 'needs approval';
    case 'error': return 'error';
    case 'running': return 'running';
    case 'thinking': return 'thinking';
    case 'starting': return 'starting';
    default: return undefined;
  }
}

function basename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (idx === -1) return trimmed || p;
  return trimmed.slice(idx + 1) || trimmed;
}

function formatRelativeTime(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  const minute = 60_000;
  const hour = 3_600_000;
  const day = 86_400_000;
  if (diff < 45_000) return 'now';
  if (diff < hour) return `${Math.max(1, Math.round(diff / minute))}m`;
  if (diff < day) return `${Math.round(diff / hour)}h`;
  const days = Math.round(diff / day);
  if (days < 7) return `${days}d`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function dayStart(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

type RecencyLabel = 'Today' | 'Yesterday' | 'Earlier';

/** Newest first within each bucket; only non-empty buckets are returned. */
function groupByRecency(
  sessions: ChatSessionSummary[],
  now: number,
): Array<{ label: RecencyLabel; items: ChatSessionSummary[] }> {
  const today = dayStart(now);
  const yesterday = today - 86_400_000;
  const buckets: Record<RecencyLabel, ChatSessionSummary[]> = { Today: [], Yesterday: [], Earlier: [] };
  for (const s of [...sessions].sort((a, b) => b.lastActivity - a.lastActivity)) {
    const start = dayStart(s.lastActivity);
    if (start === today) buckets.Today.push(s);
    else if (start === yesterday) buckets.Yesterday.push(s);
    else buckets.Earlier.push(s);
  }
  return (['Today', 'Yesterday', 'Earlier'] as const)
    .map((label) => ({ label, items: buckets[label] }))
    .filter((g) => g.items.length > 0);
}

/**
 * `:focus-visible` throws on engines that do not know the pseudo-class, and jsdom's
 * nwsapi is one of them. Failing open shows the ring to a mouse user rather than
 * hiding it from a keyboard user — the same tradeoff TabBar and ProfileSidebar make.
 */
function isKeyboardFocus(element: Element): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true;
  }
}

const groupLabelStyle: React.CSSProperties = {
  padding: '8px 12px 3px',
  fontFamily: 'var(--font-sans)',
  fontSize: 'var(--text-2xs)',
  textTransform: 'uppercase',
  letterSpacing: 'var(--tracking-caps)',
  color: 'var(--sidebar-muted)',
};

interface RowProps {
  session: ChatSessionSummary;
  active: boolean;
  isRenaming: boolean;
  renameDraft: string;
  onRenameDraftChange: (v: string) => void;
  onSelect: () => void;
  onStartRename: () => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onRequestDelete: () => void;
  canRename: boolean;
  canDelete: boolean;
  now: number;
}

function SessionRow({
  session, active, isRenaming, renameDraft, onRenameDraftChange,
  onSelect, onStartRename, onCommitRename, onCancelRename, onRequestDelete,
  canRename, canDelete, now,
}: RowProps): React.JSX.Element {
  const [hover, setHover] = React.useState(false);
  const [focusWithin, setFocusWithin] = React.useState(false);
  const [focusVisible, setFocusVisible] = React.useState(false);

  const busy = Boolean(session.state && BUSY_STATES.has(session.state));
  const label = stateLabel(session.state);
  const showDot = busy || session.state === 'error';
  // Actions live at tabIndex -1 until something reveals them, so Tab never lands
  // on a control the pointer cannot see — the same contract as TabBar's close button.
  const actionsVisible = hover || focusWithin;

  const ariaLabel = [
    session.name,
    session.runtime,
    formatRelativeTime(session.lastActivity, now),
    label,
    session.unread ? 'unread' : undefined,
  ].filter(Boolean).join(', ');

  return (
    <div
      role={isRenaming ? undefined : 'button'}
      tabIndex={isRenaming ? -1 : 0}
      aria-pressed={isRenaming ? undefined : active}
      aria-label={isRenaming ? undefined : ariaLabel}
      onClick={isRenaming ? undefined : onSelect}
      onKeyDown={(event: React.KeyboardEvent<HTMLDivElement>) => {
        if (isRenaming) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
          return;
        }
        if (event.key === 'F2' && canRename) {
          event.preventDefault();
          onStartRename();
          return;
        }
        if ((event.key === 'Delete' || event.key === 'Backspace') && canDelete) {
          event.preventDefault();
          onRequestDelete();
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={(event: React.FocusEvent<HTMLDivElement>) => {
        setFocusWithin(true);
        if (event.target === event.currentTarget) setFocusVisible(isKeyboardFocus(event.currentTarget));
      }}
      onBlur={(event: React.FocusEvent<HTMLDivElement>) => {
        if (event.target === event.currentTarget) setFocusVisible(false);
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) setFocusWithin(false);
      }}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        padding: '7px 8px 7px 12px',
        minHeight: 44,
        cursor: isRenaming ? 'default' : 'pointer',
        outline: 'none',
        background: active ? 'var(--accent)' : hover ? 'var(--muted)' : 'transparent',
        boxShadow: [
          active ? 'inset 2px 0 0 var(--foreground)' : '',
          focusVisible ? 'var(--shadow-focus)' : '',
        ].filter(Boolean).join(', ') || 'none',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span
          aria-hidden="true"
          style={{
            width: 6, height: 6, flex: '0 0 auto', borderRadius: 'var(--radius-full)',
            background: showDot ? stateDotColor(session.state) : (session.unread ? 'var(--primary)' : 'transparent'),
            animation: busy ? 'relay-pulse 1.6s ease-in-out infinite' : 'none',
          }}
        />
        {isRenaming ? (
          <Input
            // The Input element mounts fresh every time a row enters rename mode
            // (it does not exist in the DOM otherwise), so the native autoFocus
            // attribute fires exactly once per rename — no ref/effect needed,
            // and Input.tsx is a plain function component with no forwarded ref.
            autoFocus
            size="sm"
            value={renameDraft}
            aria-label="Session name"
            onChange={(event: React.ChangeEvent<HTMLInputElement>) => onRenameDraftChange(event.target.value)}
            onClick={(event: React.MouseEvent<HTMLInputElement>) => event.stopPropagation()}
            onKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => {
              event.stopPropagation();
              if (event.key === 'Enter') { event.preventDefault(); onCommitRename(); }
              else if (event.key === 'Escape') { event.preventDefault(); onCancelRename(); }
            }}
            onBlur={onCommitRename}
            style={{ fontSize: 'var(--text-sm)' }}
          />
        ) : (
          <span
            style={{
              flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              fontFamily: 'var(--font-sans)', fontSize: 'var(--text-sm)', color: 'var(--sidebar-foreground)',
              fontWeight: session.unread ? 'var(--font-semibold)' as React.CSSProperties['fontWeight'] : undefined,
            }}
          >
            {session.name}
          </span>
        )}
        {/* Hovering or focusing a row swaps its timestamp for the row's actions
            rather than overlaying them, so nothing ever sits half-obscured
            behind a delete button and the buttons only exist in the DOM (and
            in tab order) once something has actually revealed them. */}
        {!isRenaming && actionsVisible && (canRename || canDelete) ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 2, flex: '0 0 auto' }}>
            {canRename ? (
              <IconButton
                size="lg"
                label="Rename session"
                onClick={(event: React.MouseEvent<HTMLButtonElement>) => { event.stopPropagation(); onStartRename(); }}
              >
                <Icon name="pencil" size={12} />
              </IconButton>
            ) : null}
            {canDelete ? (
              <IconButton
                size="lg"
                label="Delete session"
                onClick={(event: React.MouseEvent<HTMLButtonElement>) => { event.stopPropagation(); onRequestDelete(); }}
              >
                <Icon name="trash-2" size={12} />
              </IconButton>
            ) : null}
          </div>
        ) : !isRenaming ? (
          <span style={{ flex: '0 0 auto', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--sidebar-muted)' }}>
            {formatRelativeTime(session.lastActivity, now)}
          </span>
        ) : null}
      </div>

      {!isRenaming ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 13, minWidth: 0 }}>
          <Badge variant="outline" style={{ height: 16, padding: '0 5px', fontSize: 'var(--text-2xs)', flex: '0 0 auto' }}>
            {session.runtime}
          </Badge>
          <Tooltip label={session.workingDir} side="bottom">
            <span
              tabIndex={-1}
              style={{
                minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--sidebar-muted)',
              }}
            >
              {basename(session.workingDir)}
            </span>
          </Tooltip>
          {label ? (
            <Badge
              variant={session.state === 'error' ? 'destructive' : session.state === 'awaiting_permission' ? 'warning' : 'neutral'}
              style={{ height: 16, padding: '0 5px', fontSize: 'var(--text-2xs)', flex: '0 0 auto' }}
            >
              {label}
            </Badge>
          ) : null}
          {typeof session.messageCount === 'number' ? (
            <span style={{ flex: '0 0 auto', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--sidebar-muted)' }}>
              {session.messageCount}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function SessionRail({
  session, active, onSelect, now,
}: { session: ChatSessionSummary; active: boolean; onSelect: () => void; now: number }): React.JSX.Element {
  const busy = Boolean(session.state && BUSY_STATES.has(session.state));
  const showDot = busy || session.state === 'error';
  const label = stateLabel(session.state);
  const ariaLabel = [session.name, session.runtime, formatRelativeTime(session.lastActivity, now), label, session.unread ? 'unread' : undefined]
    .filter(Boolean).join(', ');

  return (
    <Tooltip label={session.name} side="right">
      <button
        type="button"
        onClick={onSelect}
        aria-label={ariaLabel}
        aria-pressed={active}
        style={{
          position: 'relative',
          width: 40, height: 40, margin: '2px auto',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', fontWeight: 'var(--font-semibold)' as React.CSSProperties['fontWeight'],
          color: active ? 'var(--foreground)' : 'var(--sidebar-muted)',
          background: active ? 'var(--accent)' : 'transparent',
          border: `1px solid ${active ? 'var(--border-strong)' : 'transparent'}`,
          cursor: 'pointer',
        }}
      >
        {session.runtime.slice(0, 2).toUpperCase()}
        {showDot ? (
          <span
            aria-hidden="true"
            style={{
              position: 'absolute', top: 2, right: 2, width: 6, height: 6, borderRadius: 'var(--radius-full)',
              background: stateDotColor(session.state),
              animation: busy ? 'relay-pulse 1.6s ease-in-out infinite' : 'none',
            }}
          />
        ) : session.unread ? (
          <span aria-hidden="true" style={{ position: 'absolute', top: 2, right: 2, width: 6, height: 6, borderRadius: 'var(--radius-full)', background: 'var(--primary)' }} />
        ) : null}
      </button>
    </Tooltip>
  );
}

function LoadingRows({ collapsed }: { collapsed: boolean }): React.JSX.Element {
  return (
    <div
      style={{
        display: 'flex', flexDirection: collapsed ? 'column' : 'row', alignItems: 'center', justifyContent: 'center',
        gap: 8, padding: collapsed ? '18px 4px' : '30px 12px', color: 'var(--sidebar-muted)',
      }}
    >
      <Icon name="loader-circle" size={14} style={{ animation: 'relay-spin 900ms linear infinite' }} />
      {!collapsed ? <span style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--text-sm)' }}>Loading sessions…</span> : null}
    </div>
  );
}

function EmptyRows({ collapsed, onNew }: { collapsed: boolean; onNew?: () => void }): React.JSX.Element {
  if (collapsed) {
    return (
      <div style={{ padding: '18px 4px', display: 'flex', justifyContent: 'center', color: 'var(--sidebar-muted)' }}>
        <Icon name="message-square" size={16} />
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '34px 16px', textAlign: 'center', color: 'var(--sidebar-muted)' }}>
      <Icon name="message-square" size={20} />
      <span style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--text-sm)' }}>No sessions yet</span>
      {onNew ? (
        <Button size="lg" variant="secondary" onClick={onNew} iconLeft={<Icon name="plus" size={13} />}>
          New session
        </Button>
      ) : null}
    </div>
  );
}

export function ChatSessionSidebar({
  sessions,
  activeId,
  onSelect,
  onNew,
  onDelete,
  onRename,
  collapsed = false,
  onToggleCollapsed,
  loading = false,
}: ChatSessionSidebarProps): React.JSX.Element {
  const now = Date.now();
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [renameDraft, setRenameDraft] = React.useState('');
  const [deleteTarget, setDeleteTarget] = React.useState<ChatSessionSummary | null>(null);

  const groups = React.useMemo(() => groupByRecency(sessions, now), [sessions, now]);
  const width = collapsed ? 56 : 272;

  const commitRename = () => {
    const trimmed = renameDraft.trim();
    if (trimmed && onRename && renamingId) onRename(renamingId, trimmed);
    setRenamingId(null);
  };

  return (
    <div
      style={{
        width, flex: `0 0 ${width}px`, display: 'flex', flexDirection: 'column', height: '100%',
        background: 'var(--sidebar)', borderRight: '1px solid var(--border)', overflow: 'hidden',
        transition: 'width var(--duration-base) var(--ease-standard)',
      }}
    >
      <div
        style={{
          display: 'flex', flexDirection: collapsed ? 'column' : 'row', alignItems: 'center',
          justifyContent: collapsed ? 'center' : 'space-between', gap: 4,
          padding: collapsed ? '8px 4px' : '0 6px 0 12px', minHeight: collapsed ? undefined : 38,
          borderBottom: '1px solid var(--border)',
        }}
      >
        {!collapsed ? (
          <span style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--text-2xs)', textTransform: 'uppercase', letterSpacing: 'var(--tracking-caps)', color: 'var(--sidebar-muted)' }}>
            Sessions
          </span>
        ) : null}
        <div style={{ display: 'flex', flexDirection: collapsed ? 'column' : 'row', gap: 2 }}>
          {onNew ? (
            <IconButton size="lg" label="New session" onClick={onNew}>
              <Icon name="plus" size={16} />
            </IconButton>
          ) : null}
          {onToggleCollapsed ? (
            <IconButton
              size="lg"
              label={collapsed ? 'Expand sessions' : 'Collapse sessions'}
              aria-expanded={!collapsed}
              onClick={onToggleCollapsed}
            >
              <Icon name="panel-left" size={16} />
            </IconButton>
          ) : null}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '4px 0' }} aria-busy={loading || undefined}>
        {loading ? (
          <LoadingRows collapsed={collapsed} />
        ) : sessions.length === 0 ? (
          <EmptyRows collapsed={collapsed} onNew={onNew} />
        ) : collapsed ? (
          [...sessions].sort((a, b) => b.lastActivity - a.lastActivity).map((s) => (
            <SessionRail key={s.id} session={s} active={s.id === activeId} onSelect={() => onSelect(s.id)} now={now} />
          ))
        ) : (
          groups.map((g) => (
            <div key={g.label} style={{ marginBottom: 4 }}>
              <div style={groupLabelStyle}>{g.label}</div>
              {g.items.map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  active={s.id === activeId}
                  isRenaming={renamingId === s.id}
                  renameDraft={renameDraft}
                  onRenameDraftChange={setRenameDraft}
                  onSelect={() => onSelect(s.id)}
                  onStartRename={() => { setRenamingId(s.id); setRenameDraft(s.name); }}
                  onCommitRename={commitRename}
                  onCancelRename={() => setRenamingId(null)}
                  onRequestDelete={() => setDeleteTarget(s)}
                  canRename={Boolean(onRename)}
                  canDelete={Boolean(onDelete)}
                  now={now}
                />
              ))}
            </div>
          ))
        )}
      </div>

      <Dialog
        open={deleteTarget !== null}
        title="Delete session"
        description={deleteTarget ? `Delete "${deleteTarget.name}"? This cannot be undone.` : undefined}
        onClose={() => setDeleteTarget(null)}
        width={360}
        footer={
          <>
            <Button variant="outline" size="lg" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button
              variant="destructive"
              size="lg"
              onClick={() => {
                if (deleteTarget && onDelete) onDelete(deleteTarget.id);
                setDeleteTarget(null);
              }}
            >
              Delete
            </Button>
          </>
        }
      />
    </div>
  );
}
