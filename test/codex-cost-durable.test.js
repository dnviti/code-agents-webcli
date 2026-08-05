/**
 * The durable half of the codex cost estimate (issue #182): a per-job estimate
 * and its provenance survive the write->read round trip, so the dashboard,
 * history and export all re-derive the same figure the live header showed.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { UsageStore } = require('../dist/server/services/usage-store.js');
const { AppDatabase } = require('../dist/server/services/database.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cost-durable-'));
}

function baseJob(over = {}) {
  return {
    sessionId: 's1',
    nativeSessionId: 'n1',
    turnId: 't1',
    userId: 1,
    userLogin: 'd',
    agent: 'codex',
    model: 'gpt-5-codex',
    project: null,
    startedAt: '2026-08-05T00:00:00Z',
    endedAt: '2026-08-05T00:01:00Z',
    durationMs: 60_000,
    outcome: 'completed',
    modelTurns: null,
    toolCalls: 2,
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 100,
    cacheWriteTokens: null,
    reasoningTokens: 0,
    totalTokens: 1500,
    costUsd: 0.0009,
    reportsUsage: true,
    reportsCost: true,
    tools: [],
    models: [],
    ...over,
  };
}

const ESTIMATE = {
  costUsd: 0.0009,
  model: 'gpt-5-codex',
  rates: { inputPerM: 2, cachedInputPerM: 0.5, outputPerM: 6 },
  source: 'openai-list',
  pricingDate: '2026-08-05',
};

describe('a codex cost estimate persists with its job', function () {
  it('round-trips costEstimate through record() -> job()', function () {
    const store = new UsageStore(new AppDatabase({ dataDir: tmpDir() }));
    store.record(baseJob({ costUsd: 0.0009, costEstimate: ESTIMATE }));

    const row = store.job('s1:t1', { userId: 1, scope: 'self' });
    assert.ok(row);
    assert.deepStrictEqual(row.costEstimate, ESTIMATE);
    assert.strictEqual(row.costUsd, 0.0009);
  });

  it('appears in the history summary too', function () {
    const store = new UsageStore(new AppDatabase({ dataDir: tmpDir() }));
    store.record(baseJob({ costUsd: 0.0009, costEstimate: ESTIMATE }));
    const { jobs } = store.history({ userId: 1, scope: 'self', limit: 50, offset: 0 });
    assert.strictEqual(jobs.length, 1);
    assert.deepStrictEqual(jobs[0].costEstimate, ESTIMATE);
  });

  it('is null for a job recorded without one (runtime-reported, or unpriced)', function () {
    const store = new UsageStore(new AppDatabase({ dataDir: tmpDir() }));
    store.record(baseJob({ agent: 'claude', costUsd: 1.25, costEstimate: undefined }));
    const row = store.job('s1:t1', { userId: 1, scope: 'self' });
    assert.strictEqual(row.costEstimate, null);
    assert.strictEqual(row.costUsd, 1.25);
  });

  it('a corrupt stored estimate is read back as null rather than breaking history', function () {
    const db = new AppDatabase({ dataDir: tmpDir() });
    const store = new UsageStore(db);
    store.record(baseJob({ costUsd: 0.0009, costEstimate: ESTIMATE }));
    db.raw.prepare('UPDATE usage_jobs SET cost_estimate = ? WHERE id = ?').run('{not json', 's1:t1');
    const row = store.job('s1:t1', { userId: 1, scope: 'self' });
    assert.strictEqual(row.costEstimate, null);
  });
});

describe('retrospective codex backfill', function () {
  const ESTIMATOR = {
    estimate: (tokens, model, opts) => ({
      costUsd: (tokens.inputTokens ?? 0) * 2e-6,
      model: model || 'gpt-5-codex',
      rates: { inputPerM: 2, cachedInputPerM: 0.5, outputPerM: 6 },
      source: 'openai-list',
      pricingDate: '2026-08-05',
      ...(opts?.retrospective ? { retrospective: true } : {}),
    }),
  };

  it('prices eligible codex rows retrospectively and leaves the rest alone', function () {
    const store = new UsageStore(new AppDatabase({ dataDir: tmpDir() }));
    store.record(baseJob({ sessionId: 'a', turnId: 't1', inputTokens: 1000, outputTokens: 500, costUsd: null }));
    store.record(baseJob({
      sessionId: 'a',
      turnId: 't2',
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.5,
      reportsCost: true,
    }));
    store.record(baseJob({ sessionId: 'a', turnId: 't3', agent: 'claude', inputTokens: 1000, outputTokens: 500, costUsd: 3 }));
    store.record(baseJob({ sessionId: 'a', turnId: 't4', model: null, inputTokens: 1000, outputTokens: 500, costUsd: null }));

    const updated = store.backfillCodexEstimates(ESTIMATOR);
    assert.strictEqual(updated, 1);

    const t1 = store.job('a:t1', { userId: 1, scope: 'self' });
    assert.ok(t1.costEstimate);
    // 1000 uncased * $2/M = 0.002
    assert.strictEqual(t1.costEstimate.costUsd, 0.002);
    assert.strictEqual(t1.costEstimate.retrospective, true);
    assert.strictEqual(t1.costEstimate.model, 'gpt-5-codex');

    // A runtime-reported price is never overwritten.
    assert.strictEqual(store.job('a:t2', { userId: 1, scope: 'self' }).costEstimate, null);
    assert.strictEqual(store.job('a:t2', { userId: 1, scope: 'self' }).costUsd, 0.5);
    // Non-codex work is never priced.
    assert.strictEqual(store.job('a:t3', { userId: 1, scope: 'self' }).costEstimate, null);
    // Unconfirmed-model codex work stays unpriced.
    assert.strictEqual(store.job('a:t4', { userId: 1, scope: 'self' }).costEstimate, null);
  });

  it('is idempotent and never rewrites an existing estimate', function () {
    const store = new UsageStore(new AppDatabase({ dataDir: tmpDir() }));
    store.record(baseJob({ sessionId: 'a', turnId: 't1', inputTokens: 1000, outputTokens: 500, costUsd: null }));
    assert.strictEqual(store.backfillCodexEstimates(ESTIMATOR), 1);
    const first = store.job('a:t1', { userId: 1, scope: 'self' }).costEstimate;
    assert.strictEqual(store.backfillCodexEstimates(ESTIMATOR), 0);
    assert.deepStrictEqual(store.job('a:t1', { userId: 1, scope: 'self' }).costEstimate, first);
  });

  it('returns 0 when no estimator is provided', function () {
    const store = new UsageStore(new AppDatabase({ dataDir: tmpDir() }));
    store.record(baseJob({ sessionId: 'a', turnId: 't1', inputTokens: 1000, outputTokens: 500, costUsd: null }));
    assert.strictEqual(store.backfillCodexEstimates(null), 0);
  });
});
