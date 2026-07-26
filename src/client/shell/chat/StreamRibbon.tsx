import * as React from 'react';
import { ChatState } from '../../../shared/chat-events.js';
import { activityForTurn, type ActivityEvent } from '../../chat/activity.js';
import type { ChatTranscript } from '../../chat/transcript.js';
import type { TurnSummary } from '../../chat/turns.js';
import { compactCount, formatDuration } from '../../chat/tool-meta.js';
import { Icon } from '../../ui/relay/Icon.js';
import { PHONE_TEXT, TOUCH_GAP, TOUCH_TARGET, usePhone } from '../../ui/touch.js';
import { useActivity } from './use-activity.js';

/**
 * The one line that says the agent is still going, and stops it.
 *
 * Sits between the terminal split and the composer, and only while something is
 * running. It exists because the header's state chip is 20px of colour at the
 * far top of a tall surface: with the transcript scrolled up, or the terminal
 * open, "is it still working, and on what" was a question the surface could not
 * answer without scrolling somewhere.
 *
 * The stop control lives here rather than only in the composer for the same
 * reason the approvals do: the thing you need when a turn goes wrong must not be
 * somewhere you have to go looking for.
 */

export interface StreamRibbonProps {
  state: ChatState;
  /** What the agent is doing right now — the running tool's target, usually. */
  label?: string;
  /** Milliseconds since the turn started. */
  elapsedMs?: number;
  outputTokens?: number;
  canInterrupt: boolean;
  onInterrupt(): void;
}

type Tone = 'working' | 'waiting' | 'error';

const TONE: Record<Tone, string> = {
  working: 'var(--info)',
  waiting: 'var(--warning)',
  error: 'var(--destructive)',
};

export function StreamRibbon({
  state,
  label,
  elapsedMs,
  outputTokens,
  canInterrupt,
  onInterrupt,
}: StreamRibbonProps): React.JSX.Element {
  const isPhone = usePhone();
  const tone: Tone =
    state === 'error'
      ? 'error'
      : state === 'awaiting_permission' || state === 'awaiting_answer'
        ? 'waiting'
        : 'working';
  const colour = TONE[tone];
  const working = tone === 'working';

  const text = label
    || (state === 'awaiting_permission'
      ? 'Waiting for you to answer the approval above'
      : state === 'awaiting_answer'
        ? 'Waiting for you to answer the question above'
      : state === 'starting'
        ? 'Starting'
        : state === 'thinking'
          ? 'Thinking'
          : 'Working');

  const meta: string[] = [];
  if (elapsedMs !== undefined) {
    const formatted = formatDuration(elapsedMs);
    if (formatted) meta.push(formatted);
  }
  if (outputTokens !== undefined && outputTokens > 0) {
    meta.push(`${compactCount(outputTokens)} out`);
  }

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        flex: '0 0 auto',
        display: 'flex',
        alignItems: 'center',
        // One line on a phone too. What earns the width is what it is doing
        // and the control that stops it; the elapsed time and the token count
        // are dropped below rather than wrapped, because a ribbon that wraps is
        // 40px the conversation does not get and neither figure is one you act
        // on.
        flexWrap: 'nowrap',
        gap: isPhone ? TOUCH_GAP : 10,
        minWidth: 0,
        height: isPhone ? undefined : 34,
        minHeight: isPhone ? TOUCH_TARGET + 4 : undefined,
        padding: isPhone ? '2px 12px' : '0 14px',
        background: `color-mix(in oklab, ${colour} 10%, transparent)`,
        borderTop: `1px solid color-mix(in oklab, ${colour} 32%, transparent)`,
        fontFamily: 'var(--font-sans)',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: 'inline-flex',
          flex: '0 0 auto',
          color: colour,
          animation: working ? 'relay-spin 900ms linear infinite' : undefined,
        }}
      >
        <Icon
          name={working ? 'loader-circle' : tone === 'waiting' ? 'shield' : 'circle-alert'}
          size={isPhone ? 16 : 12}
        />
      </span>

      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: isPhone ? PHONE_TEXT.body : 11.5,
          color: colour,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {text}
      </span>

      {meta.length && !isPhone ? (
        <span
          style={{
            flex: '0 0 auto',
            fontFamily: 'var(--font-mono)',
            fontSize: isPhone ? PHONE_TEXT.label : 10,
            color: 'var(--muted-foreground)',
            whiteSpace: 'nowrap',
          }}
        >
          {meta.join(' · ')}
        </span>
      ) : null}

      <StopButton canInterrupt={canInterrupt} onClick={onInterrupt} />
    </div>
  );
}

