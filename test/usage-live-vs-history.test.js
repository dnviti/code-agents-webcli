/**
 * What a job showed while it ran, against what it was recorded as consuming.
 *
 * Issue #80: the two disagreed for nearly every job. The chat showed a token
 * figure; the historical dashboard said "not reported", because it filed only
 * a total the runtime had volunteered — and Claude, the agent used most here,
 * volunteers none. So the headline totals, the per-project and per-model
 * breakdowns and the trend were all built from whichever handful of jobs
 * happened to survive.
 *
 * Each case here drives a **real adapter** with a **captured wire log** from
 * `test/fixtures/chat`, folds the resulting events through the shared reducer
 * to get the live figure, feeds the same events through a real `ChatSession`
 * to get the recorded one, and compares them. Nothing here invents an event
 * shape: what the two sides read is what the CLIs actually sent.
 *
 * The one thing added to the capture is the user's own message, because that
 * comes from `deliver` rather than from the runtime — it is what opens a job,
 * and every real session emits it.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ChatSession } = require('../dist/server/chat/session.js');
const { UsageAccountant } = require('../dist/server/chat/usage-accounting.js');
const { UsageStore } = require('../dist/server/services/usage-store.js');
const { AppDatabase } = require('../dist/server/services/database.js');
const { applyChatEvent, createTranscript } = require('../dist/shared/chat-reducer.js');
const { tokenTotal } = require('../dist/shared/usage-records.js');
const { feed, wire } = require('./acp-fixture-harness.js');

const { ClaudeChatAdapter } = require('../dist/server/chat/adapters/claude.js');
const { PiChatAdapter } = require('../dist/server/chat/adapters/pi.js');
const { AcpChatAdapter } = require('../dist/server/chat/adapters/acp.js');
const { CodexAppServerAdapter } = require('../dist/server/chat/adapters/codex.js');

function fixture(name) {
  return fs
    .readFileSync(path.join(__dirname, 'fixtures', 'chat', `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

// --------------------------------------------------------------- the adapters
//
// Each of these replays one capture through the adapter that reads it, exactly
// as the tests next door do (`chat-claude`, `chat-pi`, `chat-acp`,
// `chat-codex`), and hands back the events a session would have ingested.

async function claudeRun() {
  const events = [];
  const adapter = new ClaudeChatAdapter({
    sessionId: 's', workingDir: '/w', command: 'claude', emit: (e) => events.push(e),
  });
  adapter.send({ text: 'go' });
  for (const line of fixture('claude-oneshot')) adapter.handleMessage(line);
  return events;
}

async function piRun() {
  const events = [];
  const adapter = new PiChatAdapter({
    sessionId: 's', workingDir: '/w', command: 'pi', emit: (e) => events.push(e),
  });
  for (const line of fixture('pi-final-turn')) adapter.handleMessage(line);
  return events;
}

function acpRun(name, runtime) {
  return async () => {
    const events = [];
    const adapter = new AcpChatAdapter({
      sessionId: 's', workingDir: '/w', command: '/nonexistent', emit: (e) => events.push(e),
      readFile: async () => '',
      ...(runtime ? { runtime, acpArgs: ['acp'] } : null),
    });
    const sent = [];
    wire(adapter, sent);
    const lines = fixture(name);
    const done = adapter.handshake();
    await feed(adapter, lines.slice(0, 2), sent);
    await done;
    // The prompt goes out before the updates, as it did on the wire: the
    // captured turn result is the reply to it, and carries the token counts.
    const sending = adapter.send({ text: 'go' });
    await feed(adapter, lines.slice(2), sent);
    await sending;
    return events;
  };
}

async function codexRun() {
  const events = [];
  const adapter = new CodexAppServerAdapter({
    sessionId: 's', workingDir: '/w', command: '/nonexistent', emit: (e) => events.push(e),
  });
  adapter.writeLine = () => {};
  const done = adapter.handshake();
  for (const line of fixture('codex-appserver-handshake')) {
    adapter.handleMessage(line);
    await flush();
  }
  await done;
  for (const line of fixture('codex-appserver-text-turn')) {
    adapter.handleMessage(line);
    await flush();
  }
  return events;
}

// ------------------------------------------------------------------ the sides

const CAPABILITIES = {
  streaming: true, thinking: true, toolCalls: true, diffs: true, permissions: true,
  interrupt: true, resume: true, fork: false, attachments: true, usage: true,
  cost: true, plan: true,
};

/** What the chat showed: the session usage the composer and meter read. */
function liveFigure(events) {
  const state = createTranscript(CAPABILITIES);
  events.forEach((event, index) => applyChatEvent(state, { ...event, seq: index + 1 }));
  return tokenTotal(state.usage);
}

function memoryStore() {
  const events = [];
  return {
    append(_ref, batch) { events.push(...batch); },
    async stat() { return { firstSeq: 1, cursor: events.length }; },
    async read() { return { events: [], firstSeq: 1, from: 1, cursor: events.length }; },
  };
}

