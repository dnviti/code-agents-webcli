import { Router, Request, Response } from 'express';
import { UsageStore, UsageHistoryQuery } from '../services/usage-store.js';
import { AuthenticatedUser } from '../types.js';
import { UsageFilters, UsagePeriod, UsageScope } from '../../shared/usage-records.js';
import { requireUser } from './helpers.js';

export interface UsageRoutesDeps {
  usageStore: UsageStore;
  getInstallerUserId(): number | null;
}

const PERIODS: UsagePeriod[] = ['day', 'week', 'month', 'year'];

/** A project name is a table cell, not a paragraph. */
const MAX_PROJECT_LENGTH = 120;

/**
 * Whether this viewer may ask for `everyone`.
 *
 * There is no role system in this app; the installer — the account that
 * completed the very first OAuth callback — is the one seat with a wider
 * view, the same seat that gates a self-update.
 */
function isInstaller(deps: UsageRoutesDeps, user: AuthenticatedUser): boolean {
  const installerUserId = deps.getInstallerUserId();
  return installerUserId !== null && user.id === installerUserId;
}

/**
 * Resolve the scope a request may actually have, rather than the one it asked
 * for. Every handler below routes its query param through here instead of
 * reading `req.query.scope` directly, so a new route cannot get the wide view
 * by omission.
 */
function resolveScope(deps: UsageRoutesDeps, user: AuthenticatedUser, raw: unknown): UsageScope {
  if (raw !== 'everyone') return 'self';
  return isInstaller(deps, user) ? 'everyone' : 'self';
}

function parsePeriod(raw: unknown): UsagePeriod {
  return typeof raw === 'string' && (PERIODS as string[]).includes(raw) ? (raw as UsagePeriod) : 'day';
}

function parseAnchor(raw: unknown): Date | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * The viewer's offset from UTC, in minutes.
 *
 * Clamped to the range real time zones occupy — UTC-12 to UTC+14 — because this
 * number is added to a timestamp before the range is computed, and a browser
 * that sent a nonsense one would otherwise be handed a window centuries wide to
 * aggregate over.
 */
function parseTz(raw: unknown): number | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(840, Math.max(-720, Math.trunc(n)));
}

