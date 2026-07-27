import * as React from 'react';

import type {
  UsageBreakdown,
  UsageBucket,
  UsageBucketUnit,
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
  fetchUsageDashboard,
  fetchUsageJob,
  fetchUsageJobs,
} from '../../chat/usage-api';
import { Button } from '../../ui/relay/Button';
import { Dialog } from '../../ui/relay/Dialog';
import { Icon } from '../../ui/relay/Icon';
import { Input } from '../../ui/relay/Input';
import { Tabs } from '../../ui/relay/Tabs';
import { Tooltip } from '../../ui/relay/Tooltip';
import { usePhone } from '../../ui/touch';

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
 * The honesty rule for a total: `costUsd` of zero across zero reporting jobs
 * and `costUsd` of zero across every job are opposite facts, and this is the
 * one place that turns `UsageTotals` into the sentence a viewer should read.
 */
function costFigure(totals: UsageTotals): Figure {
  if (totals.jobs === 0) return { text: '—', muted: true, title: 'No jobs in this range' };
  if (totals.costReportedJobs === 0) {
    return { text: 'not reported', muted: true, title: 'None of these jobs reported a cost' };
  }
  if (totals.costReportedJobs < totals.jobs) {
    return {
      text: `${formatCost(totals.costUsd)} across ${totals.costReportedJobs} of ${totals.jobs} jobs`,
      title: `${totals.jobs - totals.costReportedJobs} job(s) did not report a cost and are excluded from this figure`,
    };
  }
  return { text: formatCost(totals.costUsd) };
}

function tokensFigure(totals: UsageTotals): Figure {
  if (totals.jobs === 0) return { text: '—', muted: true, title: 'No jobs in this range' };
  if (totals.tokensReportedJobs === 0) {
    return { text: 'not reported', muted: true, title: 'None of these jobs reported token counts' };
  }
  if (totals.tokensReportedJobs < totals.jobs) {
    return {
      text: `${formatTokens(totals.totalTokens)} across ${totals.tokensReportedJobs} of ${totals.jobs} jobs`,
      title: `${totals.jobs - totals.tokensReportedJobs} job(s) did not report token counts and are excluded from this figure`,
    };
  }
  return { text: formatTokens(totals.totalTokens) };
}

function countFigure(n: number): Figure {
  return { text: String(n) };
}

/**
 * One thing the dashboard can plot, and everything needed to plot it.
 *
 * The distinction between a measure the *runtime* reports and one this app
 * counts for itself is carried in `reported`, and it is why this is a table
 * rather than a switch on a string. Cost and tokens can be absent — nobody
 * said — where jobs, turns and tool calls are counted from the transcript and
 * are therefore always known. A chart that drew all five the same way would
 * invent measurements for the first two.
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
    reported: (t) => t.costReportedJobs > 0,
    figure: costFigure,
  },
  {
    value: 'totalTokens',
    label: 'Tokens',
    amount: (t) => t.totalTokens,
    reported: (t) => t.tokensReportedJobs > 0,
    figure: tokensFigure,
  },
  {
    value: 'jobs',
    label: 'Jobs',
    amount: (t) => t.jobs,
    reported: (t) => t.jobs > 0,
    figure: (t) => countFigure(t.jobs),
  },
  {
    value: 'turns',
    label: 'Turns',
    amount: (t) => t.turns,
    reported: (t) => t.jobs > 0,
    figure: (t) => countFigure(t.turns),
  },
  {
    value: 'toolCalls',
    label: 'Tool calls',
    amount: (t) => t.toolCalls,
    reported: (t) => t.jobs > 0,
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
            {` · ${shown.totals.jobs} job(s)`}
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
              aria-label={`${bucketLabel(bucket.key, unit)}: ${measure.label} ${figure.text}, ${bucket.totals.jobs} job(s)`}
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

/** The five fixed buckets a `UsageEffort` histogram carries, turns or tool calls. */
function EffortHistogram({
  histogram,
  labels,
}: {
  histogram: readonly [number, number, number, number, number];
  labels: readonly [string, string, string, string, string];
}): React.JSX.Element {
  const max = Math.max(1, ...histogram);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 44 }}>
      {histogram.map((count, i) => (
        <Tooltip key={labels[i]} label={`${labels[i]}: ${count} job(s)`}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, width: 22 }}>
            <div
              style={{
                width: '100%',
                height: Math.max(2, (count / max) * 32),
                background: count > 0 ? 'var(--primary)' : 'var(--border)',
                borderRadius: 1,
              }}
            />
            <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--muted-foreground)' }}>{labels[i]}</span>
          </div>
        </Tooltip>
      ))}
    </div>
  );
}

