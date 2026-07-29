import * as React from 'react';

import type {
  UsageBreakdown,
  UsageBucket,
  UsageBucketUnit,
  UsageConversationSummary,
  UsageDashboard,
  UsageEffort,
  UsageFilters,
  UsageJobRecord,
  UsageJobSummary,
  UsageMeasure,
  UsagePeriod,
  UsageScope,
  UsageToolUse,
  UsageTotals,
} from '../../../shared/usage-records.js';
import { UNATTRIBUTED } from '../../../shared/usage-records.js';
import {
  attributeUsageProject,
  exportUsage,
  fetchUsageConversations,
  fetchUsageDashboard,
  fetchUsageJob,
  fetchUsageJobs,
} from '../../chat/usage-api';
import { Button } from '../../ui/relay/Button';
import { Dialog } from '../../ui/relay/Dialog';
import { Icon } from '../../ui/relay/Icon';
import { IconButton } from '../../ui/relay/IconButton';
import { Input } from '../../ui/relay/Input';
import { Tabs } from '../../ui/relay/Tabs';
import { Tooltip } from '../../ui/relay/Tooltip';
import { PHONE_TEXT, usePhone } from '../../ui/touch';

export interface UsageDashboardDialogProps {
  open: boolean;
  onClose(): void;
}

const PERIODS: Array<{ value: UsagePeriod; label: string }> = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' },
];

const JOBS_PAGE_SIZE = 20;

/**
 * The first instant of the period a moment falls in, in the viewer's own
 * calendar.
 *
 * Deliberately the same rule as the server's `rangeFor` — Monday-first weeks
 * included — because the two have to name the same windows. This one is only
 * ever used to describe and to bound the anchor; the range the figures are
 * actually computed over is still the server's, and arrives in `from`/`to`.
 */
export function periodStart(at: Date, period: UsagePeriod): Date {
  const y = at.getFullYear();
  const m = at.getMonth();
  const d = at.getDate();
  if (period === 'day') return new Date(y, m, d);
  if (period === 'week') return new Date(y, m, d - ((at.getDay() + 6) % 7));
  if (period === 'month') return new Date(y, m, 1);
  return new Date(y, 0, 1);
}

/**
 * One period forward or back, as an instant inside the period arrived at.
 *
 * Midday, and mid-month for the wider periods, rather than the boundary itself:
 * the server bounds every window with one fixed offset — the viewer's offset at
 * the moment of asking — so an anchor sitting exactly on a local midnight lands
 * an hour the wrong side of that boundary for half the year, and the arrows
 * would walk over the same day twice and never reach the one between.
 *
 * Stepping from the anchor rather than from the range that came back also means
 * two quick presses move two periods: a second press while the first answer is
 * still in flight would otherwise recompute the same step from the range still
 * on screen.
 */
export function stepAnchor(anchor: Date, period: UsagePeriod, direction: 1 | -1): Date {
  const y = anchor.getFullYear();
  const m = anchor.getMonth();
  const d = anchor.getDate();
  if (period === 'day') return new Date(y, m, d + direction, 12);
  if (period === 'week') return new Date(y, m, d + 7 * direction, 12);
  if (period === 'month') return new Date(y, m + direction, 15, 12);
  return new Date(y + direction, 6, 15, 12);
}

