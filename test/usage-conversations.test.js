/**
 * Accounting per chat tab: one entry per conversation, not one per request (#88).
 *
 * The claim under test is not "the SQL groups by a column". It is that the
 * figure a person cares about — what this stretch of work cost — survives the
 * three things that used to break it into pieces: many requests, compacting,
 * and clearing or starting fresh inside the same tab.
 *
 * So the first tests drive a real `ChatSession` through real turns, including
 * the accounting boundary a `/clear` actually crosses (a flush and a new
 * accountant, with the runtime handing back a different conversation id), and
 * ask the store what it would show. Only the later ones write rows directly,
 * where the question really is about the shape of the query.
 */

const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AppDatabase } = require('../dist/server/services/database.js');
const { UsageStore } = require('../dist/server/services/usage-store.js');
const { UsageAccountant } = require('../dist/server/chat/usage-accounting.js');
const { createUsageRoutes } = require('../dist/server/routes/usage.js');
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

describe('usage is accounted per chat tab', function () {
  let dir;
  let database;
  let store;

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-conv-'));
    database = new AppDatabase({ dataDir: dir });
    store = new UsageStore(database);
  });

  afterEach(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('a tab that ran real turns', function () {
    let session;

    beforeEach(function () {
      session = new ChatSession(
        { id: 'tab-1', ownerUserId: 7 },
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
      session.cwd = '/srv/work/billing-api';
      session.capabilities = { usage: true, cost: true };
      session.accountant = new UsageAccountant((finished) => session.fileJob(finished));
    });

    /** One prompt and its answer, as the events a runtime really emits. */
    function runTurn(n, { nativeSessionId = 'conv-1', model = 'sonnet', cost = 0.4 } = {}) {
      for (const event of [
        { t: 'session', nativeSessionId, model, capabilities: {} },
        { t: 'msg_start', id: `u${n}`, role: 'user', turnId: `turn-${n}` },
        { t: 'msg_end', msgId: `u${n}` },
        { t: 'msg_start', id: `a${n}`, role: 'assistant', turnId: `turn-${n}` },
        { t: 'msg_end', msgId: `a${n}`, usage: { inputTokens: 100, outputTokens: 20 } },
        { t: 'turn_end', turnId: `turn-${n}`, usage: { costUsd: cost }, durationMs: 1000 },
      ]) {
        session.ingest(event);
      }
    }

    /**
     * The accounting boundary a `/clear`, a `/new` or a compaction crosses.
     *
     * Not a shortcut for the reset itself — it is the two lines `start()` runs
     * after `restart()` has replaced the process (session.ts): the open job is
     * flushed, a fresh accountant takes over, and the runtime hands back a
     * conversation id it has never used before. Everything else about the tab,
     * the id this whole feature is keyed on included, is untouched — which is
     * the point being tested.
     */
    function startFresh() {
      session.accountant.flush();
      session.accountant = new UsageAccountant((finished) => session.fileJob(finished));
    }

    it('shows a tab used many times as one entry, not one per request', function () {
      for (let n = 1; n <= 6; n += 1) runTurn(n);

      const { jobs } = store.history({ userId: 7, scope: 'self' });
      assert.strictEqual(jobs.length, 6, 'six requests were recorded');

      const { conversations, total } = store.conversations({ userId: 7, scope: 'self' });
      assert.strictEqual(total, 1);
      assert.strictEqual(conversations.length, 1);
      assert.strictEqual(conversations[0].sessionId, 'tab-1');
      assert.strictEqual(conversations[0].totals.jobs, 6);
    });

    it("adds up to everything spent in it", function () {
      for (let n = 1; n <= 4; n += 1) runTurn(n, { cost: 0.25 });

      const { jobs } = store.history({ userId: 7, scope: 'self' });
      const spent = jobs.reduce((sum, j) => sum + (j.costUsd ?? 0), 0);
      const tokens = jobs.reduce((sum, j) => sum + (j.totalTokens ?? 0), 0);

      const [conversation] = store.conversations({ userId: 7, scope: 'self' }).conversations;
      assert.ok(spent > 0, 'the turns cost something to begin with');
      assert.strictEqual(round(conversation.totals.costUsd), round(spent));
      assert.strictEqual(conversation.totals.totalTokens, tokens);
    });

    it('does not split the entry when the conversation is cleared and started fresh', function () {
      runTurn(1);
      runTurn(2);
      startFresh();
      runTurn(3, { nativeSessionId: 'conv-2' });
      runTurn(4, { nativeSessionId: 'conv-2' });

      const { jobs } = store.history({ userId: 7, scope: 'self' });
      // The reset really was modelled: the runtime's own id changed, which is
      // what a fresh conversation looks like from here.
      assert.deepStrictEqual(
        [...new Set(jobs.map((j) => j.nativeSessionId))].sort(),
        ['conv-1', 'conv-2'],
      );
      assert.deepStrictEqual([...new Set(jobs.map((j) => j.sessionId))], ['tab-1']);

      const { conversations, total } = store.conversations({ userId: 7, scope: 'self' });
      assert.strictEqual(total, 1, 'still one conversation, not one per reset');
      assert.strictEqual(conversations[0].totals.jobs, 4);
      assert.strictEqual(
        round(conversations[0].totals.costUsd),
        round(jobs.reduce((sum, j) => sum + (j.costUsd ?? 0), 0)),
        'the total carried across the reset rather than starting again',
      );
    });

    it('is honest about a conversation that changed model half way through', function () {
      runTurn(1, { model: 'sonnet' });
      runTurn(2, { model: 'opus' });

      const [conversation] = store.conversations({ userId: 7, scope: 'self' }).conversations;
      assert.deepStrictEqual(conversation.models, ['opus', 'sonnet']);
    });

    it('says when it started and when it was last used', function () {
      runTurn(1);
      runTurn(2);

      const { jobs } = store.history({ userId: 7, scope: 'self' });
      const started = jobs.map((j) => j.startedAt).sort();
      const ended = jobs.map((j) => j.endedAt).sort();

      const [conversation] = store.conversations({ userId: 7, scope: 'self' }).conversations;
      assert.strictEqual(conversation.startedAt, started[0]);
      assert.strictEqual(conversation.lastActiveAt, ended[ended.length - 1]);
      assert.deepStrictEqual(conversation.projects, ['billing-api']);
      assert.deepStrictEqual(conversation.agents, ['claude']);
    });
  });

  describe('the conversation list', function () {
    it('gathers what was already recorded, with nothing to backfill', function () {
      // Rows filed long before any of this existed. They carry the tab's id
      // because that column has always been written, which is the whole reason
      // there is no earlier period counted differently.
      store.record(job({ sessionId: 'old-tab', turnId: 'a' }));
      store.record(job({ sessionId: 'old-tab', turnId: 'b' }));

      const { conversations } = store.conversations({ userId: 1, scope: 'self' });
      assert.strictEqual(conversations.length, 1);
      assert.strictEqual(conversations[0].totals.jobs, 2);
    });

    it('agrees with the headline totals, with nothing counted twice or dropped', function () {
      store.record(job({ sessionId: 'a', turnId: '1', costUsd: 1, totalTokens: 10 }));
      store.record(job({ sessionId: 'a', turnId: '2', costUsd: 2, totalTokens: 20 }));
      store.record(job({ sessionId: 'b', turnId: '1', costUsd: 4, totalTokens: 40, agent: 'codex' }));

      const dashboard = store.dashboard(
        { userId: 1, scope: 'self', period: 'day', anchor: new Date('2024-01-15T12:00:00.000Z') },
        false,
      );
      const { conversations } = store.conversations({ userId: 1, scope: 'self' });
      const summed = conversations.reduce(
        (acc, c) => ({
          jobs: acc.jobs + c.totals.jobs,
          costUsd: acc.costUsd + c.totals.costUsd,
          totalTokens: acc.totalTokens + c.totals.totalTokens,
        }),
        { jobs: 0, costUsd: 0, totalTokens: 0 },
      );

      assert.strictEqual(summed.jobs, dashboard.totals.jobs);
      assert.strictEqual(round(summed.costUsd), round(dashboard.totals.costUsd));
      assert.strictEqual(summed.totalTokens, dashboard.totals.totalTokens);

      // And the breakdowns, which are the same rows grouped another way.
      const byAgent = dashboard.byAgent.reduce((sum, row) => sum + row.totals.jobs, 0);
      assert.strictEqual(byAgent, summed.jobs);
    });

    it('names a conversation the way its tab is named', function () {
      database.raw
        .prepare(`
          INSERT INTO users (
            id, github_id, github_login, created_at, updated_at, last_login_at
          ) VALUES (1, 'gh-1', 'installer', '', '', '')
        `)
        .run();
      database.raw
        .prepare(`
          INSERT INTO runtime_sessions (
            id, owner_user_id, name, custom_name, created_at, last_activity, active,
            working_dir, output_buffer_json, session_usage_json
          ) VALUES ('named-tab', 1, 'Session 3', 'Refactoring the parser', '', '', 0, '/srv/work/api', '[]', '{}')
        `)
        .run();
      store.record(job({ sessionId: 'named-tab' }));

      const [conversation] = store.conversations({ userId: 1, scope: 'self' }).conversations;
      assert.strictEqual(conversation.name, 'Refactoring the parser');
    });

    it('still lists a conversation whose tab has since been deleted', function () {
      // The case an inner join would silently swallow — and the exact set of
      // rows a permanent history exists for.
      store.record(job({ sessionId: 'long-gone' }));

      const [conversation] = store.conversations({ userId: 1, scope: 'self' }).conversations;
      assert.strictEqual(conversation.sessionId, 'long-gone');
      assert.strictEqual(conversation.name, null);
      assert.strictEqual(conversation.totals.jobs, 1);
    });

    it('is ordered by when each was last used', function () {
      store.record(job({ sessionId: 'stale', turnId: '1', endedAt: '2024-01-10T02:00:00.000Z' }));
      store.record(job({ sessionId: 'fresh', turnId: '1', endedAt: '2024-01-16T02:00:00.000Z' }));

      const { conversations } = store.conversations({ userId: 1, scope: 'self' });
      assert.deepStrictEqual(conversations.map((c) => c.sessionId), ['fresh', 'stale']);
    });

    it('takes the same narrowing the charts above it took', function () {
      store.record(job({ sessionId: 'a', turnId: '1', project: 'api' }));
      store.record(job({ sessionId: 'b', turnId: '1', project: 'www' }));

      const { conversations, total } = store.conversations({
        userId: 1,
        scope: 'self',
        project: 'www',
      });
      assert.strictEqual(total, 1);
      assert.deepStrictEqual(conversations.map((c) => c.sessionId), ['b']);
    });

    it('lists only what the narrowing it was asked for actually covers', function () {
      // One conversation, two projects, two agents. Narrowed to one project,
      // the entry must not go on claiming the agent it used on the other — its
      // figures are for the narrowed rows, and its labels have to be too.
      store.record(job({ sessionId: 'a', turnId: '1', project: 'api', agent: 'claude', model: 'sonnet' }));
      store.record(job({ sessionId: 'a', turnId: '2', project: 'www', agent: 'codex', model: 'gpt-5' }));

      const [wide] = store.conversations({ userId: 1, scope: 'self' }).conversations;
      assert.deepStrictEqual(wide.agents, ['claude', 'codex']);

      const [narrow] = store.conversations({ userId: 1, scope: 'self', project: 'api' }).conversations;
      assert.strictEqual(narrow.totals.jobs, 1);
      assert.deepStrictEqual(narrow.agents, ['claude']);
      assert.deepStrictEqual(narrow.models, ['sonnet']);
    });

    it('does not name another user’s agent on a conversation id it shares', function () {
      // Not a shape the app produces, and precisely why it is worth a test: the
      // scope has to be a parameter of every query, including the ones that
      // only fill in labels for a page of ids already fetched.
      store.record(job({ sessionId: 'shared', turnId: '1', userId: 1, agent: 'claude', model: 'sonnet' }));
      store.record(job({
        sessionId: 'shared', turnId: '2', userId: 2, userLogin: 'someone-else',
        agent: 'secret-agent', model: 'secret-model',
      }));

      const [mine] = store.conversations({ userId: 1, scope: 'self' }).conversations;
      assert.strictEqual(mine.totals.jobs, 1);
      assert.deepStrictEqual(mine.agents, ['claude']);
      assert.deepStrictEqual(mine.models, ['sonnet']);
    });

    it('does not show one user their colleagues conversations', function () {
      store.record(job({ sessionId: 'mine', userId: 1 }));
      store.record(job({ sessionId: 'theirs', userId: 2, userLogin: 'someone-else' }));

      const mine = store.conversations({ userId: 1, scope: 'self' });
      assert.deepStrictEqual(mine.conversations.map((c) => c.sessionId), ['mine']);
      const everyone = store.conversations({ userId: 1, scope: 'everyone' });
      assert.strictEqual(everyone.total, 2);
    });

    it('pages without repeating or losing a conversation that shares an instant', function () {
      // Same ended_at on every row, which is what makes an unstable sort show
      // one conversation twice and never show another.
      for (const id of ['s1', 's2', 's3', 's4']) store.record(job({ sessionId: id }));

      const first = store.conversations({ userId: 1, scope: 'self', limit: 2, offset: 0 });
      const second = store.conversations({ userId: 1, scope: 'self', limit: 2, offset: 2 });
      const seen = [...first.conversations, ...second.conversations].map((c) => c.sessionId);
      assert.strictEqual(first.total, 4);
      assert.deepStrictEqual([...seen].sort(), ['s1', 's2', 's3', 's4']);
    });
  });

  describe('over the wire', function () {
    let app;

    beforeEach(function () {
      app = express();
      app.use((_req, res, next) => {
        res.locals.authContext = { user: { id: 1, login: 'installer' }, authSessionId: null };
        next();
      });
      app.use(createUsageRoutes({ usageStore: store, getInstallerUserId: () => 1 }));
    });

    it('answers with one entry per conversation', async function () {
      store.record(job({ sessionId: 'tab-a', turnId: '1' }));
      store.record(job({ sessionId: 'tab-a', turnId: '2' }));
      store.record(job({ sessionId: 'tab-b', turnId: '1' }));

      const body = await get(app, '/api/usage/conversations?scope=self');
      assert.strictEqual(body.total, 2);
      assert.strictEqual(body.conversations.length, 2);
      assert.deepStrictEqual(
        body.conversations.map((c) => c.totals.jobs).sort(),
        [1, 2],
      );
    });

    it('opens a conversation onto the requests inside it', async function () {
      store.record(job({ sessionId: 'tab-a', turnId: '1' }));
      store.record(job({ sessionId: 'tab-a', turnId: '2' }));
      store.record(job({ sessionId: 'tab-b', turnId: '1' }));

      const body = await get(app, '/api/usage/jobs?scope=self&sessionId=tab-a');
      assert.strictEqual(body.total, 2);
      assert.deepStrictEqual([...new Set(body.jobs.map((j) => j.sessionId))], ['tab-a']);
    });

    it('refuses an unauthenticated caller', async function () {
      const bare = express();
      bare.use(createUsageRoutes({ usageStore: store, getInstallerUserId: () => 1 }));
      const status = await getStatus(bare, '/api/usage/conversations');
      assert.strictEqual(status, 401);
    });
  });
});

function round(value) {
  return Math.round(value * 1e6) / 1e6;
}

/** One GET against an express app, without pulling in a request library. */
function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function fetchFrom(app, url) {
  const server = await listen(app);
  try {
    const { port } = server.address();
    return await fetch(`http://127.0.0.1:${port}${url}`, { headers: { Accept: 'application/json' } });
  } finally {
    server.close();
  }
}

async function get(app, url) {
  const response = await fetchFrom(app, url);
  assert.strictEqual(response.status, 200, `${url} answered ${response.status}`);
  return response.json();
}

async function getStatus(app, url) {
  return (await fetchFrom(app, url)).status;
}
