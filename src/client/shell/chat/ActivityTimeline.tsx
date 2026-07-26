import * as React from 'react';
import { FileDiff, ThinkingBlock, ToolBlock } from '../../../shared/chat-events.js';
import {
  ACTIVITY_FILTERS,
  activityMeta,
  filterActivity,
  type ActivityEvent,
} from '../../chat/activity.js';
import type { ActivityFilterId } from '../../chat/view-settings.js';
import { KIND_ICON, TOOL_STATUS } from '../../chat/tool-meta.js';
import { Icon } from '../../ui/relay/Icon.js';
import { PHONE_TEXT, TOUCH_GAP, TOUCH_TARGET, usePhone } from '../../ui/touch.js';
import { Markdown } from './Markdown.js';
import { ToolCallCard } from './ToolCallCard.js';

/**
 * Everything the agent actually did, on one rail.
 *
 * The transcript used to inline all of this — a reasoning disclosure and a tool
 * card between every two paragraphs — which made a five-line answer eight
 * screens tall and the prose impossible to read as prose. Moving it here is a
 * relocation, never a hiding: every block is still on screen, still expandable
 * to the full `ToolCallCard` with its arguments, its clamped output and its
 * per-hunk diff controls.
 *
 * Rows expand into the *existing* card rather than a re-implementation of it.
 * That repeats one summary line, which is a smaller price than two renderings of
 * "what did this call do" drifting apart.
 */

export interface ActivityTimelineProps {
  events: ActivityEvent[];
  filter: ActivityFilterId;
  onFilter(next: ActivityFilterId): void;
  /** Take me to the message this event came from. */
  onReveal?: (messageId: string) => void;
  /**
   * Scroll this row into view and open it, once.
   *
   * Set when a transcript work pill is clicked: the rail opens and lands on the
   * turn you were reading rather than at whatever it was last scrolled to.
   */
  focusId?: string;
  /** Bumped per request, so asking for the same row twice scrolls twice. */
  focusNonce?: number;
  onApplyHunk?: (diff: FileDiff, hunkIndex: number) => void;
  onRevertHunk?: (diff: FileDiff, hunkIndex: number) => void;
}