/** `2026-07-27`, the only shape an `<input type="date">` reads or writes. */
function dateValue(at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/**
 * A typed date back into an anchor, or null.
 *
 * A date field reports every intermediate value as the user types into it, so
 * `0002-07-27` arrives on the way to `2026-07-27`. Rejected rather than
 * honoured: jumping the dashboard to the year 2 and back is a worse experience
 * than a keystroke that does nothing.
 */
function parseDateValue(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [, y, m, d] = match;
  if (Number(y) < 2000) return null;
  return new Date(Number(y), Number(m) - 1, Number(d), 12);
}

/** The window a period covers, named the way somebody would say it out loud. */
function periodLabel(at: Date, period: UsagePeriod): string {
  const start = periodStart(at, period);
  if (period === 'year') return String(start.getFullYear());
  if (period === 'month') return start.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  if (period === 'week') {
    // The last instant inside the window, not the first outside it: a week
    // labelled up to the Monday after it reads as eight days.
    const last = new Date(periodStart(stepAnchor(at, 'week', 1), 'week').getTime() - 1);
    return `${start.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} – ${last.toLocaleDateString(
      undefined,
      { day: 'numeric', month: 'short', year: 'numeric' },
    )}`;
  }
  return start.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * A bucket key back into the instant it names, in the viewer's own clock.
 *
 * Parsed by hand rather than handed to `new Date`, because the two shapes the
 * server sends are parsed by opposite rules: `2026-07-27T09:00` is read as
 * local time and `2026-07-27` as UTC midnight. The keys are all local — they
 * were formatted after the viewer's offset was applied — so letting the second
 * one land as UTC shifted every day and month label by that offset, and would
 * have narrowed a click on Monday to a window straddling Sunday night.
 */
function bucketStart(key: string, unit: UsageBucketUnit): Date | null {
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?(?:T(\d{2}):(\d{2}))?$/.exec(key);
  if (!match) return null;
  const [, y, mo, d, h] = match;
  if (unit === 'month') return new Date(Number(y), Number(mo) - 1, 1);
  if (unit === 'day') return new Date(Number(y), Number(mo) - 1, Number(d ?? '1'));
  return new Date(Number(y), Number(mo) - 1, Number(d ?? '1'), Number(h ?? '0'));
}

/** The instant the next bucket begins — the exclusive end of this one. */
function bucketEnd(start: Date, unit: UsageBucketUnit): Date {
  const next = new Date(start.getTime());
  if (unit === 'month') next.setMonth(next.getMonth() + 1);
  else if (unit === 'day') next.setDate(next.getDate() + 1);
  else next.setHours(next.getHours() + 1);
  return next;
}

/**
 * A bucket key as something a person can read, at the width of the bucket.
 *
 * A day bucket labelled with a time reads as a single instant rather than as
 * the whole day it stands for. Falls back to the key itself when it will not
 * parse: that is a bug on the server, and the raw key at least says what
 * arrived, where "Invalid Date" across the whole axis hides which bucket is at
 * fault while looking like a rendering fault here.
 */
function bucketLabel(key: string, unit: UsageBucketUnit): string {
  const start = bucketStart(key, unit);
  if (!start) return key;
  return labelForWindow(start, unit);
}

/** The short form for the axis, where there is room for a few characters at most. */
function bucketTick(key: string, unit: UsageBucketUnit): string {
  const start = bucketStart(key, unit);
  if (!start) return '';
  if (unit === 'month') return start.toLocaleDateString(undefined, { month: 'short' });
  if (unit === 'day') return String(start.getDate());
  return String(start.getHours()).padStart(2, '0');
}

function labelForWindow(start: Date, unit: UsageBucketUnit): string {
  if (unit === 'month') return start.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  if (unit === 'day') return start.toLocaleDateString();
  return start.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Money at whatever precision keeps it meaningful, same rule as UsageMeter:
 * a job can cost fractions of a cent, and rounding that to "$0.00" reads as
 * free rather than as small.
 */
function formatCost(n: number): string {
  if (n === 0) return '$0.00';
  return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
}

/** 1234 -> "1.2k", 984123 -> "984k", 1_400_000 -> "1.4M". Same table as UsageMeter. */
function formatTokens(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  if (abs < 1_000_000) {
    const v = n / 1000;
    return `${Math.abs(v) < 100 ? v.toFixed(1) : Math.round(v)}k`;
  }
  const v = n / 1_000_000;
  return `${Math.abs(v) < 100 ? v.toFixed(1) : Math.round(v)}M`;
}

function formatAvg(n: number): string {
  return n.toFixed(1);
}

interface Figure {
  text: string;
  /** Set whenever the headline number does not speak for itself — a partial
   * report or an outright absence — so the honesty behind it is one hover
   * away rather than buried in a footnote nobody reads. */
  title?: string;
  /** Dimmed: the figure is a fact about missing data, not a measurement. */
  muted?: boolean;
}

/**
 * The honesty rule for a total: `costUsd` of zero across zero reporting turns
 * and `costUsd` of zero across every turn are opposite facts, and this is the
 * one place that turns `UsageTotals` into the sentence a viewer should read.
 */
function costFigure(totals: UsageTotals): Figure {
  if (totals.turns === 0) return { text: '—', muted: true, title: 'No turns in this range' };
  if (totals.costReportedTurns === 0) {
    return { text: 'not reported', muted: true, title: 'None of these turns reported a cost' };
  }
  if (totals.costReportedTurns < totals.turns) {
    return {
      text: `${formatCost(totals.costUsd)} across ${totals.costReportedTurns} of ${totals.turns} turns`,
      title: `${totals.turns - totals.costReportedTurns} turn(s) did not report a cost and are excluded from this figure`,
    };
  }
  return { text: formatCost(totals.costUsd) };
}

function tokensFigure(totals: UsageTotals): Figure {
  if (totals.turns === 0) return { text: '—', muted: true, title: 'No turns in this range' };
  if (totals.tokensReportedTurns === 0) {
    return { text: 'not reported', muted: true, title: 'None of these turns reported token counts' };
  }
  if (totals.tokensReportedTurns < totals.turns) {
    return {
      text: `${formatTokens(totals.totalTokens)} across ${totals.tokensReportedTurns} of ${totals.turns} turns`,
      title: `${totals.turns - totals.tokensReportedTurns} turn(s) did not report token counts and are excluded from this figure`,
    };
  }
  return { text: formatTokens(totals.totalTokens) };
}

/**
 * Model turns, which most runtimes never report — so the absence has to be said
 * rather than drawn as a zero.
 *
 * The figure beside it is the number of turns that had one to contribute, for
 * the same reason cost carries one: a sum over an unknown fraction of the range
 * is not a total, and this is the quantity where the fraction is usually small.
 */
function modelTurnsFigure(totals: UsageTotals): Figure {
  if (totals.turns === 0) return { text: '—', muted: true, title: 'No turns in this range' };
  if (totals.modelTurnsReportedTurns === 0) {
    return {
      text: 'not reported',
      muted: true,
      title: 'None of these turns ran on an agent that reports its round trips to the model',
    };
  }
  if (totals.modelTurnsReportedTurns < totals.turns) {
    return {
      text: `${totals.modelTurns} across ${totals.modelTurnsReportedTurns} of ${totals.turns} turns`,
      title: `${totals.turns - totals.modelTurnsReportedTurns} turn(s) ran on an agent that does not report round trips and are excluded from this figure`,
    };
  }
  return { text: String(totals.modelTurns) };
}

function countFigure(n: number): Figure {
  return { text: String(n) };
}

/**
 * One thing the dashboard can plot, and everything needed to plot it.
 *
 * The distinction between a measure the *runtime* reports and one this app
 * counts for itself is carried in `reported`, and it is why this is a table
 * rather than a switch on a string. Cost, tokens and model turns can be absent
 * — nobody said — where turns and tool calls are measured here and are
 * therefore always known. A chart that drew all five the same way would invent
 * measurements for the three that can be missing.
 */
interface Measure {
  value: UsageMeasure;
  label: string;
  amount(totals: UsageTotals): number;
  reported(totals: UsageTotals): boolean;
  figure(totals: UsageTotals): Figure;
}

const MEASURES: Measure[] = [
  {
    value: 'costUsd',
    label: 'Cost',
    amount: (t) => t.costUsd,
    reported: (t) => t.costReportedTurns > 0,
    figure: costFigure,
  },
  {
    value: 'totalTokens',
    label: 'Tokens',
    amount: (t) => t.totalTokens,
    reported: (t) => t.tokensReportedTurns > 0,
    figure: tokensFigure,
  },
  {
    // One per request the user made — the same turns the conversation shows,
    // counted where the work ran rather than from what a browser has loaded.
    value: 'turns',
    label: 'Turns',
    amount: (t) => t.turns,
    reported: (t) => t.turns > 0,
    figure: (t) => countFigure(t.turns),
  },
  {
    // Round trips to the model *inside* those turns, and a different quantity:
    // only the runtimes that count their own report it, so it plots as absent
    // rather than as zero for the rest.
    value: 'modelTurns',
    label: 'Model turns',
    amount: (t) => t.modelTurns,
    reported: (t) => t.modelTurnsReportedTurns > 0,
    figure: modelTurnsFigure,
  },
  {
    value: 'toolCalls',
    label: 'Tool calls',
    amount: (t) => t.toolCalls,
    reported: (t) => t.turns > 0,
    figure: (t) => countFigure(t.toolCalls),
  },
];

function measureBy(value: UsageMeasure): Measure {
  return MEASURES.find((m) => m.value === value) ?? MEASURES[0];
}

/** The per-job cost cell: "reported nothing" and "cannot report" are different stories. */
function jobCostFigure(job: UsageJobSummary): Figure {
  if (!job.reportsCost) {
    return { text: 'n/a', muted: true, title: `${job.agent} does not report cost` };
  }
  if (job.costUsd === null) {
    return { text: 'not reported', muted: true, title: 'This job reported no cost' };
  }
  return { text: formatCost(job.costUsd) };
}

function jobTokensFigure(job: UsageJobSummary): Figure {
  if (!job.reportsUsage) {
    return { text: 'n/a', muted: true, title: `${job.agent} does not report token usage` };
  }
  if (job.totalTokens === null) {
    return { text: 'not reported', muted: true, title: 'This job reported no token usage' };
  }
  return { text: formatTokens(job.totalTokens) };
}

function FigureText({ figure, style }: { figure: Figure; style?: React.CSSProperties }): React.JSX.Element {
  const span = (
    <span style={{ color: figure.muted ? 'var(--muted-foreground)' : 'var(--foreground)', ...style }}>
      {figure.text}
    </span>
  );
  return figure.title ? <Tooltip label={figure.title}>{span}</Tooltip> : span;
}

const cardStyle: React.CSSProperties = {
  background: 'var(--card)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius)',
  padding: '10px 12px',
};

const sectionTitleStyle: React.CSSProperties = {
  margin: '0 0 8px',
  fontSize: 'var(--text-xs)',
  fontWeight: 'var(--font-semibold)' as React.CSSProperties['fontWeight'],
  color: 'var(--muted-foreground)',
  textTransform: 'uppercase',
  letterSpacing: 'var(--tracking-caps)',
};

const headCellStyle: React.CSSProperties = {
  textAlign: 'right',
  padding: '4px 8px',
  borderBottom: '1px solid var(--border)',
  color: 'var(--muted-foreground)',
  fontWeight: 'var(--font-medium)' as React.CSSProperties['fontWeight'],
  whiteSpace: 'nowrap',
};

const bodyCellStyle: React.CSSProperties = {
  textAlign: 'right',
  padding: '4px 8px',
  borderBottom: '1px solid var(--border)',
  whiteSpace: 'nowrap',
};

function Headline({ label, figure }: { label: string; figure: Figure }): React.JSX.Element {
  return (
    <div style={cardStyle}>
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--muted-foreground)' }}>{label}</div>
      <div style={{ marginTop: 4, fontSize: 'var(--text-lg)', fontWeight: 'var(--font-semibold)' as React.CSSProperties['fontWeight'] }}>
        <FigureText figure={figure} />
      </div>
    </div>
  );
}

/**
 * The one thing a spend figure here cannot say for itself.
 *
 * Every runtime reports cost as an API list price for the tokens it moved,
 * whether or not the account paying for it is on the API at all. On a
 * subscription — Claude Max, ChatGPT Plus and the rest — the bill is flat and
 * arrives monthly, so a "$1.25" against a job is what that work would have
 * cost, not money that changed hands. Nothing in the event stream says which
 * of the two an account is on, so the distinction is stated rather than
 * detected: on screen, and not only on hover, because someone reconciling a
 * provider's invoice against this dashboard needs it before they start.
 */
function CostCaveat(): React.JSX.Element {
  return (
    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--muted-foreground)', lineHeight: 1.5 }}>
      Cost is the API list price each runtime reports for the tokens it used. On a subscription plan
      (Claude Max, ChatGPT Plus and the like) nothing is billed per job — read these figures as what
      the same work would have cost through the API, not as what you were charged.
    </div>
  );
}

// ----------------------------------------------------------------- narrowing

const FILTER_LABELS: Record<'agent' | 'model' | 'project' | 'user', string> = {
  agent: 'Agent',
  model: 'Model',
  project: 'Project',
  user: 'User',
};

/**
 * A breakdown key can stand for work with nothing to group it under: a job
 * whose runtime never named a model, or one recorded before this app knew
 * which project it ran in. A blank cell reads as a rendering bug, so say what
 * it means — and say the right one of the two, because "nobody reported it"
 * and "nobody recorded it" are different explanations.
 */
function keyLabel(value: string, unknown: string): string {
  return value === UNATTRIBUTED || value === '' ? unknown : value;
}

function hasFilters(filters: UsageFilters): boolean {
  return Object.values(filters).some(Boolean);
}

/** How wide a window is, in the units a person would name it in. */
function spanUnit(from: Date, to: Date): UsageBucketUnit {
  const span = to.getTime() - from.getTime();
  if (Number.isNaN(span)) return 'hour';
  if (span > 27 * 86_400_000) return 'month';
  if (span > 20 * 3_600_000) return 'day';
  return 'hour';
}

/**
 * What the dashboard is currently narrowed to, and the way back out.
 *
 * Every chip clears exactly one thing and the last control clears everything,
 * so no selection can be reached that a viewer cannot undo in a single action.
 * That matters most for the one selection with no control of its own — a time
 * window clicked on the chart, which is otherwise cleared only by clicking
 * precisely the same bar again.
 */
function FilterChips({
  filters,
  onChange,
}: {
  filters: UsageFilters;
  onChange(next: UsageFilters): void;
}): React.JSX.Element | null {
  if (!hasFilters(filters)) return null;

  const chips: Array<{ id: string; text: string; clears: Array<keyof UsageFilters> }> = [];
  for (const key of ['agent', 'model', 'project', 'user'] as const) {
    const value = filters[key];
    if (!value) continue;
    chips.push({
      id: key,
      text: `${FILTER_LABELS[key]}: ${keyLabel(value, key === 'project' ? 'unattributed' : 'not reported')}`,
      clears: [key],
    });
  }
  // One chip for the window, not two. `from` and `to` are set and cleared
  // together — half a window is not a state anybody asked for.
  if (filters.from && filters.to) {
    const start = new Date(filters.from);
    const end = new Date(filters.to);
    chips.push({
      id: 'window',
      // Described at the width of the window itself, not at the width of the
      // buckets now on screen — those are one level finer, and a whole day
      // labelled "27 Jul, 00:00" reads as a single midnight.
      text: `Time: ${Number.isNaN(start.getTime()) ? filters.from : labelForWindow(start, spanUnit(start, end))}`,
      clears: ['from', 'to'],
    });
  }

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }} aria-label="Active filters">
      <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--muted-foreground)' }}>Showing only</span>
      {chips.map((chip) => (
        <button
          key={chip.id}
          type="button"
          onClick={() => {
            const next = { ...filters };
            for (const field of chip.clears) delete next[field];
            onChange(next);
          }}
          aria-label={`Remove filter — ${chip.text}`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '2px 8px',
            fontSize: 'var(--text-2xs)',
            borderRadius: 999,
            border: '1px solid var(--border)',
            background: 'var(--accent)',
            color: 'var(--foreground)',
            cursor: 'pointer',
          }}
        >
          {chip.text}
          <Icon name="x" size={11} />
        </button>
      ))}
      <Button variant="ghost" size="sm" onClick={() => onChange({})}>
        Clear all
      </Button>
    </div>
  );
}

