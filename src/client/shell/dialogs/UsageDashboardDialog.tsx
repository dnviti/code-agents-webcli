import * as React from 'react';

import type {
  UsageBreakdown,
  UsageBucket,
  UsageDashboard,
  UsageEffort,
  UsageJobRecord,
  UsageJobSummary,
  UsagePeriod,
  UsageScope,
  UsageToolUse,
  UsageTotals,
} from '../../../shared/usage-records.js';
import {
  exportUsage,
  fetchUsageDashboard,
  fetchUsageJob,
  fetchUsageJobs,
} from '../../chat/usage-api';
import { Button } from '../../ui/relay/Button';
import { Dialog } from '../../ui/relay/Dialog';
import { Icon } from '../../ui/relay/Icon';
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
 * A bucket key as something a person can read.
 *
 * Falls back to the key itself rather than to whatever `Date` made of it: a key
 * this cannot parse is a bug on the server, and "Invalid Date" across the whole
 * axis hides which bucket is at fault while looking like a rendering fault
 * here. The raw key at least says what arrived.
 */
function bucketLabel(key: string): string {
  const date = new Date(key);
  return Number.isNaN(date.getTime()) ? key : date.toLocaleString();
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
 * A hand-rolled bar chart for the trend over time.
 *
 * No charting dependency: this is the one shape the dashboard needs — a
 * handful of bars read left to right — and an inline SVG costs nothing to
 * load and nothing to theme, where a library would bring its own colours to
 * fight `var(--*)` for every one of them.
 */
function TrendChart({ buckets }: { buckets: UsageBucket[] }): React.JSX.Element {
  const width = 640;
  const height = 120;
  const gap = 3;
  const barWidth = buckets.length ? Math.max(2, width / buckets.length - gap) : 0;
  const max = Math.max(1, ...buckets.map((b) => b.totals.costUsd));

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      role="img"
      aria-label="Cost over time"
      preserveAspectRatio="none"
    >
      {buckets.map((bucket, i) => {
        const figure = costFigure(bucket.totals);
        const x = i * (barWidth + gap);
        const reported = bucket.totals.costReportedJobs > 0;
        const h = reported ? Math.max(1, (bucket.totals.costUsd / max) * (height - 16)) : 2;
        const label = `${bucketLabel(bucket.key)}: ${figure.text}`;
        return (
          <g key={bucket.key}>
            <title>{label}</title>
            <rect
              x={x}
              y={height - h}
              width={barWidth}
              height={h}
              fill={reported ? 'var(--primary)' : 'var(--border)'}
              rx={1}
            />
          </g>
        );
      })}
    </svg>
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
              <th
                key={c}
                style={{
                  textAlign: i === 0 ? 'left' : 'right',
                  padding: '4px 8px',
                  borderBottom: '1px solid var(--border)',
                  color: 'var(--muted-foreground)',
                  fontWeight: 'var(--font-medium)' as React.CSSProperties['fontWeight'],
                  whiteSpace: 'nowrap',
                }}
              >
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
                  <td
                    key={j}
                    style={{
                      textAlign: j === 0 ? 'left' : 'right',
                      padding: '4px 8px',
                      borderBottom: '1px solid var(--border)',
                      whiteSpace: 'nowrap',
                    }}
                  >
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

function BreakdownTable({ rows }: { rows: UsageBreakdown[] }): React.JSX.Element {
  return (
    <Table
      columns={['', 'Jobs', 'Turns', 'Tools', 'Tokens', 'Cost']}
      rows={rows.map((row) => [
        row.key,
        row.totals.jobs,
        row.totals.turns,
        row.totals.toolCalls,
        <FigureText key="tok" figure={tokensFigure(row.totals)} />,
        <FigureText key="cost" figure={costFigure(row.totals)} />,
      ])}
    />
  );
}

function EffortTable({ rows }: { rows: UsageEffort[] }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {rows.length === 0 ? (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--muted-foreground)' }}>Nothing here yet</div>
      ) : (
        rows.map((row) => (
          <div key={row.key} style={{ ...cardStyle, display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'center' }}>
            <div style={{ minWidth: 90 }}>
              <div style={{ fontSize: 'var(--text-ui)' }}>{row.key}</div>
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
      rows={tools.map((t) =>
        t.agent ? [t.tool, t.agent, t.calls, t.jobs] : [t.tool, t.calls, t.jobs],
      )}
    />
  );
}

function JobDetail({
  jobId,
  scope,
  onClose,
}: {
  jobId: string;
  scope: UsageScope;
  onClose(): void;
}): React.JSX.Element {
  const [job, setJob] = React.useState<UsageJobRecord | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setJob(null);
    setError(null);
    fetchUsageJob(jobId, scope)
      .then((record) => { if (!cancelled) setJob(record); })
      .catch((err: Error) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [jobId, scope]);

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

function JobHistory({ scope }: { scope: UsageScope }): React.JSX.Element {
  const [offset, setOffset] = React.useState(0);
  const [page, setPage] = React.useState<{ jobs: UsageJobSummary[]; total: number } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [openJobId, setOpenJobId] = React.useState<string | null>(null);

  React.useEffect(() => {
    setOffset(0);
  }, [scope]);

  React.useEffect(() => {
    let cancelled = false;
    fetchUsageJobs({ scope, limit: JOBS_PAGE_SIZE, offset })
      .then((result) => { if (!cancelled) setPage(result); })
      .catch((err: Error) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [scope, offset]);

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
                  {['When', 'Agent', 'Model', 'Turns', 'Tools', 'Tokens', 'Cost'].map((c, i) => (
                    <th
                      key={c}
                      style={{
                        textAlign: i === 0 ? 'left' : 'right',
                        padding: '4px 8px',
                        borderBottom: '1px solid var(--border)',
                        color: 'var(--muted-foreground)',
                        fontWeight: 'var(--font-medium)' as React.CSSProperties['fontWeight'],
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {jobs.length === 0 ? (
                  <tr>
                    <td colSpan={7} style={{ padding: '10px 8px', color: 'var(--muted-foreground)' }}>
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
                      <td style={{ padding: '4px 8px', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>
                        {new Date(job.startedAt).toLocaleString()}
                      </td>
                      <td style={{ textAlign: 'right', padding: '4px 8px', borderBottom: '1px solid var(--border)' }}>{job.agent}</td>
                      <td style={{ textAlign: 'right', padding: '4px 8px', borderBottom: '1px solid var(--border)' }}>
                        {job.model ?? <span style={{ color: 'var(--muted-foreground)' }}>—</span>}
                      </td>
                      <td style={{ textAlign: 'right', padding: '4px 8px', borderBottom: '1px solid var(--border)' }}>{job.turns}</td>
                      <td style={{ textAlign: 'right', padding: '4px 8px', borderBottom: '1px solid var(--border)' }}>{job.toolCalls}</td>
                      <td style={{ textAlign: 'right', padding: '4px 8px', borderBottom: '1px solid var(--border)' }}>
                        <FigureText figure={jobTokensFigure(job)} />
                      </td>
                      <td style={{ textAlign: 'right', padding: '4px 8px', borderBottom: '1px solid var(--border)' }}>
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
        <JobDetail jobId={openJobId} scope={scope} onClose={() => setOpenJobId(null)} />
      ) : null}
    </div>
  );
}

/**
 * The full-screen usage dashboard: what agent work has cost, durably.
 *
 * Reads exclusively through `usage-api.ts`, which is the browser's whole
 * contract with the server here — this component knows nothing about how a
 * job record is stored, only what `UsageDashboard` says. The one rule it
 * enforces on every figure it draws is the one the shared type exists for:
 * a number nobody reported is never allowed to look like a zero.
 */
export function UsageDashboardDialog({ open, onClose }: UsageDashboardDialogProps): React.JSX.Element | null {
  const [period, setPeriod] = React.useState<UsagePeriod>('day');
  const [scope, setScope] = React.useState<UsageScope>('self');
  const [dashboard, setDashboard] = React.useState<UsageDashboard | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const isPhone = usePhone();

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    fetchUsageDashboard(period, scope)
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
  }, [open, period, scope]);

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
            onClick={() => exportUsage(scope, dashboard.from, dashboard.to)}
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
            onChange={(v) => setPeriod(v as UsagePeriod)}
          />
          {dashboard?.canSeeEveryone ? (
            <Tabs
              tabs={[{ value: 'self', label: 'Just me' }, { value: 'everyone', label: 'Everyone' }]}
              value={scope}
              onChange={(v) => setScope(v as UsageScope)}
            />
          ) : null}
        </div>

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

            <div>
              <h3 style={sectionTitleStyle}>Trend</h3>
              <div style={cardStyle}>
                <TrendChart buckets={dashboard.series} />
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: isPhone ? '1fr' : '1fr 1fr', gap: 16 }}>
              <div>
                <h3 style={sectionTitleStyle}>By agent</h3>
                <BreakdownTable rows={dashboard.byAgent} />
              </div>
              <div>
                <h3 style={sectionTitleStyle}>By model</h3>
                <BreakdownTable rows={dashboard.byModel} />
              </div>
            </div>

            {scope === 'everyone' && dashboard.byUser ? (
              <div>
                <h3 style={sectionTitleStyle}>By user</h3>
                <BreakdownTable rows={dashboard.byUser} />
              </div>
            ) : null}

            <div style={{ display: 'grid', gridTemplateColumns: isPhone ? '1fr' : '1fr 1fr', gap: 16 }}>
              <div>
                <h3 style={sectionTitleStyle}>Effort by agent</h3>
                <EffortTable rows={dashboard.effortByAgent} />
              </div>
              <div>
                <h3 style={sectionTitleStyle}>Effort by model</h3>
                <EffortTable rows={dashboard.effortByModel} />
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
              <h3 style={sectionTitleStyle}>Job history</h3>
              <JobHistory scope={scope} />
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
