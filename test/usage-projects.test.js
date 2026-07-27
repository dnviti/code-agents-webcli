/**
 * Per-project accounting, and the narrowing the dashboard drills with.
 *
 * Two claims are under test here and they are not the same one:
 *
 * 1. Work is attributed to the folder it ran in, and work that predates the
 *    column is attributed to nothing rather than to a guess.
 * 2. A narrowing reaches *every* panel. That is the claim most at risk: the
 *    totals, the trend, four breakdowns, two effort tables and two tool lists
 *    are ten queries, and a filter that reached nine of them would look
 *    entirely correct on screen while the tenth quietly answered a different
 *    question.
 */

const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AppDatabase } = require('../dist/server/services/database.js');
const { UsageStore } = require('../dist/server/services/usage-store.js');
const { createUsageRoutes } = require('../dist/server/routes/usage.js');
const { UNATTRIBUTED, projectNameFor } = require('../dist/shared/usage-records.js');
const { ChatSession } = require('../dist/server/chat/session.js');

function job(overrides = {}) {
  return {
    sessionId: 'sess-1',
    nativeSessionId: null,
    turnId: 't1',
    userId: 1,
    userLogin: 'installer',
    agent: 'claude',
    model: 'sonnet',
    project: 'api',
    startedAt: '2024-01-15T01:59:00.000Z',
    endedAt: '2024-01-15T02:00:00.000Z',
    durationMs: 60_000,
    outcome: 'completed',
    turns: 2,
    toolCalls: 3,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
    reasoningTokens: 0,
    totalTokens: 165,
    costUsd: 1.5,
    reportsUsage: true,
    reportsCost: true,
    tools: [],
    ...overrides,
  };
}

const ANCHOR = new Date('2024-01-15T12:00:00.000Z');

