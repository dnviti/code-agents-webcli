import * as React from 'react';
import { ChatCapabilities, ChatState, ChatUsage } from '../../../shared/chat-events.js';
import { Badge } from '../../ui/relay/Badge.js';
import { Icon } from '../../ui/relay/Icon.js';
import { IconButton } from '../../ui/relay/IconButton.js';
import { Kbd } from '../../ui/relay/Kbd.js';
import { Tooltip } from '../../ui/relay/Tooltip.js';
import { PHONE_SPACE, PHONE_TEXT, TOUCH_GAP, TOUCH_TARGET } from '../../ui/touch.js';
import { UsageMeter } from './UsageMeter.js';

/**
 * The one bar above the conversation: where you are, what it is doing, what it
 * has cost, and the three zones you can switch off.
 *
 * 34px, and it has to hold a money figure at 924px as well as at 1600px. The
 * rule that makes that work is stated once here and repeated nowhere: the
 * *low-value* items shrink (`min-width: 0` + ellipsis) and the numbers never do
 * (`flex: 0 0 auto`). A header that wraps is a header that changes the height of
 * everything below it, and a cost that ellipsises is worse than no cost at all.
 */

export interface SessionHeaderProps {
  runtimeLabel: string;
  workingDir: string;
  /** From the workspace status endpoint; absent outside a git repo. */
  branch?: string;
  usage: ChatUsage;
  capabilities: ChatCapabilities;
  state: ChatState;
  /**
   * The process behind this conversation is gone.
   *
   * Passed separately because the event log replays to `idle` on its own — a
   * conversation that ended on a finished turn reads as Ready — and the state of
   * the *process* has to win over the state of the transcript.
   */
  exited?: boolean;
  bypassPermissions?: boolean;
  showUsage?: boolean;
  terminalOpen: boolean;
  railOpen: boolean;
  indexOpen: boolean;
  isMobile?: boolean;
  /**
   * Not enough width for the decoration.
   *
   * The bar sheds in a fixed order, and the order is the whole point: the Beta
   * badge goes first (it says nothing about this session), then the branch (the
   * composer carries it too), then the search field shrinks to its glyph. The
   * money, the context meter and the state chip never go — they are what
   * somebody looks at the header *for*, and a cost pushed off the right edge is
   * worse than one that was never drawn.
   */
  compact?: boolean;
  theme?: 'dark' | 'light';
  onToggleTerminal(): void;
  onToggleRail(): void;
  onToggleIndex(): void;
  onOpenSearch(): void;
  onOpenSettings(): void;
  onToggleTheme?: () => void;
}

interface StateMeta {
  label: string;
  color: string;
  tint?: string;
  pulse?: boolean;
}

/**
 * One word per state, and a dot that only ever reinforces it.
 *
 * Colour is never the carrier: `awaiting_permission` and `error` are different
 * kinds of stop, and someone who cannot separate amber from red still has to be
 * able to tell "it is waiting for you" from "it broke".
 */
const STATE_META: Record<ChatState, StateMeta> = {
  starting: { label: 'starting', color: 'var(--muted-foreground)', pulse: true },
  idle: { label: 'ready', color: 'var(--muted-foreground)' },
  thinking: { label: 'thinking', color: 'var(--info)', tint: 'var(--info)', pulse: true },
  running: { label: 'working', color: 'var(--info)', tint: 'var(--info)', pulse: true },
  awaiting_permission: {
    label: 'waiting for you',
    color: 'var(--warning)',
    tint: 'var(--warning)',
    pulse: true,
  },
  exited: { label: 'exited', color: 'var(--muted-foreground)' },
  error: { label: 'error', color: 'var(--destructive)', tint: 'var(--destructive)' },
};

/** Announced but not painted — the bar shows a leaf, screen readers get the path. */
const SR_ONLY: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0,0,0,0)',
};