/**
 * Which window the figures are for, and the only way out of the one the clock
 * is standing in.
 *
 * Everything downstream reads its range out of the answer this asks for — the
 * history list and the export both take `from`/`to` from the dashboard — so
 * moving the anchor moves the whole page rather than the charts alone.
 *
 * The window is named from the anchor rather than from the range that came
 * back, because that range is the *narrowed* one whenever a bar has been
 * pressed: an hour of Monday morning is still a day of July, and a control
 * that renamed itself "27 Jul, 09:00" would be describing the drill-down the
 * chips already describe.
 */
function PeriodNavigator({
  period,
  anchor,
  empty,
  narrowed,
  onAnchor,
}: {
  period: UsagePeriod;
  /** Null while the window is wherever now is — which is where it starts. */
  anchor: Date | null;
  /** Whether the window that came back holds no turns at all. */
  empty: boolean;
  narrowed: boolean;
  onAnchor(next: Date | null): void;
}): React.JSX.Element {
  const phone = usePhone();
  const now = new Date();
  const at = anchor ?? now;
  // Nothing has happened after now, so there is nothing ahead to walk into.
  // Compared period-start to period-start rather than instant to instant: the
  // window holding this moment is the last one there is, and half of it is
  // still in the future.
  const latest = periodStart(at, period).getTime() >= periodStart(now, period).getTime();

  const pick = (value: string): void => {
    const picked = parseDateValue(value);
    if (!picked) return;
    if (periodStart(picked, period).getTime() > periodStart(now, period).getTime()) return;
    onAnchor(picked);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div
        style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}
        role="group"
        aria-label="The period on screen"
      >
        {/* IconButton, not an icon-only Button: only this one is a square at
            the touch floor, and the dashboard is one of the phone's own
            destinations. */}
        <IconButton
          variant="outline"
          size={phone ? 'lg' : 'md'}
          aria-label={`Previous ${period}`}
          onClick={() => onAnchor(stepAnchor(at, period, -1))}
        >
          <Icon name="arrow-left" size={phone ? 18 : 12} />
        </IconButton>
        <span
          // The whole page has just been re-asked for a different range, and
          // the name of that range is the one thing on screen that says which.
          aria-live="polite"
          style={{
            fontSize: phone ? PHONE_TEXT.body : 'var(--text-ui)',
            minWidth: 150,
            textAlign: 'center',
          }}
        >
          {periodLabel(at, period)}
        </span>
        <IconButton
          variant="outline"
          size={phone ? 'lg' : 'md'}
          aria-label={`Next ${period}`}
          disabled={latest}
          onClick={() => onAnchor(stepAnchor(at, period, 1))}
        >
          <Icon name="arrow-right" size={phone ? 18 : 12} />
        </IconButton>
        <div style={{ width: 150 }}>
          <Input
            size="sm"
            type="date"
            value={dateValue(periodStart(at, period))}
            // Belt as well as braces: the arrow is already disabled at the
            // present, and a date field that offers next March is an interface
            // promising a record that cannot exist.
            max={dateValue(now)}
            aria-label={`Show the ${period} containing a date`}
            onChange={(e) => pick(e.currentTarget.value)}
          />
        </div>
        {/* Disabled only when the window is already the live one — which is
            not the same as its being the current period. Step back and forward
            again and the anchor is a fixed instant inside today; keyed on
            `latest`, the only control that unpins it would be unavailable, and
            a dialog left open across midnight would go on answering for the
            day that ended. */}
        <Button variant="ghost" size="sm" disabled={anchor === null} onClick={() => onAnchor(null)}>
          Now
        </Button>
      </div>
      {empty ? (
        <span
          style={{
            fontSize: phone ? PHONE_TEXT.meta : 'var(--text-2xs)',
            color: 'var(--muted-foreground)',
          }}
        >
          {narrowed
            ? `Nothing in this ${period} matches the selection above.`
            : `Nothing was recorded in this ${period}. Step back, or pick a date, to look further into the past.`}
        </span>
      ) : null}
    </div>
  );
}

// --------------------------------------------------------------------- trend

/**
 * The trend over time: one focusable, tappable bar per bucket.
 *
 * HTML buttons rather than the inline SVG this was. An `<svg><title>` shows a
 * value to a mouse and to nothing else — not to a finger, not to the keyboard,
 * not to a screen reader — and the shape it drew was fixed at 640 units wide
 * and stretched to fit, so every bar came out sheared at phone width. Buttons
 * in a flex row are focusable, announce themselves, respond to a tap, and
 * reflow on their own.
 *
 * The bar for a bucket nothing reported is a stub in the border colour with a
 * dashed cap, never a bar of height zero: "no agent here reported a cost" and
 * "this hour cost nothing" are the two facts this dashboard exists to keep
 * apart, and on a chart they are one pixel away from each other.
 */
