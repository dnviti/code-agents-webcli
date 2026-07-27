import type {
  UsageDashboard,
  UsageJobRecord,
  UsageJobSummary,
  UsagePeriod,
  UsageScope,
} from '../../shared/usage-records.js';

/**
 * The browser's half of the usage-accounting routes.
 *
 * Thin on purpose, same as `workspace-api.ts`: every one of these is a plain
 * GET whose shape is decided by `src/server/routes/usage.ts`, and the
 * dashboard is easier to read when the fetch boilerplate is not repeated in
 * every panel that needs a page of it.
 */

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });

  if (!response.ok) {
    // Same reasoning as workspace-api's getJson: a 404 that is not JSON is
    // Express's own "no such route", not this API answering — the tell for a
    // page that has been reloaded against a server older than itself.
    const contentType = response.headers.get('content-type') || '';
    if (response.status === 404 && !contentType.includes('json')) {
      throw new Error(
        'This server has no usage API. It is running an older version than this page — '
          + 'restart the server and reload.',
      );
    }

    const detail = await response
      .json()
      .then((body: { error?: string; message?: string }) => body.error || body.message)
      .catch(() => null);
    throw new Error(detail || `Request failed (${response.status})`);
  }

  return (await response.json()) as T;
}

/** The viewer's own UTC offset, in minutes, the way `Date.getTimezoneOffset` already gives it. */
export function localTzOffsetMinutes(): number {
  return -new Date().getTimezoneOffset();
}

export function fetchUsageDashboard(period: UsagePeriod, scope: UsageScope): Promise<UsageDashboard> {
  const params = new URLSearchParams({
    period,
    scope,
    tz: String(localTzOffsetMinutes()),
  });
  return getJson<UsageDashboard>(`/api/usage/dashboard?${params.toString()}`);
}

export interface UsageJobsQuery {
  scope: UsageScope;
  limit?: number;
  offset?: number;
  agent?: string;
  model?: string;
}

export interface UsageJobsPage {
  jobs: UsageJobSummary[];
  total: number;
}

export function fetchUsageJobs(query: UsageJobsQuery): Promise<UsageJobsPage> {
  const params = new URLSearchParams({ scope: query.scope });
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.offset !== undefined) params.set('offset', String(query.offset));
  if (query.agent) params.set('agent', query.agent);
  if (query.model) params.set('model', query.model);
  return getJson<UsageJobsPage>(`/api/usage/jobs?${params.toString()}`);
}

/**
 * One job in full.
 *
 * The scope travels with it, and has to: the server resolves a missing one to
 * `self` and answers 404, which meant every row an administrator had just been
 * shown in the everyone view refused to open. The server still decides whether
 * the scope is allowed — this only stops the request asking for less than the
 * list it came from.
 */
export function fetchUsageJob(id: string, scope: UsageScope): Promise<UsageJobRecord> {
  const params = new URLSearchParams({ scope });
  return getJson<UsageJobRecord>(`/api/usage/jobs/${encodeURIComponent(id)}?${params.toString()}`);
}

/**
 * The URL the export button downloads from.
 *
 * A URL rather than a fetch-then-blob, same reasoning as `rawFileUrl` in
 * workspace-api: the browser's own download machinery already streams and
 * names the file, and fetching the CSV here would only buffer it in memory to
 * hand the same bytes straight back.
 */
export function usageExportUrl(scope: UsageScope, from: string, to: string): string {
  const params = new URLSearchParams({ scope, from, to, format: 'csv' });
  return `/api/usage/export?${params.toString()}`;
}

/**
 * Trigger the CSV download.
 *
 * A plain anchor click, not a fetch: same as `downloadFile` in
 * workspace-api.ts, this lets the browser name and save the file itself
 * rather than this code re-implementing a save dialog around a blob.
 */
export function exportUsage(scope: UsageScope, from: string, to: string): void {
  const anchor = document.createElement('a');
  anchor.href = usageExportUrl(scope, from, to);
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