export function SessionHeader({
  runtimeLabel,
  workingDir,
  branch,
  usage,
  capabilities,
  state,
  exited = false,
  bypassPermissions = false,
  showUsage = true,
  terminalOpen,
  railOpen,
  indexOpen,
  isMobile = false,
  compact = false,
  theme,
  onToggleTerminal,
  onToggleRail,
  onToggleIndex,
  onOpenSearch,
  onOpenSettings,
  onToggleTheme,
}: SessionHeaderProps): React.JSX.Element {
  const meta = exited ? STATE_META.exited : STATE_META[state] || STATE_META.idle;
  // A phone is always the tightest case.
  const tight = compact;

  if (isMobile) {
    return (
      <PhoneHeader
        runtimeLabel={runtimeLabel}
        workingDir={workingDir}
        branch={branch}
        usage={usage}
        capabilities={capabilities}
        meta={meta}
        bypassPermissions={bypassPermissions}
        showUsage={showUsage}
      />
    );
  }

  return (
    <header
      style={{
        flex: '0 0 auto',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        minWidth: 0,
        height: 34,
        padding: '0 10px',
        background: 'var(--chrome)',
        borderBottom: '1px solid var(--border)',
        color: 'var(--chrome-foreground)',
        fontFamily: 'var(--font-sans)',
      }}
    >
      <span
        style={{
          flex: '0 0 auto',
          fontSize: 12.5,
          fontWeight: 'var(--font-semibold)' as React.CSSProperties['fontWeight'],
          letterSpacing: 'var(--tracking-tight)',
          whiteSpace: 'nowrap',
        }}
      >
        {runtimeLabel}
      </span>

      <Tooltip label={workingDir} side="bottom">
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            minWidth: 0,
            maxWidth: 220,
            fontFamily: 'var(--font-mono)',
            fontSize: 10.5,
            color: 'var(--muted-foreground)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          <Icon name="folder" size={11} />
          {basename(workingDir)}
          <span style={SR_ONLY}>{workingDir}</span>
        </span>
      </Tooltip>

      {branch && !tight ? (
        <span
          title={`On branch ${branch}`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            minWidth: 0,
            maxWidth: 180,
            fontFamily: 'var(--font-mono)',
            fontSize: 10.5,
            color: 'var(--ansi-cyan)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          <Icon name="git-branch" size={11} />
          {branch}
        </span>
      ) : null}

      {compact ? null : <Badge variant="outline">Beta</Badge>}

      {tight ? null : <SearchTrigger onClick={onOpenSearch} />}

      {/* Everything from here right is the readout, and none of it shrinks. */}
      <span
        style={{
          marginLeft: 'auto',
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        {showUsage ? (
          // Renders nothing at all when the runtime has reported no numbers,
          // which is exactly the "when there is usage to show" rule — deciding
          // it twice is how the two answers drift apart.
          <UsageMeter usage={usage} capabilities={capabilities} compact />
        ) : null}

        <span
          role="status"
          aria-live="polite"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            flex: '0 0 auto',
            height: 20,
            padding: '0 7px',
            whiteSpace: 'nowrap',
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            background: meta.tint
              ? `color-mix(in oklab, ${meta.tint} 12%, transparent)`
              : 'transparent',
            border: `1px solid ${
              meta.tint ? `color-mix(in oklab, ${meta.tint} 40%, transparent)` : 'var(--border)'
            }`,
            color: meta.color,
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 5,
              height: 5,
              borderRadius: 'var(--radius-full)',
              background: 'currentColor',
              animation: meta.pulse ? 'relay-pulse 1.4s var(--ease-standard) infinite' : undefined,
            }}
          />
          {meta.label}
        </span>

        {bypassPermissions ? (
          <Badge variant="warning" style={{ flex: '0 0 auto' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Icon name="shield" size={10} />
              Approvals bypassed
            </span>
          </Badge>
        ) : null}

        {tight ? null : (
          <button
            type="button"
            onClick={onToggleTerminal}
            aria-pressed={terminalOpen}
            aria-label={terminalOpen ? 'Close the terminal' : 'Open a terminal here'}
            title="Toggle terminal — Ctrl+`"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              flex: '0 0 auto',
              height: 20,
              padding: '0 8px',
              whiteSpace: 'nowrap',
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              background: terminalOpen ? 'var(--secondary)' : 'transparent',
              border: `1px solid ${terminalOpen ? 'var(--border-strong)' : 'var(--border)'}`,
              borderRadius: 'var(--radius)',
              color: terminalOpen ? 'var(--foreground)' : 'var(--muted-foreground)',
              cursor: 'pointer',
            }}
          >
            <Icon name="terminal" size={10} />
            terminal
            <span style={{ color: 'var(--muted-foreground)' }}>^`</span>
          </button>
        )}

        {tight ? (
          <IconButton
            type="button"
            size="md"
            label="Search this conversation"
            onClick={onOpenSearch}
          >
            <Icon name="search" />
          </IconButton>
        ) : null}

        {onToggleTheme ? (
          <IconButton
            type="button"
            size="md"
            label={theme === 'light' ? 'Switch to the dark theme' : 'Switch to the light theme'}
            onClick={onToggleTheme}
          >
            <Icon name="monitor" />
          </IconButton>
        ) : null}

        <IconButton
          type="button"
          size="md"
          label={indexOpen ? 'Hide the turn index' : 'Show the turn index'}
          aria-pressed={indexOpen}
          active={indexOpen}
          onClick={onToggleIndex}
        >
          <Icon name="panel-left" />
        </IconButton>

        <IconButton
          type="button"
          size="md"
          label={railOpen ? 'Hide the trace rail' : 'Show the trace rail'}
          aria-pressed={railOpen}
          active={railOpen}
          onClick={onToggleRail}
        >
          <Icon name="panel-right" />
        </IconButton>

        <IconButton
          type="button"
          size="md"
          label="Chat display settings"
          onClick={onOpenSettings}
        >
          <Icon name="settings" />
        </IconButton>
      </span>
    </header>
  );
}

/**
 * The same bar, laid out for a phone — and mostly not laid out at all.
 *
 * A separate component rather than a dozen `isMobile ?` ternaries, because the
 * answer is not "the same row, smaller". The two layouts disagree about their
 * shape, and now about how much of themselves they show:
 *
 *   - The desktop bar is one fixed 34px line that must never wrap, and sheds
 *     items to stay on it.
 *   - The phone bar is a strip saying what the session is doing and what it has
 *     cost, and nothing else until it is asked. Tapping it opens the rest — the
 *     runtime, the folder, the branch, the tokens, the context meter, the
 *     approvals state — at a size worth reading, and tapping it again gives the
 *     room back to the conversation.
 *
 * Collapsed by default because the conversation is what a phone is for. The two
 * figures that stay are the two that change while you watch: what it is doing,
 * and what that has cost so far.
 *
 * The controls that used to sit here are gone from the bar entirely — they are
 * in the floating menu now, published by ChatView. A row of them here was a row
 * of chrome the transcript never got back.
 */
function PhoneHeader({
  runtimeLabel,
  workingDir,
  branch,
  usage,
  capabilities,
  meta,
  bypassPermissions,
  showUsage,
}: {
  runtimeLabel: string;
  workingDir: string;
  branch?: string;
  usage: ChatUsage;
  capabilities: ChatCapabilities;
  meta: StateMeta;
  bypassPermissions: boolean;
  showUsage: boolean;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const detailId = React.useId();

  return (
    <header
      style={{
        flex: '0 0 auto',
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        background: 'var(--chrome)',
        borderBottom: '1px solid var(--border)',
        color: 'var(--chrome-foreground)',
        fontFamily: 'var(--font-sans)',
      }}
    >
      {/* The whole strip is the control. A 44px button in the corner of it
          would be a second thing to aim at on a bar one line tall; the bar
          itself is a far bigger target than any button on it. */}
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailId}
        aria-label={open ? 'Hide the session details' : 'Show the session details'}
        onClick={() => setOpen((value) => !value)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: PHONE_SPACE.inline,
          width: '100%',
          // The floor, like every other control. A full-width strip is an easy
          // thing to hit at any height, but "easy" is not the rule and 10px is
          // not what the conversation was short of.
          minHeight: TOUCH_TARGET,
          padding: `2px ${PHONE_SPACE.edge}px`,
          background: 'transparent',
          border: 0,
          color: 'inherit',
          font: 'inherit',
          textAlign: 'left',
          cursor: 'pointer',
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        <span
          role="status"
          aria-live="polite"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            flex: '0 0 auto',
            minWidth: 0,
            whiteSpace: 'nowrap',
            fontFamily: 'var(--font-mono)',
            fontSize: PHONE_TEXT.label,
            color: meta.color,
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 7,
              height: 7,
              flex: '0 0 auto',
              borderRadius: 'var(--radius-full)',
              background: 'currentColor',
              animation: meta.pulse ? 'relay-pulse 1.4s var(--ease-standard) infinite' : undefined,
            }}
          />
          {meta.label}
        </span>

        {/* Collapsed, the cost is the one figure worth the width. The rest of
            the meter is below, where there is room for it. */}
        <span style={{ marginLeft: 'auto', flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', gap: PHONE_SPACE.inline }}>
          {showUsage && !open ? (
            <UsageMeter usage={usage} capabilities={capabilities} compact phone costOnly />
          ) : null}

          {bypassPermissions && !open ? (
            <Icon name="shield" size={14} style={{ color: 'var(--warning)' }} />
          ) : null}

          <Icon
            name={open ? 'chevron-up' : 'chevron-down'}
            size={16}
            style={{ color: 'var(--muted-foreground)' }}
          />
        </span>
      </button>

      {open ? (
        <div
          id={detailId}
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            columnGap: PHONE_SPACE.inline,
            rowGap: 4,
            minWidth: 0,
            padding: `0 ${PHONE_SPACE.edge}px 8px`,
          }}
        >
          <span
            style={{
              fontSize: PHONE_TEXT.meta,
              fontWeight: 'var(--font-semibold)' as React.CSSProperties['fontWeight'],
              letterSpacing: 'var(--tracking-tight)',
              whiteSpace: 'nowrap',
            }}
          >
            {runtimeLabel}
          </span>

          <span
            title={workingDir}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              minWidth: 0,
              maxWidth: 150,
              fontFamily: 'var(--font-mono)',
              fontSize: PHONE_TEXT.meta,
              color: 'var(--muted-foreground)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            <Icon name="folder" size={12} />
            {basename(workingDir)}
            <span style={SR_ONLY}>{workingDir}</span>
          </span>

          {branch ? (
            <span
              title={`On branch ${branch}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                minWidth: 0,
                maxWidth: 150,
                fontFamily: 'var(--font-mono)',
                fontSize: PHONE_TEXT.meta,
                color: 'var(--ansi-cyan)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              <Icon name="git-branch" size={12} />
              {branch}
            </span>
          ) : null}

          {showUsage ? <UsageMeter usage={usage} capabilities={capabilities} compact phone /> : null}

          {bypassPermissions ? (
            <Badge
              variant="warning"
              aria-label="Approvals bypassed"
              style={{ flex: '0 0 auto', height: 'auto', padding: '1px 8px', fontSize: PHONE_TEXT.label }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <Icon name="shield" size={12} />
                Approvals bypassed
              </span>
            </Badge>
          ) : null}
        </div>
      ) : null}
    </header>
  );
}

