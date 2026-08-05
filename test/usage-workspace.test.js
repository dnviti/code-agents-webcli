const assert = require('assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { SessionStore } = require('../dist/server/services/session-store.js');
const { UsageStore } = require('../dist/server/services/usage-store.js');
const { WorkspaceUsageCoordinator } = require('../dist/server/services/workspace-usage-coordinator.js');

function job(sessionId, turnId, overrides = {}) {
  const endedAt = overrides.endedAt || '2026-08-05T10:00:00.000Z';
  return {
    sessionId,
    nativeSessionId: overrides.nativeSessionId ?? `native-${sessionId}`,
    turnId,
    userId: overrides.userId ?? 1,
    userLogin: overrides.userLogin ?? `user-${overrides.userId ?? 1}`,
    agent: overrides.agent ?? 'claude',
    model: overrides.model === undefined ? 'test-model' : overrides.model,
    project: overrides.project ?? null,
    startedAt: overrides.startedAt || endedAt,
    endedAt,
    durationMs: overrides.durationMs ?? 1,
    outcome: overrides.outcome ?? 'completed',
    modelTurns: overrides.modelTurns === undefined ? 1 : overrides.modelTurns,
    toolCalls: overrides.toolCalls ?? 0,
    inputTokens: overrides.inputTokens === undefined ? 2 : overrides.inputTokens,
    outputTokens: overrides.outputTokens === undefined ? 3 : overrides.outputTokens,
    cacheReadTokens: overrides.cacheReadTokens ?? null,
    cacheWriteTokens: overrides.cacheWriteTokens ?? null,
    reasoningTokens: overrides.reasoningTokens ?? null,
    totalTokens: overrides.totalTokens === undefined ? 5 : overrides.totalTokens,
    costUsd: overrides.costUsd === undefined ? 0.01 : overrides.costUsd,
    reportsUsage: overrides.reportsUsage ?? true,
    reportsCost: overrides.reportsCost ?? true,
    tools: overrides.tools ?? [],
    models: overrides.models ?? [],
  };
}

async function workspacePair(options = {}) {
  const firstRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-usage-a-'));
  const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-usage-b-'));
  const firstScope = {
    workspaceRoot: firstRoot,
    ownerKey: options.firstOwner || 'd'.repeat(64),
  };
  const secondScope = {
    workspaceRoot: secondRoot,
    ownerKey: options.secondOwner || 'e'.repeat(64),
  };
  const firstSession = new SessionStore(firstScope);
  const secondSession = new SessionStore(secondScope);
  const first = new UsageStore({ database: firstSession.database, ownerKey: firstScope.ownerKey });
  const second = new UsageStore({ database: secondSession.database, ownerKey: secondScope.ownerKey });
  const coordinator = new WorkspaceUsageCoordinator();
  coordinator.register(firstScope, firstSession.database);
  coordinator.register(secondScope, secondSession.database);
  return {
    firstRoot,
    secondRoot,
    firstScope,
    secondScope,
    firstSession,
    secondSession,
    first,
    second,
    coordinator,
    async close() {
      coordinator.close();
      firstSession.database.close();
      secondSession.database.close();
      await fs.rm(firstRoot, { recursive: true, force: true });
      await fs.rm(secondRoot, { recursive: true, force: true });
    },
  };
}

describe('workspace usage storage', function () {
  it('applies sorting and pagination once across registered owner-scoped stores', async function () {
    const fixture = await workspacePair();
    try {
      fixture.first.record(job('one', 'first', {
        endedAt: '2026-08-05T08:00:00.000Z', agent: 'claude', project: 'alpha',
      }));
      fixture.second.record(job('two', 'second', {
        endedAt: '2026-08-05T10:00:00.000Z', userId: 2, agent: 'codex', model: 'gpt-x', project: 'beta',
      }));
      fixture.first.record(job('three', 'third', {
        endedAt: '2026-08-05T09:00:00.000Z', agent: 'claude', model: 'sonnet', project: 'alpha',
      }));

      // Registering the same immutable scope is idempotent, not a second read source.
      fixture.coordinator.register(fixture.firstScope, fixture.firstSession.database);
      const page = fixture.coordinator.history({
        userId: 1, scope: 'everyone', limit: 1, offset: 1,
      });
      assert.strictEqual(page.total, 3);
      assert.deepStrictEqual(page.jobs.map((row) => row.sessionId), ['three']);

      const own = fixture.coordinator.history({ userId: 1, scope: 'self', limit: 10 });
      assert.deepStrictEqual(own.jobs.map((row) => row.sessionId), ['three', 'one']);

      const exported = fixture.coordinator.export({ userId: 1, scope: 'everyone' });
      assert.strictEqual(exported.truncated, false);
      assert.deepStrictEqual(exported.jobs.map((row) => row.sessionId), ['one', 'three', 'two']);
      assert.deepStrictEqual(fixture.coordinator.facets({ userId: 1, scope: 'everyone' }), {
        agents: ['claude', 'codex'],
        models: ['gpt-x', 'sonnet', 'test-model'],
        projects: ['alpha', 'beta'],
      });
    } finally {
      await fixture.close();
    }
  });

  it('aggregates dashboard totals, effort, tools, conversations, burn, and null counters', async function () {
    const fixture = await workspacePair({ secondOwner: 'd'.repeat(64) });
    try {
      fixture.first.record(job('one', 'a', {
        nativeSessionId: 'native-one',
        endedAt: '2026-08-05T10:10:00.000Z',
        model: 'm1',
        project: 'alpha',
        modelTurns: 1,
        toolCalls: 2,
        tools: [{ tool: 'Read', calls: 2 }],
        costUsd: 0.25,
      }));
      fixture.second.record(job('two', 'b', {
        nativeSessionId: 'native-two',
        endedAt: '2026-08-05T10:20:00.000Z',
        model: 'm2',
        project: 'beta',
        modelTurns: null,
        toolCalls: 4,
        tools: [{ tool: 'Read', calls: 3 }, { tool: 'Write', calls: 1 }],
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        costUsd: null,
        reportsUsage: false,
        reportsCost: false,
      }));

      const dashboard = fixture.coordinator.dashboard({
        userId: 1,
        scope: 'self',
        period: 'day',
        anchor: new Date('2026-08-05T12:00:00.000Z'),
        tzOffsetMinutes: 0,
      }, false);
      assert.strictEqual(dashboard.totals.turns, 2);
      assert.strictEqual(dashboard.totals.toolCalls, 6);
      assert.strictEqual(dashboard.totals.costUsd, 0.25);
      assert.strictEqual(dashboard.totals.costReportedTurns, 1);
      assert.strictEqual(dashboard.totals.tokensReportedTurns, 1);
      assert.strictEqual(dashboard.series.find((bucket) => bucket.key === '2026-08-05T10:00').totals.turns, 2);
      assert.deepStrictEqual(dashboard.byAgent.map((row) => [row.key, row.totals.turns]), [['claude', 2]]);
      assert.deepStrictEqual(new Set(dashboard.byModel.map((row) => row.key)), new Set(['m1', 'm2']));
      assert.deepStrictEqual(dashboard.effortByAgent[0], {
        key: 'claude',
        turns: 2,
        modelTurnsReportedTurns: 1,
        modelTurnsAvg: 1,
        modelTurnsMax: 1,
        toolCallsAvg: 3,
        toolCallsMax: 4,
        modelTurnsHistogram: [1, 0, 0, 0, 0],
        toolCallsHistogram: [0, 1, 1, 0, 0],
      });
      assert.deepStrictEqual(dashboard.topTools, [
        { tool: 'Read', agent: null, calls: 5, turns: 2 },
        { tool: 'Write', agent: null, calls: 1, turns: 1 },
      ]);

      const conversations = fixture.coordinator.conversations({ userId: 1, scope: 'self', limit: 1 });
      assert.strictEqual(conversations.total, 2);
      assert.strictEqual(conversations.conversations[0].sessionId, 'two');

      const burn = fixture.coordinator.burn(1, 'claude', 24, new Date('2026-08-06T00:00:00.000Z'));
      assert.strictEqual(burn.totals.turns, 2);
      assert.strictEqual(burn.totals.costReportedTurns, 1);

      assert.strictEqual(fixture.coordinator.costBaselineFor(fixture.firstScope, 'native-one'), 0.25);
      assert.deepStrictEqual(fixture.coordinator.consumedFor(fixture.firstScope, 'native-one'), {
        inputTokens: 2,
        outputTokens: 3,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 5,
        costUsd: 0.25,
      });
      assert.strictEqual(
        fixture.coordinator.spendByTurn(fixture.firstScope, 'one', 1).get('a').costUsd,
        0.25,
      );
    } finally {
      await fixture.close();
    }
  });

  it('keeps colliding ids ambiguous until a trusted scope qualifies them', async function () {
    const fixture = await workspacePair({ secondOwner: 'd'.repeat(64) });
    try {
      fixture.first.record(job('same-session', 'same-turn', {
        nativeSessionId: 'same-native', costUsd: 1, project: null,
      }));
      fixture.second.record(job('same-session', 'same-turn', {
        nativeSessionId: 'same-native', costUsd: 2, project: null,
      }));
      const query = { userId: 1, scope: 'self' };

      assert.strictEqual(fixture.coordinator.history({ ...query, limit: 10 }).total, 2);
      assert.strictEqual(fixture.coordinator.job('same-session:same-turn', query), null);
      assert.strictEqual(fixture.coordinator.attributeProject(
        { sessionId: 'same-session' }, 'ambiguous', query,
      ), 0);
      assert.strictEqual(fixture.coordinator.costBaselineFor('same-native'), null);
      assert.deepStrictEqual(fixture.coordinator.consumedFor('same-native'), {});
      assert.strictEqual(fixture.coordinator.spendByTurn('same-session', 1).size, 0);

      assert.strictEqual(
        fixture.coordinator.jobInScope(fixture.firstScope, 'same-session:same-turn', query).costUsd,
        1,
      );
      assert.strictEqual(fixture.coordinator.attributeProjectInScope(
        fixture.firstScope, { sessionId: 'same-session' }, 'alpha', query,
      ), 1);
      assert.strictEqual(fixture.coordinator.jobInScope(
        fixture.secondScope, 'same-session:same-turn', query,
      ).project, null);

      assert.throws(() => fixture.coordinator.record(
        fixture.firstScope,
        job('same-session', 'next-turn'),
      ), /already bound to another workspace scope/);
    } finally {
      await fixture.close();
    }
  });

  it('correlates split-model filters by owner when accounts share one workspace database', async function () {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-usage-shared-owner-'));
    const firstOwner = '1'.repeat(64);
    const secondOwner = '2'.repeat(64);
    const firstSession = new SessionStore({ workspaceRoot, ownerKey: firstOwner });
    const secondSession = new SessionStore({ workspaceRoot, ownerKey: secondOwner });
    const first = new UsageStore({ database: firstSession.database, ownerKey: firstOwner });
    const second = new UsageStore({ database: secondSession.database, ownerKey: secondOwner });
    try {
      first.record(job('same-session', 'same-turn', { model: 'answer-a' }));
      second.record(job('same-session', 'same-turn', {
        model: 'answer-b',
        models: [{
          model: 'private-split-b',
          calls: 1,
          inputTokens: 2,
          outputTokens: 3,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          costUsd: 0.01,
        }],
      }));

      const firstQuery = { userId: 1, scope: 'self', model: 'private-split-b' };
      assert.strictEqual(first.history(firstQuery).total, 0);
      assert.strictEqual(first.export(firstQuery).jobs.length, 0);
      assert.strictEqual(first.dashboard({
        ...firstQuery,
        period: 'day',
        anchor: new Date('2026-08-05T12:00:00.000Z'),
      }, false).totals.turns, 0);
      assert.strictEqual(second.history(firstQuery).total, 1);
    } finally {
      firstSession.database.close();
      secondSession.database.close();
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('records with per-workspace deduplication and supports unregister/re-register', async function () {
    const fixture = await workspacePair({ secondOwner: 'd'.repeat(64) });
    try {
      fixture.coordinator.record(fixture.firstScope, job('one', 'turn', { costUsd: 1 }));
      fixture.coordinator.record(fixture.firstScope, job('one', 'turn', { costUsd: 3 }));
      let history = fixture.coordinator.history({ userId: 1, scope: 'self' });
      assert.strictEqual(history.total, 1);
      assert.strictEqual(history.jobs[0].costUsd, 3);

      assert.strictEqual(fixture.coordinator.unregister(fixture.firstScope), true);
      assert.strictEqual(fixture.coordinator.history({ userId: 1, scope: 'self' }).total, 0);
      assert.throws(
        () => fixture.coordinator.record(fixture.firstScope, job('blocked', 'turn-2')),
        /authorised and registered/i,
        'usage must not open an arbitrary scope behind the workspace catalog',
      );
      fixture.coordinator.register(fixture.firstScope, fixture.firstSession.database);
      history = fixture.coordinator.history({ userId: 1, scope: 'self' });
      assert.strictEqual(history.total, 1);
      assert.strictEqual(history.jobs[0].costUsd, 3);
    } finally {
      await fixture.close();
    }
  });

  it('returns a correctly shaped empty dashboard without opening global storage', function () {
    const coordinator = new WorkspaceUsageCoordinator();
    try {
      const dashboard = coordinator.dashboard({
        userId: 1,
        scope: 'everyone',
        period: 'week',
        anchor: new Date('2026-08-05T12:00:00.000Z'),
      }, true);
      assert.strictEqual(dashboard.scope, 'everyone');
      assert.strictEqual(dashboard.totals.turns, 0);
      assert.strictEqual(dashboard.series.length, 7);
      assert.deepStrictEqual(dashboard.byUser, []);
    } finally {
      coordinator.close();
    }
  });
});
