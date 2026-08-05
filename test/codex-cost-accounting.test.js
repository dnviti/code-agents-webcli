/**
 * The accountant→fileJob codex cost path (issue #182), end to end.
 *
 * The durable tests prove the store round-trips a `costEstimate` and the
 * adapter tests prove a usage event carries one. This is the seam neither
 * covers alone: a real `ChatSession` with a `codexPricing` estimator feeding
 * codex's *cumulative* standalone usage events, where the accountant must
 * subtract each turn's increment from the running total and `fileJob` must
 * recompute the per-turn estimate from that increment so the recorded cost and
 * its provenance agree.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ChatSession } = require('../dist/server/chat/session.js');
const { UsageAccountant } = require('../dist/server/chat/usage-accounting.js');
const { UsageStore } = require('../dist/server/services/usage-store.js');
const { AppDatabase } = require('../dist/server/services/database.js');

const RATES = { inputPerM: 2, cachedInputPerM: 0.5, outputPerM: 6 };

/** Mirror the pure formula: linear in tokens at the list rates. */
function expectedCost(tokens) {
  return (
    (tokens.inputTokens ?? 0) * (2 / 1e6) +
    (tokens.cacheReadTokens ?? 0) * (0.5 / 1e6) +
    (tokens.outputTokens ?? 0) * (6 / 1e6)
  );
}

/** The estimator the session hands to fileJob for codex. */
const ESTIMATOR = {
  estimate(tokens, model, opts) {
    if (!tokens.inputTokens && !tokens.outputTokens && !tokens.cacheReadTokens) return null;
    return {
      costUsd: expectedCost(tokens),
      model: model || 'gpt-5-codex',
      rates: RATES,
      source: 'openai-list',
      pricingDate: '2026-08-05',
      ...(opts?.retrospective ? { retrospective: true } : {}),
    };
  },
};

/** A cumulative standalone usage event, exactly as the adapter emits it. */
function cumulativeUsage(tokens) {
  return {
    t: 'usage',
    usage: {
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      cacheReadTokens: tokens.cacheReadTokens,
      totalTokens: (tokens.inputTokens ?? 0) + (tokens.outputTokens ?? 0),
      costUsd: expectedCost(tokens),
      costSource: 'estimated',
      costEstimate: ESTIMATOR.estimate(tokens, 'gpt-5-codex'),
    },
  };
}

function makeSession(store) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-codex-'));
  const session = new ChatSession(
    { id: 'sess-codex', ownerUserId: 7 },
    {
      store: {
        events: [],
        append(_ref, batch) { this.events.push(...batch); },
        async stat() { return { firstSeq: 1, cursor: this.events.length }; },
        async read() { return { events: [], firstSeq: 1, from: 1, cursor: this.events.length }; },
      },
      socketDir: dir,
      hookScript: path.join(__dirname, '..', 'does-not-exist.js'),
      broadcast: () => {},
      resolveCommand: () => 'codex',
      codexPricing: ESTIMATOR,
      usage: {
        record: (job) => store.record(job),
        costBaselineFor: (native) => store.costBaselineFor(native),
        loginFor: () => 'octocat',
      },
    },
  );
  session.runtime = 'codex';
  session.capabilities = { usage: true, cost: true };
  session.accountant = new UsageAccountant((job) => session.fileJob(job), false);
  return { session, dir };
}

