/**
 * What a job cost, and the several ways that could be got wrong.
 *
 * The cases here are the ones that would silently multiply or erase somebody's
 * bill rather than fail loudly: a runtime that reports a running total being
 * summed as if it were per-turn, a null becoming a zero, a job counted twice
 * because its conversation was resumed. Each is a real convention some runtime
 * in this app actually uses.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { UsageAccountant } = require('../dist/server/chat/usage-accounting.js');
const { UsageStore, rangeFor } = require('../dist/server/services/usage-store.js');
const { AppDatabase } = require('../dist/server/services/database.js');

/** Feed events through an accountant and collect the jobs it closes. */
function run(events, prior) {
  const closed = [];
  const accountant = new UsageAccountant((job) => closed.push(job), prior);
  let seq = 0;
  for (const event of events) {
    accountant.observe({ seq: (seq += 1), ts: event.ts ?? seq * 1000, ...event });
  }
  return { closed, accountant };
}

/** The events one plain prompt-and-answer produces, with usage attached where asked. */
function turn(id, { usage, tools = [], assistantMessages = 1 } = {}) {
  const events = [
    { t: 'msg_start', id: `u-${id}`, role: 'user', turnId: id },
    { t: 'msg_end', msgId: `u-${id}` },
  ];
  for (let i = 0; i < assistantMessages; i += 1) {
    events.push({ t: 'msg_start', id: `a-${id}-${i}`, role: 'assistant', turnId: id });
    for (const [n, tool] of tools.entries()) {
      events.push({
        t: 'block_start',
        msgId: `a-${id}-${i}`,
        index: n,
        block: { kind: 'tool', toolId: `${id}-${i}-${n}`, name: tool },
      });
    }
    events.push({ t: 'msg_end', msgId: `a-${id}-${i}` });
  }
  events.push({ t: 'turn_end', turnId: id, usage });
  return events;
}

