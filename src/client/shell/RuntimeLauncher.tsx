import * as React from 'react';

import type { AgentKind, Aliases, RuntimeStartOptions } from '../types';
import type { ConversationSummary } from '../../shared/conversations';
import { Badge } from '../ui/relay/Badge';
import { Button } from '../ui/relay/Button';
import { Icon } from '../ui/relay/Icon';
import { LaunchCard } from '../ui/relay/LaunchCard';
import { CHAT_LAUNCH_LABEL, chatUnavailableReason } from '../../shared/chat-runtimes';
import {
  AGENT_MAINTENANCE_IDS,
  type AgentMaintenanceId,
  type AgentMaintenanceOperation,
  type AgentMaintenanceStatus,
} from '../../shared/agent-maintenance';
import { AgentMaintenancePickerRow } from './AgentMaintenanceStrip';

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
  /**
   * Whether a web chat launched now would skip tool approvals.
   *
   * Passed in rather than read from storage here so the button's label and the
   * flag it actually sends come from one value. The setting itself lives in the
   * app Settings dialog, where a choice with this much consequence belongs.
   */
  chatBypass?: boolean;
  /**
   * Past conversations in this working directory, newest first.
   *
   * The web counterpart of `claude --resume`: having chosen a folder, the next
   * question is usually "carry on with the one from this morning", not "start
   * over". Absent or empty simply means there are none to offer, and the
   * launcher is what it always was.
   */
  conversations?: ResumableConversation[];
  /** True while that list is still being fetched. */
  conversationsLoading?: boolean;
  onResume?(conversation: ResumableConversation): void;
  maintenance?: {
    targetName: string;
    statuses: Partial<Record<AgentMaintenanceId, AgentMaintenanceStatus>>;
    operation?: AgentMaintenanceOperation | null;
    checking?: readonly AgentMaintenanceId[];
    errors?: Partial<Record<AgentMaintenanceId, string>>;
    error?: string | null;
    operationBusyReason?: string | null;
    onInstall(agentId: AgentMaintenanceId): void | Promise<void>;
    /** Update actions belong only to the fixed notice above an opened session. */
    onUpdate?(agentId: AgentMaintenanceId): void | Promise<void>;
    onRetry(agentId: AgentMaintenanceId): void | Promise<void>;
    onCancel(): void | Promise<void>;
  };
}

/**
 * One conversation offered here, which is one conversation as any list of them
 * describes it — see shared/conversations.ts.
 *
 * An alias rather than its own shape: this list and the full conversation list
 * are two views of the same rows off the same endpoints, and two declarations of
 * that would be two things to keep in step.
 */
export type ResumableConversation = ConversationSummary;

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
  {
    kind: 'antigravity',
    binary: 'agy',
    dangerous: 'auto-approves every tool permission (--dangerously-skip-permissions)',
  },
];

