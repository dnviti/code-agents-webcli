/**
 * Issue #137: the only burn rate this app can honestly compute.
 *
 * The one it used to draw was a projection against a hand-written plan ceiling
 * over a scan of every Claude Code transcript on the host. This one is the
 * app's own record of turns it actually ran, narrowed to the person asking and
 * to the agent they are looking at — and it keeps the "reported" counters, so a
 * run of silent turns lowers confidence rather than lowering the rate.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { UsageStore } = require('../dist/server/services/usage-store.js');
const { AppDatabase } = require('../dist/server/services/database.js');

const NOW = new Date('2026-07-29T12:00:00.000Z');

function hoursAgo(n) {
  return new Date(NOW.getTime() - n * 3_600_000).toISOString();
}

function job(over = {}) {
  return {
    sessionId: 's1',
    nativeSessionId: null,
    turnId: 't1',
    userId: 7,
    userLogin: 'tester',
    agent: 'claude',
    model: 'claude-opus-5',
    project: null,
    startedAt: hoursAgo(2),
    endedAt: hoursAgo(2),
    durationMs: 1000,
    outcome: 'completed',
    modelTurns: null,
    toolCalls: 0,
    inputTokens: 100,
    outputTokens: 200,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    totalTokens: 300,
    costUsd: 0.5,
    reportsUsage: true,
    reportsCost: true,
    tools: [],
    models: [],
    ...over,
  };
}

describe('what this app measured, for one person on one agent', function () {
  let dir;
  let store;

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-burn-'));
    store = new UsageStore(new AppDatabase({ dataDir: dir }));
  });

  afterEach(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('counts only this user and this agent', function () {
    store.record(job({ turnId: 'mine-1' }));
    store.record(job({ turnId: 'mine-2', totalTokens: 700, costUsd: 1.5 }));
    // Somebody else's work on the same agent, and my own work on another.
    store.record(job({ turnId: 'theirs', userId: 8, totalTokens: 9_000_000 }));
    store.record(job({ turnId: 'other-agent', agent: 'codex', totalTokens: 9_000_000 }));

    const burn = store.burn(7, 'claude', 24, NOW);
    assert.strictEqual(burn.totals.turns, 2);
    assert.strictEqual(burn.totals.totalTokens, 1000);
    assert.strictEqual(burn.totals.costUsd, 2);
    assert.strictEqual(burn.hours, 24);
  });

  it('leaves out anything older than the window', function () {
    store.record(job({ turnId: 'recent' }));
    store.record(job({ turnId: 'ancient', startedAt: hoursAgo(30), endedAt: hoursAgo(30) }));

    assert.strictEqual(store.burn(7, 'claude', 24, NOW).totals.turns, 1);
    assert.strictEqual(store.burn(7, 'claude', 48, NOW).totals.turns, 2);
  });

  it('separates a silent turn from a turn that cost nothing', function () {
    store.record(job({ turnId: 'spoke' }));
    store.record(job({
      turnId: 'silent',
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      costUsd: null,
      reportsUsage: false,
      reportsCost: false,
    }));

    const burn = store.burn(7, 'claude', 24, NOW);
    assert.strictEqual(burn.totals.turns, 2);
    // The rate is over what was reported; the counters say how much of the
    // window stood behind it, which is what stops "0" reading as "nothing spent".
    assert.strictEqual(burn.totals.tokensReportedTurns, 1);
    assert.strictEqual(burn.totals.costReportedTurns, 1);
    assert.strictEqual(burn.totals.totalTokens, 300);
  });

  it('reports zero reported turns rather than a zero rate when nothing spoke', function () {
    store.record(job({
      turnId: 'silent',
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      costUsd: null,
      reportsUsage: false,
      reportsCost: false,
    }));

    const burn = store.burn(7, 'claude', 24, NOW);
    assert.strictEqual(burn.totals.turns, 1);
    assert.strictEqual(burn.totals.tokensReportedTurns, 0);
    assert.strictEqual(burn.totals.costReportedTurns, 0);
  });

  it('reports an empty window as empty, not as an error', function () {
    const burn = store.burn(7, 'claude', 24, NOW);
    assert.strictEqual(burn.totals.turns, 0);
    assert.strictEqual(burn.from, new Date(NOW.getTime() - 24 * 3_600_000).toISOString());
    assert.strictEqual(burn.to, NOW.toISOString());
  });
});