function stringParam(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/**
 * The narrowing a request carries.
 *
 * Read once, in one place, and handed to every route: the dashboard, the job
 * list it drills into and the export all have to agree about what is on
 * screen, and three separate readings of the same query string is how they
 * stop agreeing.
 *
 * `user` is not privileged here. It narrows to one login, but it can only ever
 * narrow *within* the scope the request already resolved to — a viewer scoped
 * to `self` who asks for somebody else's login gets their own empty set, not
 * somebody else's figures, because the scope predicate is still there.
 */
function filtersFrom(req: Request): UsageFilters {
  return {
    agent: stringParam(req.query.agent),
    model: stringParam(req.query.model),
    project: stringParam(req.query.project),
    user: stringParam(req.query.user),
    from: stringParam(req.query.from),
    to: stringParam(req.query.to),
  };
}

function historyQueryFrom(
  deps: UsageRoutesDeps,
  user: AuthenticatedUser,
  req: Request,
): UsageHistoryQuery {
  return {
    userId: user.id,
    scope: resolveScope(deps, user, req.query.scope),
    ...filtersFrom(req),
    sessionId: stringParam(req.query.sessionId),
  };
}

/**
 * A CSV cell, quoted only when it needs to be.
 *
 * `null` becomes an empty string rather than `0`: an unreported figure and a
 * reported zero are different facts (see usage-records.ts), and this is the
 * one place that distinction would otherwise get flattened on the way out.
 */
function csvCell(value: string | number | boolean | null): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const EXPORT_COLUMNS = [
  'id',
  'sessionId',
  'nativeSessionId',
  'turnId',
  'userId',
  'userLogin',
  'agent',
  'model',
  'project',
  // Carried out of the app, not only shown inside it: someone reconciling a
  // per-project total against an invoice needs to see which rows were a
  // person's assertion rather than a recorded fact.
  'projectSource',
  'startedAt',
  'endedAt',
  'durationMs',
  'outcome',
  // One row is one turn, so there is no turn column to export — counting the
  // rows is the count (#86). This is the other quantity, and it is empty for
  // every runtime that does not report its own round trips.
  'modelTurns',
  'toolCalls',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
  'totalTokens',
  'costUsd',
  'reportsUsage',
  'reportsCost',
] as const;

export function createUsageRoutes(deps: UsageRoutesDeps): Router {
  const router = Router();

  router.get('/api/usage/dashboard', (req: Request, res: Response): void => {
    const user = requireUser(res);
    if (!user) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }

    const dashboard = deps.usageStore.dashboard(
      {
        userId: user.id,
        scope: resolveScope(deps, user, req.query.scope),
        period: parsePeriod(req.query.period),
        anchor: parseAnchor(req.query.anchor),
        tzOffsetMinutes: parseTz(req.query.tz),
        ...filtersFrom(req),
      },
      isInstaller(deps, user),
    );
    res.json(dashboard);
  });

  router.get('/api/usage/jobs', (req: Request, res: Response): void => {
    const user = requireUser(res);
    if (!user) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }

    const query = historyQueryFrom(deps, user, req);
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const offset = req.query.offset ? Number(req.query.offset) : undefined;
    const { jobs, total } = deps.usageStore.history({
      ...query,
      limit: Number.isFinite(limit) ? limit : undefined,
      offset: Number.isFinite(offset) ? offset : undefined,
    });
    res.json({ jobs, total });
  });

  /**
   * The conversations behind the figures — one entry per chat tab (#88).
   *
   * Same query string as `/jobs`, deliberately: the two are the same list at
   * two levels of detail, and a viewer who opens one conversation from the
   * other is looking at the same narrowing either way.
   */
  router.get('/api/usage/conversations', (req: Request, res: Response): void => {
    const user = requireUser(res);
    if (!user) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }

    const query = historyQueryFrom(deps, user, req);
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const offset = req.query.offset ? Number(req.query.offset) : undefined;
    const { conversations, total } = deps.usageStore.conversations({
      ...query,
      limit: Number.isFinite(limit) ? limit : undefined,
      offset: Number.isFinite(offset) ? offset : undefined,
    });
    res.json({ conversations, total });
  });

  router.get('/api/usage/jobs/:id', (req: Request, res: Response): void => {
    const user = requireUser(res);
    if (!user) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }

    const scope = resolveScope(deps, user, req.query.scope);
    const job = deps.usageStore.job(String(req.params.id), { userId: user.id, scope });
    if (!job) {
      // Not found and not-yours answer the same way, so a caller can't probe
      // for another user's job ids.
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json(job);
  });

  /**
   * Attribute a job — or every unattributed job in its conversation — to a
   * project by hand.
   *
   * The only write in this file, and the checks are stacked rather than
   * combined so each one fails for its own reason. The scope resolves the same
   * way every read does, so a viewer who cannot see a job cannot attribute it
   * either; the installer, who can already see everyone's figures, can also fix
   * anyone's missing attribution, which is the whole point of a management
   * view.
   *
   * The store refuses to overwrite an observed project, so this route does not
   * need to re-check that — but it does report how many rows actually changed,
   * because "nothing changed" is a real and useful answer here.
   */
  router.post('/api/usage/jobs/:id/project', (req: Request, res: Response): void => {
    const user = requireUser(res);
    if (!user) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }

    const scope = resolveScope(deps, user, req.query.scope ?? (req.body ?? {}).scope);
    const jobId = String(req.params.id);
    const job = deps.usageStore.job(jobId, { userId: user.id, scope });
    if (!job) {
      // Same answer as the read, for the same reason: not-found and not-yours
      // must be indistinguishable, or this becomes a way to probe for job ids.
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const body = (req.body ?? {}) as { project?: unknown; applyToSession?: unknown };
    if (body.project !== null && typeof body.project !== 'string') {
      res.status(400).json({
        error: 'invalid_project',
        message: 'project must be a string, or null to withdraw an attribution',
      });
      return;
    }

    // A name is what was typed with the whitespace taken off, and one that is
    // nothing but whitespace is not a name — it would group under a key that
    // renders as blank, which is the state the sentinel exists to avoid.
    // Capped for the same reason the session name is: this is a table cell.
    const project = body.project === null ? null : body.project.trim().slice(0, MAX_PROJECT_LENGTH);
    if (project === '') {
      res.status(400).json({
        error: 'empty_project',
        message: 'A project name cannot be blank. Send null to withdraw the attribution instead.',
      });
      return;
    }

    const updated = deps.usageStore.attributeProject(
      body.applyToSession ? { sessionId: job.sessionId } : { jobId },
      project,
      { userId: user.id, scope },
    );
    res.json({ updated, project });
  });

  router.get('/api/usage/facets', (req: Request, res: Response): void => {
    const user = requireUser(res);
    if (!user) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }

    const scope = resolveScope(deps, user, req.query.scope);
    res.json(deps.usageStore.facets({ userId: user.id, scope }));
  });

  router.get('/api/usage/export', (req: Request, res: Response): void => {
    const user = requireUser(res);
    if (!user) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }

    const query = historyQueryFrom(deps, user, req);
    const { jobs, truncated } = deps.usageStore.export(query);
    const format = req.query.format === 'json' ? 'json' : 'csv';
    const from = stringParam(req.query.from) ?? 'all';
    const to = stringParam(req.query.to) ?? 'all';

    // Said out loud rather than left to be noticed. An export that quietly
    // stops short reads as a complete answer, and someone would reconcile a
    // provider's bill against it.
    if (truncated) res.setHeader('X-Usage-Export-Truncated', 'true');

    if (format === 'json') {
      res.json(jobs);
      return;
    }

    const lines = [EXPORT_COLUMNS.join(',')];
    for (const job of jobs) {
      lines.push(
        EXPORT_COLUMNS.map((column) => csvCell(job[column] as string | number | boolean | null)).join(
          ',',
        ),
      );
    }
    const csv = lines.join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="usage-${sanitizeFilenamePart(from)}-${sanitizeFilenamePart(to)}.csv"`,
    );
    res.send(csv);
  });

  return router;
}

/**
 * `from`/`to` are ISO timestamps or the literal `all`; either can carry a
 * colon or slash that would otherwise leak into the Content-Disposition
 * header as a path-ish character.
 */
function sanitizeFilenamePart(value: string): string {
  return value.replace(/[^0-9A-Za-z-]/g, '');
}