function maintenanceAgent(kind: AgentKind): AgentMaintenanceId | null {
  return (AGENT_MAINTENANCE_IDS as readonly string[]).includes(kind)
    ? kind as AgentMaintenanceId
    : null;
}

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
  bypass,
  onStart,
  disabledReason,
}: {
  label: string;
  kind: AgentKind;
  compact?: boolean;
  /**
   * What the account's preference is, for the label and nothing else — the
   * launch itself names no mode. See the click handler.
   */
  bypass?: boolean;
  onStart(kind: AgentKind, options?: RuntimeStartOptions): void;
  disabledReason?: string;
}): React.JSX.Element {
  const unavailable = chatUnavailableReason(kind);
  const disabled = disabledReason || unavailable;

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={Boolean(disabled)}
      // Blue, from the one blue the design system already has. `--info` flips
      // between a light blue on dark and a dark blue on light, and pairing it
      // with `--background` as the foreground keeps the contrast right in both
      // directions — a fixed white or black would fail one of the two themes.
      style={
        disabled
          ? undefined
          : {
              background: 'var(--info)',
              borderColor: 'var(--info)',
              color: 'var(--background)',
            }
      }
      title={
        disabledReason
          ? disabledReason
          : unavailable
            ? `${CHAT_LAUNCH_LABEL} is unavailable for ${label}. ${unavailable}`
          : bypass
            ? `Open ${label} as a chat in the browser. Tool approvals are bypassed for new chats `
              + '(change that in Settings). This surface is in beta.'
            : `Open ${label} as a chat in the browser instead of a terminal. This surface is in beta.`
      }
      aria-label={
        compact
          ? `Open ${label} as a web chat (beta)${bypass ? ', approvals bypassed' : ''}`
          : undefined
      }
      onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        if (disabled) return;
        // No mode is asked for. The server decides it from the preference it
        // holds for this account, which is the whole point of #134: the button
        // *reports* what is about to happen rather than requesting it, the same
        // discipline a relaunch already follows. A page left open across a
        // change of the preference elsewhere would otherwise send a stale one.
        onStart(kind, { surface: 'chat' });
      }}
    >
      {compact ? (
        <Icon name="message-square" size={13} />
      ) : (
        CHAT_LAUNCH_LABEL
      )}
      {/* Stated on the control that carries it, not only in a dialog the user
          may never open: the difference between asking and not asking is the
          single most consequential thing about the session being started. */}
      {!compact && bypass ? (
        <span style={{ marginLeft: 6, opacity: 0.85 }} aria-hidden="true">
          · no prompts
        </span>
      ) : null}
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

/**
 * One past conversation, offered by what was said in it.
 *
 * The opening message is the label and the date is the detail, not the other
 * way round: "che file ho caricato?" identifies a conversation instantly, where
 * "Session 25/07/2026, 21:35" identifies nothing — which is the whole reason a
 * list of timestamps is not worth showing.
 */