function TrendChart({
  buckets,
  unit,
  measure,
  selectedKey,
  onSelect,
}: {
  buckets: UsageBucket[];
  unit: UsageBucketUnit;
  measure: Measure;
  selectedKey: string | null;
  onSelect(key: string): void;
}): React.JSX.Element {
  const [active, setActive] = React.useState<string | null>(null);
  const max = Math.max(0, ...buckets.map((b) => (measure.reported(b.totals) ? measure.amount(b.totals) : 0)));
  const shown =
    buckets.find((b) => b.key === active) ?? buckets.find((b) => b.key === selectedKey) ?? null;
  // Every nth tick at most, so an axis of 31 days or 24 hours stays legible
  // instead of collapsing into a smear of overlapping numbers.
  const tickEvery = Math.max(1, Math.ceil(buckets.length / 12));

  return (
    <div>
      <div
        // Polite, and always mounted rather than appearing on demand: a region
        // that only exists once a value is picked is announced as new content
        // rather than as the answer to what was just pressed.
        aria-live="polite"
        style={{ minHeight: 20, fontSize: 'var(--text-xs)', color: 'var(--muted-foreground)', marginBottom: 6 }}
      >
        {shown ? (
          <>
            <span style={{ color: 'var(--foreground)' }}>{bucketLabel(shown.key, unit)}</span>
            {` · ${measure.label} `}
            <FigureText figure={measure.figure(shown.totals)} />
            {` · ${shown.totals.turns} turn(s)`}
          </>
        ) : (
          `${measure.label} over time — select a point for its figures`
        )}
      </div>

      <div
        style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 120 }}
        role="group"
        aria-label={`${measure.label} over time`}
        onMouseLeave={() => setActive(null)}
      >
        {buckets.map((bucket) => {
          const reported = measure.reported(bucket.totals);
          const amount = measure.amount(bucket.totals);
          const height = reported && max > 0 ? Math.max(2, (amount / max) * 104) : 3;
          const selected = bucket.key === selectedKey;
          const figure = measure.figure(bucket.totals);
          return (
            <button
              key={bucket.key}
              type="button"
              aria-pressed={selected}
              aria-label={`${bucketLabel(bucket.key, unit)}: ${measure.label} ${figure.text}, ${bucket.totals.turns} turn(s)`}
              title={`${bucketLabel(bucket.key, unit)} · ${measure.label} ${figure.text}`}
              onMouseEnter={() => setActive(bucket.key)}
              onFocus={() => setActive(bucket.key)}
              onBlur={() => setActive(null)}
              onClick={() => onSelect(bucket.key)}
              style={{
                flex: '1 1 0',
                // Flex children take a content-sized minimum by default, so a
                // row of 31 bars refuses to shrink past its own labels and
                // pushes the chart off the side of the dialog.
                minWidth: 0,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'flex-end',
                height: '100%',
                padding: 0,
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
              }}
            >
              <span
                style={{
                  width: '100%',
                  height,
                  background: reported ? 'var(--primary)' : 'var(--border)',
                  borderTop: reported ? 'none' : '2px dashed var(--muted-foreground)',
                  outline: selected ? '2px solid var(--foreground)' : 'none',
                  outlineOffset: 1,
                  opacity: active && active !== bucket.key ? 0.6 : 1,
                  borderRadius: 1,
                }}
              />
            </button>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: 2, marginTop: 2 }} aria-hidden="true">
        {buckets.map((bucket, i) => (
          <span
            key={bucket.key}
            style={{
              flex: '1 1 0',
              minWidth: 0,
              textAlign: 'center',
              fontSize: 'var(--text-2xs)',
              color: 'var(--muted-foreground)',
              overflow: 'hidden',
            }}
          >
            {i % tickEvery === 0 ? bucketTick(bucket.key, unit) : ''}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * The five fixed buckets a `UsageEffort` histogram carries, turns or tool calls.
 *
 * Built the way `TrendChart` above is built, and for the reason it was: these
 * were bare `<div>`s inside a `Tooltip`, which mounts on mouseenter or on focus
 * from a focusable descendant — and there was none. So the counts existed in no
 * place a keyboard or a screen reader could reach, and "Effort by agent" read
 * as an agent, a turn count, and then five loose numbers with no quantity
 * attached to any of them (#66). The distribution is the entire question this
 * panel answers.
 *
 * Nothing is selected by pressing a bar, so pressing one does what hovering it
 * does: says what it counts. That is not a control with no action — it is the
 * only action a touch screen has, where there is no hover to reveal a tooltip
 * with.
 */
function EffortHistogram({
  label,
  histogram,
  labels,
}: {
  /** What the distribution is *of* — the panel heading is too far away to carry it. */
  label: string;
  histogram: readonly [number, number, number, number, number];
  labels: readonly [string, string, string, string, string];
}): React.JSX.Element {
  const phone = usePhone();
  const [active, setActive] = React.useState<number | null>(null);
  const max = Math.max(1, ...histogram);
  const total = histogram.reduce((sum, count) => sum + count, 0);

  return (
    <div>
      <div
        style={{ display: 'flex', alignItems: 'flex-end', gap: phone ? 8 : 4, height: 44 }}
        role="group"
        aria-label={label}
        onMouseLeave={() => setActive(null)}
      >
        {histogram.map((count, i) => (
          <button
            key={labels[i]}
            type="button"
            aria-label={`${labels[i]}: ${count} of ${total} turn(s)`}
            title={`${labels[i]}: ${count} of ${total} turn(s)`}
            onMouseEnter={() => setActive(i)}
            onFocus={() => setActive(i)}
            onBlur={() => setActive(null)}
            // Set, never toggled: a real press arrives after mouseenter and
            // after focus, so a toggle finds the bar already active and clears
            // the readout the press was for. On a keyboard the same — Tab
            // shows the figure and Enter took it away again.
            onClick={() => setActive(i)}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 2,
              // Wider on a phone: this is the affordance the change adds for
              // touch, and a 22px target with 4px between them is not one.
              width: phone ? 40 : 22,
              height: '100%',
              padding: 0,
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
            }}
          >
            <span
              style={{
                width: '100%',
                height: Math.max(2, (count / max) * 32),
                background: count > 0 ? 'var(--primary)' : 'var(--border)',
                opacity: active !== null && active !== i ? 0.6 : 1,
                borderRadius: 1,
              }}
            />
            <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--muted-foreground)' }}>{labels[i]}</span>
          </button>
        ))}
      </div>
      <div
        // Always mounted, same as the trend's readout: a region that appears
        // when a bar is reached is announced as new content rather than as the
        // answer to what was just reached.
        aria-live="polite"
        style={{ minHeight: 14, fontSize: 'var(--text-2xs)', color: 'var(--muted-foreground)' }}
      >
        {active === null ? '' : `${labels[active]} · ${histogram[active]} of ${total} turn(s)`}
      </div>
    </div>
  );
}

const MODEL_TURNS_LABELS = ['1', '2', '3-5', '6-10', '11+'] as const;
const TOOLS_LABELS = ['0', '1-2', '3-5', '6-10', '11+'] as const;

function BreakdownKey({ value, unknown }: { value: string; unknown: string }): React.JSX.Element {
  if (value && value !== UNATTRIBUTED) return <>{value}</>;
  return (
    <span
      style={{ color: 'var(--muted-foreground)' }}
      title={
        unknown === 'unattributed'
          ? 'Recorded before this app knew which project a job ran in'
          : 'These turns ran without a reported model'
      }
    >
      {unknown}
    </span>
  );
}

function Table({
  columns,
  rows,
}: {
  columns: string[];
  rows: Array<Array<React.ReactNode>>;
}): React.JSX.Element {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-xs)' }}>
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th key={c} style={{ ...headCellStyle, textAlign: i === 0 ? 'left' : 'right' }}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} style={{ padding: '10px 8px', color: 'var(--muted-foreground)' }}>
                Nothing here yet
              </td>
            </tr>
          ) : (
            rows.map((row, i) => (
              // A table built from breakdown rows has no id of its own to key
              // on — the first cell is the row's label wherever these are
              // called, so it stands in for one.
              <tr key={String(row[0]) + i}>
                {row.map((cell, j) => (
                  // The column position is the identity here; there is no
                  // other stable key for an arbitrary cell.
                  <td key={j} style={{ ...bodyCellStyle, textAlign: j === 0 ? 'left' : 'right' }}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- breakdowns

const BREAKDOWN_COLUMNS: Array<{ label: string; measure: UsageMeasure }> = [
  { label: 'Turns', measure: 'turns' },
  { label: 'Model turns', measure: 'modelTurns' },
  { label: 'Tools', measure: 'toolCalls' },
  { label: 'Tokens', measure: 'totalTokens' },
  { label: 'Cost', measure: 'costUsd' },
];

/**
 * A breakdown, sortable and selectable, with each row's share drawn behind its
 * label.
 *
 * The bar sits behind the text rather than in a column of its own, so the
 * shape is readable without costing a column at phone width. It is scaled
 * against the largest row of the *sorted* measure — the one the viewer has
 * just said they care about — because a bar chart of cost in a table sorted by
 * job count shows its widest bar three rows down and reads as a bug.
 */
function BreakdownTable({
  rows,
  unknown,
  selected,
  onSelect,
}: {
  rows: UsageBreakdown[] | undefined;
  unknown: string;
  selected?: string;
  onSelect(key: string): void;
}): React.JSX.Element {
  const [sort, setSort] = React.useState<UsageMeasure>('costUsd');
  const measure = measureBy(sort);
  const sorted = React.useMemo(
    // Defended rather than assumed. `usage-api` rejects a response missing a
    // breakdown before it reaches here, but a table that throws on an absent
    // array takes the entire dialog down with it — including the message
    // explaining what went wrong.
    () => [...(rows ?? [])].sort((a, b) => measure.amount(b.totals) - measure.amount(a.totals)),
    [rows, measure],
  );
  const max = Math.max(1, ...sorted.map((r) => measure.amount(r.totals)));

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-xs)' }}>
        <thead>
          <tr>
            <th style={{ ...headCellStyle, textAlign: 'left' }} />
            {BREAKDOWN_COLUMNS.map((column) => (
              <th
                key={column.label}
                style={headCellStyle}
                aria-sort={sort === column.measure ? 'descending' : 'none'}
              >
                <button
                  type="button"
                  onClick={() => setSort(column.measure)}
                  aria-label={`Sort by ${column.label}`}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    padding: 0,
                    cursor: 'pointer',
                    font: 'inherit',
                    color: sort === column.measure ? 'var(--foreground)' : 'var(--muted-foreground)',
                  }}
                >
                  {column.label}
                  {sort === column.measure ? ' ↓' : ''}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr>
              <td
                colSpan={BREAKDOWN_COLUMNS.length + 1}
                style={{ padding: '10px 8px', color: 'var(--muted-foreground)' }}
              >
                Nothing here yet
              </td>
            </tr>
          ) : (
            sorted.map((row) => {
              const share = Math.max(0, Math.min(1, measure.amount(row.totals) / max));
              const isSelected = selected === row.key;
              return (
                <tr key={row.key} style={{ background: isSelected ? 'var(--accent)' : 'transparent' }}>
                  <td style={{ ...bodyCellStyle, textAlign: 'left', position: 'relative' }}>
                    <span
                      aria-hidden="true"
                      style={{
                        position: 'absolute',
                        left: 4,
                        top: 3,
                        bottom: 3,
                        width: `${(share * 96).toFixed(1)}%`,
                        background: 'var(--primary)',
                        opacity: 0.16,
                        borderRadius: 2,
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => onSelect(row.key)}
                      aria-pressed={isSelected}
                      title={isSelected ? 'Remove this filter' : 'Show only this'}
                      style={{
                        position: 'relative',
                        background: 'transparent',
                        border: 'none',
                        padding: 0,
                        font: 'inherit',
                        color: 'inherit',
                        cursor: 'pointer',
                        textAlign: 'left',
                        textDecoration: isSelected ? 'underline' : 'none',
                      }}
                    >
                      <BreakdownKey value={row.key} unknown={unknown} />
                    </button>
                  </td>
                  <td style={bodyCellStyle}>{row.totals.turns}</td>
                  <td style={bodyCellStyle}>
                    <FigureText figure={modelTurnsFigure(row.totals)} />
                  </td>
                  <td style={bodyCellStyle}>{row.totals.toolCalls}</td>
                  <td style={bodyCellStyle}>
                    <FigureText figure={tokensFigure(row.totals)} />
                  </td>
                  <td style={bodyCellStyle}>
                    <FigureText figure={costFigure(row.totals)} />
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

function EffortTable({ rows, unknown }: { rows: UsageEffort[]; unknown: string }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {rows.length === 0 ? (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--muted-foreground)' }}>Nothing here yet</div>
      ) : (
        rows.map((row) => (
          <div key={row.key} style={{ ...cardStyle, display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'center' }}>
            <div style={{ minWidth: 90 }}>
              <div style={{ fontSize: 'var(--text-ui)' }}>
                <BreakdownKey value={row.key} unknown={unknown} />
              </div>
              <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--muted-foreground)' }}>{row.turns} turns</div>
            </div>
            <div>
              {/* Said out loud rather than drawn as an empty chart: an agent
                  that never reports its round trips has no shape here, and a
                  bar chart of nothing reads as a measurement of little. */}
              <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--muted-foreground)' }}>
                {row.modelTurnsReportedTurns === 0
                  ? 'model turns/turn · not reported'
                  : `model turns/turn · avg ${formatAvg(row.modelTurnsAvg)} · max ${row.modelTurnsMax}${
                      row.modelTurnsReportedTurns < row.turns
                        ? ` · of ${row.modelTurnsReportedTurns} of ${row.turns} turns`
                        : ''
                    }`}
              </div>
              {row.modelTurnsReportedTurns > 0 ? (
                <EffortHistogram
                  label={`${keyLabel(row.key, unknown)} · model turns per turn`}
                  histogram={row.modelTurnsHistogram}
                  labels={MODEL_TURNS_LABELS}
                />
              ) : null}
            </div>
            <div>
              <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--muted-foreground)' }}>
                tool calls/turn · avg {formatAvg(row.toolCallsAvg)} · max {row.toolCallsMax}
              </div>
              <EffortHistogram
                label={`${keyLabel(row.key, unknown)} · tool calls per turn`}
                histogram={row.toolCallsHistogram}
                labels={TOOLS_LABELS}
              />
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function ToolsTable({ tools }: { tools: UsageToolUse[] }): React.JSX.Element {
  return (
    <Table
      columns={tools.some((t) => t.agent) ? ['Tool', 'Agent', 'Calls', 'Turns'] : ['Tool', 'Calls', 'Turns']}
      rows={tools.map((t) => (t.agent ? [t.tool, t.agent, t.calls, t.turns] : [t.tool, t.calls, t.turns]))}
    />
  );
}

/**
 * Attributing work to a project after the fact.
 *
 * Offered only where there is nothing to overwrite — no project at all, or one
 * somebody else typed here earlier. A job whose project was observed shows the
 * observation and no control, because the alternative is an interface that
 * invites you to correct a measurement and then refuses.
 *
 * The whole-conversation checkbox is on by default, and is the case that
 * actually matters: a conversation ran in one folder, so somebody clearing a
 * backlog of unattributed work wants the conversation, not its ninth turn.
 */
function ProjectAttribution({
  job,
  scope,
  knownProjects,
  onDone,
}: {
  job: UsageJobRecord;
  scope: UsageScope;
  knownProjects: string[];
  /**
   * Reports the outcome upward rather than showing it here, because saving
   * reloads the job — which unmounts this component and would take the message
   * with it. "0 jobs attributed" is the one outcome most worth reading, and it
   * was the one guaranteed to flash and vanish.
   */
  onDone(message: string): void;
}): React.JSX.Element {
  const [editing, setEditing] = React.useState(false);
  const [value, setValue] = React.useState(job.project ?? '');
  const [applyToSession, setApplyToSession] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const listId = `usage-projects-${job.id.replace(/[^a-zA-Z0-9]/g, '-')}`;

  if (job.projectSource === 'observed') {
    return (
      <Tooltip label="Read from the folder this session was working in as the job ran">
        <span>{job.project}</span>
      </Tooltip>
    );
  }

  const save = (next: string | null): void => {
    setBusy(true);
    setError(null);
    attributeUsageProject(job.id, { project: next, applyToSession, scope })
      .then((outcome) => {
        setBusy(false);
        setEditing(false);
        onDone(
          outcome.updated === 0
            ? 'Nothing changed — this work already had a recorded project.'
            : `${outcome.updated} job(s) attributed.`,
        );
      })
      .catch((err: Error) => {
        setBusy(false);
        setError(err.message);
      });
  };

  if (!editing) {
    return (
      <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
          {job.project ? (
            <Tooltip label="Attributed by hand, not read from a running session">
              <span>
                {job.project}
                <span style={{ color: 'var(--muted-foreground)' }}> (by hand)</span>
              </span>
            </Tooltip>
          ) : (
            <span style={{ color: 'var(--muted-foreground)' }}>unattributed</span>
          )}
          <button
            type="button"
            onClick={() => setEditing(true)}
            style={{
              background: 'transparent',
              border: 'none',
              padding: 0,
              font: 'inherit',
              fontSize: 'var(--text-2xs)',
              color: 'var(--primary)',
              cursor: 'pointer',
              textDecoration: 'underline',
            }}
          >
            {job.project ? 'Change' : 'Attribute…'}
          </button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <datalist id={listId}>
        {knownProjects.map((name) => <option key={name} value={name} />)}
      </datalist>
      <Input
        size="sm"
        autoFocus
        value={value}
        list={listId}
        placeholder="Project name"
        aria-label="Project name"
        disabled={busy}
        onChange={(e) => setValue(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && value.trim()) save(value.trim());
          if (e.key === 'Escape') setEditing(false);
        }}
      />
      <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 'var(--text-2xs)', color: 'var(--muted-foreground)' }}>
        <input
          type="checkbox"
          checked={applyToSession}
          disabled={busy}
          onChange={(e) => setApplyToSession(e.currentTarget.checked)}
        />
        Apply to every unattributed job in this conversation
      </label>
      {error ? (
        <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--destructive)' }}>{error}</span>
      ) : null}
      <div style={{ display: 'flex', gap: 6 }}>
        <Button size="sm" disabled={busy || !value.trim()} onClick={() => save(value.trim())}>
          Save
        </Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => setEditing(false)}>
          Cancel
        </Button>
        {job.project ? (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => save(null)}>
            Withdraw
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function JobDetail({
  jobId,
  scope,
  knownProjects,
  onClose,
  onChanged,
}: {
  jobId: string;
  scope: UsageScope;
  knownProjects: string[];
  onClose(): void;
  onChanged(): void;
}): React.JSX.Element {
  const [job, setJob] = React.useState<UsageJobRecord | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [reloads, setReloads] = React.useState(0);
  const [outcome, setOutcome] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setJob(null);
    setError(null);
    fetchUsageJob(jobId, scope)
      .then((record) => { if (!cancelled) setJob(record); })
      .catch((err: Error) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [jobId, scope, reloads]);

  const costFig = job ? jobCostFigure(job) : null;
  const tokensFig = job ? jobTokensFigure(job) : null;

  return (
    <Dialog open title="Job detail" onClose={onClose} width={520}>
      {error ? (
        <div style={{ color: 'var(--destructive)', fontSize: 'var(--text-ui)' }}>{error}</div>
      ) : !job ? (
        <div style={{ color: 'var(--muted-foreground)', fontSize: 'var(--text-ui)' }}>Loading…</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 'var(--text-sm)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div>
              <div style={{ color: 'var(--muted-foreground)', fontSize: 'var(--text-2xs)' }}>Agent</div>
              <div>{job.agent}</div>
            </div>
            <div>
              <div style={{ color: 'var(--muted-foreground)', fontSize: 'var(--text-2xs)' }}>Model</div>
              <div>{job.model ?? <span style={{ color: 'var(--muted-foreground)' }}>not reported</span>}</div>
            </div>
            <div>
              <div style={{ color: 'var(--muted-foreground)', fontSize: 'var(--text-2xs)' }}>Project</div>
              <ProjectAttribution
                job={job}
                scope={scope}
                knownProjects={knownProjects}
                onDone={(message) => {
                  setOutcome(message);
                  setReloads((n) => n + 1);
                  onChanged();
                }}
              />
              {outcome ? (
                <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--muted-foreground)', marginTop: 2 }}>
                  {outcome}
                </div>
              ) : null}
            </div>
            <div>
              <div style={{ color: 'var(--muted-foreground)', fontSize: 'var(--text-2xs)' }}>User</div>
              <div>{job.userLogin}</div>
            </div>
            <div>
              <div style={{ color: 'var(--muted-foreground)', fontSize: 'var(--text-2xs)' }}>Outcome</div>
              <div>{job.outcome}</div>
            </div>
            <div>
              <div style={{ color: 'var(--muted-foreground)', fontSize: 'var(--text-2xs)' }}>Started</div>
              <div>{new Date(job.startedAt).toLocaleString()}</div>
            </div>
            <div>
              <div style={{ color: 'var(--muted-foreground)', fontSize: 'var(--text-2xs)' }}>Duration</div>
              <div>{job.durationMs !== null ? `${(job.durationMs / 1000).toFixed(1)}s` : '—'}</div>
            </div>
            <div>
              <div style={{ color: 'var(--muted-foreground)', fontSize: 'var(--text-2xs)' }}>Model turns</div>
              <div>
                {job.modelTurns === null ? (
                  <span style={{ color: 'var(--muted-foreground)' }} title={`${job.agent} does not report round trips to the model`}>
                    not reported
                  </span>
                ) : (
                  job.modelTurns
                )}
              </div>
            </div>
            <div>
              <div style={{ color: 'var(--muted-foreground)', fontSize: 'var(--text-2xs)' }}>Tool calls</div>
              <div>{job.toolCalls}</div>
            </div>
            <div>
              <div style={{ color: 'var(--muted-foreground)', fontSize: 'var(--text-2xs)' }}>Tokens</div>
              <div>{tokensFig ? <FigureText figure={tokensFig} /> : null}</div>
            </div>
            <div>
              <div style={{ color: 'var(--muted-foreground)', fontSize: 'var(--text-2xs)' }}>Cost</div>
              <div>{costFig ? <FigureText figure={costFig} /> : null}</div>
            </div>
          </div>

          {/* Defended rather than assumed: this dialog is served to whatever
              server answers, and one older than this page returns a job record
              with no split at all. Reading `.length` off that is a blank
              dialog where a job used to open. */}
          {(job.models ?? []).length > 0 ? (
            <div>
              {/* Only for a turn that genuinely ran on more than one model. A
                  job with one is fully described by the Model field above, and
                  a one-row table under it would suggest a split that is not
                  there. Tokens and cost are the runtime's own per-model
                  figures; there is no tool column because no runtime says
                  which model asked for which tool. (#75) */}
              <h3 style={sectionTitleStyle}>Models this turn ran on</h3>
              <Table
                columns={['Model', 'Calls', 'Input', 'Output', 'Cost']}
                rows={(job.models ?? []).map((split) => [
                  split.model,
                  split.calls ?? '—',
                  split.inputTokens === null ? '—' : formatTokens(split.inputTokens),
                  split.outputTokens === null ? '—' : formatTokens(split.outputTokens),
                  split.costUsd === null ? '—' : formatCost(split.costUsd),
                ])}
              />
            </div>
          ) : null}

          <div>
            <h3 style={sectionTitleStyle}>Tools called</h3>
            {job.tools.length === 0 ? (
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--muted-foreground)' }}>No tool calls</div>
            ) : (
              <Table columns={['Tool', 'Calls']} rows={job.tools.map((t) => [t.tool, t.calls])} />
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}

/**
 * A conversation's totals, as one figure each.
 *
 * The same honesty rule as everywhere else: `costUsd` of zero across zero
 * reporting jobs is not a conversation that cost nothing.
 */
function conversationLabel(conversation: UsageConversationSummary): string {
  if (conversation.name) return conversation.name;
  // No name means the tab has been deleted; the id is what is left, and the
  // leading segment of it is enough to tell two entries apart without turning
  // the column into a wall of uuid.
  return `Conversation ${conversation.sessionId.slice(0, 8)}`;
}

/** A list of values as one cell: one name, or "first +2". */
function ListCell({ values, empty }: { values: string[]; empty: string }): React.JSX.Element {
  if (values.length === 0) {
    return <span style={{ color: 'var(--muted-foreground)' }}>{empty}</span>;
  }
  if (values.length === 1) return <>{values[0]}</>;
  // A conversation that used two agents says so rather than claiming one of
  // them — the whole list is in the tooltip, and the count is on screen.
  return (
    <Tooltip label={values.join(', ')}>
      <span>
        {values[0]}
        <span style={{ color: 'var(--muted-foreground)' }}>{` +${values.length - 1}`}</span>
      </span>
    </Tooltip>
  );
}

/**
 * The conversations behind the figures above — one row per chat tab (#88).
 *
 * The unit is the tab, not the request: everything spent in it is one entry,
 * for as long as it exists, across compaction and clearing and starting fresh.
 * What happened inside is detail about how the work went, and it is one click
 * away rather than spread over forty rows of this list.
 *
 * Narrowed by the same `UsageFilters` as everything above it, for the same
 * reason the job list is.
 */
function ConversationHistory({
  scope,
  filters,
  reloads,
  onOpen,
}: {
  scope: UsageScope;
  filters: UsageFilters;
  /** Bumped when something below changes a figure, so the list is re-asked. */
  reloads: number;
  onOpen(conversation: UsageConversationSummary): void;
}): React.JSX.Element {
  const [offset, setOffset] = React.useState(0);
  const [page, setPage] = React.useState<{
    conversations: UsageConversationSummary[];
    total: number;
  } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const filterKey = JSON.stringify(filters);

  React.useEffect(() => {
    setOffset(0);
  }, [scope, filterKey]);

  React.useEffect(() => {
    let cancelled = false;
    setError(null);
    fetchUsageConversations({ scope, limit: JOBS_PAGE_SIZE, offset, ...filters })
      .then((result) => { if (!cancelled) setPage(result); })
      .catch((err: Error) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, offset, filterKey, reloads]);

  const total = page?.total ?? 0;
  const conversations = page?.conversations ?? [];
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(total, offset + JOBS_PAGE_SIZE);

  if (error) {
    return <div style={{ color: 'var(--destructive)', fontSize: 'var(--text-xs)' }}>{error}</div>;
  }

  return (
    <div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-xs)' }}>
          <thead>
            <tr>
              {['Conversation', 'Project', 'Agent', 'Model', 'Started', 'Last active', 'Requests', 'Tokens', 'Cost'].map(
                (c, i) => (
                  <th key={c} style={{ ...headCellStyle, textAlign: i === 0 ? 'left' : 'right' }}>
                    {c}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {conversations.length === 0 ? (
              <tr>
                <td colSpan={9} style={{ padding: '10px 8px', color: 'var(--muted-foreground)' }}>
                  No conversations in this range
                </td>
              </tr>
            ) : (
              conversations.map((conversation) => (
                <tr
                  key={conversation.sessionId}
                  onClick={() => onOpen(conversation)}
                  style={{ cursor: 'pointer' }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--accent)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <td style={{ ...bodyCellStyle, textAlign: 'left' }}>{conversationLabel(conversation)}</td>
                  <td style={bodyCellStyle}>
                    <ListCell values={conversation.projects} empty="unattributed" />
                  </td>
                  <td style={bodyCellStyle}>
                    <ListCell values={conversation.agents} empty="—" />
                  </td>
                  <td style={bodyCellStyle}>
                    <ListCell values={conversation.models} empty="—" />
                  </td>
                  <td style={bodyCellStyle}>{new Date(conversation.startedAt).toLocaleString()}</td>
                  <td style={bodyCellStyle}>{new Date(conversation.lastActiveAt).toLocaleString()}</td>
                  <td style={bodyCellStyle}>{conversation.totals.turns}</td>
                  <td style={bodyCellStyle}>
                    <FigureText figure={tokensFigure(conversation.totals)} />
                  </td>
                  <td style={bodyCellStyle}>
                    <FigureText figure={costFigure(conversation.totals)} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
        <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--muted-foreground)' }}>
          {total === 0 ? 'No conversations' : `${from}-${to} of ${total}`}
        </span>
        <div style={{ display: 'flex', gap: 6 }}>
          <Button
            variant="outline"
            size="sm"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - JOBS_PAGE_SIZE))}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={to >= total}
            onClick={() => setOffset(offset + JOBS_PAGE_SIZE)}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * The history section: conversations, one of them opened, or every request.
 *
 * Three states rather than two, because the list of conversations and the list
 * of every request answer different questions — "what did this piece of work
 * cost" and "which single request cost that much" — and neither one is the
 * other with a filter applied. The conversation list is what opens first: it is
 * the unit anybody thinks in, and the flat list of fragments is the thing #88
 * is about not showing by default.
 */
function History({
  scope,
  filters,
  knownProjects,
  onChanged,
}: {
  scope: UsageScope;
  filters: UsageFilters;
  knownProjects: string[];
  onChanged(): void;
}): React.JSX.Element {
  const [mode, setMode] = React.useState<'conversations' | 'requests'>('conversations');
  const [open, setOpen] = React.useState<UsageConversationSummary | null>(null);
  const [reloads, setReloads] = React.useState(0);
  const changed = (): void => {
    setReloads((n) => n + 1);
    onChanged();
  };

  if (open) {
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          <Button variant="outline" size="sm" onClick={() => setOpen(null)} iconLeft={<Icon name="arrow-left" size={12} />}>
            All conversations
          </Button>
          <span style={{ fontSize: 'var(--text-xs)', fontWeight: 600 }}>{conversationLabel(open)}</span>
          <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--muted-foreground)' }}>
            {`${open.totals.turns} request(s) · ${costFigure(open.totals).text}`}
          </span>
        </div>
        <JobHistory
          scope={scope}
          filters={filters}
          knownProjects={knownProjects}
          sessionId={open.sessionId}
          onChanged={changed}
        />
      </div>
    );
  }

  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        <Tabs
          tabs={[
            { value: 'conversations', label: 'Conversations' },
            { value: 'requests', label: 'Requests' },
          ]}
          value={mode}
          onChange={(value) => setMode(value as 'conversations' | 'requests')}
        />
      </div>
      {mode === 'conversations' ? (
        <ConversationHistory scope={scope} filters={filters} reloads={reloads} onOpen={setOpen} />
      ) : (
        <JobHistory scope={scope} filters={filters} knownProjects={knownProjects} onChanged={changed} />
      )}
    </div>
  );
}

/**
 * The jobs behind the figures above, narrowed by whatever the charts are
 * narrowed by.
 *
 * It takes the same `UsageFilters` the dashboard query took, and that is the
 * whole of the drill-through: selecting a project on a chart shows that
 * project's jobs here, with no second set of controls to keep in step and no
 * way for the two to end up disagreeing about what is on screen.
 */
function JobHistory({
  scope,
  filters,
  knownProjects,
  sessionId,
  onChanged,
}: {
  scope: UsageScope;
  filters: UsageFilters;
  knownProjects: string[];
  /** Narrow to one conversation — how an entry opens onto its own requests. */
  sessionId?: string;
  onChanged(): void;
}): React.JSX.Element {
  const [offset, setOffset] = React.useState(0);
  const [page, setPage] = React.useState<{ jobs: UsageJobSummary[]; total: number } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [openJobId, setOpenJobId] = React.useState<string | null>(null);
  const [reloads, setReloads] = React.useState(0);
  // `filters` is rebuilt by the parent on every render; its serialised form is
  // what actually changes when a filter does, and it is what the effects below
  // depend on.
  const filterKey = JSON.stringify(filters);

  React.useEffect(() => {
    // Page 4 of an unfiltered list is not page 4 of a filtered one. Narrowing
    // while deep in the pages otherwise left an empty table, which reads as
    // "this project did no work".
    setOffset(0);
  }, [scope, filterKey, sessionId]);

  React.useEffect(() => {
    let cancelled = false;
    setError(null);
    fetchUsageJobs({ scope, limit: JOBS_PAGE_SIZE, offset, sessionId, ...filters })
      .then((result) => { if (!cancelled) setPage(result); })
      .catch((err: Error) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, offset, filterKey, reloads, sessionId]);

  const total = page?.total ?? 0;
  const jobs = page?.jobs ?? [];
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(total, offset + JOBS_PAGE_SIZE);

  return (
    <div>
      {error ? (
        <div style={{ color: 'var(--destructive)', fontSize: 'var(--text-xs)' }}>{error}</div>
      ) : (
        <>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-xs)' }}>
              <thead>
                <tr>
                  {['When', 'Project', 'Agent', 'Model', 'Model turns', 'Tools', 'Tokens', 'Cost'].map((c, i) => (
                    <th key={c} style={{ ...headCellStyle, textAlign: i === 0 ? 'left' : 'right' }}>
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {jobs.length === 0 ? (
                  <tr>
                    <td colSpan={8} style={{ padding: '10px 8px', color: 'var(--muted-foreground)' }}>
                      No turns in this range
                    </td>
                  </tr>
                ) : (
                  jobs.map((job) => (
                    <tr
                      key={job.id}
                      onClick={() => setOpenJobId(job.id)}
                      style={{ cursor: 'pointer' }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--accent)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                    >
                      <td style={{ ...bodyCellStyle, textAlign: 'left' }}>
                        {new Date(job.startedAt).toLocaleString()}
                      </td>
                      <td style={bodyCellStyle}>
                        {job.project ? (
                          <>
                            {job.project}
                            {job.projectSource === 'manual' ? (
                              <Tooltip label="Attributed by hand, not read from a running session">
                                <span style={{ color: 'var(--muted-foreground)' }}> ·</span>
                              </Tooltip>
                            ) : null}
                          </>
                        ) : (
                          <span style={{ color: 'var(--muted-foreground)' }}>unattributed</span>
                        )}
                      </td>
                      <td style={bodyCellStyle}>{job.agent}</td>
                      <td style={bodyCellStyle}>
                        {job.model ?? <span style={{ color: 'var(--muted-foreground)' }}>—</span>}
                      </td>
                      <td style={bodyCellStyle}>
                        {job.modelTurns ?? <span style={{ color: 'var(--muted-foreground)' }}>—</span>}
                      </td>
                      <td style={bodyCellStyle}>{job.toolCalls}</td>
                      <td style={bodyCellStyle}>
                        <FigureText figure={jobTokensFigure(job)} />
                      </td>
                      <td style={bodyCellStyle}>
                        <FigureText figure={jobCostFigure(job)} />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
            <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--muted-foreground)' }}>
              {total === 0 ? 'No turns' : `${from}-${to} of ${total}`}
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              <Button
                variant="outline"
                size="sm"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - JOBS_PAGE_SIZE))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={to >= total}
                onClick={() => setOffset(offset + JOBS_PAGE_SIZE)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
      {openJobId ? (
        <JobDetail
          jobId={openJobId}
          scope={scope}
          knownProjects={knownProjects}
          onClose={() => setOpenJobId(null)}
          onChanged={() => { setReloads((n) => n + 1); onChanged(); }}
        />
      ) : null}
    </div>
  );
}

/**
 * The full-screen usage dashboard: what agent work has cost, durably, and what
 * it was spent on.
 *
 * Reads exclusively through `usage-api.ts`, which is the browser's whole
 * contract with the server here — this component knows nothing about how a job
 * record is stored, only what `UsageDashboard` says. Two rules run through
 * everything it draws:
 *
 * 1. A number nobody reported is never allowed to look like a zero. That is
 *    what the shared type exists for, and it survives into the charts: the bar
 *    for an unreported bucket is drawn differently, not drawn at height zero.
 * 2. Narrowing is a question asked of the server, not a filter applied to the
 *    answer it already gave. Totals, trend, every breakdown, effort, tools and
 *    the job list all come from one query with one set of filters, so they
 *    cannot come to disagree about what is being shown — and the export, which
 *    carries the same filters, cannot disagree with the screen it came from.
 */
export function UsageDashboardDialog({ open, onClose }: UsageDashboardDialogProps): React.JSX.Element | null {
  const [period, setPeriod] = React.useState<UsagePeriod>('day');
  /** Null means "wherever now is", which is what the server assumes anyway. */
  const [anchor, setAnchor] = React.useState<Date | null>(null);
  const [scope, setScope] = React.useState<UsageScope>('self');
  const [measure, setMeasure] = React.useState<UsageMeasure>('costUsd');
  const [filters, setFilters] = React.useState<UsageFilters>({});
  const [dashboard, setDashboard] = React.useState<UsageDashboard | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [reloads, setReloads] = React.useState(0);
  const isPhone = usePhone();
  const filterKey = JSON.stringify(filters);
  const anchorKey = anchor ? anchor.toISOString() : '';

  React.useEffect(() => {
    // A dashboard reopened is a question asked afresh. Carrying the last
    // visit's narrowing back in would show a total that is not the total, with
    // the reason for it several screens further down. The window it was left
    // parked on is the same kind of stale: "Usage" should mean this week's.
    if (open) {
      setFilters({});
      setAnchor(null);
    }
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    fetchUsageDashboard(period, scope, filters, anchor ?? undefined)
      .then((result) => {
        if (cancelled) return;
        setDashboard(result);
        // The server is the one that knows whether this viewer may see
        // everyone else's figures; a scope this client asked for but was
        // refused should not go on being requested every time the period
        // changes.
        if (!result.canSeeEveryone && scope === 'everyone') setScope('self');
      })
      .catch((err: Error) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, period, scope, filterKey, anchorKey, reloads]);

  const active = measureBy(measure);
  const bucketUnit: UsageBucketUnit = dashboard?.bucket ?? 'hour';
  // The projects already in use, offered as suggestions when attributing work
  // by hand. Taken from the breakdown rather than fetched separately: it is the
  // same list, already on screen, and a second request could disagree with it.
  // The sentinel is not a project anybody can type.
  const knownProjects = (dashboard?.byProject ?? [])
    .map((row) => row.key)
    .filter((key) => key !== UNATTRIBUTED && key !== '');

  /**
   * The period is the *unnarrowed* range, so choosing a new one drops any
   * window selected inside the old one — a week bounded by an hour of some
   * other day is not a question anybody asked.
   */
  const changePeriod = (next: UsagePeriod): void => {
    setPeriod(next);
    setFilters(({ from: _from, to: _to, ...rest }) => rest);
  };

  /**
   * Moving the window drops the selection made inside the old one, for the same
   * reason changing the period does: an hour of last Tuesday is not a slice of
   * this week, and carried across it would leave every figure on screen
   * answering for a range no control on the page names.
   */
  const changeAnchor = (next: Date | null): void => {
    setAnchor(next);
    setFilters(({ from: _from, to: _to, ...rest }) => rest);
  };

  /** A one-of filter: selecting the row that is already selected clears it. */
  const toggle = (key: 'agent' | 'model' | 'project' | 'user', value: string): void => {
    setFilters((current) => {
      const next = { ...current };
      if (next[key] === value) delete next[key];
      else next[key] = value;
      return next;
    });
  };

  /** Selecting a point on the trend narrows the whole dashboard to that bucket. */
  const selectBucket = (key: string): void => {
    const start = bucketStart(key, bucketUnit);
    if (!start) return;
    const end = bucketEnd(start, bucketUnit);
    setFilters((current) => {
      // Both ends, not just the start. A day-wide selection is redrawn as 24
      // hourly bars whose first one begins at the same instant, so matching on
      // the start alone made pressing that bar jump back out to the whole
      // month instead of narrowing to midnight.
      if (current.from === start.toISOString() && current.to === end.toISOString()) {
        const { from: _from, to: _to, ...rest } = current;
        return rest;
      }
      return { ...current, from: start.toISOString(), to: end.toISOString() };
    });
  };

  const selectedBucketKey = React.useMemo(() => {
    if (!filters.from || !dashboard) return null;
    const start = new Date(filters.from);
    if (Number.isNaN(start.getTime())) return null;
    // A selected window is re-bucketed one level finer once it is applied, so
    // the bar that was clicked no longer exists at that width. Its start does:
    // it is the first bucket of the narrowed range.
    return (
      dashboard.series.find((b) => {
        const bucket = bucketStart(b.key, dashboard.bucket);
        if (bucket === null || bucket.getTime() !== start.getTime()) return false;
        // And ends where this bucket ends. A window one level wider than the
        // buckets drawn for it — a selected day, redrawn as hours — is not any
        // one of those bars, and marking the first of them as pressed would
        // claim a selection the viewer never made.
        return bucketEnd(bucket, dashboard.bucket).toISOString() === filters.to;
      })?.key ?? null
    );
  }, [filters.from, filters.to, dashboard]);

  if (!open) return null;

  return (
    <Dialog
      open={open}
      title="Usage"
      onClose={onClose}
      width={860}
      movable
      height="80vh"
      headerActions={
        dashboard ? (
          <Button
            variant="outline"
            size="sm"
            iconLeft={<Icon name="download" size={13} />}
            onClick={() => exportUsage(scope, dashboard.from, dashboard.to, filters)}
          >
            Export
          </Button>
        ) : null
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center', justifyContent: 'space-between' }}>
            <Tabs
              tabs={PERIODS.map((p) => ({ value: p.value, label: p.label }))}
              value={period}
              onChange={(v) => changePeriod(v as UsagePeriod)}
            />
            {dashboard?.canSeeEveryone ? (
              <Tabs
                tabs={[{ value: 'self', label: 'Just me' }, { value: 'everyone', label: 'Everyone' }]}
                value={scope}
                onChange={(v) => setScope(v as UsageScope)}
              />
            ) : null}
          </div>
          <PeriodNavigator
            period={period}
            anchor={anchor}
            // An empty window is only worth remarking on once the answer is in;
            // while it is loading there is nothing to say and a line saying
            // "nothing recorded" would be a guess.
            empty={Boolean(dashboard) && dashboard?.totals.turns === 0}
            narrowed={hasFilters(filters)}
            onAnchor={changeAnchor}
          />
        </div>

        <FilterChips filters={filters} onChange={setFilters} />

        {error ? (
          <div style={{ color: 'var(--destructive)', fontSize: 'var(--text-ui)' }}>{error}</div>
        ) : !dashboard ? (
          <div style={{ color: 'var(--muted-foreground)', fontSize: 'var(--text-ui)' }}>Loading…</div>
        ) : (
          <>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: isPhone ? '1fr 1fr' : 'repeat(5, 1fr)',
                gap: 10,
              }}
            >
              <Headline label="Cost" figure={costFigure(dashboard.totals)} />
              <Headline label="Tokens" figure={tokensFigure(dashboard.totals)} />
              <Headline label="Turns" figure={{ text: String(dashboard.totals.turns) }} />
              <Headline label="Model turns" figure={modelTurnsFigure(dashboard.totals)} />
              <Headline label="Tool calls" figure={{ text: String(dashboard.totals.toolCalls) }} />
            </div>

            <CostCaveat />

            <div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
                <h3 style={{ ...sectionTitleStyle, margin: 0 }}>Trend</h3>
                <Tabs
                  tabs={MEASURES.map((m) => ({ value: m.value, label: m.label }))}
                  value={measure}
                  onChange={(v) => setMeasure(v as UsageMeasure)}
                />
              </div>
              <div style={{ ...cardStyle, marginTop: 8 }}>
                <TrendChart
                  buckets={dashboard.series}
                  unit={dashboard.bucket}
                  measure={active}
                  selectedKey={selectedBucketKey}
                  onSelect={selectBucket}
                />
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: isPhone ? '1fr' : '1fr 1fr', gap: 16 }}>
              <div>
                <h3 style={sectionTitleStyle}>By project</h3>
                <BreakdownTable
                  rows={dashboard.byProject}
                  unknown="unattributed"
                  selected={filters.project}
                  onSelect={(key) => toggle('project', key)}
                />
                {/* Said where the problem is visible, not in a help page. Work
                    with no project is the one row here a viewer can actually
                    do something about, and the way to do it is two panels
                    down. */}
                {dashboard.byProject.some((row) => row.key === UNATTRIBUTED) ? (
                  <div style={{ marginTop: 6, fontSize: 'var(--text-2xs)', color: 'var(--muted-foreground)' }}>
                    Work recorded before its folder was tracked shows as unattributed. Open any of
                    those jobs in the history below to attribute it — and its whole conversation — by
                    hand.
                  </div>
                ) : null}
              </div>
              <div>
                <h3 style={sectionTitleStyle}>By agent</h3>
                <BreakdownTable
                  rows={dashboard.byAgent}
                  unknown="not reported"
                  selected={filters.agent}
                  onSelect={(key) => toggle('agent', key)}
                />
              </div>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns:
                  isPhone || !(scope === 'everyone' && dashboard.byUser) ? '1fr' : '1fr 1fr',
                gap: 16,
              }}
            >
              <div>
                <h3 style={sectionTitleStyle}>By model</h3>
                <BreakdownTable
                  rows={dashboard.byModel}
                  unknown="not reported"
                  selected={filters.model}
                  onSelect={(key) => toggle('model', key)}
                />
              </div>
              {scope === 'everyone' && dashboard.byUser ? (
                <div>
                  <h3 style={sectionTitleStyle}>By user</h3>
                  <BreakdownTable
                    rows={dashboard.byUser}
                    unknown="not reported"
                    selected={filters.user}
                    onSelect={(key) => toggle('user', key)}
                  />
                </div>
              ) : null}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: isPhone ? '1fr' : '1fr 1fr', gap: 16 }}>
              <div>
                <h3 style={sectionTitleStyle}>Effort by agent</h3>
                <EffortTable rows={dashboard.effortByAgent} unknown="not reported" />
              </div>
              <div>
                <h3 style={sectionTitleStyle}>Effort by model</h3>
                <EffortTable rows={dashboard.effortByModel} unknown="not reported" />
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: isPhone ? '1fr' : '1fr 1fr', gap: 16 }}>
              <div>
                <h3 style={sectionTitleStyle}>Most-used tools</h3>
                <ToolsTable tools={dashboard.topTools} />
              </div>
              <div>
                <h3 style={sectionTitleStyle}>Most-used tools by agent</h3>
                <ToolsTable tools={dashboard.topToolsByAgent} />
              </div>
            </div>

            <div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
                <h3 style={{ ...sectionTitleStyle, margin: 0 }}>History</h3>
                {hasFilters(filters) ? (
                  <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--muted-foreground)' }}>
                    narrowed to the same selection
                  </span>
                ) : null}
              </div>
              <div style={{ marginTop: 8 }}>
                <History
                  scope={scope}
                  // The range the figures above were actually computed over,
                  // not the filter state — a period button sets no `from`/`to`
                  // of its own, so a list built from `filters` alone covered
                  // all time while the headline covered a day. The two have to
                  // add up (#88), and this is the one place both readings of
                  // the range come from.
                  filters={{ ...filters, from: dashboard.from, to: dashboard.to }}
                  knownProjects={knownProjects}
                  // Attributing work changes the figures above it, so the whole
                  // view is re-asked rather than left showing a breakdown that
                  // disagrees with the row that was just edited.
                  onChanged={() => setReloads((n) => n + 1)}
                />
              </div>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