describe('usage accounting', () => {
  describe('what a job is', () => {
    it('opens on the user message and closes on turn_end', () => {
      const { closed } = run(turn('t1'));
      assert.strictEqual(closed.length, 1);
      assert.strictEqual(closed[0].turnId, 't1');
      assert.strictEqual(closed[0].outcome, 'completed');
    });

    it('does not count messages as round trips, however many the agent sent', () => {
      // The defect behind #86, from the other side: three assistant messages
      // used to be filed as three "turns", so an agent that separates its
      // thinking from its answer looked like three times the work of one that
      // does not. Nothing here reported a round-trip count, so the honest
      // answer is null.
      const { closed } = run(turn('t1', { assistantMessages: 3 }));
      assert.strictEqual(closed[0].modelTurns, null);
      assert.strictEqual(closed.length, 1, 'one prompt is one turn, whatever came back');
    });

    it('takes the runtime\'s own round-trip count where it reports one', () => {
      const { closed } = run([
        { t: 'msg_start', id: 'u', role: 'user', turnId: 't1' },
        { t: 'msg_start', id: 'a', role: 'assistant', turnId: 't1' },
        { t: 'msg_end', msgId: 'a' },
        // Claude's num_turns, which used to be dropped on the floor in favour
        // of the derived figure.
        { t: 'turn_end', turnId: 't1', modelTurns: 6 },
      ]);
      assert.strictEqual(closed[0].modelTurns, 6);
    });

    it('adds up a per-model breakdown only when every model reported', () => {
      const split = (calls) => [
        { t: 'msg_start', id: 'u', role: 'user', turnId: 't1' },
        { t: 'msg_start', id: 'a', role: 'assistant', turnId: 't1' },
        { t: 'msg_end', msgId: 'a' },
        { t: 'turn_end', turnId: 't1', models: calls },
      ];
      assert.strictEqual(
        run(split([{ model: 'a', calls: 2 }, { model: 'b', calls: 3 }])).closed[0].modelTurns,
        5,
      );
      // One model that did not say leaves the total unknowable: adding up the
      // rest would report a confident figure that undercounts.
      assert.strictEqual(
        run(split([{ model: 'a', calls: 2 }, { model: 'b', calls: null }])).closed[0].modelTurns,
        null,
      );
    });

    it('counts tool calls once each, even when a call is re-announced', () => {
      const events = [
        { t: 'msg_start', id: 'u', role: 'user', turnId: 't1' },
        { t: 'msg_start', id: 'a', role: 'assistant', turnId: 't1' },
        // Claude opens a tool block, then re-announces it once its streamed
        // arguments parse. Counting both would inflate every tool figure.
        { t: 'block_start', msgId: 'a', index: 0, block: { kind: 'tool', toolId: 'x', name: 'Bash' } },
        { t: 'block_start', msgId: 'a', index: 0, block: { kind: 'tool', toolId: 'x', name: 'Bash' } },
        { t: 'block_start', msgId: 'a', index: 1, block: { kind: 'tool', toolId: 'y', name: 'Read' } },
        { t: 'msg_end', msgId: 'a' },
        { t: 'turn_end', turnId: 't1' },
      ];
      const { closed } = run(events);
      assert.strictEqual(closed[0].toolCalls, 2);
      assert.deepStrictEqual(
        closed[0].tools.sort((a, b) => a.tool.localeCompare(b.tool)),
        [
          { tool: 'Bash', calls: 1 },
          { tool: 'Read', calls: 1 },
        ],
      );
    });

    it('files a job the process died in the middle of, rather than losing it', () => {
      const { closed } = run([
        { t: 'msg_start', id: 'u', role: 'user', turnId: 't1' },
        { t: 'msg_start', id: 'a', role: 'assistant', turnId: 't1' },
        { t: 'msg_end', msgId: 'a' },
        { t: 'state', state: 'exited' },
      ]);
      assert.strictEqual(closed.length, 1);
      assert.strictEqual(closed[0].outcome, 'interrupted');
      assert.strictEqual(closed[0].modelTurns, null);
    });

    it('leaves a figure nobody reported undefined rather than zero', () => {
      const { closed } = run(turn('t1'));
      assert.strictEqual(closed[0].usage.costUsd, undefined);
      assert.strictEqual(closed[0].usage.inputTokens, undefined);
    });
  });

  describe('additive reporting — claude, grok, pi, acp', () => {
    it('sums a per-turn figure across the messages of one job', () => {
      const { closed } = run([
        { t: 'msg_start', id: 'u', role: 'user', turnId: 't1' },
        { t: 'msg_start', id: 'a1', role: 'assistant', turnId: 't1' },
        { t: 'msg_end', msgId: 'a1', usage: { inputTokens: 10, outputTokens: 5 } },
        { t: 'msg_start', id: 'a2', role: 'assistant', turnId: 't1' },
        { t: 'msg_end', msgId: 'a2', usage: { inputTokens: 20, outputTokens: 7 } },
        { t: 'turn_end', turnId: 't1' },
      ]);
      assert.strictEqual(closed[0].usage.inputTokens, 30);
      assert.strictEqual(closed[0].usage.outputTokens, 12);
    });

    it('keeps each job to its own figures', () => {
      const { closed } = run([
        ...turn('t1', { usage: { costUsd: 0.5 } }),
        ...turn('t2', { usage: { costUsd: 0.25 } }),
      ]);
      assert.strictEqual(closed.length, 2);
      assert.strictEqual(closed[0].usage.costUsd, 0.5);
      assert.strictEqual(closed[1].usage.costUsd, 0.25);
    });
  });

  describe('absolute reporting — codex, and an ACP usage_update', () => {
    it('charges a job what the running total grew by, not what it says', () => {
      // codex reports a cumulative figure for the whole conversation. Summing
      // these three readings would bill 300+600+900 instead of 900.
      const { closed } = run([
        { t: 'msg_start', id: 'u1', role: 'user', turnId: 't1' },
        { t: 'usage', usage: { totalTokens: 300 } },
        { t: 'turn_end', turnId: 't1' },
        { t: 'msg_start', id: 'u2', role: 'user', turnId: 't2' },
        { t: 'usage', usage: { totalTokens: 600 } },
        { t: 'turn_end', turnId: 't2' },
        { t: 'msg_start', id: 'u3', role: 'user', turnId: 't3' },
        { t: 'usage', usage: { totalTokens: 900 } },
        { t: 'turn_end', turnId: 't3' },
      ]);
      assert.deepStrictEqual(
        closed.map((job) => job.usage.totalTokens),
        [300, 300, 300],
      );
    });

    it('credits the first job of a fresh conversation with the whole first reading', () => {
      // The floor is zero here: a conversation that just started has no history
      // for its first reported total to be describing.
      const { closed } = run([
        { t: 'msg_start', id: 'u1', role: 'user', turnId: 't1' },
        { t: 'usage', usage: { totalTokens: 500 } },
        { t: 'turn_end', turnId: 't1' },
      ]);
      assert.strictEqual(closed[0].usage.totalTokens, 500);
    });

    it('does not charge a resumed conversation for the history it inherited', () => {
      // Same events, but this process picked up a conversation already recorded
      // as having used 500 tokens, and the counter came back above that — so it
      // carried the history and this job used 100 of them, not 600.
      const { closed } = run(
        [
          { t: 'msg_start', id: 'u1', role: 'user', turnId: 't1' },
          { t: 'usage', usage: { totalTokens: 500 } },
          { t: 'usage', usage: { totalTokens: 600 } },
          { t: 'turn_end', turnId: 't1' },
        ],
        { totalTokens: 500 },
      );
      assert.strictEqual(closed[0].usage.totalTokens, 100);
    });

    it('reports zero rather than a negative when a counter goes backwards', () => {
      const { closed } = run([
        { t: 'msg_start', id: 'u1', role: 'user', turnId: 't1' },
        { t: 'usage', usage: { totalTokens: 900 } },
        { t: 'turn_end', turnId: 't1' },
        { t: 'msg_start', id: 'u2', role: 'user', turnId: 't2' },
        { t: 'usage', usage: { totalTokens: 10 } },
        { t: 'turn_end', turnId: 't2' },
      ]);
      assert.strictEqual(closed[1].usage.totalTokens, 0);
    });

    it('ignores context-window figures, which describe the window not the spend', () => {
      const { closed } = run([
        { t: 'msg_start', id: 'u1', role: 'user', turnId: 't1' },
        { t: 'msg_start', id: 'a1', role: 'assistant', turnId: 't1' },
        { t: 'msg_end', msgId: 'a1' },
        { t: 'usage', usage: { contextWindow: 200000, contextUsed: 40000 } },
        { t: 'turn_end', turnId: 't1' },
      ]);
      assert.strictEqual(closed[0].usage.contextWindow, undefined);
      assert.strictEqual(closed[0].usage.contextUsed, undefined);
    });
  });

  describe('the store', () => {
    let dir;
    let database;
    let store;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-usage-'));
      database = new AppDatabase({ dataDir: dir });
      store = new UsageStore(database);
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const job = (over = {}) => ({
      sessionId: 's1',
      nativeSessionId: 'n1',
      turnId: 't1',
      userId: 1,
      userLogin: 'octocat',
      agent: 'claude',
      model: 'sonnet',
      startedAt: '2026-03-04T10:00:00.000Z',
      endedAt: '2026-03-04T10:01:00.000Z',
      durationMs: 60000,
      outcome: 'completed',
      modelTurns: 2,
      toolCalls: 3,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
      totalTokens: 150,
      costUsd: 0.25,
      reportsUsage: true,
      reportsCost: true,
      tools: [
        { tool: 'Bash', calls: 2 },
        { tool: 'Read', calls: 1 },
      ],
      ...over,
    });

    it('survives the database being closed and reopened', () => {
      store.record(job());
      const reopened = new UsageStore(new AppDatabase({ dataDir: dir }));
      const { jobs, total } = reopened.history({ userId: 1, scope: 'self' });
      assert.strictEqual(total, 1);
      assert.strictEqual(jobs[0].costUsd, 0.25);
    });

    it('replaces rather than duplicates when the same job is filed twice', () => {
      store.record(job());
      store.record(job({ costUsd: 0.4 }));
      const { jobs, total } = store.history({ userId: 1, scope: 'self' });
      assert.strictEqual(total, 1);
      assert.strictEqual(jobs[0].costUsd, 0.4);
    });

    it('keeps a null null all the way back out', () => {
      store.record(job({ costUsd: null, totalTokens: null, reportsCost: false }));
      const record = store.job('s1:t1', { userId: 1, scope: 'self' });
      assert.strictEqual(record.costUsd, null);
      assert.strictEqual(record.totalTokens, null);
      assert.strictEqual(record.reportsCost, false);
    });

    it('counts how many jobs actually reported, so a total can be qualified', () => {
      store.record(job({ turnId: 'a', costUsd: 0.25 }));
      store.record(job({ turnId: 'b', costUsd: null }));
      const dash = store.dashboard(
        { userId: 1, scope: 'self', period: 'day', anchor: new Date('2026-03-04T12:00:00Z'), tzOffsetMinutes: 0 },
        false,
      );
      assert.strictEqual(dash.totals.turns, 2);
      assert.strictEqual(dash.totals.costReportedTurns, 1);
      assert.strictEqual(dash.totals.costUsd, 0.25);
    });

    it('shows no other user their figures, whatever they ask for', () => {
      store.record(job({ userId: 1, turnId: 'mine' }));
      store.record(job({ userId: 2, userLogin: 'someone-else', sessionId: 's2', turnId: 'theirs' }));

      const history = store.history({ userId: 1, scope: 'self' });
      assert.strictEqual(history.total, 1);
      assert.strictEqual(history.jobs[0].turnId, 'mine');

      assert.strictEqual(store.job('s2:theirs', { userId: 1, scope: 'self' }), null);

      // The store honours `everyone` only when the caller vouches for it; a
      // request that merely asks for it gets its own rows.
      const denied = store.dashboard(
        { userId: 1, scope: 'everyone', period: 'day', anchor: new Date('2026-03-04T12:00:00Z'), tzOffsetMinutes: 0 },
        false,
      );
      assert.strictEqual(denied.scope, 'self');
      assert.strictEqual(denied.totals.turns, 1);
      assert.strictEqual(denied.byUser, undefined);

      const allowed = store.dashboard(
        { userId: 1, scope: 'everyone', period: 'day', anchor: new Date('2026-03-04T12:00:00Z'), tzOffsetMinutes: 0 },
        true,
      );
      assert.strictEqual(allowed.totals.turns, 2);
      assert.strictEqual(allowed.byUser.length, 2);
    });

    it('breaks the same total down by agent and by model', () => {
      store.record(job({ turnId: 'a', agent: 'claude', model: 'sonnet', costUsd: 1 }));
      store.record(job({ turnId: 'b', agent: 'codex', model: 'gpt', costUsd: 2 }));
      const dash = store.dashboard(
        { userId: 1, scope: 'self', period: 'day', anchor: new Date('2026-03-04T12:00:00Z'), tzOffsetMinutes: 0 },
        false,
      );
      const byAgent = Object.fromEntries(dash.byAgent.map((row) => [row.key, row.totals.costUsd]));
      assert.deepStrictEqual(byAgent, { claude: 1, codex: 2 });
      const byModel = Object.fromEntries(dash.byModel.map((row) => [row.key, row.totals.costUsd]));
      assert.deepStrictEqual(byModel, { sonnet: 1, gpt: 2 });
    });

    it('puts each job in its own hour of the day, in the viewer’s own offset', () => {
      store.record(job({ turnId: 'a', endedAt: '2026-03-04T09:30:00.000Z' }));
      store.record(job({ turnId: 'b', endedAt: '2026-03-04T10:30:00.000Z' }));
      const dash = store.dashboard(
        {
          userId: 1,
          scope: 'self',
          period: 'day',
          anchor: new Date('2026-03-04T12:00:00Z'),
          // Two hours ahead of UTC, so 09:30Z is their 11:30.
          tzOffsetMinutes: 120,
        },
        false,
      );
      assert.strictEqual(dash.series.length, 24);
      const busy = dash.series.filter((bucket) => bucket.totals.turns > 0).map((bucket) => bucket.key);
      assert.deepStrictEqual(busy, ['2026-03-04T11:00', '2026-03-04T12:00']);
    });

    it('draws quiet buckets as gaps rather than closing them up', () => {
      store.record(job({ endedAt: '2026-03-04T10:30:00.000Z' }));
      const dash = store.dashboard(
        { userId: 1, scope: 'self', period: 'month', anchor: new Date('2026-03-04T12:00:00Z'), tzOffsetMinutes: 0 },
        false,
      );
      assert.strictEqual(dash.series.length, 31);
      assert.strictEqual(dash.series.filter((b) => b.totals.turns === 0).length, 30);
    });

    it('compares effort between agents, over completed jobs only', () => {
      store.record(job({ turnId: 'a', agent: 'claude', modelTurns: 1, toolCalls: 0 }));
      store.record(job({ turnId: 'b', agent: 'claude', modelTurns: 7, toolCalls: 9 }));
      store.record(job({ turnId: 'c', agent: 'codex', modelTurns: 2, toolCalls: 1 }));
      store.record(job({ turnId: 'd', agent: 'codex', modelTurns: 99, toolCalls: 99, outcome: 'interrupted' }));

      const dash = store.dashboard(
        { userId: 1, scope: 'self', period: 'day', anchor: new Date('2026-03-04T12:00:00Z'), tzOffsetMinutes: 0 },
        false,
      );
      const effort = Object.fromEntries(dash.effortByAgent.map((row) => [row.key, row]));
      assert.strictEqual(effort.claude.modelTurnsAvg, 4);
      assert.strictEqual(effort.claude.modelTurnsMax, 7);
      assert.deepStrictEqual(effort.claude.modelTurnsHistogram, [1, 0, 0, 1, 0]);
      // The interrupted job is not evidence about how many turns codex takes.
      assert.strictEqual(effort.codex.turns, 1);
      assert.strictEqual(effort.codex.modelTurnsAvg, 2);
    });

    it('shows which tools are used most, and how that differs by agent', () => {
      store.record(job({ turnId: 'a', agent: 'claude', tools: [{ tool: 'Bash', calls: 5 }] }));
      store.record(job({ turnId: 'b', agent: 'codex', tools: [{ tool: 'Bash', calls: 1 }, { tool: 'apply_patch', calls: 4 }] }));
      const dash = store.dashboard(
        { userId: 1, scope: 'self', period: 'day', anchor: new Date('2026-03-04T12:00:00Z'), tzOffsetMinutes: 0 },
        false,
      );
      assert.deepStrictEqual(dash.topTools[0], { tool: 'Bash', agent: null, calls: 6, turns: 2 });
      const perAgent = dash.topToolsByAgent.filter((row) => row.tool === 'Bash');
      assert.deepStrictEqual(
        perAgent.map((row) => [row.agent, row.calls]).sort(),
        [['claude', 5], ['codex', 1]],
      );
    });

    it('rebuilds a cumulative counter from what a conversation was already billed', () => {
      store.record(job({ turnId: 'a', nativeSessionId: 'conv-1', costUsd: 0.1 }));
      store.record(job({ turnId: 'b', nativeSessionId: 'conv-1', costUsd: 0.25 }));
      store.record(job({ turnId: 'c', nativeSessionId: 'conv-2', costUsd: 9 }));
      assert.strictEqual(Math.round(store.costBaselineFor('conv-1') * 100) / 100, 0.35);
      // A conversation with no record at all is not a conversation that has
      // spent nothing — see the note on costBaselineFor.
      assert.strictEqual(store.costBaselineFor('conv-3'), null);
    });

    it('keeps a job after the conversation it ran in is gone', () => {
      store.record(job());
      database.raw.prepare('DELETE FROM runtime_sessions').run();
      assert.strictEqual(store.history({ userId: 1, scope: 'self' }).total, 1);
    });
  });

  describe('period boundaries', () => {
    it('starts a week on Monday', () => {
      // 2026-03-04 is a Wednesday.
      const { from, to, buckets } = rangeFor('week', new Date('2026-03-04T12:00:00Z'), 0);
      assert.strictEqual(from.toISOString(), '2026-03-02T00:00:00.000Z');
      assert.strictEqual(to.toISOString(), '2026-03-09T00:00:00.000Z');
      assert.strictEqual(buckets.length, 7);
    });

    it('anchors a day on the viewer’s midnight, not the server’s', () => {
      // 23:00Z on the 4th is already the 5th for someone two hours ahead.
      const { from } = rangeFor('day', new Date('2026-03-04T23:00:00Z'), 120);
      assert.strictEqual(from.toISOString(), '2026-03-04T22:00:00.000Z');
    });

    it('covers a whole year in twelve months', () => {
      const { from, to, buckets } = rangeFor('year', new Date('2026-07-27T00:00:00Z'), 0);
      assert.strictEqual(from.toISOString(), '2026-01-01T00:00:00.000Z');
      assert.strictEqual(to.toISOString(), '2027-01-01T00:00:00.000Z');
      assert.deepStrictEqual(buckets[0], '2026-01');
      assert.strictEqual(buckets.length, 12);
    });
  });
});
