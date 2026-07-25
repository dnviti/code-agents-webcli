import * as React from 'react';

import type { AgentKind, Aliases, RuntimeStartOptions } from '../types';
import { Button } from '../ui/relay/Button';
import { Icon } from '../ui/relay/Icon';
import { LaunchCard } from '../ui/relay/LaunchCard';
import { CHAT_LAUNCH_LABEL, chatUnavailableReason } from '../../shared/chat-runtimes';

export interface RuntimeLauncherProps {
  aliases: Aliases;
  onStart(kind: AgentKind, options?: RuntimeStartOptions): void;
  /** The shell/command chooser, which stays a separate modal. */
  onTerminal(): void;
  onCancel(): void;
  /**
   * Drop the button labels and show icons only.
   *
   * Two actions per card is more than a phone-width card can carry as text, and
   * truncating either one would leave the destructive control reading as
   * something shorter and friendlier than it is.
   */
  compact?: boolean;
}

interface RuntimeEntry {
  kind: AgentKind;
  /** The binary the bridge actually looks for, shown so a missing CLI is diagnosable. */
  binary: string;
  /**
   * What the runtime's own bypass flag does, in its own terms. Null means the
   * CLI has no true tool-approval bypass, and no Dangerous affordance is
   * offered — pi's --approve and Cursor's flags are not equivalents, and
   * pretending otherwise would promise a bypass the user does not get.
   */
  dangerous: string | null;
}

const RUNTIMES: RuntimeEntry[] = [
  { kind: 'claude', binary: 'claude', dangerous: 'skips every permission prompt' },
  { kind: 'codex', binary: 'codex', dangerous: 'bypasses approvals and the sandbox' },
  { kind: 'agent', binary: 'cursor-agent', dangerous: null },
  { kind: 'pi', binary: 'pi', dangerous: null },
  { kind: 'grok', binary: 'grok', dangerous: 'auto-approves every tool call' },
  { kind: 'qwen', binary: 'qwen', dangerous: 'auto-accepts every action (--yolo)' },
  { kind: 'kimi', binary: 'kimi', dangerous: 'auto-approves every action (--yolo)' },
  { kind: 'omp', binary: 'omp', dangerous: 'auto-approves every tool call (--auto-approve)' },
];

/**
 * Opens a runtime as a web chat instead of a terminal.
 *
 * The surface is decided here and never changes afterwards: a TUI in a PTY and
 * a headless protocol stream are different processes, so "switch this session
 * to chat" would mean killing the agent and restarting it. Asking once, at the
 * only moment when there is nothing to lose, is the cheaper trade.
 *
 * Rendered disabled rather than hidden when a runtime has no chat adapter. A
 * missing button reads as an oversight; a disabled one with a reason answers
 * the question the user was about to ask.
 */
function ChatLaunchButton({
  label,
  kind,
  compact,
  onStart,
}: {
  label: string;
  kind: AgentKind;
  compact?: boolean;
  onStart(kind: AgentKind, options?: RuntimeStartOptions): void;
}): React.JSX.Element {
  const unavailable = chatUnavailableReason(kind);

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={Boolean(unavailable)}
      // Blue, from the one blue the design system already has. `--info` flips
      // between a light blue on dark and a dark blue on light, and pairing it
      // with `--background` as the foreground keeps the contrast right in both
      // directions — a fixed white or black would fail one of the two themes.
      style={
        unavailable
          ? undefined
          : {
              background: 'var(--info)',
              borderColor: 'var(--info)',
              color: 'var(--background)',
            }
      }
      title={
        unavailable
          ? `${CHAT_LAUNCH_LABEL} is unavailable for ${label}. ${unavailable}`
          : `Open ${label} as a chat in the browser instead of a terminal. This surface is in beta.`
      }
      aria-label={compact ? `Open ${label} as a web chat (beta)` : undefined}
      onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        if (unavailable) return;
        onStart(kind, { surface: 'chat' });
      }}
    >
      {compact ? (
        <Icon name="message-square" size={13} />
      ) : (
        CHAT_LAUNCH_LABEL
      )}
    </Button>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div
      style={{
        marginTop: 26,
        marginBottom: 10,
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--text-2xs)',
        textTransform: 'uppercase',
        letterSpacing: 'var(--tracking-caps)',
        color: 'var(--muted-foreground)',
      }}
    >
      {children}
    </div>
  );
}

export function RuntimeLauncher({
  aliases,
  onStart,
  onTerminal,
  onCancel,
  compact,
}: RuntimeLauncherProps): React.JSX.Element {
  return (
    <div
      style={{
        width: 560,
        maxWidth: '90vw',
        maxHeight: '86vh',
        overflow: 'auto',
        padding: '28px 26px 24px',
        background: 'var(--background)',
        border: '1px solid var(--border)',
        boxShadow: 'var(--shadow-lg)',
        textAlign: 'left',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          fontFamily: 'var(--font-mono)',
          fontSize: 26,
          fontWeight: 700,
          letterSpacing: '-0.02em',
          color: 'var(--foreground)',
        }}
      >
        <span>launch</span>
        <span
          style={{
            display: 'inline-block',
            width: 12,
            height: 23,
            marginLeft: 2,
            background: 'var(--foreground)',
            animation: 'relay-cursor-blink 1.1s step-end infinite',
          }}
        />
      </div>
      <div
        style={{
          marginTop: 8,
          color: 'var(--muted-foreground)',
          fontSize: 'var(--text-body)',
        }}
      >
        Pick a runtime for this working directory.
      </div>

      <SectionLabel>Agents</SectionLabel>
      <div style={{ display: 'grid', gap: 8 }}>
        {RUNTIMES.map((runtime) => {
          // One fallback, used by both the label and the tooltip. Computed once
          // so the two cannot drift — the tooltip previously read the alias
          // straight through and would have said "Start undefined" for a
          // runtime whose alias was missing while the card still read fine.
          const label = aliases[runtime.kind] || runtime.kind;
          return (
          <LaunchCard
            key={runtime.kind}
            icon="cpu"
            label={label}
            meta={runtime.binary}
            onClick={() => onStart(runtime.kind)}
            action={
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <ChatLaunchButton
                  label={label}
                  kind={runtime.kind}
                  compact={compact}
                  onStart={onStart}
                />
                {runtime.dangerous ? (
                  <Button
                    variant="destructive"
                    size="sm"
                    // The card itself starts the runtime safely; this is a
                    // separate target so the bypass cannot be hit by aiming at
                    // the card. The title states the actual consequence rather
                    // than the word "dangerous", which says nothing.
                    title={`Start ${label} in a mode that ${runtime.dangerous}.`}
                    aria-label={
                      compact ? `Start ${label} with no permission prompts` : undefined
                    }
                    onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
                      event.stopPropagation();
                      onStart(runtime.kind, { dangerouslySkipPermissions: true });
                    }}
                  >
                    {compact ? <Icon name="circle-alert" size={13} /> : 'No prompts'}
                  </Button>
                ) : null}
              </div>
            }
          />
          );
        })}
      </div>

      <SectionLabel>Terminal</SectionLabel>
      <LaunchCard
        icon="terminal"
        label={aliases.terminal || 'Terminal'}
        meta="interactive shell, or a single command"
        onClick={onTerminal}
      />

      <div
        style={{
          marginTop: 22,
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 8,
        }}
      >
        <Button variant="secondary" size="md" onClick={onCancel} iconLeft={<Icon name="x" size={13} />}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
