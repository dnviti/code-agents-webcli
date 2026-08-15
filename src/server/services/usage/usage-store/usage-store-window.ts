import type { UsageBucketUnit, UsagePeriod } from '../../../../shared/usage-records.js';

/**
 * The range a period covers, and the buckets to draw inside it.
 *
 * Computed against the viewer's own offset rather than the server's, because
 * "what did I spend today" is a question about their day. The bucket keys are
 * generated here rather than taken from whatever the query happened to return,
 * so a quiet hour still appears on the trend line as a gap instead of closing
 * up and making the shape a lie.
 */
export function rangeFor(
  period: UsagePeriod,
  anchor: Date,
  tzOffsetMinutes: number,
): { from: Date; to: Date; buckets: string[]; format: string; unit: UsageBucketUnit } {
  const shift = tzOffsetMinutes * 60_000;
  const local = new Date(anchor.getTime() + shift);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();
  const toUtc = (ms: number): Date => new Date(ms - shift);
  const buckets: string[] = [];

  if (period === 'day') {
    const start = Date.UTC(y, m, d);
    for (let h = 0; h < 24; h += 1) buckets.push(iso(new Date(start + h * 3_600_000), 'hour'));
    // The minutes are not decoration. `2026-07-27T09` is not a parseable
    // instant — `new Date` on it returns Invalid Date — and the key is
    // documented as an ISO one, so anything that formats it for an axis label
    // would print exactly that.
    return { from: toUtc(start), to: toUtc(start + 24 * 3_600_000), buckets, format: '%Y-%m-%dT%H:00', unit: 'hour' };
  }

  if (period === 'week') {
    // Monday-first: a spending week that starts on Sunday reads as two
    // half-weeks to everyone who works Monday to Friday.
    const weekday = (new Date(Date.UTC(y, m, d)).getUTCDay() + 6) % 7;
    const start = Date.UTC(y, m, d - weekday);
    for (let i = 0; i < 7; i += 1) buckets.push(iso(new Date(start + i * 86_400_000), 'day'));
    return { from: toUtc(start), to: toUtc(start + 7 * 86_400_000), buckets, format: '%Y-%m-%d', unit: 'day' };
  }

  if (period === 'month') {
    const start = Date.UTC(y, m, 1);
    const end = Date.UTC(y, m + 1, 1);
    for (let t = start; t < end; t += 86_400_000) buckets.push(iso(new Date(t), 'day'));
    return { from: toUtc(start), to: toUtc(end), buckets, format: '%Y-%m-%d', unit: 'day' };
  }

  const start = Date.UTC(y, 0, 1);
  for (let i = 0; i < 12; i += 1) buckets.push(iso(new Date(Date.UTC(y, i, 1)), 'month'));
  return { from: toUtc(start), to: toUtc(Date.UTC(y + 1, 0, 1)), buckets, format: '%Y-%m', unit: 'month' };
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Two years. A window wider than this is a mistake or an attempt, not a question. */
const MAX_WINDOW_MS = 2 * 366 * DAY_MS;
/** More bars than this is a smear, and more rows than a browser should be handed. */
const MAX_BUCKETS = 800;

/**
 * The range the dashboard covers, whether it came from a period or from a
 * viewer clicking one bar of the trend.
 *
 * Granularity is derived from how wide the window is, not from which period
 * button is lit. That is the whole of what makes drilling in work: click a
 * month and you get its days, click one of those days and you get its hours,
 * with no second notion of "zoom level" to keep in step with the first. The
 * thresholds are chosen so an unnarrowed period lands exactly where it used to
 * — a day on hours, a week and a month on days, a year on months.
 */
export function windowFor(
  period: UsagePeriod,
  anchor: Date,
  tzOffsetMinutes: number,
  fromISO?: string,
  toISO?: string,
): { from: Date; to: Date; buckets: string[]; format: string; unit: UsageBucketUnit; windowed: boolean } {
  const from = parseInstant(fromISO);
  const to = parseInstant(toISO);
  // Both ends or neither. One end alone leaves the other implied by the period,
  // and a window whose start and end were decided by two different mechanisms
  // is the kind of thing that reads correctly right up until a month boundary.
  if (!from || !to || to.getTime() <= from.getTime()) {
    return { ...rangeFor(period, anchor, tzOffsetMinutes), windowed: false };
  }

  const span = Math.min(to.getTime() - from.getTime(), MAX_WINDOW_MS);
  const end = new Date(from.getTime() + span);
  const unit: UsageBucketUnit = span > 62 * DAY_MS ? 'month' : span > 36 * HOUR_MS ? 'day' : 'hour';
  const shift = tzOffsetMinutes * 60_000;
  const local = new Date(from.getTime() + shift);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();

  // Aligned down to the unit boundary in the viewer's own frame, so the first
  // bar is a whole hour or a whole day rather than a stub starting at 09:37.
  let cursor =
    unit === 'hour'
      ? Date.UTC(y, m, d, local.getUTCHours())
      : unit === 'day'
        ? Date.UTC(y, m, d)
        : Date.UTC(y, m, 1);
  const localEnd = end.getTime() + shift;
  const buckets: string[] = [];
  let months = 0;
  while (cursor < localEnd && buckets.length < MAX_BUCKETS) {
    buckets.push(iso(new Date(cursor), unit));
    if (unit === 'hour') cursor += HOUR_MS;
    else if (unit === 'day') cursor += DAY_MS;
    else {
      months += 1;
      cursor = Date.UTC(y, m + months, 1);
    }
  }

  return {
    from,
    to: end,
    buckets,
    format: unit === 'hour' ? '%Y-%m-%dT%H:00' : unit === 'day' ? '%Y-%m-%d' : '%Y-%m',
    unit,
    windowed: true,
  };
}

function parseInstant(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function iso(date: Date, unit: 'hour' | 'day' | 'month'): string {
  const text = date.toISOString();
  if (unit === 'hour') return `${text.slice(0, 13)}:00`;
  if (unit === 'day') return text.slice(0, 10);
  return text.slice(0, 7);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
