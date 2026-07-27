import * as React from 'react';
import { Badge } from '../../ui/relay/Badge.js';
import { Icon } from '../../ui/relay/Icon.js';
import { fetchStatus, type WorkspaceStatus } from '../../chat/workspace-api.js';
import type { ChatTranscript } from '../../chat/transcript.js';
import { PanelBody, PanelHeader, PanelNote, useWorkspaceData } from './PanelShell.js';

/**
 * What is left: of the context window, of the plan, and of the branch.
 *
 * The three questions a person asks before deciding whether to keep going, and
 * they were spread across a header meter, a terminal-only readout, and a `git`
 * command in another window.
 *
 * Every number here is one something actually reported. Runtimes differ wildly
 * in what they tell us — some report the context window and what is in it, some
 * report only the window, most report neither — and a meter that reads "0%
 * used" because nothing was measured looks exactly like one that reads 0%
 * because nothing has been spent. So a section that has no data says so in a
 * sentence instead.
 */

export interface StatusPanelProps {
  sessionId: string;
  transcript: ChatTranscript;
  /** Bumped when the agent goes idle, so the branch is re-read after work. */
  revision?: number;
}

const ZERO = (): number => 0;

export function StatusPanel({
  sessionId,
  transcript,
  revision = 0,
}: StatusPanelProps): React.JSX.Element {
  React.useSyncExternalStore(transcript.subscribe, transcript.getVersion, ZERO);

  const { data, error, busy, reload } = useWorkspaceData<WorkspaceStatus>(
    () => fetchStatus(sessionId),
    [sessionId, revision],
    Boolean(sessionId),
  );

  const usage = transcript.usage;

  return (
    <>
      <PanelHeader title="Status" onRefresh={reload} busy={busy} />
      <PanelBody>
        {error ? <PanelNote tone="destructive" icon="circle-alert">{error}</PanelNote> : null}

        <Group title="Context window">
          <ContextSection
            window={usage.contextWindow}
            used={usage.contextUsed}
            total={usage.totalTokens}
          />
        </Group>

        {/* Named for what it actually reads rather than for what it looked
            like. It only understands Claude, and it reports the machine, so a
            heading that said "Subscription" invited every user of every other
            agent to read it as their own. */}
        <Group title="Claude rate limit (this machine)">
          <PlanSection plan={data?.plan ?? null} loading={busy && !data} />
        </Group>

        <Group title="Branch">
          <GitSection git={data?.git ?? null} loading={busy && !data} />
        </Group>
      </PanelBody>
    </>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)' }}>
      <h3
        style={{
          margin: '0 0 6px',
          fontFamily: 'var(--font-sans)',
          fontSize: 'var(--text-2xs)',
          textTransform: 'uppercase',
          letterSpacing: 'var(--tracking-caps)',
          color: 'var(--muted-foreground)',
          fontWeight: 'var(--font-medium)' as React.CSSProperties['fontWeight'],
        }}
      >
        {title}
      </h3>
      <div style={{ display: 'grid', gap: 6 }}>{children}</div>
    </section>
  );
}

function Quiet({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p style={{ margin: 0, fontSize: 'var(--text-2xs)', color: 'var(--muted-foreground)' }}>
      {children}
    </p>
  );
}

function Row({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 'var(--text-xs)' }}>
      <span style={{ color: 'var(--muted-foreground)' }}>{label}</span>
      <span
        style={{
          marginLeft: 'auto',
          fontFamily: 'var(--font-mono)',
          color: tone || 'var(--foreground)',
          textAlign: 'right',
        }}
      >
        {value}
      </span>
    </div>
  );
}

/** A proportion bar. Only rendered where the proportion is a measured one. */
function Meter({ used, of }: { used: number; of: number }): React.JSX.Element {
  const pct = Math.min(100, Math.max(0, (used / Math.max(1, of)) * 100));
  const tone = pct >= 90 ? 'var(--destructive)' : pct >= 70 ? 'var(--warning)' : 'var(--success)';
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      style={{ height: 4, background: 'var(--muted)', borderRadius: 'var(--radius)' }}
    >
      <div style={{ width: `${pct}%`, height: '100%', background: tone, transition: 'width var(--duration-base)' }} />
    </div>
  );
}

