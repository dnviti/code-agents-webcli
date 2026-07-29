import * as React from 'react';
import { Badge } from '../../ui/relay/Badge.js';
import { Icon } from '../../ui/relay/Icon.js';
import { fetchStatus, type WorkspaceStatus } from '../../chat/workspace-api.js';
import type { ChatTranscript } from '../../chat/transcript.js';
import type {
  AccountLimits,
  AccountLimitWindow,
  ChatUsage,
  ContextWindowSource,
} from '../../../shared/chat-events.js';
import { tokenTotal, type UsageBurn } from '../../../shared/usage-records.js';
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
  /**
   * What to call the agent this conversation runs.
   *
   * Passed in rather than hardcoded because the account section used to be
   * titled "Claude rate limit" over every runtime, which invited a codex or
   * grok user to read Claude's figures as their own (#137).
   */
  runtimeLabel?: string;
  /** Bumped when the agent goes idle, so the branch is re-read after work. */
  revision?: number;
}

const ZERO = (): number => 0;

export function StatusPanel({
  sessionId,
  transcript,
  runtimeLabel,
  revision = 0,
}: StatusPanelProps): React.JSX.Element {
  React.useSyncExternalStore(transcript.subscribe, transcript.getVersion, ZERO);

  const { data, error, busy, reload } = useWorkspaceData<WorkspaceStatus>(
    () => fetchStatus(sessionId),
    [sessionId, revision],
    Boolean(sessionId),
  );

  const usage = transcript.usage;

  // "Still reading" is not `busy`. `useWorkspaceData` starts at `busy: false`
  // and only raises the flag inside a post-paint effect, so `busy && !data` is
  // false on the very first frame of every open — long enough for a "nothing
  // here" sentence to flash before the route has been asked anything. What
  // actually settles it is whether an answer has arrived, or whether there is a
  // conversation to ask about at all (`sessionId` empty disables the fetch, so
  // no answer is ever coming and waiting for one would spin forever).
  const answered = Boolean(data) || Boolean(error) || !sessionId;

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
            source={usage.contextWindowSource}
          />
        </Group>

        {/* The surface with room for sentences, which is why the spend belongs
            here as well as in the header strip. The header can only be terse;
            "not reported" beside a number is ambiguous until somebody says
            whose silence it is. */}
        <Group title="Usage this conversation">
          <UsageSection usage={usage} />
        </Group>

        {/* Two sections, deliberately apart. One is what the provider said
            about the account; the other is what this app measured going through
            it, priced at list rates. Combining them would produce a number that
            is neither. */}
        <Group title={`${runtimeLabel || 'Agent'} account`}>
          <AccountSection
            limits={transcript.limits}
            account={data?.account ?? null}
            loading={!answered}
          />
        </Group>

        <Group title="Measured in this app">
          <MeasuredSection
            burn={data?.account?.measured ?? null}
            runtime={data?.account?.runtime ?? null}
            loading={!answered}
          />
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

/**
 * Who said how big the window is.
 *
 * Worth a line because the two are not equally authoritative: an agent
 * reporting its own window is describing the model it will actually run, while
 * a provider catalogue is what gets consulted when the agent said nothing at
 * all. Grok is the standing illustration — it reports 512,000 tokens for
 * `grok-build`, where the nearest catalogue entry says half that.
 */
function SourceNote({ source }: { source?: ContextWindowSource }): React.JSX.Element | null {
  // `unknown` is the absence of a window rather than a claim about one — it is
  // how a conversation says the model it moved to could not be sized, and the
  // sections with no size to show say that in their own words. Falling through
  // here would credit the provider with a figure nobody gave.
  if (!source || source === 'unknown') return null;
  return (
    <Quiet>
      {source === 'agent'
        ? 'Window size as reported by the agent.'
        : "Window size from the model's provider — this agent does not report one."}
    </Quiet>
  );
}

function ContextSection({
  window: size,
  used,
  total,
  source,
}: {
  window?: number;
  used?: number;
  total?: number;
  source?: ContextWindowSource;
}): React.JSX.Element {
  // Both halves, or it is not a proportion. A window with no occupancy figure
  // still says something useful — how much room the model has at all — so it is
  // shown on its own rather than suppressed.
  if (size !== undefined && used !== undefined) {
    const pct = (used / Math.max(1, size)) * 100;
    return (
      <>
        <Meter used={used} of={size} />
        <Row label="Used" value={`${formatTokens(used)} of ${formatTokens(size)}`} />
        <Row
          label="Left"
          value={formatTokens(Math.max(0, size - used))}
          tone={size - used < size * 0.1 ? 'var(--destructive)' : undefined}
        />
        {pct >= 80 ? (
          // Said in words and early enough to act on. A bar turning amber is
          // easy to miss, and by the time it is unmissable the room to do
          // anything about it is gone.
          <PanelNote tone={pct >= 90 ? 'destructive' : 'warning'} icon="circle-alert">
            {pct >= 90
              ? 'The context is almost full. Compact or start a new conversation before the next turn.'
              : 'The context is filling up. Consider compacting or starting a new conversation.'}
          </PanelNote>
        ) : null}
        <SourceNote source={source} />
      </>
    );
  }

  // Occupied against a ceiling nobody would state. Shown rather than
  // suppressed, because a blank section reads as "your context is fine".
  if (used !== undefined) {
    return (
      <>
        <Row label="In the window" value={formatTokens(used)} />
        {/* Kept alongside, because they answer different questions: one is
            what the last request carried, the other is what the whole
            conversation has spent. Dropping the second here would have made
            switching to this branch look like the session total vanished. */}
        {total !== undefined ? <Row label="Tokens this session" value={formatTokens(total)} /> : null}
        <Quiet>
          Neither this agent nor the model&apos;s provider would say how large the window is, so
          there is nothing honest to measure that against.
        </Quiet>
      </>
    );
  }

  if (size !== undefined) {
    return (
      <>
        <Row label="Window" value={formatTokens(size)} />
        <Quiet>This runtime reports the window it has, but not how full it is.</Quiet>
        <SourceNote source={source} />
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

/**
 * A window's name, in words a person reads.
 *
 * The providers name these for themselves — Claude says `five_hour` and
 * `seven_day`, Codex says `primary` and `secondary` and states the length
 * separately — so the length is preferred when it is there and the provider's
 * own word is tidied up when it is not. Nothing is invented: a window this does
 * not recognise is shown under the name the provider gave it.
 */
function windowLabel(window: AccountLimitWindow): string {
  const minutes = window.durationMinutes;
  if (minutes && minutes > 0) {
    if (minutes % (60 * 24) === 0) return `${minutes / (60 * 24)}-day limit`;
    if (minutes % 60 === 0) return `${minutes / 60}-hour limit`;
  }
  const spelled = window.kind.replace(/_/g, ' ');
  return /^\d/.test(spelled) ? `${spelled} limit` : spelled;
}

/**
 * What this conversation has spent, and who would not say.
 *
 * Same four-way honesty as the context section above, applied to the other two
 * figures the header shows. The distinction that earns the words is between a
 * runtime that will never report tokens or money — kimi reports neither, codex
 * prices nothing — and a conversation that simply has not finished a turn yet.
 * They look identical in the numbers, so only the first one gets a sentence,
 * and it is drawn from a statement the session makes after watching a turn end
 * in silence rather than from anything a capability flag claims in advance.
 *
 * Nothing here is ever estimated. The runtime's figure or no figure.
 */
function UsageSection({ usage }: { usage: ChatUsage }): React.JSX.Element {
  const total = tokenTotal(usage);
  const tokensSilent = total === null && usage.usageSource === 'none';
  const costSilent = usage.costUsd === undefined && usage.costSource === 'none';

  return (
    <>
      {total !== null ? <Row label="Tokens" value={formatTokens(total)} /> : null}
      {usage.costUsd !== undefined ? <Row label="Cost" value={formatCost(usage.costUsd)} /> : null}
      {tokensSilent && costSilent ? (
        <Quiet>
          This runtime reports neither token counts nor costs, so there is nothing honest to show
          here. Nothing on this screen is estimated.
        </Quiet>
      ) : tokensSilent ? (
        <Quiet>This runtime reports what a turn costs but not how many tokens it used.</Quiet>
      ) : costSilent ? (
        <Quiet>
          This runtime reports token counts but never a price, and this app does not price a turn
          itself.
        </Quiet>
      ) : total === null && usage.costUsd === undefined ? (
        <Quiet>Nothing has been reported yet in this conversation.</Quiet>
      ) : null}
    </>
  );
}

/** Money at whatever precision keeps it meaningful, the same rule the meter uses. */
function formatCost(value: number): string {
  if (value === 0) return '$0.00';
  return value >= 1 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`;
}

/** Only the words a provider uses that a person should be warned by. */
function windowTone(window: AccountLimitWindow): string | undefined {
  if (window.status === 'allowed_warning') return 'var(--warning)';
  if (typeof window.utilization === 'number' && window.utilization >= 0.9) {
    return 'var(--destructive)';
  }
  return undefined;
}

function LimitWindow({ window: limit }: { window: AccountLimitWindow }): React.JSX.Element {
  const pct = typeof limit.utilization === 'number' ? limit.utilization * 100 : null;
  // Two readings of the same window, far enough apart to divide by. One reading
  // is a level, not a rate, and this row is the difference between a
  // measurement and the projection-from-a-guess it replaced.
  const minutesLeft = limit.utilizationPerHour && pct !== null && limit.utilizationPerHour > 0
    ? ((1 - limit.utilization!) / limit.utilizationPerHour) * 60
    : null;

  return (
    <>
      <Row label={windowLabel(limit)} value={pct === null ? 'not reported' : `${Math.round(pct)}%`} tone={windowTone(limit)} />
      {/* No bar without a percentage. A meter defaulting to zero is the exact
          shape of the bug this section replaced: it reads as "nothing spent"
          when it means "nobody said". */}
      {pct === null ? null : <Meter used={pct} of={100} />}
      {limit.resetsAt ? (
        <Row label="Resets" value={new Date(limit.resetsAt).toLocaleString()} />
      ) : null}
      {minutesLeft !== null ? (
        <Row
          label="At this rate"
          value={`${formatDuration(minutesLeft)} left`}
          tone={minutesLeft < 30 ? 'var(--warning)' : undefined}
        />
      ) : pct === null ? null : (
        <Quiet>Not enough readings yet to say when this window runs out.</Quiet>
      )}
    </>
  );
}

/**
 * Where the account stands, and nothing else.
 *
 * This used to be a plan badge, a token meter and a cost row built from a
 * build-time constant: `--plan` defaulted to `max20` on every install, the
 * allowances came from a table written into this repository, and the "used"
 * figure was a scan of every Claude Code transcript on the host — which, when
 * it found no window containing right now, rendered as "Tokens 0 of 220.0k"
 * (#137).
 *
 * What is here instead is only what a provider said on its own channel, plus
 * one sentence for every runtime that says nothing. The three states are told
 * apart on purpose: reported, reported-but-silent-about-the-percentage, and
 * never reported at all.
 */
function AccountSection({
  limits,
  account,
  loading,
}: {
  limits?: AccountLimits;
  account: WorkspaceStatus['account'];
  loading: boolean;
}): React.JSX.Element {
  if (loading && !account && !limits) return <Quiet>Reading…</Quiet>;

  const spoken = limits?.windows ?? [];
  // The CLI's own cache, used only where the conversation itself has nothing.
  // It is a fallback and is labelled as one, because it describes the account
  // the *server* is signed in as and the browser may have several people on it.
  const cached = account?.cached ?? null;
  const windows = spoken.length > 0 ? spoken : cached?.windows ?? [];
  const planName = limits?.planName || cached?.planName;

  // Provenance is tracked per figure, not for the section as a whole.
  //
  // Keying the caveat on "did the conversation state any window" hid it in
  // exactly the case it exists for: Claude states a window every single turn
  // and never states a plan name, so the tier read out of `~/.claude.json`
  // rendered as an unqualified `Plan` badge with no "as of" and no note that it
  // is the server's account — on a `--allow-any-github-user` server, one user
  // reading the host owner's tier as their own (#137).
  const cachedWindows = spoken.length === 0 && (cached?.windows.length ?? 0) > 0;
  const cachedPlan = !limits?.planName && Boolean(cached?.planName);

  return (
    <>
      {planName ? <Row label="Plan" value={<Badge variant="outline">{planName}</Badge>} /> : null}

      {limits?.billing === 'subscription' ? (
        <Row label="Billed as" value="Subscription" />
      ) : limits?.billing === 'api-key' ? (
        <Row label="Billed as" value="API key" />
      ) : null}

      {windows.map((limit) => <LimitWindow key={limit.kind} window={limit} />)}

      {windows.length === 0 ? (
        <Quiet>{account?.reporting || 'Nothing has reported an account here.'}</Quiet>
      ) : null}

      {/* Said even when a window was reported, because "what this agent will
          ever tell you" is the thing a reader is actually calibrating on. */}
      {windows.length > 0 && account?.reporting ? <Quiet>{account.reporting}</Quiet> : null}

      {limits && limits.billing === 'unknown' ? (
        <Quiet>
          This runtime did not say whether the work is billed to a subscription or to an API
          key, so neither is claimed.
        </Quiet>
      ) : null}

      {cached && (cachedWindows || cachedPlan) ? (
        <Quiet>
          {/* Named rather than left as "the above", because when only the plan
              comes from the cache the windows beside it are this
              conversation's own and the caveat must not tar them too. */}
          {cachedWindows && cachedPlan
            ? 'The plan and the figures above were'
            : cachedPlan
              ? 'The plan above was'
              : 'The figures above were'}{' '}
          read from the Claude CLI&rsquo;s own cache on this server, as of{' '}
          {new Date(cached.asOf).toLocaleString()} — it describes the account this server is
          signed in as, not necessarily yours.
        </Quiet>
      ) : null}
    </>
  );
}

/**
 * What this app itself measured, kept well away from the account figures above.
 *
 * Its own section because it answers a different question and carries a
 * different caveat: these are the turns that ran through this app, for the
 * person signed in, on this agent, priced at published list rates rather than
 * billed. A provider window and a list-price total are not the same currency
 * and were never worth adding together.
 */
function MeasuredSection({
  burn,
  runtime,
  loading,
}: {
  burn: UsageBurn | null;
  runtime: string | null;
  loading: boolean;
}): React.JSX.Element {
  if (loading && !burn) return <Quiet>Reading…</Quiet>;
  // The totals guard is not paranoia: this whole panel is one React tree, and a
  // section that throws takes the context window and the branch down with it.
  //
  // Two different silences, and one sentence used to claim the wrong one for
  // both. The route only measures a burn once there is an agent to scope it to,
  // so a conversation that has never been launched comes back with no
  // measurement at all — which says nothing whatever about whether this server
  // keeps a usage record, and reading it that way would be this panel making
  // something up again (#137).
  if (!burn || !burn.totals) {
    return (
      <Quiet>
        {runtime
          ? 'This server is not keeping a usage record.'
          : 'Nothing has run in this conversation yet, so there is nothing measured to show.'}
      </Quiet>
    );
  }

  const { totals, hours } = burn;
  if (totals.turns === 0) {
    return <Quiet>{`Nothing has run here in the last ${hours} hours.`}</Quiet>;
  }

  // Zero over forty turns means one thing if forty of them reported a figure
  // and quite another if none did, which is exactly what these counters are
  // for. A rate divided out of silence would be a confident nothing.
  const tokens = totals.tokensReportedTurns > 0 ? totals.totalTokens : null;
  const cost = totals.costReportedTurns > 0 ? totals.costUsd : null;

  return (
    <>
      <Row label={`Turns (last ${hours}h)`} value={String(totals.turns)} />
      <Row
        label="Tokens"
        value={tokens === null ? 'not reported' : `${formatTokens(tokens)} · ${formatTokens(tokens / hours)}/h`}
      />
      <Row
        label="Cost"
        value={cost === null ? 'not reported' : `$${cost.toFixed(2)} · $${(cost / hours).toFixed(2)}/h`}
      />
      <Quiet>
        What went through this app on this agent, for you, over the last {hours} hours. Costs are
        published list prices, not a bill, and a turn whose runtime reported nothing contributes
        nothing rather than a zero.
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