/** What was filed: the row the dashboard's Tokens column reads. */
function recordedRow(dir, runtime, events) {
  const store = new UsageStore(new AppDatabase({ dataDir: dir }));
  const session = new ChatSession(
    { id: 'sess-1', ownerUserId: 7 },
    {
      store: memoryStore(),
      socketDir: dir,
      hookScript: path.join(__dirname, '..', 'does-not-exist.js'),
      broadcast: () => {},
      resolveCommand: () => runtime,
      usage: {
        record: (job) => store.record(job),
        costBaselineFor: () => null,
        loginFor: () => 'octocat',
      },
    },
  );
  session.runtime = runtime;
  session.capabilities = { usage: true, cost: true };
  session.accountant = new UsageAccountant((job) => session.fileJob(job), false);

  // The user's own message, which `deliver` emits and the capture cannot
  // contain, then the runtime's events, then the close every session performs
  // when the process goes away — some captures are trimmed before turn_end.
  session.ingest({ t: 'msg_start', id: 'u1', role: 'user', turnId: 'turn-1' });
  session.ingest({ t: 'msg_end', msgId: 'u1' });
  for (const event of events) session.ingest(event);
  session.accountant.flush();

  const rows = store.history({ userId: 7, scope: 'self' }).jobs;
  return { rows, store };
}

const AGENTS = [
  { runtime: 'claude', label: 'claude, which reports four buckets and never a total', run: claudeRun },
  // Grok over ACP since #73 — the headless adapter this used to drive is gone,
  // and the capture is the one the ACP entry point really produced.
  { runtime: 'grok', label: 'grok, over ACP', run: acpRun('acp-grok', 'grok') },
  { runtime: 'pi', label: 'pi', run: piRun },
  { runtime: 'codex', label: 'codex, which reports a running total', run: codexRun },
  // Named for the CLI whose capture is being replayed. These two said `kimi`,
  // which was wrong twice over now that kimi is on record as reporting no
  // tokens and no money at all (#136): the row would have claimed a runtime
  // reported the very figures it never sends.
  { runtime: 'omp', label: 'an ACP agent (omp)', run: acpRun('acp-omp') },
  { runtime: 'opencode', label: 'an ACP agent (opencode)', run: acpRun('acp-opencode') },
];

describe('a job’s tokens: what the chat showed against what was filed', function () {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-lvh-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  for (const agent of AGENTS) {
    it(`${agent.label} files the figure it showed`, async function () {
      const events = await agent.run();
      const live = liveFigure(events);
      assert.ok(
        live !== null && live > 0,
        `${agent.label}: the capture shows no tokens live, so it proves nothing`,
      );

      const { rows } = recordedRow(dir, agent.runtime, events);
      assert.strictEqual(rows.length, 1, 'one prompt, one row');
      assert.notStrictEqual(
        rows[0].totalTokens,
        null,
        `${agent.label}: showed ${live} tokens in chat and filed "not reported"`,
      );
      assert.strictEqual(rows[0].totalTokens, live);
    });
  }

  it('an agent that reported nothing is still recorded as having reported nothing', async function () {
    const { rows } = recordedRow(dir, 'claude', [
      { t: 'msg_start', id: 'a1', role: 'assistant', turnId: 'turn-1' },
      { t: 'msg_end', msgId: 'a1' },
      { t: 'turn_end', turnId: 'turn-1', usage: { costUsd: 0.02 } },
    ]);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].totalTokens, null, 'a silence is not a zero');
    assert.strictEqual(rows[0].costUsd, 0.02);
    assert.strictEqual(rows[0].reportsUsage, true, 'it can report usage; this time it did not');
  });

  it('an agent that cannot report usage stays distinguishable from one that did not', async function () {
    const store = new UsageStore(new AppDatabase({ dataDir: dir }));
    const session = new ChatSession(
      { id: 'sess-2', ownerUserId: 7 },
      {
        store: memoryStore(),
        socketDir: dir,
        hookScript: path.join(__dirname, '..', 'does-not-exist.js'),
        broadcast: () => {},
        resolveCommand: () => 'cursor',
        usage: {
          record: (job) => store.record(job),
          costBaselineFor: () => null,
          loginFor: () => 'octocat',
        },
      },
    );
    session.runtime = 'cursor';
    session.capabilities = { usage: false, cost: false };
    session.accountant = new UsageAccountant((job) => session.fileJob(job), false);
    session.ingest({ t: 'msg_start', id: 'u1', role: 'user', turnId: 'turn-1' });
    session.ingest({ t: 'msg_end', msgId: 'u1' });
    session.ingest({ t: 'msg_start', id: 'a1', role: 'assistant', turnId: 'turn-1' });
    session.ingest({ t: 'msg_end', msgId: 'a1' });
    session.ingest({ t: 'turn_end', turnId: 'turn-1' });

    const row = store.history({ userId: 7, scope: 'self' }).jobs[0];
    assert.strictEqual(row.reportsUsage, false);
    assert.strictEqual(row.totalTokens, null);
  });

  it('the dashboard’s totals count the jobs the history now shows', async function () {
    const events = await claudeRun();
    const { rows, store } = recordedRow(dir, 'claude', events);
    const dashboard = store.dashboard({ userId: 7, scope: 'self', period: 'month' }, false);
    assert.strictEqual(dashboard.totals.totalTokens, rows[0].totalTokens);
    assert.strictEqual(dashboard.totals.tokensReportedTurns, 1);
    // And the breakdowns, which are what a user compares agents and projects by.
    const byAgent = dashboard.byAgent.find((entry) => entry.key === 'claude');
    assert.strictEqual(byAgent.totals.totalTokens, rows[0].totalTokens);
  });
});

