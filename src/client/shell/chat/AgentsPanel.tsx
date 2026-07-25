import * as React from 'react';
import type { ToolStatus } from '../../../shared/chat-events.js';
import { collectAgentActivity, type AgentActivity } from '../../../shared/agent-activity.js';
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

const STATUS_META: Record<ToolStatus, { label: string; variant: BadgeVariant; pulse?: boolean }> = {
  pending: { label: 'queued', variant: 'outline' },
  running: { label: 'running', variant: 'warning', pulse: true },
  completed: { label: 'done', variant: 'success' },
  failed: { label: 'failed', variant: 'destructive' },
  denied: { label: 'denied', variant: 'destructive' },
  canceled: { label: 'canceled', variant: 'outline' },
};

export interface AgentsPanelProps {
  transcript: ChatTranscript;
}

export function AgentsPanel({ transcript }: AgentsPanelProps): React.JSX.Element {
  const version = React.useSyncExternalStore(
    transcript.subscribe,
    transcript.getVersion,
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
          <ActivityRow key={entry.toolId} entry={entry} />
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
          <ActivityRow key={entry.toolId} entry={entry} />
        ))}
      </PanelBody>
    </>
  );
}

const ZERO = (): number => 0;

function ActivityRow({ entry }: { entry: AgentActivity }): React.JSX.Element {
  const meta = STATUS_META[entry.status] || STATUS_META.pending;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 7,
        padding: '7px 10px',
        borderBottom: '1px solid var(--border)',
        opacity: entry.running ? 1 : 0.75,
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
      </div>
    </div>
  );
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}
