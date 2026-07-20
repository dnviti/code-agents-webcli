import * as React from 'react';

import type { AgentKind, Aliases, RuntimeStartOptions } from '../types';
import { Button } from '../ui/relay/Button';
import { Icon } from '../ui/relay/Icon';
import { LaunchCard } from '../ui/relay/LaunchCard';

export interface RuntimeLauncherProps {
  aliases: Aliases;
  onStart(kind: AgentKind, options?: RuntimeStartOptions): void;
  /** The shell/command chooser, which stays a separate modal. */
  onTerminal(): void;
  onCancel(): void;
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
];

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
        {RUNTIMES.map((runtime) => (
          <LaunchCard
            key={runtime.kind}
            icon="cpu"
            label={aliases[runtime.kind] || runtime.kind}
            meta={runtime.binary}
            onClick={() => onStart(runtime.kind)}
            action={
              runtime.dangerous ? (
                <Button
                  variant="destructive"
                  size="sm"
                  // The card itself starts the runtime safely; this is a
                  // separate target so the bypass cannot be hit by aiming at
                  // the card. The title states the actual consequence rather
                  // than the word "dangerous", which says nothing.
                  title={`Start ${aliases[runtime.kind]} in a mode that ${runtime.dangerous}.`}
                  onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
                    event.stopPropagation();
                    onStart(runtime.kind, { dangerouslySkipPermissions: true });
                  }}
                >
                  No prompts
                </Button>
              ) : null
            }
          />
        ))}
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