describe('the project a job ran in', function () {
  describe('naming', function () {
    it('is the last segment of the working directory', function () {
      assert.strictEqual(projectNameFor('/srv/work/api'), 'api');
    });

    it('does not split one project in two over a trailing slash', function () {
      assert.strictEqual(projectNameFor('/srv/work/api/'), projectNameFor('/srv/work/api'));
    });

    it('is null when there is no working directory to take it from', function () {
      assert.strictEqual(projectNameFor(''), null);
      assert.strictEqual(projectNameFor(null), null);
      assert.strictEqual(projectNameFor(undefined), null);
    });

    it('reports the filesystem root as itself rather than as nothing', function () {
      assert.strictEqual(projectNameFor('/'), '/');
    });
  });

  describe('recording', function () {
    let dir;
    let store;
    let session;

    beforeEach(function () {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-proj-'));
      store = new UsageStore(new AppDatabase({ dataDir: dir }));
      session = new ChatSession(
        { id: 'sess-1', ownerUserId: 7 },
        {
          store: {
            append: () => {},
            async stat() { return { firstSeq: 1, cursor: 0 }; },
            async read() { return { events: [], firstSeq: 1, from: 1, cursor: 0 }; },
          },
          socketDir: dir,
          hookScript: path.join(__dirname, '..', 'does-not-exist.js'),
          broadcast: () => {},
          resolveCommand: () => 'claude',
          usage: {
            record: (record) => store.record(record),
            consumedFor: () => ({}),
            costBaselineFor: () => null,
            loginFor: () => 'octocat',
          },
        },
      );
      session.runtime = 'claude';
      session.capabilities = { usage: true, cost: true };
      const { UsageAccountant } = require('../dist/server/chat/usage-accounting.js');
      session.accountant = new UsageAccountant((finished) => session.fileJob(finished));
    });

    afterEach(function () {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    function runOneTurn() {
      for (const event of [
        { t: 'session', nativeSessionId: 'conv-1', model: 'claude-sonnet-5', capabilities: {} },
        { t: 'msg_start', id: 'u1', role: 'user', turnId: 'turn-1' },
        { t: 'msg_end', msgId: 'u1' },
        { t: 'msg_start', id: 'a1', role: 'assistant', turnId: 'turn-1' },
        { t: 'msg_end', msgId: 'a1', usage: { inputTokens: 100, outputTokens: 20 } },
        { t: 'turn_end', turnId: 'turn-1', usage: { costUsd: 0.4 }, durationMs: 1000 },
      ]) {
        session.ingest(event);
      }
    }

    it('files the folder the session is pointed at, by name', function () {
      session.cwd = '/srv/work/billing-api';
      runOneTurn();
      const { jobs } = store.history({ userId: 7, scope: 'self' });
      assert.strictEqual(jobs.length, 1);
      assert.strictEqual(jobs[0].project, 'billing-api');
    });

    it('leaves the project unattributed when the session has no folder yet', function () {
      runOneTurn();
      const { jobs } = store.history({ userId: 7, scope: 'self' });
      assert.strictEqual(jobs[0].project, null);
    });
  });

  describe('an installation that predates the column', function () {
    let dir;

    beforeEach(function () {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-proj-migrate-'));
    });

    afterEach(function () {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('adds the column on the next boot and keeps the rows that were already there', function () {
      const first = new AppDatabase({ dataDir: dir });
      const store = new UsageStore(first);
      const userId = first.upsertGitHubUser({ githubId: '1000', githubLogin: 'installer' }).id;
      store.record(job({ turnId: 't1', userId, project: 'api' }));
      // Wind the schema back to what shipped before this feature. `record`
      // above wrote through the new one, so this is as close as a test can get
      // to a database that has been in use for months.
      first.raw.exec('DROP INDEX idx_usage_jobs_project');
      first.raw.exec('ALTER TABLE usage_jobs DROP COLUMN project');
      first.close();

      const second = new AppDatabase({ dataDir: dir });
      const reopened = new UsageStore(second);
      const { jobs, total } = reopened.history({ userId, scope: 'self' });
      assert.strictEqual(total, 1, 'the existing row must survive the migration');
      // Null, not a guess: nobody recorded where that work ran.
      assert.strictEqual(jobs[0].project, null);

      const body = reopened.dashboard(
        { userId, scope: 'self', period: 'day', anchor: ANCHOR, tzOffsetMinutes: 0 },
        false,
      );
      assert.strictEqual(body.byProject.length, 1);
      assert.strictEqual(body.byProject[0].key, UNATTRIBUTED);
      second.close();
    });
  });

  describe('reporting', function () {
    let dir;
    let database;
    let store;
    let installerId;
    let otherId;

    beforeEach(function () {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-proj-report-'));
      database = new AppDatabase({ dataDir: dir });
      store = new UsageStore(database);
      installerId = database.upsertGitHubUser({ githubId: '1000', githubLogin: 'installer' }).id;
      otherId = database.upsertGitHubUser({ githubId: '2000', githubLogin: 'other' }).id;

      // api: two jobs, one of them by another user and one with a different agent.
      store.record(job({ turnId: 't1', userId: installerId, project: 'api', costUsd: 1.5, tools: [{ tool: 'bash', calls: 2 }] }));
      store.record(
        job({
          turnId: 't2',
          userId: installerId,
          project: 'api',
          agent: 'codex',
          model: null,
          endedAt: '2024-01-15T03:00:00.000Z',
          costUsd: 0.5,
          tools: [{ tool: 'exec', calls: 4 }],
        }),
      );
      // web: one job, other user.
      store.record(
        job({
          turnId: 't3',
          userId: otherId,
          userLogin: 'other',
          project: 'web',
          endedAt: '2024-01-15T04:00:00.000Z',
          costUsd: 2,
          tools: [{ tool: 'bash', calls: 5 }],
        }),
      );
      // Recorded before the column existed: no project at all.
      store.record(
        job({
          turnId: 't4',
          userId: installerId,
          project: null,
          endedAt: '2024-01-15T05:00:00.000Z',
          costUsd: 0.25,
          tools: [{ tool: 'read', calls: 1 }],
        }),
      );
    });

    afterEach(function () {
      database.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const dashboard = (extra = {}) =>
      store.dashboard(
        { userId: installerId, scope: 'everyone', period: 'day', anchor: ANCHOR, tzOffsetMinutes: 0, ...extra },
        true,
      );

    it('breaks the range down by project', function () {
      const rows = dashboard().byProject;
      const byKey = Object.fromEntries(rows.map((r) => [r.key, r.totals]));
      assert.strictEqual(byKey.api.jobs, 2);
      assert.strictEqual(byKey.web.jobs, 1);
      assert.strictEqual(byKey[UNATTRIBUTED].jobs, 1);
    });

    it('groups work with no project under a key that is not blank', function () {
      const unknown = dashboard().byProject.find((r) => r.key === UNATTRIBUTED);
      // A blank key renders as a blank cell and, worse, cannot be sent back as
      // a filter: an empty query param is indistinguishable from an absent one.
      assert.ok(unknown, 'unattributed work must have a key of its own');
      assert.notStrictEqual(unknown.key, '');
    });

    it('adds up: the per-project totals are the overall total', function () {
      const body = dashboard();
      const summed = body.byProject.reduce((sum, row) => sum + row.totals.jobs, 0);
      const cost = body.byProject.reduce((sum, row) => sum + row.totals.costUsd, 0);
      assert.strictEqual(summed, body.totals.jobs);
      assert.strictEqual(Math.round(cost * 100), Math.round(body.totals.costUsd * 100));
    });

    it('narrows every panel to one project, not merely the breakdown', function () {
      const body = dashboard({ project: 'api' });
      assert.strictEqual(body.totals.jobs, 2);
      assert.strictEqual(body.totals.costUsd, 2);
      assert.strictEqual(body.byProject.length, 1);
      // The panels that would look right regardless, and so are the ones a
      // half-applied filter hides in.
      assert.deepStrictEqual(body.byAgent.map((r) => r.key).sort(), ['claude', 'codex']);
      assert.strictEqual(body.byUser.length, 1);
      assert.strictEqual(body.series.reduce((n, b) => n + b.totals.jobs, 0), 2);
      assert.strictEqual(body.effortByAgent.reduce((n, r) => n + r.jobs, 0), 2);
      assert.deepStrictEqual(body.topTools.map((t) => t.tool).sort(), ['bash', 'exec']);
    });

    it('narrows to the work nobody recorded a project for', function () {
      const body = dashboard({ project: UNATTRIBUTED });
      assert.strictEqual(body.totals.jobs, 1);
      assert.strictEqual(body.totals.costUsd, 0.25);
      assert.deepStrictEqual(body.topTools.map((t) => t.tool), ['read']);
    });

    it('echoes back what it narrowed to, so a client can trust the filter took', function () {
      assert.deepStrictEqual(dashboard({ project: 'api' }).filters, { project: 'api' });
      assert.deepStrictEqual(dashboard().filters, {});
    });

    it('combines a project with another dimension rather than replacing it', function () {
      const body = dashboard({ project: 'api', agent: 'codex' });
      assert.strictEqual(body.totals.jobs, 1);
      assert.strictEqual(body.totals.costUsd, 0.5);
    });

    it('keeps a project filter inside the viewer’s own scope', function () {
      // `web` is another user's work. Asked for by someone scoped to
      // themselves, it must come back empty rather than come back.
      const body = store.dashboard(
        { userId: installerId, scope: 'self', period: 'day', anchor: ANCHOR, tzOffsetMinutes: 0, project: 'web' },
        false,
      );
      assert.strictEqual(body.totals.jobs, 0);
    });

    it('offers only the projects the viewer may see in the filter menu', function () {
      const mine = store.facets({ userId: installerId, scope: 'self' });
      assert.deepStrictEqual(mine.projects, ['api']);
      const everyone = store.facets({ userId: installerId, scope: 'everyone' });
      assert.deepStrictEqual(everyone.projects, ['api', 'web']);
    });

    it('filters the job history by project too, so a total can be drilled into', function () {
      const { jobs, total } = store.history({ userId: installerId, scope: 'everyone', project: 'api' });
      assert.strictEqual(total, 2);
      assert.ok(jobs.every((j) => j.project === 'api'));
    });

    it('filters the job history to unattributed work', function () {
      const { total } = store.history({ userId: installerId, scope: 'everyone', project: UNATTRIBUTED });
      assert.strictEqual(total, 1);
    });
  });

  describe('narrowing to a window', function () {
    let dir;
    let database;
    let store;
    let userId;

    beforeEach(function () {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-proj-window-'));
      database = new AppDatabase({ dataDir: dir });
      store = new UsageStore(database);
      userId = database.upsertGitHubUser({ githubId: '1000', githubLogin: 'installer' }).id;
      store.record(job({ turnId: 't1', userId, endedAt: '2024-01-15T02:30:00.000Z', costUsd: 1 }));
      store.record(job({ turnId: 't2', userId, endedAt: '2024-01-15T09:30:00.000Z', costUsd: 2 }));
      store.record(job({ turnId: 't3', userId, endedAt: '2024-01-16T09:30:00.000Z', costUsd: 4 }));
    });

    afterEach(function () {
      database.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const dashboard = (extra = {}) =>
      store.dashboard({ userId, scope: 'self', period: 'month', anchor: ANCHOR, tzOffsetMinutes: 0, ...extra }, false);

    it('buckets an unnarrowed period exactly as it always did', function () {
      const body = dashboard();
      assert.strictEqual(body.bucket, 'day');
      assert.strictEqual(body.series.length, 31);
      assert.strictEqual(body.totals.jobs, 3);
    });

    it('re-buckets a day-wide window into hours, so a selection can be drilled again', function () {
      const body = dashboard({ from: '2024-01-15T00:00:00.000Z', to: '2024-01-16T00:00:00.000Z' });
      assert.strictEqual(body.bucket, 'hour');
      assert.strictEqual(body.series.length, 24);
      assert.strictEqual(body.totals.jobs, 2);
      assert.strictEqual(body.totals.costUsd, 3);
    });

    it('narrows to a single hour', function () {
      const body = dashboard({ from: '2024-01-15T09:00:00.000Z', to: '2024-01-15T10:00:00.000Z' });
      assert.strictEqual(body.series.length, 1);
      assert.strictEqual(body.totals.jobs, 1);
      assert.strictEqual(body.totals.costUsd, 2);
    });

    it('ignores half a window rather than inventing the other end', function () {
      // One end alone would be a range decided by two different mechanisms —
      // which reads correctly right up until a month boundary.
      const body = dashboard({ from: '2024-01-15T00:00:00.000Z' });
      assert.strictEqual(body.series.length, 31);
      assert.strictEqual(body.totals.jobs, 3);
    });

    it('ignores a window that ends before it starts', function () {
      const body = dashboard({ from: '2024-01-16T00:00:00.000Z', to: '2024-01-15T00:00:00.000Z' });
      assert.strictEqual(body.totals.jobs, 3);
    });

    it('reports the window it actually used, not the one it was handed', function () {
      const body = dashboard({ from: '2024-01-15T00:00:00.000Z', to: '2024-01-16T00:00:00.000Z' });
      assert.strictEqual(body.from, '2024-01-15T00:00:00.000Z');
      assert.strictEqual(body.to, '2024-01-16T00:00:00.000Z');
    });

    it('does not echo back a window it decided to ignore', function () {
      // The client draws a "clear this" control from the echo. Advertising a
      // narrowing that was never applied is worse than offering no control.
      assert.strictEqual(dashboard({ from: '2024-01-15T00:00:00.000Z' }).filters.from, undefined);
      assert.strictEqual(
        dashboard({ from: '2024-01-16T00:00:00.000Z', to: '2024-01-15T00:00:00.000Z' }).filters.to,
        undefined,
      );
    });

    it('echoes the window it did apply', function () {
      const body = dashboard({ from: '2024-01-15T00:00:00.000Z', to: '2024-01-16T00:00:00.000Z' });
      assert.strictEqual(body.filters.from, '2024-01-15T00:00:00.000Z');
      assert.strictEqual(body.filters.to, '2024-01-16T00:00:00.000Z');
    });

    it('refuses to draw an unbounded number of bars for an absurd window', function () {
      const body = dashboard({ from: '1970-01-01T00:00:00.000Z', to: '3000-01-01T00:00:00.000Z' });
      assert.ok(body.series.length <= 800, `${body.series.length} buckets is a smear, not a chart`);
    });
  });

  describe('attributing by hand', function () {
    let dir;
    let database;
    let store;
    let mine;
    let theirs;

    beforeEach(function () {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-proj-manual-'));
      database = new AppDatabase({ dataDir: dir });
      store = new UsageStore(database);
      mine = database.upsertGitHubUser({ githubId: '1000', githubLogin: 'installer' }).id;
      theirs = database.upsertGitHubUser({ githubId: '2000', githubLogin: 'other' }).id;

      // One conversation, three jobs: two nobody recorded a folder for, and one
      // that was observed running in `api`.
      store.record(job({ sessionId: 's1', turnId: 't1', userId: mine, project: null }));
      store.record(job({ sessionId: 's1', turnId: 't2', userId: mine, project: null }));
      store.record(job({ sessionId: 's1', turnId: 't3', userId: mine, project: 'api' }));
      // Somebody else's unattributed work.
      store.record(job({ sessionId: 's2', turnId: 't4', userId: theirs, userLogin: 'other', project: null }));
    });

    afterEach(function () {
      database.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const jobById = (id) => store.job(id, { userId: mine, scope: 'everyone' });

    it('records what was observed as observed, and nothing as nothing', function () {
      assert.strictEqual(jobById('s1:t3').projectSource, 'observed');
      assert.strictEqual(jobById('s1:t1').projectSource, null);
    });

    it('attributes one job, and says it was a person who did it', function () {
      const updated = store.attributeProject({ jobId: 's1:t1' }, 'billing', { userId: mine, scope: 'self' });
      assert.strictEqual(updated, 1);
      const record = jobById('s1:t1');
      assert.strictEqual(record.project, 'billing');
      assert.strictEqual(record.projectSource, 'manual');
      // And only that one.
      assert.strictEqual(jobById('s1:t2').project, null);
    });

    it('attributes a whole conversation without touching what was observed', function () {
      const updated = store.attributeProject({ sessionId: 's1' }, 'billing', { userId: mine, scope: 'self' });
      // Two, not three: the observed job is a measurement and is left alone.
      assert.strictEqual(updated, 2);
      assert.strictEqual(jobById('s1:t1').project, 'billing');
      assert.strictEqual(jobById('s1:t2').project, 'billing');
      assert.strictEqual(jobById('s1:t3').project, 'api');
      assert.strictEqual(jobById('s1:t3').projectSource, 'observed');
    });

    it('refuses to overwrite an observed project even when named directly', function () {
      const updated = store.attributeProject({ jobId: 's1:t3' }, 'billing', { userId: mine, scope: 'self' });
      assert.strictEqual(updated, 0, 'a measurement is not editable');
      assert.strictEqual(jobById('s1:t3').project, 'api');
    });

    it('lets a hand-made attribution be corrected — a typo must not be permanent', function () {
      store.attributeProject({ jobId: 's1:t1' }, 'biling', { userId: mine, scope: 'self' });
      const updated = store.attributeProject({ jobId: 's1:t1' }, 'billing', { userId: mine, scope: 'self' });
      assert.strictEqual(updated, 1);
      assert.strictEqual(jobById('s1:t1').project, 'billing');
    });

    it('lets a hand-made attribution be withdrawn, back to unattributed', function () {
      store.attributeProject({ jobId: 's1:t1' }, 'billing', { userId: mine, scope: 'self' });
      const updated = store.attributeProject({ jobId: 's1:t1' }, null, { userId: mine, scope: 'self' });
      assert.strictEqual(updated, 1);
      const record = jobById('s1:t1');
      assert.strictEqual(record.project, null);
      // Not "manually attributed to nothing" — a source with no project is a
      // state nothing else knows how to read.
      assert.strictEqual(record.projectSource, null);
    });

    it('will not attribute another person’s work when scoped to your own', function () {
      const updated = store.attributeProject({ jobId: 's2:t4' }, 'billing', { userId: mine, scope: 'self' });
      assert.strictEqual(updated, 0);
      assert.strictEqual(jobById('s2:t4').project, null);
    });

    it('will not attribute another person’s conversation when scoped to your own', function () {
      const updated = store.attributeProject({ sessionId: 's2' }, 'billing', { userId: mine, scope: 'self' });
      assert.strictEqual(updated, 0);
    });

    it('refuses a target it was not given, rather than attributing everything', function () {
      const updated = store.attributeProject({}, 'billing', { userId: mine, scope: 'everyone' });
      assert.strictEqual(updated, 0);
      assert.strictEqual(jobById('s1:t1').project, null);
      assert.strictEqual(jobById('s2:t4').project, null);
    });

    it('counts hand-attributed work into the breakdown it was assigned to', function () {
      store.attributeProject({ sessionId: 's1' }, 'billing', { userId: mine, scope: 'self' });
      const body = store.dashboard(
        { userId: mine, scope: 'self', period: 'day', anchor: ANCHOR, tzOffsetMinutes: 0 },
        false,
      );
      const billing = body.byProject.find((r) => r.key === 'billing');
      assert.strictEqual(billing.totals.jobs, 2);
      assert.ok(!body.byProject.some((r) => r.key === UNATTRIBUTED), 'nothing left unattributed');
      // And the whole thing still adds up.
      assert.strictEqual(
        body.byProject.reduce((n, r) => n + r.totals.jobs, 0),
        body.totals.jobs,
      );
    });

    it('is filterable exactly like an observed one', function () {
      store.attributeProject({ jobId: 's1:t1' }, 'billing', { userId: mine, scope: 'self' });
      const { total } = store.history({ userId: mine, scope: 'self', project: 'billing' });
      assert.strictEqual(total, 1);
    });
  });

  describe('attributing by hand, over the routes', function () {
    let dir;
    let database;
    let store;
    let server;
    let baseUrl;
    let currentUser;
    let installerId;
    let otherId;

    beforeEach(async function () {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-proj-manual-routes-'));
      database = new AppDatabase({ dataDir: dir });
      store = new UsageStore(database);
      installerId = database.upsertGitHubUser({ githubId: '1000', githubLogin: 'installer' }).id;
      otherId = database.upsertGitHubUser({ githubId: '2000', githubLogin: 'other' }).id;
      store.record(job({ sessionId: 's1', turnId: 't1', userId: installerId, project: null }));
      store.record(job({ sessionId: 's1', turnId: 't2', userId: installerId, project: null }));
      store.record(job({ sessionId: 's2', turnId: 't3', userId: otherId, userLogin: 'other', project: null }));
      currentUser = { id: installerId, githubId: '1000', githubLogin: 'installer', githubName: null, avatarUrl: null, email: null };

      const app = express();
      app.use(express.json());
      app.use((_req, res, next) => {
        res.locals.authContext = { user: currentUser, authSessionId: null };
        next();
      });
      app.use(createUsageRoutes({ usageStore: store, getInstallerUserId: () => database.getInstallerUserId() }));
      await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
      baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    afterEach(async function () {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      database.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const attribute = (id, body, query = '') =>
      fetch(`${baseUrl}/api/usage/jobs/${encodeURIComponent(id)}/project${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    it('attributes a job over the wire', async function () {
      const response = await attribute('s1:t1', { project: 'billing' });
      assert.strictEqual(response.status, 200);
      const body = await response.json();
      assert.strictEqual(body.updated, 1);
      assert.strictEqual(body.project, 'billing');
    });

    it('attributes the whole conversation when asked to', async function () {
      const body = await (await attribute('s1:t1', { project: 'billing', applyToSession: true })).json();
      assert.strictEqual(body.updated, 2);
    });

    it('requires a signed-in user', async function () {
      currentUser = null;
      assert.strictEqual((await attribute('s1:t1', { project: 'billing' })).status, 401);
    });

    it('answers 404 for another person’s job, the same as reading it does', async function () {
      // Not 403: a distinguishable refusal is a way to probe for job ids.
      currentUser = { id: otherId, githubId: '2000', githubLogin: 'other', githubName: null, avatarUrl: null, email: null };
      assert.strictEqual((await attribute('s1:t1', { project: 'billing' })).status, 404);
      assert.strictEqual(store.job('s1:t1', { userId: installerId, scope: 'self' }).project, null);
    });

    it('refuses a blank name rather than creating a project called nothing', async function () {
      const response = await attribute('s1:t1', { project: '   ' });
      assert.strictEqual(response.status, 400);
      assert.strictEqual((await response.json()).error, 'empty_project');
    });

    it('refuses a project that is not a string', async function () {
      assert.strictEqual((await attribute('s1:t1', { project: 42 })).status, 400);
    });

    it('trims what was typed', async function () {
      await attribute('s1:t1', { project: '  billing  ' });
      assert.strictEqual(store.job('s1:t1', { userId: installerId, scope: 'self' }).project, 'billing');
    });

    it('caps a name at a length a table cell can hold', async function () {
      await attribute('s1:t1', { project: 'x'.repeat(500) });
      assert.strictEqual(store.job('s1:t1', { userId: installerId, scope: 'self' }).project.length, 120);
    });

    it('withdraws an attribution when sent null', async function () {
      await attribute('s1:t1', { project: 'billing' });
      const body = await (await attribute('s1:t1', { project: null })).json();
      assert.strictEqual(body.updated, 1);
      assert.strictEqual(store.job('s1:t1', { userId: installerId, scope: 'self' }).project, null);
    });

    it('lets the installer fix somebody else’s missing attribution', async function () {
      const body = await (await attribute('s2:t3', { project: 'billing' }, '?scope=everyone')).json();
      assert.strictEqual(body.updated, 1);
    });

    it('does not let a non-installer reach everyone by asking for it', async function () {
      currentUser = { id: otherId, githubId: '2000', githubLogin: 'other', githubName: null, avatarUrl: null, email: null };
      // `s1:t1` is the installer's. Asking for the wide scope resolves back to
      // this user's own, so the job is simply not theirs to see.
      assert.strictEqual((await attribute('s1:t1', { project: 'x' }, '?scope=everyone')).status, 404);
    });

    it('carries the provenance into the export, so a hand-made figure is legible as one', async function () {
      await attribute('s1:t1', { project: 'billing' });
      const csv = await (await fetch(`${baseUrl}/api/usage/export`)).text();
      const [header, ...rows] = csv.trim().split('\n');
      const column = header.split(',').indexOf('projectSource');
      assert.ok(column >= 0, header);
      assert.ok(rows.some((r) => r.split(',')[column] === 'manual'), rows.join(' | '));
    });
  });

  describe('over the routes', function () {
    let dir;
    let database;
    let store;
    let server;
    let baseUrl;
    let currentUser;

    beforeEach(async function () {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-proj-routes-'));
      database = new AppDatabase({ dataDir: dir });
      store = new UsageStore(database);
      const installer = database.upsertGitHubUser({ githubId: '1000', githubLogin: 'installer' });
      store.record(job({ turnId: 't1', userId: installer.id, project: 'api', costUsd: 1.5 }));
      store.record(
        job({ turnId: 't2', userId: installer.id, project: 'web', endedAt: '2024-01-15T03:00:00.000Z', costUsd: 2 }),
      );
      store.record(
        job({ turnId: 't3', userId: installer.id, project: null, endedAt: '2024-01-15T04:00:00.000Z', costUsd: 4 }),
      );
      currentUser = { id: installer.id, githubId: '1000', githubLogin: 'installer', githubName: null, avatarUrl: null, email: null };

      const app = express();
      app.use((_req, res, next) => {
        res.locals.authContext = { user: currentUser, authSessionId: null };
        next();
      });
      app.use(createUsageRoutes({ usageStore: store, getInstallerUserId: () => database.getInstallerUserId() }));
      await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
      baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    afterEach(async function () {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      database.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const get = (url) => fetch(`${baseUrl}${url}`);

    it('narrows the dashboard from the query string', async function () {
      const body = await (
        await get('/api/usage/dashboard?period=day&anchor=2024-01-15T12:00:00.000Z&project=api')
      ).json();
      assert.strictEqual(body.totals.jobs, 1);
      assert.strictEqual(body.filters.project, 'api');
    });

    it('narrows the job list from the same query string', async function () {
      const body = await (await get('/api/usage/jobs?project=web')).json();
      assert.strictEqual(body.total, 1);
      assert.strictEqual(body.jobs[0].project, 'web');
    });

    it('carries the project into the export, and the filter with it', async function () {
      const response = await get('/api/usage/export?project=api');
      const csv = await response.text();
      const [header, ...rows] = csv.trim().split('\n');
      assert.ok(header.split(',').includes('project'), header);
      assert.strictEqual(rows.length, 1);
      assert.ok(rows[0].split(',').includes('api'), rows[0]);
    });

    it('exports a job with no project as blank, never as a project called something', async function () {
      const csv = await (await get('/api/usage/export')).text();
      const [header, ...rows] = csv.trim().split('\n');
      const column = header.split(',').indexOf('project');
      const unattributed = rows.map((r) => r.split(',')[column]).filter((v) => v === '');
      assert.strictEqual(unattributed.length, 1);
    });

    it('has a sentinel that a URL, a JSON body and a CSV cell can all carry', function () {
      // The first version of this was a leading control character, which is a
      // thing each of those three mangles differently — and which every test
      // that compared the constant against itself was blind to.
      assert.ok(!/[\u0000-\u001f]/.test(UNATTRIBUTED), 'no control characters');
      assert.strictEqual(new URLSearchParams({ project: UNATTRIBUTED }).get('project'), UNATTRIBUTED);
      assert.strictEqual(JSON.parse(JSON.stringify({ p: UNATTRIBUTED })).p, UNATTRIBUTED);
    });

    it('cannot collide with a real project name', function () {
      // A project is a path's last segment, so it can never contain a separator.
      assert.ok(UNATTRIBUTED.includes('/'));
      assert.notStrictEqual(projectNameFor('/srv/work' + UNATTRIBUTED), UNATTRIBUTED);
    });

    it('round-trips the unattributed sentinel through a query string', async function () {
      // If either end of that encoding ever stopped agreeing, the filter would
      // silently match nothing while the row that offered it went on looking
      // selectable.
      const params = new URLSearchParams({ project: UNATTRIBUTED });
      const body = await (await get(`/api/usage/jobs?${params.toString()}`)).json();
      assert.strictEqual(body.total, 1);
      assert.strictEqual(body.jobs[0].project, null);
    });

    it('lists the projects it knows about as facets', async function () {
      const body = await (await get('/api/usage/facets')).json();
      assert.deepStrictEqual(body.projects, ['api', 'web']);
    });

    it('narrows to an explicit window over the wire', async function () {
      const body = await (
        await get(
          '/api/usage/dashboard?period=day&anchor=2024-01-15T12:00:00.000Z'
            + '&from=2024-01-15T03:00:00.000Z&to=2024-01-15T04:00:00.000Z',
        )
      ).json();
      assert.strictEqual(body.totals.jobs, 1);
      assert.strictEqual(body.totals.costUsd, 2);
    });
  });
});
