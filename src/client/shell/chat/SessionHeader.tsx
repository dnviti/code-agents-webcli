import * as React from 'react';
import { ChatCapabilities, ChatState, ChatUsage } from '../../../shared/chat-events.js';
import { Badge } from '../../ui/relay/Badge.js';
import { Icon } from '../../ui/relay/Icon.js';
import { IconButton } from '../../ui/relay/IconButton.js';
import { Kbd } from '../../ui/relay/Kbd.js';
import { Tooltip } from '../../ui/relay/Tooltip.js';
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

/** Touch-target floor for this app's phone layout; matches IconButton size="lg". */
const TOUCH = 34;

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
  const tight = compact || isMobile;

  return (
    <header
      style={{
        flex: '0 0 auto',
        display: 'flex',
        alignItems: 'center',
        gap: isMobile ? 6 : 10,
        minWidth: 0,
        // A phone's header wraps rather than dropping what is on it: the money
        // and the context meter are worth a second row, and a fixed height
        // would have to throw one of them away to keep the bar to one line.
        flexWrap: isMobile ? 'wrap' : 'nowrap',
        height: isMobile ? undefined : 34,
        minHeight: isMobile ? TOUCH + 6 : undefined,
        padding: isMobile ? '3px 10px' : '0 10px',
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
            maxWidth: isMobile ? 120 : 220,
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

      {compact && !isMobile ? null : <Badge variant="outline">Beta</Badge>}

      {tight ? null : <SearchTrigger onClick={onOpenSearch} />}

      {/* Everything from here right is the readout, and none of it shrinks. */}
      <span
        style={{
          marginLeft: 'auto',
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          gap: isMobile ? 4 : 10,
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
              {isMobile ? 'bypassed' : 'Approvals bypassed'}
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
            size={isMobile ? 'lg' : 'md'}
            label="Search this conversation"
            onClick={onOpenSearch}
          >
            <Icon name="search" />
          </IconButton>
        ) : null}

        {onToggleTheme ? (
          <IconButton
            type="button"
            size={isMobile ? 'lg' : 'md'}
            label={theme === 'light' ? 'Switch to the dark theme' : 'Switch to the light theme'}
            onClick={onToggleTheme}
          >
            <Icon name="monitor" />
          </IconButton>
        ) : null}

        <IconButton
          type="button"
          size={isMobile ? 'lg' : 'md'}
          label={indexOpen ? 'Hide the turn index' : 'Show the turn index'}
          aria-pressed={indexOpen}
          active={indexOpen}
          onClick={onToggleIndex}
        >
          <Icon name="panel-left" />
        </IconButton>

        <IconButton
          type="button"
          size={isMobile ? 'lg' : 'md'}
          label={railOpen ? 'Hide the trace rail' : 'Show the trace rail'}
          aria-pressed={railOpen}
          active={railOpen}
          onClick={onToggleRail}
        >
          <Icon name="panel-right" />
        </IconButton>

        <IconButton
          type="button"
          size={isMobile ? 'lg' : 'md'}
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
