const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createUsageRoutes } = require('../dist/server/routes/usage.js');
const { AppDatabase } = require('../dist/server/services/database.js');
const { UsageStore } = require('../dist/server/services/usage-store.js');

function job(overrides = {}) {
  return {
    sessionId: 'sess-1',
    nativeSessionId: null,
    turnId: 't1',
    userId: 1,
    userLogin: 'installer',
    agent: 'claude',
    model: 'sonnet',
    startedAt: '2024-01-15T01:59:00.000Z',
    endedAt: '2024-01-15T02:00:00.000Z',
    durationMs: 60_000,
    outcome: 'completed',
    modelTurns: 2,
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

describe('usage routes', function () {
  let dir;
  let database;
  let usageStore;
  let server;
  let baseUrl;
  let currentUser;
  let installerId;
  let otherId;

  const ANCHOR = '2024-01-15T12:00:00.000Z';

  beforeEach(async function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-usage-routes-'));
    database = new AppDatabase({ dataDir: dir });
    usageStore = new UsageStore(database);

    const installer = database.upsertGitHubUser({ githubId: '1000', githubLogin: 'installer' });
    const other = database.upsertGitHubUser({ githubId: '2000', githubLogin: 'other' });
    installerId = installer.id;
    otherId = other.id;

    // Job 1: installer, agent claude, tools bash x2 + read x1, cost reported.
    usageStore.record(
      job({
        turnId: 't1',
        userId: installerId,
        userLogin: 'installer',
        agent: 'claude',
        model: 'sonnet',
        endedAt: '2024-01-15T02:00:00.000Z',
        costUsd: 1.5,
        tools: [
          { tool: 'bash', calls: 2 },
          { tool: 'read', calls: 1 },
        ],
      }),
    );

    // Job 2: installer, agent codex, cost NOT reported (null), tool exec x4.
    usageStore.record(
      job({
        turnId: 't2',
        userId: installerId,
        userLogin: 'installer',
        agent: 'codex',
        model: null,
        endedAt: '2024-01-15T03:00:00.000Z',
        modelTurns: 1,
        toolCalls: 4,
        costUsd: null,
        reportsCost: false,
        tools: [{ tool: 'exec', calls: 4 }],
      }),
    );

    // Job 3: other user, agent claude, tools bash x5, cost reported.
    usageStore.record(
      job({
        turnId: 't3',
        userId: otherId,
        userLogin: 'other',
        agent: 'claude',
        model: 'sonnet',
        endedAt: '2024-01-15T04:00:00.000Z',
        costUsd: 2.0,
        tools: [{ tool: 'bash', calls: 5 }],
      }),
    );

    currentUser = { id: installerId, githubId: '1000', githubLogin: 'installer', githubName: null, avatarUrl: null, email: null };

    const app = express();
    app.use(express.json());
    app.use((_req, res, next) => {
      res.locals.authContext = { user: currentUser, authSessionId: null };
      next();
    });
    app.use(
      createUsageRoutes({
        usageStore,
        getInstallerUserId: () => database.getInstallerUserId(),
      }),
    );

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async function () {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function asOther() {
    currentUser = { id: otherId, githubId: '2000', githubLogin: 'other', githubName: null, avatarUrl: null, email: null };
  }

  function get(url) {
    return fetch(`${baseUrl}${url}`);
  }

  it('requires a signed-in user on every route', async function () {
    currentUser = null;
    assert.strictEqual((await get('/api/usage/dashboard')).status, 401);
    assert.strictEqual((await get('/api/usage/jobs')).status, 401);
    assert.strictEqual((await get('/api/usage/jobs/anything')).status, 401);
    assert.strictEqual((await get('/api/usage/facets')).status, 401);
    assert.strictEqual((await get('/api/usage/export')).status, 401);
  });

  it('defaults to the caller\'s own jobs on the dashboard', async function () {
    const body = await (await get(`/api/usage/dashboard?period=day&anchor=${ANCHOR}`)).json();
    assert.strictEqual(body.scope, 'self');
    assert.strictEqual(body.totals.turns, 2);
    assert.strictEqual(body.totals.costUsd, 1.5);
    assert.strictEqual(body.totals.costReportedTurns, 1);
    assert.strictEqual(body.byUser, undefined);
  });

  it('lets the installer see everyone when asked', async function () {
    const body = await (
      await get(`/api/usage/dashboard?period=day&anchor=${ANCHOR}&scope=everyone`)
    ).json();
    assert.strictEqual(body.scope, 'everyone');
    assert.strictEqual(body.canSeeEveryone, true);
    assert.strictEqual(body.totals.turns, 3);
    assert.strictEqual(round2(body.totals.costUsd), 3.5);
    assert.ok(Array.isArray(body.byUser));
    assert.strictEqual(body.byUser.length, 2);
  });

  it('silently downgrades a non-installer asking for everyone', async function () {
    asOther();
    const body = await (
      await get(`/api/usage/dashboard?period=day&anchor=${ANCHOR}&scope=everyone`)
    ).json();
    assert.strictEqual(body.scope, 'self');
    assert.strictEqual(body.canSeeEveryone, false);
    assert.strictEqual(body.totals.turns, 1);
    assert.strictEqual(body.totals.costUsd, 2);
    assert.strictEqual(body.byUser, undefined);
  });

  it('gets the period totals and series right for the seeded rows', async function () {
    const body = await (
      await get(`/api/usage/dashboard?period=day&anchor=${ANCHOR}&scope=everyone`)
    ).json();
    assert.strictEqual(body.from, '2024-01-15T00:00:00.000Z');
    assert.strictEqual(body.to, '2024-01-16T00:00:00.000Z');
    assert.strictEqual(body.series.length, 24);

    const bucket02 = body.series.find((b) => b.key === '2024-01-15T02:00');
    const bucket03 = body.series.find((b) => b.key === '2024-01-15T03:00');
    const bucket04 = body.series.find((b) => b.key === '2024-01-15T04:00');
    const bucket05 = body.series.find((b) => b.key === '2024-01-15T05:00');
    assert.strictEqual(bucket02.totals.turns, 1);
    assert.strictEqual(bucket02.totals.costUsd, 1.5);
    assert.strictEqual(bucket03.totals.turns, 1);
    assert.strictEqual(bucket03.totals.costReportedTurns, 0);
    assert.strictEqual(bucket04.totals.turns, 1);
    assert.strictEqual(bucket04.totals.costUsd, 2);
    assert.strictEqual(bucket05.totals.turns, 0);
  });

  it('surfaces top tools, and differing per-agent tool counts', async function () {
    const body = await (
      await get(`/api/usage/dashboard?period=day&anchor=${ANCHOR}&scope=everyone`)
    ).json();

    const bash = body.topTools.find((t) => t.tool === 'bash');
    assert.strictEqual(bash.calls, 7); // 2 (installer/claude) + 5 (other/claude)
    const exec = body.topTools.find((t) => t.tool === 'exec');
    assert.strictEqual(exec.calls, 4);

    const claudeBash = body.topToolsByAgent.find((t) => t.tool === 'bash' && t.agent === 'claude');
    const codexExec = body.topToolsByAgent.find((t) => t.tool === 'exec' && t.agent === 'codex');
    assert.strictEqual(claudeBash.calls, 7);
    assert.strictEqual(codexExec.calls, 4);
    // The two agents' tool counts must not bleed into each other.
    assert.strictEqual(
      body.topToolsByAgent.find((t) => t.tool === 'exec' && t.agent === 'claude'),
      undefined,
    );
  });

  it('lists only the caller\'s own jobs by default', async function () {
    const body = await (await get('/api/usage/jobs')).json();
    assert.strictEqual(body.total, 2);
    assert.ok(body.jobs.every((j) => j.userId === installerId));
  });

  it('downgrades a non-installer\'s scope=everyone on the job list too', async function () {
    asOther();
    const body = await (await get('/api/usage/jobs?scope=everyone')).json();
    assert.strictEqual(body.total, 1);
    assert.ok(body.jobs.every((j) => j.userId === otherId));
  });

  it('fetches a single job with its tools', async function () {
    const body = await (await get(`/api/usage/jobs/sess-1:t1`)).json();
    assert.strictEqual(body.id, 'sess-1:t1');
    assert.ok(Array.isArray(body.tools));
    assert.strictEqual(body.tools.length, 2);
  });

  it('404s for another user\'s job id', async function () {
    asOther();
    const response = await get(`/api/usage/jobs/sess-1:t1`);
    assert.strictEqual(response.status, 404);
    assert.strictEqual((await response.json()).error, 'not_found');
  });

  it('404s for a job id that does not exist at all', async function () {
    const response = await get(`/api/usage/jobs/does-not-exist`);
    assert.strictEqual(response.status, 404);
  });

  it('reports the facets for the caller\'s own scope', async function () {
    const body = await (await get('/api/usage/facets')).json();
    assert.deepStrictEqual(body.agents, ['claude', 'codex']);
    assert.deepStrictEqual(body.models, ['sonnet']);
  });

  it('does not leak facets from another user to a non-installer', async function () {
    asOther();
    const body = await (await get('/api/usage/facets?scope=everyone')).json();
    assert.deepStrictEqual(body.agents, ['claude']);
  });

  it('exports CSV with a null cost as an empty cell, never zero', async function () {
    const response = await get('/api/usage/export?format=csv');
    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get('content-type').startsWith('text/csv'));
    assert.ok(response.headers.get('content-disposition').includes('usage-'));
    const text = await response.text();
    const lines = text.trim().split('\n');
    const header = lines[0].split(',');
    const costIndex = header.indexOf('costUsd');
    const row2 = lines.find((line) => line.includes('sess-1:t2'));
    const cells = row2.split(',');
    assert.strictEqual(cells[costIndex], '');
    const row1 = lines.find((line) => line.includes('sess-1:t1'));
    assert.strictEqual(row1.split(',')[costIndex], '1.5');
  });

  it('never exports another user\'s rows to a non-installer, even with scope=everyone', async function () {
    asOther();
    const response = await get('/api/usage/export?format=csv&scope=everyone');
    const text = await response.text();
    assert.ok(!text.includes('sess-1:t1'));
    assert.ok(!text.includes('sess-1:t2'));
    assert.ok(text.includes('sess-1:t3'));
  });

  it('honours the agent, model and session filters on export, like history does', async function () {
    const byAgent = await (await get('/api/usage/export?format=json&scope=everyone&agent=codex')).json();
    assert.deepStrictEqual(byAgent.map((row) => row.id), ['sess-1:t2']);

    const byModel = await (await get('/api/usage/export?format=json&scope=everyone&model=sonnet')).json();
    assert.deepStrictEqual(byModel.map((row) => row.id), ['sess-1:t1', 'sess-1:t3']);

    const bySession = await (await get('/api/usage/export?format=json&sessionId=sess-nope')).json();
    assert.deepStrictEqual(bySession, []);
  });

  it('exports JSON when asked', async function () {
    const response = await get('/api/usage/export?format=json&scope=everyone');
    const body = await response.json();
    assert.strictEqual(body.length, 3);
  });
});

function round2(value) {
  return Math.round(value * 100) / 100;
}
