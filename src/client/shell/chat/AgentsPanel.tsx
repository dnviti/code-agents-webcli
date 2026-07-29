import * as React from 'react';
import type { ToolStatus } from '../../../shared/chat-events.js';
import {
  collectAgentActivity,
  type AgentActivity,
  type AgentActivityKind,
} from '../../../shared/agent-activity.js';
import type { ChatTranscript } from '../../chat/transcript.js';
import { Badge, type BadgeVariant } from '../../ui/relay/Badge.js';
import { Icon } from '../../ui/relay/Icon.js';
import { PanelBody, PanelHeader, PanelNote } from './PanelShell.js';

/**
 * Subagents and workflows this conversation has spawned.
 *
 * Read straight off the transcript rather than fetched: the tool call that
 * started the agent *is* the record of it, and it already streams here live. A
 * separate server-side registry would be a second source of truth that could
 * disagree with the conversation it is describing.
 *
 * Running entries are pinned above finished ones. Fifty completed subagents
 * scrolling above the two that are still working is the failure mode this panel
 * exists to avoid.
 */

export const STATUS_META: Record<ToolStatus, { label: string; variant: BadgeVariant; pulse?: boolean }> = {
  pending: { label: 'queued', variant: 'outline' },
  running: { label: 'running', variant: 'warning', pulse: true },
  completed: { label: 'done', variant: 'success' },
  failed: { label: 'failed', variant: 'destructive' },
  denied: { label: 'denied', variant: 'destructive' },
  canceled: { label: 'canceled', variant: 'outline' },
};

export interface AgentsPanelProps {
  transcript: ChatTranscript;
  /**
   * Open a delegation's detail popup, by tool id and by what it is.
   *
   * The popups themselves are mounted by the workspace rail, not here: this
   * panel is unmounted the moment another tab is selected, and a popup that
   * dies when you glance at the file tree is not the file popup's behaviour,
   * which is what issue #45 asked it to match.
   */
  onOpenDelegation: (toolId: string, kind: AgentActivityKind) => void;
}

export function AgentsPanel({ transcript, onOpenDelegation }: AgentsPanelProps): React.JSX.Element {
  // The live tier, not `subscribe`. What a workflow is doing arrives as
  // `workflow_progress`, which the reducer marks neither structural nor meta —
  // so it reaches `subscribeContent` and nothing else (see transcript.ts). On
  // the coarse tier this panel showed the counts a run reported at the moment
  // some *unrelated* structural event last fired: "3 agents · 3 running" under
  // a workflow that had finished, and no sign of one that had lost an agent
  // (#140). Every other delegation surface is already here.
  const version = React.useSyncExternalStore(
    transcript.subscribeContent,
    transcript.getContentVersion,
    ZERO,
  );

  const activity = React.useMemo(
    () => collectAgentActivity(transcript.messages),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [transcript, version],
  );

  const running = activity.filter((entry) => entry.running);
  const finished = activity.filter((entry) => !entry.running).reverse();

  return (
    <>
      <PanelHeader title="Agents" detail={`${activity.length} total`}>
        {running.length > 0 ? (
          <Badge variant="warning" dot>
            {running.length}
          </Badge>
        ) : null}
      </PanelHeader>
      <PanelBody>
        {activity.length === 0 ? (
          <PanelNote icon="bot">
            Nothing delegated yet. Subagents and workflows this conversation starts appear here
            while they run.
          </PanelNote>
        ) : null}
        {running.map((entry) => (
          <ActivityRow key={entry.toolId} entry={entry} onOpen={onOpenDelegation} />
        ))}
        {finished.length > 0 && running.length > 0 ? (
          <div
            style={{
              padding: '10px 10px 4px',
              fontFamily: 'var(--font-sans)',
              fontSize: 'var(--text-2xs)',
              textTransform: 'uppercase',
              letterSpacing: 'var(--tracking-caps)',
              color: 'var(--muted-foreground)',
            }}
          >
            Finished
          </div>
        ) : null}
        {finished.map((entry) => (
          <ActivityRow key={entry.toolId} entry={entry} onOpen={onOpenDelegation} />
        ))}
      </PanelBody>
    </>
  );
}

