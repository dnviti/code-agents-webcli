const assert = require('assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const { AppDatabase } = require('../dist/server/services/database.js');
const { UsageStore } = require('../dist/server/services/usage-store.js');

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

describe('shared usage storage', function () {
  it('aggregates every project in one per-user app.sqlite across restart', async function () {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-shared-usage-'));
    const dataDir = path.join(root, 'user-data');
    const firstWorkspace = path.join(root, 'project-a');
    const secondWorkspace = path.join(root, 'project-b');
    await Promise.all([fs.mkdir(dataDir), fs.mkdir(firstWorkspace), fs.mkdir(secondWorkspace)]);

    let database = new AppDatabase({ dataDir });
    try {
      let usage = new UsageStore(database);
      usage.record(job('session-a', 'turn-a', {
        project: 'alpha', endedAt: '2026-08-05T09:00:00.000Z',
      }));
      usage.record(job('session-b', 'turn-b', {
        project: 'beta', agent: 'codex', model: 'gpt-test',
        endedAt: '2026-08-05T10:00:00.000Z',
      }));

      database.close();
      database = new AppDatabase({ dataDir });
      usage = new UsageStore(database);

      const history = usage.history({ userId: 1, scope: 'everyone', limit: 10, offset: 0 });
      assert.strictEqual(history.total, 2);
      assert.deepStrictEqual(history.jobs.map((row) => row.sessionId), ['session-b', 'session-a']);
      assert.deepStrictEqual(usage.facets({ userId: 1, scope: 'everyone' }), {
        agents: ['claude', 'codex'],
        models: ['gpt-test', 'test-model'],
        projects: ['alpha', 'beta'],
      });
      assert.strictEqual(
        await fs.access(path.join(dataDir, 'app.sqlite')).then(() => true).catch(() => false),
        true,
      );
      for (const workspace of [firstWorkspace, secondWorkspace]) {
        assert.strictEqual(
          await fs.access(path.join(workspace, '.cc-web', 'session-state.sqlite'))
            .then(() => true).catch(() => false),
          false,
          'usage never creates project-local SQLite state',
        );
      }
    } finally {
      try { database.close(); } catch { /* already closed */ }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('keeps account filtering and idempotent turn replacement in the shared ledger', async function () {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-shared-usage-filter-'));
    const database = new AppDatabase({ dataDir });
    try {
      const usage = new UsageStore(database);
      usage.record(job('own', 'turn', { userId: 1, costUsd: 0.01 }));
      usage.record(job('own', 'turn', { userId: 1, costUsd: 0.02, outputTokens: 9 }));
      usage.record(job('other', 'turn', { userId: 2, costUsd: 0.03 }));

      const own = usage.history({ userId: 1, scope: 'self', limit: 10, offset: 0 });
      assert.strictEqual(own.total, 1);
      assert.strictEqual(own.jobs[0].costUsd, 0.02);
      assert.strictEqual(own.jobs[0].outputTokens, 9);
      assert.strictEqual(
        usage.history({ userId: 1, scope: 'everyone', limit: 10, offset: 0 }).total,
        2,
      );
    } finally {
      database.close();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