describe('a codex turn is estimated per-turn from the cumulative total', function () {
  it('subtracts each turn’s increment and records a matching retrospective-able estimate', function () {
    const store = new UsageStore(new AppDatabase({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-codex-db-')) }));
    const { session, dir } = makeSession(store);
    try {
      session.ingest({ t: 'session', nativeSessionId: 'conv-1', model: 'gpt-5-codex', capabilities: { usage: true, cost: true } });

      // Turn 1: cumulative usage is the whole of turn 1.
      session.ingest({ t: 'msg_start', id: 'u1', role: 'user', turnId: 't1' });
      session.ingest({ t: 'msg_end', msgId: 'u1' });
      session.ingest({ t: 'msg_start', id: 'a1', role: 'assistant', turnId: 't1' });
      session.ingest(cumulativeUsage({ inputTokens: 1000, outputTokens: 500, cacheReadTokens: 100 }));
      session.ingest({ t: 'msg_end', msgId: 'a1' });
      session.ingest({ t: 'turn_end', turnId: 't1', stopReason: 'completed' });

      // Turn 2: cumulative usage adds another 600/300/100.
      session.ingest({ t: 'msg_start', id: 'u2', role: 'user', turnId: 't2' });
      session.ingest({ t: 'msg_end', msgId: 'u2' });
      session.ingest({ t: 'msg_start', id: 'a2', role: 'assistant', turnId: 't2' });
      session.ingest(cumulativeUsage({ inputTokens: 1600, outputTokens: 800, cacheReadTokens: 200 }));
      session.ingest({ t: 'msg_end', msgId: 'a2' });
      session.ingest({ t: 'turn_end', turnId: 't2', stopReason: 'completed' });

      const { jobs } = store.history({ userId: 7, scope: 'self' });
      assert.strictEqual(jobs.length, 2);

      const t1 = jobs.find((job) => job.turnId === 't1');
      const t2 = jobs.find((job) => job.turnId === 't2');

      // Turn 1 is the whole cumulative: 1000/500/100.
      assert.strictEqual(t1.inputTokens, 1000);
      assert.strictEqual(t1.outputTokens, 500);
      assert.strictEqual(t1.cacheReadTokens, 100);
      assert.ok(Math.abs(t1.costUsd - expectedCost({ inputTokens: 1000, outputTokens: 500, cacheReadTokens: 100 })) < 1e-9);
      assert.strictEqual(t1.costEstimate.model, 'gpt-5-codex');
      assert.ok(Math.abs(t1.costEstimate.costUsd - t1.costUsd) < 1e-12, 'provenance cost agrees with the filed cost');
      assert.strictEqual(t1.costEstimate.retrospective, undefined);

      // Turn 2 is the increment over turn 1: 600/300/100.
      assert.strictEqual(t2.inputTokens, 600);
      assert.strictEqual(t2.outputTokens, 300);
      assert.strictEqual(t2.cacheReadTokens, 100);
      assert.ok(Math.abs(t2.costUsd - expectedCost({ inputTokens: 600, outputTokens: 300, cacheReadTokens: 100 })) < 1e-9);
      assert.ok(Math.abs(t2.costEstimate.costUsd - t2.costUsd) < 1e-12);

      // The two turn costs are the same linear difference the accountant made.
      const total = t1.costUsd + t2.costUsd;
      assert.ok(Math.abs(total - expectedCost({ inputTokens: 1600, outputTokens: 800, cacheReadTokens: 200 })) < 1e-9);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves an unpriced codex turn as price-unavailable (null cost, no estimate)', function () {
    const store = new UsageStore(new AppDatabase({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-codex-db-')) }));
    const estimator = {
      estimate: () => null, // no rate for this model
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-codex-'));
    const session = new ChatSession(
      { id: 'sess-codex2', ownerUserId: 7 },
      {
        store: {
          events: [],
          append(_ref, batch) { this.events.push(...batch); },
          async stat() { return { firstSeq: 1, cursor: this.events.length }; },
          async read() { return { events: [], firstSeq: 1, from: 1, cursor: this.events.length }; },
        },
        socketDir: dir,
        hookScript: path.join(__dirname, '..', 'does-not-exist.js'),
        broadcast: () => {},
        resolveCommand: () => 'codex',
        codexPricing: estimator,
        usage: {
          record: (job) => store.record(job),
          costBaselineFor: (native) => store.costBaselineFor(native),
          loginFor: () => 'octocat',
        },
      },
    );
    session.runtime = 'codex';
    session.capabilities = { usage: true, cost: true };
    session.accountant = new UsageAccountant((job) => session.fileJob(job), false);
    try {
      session.ingest({ t: 'session', nativeSessionId: 'conv-2', model: 'gpt-unknown', capabilities: { usage: true, cost: true } });
      session.ingest({ t: 'msg_start', id: 'u1', role: 'user', turnId: 't1' });
      session.ingest({ t: 'msg_end', msgId: 'u1' });
      session.ingest({ t: 'usage', usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } });
      session.ingest({ t: 'turn_end', turnId: 't1', stopReason: 'completed' });

      const { jobs } = store.history({ userId: 7, scope: 'self' });
      const row = jobs[0];
      // Tokens preserved; no invented cost, no estimate, no zero.
      assert.strictEqual(row.inputTokens, 100);
      assert.strictEqual(row.outputTokens, 50);
      assert.strictEqual(row.costUsd, null);
      assert.strictEqual(row.costEstimate, null);
      assert.strictEqual(row.reportsCost, true, 'capability still says codex reports a (potentially unavailable) cost');
      assert.strictEqual(row.costUsd, null, 'price unavailable is never a zero');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