const ZERO = (): number => 0;

function ActivityRow({
  entry,
  onOpen,
}: {
  entry: AgentActivity;
  onOpen: (toolId: string, kind: AgentActivityKind) => void;
}): React.JSX.Element {
  const meta = STATUS_META[entry.status] || STATUS_META.pending;
  // Every delegation opens, workflows and sub-agents alike. The steps a
  // sub-agent reports come from events the runtime already sends for all of
  // them, so there is nothing to save by withholding the view from short ones
  // — which was issue #44's open question.
  const open = (): void => onOpen(entry.toolId, entry.kind);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          open();
        }
      }}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 7,
        padding: '7px 10px',
        borderBottom: '1px solid var(--border)',
        // Finished work is dimmed so the working rows carry the panel — but not
        // a run that failed. Faded to 0.75 the red it is written in composites
        // to about 3.3:1 against the rail, under the 4.5:1 body text needs, and
        // the one row nobody should have to squint at is the broken one (#140).
        opacity: entry.running || entry.status === 'failed' ? 1 : 0.75,
        cursor: 'pointer',
      }}
    >
      <span
        style={{
          flex: '0 0 auto',
          marginTop: 2,
          color: entry.running ? 'var(--warning)' : 'var(--muted-foreground)',
          animation: meta.pulse ? 'relay-pulse 1.4s var(--ease-standard) infinite' : undefined,
        }}
      >
        <Icon name={entry.kind === 'workflow' ? 'square-split-horizontal' : 'bot'} size={13} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-xs)',
              fontWeight: 'var(--font-semibold)' as React.CSSProperties['fontWeight'],
              color: 'var(--foreground)',
            }}
          >
            {entry.name || entry.tool}
          </span>
          <Badge variant={meta.variant} dot={entry.running}>
            {meta.label}
          </Badge>
          {/* What a workflow holds, which is the thing that made it a different
              kind of row from a sub-agent in the first place (#117). Only when
              the run has said — a workflow that reports nothing keeps the row
              it has always had rather than gaining a hollow "0 agents". */}
          {entry.agentCount ? (
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--text-2xs)',
                color: entry.agentsRunning ? 'var(--warning)' : 'var(--muted-foreground)',
              }}
            >
              {entry.agentsRunning
                ? `${entry.agentCount} agents · ${entry.agentsRunning} running`
                : `${entry.agentCount} agents`}
            </span>
          ) : null}
          {/* What went wrong underneath, which the badge above deliberately does
              not say: a run can return a perfectly good result with two of its
              twelve agents dead, and a red badge over that would be crying wolf
              (#140). Its own span so the count is red while the rest is not. */}
          {entry.agentsFailed ? (
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--text-2xs)',
                color: 'var(--destructive)',
              }}
            >
              {`${entry.agentsFailed} failed`}
            </span>
          ) : null}
          {entry.durationMs !== undefined ? (
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--text-2xs)',
                color: 'var(--muted-foreground)',
              }}
            >
              {formatDuration(entry.durationMs)}
            </span>
          ) : null}
        </div>
        {entry.description ? (
          <div
            style={{
              marginTop: 2,
              fontFamily: 'var(--font-sans)',
              fontSize: 'var(--text-xs)',
              lineHeight: 'var(--leading-snug)',
              color: 'var(--muted-foreground)',
              wordBreak: 'break-word',
            }}
          >
            {entry.description}
          </div>
        ) : null}
        {/* Why it broke, on the row. A red badge that told you *that* something
            failed and made you open a popup to find out *what* is a row that
            has answered the easier half of the question (#140). One line: the
            whole of a runtime error is a stack trace, and the popup is a click
            away for the rest of it. */}
        {entry.status === 'failed' && entry.error ? (
          <div
            title={entry.error}
            style={{
              marginTop: 2,
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-2xs)',
              lineHeight: 'var(--leading-snug)',
              color: 'var(--destructive)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {firstLine(entry.error)}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The headline of a runtime error, without the stack under it. */
function firstLine(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim()) ?? '';
  return line.trim();
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}