function ConversationCard({
  conversation,
  onSelect,
}: {
  conversation: ResumableConversation;
  onSelect: () => void;
}): React.JSX.Element {
  const [hover, setHover] = React.useState(false);
  const title = conversation.firstMessage || conversation.name;
  const blockedReason = conversation.persistenceUnavailable
    || (conversation.rollbackRecoveryPending
      ? 'Rollback cleanup is pending. Delete this recovery entry to retry cleanup.'
      : undefined);

  return (
    <button
      type="button"
      disabled={Boolean(blockedReason)}
      onClick={onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={blockedReason || title}
      style={{
        display: 'grid',
        gap: 3,
        width: '100%',
        padding: '8px 10px',
        textAlign: 'left',
        font: 'inherit',
        color: 'var(--foreground)',
        background: hover ? 'var(--accent)' : 'transparent',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        cursor: blockedReason ? 'not-allowed' : 'pointer',
        opacity: blockedReason ? 0.7 : 1,
      }}
    >
      <span
        style={{
          display: 'block',
          fontSize: 'var(--text-ui)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {title}
      </span>
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          fontSize: 'var(--text-2xs)',
          color: 'var(--muted-foreground)',
        }}
      >
        <span>{conversation.runtimeLabel || conversation.runtime || 'chat'}</span>
        <span>{formatWhen(conversation.lastActivity)}</span>
        {conversation.running ? <Badge variant="success">running</Badge> : null}
        {conversation.persistenceUnavailable ? (
          <Badge variant="destructive">migration blocked</Badge>
        ) : null}
        {conversation.rollbackRecoveryPending ? (
          <Badge variant="destructive">rollback cleanup pending</Badge>
        ) : null}
        {/* Said here rather than discovered on arrival: the transcript comes
            back either way, and this is the difference between an agent that
            remembers it and one reading it for the first time. */}
        {!conversation.rollbackRecoveryPending && !conversation.running && !conversation.canResume ? (
          <Badge variant="outline">transcript only</Badge>
        ) : null}
        {/* The mode this conversation comes back in. Only the bypass is called
            out: "asks first" is what every other row already means, and a badge
            on all of them would make the one that matters harder to see. */}
        {conversation.bypassPermissions ? (
          <Badge variant="destructive">approvals bypassed</Badge>
        ) : null}
      </span>
    </button>
  );
}

/** A date a person reads, in their own locale. */
function formatWhen(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const today = new Date();
  const sameDay = at.toDateString() === today.toDateString();
  return sameDay ? at.toLocaleTimeString() : at.toLocaleString();
}

export function RuntimeLauncher({
  aliases,
  onStart,
  onTerminal,
  onCancel,
  compact,
  chatBypass,
  conversations,
  conversationsLoading = false,
  onResume,
  maintenance,
}: RuntimeLauncherProps): React.JSX.Element {
  const resumable = onResume ? conversations || [] : [];
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
        {resumable.length > 0
          ? 'Carry on with a conversation, or start a new one.'
          : 'Pick a runtime for this working directory.'}
      </div>

      {/* Above the runtimes, because when there is one it is usually the
          answer: someone who opened this folder yesterday is here to continue,
          and making them scroll past six identical launch cards to find that
          out is the wrong order. */}
      {conversationsLoading || resumable.length > 0 ? (
        <>
          <SectionLabel>Resume a conversation</SectionLabel>
          {conversationsLoading && resumable.length === 0 ? (
            <div style={{ color: 'var(--muted-foreground)', fontSize: 'var(--text-sm)' }}>
              Looking for past conversations…
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 6, maxHeight: 260, overflowY: 'auto' }}>
              {resumable.map((conversation) => (
                <ConversationCard
                  key={conversation.id}
                  conversation={conversation}
                  onSelect={() => onResume?.(conversation)}
                />
              ))}
            </div>
          )}
        </>
      ) : null}

      <SectionLabel>{resumable.length > 0 ? 'Or start something new' : 'Agents'}</SectionLabel>
      <div style={{ display: 'grid', gap: 8 }}>
        {RUNTIMES.map((runtime) => {
          // One fallback, used by both the label and the tooltip. Computed once
          // so the two cannot drift — the tooltip previously read the alias
          // straight through and would have said "Start undefined" for a
          // runtime whose alias was missing while the card still read fine.
          const label = aliases[runtime.kind] || runtime.kind;
          const maintenanceId = maintenanceAgent(runtime.kind);
          const maintenanceStatus = maintenanceId
            ? maintenance?.statuses[maintenanceId]
            : undefined;
          const launchDisabled = maintenanceStatus?.state === 'missing';
          const launchDisabledReason = launchDisabled
            ? `${label} is not installed on ${maintenance?.targetName || 'this target'}. Install it below before starting a session.`
            : undefined;
          return (
          <div key={runtime.kind} style={{ display: 'grid' }}>
          <LaunchCard
            icon="cpu"
            label={label}
            meta={runtime.binary}
            disabled={launchDisabled}
            disabledReason={launchDisabledReason}
            onClick={() => onStart(runtime.kind)}
            action={
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <ChatLaunchButton
                  label={label}
                  kind={runtime.kind}
                  compact={compact}
                  bypass={chatBypass}
                  onStart={onStart}
                  disabledReason={launchDisabledReason}
                />
                {runtime.dangerous ? (
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={launchDisabled}
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
          {maintenance && maintenanceStatus && maintenanceId ? (
            <AgentMaintenancePickerRow
              status={maintenanceStatus}
              targetName={maintenance.targetName}
              operation={maintenance.operation?.agentId === maintenanceId
                ? maintenance.operation
                : null}
              checking={maintenance.checking?.includes(maintenanceId)}
              error={maintenance.errors?.[maintenanceId]
                || (maintenance.operation?.agentId === maintenanceId ? maintenance.error : null)}
              blockedReason={maintenance.operation?.agentId === maintenanceId
                ? null
                : maintenance.operationBusyReason}
              onInstall={maintenance.onInstall}
              onUpdate={maintenance.onUpdate}
              onRetry={maintenance.onRetry}
              onCancel={maintenance.onCancel}
            />
          ) : null}
          </div>
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
