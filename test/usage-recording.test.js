/**
 * That a conversation actually files what it cost, end to end.
 *
 * The unit tests next door prove the arithmetic; these prove the wiring — that
 * a real ChatSession, fed the events a real runtime emits, leaves a row behind
 * with the right user, agent and model on it. Two of the cases are regressions
 * for conventions that were verified by probing the CLIs rather than read off a
 * document, and both would produce a plausible-looking wrong number.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ChatSession } = require('../dist/server/chat/session.js');
const { ClaudeChatAdapter } = require('../dist/server/chat/adapters/claude.js');
const { UsageStore } = require('../dist/server/services/usage-store.js');
const { AppDatabase } = require('../dist/server/services/database.js');

function memoryStore() {
  const events = [];
  return {
    events,
    append(_ref, batch) {
      events.push(...batch);
    },
    async stat() {
      return { firstSeq: 1, cursor: events.length };
    },
    async read() {
      return { events: [], firstSeq: 1, from: 1, cursor: events.length };
    },
  };
}

describe('a conversation files what it cost', () => {
  let dir;
  let store;
  let session;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-rec-'));
    store = new UsageStore(new AppDatabase({ dataDir: dir }));
    session = new ChatSession(
      { id: 'sess-1', ownerUserId: 7 },
      {
        store: memoryStore(),
        socketDir: dir,
        hookScript: path.join(__dirname, '..', 'does-not-exist.js'),
        broadcast: () => {},
        resolveCommand: () => 'claude',
        usage: {
          record: (job) => store.record(job),
          costBaselineFor: (native) => store.costBaselineFor(native),
          loginFor: () => 'octocat',
        },
      },
    );
    session.runtime = 'claude';
    session.capabilities = { usage: true, cost: true };
    // `start()` builds the accountant; these tests drive the event stream
    // directly rather than spawning a CLI, so it is built the same way here.
    const { UsageAccountant } = require('../dist/server/chat/usage-accounting.js');
    session.accountant = new UsageAccountant((job) => session.fileJob(job), false);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const feed = (events) => {
    for (const event of events) session.ingest(event);
  };

  it('records who ran the work, with which agent and model, and what it took', () => {
    feed([
      { t: 'session', nativeSessionId: 'conv-1', model: 'claude-sonnet-5', capabilities: {} },
      { t: 'msg_start', id: 'u1', role: 'user', turnId: 'turn-1' },
      { t: 'msg_end', msgId: 'u1' },
      { t: 'msg_start', id: 'a1', role: 'assistant', turnId: 'turn-1' },
      { t: 'block_start', msgId: 'a1', index: 0, block: { kind: 'tool', toolId: 'x', name: 'Bash' } },
      { t: 'msg_end', msgId: 'a1', usage: { inputTokens: 100, outputTokens: 20 } },
      { t: 'msg_start', id: 'a2', role: 'assistant', turnId: 'turn-1' },
      { t: 'msg_end', msgId: 'a2', usage: { inputTokens: 50, outputTokens: 10 } },
      { t: 'turn_end', turnId: 'turn-1', usage: { costUsd: 0.4 }, durationMs: 1234 },
    ]);

    const { jobs, total } = store.history({ userId: 7, scope: 'self' });
    assert.strictEqual(total, 1);
    const job = jobs[0];
    assert.strictEqual(job.userId, 7);
    assert.strictEqual(job.userLogin, 'octocat');
    assert.strictEqual(job.agent, 'claude');
    assert.strictEqual(job.model, 'claude-sonnet-5');
    assert.strictEqual(job.sessionId, 'sess-1');
    assert.strictEqual(job.nativeSessionId, 'conv-1');
    assert.strictEqual(job.modelTurns, null);
    assert.strictEqual(job.toolCalls, 1);
    assert.strictEqual(job.inputTokens, 150);
    assert.strictEqual(job.outputTokens, 30);
    assert.strictEqual(job.costUsd, 0.4);
    assert.strictEqual(job.durationMs, 1234);
    assert.strictEqual(job.outcome, 'completed');

    const detail = store.job(job.id, { userId: 7, scope: 'self' });
    assert.deepStrictEqual(
      detail.tools.map((entry) => ({ tool: entry.tool, calls: entry.calls })),
      [{ tool: 'Bash', calls: 1 }],
    );
  });

  it('records nothing about what was said', () => {
    feed([
      { t: 'msg_start', id: 'u1', role: 'user', turnId: 'turn-1' },
      { t: 'msg_end', msgId: 'u1' },
      { t: 'turn_end', turnId: 'turn-1' },
    ]);
    const row = store.history({ userId: 7, scope: 'self' }).jobs[0];
    const text = JSON.stringify(row);
    assert.ok(!/text|content|prompt|input"\s*:\s*"/.test(text), text);
  });

  it('marks an agent that cannot report cost, so a null can be explained', () => {
    session.runtime = 'codex';
    session.capabilities = { usage: true, cost: false };
    feed([
      { t: 'msg_start', id: 'u1', role: 'user', turnId: 'turn-1' },
      { t: 'msg_end', msgId: 'u1' },
      { t: 'usage', usage: { totalTokens: 900 } },
      { t: 'turn_end', turnId: 'turn-1' },
    ]);
    const row = store.history({ userId: 7, scope: 'self' }).jobs[0];
    assert.strictEqual(row.costUsd, null, 'a cost nobody reported is not zero');
    assert.strictEqual(row.reportsCost, false);
    assert.strictEqual(row.reportsUsage, true);
    assert.strictEqual(row.totalTokens, 900);
  });

  it('survives a runtime that dies with a turn still open', () => {
    feed([
      { t: 'msg_start', id: 'u1', role: 'user', turnId: 'turn-1' },
      { t: 'msg_end', msgId: 'u1' },
      { t: 'msg_start', id: 'a1', role: 'assistant', turnId: 'turn-1' },
      { t: 'msg_end', msgId: 'a1', usage: { inputTokens: 42 } },
      { t: 'state', state: 'exited' },
    ]);
    const row = store.history({ userId: 7, scope: 'self' }).jobs[0];
    assert.strictEqual(row.outcome, 'interrupted');
    assert.strictEqual(row.inputTokens, 42);
  });

  it('reports what each turn of the conversation cost, by turn', () => {
    // The figure that goes beside a turn in the index. Taken from the row the
    // accountant filed rather than added up in the browser: half the runtimes
    // report a running total rather than a per-turn one, and only this side
    // knows where each turn started.
    feed([
      { t: 'msg_start', id: 'u1', role: 'user', turnId: 'turn-1' },
      { t: 'msg_end', msgId: 'u1' },
      { t: 'msg_start', id: 'a1', role: 'assistant', turnId: 'turn-1' },
      { t: 'msg_end', msgId: 'a1', usage: { outputTokens: 20 } },
      { t: 'turn_end', turnId: 'turn-1', usage: { costUsd: 0.4 } },
      { t: 'msg_start', id: 'u2', role: 'user', turnId: 'turn-2' },
      { t: 'msg_end', msgId: 'u2' },
      { t: 'msg_start', id: 'a2', role: 'assistant', turnId: 'turn-2' },
      { t: 'msg_end', msgId: 'a2', usage: { outputTokens: 5 } },
      { t: 'turn_end', turnId: 'turn-2', usage: { costUsd: 0.05 } },
    ]);

    const spend = store.spendByTurn('sess-1', 7);
    assert.strictEqual(spend.get('turn-1').costUsd, 0.4);
    assert.strictEqual(spend.get('turn-2').costUsd, 0.05);
    assert.strictEqual(spend.get('turn-1').outputTokens, 20);
    // Somebody else's conversation is not readable by asking nicely.
    assert.strictEqual(store.spendByTurn('sess-1', 99).size, 0);
  });

  it('leaves a turn nobody could price without a figure, rather than at zero', () => {
    session.runtime = 'codex';
    session.capabilities = { usage: true, cost: false };
    feed([
      { t: 'msg_start', id: 'u1', role: 'user', turnId: 'turn-1' },
      { t: 'msg_end', msgId: 'u1' },
      { t: 'usage', usage: { totalTokens: 900 } },
      { t: 'turn_end', turnId: 'turn-1' },
    ]);
    const spend = store.spendByTurn('sess-1', 7);
    assert.strictEqual(spend.get('turn-1').costUsd, undefined, 'unmeasured is not $0.00');
    assert.strictEqual(spend.get('turn-1').totalTokens, 900);
  });

  it('keeps one row when the same job is somehow filed twice', () => {
    const events = [
      { t: 'msg_start', id: 'u1', role: 'user', turnId: 'turn-1' },
      { t: 'msg_end', msgId: 'u1' },
      { t: 'turn_end', turnId: 'turn-1', usage: { costUsd: 0.1 } },
    ];
    feed(events);
    feed(events);
    assert.strictEqual(store.history({ userId: 7, scope: 'self' }).total, 1);
  });
});

describe("claude's cost figure is cumulative, and is corrected where it is produced", () => {
  /**
   * Probed against 2.1.220 rather than assumed: two prompts through one process
   * reported 0.1286 then 0.1790 while the token counts stayed at 2 in / 6 out
   * both times, and a third prompt through a `--resume` in a new process
   * continued from 0.1790 instead of restarting. Everything downstream sums
   * what a turn reports, so before this was corrected a second turn showed
   * roughly triple its real cost and a tenth turn far worse.
   */
  function adapter(costBaselineUsd) {
    const events = [];
    const instance = new ClaudeChatAdapter({
      sessionId: 'app-1',
      workingDir: '/tmp',
      command: 'claude',
      costBaselineUsd,
      emit: (event) => events.push(event),
    });
    return { instance, events };
  }

  const costs = (events) => events.filter((e) => e.t === 'turn_end').map((e) => e.usage.costUsd);

  it('reports each turn its own share of the running total', () => {
    const { instance, events } = adapter();
    instance.handleResult({ type: 'result', total_cost_usd: 0.1286, usage: { input_tokens: 2 } });
    instance.handleResult({ type: 'result', total_cost_usd: 0.179, usage: { input_tokens: 2 } });
    instance.handleResult({ type: 'result', total_cost_usd: 0.2, usage: { input_tokens: 2 } });
    const [first, second, third] = costs(events);
    assert.strictEqual(round(first), 0.1286);
    assert.strictEqual(round(second), 0.0504);
    assert.strictEqual(round(third), 0.021);
  });

  it('picks the counter back up where a resumed conversation left it', () => {
    // The CLI's counter survives a restart; an in-process variable does not,
    // so the watermark is handed in from what the conversation was billed.
    const { instance, events } = adapter(0.179);
    instance.handleResult({ type: 'result', total_cost_usd: 0.1970415, usage: {} });
    assert.strictEqual(round(costs(events)[0]), 0.018);
  });

  it('never reports a negative when the baseline turns out to be too high', () => {
    const { instance, events } = adapter(5);
    instance.handleResult({ type: 'result', total_cost_usd: 0.1, usage: {} });
    assert.strictEqual(costs(events)[0], 0);
  });

  it('leaves a turn that reported no cost reporting no cost', () => {
    const { instance, events } = adapter();
    instance.handleResult({ type: 'result', usage: { input_tokens: 2 } });
    assert.strictEqual(events.find((e) => e.t === 'turn_end').usage.costUsd, undefined);
  });

  it('leaves the per-turn token counts exactly as reported', () => {
    const { instance, events } = adapter();
    instance.handleResult({
      type: 'result',
      total_cost_usd: 1,
      usage: { input_tokens: 2, output_tokens: 6, cache_read_input_tokens: 15498 },
    });
    const usage = events.find((e) => e.t === 'turn_end').usage;
    assert.strictEqual(usage.inputTokens, 2);
    assert.strictEqual(usage.outputTokens, 6);
    assert.strictEqual(usage.cacheReadTokens, 15498);
  });
});

function round(value) {
  return Math.round(value * 10000) / 10000;
}