export function ActivityTimeline({
  events,
  filter,
  onFilter,
  onReveal,
  focusId,
  focusNonce,
  onApplyHunk,
  onRevertHunk,
}: ActivityTimelineProps): React.JSX.Element {
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(() => new Set<string>());
  const scroller = React.useRef<HTMLDivElement | null>(null);
  const rows = React.useRef(new Map<string, HTMLDivElement>());
  const isPhone = usePhone();

  const filtered = React.useMemo(() => filterActivity(events, filter), [events, filter]);

  // How far back the rail draws. A long session projects well over a thousand
  // events, and every one of them is a row of a dozen elements: rendering the
  // lot on every token of a streaming turn is the cost the transcript was
  // engineered to avoid, reintroduced in the rail. The newest are the ones
  // being watched, so the window is the tail — and the button says what is
  // outside it rather than pretending there is nothing there.
  const [window, setWindow] = React.useState(ROW_WINDOW);
  const hidden = Math.max(0, filtered.length - window);
  const visible = React.useMemo(
    () => (hidden > 0 ? filtered.slice(hidden) : filtered),
    [filtered, hidden],
  );

  // Stable, so a row's props do not change identity on every parent render —
  // which is what lets React.memo below actually bite.
  const register = React.useCallback((id: string, node: HTMLDivElement | null) => {
    if (node) rows.current.set(id, node);
    else rows.current.delete(id);
  }, []);

  const toggle = React.useCallback((id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // A focus request is honoured once, when it changes. `scrollTo` on the rail's
  // own scroller rather than `scrollIntoView`, which would also scroll every
  // ancestor — including the app shell — to bring this row into view.
  React.useEffect(() => {
    if (!focusId) return;
    setExpanded((current) => (current.has(focusId) ? current : new Set(current).add(focusId)));
    const row = rows.current.get(focusId);
    const box = scroller.current;
    if (!row || !box) return;
    box.scrollTo({ top: Math.max(0, row.offsetTop - 8), behavior: 'smooth' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, focusNonce]);

  return (
    <section
      aria-label="Activity"
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'var(--font-sans)',
      }}
    >
      <div
        role="tablist"
        aria-label="Filter activity"
        style={{
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          flexWrap: isPhone ? 'wrap' : 'nowrap',
          gap: isPhone ? TOUCH_GAP : 4,
          height: isPhone ? undefined : 28,
          minHeight: isPhone ? TOUCH_TARGET + 8 : undefined,
          padding: isPhone ? '4px 12px' : '0 12px',
          borderBottom: '1px solid var(--border)',
        }}
      >
        {ACTIVITY_FILTERS.map((id) => (
          <FilterChip
            key={id}
            id={id}
            active={id === filter}
            onClick={() => onFilter(id)}
          />
        ))}
        <span
          style={{
            marginLeft: 'auto',
            flex: '0 0 auto',
            fontFamily: 'var(--font-mono)',
            fontSize: isPhone ? PHONE_TEXT.meta : 10,
            color: 'var(--muted-foreground)',
            whiteSpace: 'nowrap',
          }}
        >
          {events.length} {events.length === 1 ? 'event' : 'events'}
        </span>
      </div>

      <div
        ref={scroller}
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px 12px 8px 0' }}
      >
        {visible.length === 0 ? (
          <p
            style={{
              margin: 0,
              padding: '10px 12px',
              fontSize: 'var(--text-xs)',
              color: 'var(--muted-foreground)',
            }}
          >
            {events.length === 0
              ? 'Nothing yet. Reasoning and tool calls appear here as the agent works.'
              : 'Nothing matches this filter.'}
          </p>
        ) : (
          <div
            style={{
              position: 'relative',
              paddingLeft: 30,
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
            }}
          >
            {/* The rail the dots sit on. Inset rather than full-height so it
                does not run past the first and last events. */}
            <span
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: 15,
                top: 8,
                bottom: 6,
                width: 1,
                background: 'var(--border)',
              }}
            />
            {hidden > 0 ? (
              <button
                type="button"
                onClick={() => setWindow((current) => current + ROW_WINDOW)}
                style={{
                  alignSelf: 'flex-start',
                  marginBottom: 4,
                  minHeight: isPhone ? TOUCH_TARGET : undefined,
                  padding: isPhone ? '0 12px' : '2px 6px',
                  background: 'transparent',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: isPhone ? PHONE_TEXT.body : 10,
                  color: 'var(--muted-foreground)',
                  cursor: 'pointer',
                }}
              >
                show {Math.min(hidden, ROW_WINDOW)} earlier of {hidden}
              </button>
            ) : null}
            {visible.map((event) => (
              <ActivityRow
                key={event.id}
                event={event}
                open={expanded.has(event.id)}
                onToggle={toggle}
                onReveal={onReveal}
                onApplyHunk={onApplyHunk}
                onRevertHunk={onRevertHunk}
                register={register}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

const FILTER_LABEL: Record<ActivityFilterId, string> = {
  all: 'all',
  tools: 'tools',
  reasoning: 'reasoning',
  files: 'files',
};

function FilterChip({
  id,
  active,
  onClick,
}: {
  id: ActivityFilterId;
  active: boolean;
  onClick: () => void;
}): React.JSX.Element {
  const [hover, setHover] = React.useState(false);
  const isPhone = usePhone();
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        height: isPhone ? TOUCH_TARGET : 18,
        padding: isPhone ? '0 12px' : '0 6px',
        background: active || hover ? 'var(--accent)' : 'transparent',
        border: 0,
        borderRadius: 'var(--radius)',
        fontFamily: 'var(--font-mono)',
        fontSize: isPhone ? PHONE_TEXT.body : 10,
        color: active ? 'var(--foreground)' : 'var(--muted-foreground)',
        cursor: 'pointer',
      }}
    >
      {FILTER_LABEL[id]}
    </button>
  );
}

/**
 * One row, memoised.
 *
 * The rail redraws on every token of a streaming turn — that is the point of it
 * — so a row that re-renders when nothing about it changed is a row rendered a
 * thousand times for one command. The projection hands back a fresh event
 * object per derivation, so the comparator is explicit: a row is unchanged when
 * the fields it actually paints are unchanged.
 */
const ActivityRow = React.memo(function ActivityRow({
  event,
  open,
  onToggle,
  onReveal,
  onApplyHunk,
  onRevertHunk,
  register,
}: {
  event: ActivityEvent;
  open: boolean;
  onToggle: (id: string) => void;
  onReveal?: (messageId: string) => void;
  onApplyHunk?: (diff: FileDiff, hunkIndex: number) => void;
  onRevertHunk?: (diff: FileDiff, hunkIndex: number) => void;
  register: (id: string, node: HTMLDivElement | null) => void;
}): React.JSX.Element {
  const [hover, setHover] = React.useState(false);
  const isPhone = usePhone();
  const bodyId = React.useId();
  const reasoning = event.kind === 'reasoning';
  const status = TOOL_STATUS[event.status] || TOOL_STATUS.completed;
  const failed = event.status === 'failed';
  const running = event.status === 'running' || event.status === 'pending';
  const meta = activityMeta(event);

  const dotColor = reasoning
    ? 'var(--ansi-magenta)'
    : failed
      ? 'var(--destructive)'
      : running
        ? 'var(--info)'
        : status.color;

  return (
    <div
      ref={(node) => register(event.id, node)}
      style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 6, padding: open ? '2px 0 6px' : 0 }}
    >
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: -21,
          top: 5,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 14,
          height: 14,
          // Opaque, so the rail line does not run through the glyph.
          background: 'var(--sidebar)',
          border: `1px solid ${
            reasoning ? 'var(--border)' : `color-mix(in oklab, ${dotColor} 50%, transparent)`
          }`,
          color: dotColor,
        }}
      >
        <span style={{ animation: running && !reasoning ? 'relay-spin 900ms linear infinite' : undefined, display: 'inline-flex' }}>
          <Icon name={reasoning ? 'brain' : status.icon} size={9} />
        </span>
      </span>

      <button
        type="button"
        onClick={() => onToggle(event.id)}
        aria-expanded={open}
        aria-controls={bodyId}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          minWidth: 0,
          minHeight: isPhone ? TOUCH_TARGET : 24,
          padding: isPhone ? '4px 0' : 0,
          textAlign: 'left',
          background: hover ? 'var(--accent)' : 'transparent',
          border: 0,
          font: 'inherit',
          cursor: 'pointer',
          transition: 'background var(--duration-fast) var(--ease-standard)',
        }}
      >
        {reasoning ? null : (
          <Icon
            name={KIND_ICON[event.toolKind || 'other'] || 'wrench'}
            size={isPhone ? 15 : 10}
            style={{ color: 'var(--muted-foreground)', flex: '0 0 auto' }}
          />
        )}
        <span
          style={{
            flex: '0 0 auto',
            fontFamily: 'var(--font-mono)',
            fontSize: isPhone ? PHONE_TEXT.meta : 10.5,
            color: reasoning
              ? 'var(--muted-foreground)'
              : failed
                ? 'var(--destructive)'
                : 'var(--ansi-cyan)',
          }}
        >
          {reasoning ? 'reasoning' : event.name}
        </span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontFamily: 'var(--font-mono)',
            fontSize: isPhone ? PHONE_TEXT.meta : 10.5,
            color: 'var(--muted-foreground)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {event.target}
        </span>
        {meta ? (
          <span
            style={{
              flex: '0 0 auto',
              fontFamily: 'var(--font-mono)',
              fontSize: isPhone ? PHONE_TEXT.meta : 10,
              color: running ? 'var(--info)' : 'var(--muted-foreground)',
            }}
          >
            {meta}
          </span>
        ) : null}
        {/* The outcome as a word, for anything that cannot see the dot. */}
        <span style={SR_ONLY}>{reasoning ? 'reasoning' : status.label}</span>
        <Icon
          name="chevron-right"
          size={11}
          style={{
            flex: '0 0 auto',
            color: 'var(--muted-foreground)',
            transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform var(--duration-fast) var(--ease-standard)',
          }}
        />
      </button>

      {open ? (
        <div id={bodyId} style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
          {reasoning ? (
            <div
              style={{
                padding: '6px 8px',
                background: 'var(--terminal-bg)',
                border: '1px solid var(--border)',
                maxHeight: 220,
                overflow: 'auto',
                color: 'var(--muted-foreground)',
                fontSize: 'var(--text-sm)',
              }}
            >
              <Markdown text={(event.block as ThinkingBlock).text} dense />
            </div>
          ) : (
            <ToolCallCard
              block={event.block as ToolBlock}
              defaultOpen
              onApplyHunk={onApplyHunk}
              onRevertHunk={onRevertHunk}
            />
          )}
          {onReveal ? (
            <button
              type="button"
              onClick={() => onReveal(event.messageId)}
              style={{
                alignSelf: 'flex-start',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                height: isPhone ? TOUCH_TARGET : 20,
                padding: isPhone ? '0 12px' : '0 6px',
                background: 'transparent',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius)',
                fontFamily: 'var(--font-mono)',
                fontSize: isPhone ? PHONE_TEXT.body : 10,
                color: 'var(--muted-foreground)',
                cursor: 'pointer',
              }}
            >
              <Icon name="corner-up-left" size={isPhone ? 16 : 10} />
              show in transcript
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}, (before, after) => {
  const a = before.event;
  const b = after.event;
  return (
    before.open === after.open
    && before.onToggle === after.onToggle
    && before.onReveal === after.onReveal
    && before.register === after.register
    && a.id === b.id
    && a.status === b.status
    && a.name === b.name
    && a.target === b.target
    && a.durationMs === b.durationMs
    && a.diffs === b.diffs
    // An open row always redraws. The reducer mutates blocks in place, so the
    // block's identity is stable across a whole streaming call — comparing it
    // would freeze an expanded card at whatever output it had when it opened.
    // Closed rows are the ones there are hundreds of, and those are covered by
    // the scalar comparisons above.
    && !after.open
  );
});

/** How many rows the rail draws before it asks. */
const ROW_WINDOW = 120;

const SR_ONLY: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0,0,0,0)',
  whiteSpace: 'nowrap',
};