/**
 * Disabled rather than hidden when the runtime has no interrupt channel.
 *
 * A control that vanished would read as a bug; one that says why reads as a
 * property of the runtime, which is what it is.
 */
function StopButton({
  canInterrupt,
  onClick,
}: {
  canInterrupt: boolean;
  onClick: () => void;
}): React.JSX.Element {
  const [hover, setHover] = React.useState(false);
  const isPhone = usePhone();
  const label = canInterrupt ? 'Stop this turn' : 'This runtime cannot be interrupted';
  return (
    <button
      type="button"
      onClick={canInterrupt ? onClick : undefined}
      disabled={!canInterrupt}
      aria-label={label}
      title={label}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        flex: '0 0 auto',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: isPhone ? TOUCH_TARGET : 22,
        padding: isPhone ? '0 14px' : '0 9px',
        background: hover && canInterrupt ? 'var(--accent)' : 'var(--secondary)',
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--radius)',
        fontFamily: 'var(--font-mono)',
        fontSize: isPhone ? PHONE_TEXT.label : 10,
        color: 'var(--foreground)',
        opacity: canInterrupt ? 1 : 0.5,
        cursor: canInterrupt ? 'pointer' : 'not-allowed',
      }}
    >
      <Icon name="square" size={isPhone ? 14 : 9} />
      {/* A phone has no Escape key to name. */}
      {isPhone ? 'stop' : 'stop · esc'}
    </button>
  );
}

/**
 * The ribbon, wired to the live tier.
 *
 * Split from the presentational component so the label — "Working — bash npm
 * test" — tracks the tool that is actually running. Derived here rather than in
 * the chat root for the same reason the rail is: `transcript.subscribe` is
 * silent while a call runs, so a label computed up there said "Working" for the
 * whole of it.
 */
export function LiveStreamRibbon({
  transcript,
  turn,
  state,
  showThinking,
  showToolCalls,
  canInterrupt,
  onInterrupt,
}: {
  transcript: ChatTranscript;
  turn: TurnSummary | undefined;
  state: ChatState;
  showThinking: boolean;
  showToolCalls: boolean;
  canInterrupt: boolean;
  onInterrupt(): void;
}): React.JSX.Element {
  const events = useActivity(transcript, showThinking, showToolCalls);
  const busy = state === 'thinking' || state === 'running' || state === 'starting';

  return (
    <StreamRibbon
      state={state}
      label={ribbonLabel(events, turn, state)}
      // Recomputed on every content bump, which during a turn is every token —
      // so the elapsed figure ticks without a timer of its own.
      elapsedMs={turn && busy ? Date.now() - turn.startedAt : undefined}
      outputTokens={turn?.usage.outputTokens}
      canInterrupt={canInterrupt}
      onInterrupt={onInterrupt}
    />
  );
}

/** What the ribbon says the agent is doing, straight from the live timeline. */
function ribbonLabel(
  events: ActivityEvent[],
  turn: TurnSummary | undefined,
  state: ChatState,
): string | undefined {
  if (state === 'awaiting_permission' || state === 'awaiting_answer') return undefined;
  const scoped = turn ? activityForTurn(turn, events) : events;
  for (let i = scoped.length - 1; i >= 0; i -= 1) {
    const event = scoped[i];
    if (event.status !== 'running' && event.status !== 'pending') continue;
    if (event.kind === 'reasoning') return 'Thinking';
    return `Working — ${event.name}${event.target ? ` ${event.target}` : ''}`;
  }
  return undefined;
}