const TURNS_LABELS = ['1', '2', '3-5', '6-10', '11+'] as const;
const TOOLS_LABELS = ['0', '1-2', '3-5', '6-10', '11+'] as const;

function BreakdownKey({ value, unknown }: { value: string; unknown: string }): React.JSX.Element {
  if (value && value !== UNATTRIBUTED) return <>{value}</>;
  return (
    <span
      style={{ color: 'var(--muted-foreground)' }}
      title={
        unknown === 'unattributed'
          ? 'Recorded before this app knew which project a job ran in'
          : 'These jobs ran without a reported model'
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
  { label: 'Jobs', measure: 'jobs' },
  { label: 'Turns', measure: 'turns' },
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
                  <td style={bodyCellStyle}>{row.totals.jobs}</td>
                  <td style={bodyCellStyle}>{row.totals.turns}</td>
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
              <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--muted-foreground)' }}>{row.jobs} jobs</div>
            </div>
            <div>
              <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--muted-foreground)' }}>
                turns/job · avg {formatAvg(row.turnsAvg)} · max {row.turnsMax}
              </div>
              <EffortHistogram histogram={row.turnsHistogram} labels={TURNS_LABELS} />
            </div>
            <div>
              <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--muted-foreground)' }}>
                tool calls/job · avg {formatAvg(row.toolCallsAvg)} · max {row.toolCallsMax}
              </div>
              <EffortHistogram histogram={row.toolCallsHistogram} labels={TOOLS_LABELS} />
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
      columns={tools.some((t) => t.agent) ? ['Tool', 'Agent', 'Calls', 'Jobs'] : ['Tool', 'Calls', 'Jobs']}
      rows={tools.map((t) => (t.agent ? [t.tool, t.agent, t.calls, t.jobs] : [t.tool, t.calls, t.jobs]))}
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
              <div style={{ color: 'var(--muted-foreground)', fontSize: 'var(--text-2xs)' }}>Turns</div>
              <div>{job.turns}</div>
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
  onChanged,
}: {
  scope: UsageScope;
  filters: UsageFilters;
  knownProjects: string[];
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
  }, [scope, filterKey]);

  React.useEffect(() => {
    let cancelled = false;
    setError(null);
    fetchUsageJobs({ scope, limit: JOBS_PAGE_SIZE, offset, ...filters })
      .then((result) => { if (!cancelled) setPage(result); })
      .catch((err: Error) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, offset, filterKey, reloads]);

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
                  {['When', 'Project', 'Agent', 'Model', 'Turns', 'Tools', 'Tokens', 'Cost'].map((c, i) => (
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
                      No jobs in this range
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
                      <td style={bodyCellStyle}>{job.turns}</td>
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
              {total === 0 ? 'No jobs' : `${from}-${to} of ${total}`}
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
  const [scope, setScope] = React.useState<UsageScope>('self');
  const [measure, setMeasure] = React.useState<UsageMeasure>('costUsd');
  const [filters, setFilters] = React.useState<UsageFilters>({});
  const [dashboard, setDashboard] = React.useState<UsageDashboard | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [reloads, setReloads] = React.useState(0);
  const isPhone = usePhone();
  const filterKey = JSON.stringify(filters);

  React.useEffect(() => {
    // A dashboard reopened is a question asked afresh. Carrying the last
    // visit's narrowing back in would show a total that is not the total, with
    // the reason for it several screens further down.
    if (open) setFilters({});
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    fetchUsageDashboard(period, scope, filters)
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
  }, [open, period, scope, filterKey, reloads]);

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
              <Headline label="Jobs" figure={{ text: String(dashboard.totals.jobs) }} />
              <Headline label="Turns" figure={{ text: String(dashboard.totals.turns) }} />
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
                <h3 style={{ ...sectionTitleStyle, margin: 0 }}>Job history</h3>
                {hasFilters(filters) ? (
                  <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--muted-foreground)' }}>
                    narrowed to the same selection
                  </span>
                ) : null}
              </div>
              <div style={{ marginTop: 8 }}>
                <JobHistory
                  scope={scope}
                  filters={filters}
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