describe('history filed before a total was derived', function () {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-backfill-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A row as the old code left it: every part recorded, no total. */
  function fileOldRow(db, id, parts) {
    db.raw
      .prepare(`
        INSERT INTO usage_jobs (
          id, session_id, native_session_id, turn_id, user_id, user_login,
          agent, model, project, project_source, started_at, ended_at, duration_ms, outcome,
          turns, tool_calls, input_tokens, output_tokens, cache_read_tokens,
          cache_write_tokens, reasoning_tokens, total_tokens, cost_usd,
          reports_usage, reports_cost
        ) VALUES (?, 's', NULL, ?, 7, 'octocat', 'claude', NULL, NULL, NULL,
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z', 60000, 'completed',
          1, 0, ?, ?, ?, ?, ?, NULL, 0.1, 1, 1)
      `)
      .run(
        id, id,
        parts.inputTokens ?? null,
        parts.outputTokens ?? null,
        parts.cacheReadTokens ?? null,
        parts.cacheWriteTokens ?? null,
        parts.reasoningTokens ?? null,
      );
  }

  it('is corrected on the next boot, from the parts already in the row', function () {
    const first = new AppDatabase({ dataDir: dir });
    fileOldRow(first, 'old-1', {
      inputTokens: 4, outputTokens: 97, cacheReadTokens: 47287, cacheWriteTokens: 16402,
    });
    fileOldRow(first, 'old-2', {});
    first.close?.();

    // Booting again is what runs the migration; nothing else touches the rows.
    const store = new UsageStore(new AppDatabase({ dataDir: dir }));
    const jobs = store.history({ userId: 7, scope: 'self' }).jobs;
    const byId = Object.fromEntries(jobs.map((job) => [job.id, job]));
    assert.strictEqual(byId['old-1'].totalTokens, 63790, 'the parts were always there to add up');
    assert.strictEqual(
      byId['old-2'].totalTokens,
      null,
      'a row that reported nothing has nothing to add up, and still says so',
    );
  });

  it('leaves legacy usage rows unchanged when the database is import-only', function () {
    const first = new AppDatabase({ dataDir: dir });
    fileOldRow(first, 'pending-import', {
      inputTokens: 4, outputTokens: 97, cacheReadTokens: 47287, cacheWriteTokens: 16402,
    });
    first.raw.prepare(`UPDATE usage_jobs
      SET project = 'legacy-project', project_source = NULL
      WHERE id = 'pending-import'`).run();
    first.close?.();

    const importOnly = new AppDatabase({
      dataDir: dir,
      legacySessionBackfills: false,
    });
    try {
      const row = importOnly.raw.prepare(`SELECT project_source, total_tokens
        FROM usage_jobs WHERE id = 'pending-import'`).get();
      assert.deepStrictEqual({ ...row }, { project_source: null, total_tokens: null });
    } finally {
      importOnly.close?.();
    }
  });

  it('leaves a total the runtime did report exactly as it was', function () {
    const first = new AppDatabase({ dataDir: dir });
    first.raw
      .prepare(`
        INSERT INTO usage_jobs (
          id, session_id, native_session_id, turn_id, user_id, user_login, agent, model,
          project, project_source, started_at, ended_at, duration_ms, outcome, turns, tool_calls,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          reasoning_tokens, total_tokens, cost_usd, reports_usage, reports_cost
        ) VALUES ('codex-1', 's', NULL, 't', 7, 'octocat', 'codex', NULL, NULL, NULL,
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z', 60000, 'completed', 1, 0,
          100, 50, 10, NULL, 0, 150, 0.1, 1, 1)
      `)
      .run();
    first.close?.();

    // codex counts its cached input inside its input: adding the parts would
    // bill those 10 tokens twice, and its own 150 is the only right answer.
    const store = new UsageStore(new AppDatabase({ dataDir: dir }));
    assert.strictEqual(store.history({ userId: 7, scope: 'self' }).jobs[0].totalTokens, 150);
  });
});
