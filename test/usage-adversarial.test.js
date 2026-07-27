/**
 * The event shapes real adapters actually emit, rather than the tidy ones a
 * fixture would invent.
 *
 * Every case here is a defect an adversarial review proved by execution against
 * the first version of this feature. They share a cause: the hand-written
 * fixtures next door gave each prompt exactly one user message and one
 * consistent turn id, and no runtime in this app does that. codex and the ACP
 * agents echo the prompt back with a turn id of their own; grok and pi number
 * their turns from a counter that restarts with the process; an ACP context
 * update carries a cost key with nothing in it. Each of those quietly produced
 * a wrong bill while every test stayed green.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { UsageAccountant } = require('../dist/server/chat/usage-accounting.js');
const { UsageStore } = require('../dist/server/services/usage-store.js');
const { AppDatabase } = require('../dist/server/services/database.js');
const { ClaudeChatAdapter } = require('../dist/server/chat/adapters/claude.js');

function run(events, prior) {
  const closed = [];
  const accountant = new UsageAccountant((job) => closed.push(job), prior);
  let seq = 0;
  for (const event of events) {
    accountant.observe({ seq: (seq += 1), ts: event.ts ?? seq * 1000, ...event });
  }
  return closed;
}

describe('accounting against what the adapters really emit', () => {
  it('files one job per prompt when the runtime echoes the prompt back', () => {
    // codex and the ACP agents both emit their own user message for a turn the
    // session has already opened. Treating that as a new prompt filed a blank
    // second row for every prompt those agents ever answered — half their
    // history, and half their turns- and tool-calls-per-job averages.
    const closed = run([
      { t: 'msg_start', id: 'ours', role: 'user', turnId: 'turn-uuid' },
      { t: 'msg_end', msgId: 'ours' },
      { t: 'msg_start', id: 'theirs', role: 'user', turnId: 'codex-1' },
      { t: 'msg_end', msgId: 'theirs' },
      { t: 'msg_start', id: 'a1', role: 'assistant', turnId: 'codex-1' },
      { t: 'block_start', msgId: 'a1', index: 0, block: { kind: 'tool', toolId: 'x', name: 'exec' } },
      { t: 'msg_end', msgId: 'a1' },
      { t: 'msg_start', id: 'a2', role: 'assistant', turnId: 'codex-1' },
      { t: 'msg_end', msgId: 'a2' },
      { t: 'turn_end', turnId: 'codex-1' },
    ]);

    assert.strictEqual(closed.length, 1, 'one prompt is one job');
    assert.strictEqual(closed[0].turns, 2);
    assert.strictEqual(closed[0].toolCalls, 1);
  });

  it('keys a job on the turn id this app minted, not the runtime’s', () => {
    // grok and pi restart their turn counter with every process, so a second
    // conversation in the same session reuses t1 and t2. A record keyed on the
    // runtime's id was overwritten by the next launch, taking the spend with it.
    const closed = run([
      { t: 'msg_start', id: 'u', role: 'user', turnId: 'turn-ours-abc' },
      { t: 'msg_end', msgId: 'u' },
      { t: 'msg_start', id: 'a', role: 'assistant', turnId: 't1' },
      { t: 'msg_end', msgId: 'a' },
      { t: 'turn_end', turnId: 't1', usage: { costUsd: 0.5 } },
    ]);
    assert.strictEqual(closed[0].turnId, 'turn-ours-abc');
  });

  it('keeps every turn of a conversation that was restarted twice', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-adv-'));
    try {
      const store = new UsageStore(new AppDatabase({ dataDir: dir }));
      const file = (turnId, costUsd) =>
        store.record({
          sessionId: 'sess-1',
          nativeSessionId: 'conv-1',
          turnId,
          userId: 1,
          userLogin: 'octocat',
          agent: 'grok',
          model: null,
          startedAt: '2026-03-04T10:00:00.000Z',
          endedAt: '2026-03-04T10:01:00.000Z',
          durationMs: 1,
          outcome: 'completed',
          turns: 1,
          toolCalls: 0,
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          reasoningTokens: null,
          totalTokens: null,
          costUsd,
          reportsUsage: true,
          reportsCost: true,
          tools: [],
        });

      // Four turns across two processes. Under the old key these collapsed to
      // two rows and $0.30 of $1.50 was never billed to anyone.
      for (const [turnId, cost] of [
        ['turn-a', 0.1],
        ['turn-b', 0.2],
        ['turn-c', 0.55],
        ['turn-d', 0.65],
      ]) {
        file(turnId, cost);
      }

      const { jobs, total } = store.history({ userId: 1, scope: 'self' });
      assert.strictEqual(total, 4);
      const billed = jobs.reduce((sum, job) => sum + job.costUsd, 0);
      assert.strictEqual(Math.round(billed * 100) / 100, 1.5);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not let a cost-less context update erase the running total', () => {
    // ACP sends `usage_update` with the cost key present but undefined whenever
    // the runtime omits a cost or quotes a currency that is not USD. Spreading
    // that over the watermark reset it to nothing, and the next reading was
    // measured against zero — billing one job the whole conversation again.
    const closed = run([
      { t: 'msg_start', id: 'u1', role: 'user', turnId: 'T1' },
      { t: 'usage', usage: { costUsd: 0.1 } },
      { t: 'turn_end', turnId: 'T1' },
      { t: 'msg_start', id: 'u2', role: 'user', turnId: 'T2' },
      { t: 'usage', usage: { costUsd: undefined, contextUsed: 4000 } },
      { t: 'turn_end', turnId: 'T2' },
      { t: 'msg_start', id: 'u3', role: 'user', turnId: 'T3' },
      { t: 'usage', usage: { costUsd: 0.3 } },
      { t: 'turn_end', turnId: 'T3' },
    ]);
    assert.strictEqual(closed[0].usage.costUsd, 0.1);
    assert.strictEqual(
      round(closed[2].usage.costUsd),
      0.2,
      'the third turn spent 0.2, not the whole conversation over again',
    );
  });

  it('reports nothing, rather than a measured zero, for a turn with no reading', () => {
    // A counter that did not move is not a measurement of zero. Filing it as
    // one is exactly what the record exists to avoid, and it would also count
    // the job as having reported.
    const closed = run([
      { t: 'msg_start', id: 'u1', role: 'user', turnId: 'T1' },
      { t: 'usage', usage: { inputTokens: 100, totalTokens: 110 } },
      { t: 'turn_end', turnId: 'T1' },
      { t: 'msg_start', id: 'u2', role: 'user', turnId: 'T2' },
      { t: 'msg_start', id: 'a2', role: 'assistant', turnId: 'T2' },
      { t: 'msg_end', msgId: 'a2' },
      { t: 'turn_end', turnId: 'T2' },
    ]);
    assert.strictEqual(closed[0].usage.totalTokens, 110);
    assert.strictEqual(closed[1].usage.totalTokens, undefined, 'not reported, not zero');
    assert.strictEqual(closed[1].usage.inputTokens, undefined);
  });

  it('works out whether a resumed counter carried its history or restarted', () => {
    const prior = { totalTokens: 500, inputTokens: 400 };

    // Carried: the first reading is above what we already recorded, so only the
    // growth belongs to this job.
    const carried = run(
      [
        { t: 'msg_start', id: 'u', role: 'user', turnId: 'T1' },
        { t: 'usage', usage: { totalTokens: 600, inputTokens: 450 } },
        { t: 'turn_end', turnId: 'T1' },
      ],
      prior,
    );
    assert.strictEqual(carried[0].usage.totalTokens, 100);

    // Restarted: the first reading is below it, so the counter plainly began
    // again and the whole reading is this job's. Treating this as carried
    // history recorded the turn as zero and lost it.
    const restarted = run(
      [
        { t: 'msg_start', id: 'u', role: 'user', turnId: 'T1' },
        { t: 'usage', usage: { totalTokens: 80, inputTokens: 60 } },
        { t: 'turn_end', turnId: 'T1' },
      ],
      prior,
    );
    assert.strictEqual(restarted[0].usage.totalTokens, 80);
  });

  it('files nothing for a turn that was opened and abandoned', () => {
    // `/clear` opens a turn before it is recognised as a command. The blank row
    // it left counted against every "N of M jobs reported" figure.
    const closed = run([
      { t: 'msg_start', id: 'u', role: 'user', turnId: 'T1' },
      { t: 'msg_end', msgId: 'u' },
      { t: 'state', state: 'exited' },
    ]);
    assert.deepStrictEqual(closed, []);
  });

  it('still files an interrupted turn that got somewhere first', () => {
    const closed = run([
      { t: 'msg_start', id: 'u', role: 'user', turnId: 'T1' },
      { t: 'msg_start', id: 'a', role: 'assistant', turnId: 'T1' },
      { t: 'msg_end', msgId: 'a', usage: { inputTokens: 9 } },
      { t: 'state', state: 'exited' },
    ]);
    assert.strictEqual(closed.length, 1);
    assert.strictEqual(closed[0].outcome, 'interrupted');
  });
});

describe('a conversation resumed with no record of what it already spent', () => {
  it('reports the first turn as unknown rather than billing it the whole history', () => {
    // An upgrade meets conversations that have been running for weeks. Their
    // cumulative counter is already high and nothing here knows how high, so
    // the first reading is adopted as the watermark. Charging that turn five
    // dollars of last fortnight's work would be the confident wrong answer.
    const events = [];
    const adapter = new ClaudeChatAdapter({
      sessionId: 'app-1',
      workingDir: '/tmp',
      command: 'claude',
      costBaselineUsd: null,
      emit: (event) => events.push(event),
    });
    adapter.handleResult({ type: 'result', total_cost_usd: 5.0, usage: {} });
    adapter.handleResult({ type: 'result', total_cost_usd: 5.02, usage: {} });

    const costs = events.filter((e) => e.t === 'turn_end').map((e) => e.usage && e.usage.costUsd);
    assert.strictEqual(costs[0], undefined, 'not knowable, so not reported');
    assert.strictEqual(round(costs[1]), 0.02);
  });

  it('tells a conversation with no record apart from one billed nothing so far', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-adv2-'));
    try {
      const store = new UsageStore(new AppDatabase({ dataDir: dir }));
      assert.strictEqual(store.costBaselineFor('never-seen'), null);

      store.record({
        sessionId: 's', nativeSessionId: 'conv-1', turnId: 't', userId: 1, userLogin: 'o',
        agent: 'claude', model: null,
        startedAt: '2026-03-04T10:00:00.000Z', endedAt: '2026-03-04T10:01:00.000Z',
        durationMs: 1, outcome: 'completed', turns: 1, toolCalls: 0,
        inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
        reasoningTokens: null, totalTokens: null, costUsd: null,
        reportsUsage: true, reportsCost: false, tools: [],
      });
      // A record exists; it simply reported no cost. That is a baseline of
      // zero, and quite different from having no record at all.
      assert.strictEqual(store.costBaselineFor('conv-1'), 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

function round(value) {
  return Math.round(value * 10000) / 10000;
}