/**
 * The search field that is not a field.
 *
 * A real input here would be a second place to type on a surface whose whole
 * point is the composer, and it would take the ⌘F shortcut's landing spot with
 * it. This is a button shaped like an input: it opens ChatSearch, which is the
 * component that actually knows how to search a transcript.
 */
function SearchTrigger({ onClick }: { onClick: () => void }): React.JSX.Element {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Search this conversation"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        height: 22,
        padding: '0 8px',
        marginLeft: 2,
        // Shrinks before anything else on the row, down to a glyph and a hint.
        flex: '0 1 240px',
        minWidth: 104,
        overflow: 'hidden',
        background: 'var(--input)',
        border: `1px solid ${hover ? 'var(--border-strong)' : 'var(--border)'}`,
        borderRadius: 'var(--radius)',
        color: 'var(--muted-foreground)',
        cursor: 'pointer',
        transition: 'border-color var(--duration-fast) var(--ease-standard)',
      }}
    >
      <Icon name="search" size={11} />
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 'var(--text-xs)',
          textAlign: 'left',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        Search transcript
      </span>
      <Kbd style={{ height: 16, minWidth: 0, fontSize: 9.5, flex: '0 0 auto' }}>⌘F</Kbd>
    </button>
  );
}

/** Trailing-slash tolerant leaf of a path, in either separator style. */
export function basename(dir: string): string {
  const trimmed = String(dir || '').replace(/[/\\]+$/, '');
  if (!trimmed) return dir || '/';
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return cut >= 0 ? trimmed.slice(cut + 1) || trimmed : trimmed;
}