function ContextSection({
  window: size,
  used,
  total,
}: {
  window?: number;
  used?: number;
  total?: number;
}): React.JSX.Element {
  // Both halves, or it is not a proportion. A window with no occupancy figure
  // still says something useful — how much room the model has at all — so it is
  // shown on its own rather than suppressed.
  if (size !== undefined && used !== undefined) {
    return (
      <>
        <Meter used={used} of={size} />
        <Row label="Used" value={`${formatTokens(used)} of ${formatTokens(size)}`} />
        <Row
          label="Left"
          value={formatTokens(Math.max(0, size - used))}
          tone={size - used < size * 0.1 ? 'var(--destructive)' : undefined}
        />
      </>
    );
  }

  if (size !== undefined) {
    return (
      <>
        <Row label="Window" value={formatTokens(size)} />
        <Quiet>This runtime reports the window it has, but not how full it is.</Quiet>
      </>
    );
  }

  return (
    <>
      {total !== undefined ? <Row label="Tokens this session" value={formatTokens(total)} /> : null}
      <Quiet>
        This runtime does not report its context window, so there is no honest number for what is
        left of it.
      </Quiet>
    </>
  );
}

function PlanSection({
  plan,
  loading,
}: {
  plan: WorkspaceStatus['plan'];
  loading: boolean;
}): React.JSX.Element {
  if (loading) return <Quiet>Reading…</Quiet>;
  if (!plan) return <Quiet>This server is not tracking a subscription.</Quiet>;

  // What this section is, said plainly, because it used to be read as this
  // user's spending and it is neither. It comes from Claude Code's own
  // transcript files on the host, so it covers every account and every project
  // on this machine and knows nothing about the other agents. The question it
  // does answer — how close this machine is to its rate-limit window — is not
  // one the accounting record can answer, which is why it stays.

  const limits = plan.limits || null;
  const tokens = Number(plan.sessionStats?.totalTokens ?? 0);
  const cost = Number(plan.sessionStats?.totalCost ?? 0);
  const depletionMinutes = plan.predictions?.minutesToDepletion;

  return (
    <>
      <Row label="Plan" value={<Badge variant="outline">{plan.type || 'unknown'}</Badge>} />

      {limits?.tokens ? (
        <>
          <Meter used={tokens} of={limits.tokens} />
          <Row label="Tokens" value={`${formatTokens(tokens)} of ${formatTokens(limits.tokens)}`} />
          <Row label="Left" value={formatTokens(Math.max(0, limits.tokens - tokens))} />
        </>
      ) : (
        <Quiet>No token limit is known for this plan.</Quiet>
      )}

      {limits?.cost ? <Row label="Cost" value={`$${cost.toFixed(2)} of $${limits.cost.toFixed(2)}`} /> : null}

      {/* The reset the runtime actually has. Claude's plans refill on a rolling
          window rather than at a fixed hour, so this reports when *this* window
          runs out rather than inventing a daily or weekly boundary. */}
      {typeof depletionMinutes === 'number' ? (
        <Row
          label="At this rate"
          value={`${formatDuration(depletionMinutes)} left`}
          tone={depletionMinutes < 30 ? 'var(--warning)' : undefined}
        />
      ) : null}

      {(plan.windows || []).slice(0, 1).map((window, index) => (
        <Row
          key={index}
          label="Window resets"
          value={window.resetAt ? new Date(window.resetAt).toLocaleTimeString() : '—'}
        />
      ))}

      <Quiet>
        Claude&rsquo;s rate-limit window for this whole machine, read from its own files — not
        your spending, and not this conversation&rsquo;s. Open Usage for what your work actually
        cost, across every agent.
      </Quiet>
    </>
  );
}

function GitSection({
  git,
  loading,
}: {
  git: WorkspaceStatus['git'];
  loading: boolean;
}): React.JSX.Element {
  if (loading) return <Quiet>Reading…</Quiet>;
  if (!git || !git.repo) return <Quiet>This folder is not a git repository.</Quiet>;

  return (
    <>
      <Row
        label={git.detached ? 'Detached at' : 'Branch'}
        value={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Icon name="git-branch" size={11} />
            {git.branch || 'HEAD'}
          </span>
        }
      />
      <Row label="Tracking" value={git.upstream || 'nothing'} />
      {git.upstream ? (
        <Row
          label="Ahead / behind"
          value={`${git.ahead ?? 0} / ${git.behind ?? 0}`}
          tone={(git.behind ?? 0) > 0 ? 'var(--warning)' : undefined}
        />
      ) : null}
      <Row
        label="Changed files"
        value={git.changed ?? 0}
        tone={(git.changed ?? 0) > 0 ? 'var(--warning)' : undefined}
      />
    </>
  );
}

/** Thousands as k, millions as M — the shape these numbers are read in. */
function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${Math.round(minutes % 60)}m`;
}
