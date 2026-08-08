/**
 * Which model actually ran, per agent (#75).
 *
 * The distinction every case here turns on is between the model this app
 * *asked for* and the model the runtime says it *ran*. Only the second one is a
 * measurement, and only the second one belongs in a spend record — a requested
 * model rendered plainly is worse than a blank, because it looks like a fact.
 *
 * Every fixture is real output, captured from the installed binary rather than
 * written to match this code: `grok -p ... --output-format streaming-json`,
 * `claude -p ... --output-format stream-json`, `pi --mode json -p ...`,
 * `grok models` and `pi --list-models`. An agent that goes quiet about its
 * model in a later version fails here, which is the point.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ClaudeChatAdapter } = require('../dist/server/chat/adapters/claude.js');
const { PiChatAdapter } = require('../dist/server/chat/adapters/pi.js');
const { mapModelUsage } = require('../dist/server/chat/adapters/model-usage.js');
const { installedModels, resetInstalledModels } = require('../dist/server/chat/installed-models.js');
const { UsageAccountant } = require('../dist/server/chat/usage-accounting.js');
const { UsageStore } = require('../dist/server/services/usage-store.js');
const { AppDatabase } = require('../dist/server/services/database.js');
const { createTranscript, applyChatEvent } = require('../dist/shared/chat-reducer.js');

function fixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', 'chat', name), 'utf8');
}

function fixtureLines(name) {
  return fixture(name)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function collect(Adapter, options) {
  const events = [];
  const adapter = new Adapter({
    sessionId: 's1',
    workingDir: '/work',
    command: '/does/not/matter',
    emit: (event) => events.push(event),
    ...options,
  });
  return { adapter, events };
}


describe('which model actually ran', () => {
  /**
   * Grok's own model reporting moved with it.
   *
   * The headless adapter these cases drove was deleted in #73, which put grok
   * on ACP — where the model is not something the app infers from a finished
   * turn at all: the agent publishes its list and its current selection during
   * the handshake, and `session/set_model` changes it. That is asserted against
   * the real ACP capture in `chat-tool-activity.test.js` ("names the model it
   * is actually running", "and the models it offers"), and the money filed
   * against it in `usage-live-vs-history.test.js`. Nothing about the claim this
   * file makes was dropped; the surface that answers it changed.
   */

  describe('claude, whose billing name is not the name it shows', () => {
    it('records the canonical model, the one its messages carry', () => {
      const { adapter, events } = collect(ClaudeChatAdapter, {});
      adapter.activeTurnId = 't1';
      adapter.handleMessage(fixtureLines('claude-model-usage.jsonl')[0]);

      const turnEnd = events.find((event) => event.t === 'turn_end');
      assert.strictEqual(turnEnd.models.length, 1);
      // The key was `claude-opus-5[1m]`; the conversation shows `claude-opus-5`,
      // and filing the alias would put the two views permanently at odds.
      assert.strictEqual(turnEnd.models[0].model, 'claude-opus-5');
      assert.strictEqual(turnEnd.models[0].usage.costUsd, 0.15501900000000002);
    });

    it('reports a delegated turn as two models, not as one', () => {
      const raw = JSON.parse(fixture('claude-model-usage.jsonl').trim());
      raw.modelUsage['claude-haiku-4-5'] = {
        inputTokens: 900,
        outputTokens: 120,
        costUSD: 0.004,
        canonicalModel: 'claude-haiku-4-5',
      };
      const { adapter, events } = collect(ClaudeChatAdapter, {});
      adapter.activeTurnId = 't1';
      adapter.handleMessage(raw);

      const turnEnd = events.find((event) => event.t === 'turn_end');
      assert.deepStrictEqual(
        turnEnd.models.map((entry) => entry.model).sort(),
        ['claude-haiku-4-5', 'claude-opus-5'],
      );
    });

    it('never lets the models cost more than the turn they were part of', () => {
      // claude's `total_cost_usd` is cumulative over a conversation — the whole
      // reason `turnCost` exists — and `modelUsage.costUSD` is a slice of that
      // same counter. Straight through, the second turn would file a
      // whole-conversation cost against the models inside a turn that cost a
      // fraction of it, and the by-model view would climb past the total it is
      // a breakdown of.
      const line = () => JSON.parse(fixture('claude-model-usage.jsonl').trim());
      const { adapter, events } = collect(ClaudeChatAdapter, {});

      adapter.activeTurnId = 't1';
      const first = line();
      first.total_cost_usd = 1;
      first.modelUsage['claude-opus-5[1m]'].costUSD = 1;
      adapter.handleMessage(first);

      adapter.activeTurnId = 't2';
      const second = line();
      second.total_cost_usd = 3; // the counter carried the first turn with it
      second.modelUsage['claude-opus-5[1m]'].costUSD = 1.5;
      second.modelUsage['claude-haiku-4-5'] = { costUSD: 1.5, canonicalModel: 'claude-haiku-4-5' };
      adapter.handleMessage(second);

      const turns = events.filter((event) => event.t === 'turn_end');
      assert.strictEqual(turns[1].usage.costUsd, 2); // 3 reported minus 1 already billed
      const split = turns[1].models.reduce((total, entry) => total + entry.usage.costUsd, 0);
      assert.strictEqual(Math.round(split * 1e6), Math.round(2 * 1e6));
      // The shares are still the runtime's own: half each, here.
      assert.deepStrictEqual(turns[1].models.map((entry) => entry.usage.costUsd), [1, 1]);
    });

    it('names the models even when there is no cost to divide between them', () => {
      const raw = JSON.parse(fixture('claude-model-usage.jsonl').trim());
      delete raw.total_cost_usd;
      delete raw.modelUsage['claude-opus-5[1m]'].costUSD;
      const { adapter, events } = collect(ClaudeChatAdapter, {});
      adapter.activeTurnId = 't1';
      adapter.handleMessage(raw);

      const turnEnd = events.find((event) => event.t === 'turn_end');
      assert.strictEqual(turnEnd.models[0].model, 'claude-opus-5');
      assert.strictEqual(turnEnd.models[0].usage.costUsd, undefined);
      assert.strictEqual(turnEnd.models[0].usage.inputTokens, 2);
    });

    it('leaves the key alone when there is no canonical name beside it', () => {
      assert.deepStrictEqual(mapModelUsage({ modelUsage: { 'some-model': { modelCalls: 2 } } }), [
        { model: 'some-model', calls: 2 },
      ]);
    });

    it('says nothing rather than zero when a model was named with no figures', () => {
      const [entry] = mapModelUsage({ modelUsage: { 'some-model': {} } });
      assert.strictEqual(entry.model, 'some-model');
      assert.strictEqual(entry.usage, undefined);
      assert.strictEqual(entry.calls, undefined);
    });

    it('treats a runtime that reported no breakdown as silent, not as empty', () => {
      assert.strictEqual(mapModelUsage({}), undefined);
      assert.strictEqual(mapModelUsage({ modelUsage: {} }), undefined);
      assert.strictEqual(mapModelUsage({ modelUsage: 'nonsense' }), undefined);
    });
  });

  describe('pi, which said the right thing everywhere but the session line', () => {
    it('reports the model its own messages carried', () => {
      const { adapter, events } = collect(PiChatAdapter, { model: 'openai/gpt-5' });
      adapter.turnInFlight = true;
      adapter.currentTurnId = 't1';
      adapter.turnCounter = 1;
      for (const line of fixtureLines('pi-full-invocation.jsonl')) adapter.handleMessage(line);

      const turnEnd = events.find((event) => event.t === 'turn_end');
      assert.strictEqual(turnEnd.models.length, 1);
      assert.strictEqual(turnEnd.models[0].model, 'moonshotai/kimi-k3');
      assert.ok(turnEnd.models[0].calls >= 1);
      // `openai/gpt-5` was the request and appears nowhere in what was recorded.
      assert.ok(!JSON.stringify(turnEnd).includes('openai/gpt-5'));
    });

    it('does not put the requested model on the session line', () => {
      const { events } = (() => {
        const made = collect(PiChatAdapter, { model: 'openai/gpt-5' });
        for (const line of fixtureLines('pi-session.jsonl')) made.adapter.handleMessage(line);
        return made;
      })();
      const session = events.find((event) => event.t === 'session');
      assert.strictEqual(session.model, undefined);
    });

    it('counts one message as one call, so a two-message turn is two', () => {
      const { adapter, events } = collect(PiChatAdapter, {});
      adapter.turnInFlight = true;
      adapter.currentTurnId = 't1';
      adapter.turnCounter = 1;
      const message = (model) => ({
        role: 'assistant',
        model,
        content: [{ type: 'text', text: 'hi' }],
        usage: { input: 10, output: 5, cost: { total: 0.01 } },
      });
      adapter.handleMessage({ type: 'message_start', message: message('a/one') });
      adapter.handleMessage({ type: 'message_end', message: message('a/one') });
      adapter.handleMessage({ type: 'message_start', message: message('a/one') });
      adapter.handleMessage({ type: 'message_end', message: message('a/one') });
      adapter.handleMessage({ type: 'agent_settled' });

      const turnEnd = events.find((event) => event.t === 'turn_end');
      assert.strictEqual(turnEnd.models.length, 1);
      assert.strictEqual(turnEnd.models[0].calls, 2);
    });

    it('reports a turn that fell back to another model as both', () => {
      const { adapter, events } = collect(PiChatAdapter, {});
      adapter.turnInFlight = true;
      adapter.currentTurnId = 't1';
      adapter.turnCounter = 1;
      const message = (model) => ({
        role: 'assistant',
        model,
        content: [{ type: 'text', text: 'hi' }],
        usage: { input: 10, output: 5, cost: { total: 0.01 } },
      });
      adapter.handleMessage({ type: 'message_start', message: message('a/one') });
      adapter.handleMessage({ type: 'message_end', message: message('a/one') });
      adapter.handleMessage({ type: 'message_start', message: message('b/two') });
      adapter.handleMessage({ type: 'message_end', message: message('b/two') });
      adapter.handleMessage({ type: 'agent_settled' });

      const turnEnd = events.find((event) => event.t === 'turn_end');
      assert.deepStrictEqual(turnEnd.models.map((entry) => entry.model), ['a/one', 'b/two']);
    });

    it('carries no models key at all for a turn that reached no model', () => {
      const { adapter, events } = collect(PiChatAdapter, {});
      adapter.turnInFlight = true;
      adapter.currentTurnId = 't1';
      adapter.turnCounter = 1;
      adapter.handleMessage({ type: 'agent_settled' });

      const turnEnd = events.find((event) => event.t === 'turn_end');
      assert.ok(!('models' in turnEnd));
    });
  });

  describe('what the conversation shows', () => {
    const replay = (events) => {
      const state = createTranscript({});
      let seq = 0;
      for (const event of events) applyChatEvent(state, { seq: (seq += 1), ts: seq, ...event });
      return state;
    };

    it('names the model a turn reported, for a conversation that opened with none', () => {
      const state = replay([
        { t: 'msg_start', id: 'u1', role: 'user', turnId: 't1' },
        { t: 'msg_start', id: 'a1', role: 'assistant', turnId: 't1' },
        { t: 'turn_end', turnId: 't1', models: [{ model: 'grok-build', calls: 1 }] },
      ]);
      assert.strictEqual(state.model, 'grok-build');
      // And the message that was already on screen stops being anonymous.
      assert.strictEqual(state.messages[1].model, 'grok-build');
    });

    it('keeps the model that answered when a turn was split across several', () => {
      const state = replay([
        { t: 'msg_start', id: 'a1', role: 'assistant', turnId: 't1', model: 'claude-opus-5' },
        {
          t: 'turn_end',
          turnId: 't1',
          models: [
            { model: 'claude-opus-5', calls: 3 },
            { model: 'claude-haiku-4-5', calls: 11 },
          ],
        },
      ]);
      // Not the busiest — the one that actually answered in the transcript.
      assert.strictEqual(state.model, 'claude-opus-5');
      assert.deepStrictEqual(state.turnModels, ['claude-opus-5', 'claude-haiku-4-5']);
    });

    it('does not keep last turn split on the next turn', () => {
      const state = replay([
        { t: 'msg_start', id: 'u1', role: 'user', turnId: 't1' },
        {
          t: 'turn_end',
          turnId: 't1',
          models: [{ model: 'one', calls: 1 }, { model: 'two', calls: 1 }],
        },
        { t: 'msg_start', id: 'u2', role: 'user', turnId: 't2' },
      ]);
      // The next turn has not reported anything yet, and last turn's models are
      // not a claim about it.
      assert.strictEqual(state.turnModels, undefined);
    });

    it('falls back to the busiest only when no message named one', () => {
      const state = replay([
        { t: 'msg_start', id: 'a1', role: 'assistant', turnId: 't1' },
        {
          t: 'turn_end',
          turnId: 't1',
          models: [
            { model: 'quiet', calls: 1 },
            { model: 'busy', calls: 9 },
          ],
        },
      ]);
      assert.strictEqual(state.model, 'busy');
      // Two models ran, so no message is renamed after either of them.
      assert.strictEqual(state.messages[0].model, undefined);
    });
  });

  describe('the record, when a turn ran on more than one model', () => {
    let dir;
    let store;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-models-'));
      store = new UsageStore(new AppDatabase({ dataDir: dir }));
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
      model: 'claude-opus-5',
      project: null,
      startedAt: '2026-03-04T10:00:00.000Z',
      endedAt: '2026-03-04T10:01:00.000Z',
      durationMs: 60000,
      outcome: 'completed',
      modelTurns: 4,
      toolCalls: 3,
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
      totalTokens: 1200,
      costUsd: 1,
      reportsUsage: true,
      reportsCost: true,
      tools: [{ tool: 'Task', calls: 1 }],
      models: [],
      ...over,
    });

    const split = [
      {
        model: 'claude-opus-5',
        calls: 3,
        inputTokens: 800,
        outputTokens: 150,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        costUsd: 0.75,
      },
      {
        model: 'claude-haiku-4-5',
        calls: 1,
        inputTokens: 200,
        outputTokens: 50,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        costUsd: 0.25,
      },
    ];

    const dashboard = (over = {}) =>
      store.dashboard(
        {
          userId: 1,
          scope: 'self',
          period: 'month',
          anchor: new Date('2026-03-04T12:00:00.000Z'),
          ...over,
        },
        false,
      );

    it('does not file the whole turn against the model that answered', () => {
      store.record(job({ models: split }));
      const byModel = dashboard().byModel;
      const opus = byModel.find((row) => row.key === 'claude-opus-5');
      const haiku = byModel.find((row) => row.key === 'claude-haiku-4-5');
      assert.strictEqual(opus.totals.costUsd, 0.75);
      assert.strictEqual(haiku.totals.costUsd, 0.25);
    });

    it('adds up to the same total the headline figure does', () => {
      store.record(job({ models: split }));
      store.record(job({ turnId: 't2', model: 'gpt-5.5', agent: 'codex', costUsd: 2, models: [] }));
      const view = dashboard();
      const summed = view.byModel.reduce((total, row) => total + row.totals.costUsd, 0);
      assert.strictEqual(Math.round(summed * 1000), Math.round(view.totals.costUsd * 1000));
    });

    it('leaves a job with one model exactly as it was', () => {
      store.record(job({ models: [] }));
      const byModel = dashboard().byModel;
      assert.strictEqual(byModel.length, 1);
      assert.strictEqual(byModel[0].key, 'claude-opus-5');
      assert.strictEqual(byModel[0].totals.costUsd, 1);
      assert.strictEqual(byModel[0].totals.toolCalls, 3);
      // One turn, whose runtime said it took four round trips.
      assert.strictEqual(byModel[0].totals.turns, 1);
      assert.strictEqual(byModel[0].totals.modelTurns, 4);
    });

    it('counts a split job once against each model it touched', () => {
      store.record(job({ models: split }));
      for (const row of dashboard().byModel) assert.strictEqual(row.totals.turns, 1);
    });

    it('takes the runtime own per-model call count as that model round trips', () => {
      store.record(job({ models: split }));
      const byModel = dashboard().byModel;
      assert.strictEqual(byModel.find((row) => row.key === 'claude-opus-5').totals.modelTurns, 3);
      assert.strictEqual(byModel.find((row) => row.key === 'claude-haiku-4-5').totals.modelTurns, 1);
    });

    it('attributes no tool call to a model nobody said made it', () => {
      store.record(job({ models: split }));
      for (const row of dashboard().byModel) assert.strictEqual(row.totals.toolCalls, 0);
    });

    it('finds the job when the model asked about only ran as a subagent', () => {
      store.record(job({ models: split }));
      const view = dashboard({ model: 'claude-haiku-4-5' });
      assert.strictEqual(view.totals.turns, 1);
      const history = store.history({ userId: 1, scope: 'self', model: 'claude-haiku-4-5' });
      assert.strictEqual(history.total, 1);
      assert.strictEqual(history.jobs[0].turnId, 't1');
    });

    it('offers that model in the filter menu, not only the answering one', () => {
      store.record(job({ models: split }));
      assert.deepStrictEqual(store.facets({ userId: 1, scope: 'self' }).models, [
        'claude-haiku-4-5',
        'claude-opus-5',
      ]);
    });

    it('keeps the split out of another user view', () => {
      store.record(job({ models: split }));
      const theirs = store.dashboard(
        { userId: 2, scope: 'self', period: 'month', anchor: new Date('2026-03-04T12:00:00.000Z') },
        false,
      );
      assert.deepStrictEqual(theirs.byModel, []);
      assert.deepStrictEqual(store.facets({ userId: 2, scope: 'self' }).models, []);
    });

    it('makes the split reachable on the job itself', () => {
      const id = store.record(job({ models: split }));
      const record = store.job(id, { userId: 1, scope: 'self' });
      assert.deepStrictEqual(record.models.map((entry) => entry.model), [
        'claude-opus-5',
        'claude-haiku-4-5',
      ]);
      assert.strictEqual(record.models[0].calls, 3);
    });

    it('replaces the split when the same job is recorded again', () => {
      store.record(job({ models: split }));
      const id = store.record(job({ models: [split[0]] }));
      assert.strictEqual(store.job(id, { userId: 1, scope: 'self' }).models.length, 1);
      const byModel = dashboard().byModel;
      assert.strictEqual(byModel.find((row) => row.key === 'claude-haiku-4-5'), undefined);
    });
  });

  describe('the models a runtime will accept', () => {
    let dir;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-modellist-'));
      resetInstalledModels();
    });

    afterEach(() => {
      resetInstalledModels();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    /** A stand-in binary that prints exactly what the real one printed. */
    function fakeBinary(name, output, { exitCode = 0 } = {}) {
      const file = path.join(dir, name);
      fs.writeFileSync(
        file,
        `#!/bin/sh\ncat <<'MODELS'\n${output}MODELS\nexit ${exitCode}\n`,
        { mode: 0o755 },
      );
      return file;
    }

    it('reads the list grok prints, and marks its default', async () => {
      const models = await installedModels('grok', fakeBinary('grok', fixture('grok-models-list.txt')));
      assert.deepStrictEqual(models.map((m) => m.value), [
        'grok-build',
        'sxs-claude-opus-4-6',
        'grok-experimental-0609-lp-fix-s80',
        'grok-4.5',
      ]);
      assert.strictEqual(models[0].description, 'default');
      assert.strictEqual(models[1].description, undefined);
    });

    it('reads pi table without taking its header for a model', async () => {
      const models = await installedModels('pi', fakeBinary('pi', fixture('pi-models-list.txt')));
      assert.deepStrictEqual(models.map((m) => m.value), [
        '~anthropic/claude-opus-latest',
        'anthropic/claude-opus-4.1',
        'moonshotai/kimi-k3',
      ]);
      assert.strictEqual(models[0].description, 'openrouter');
    });

    it('reads models through a managed Windows npm shim', async function () {
      if (process.platform !== 'win32') this.skip();
      const bin = path.join(dir, 'managed agent', 'prefix', 'bin');
      const entry = path.join(bin, 'node_modules', 'example-pi', 'cli.js');
      fs.mkdirSync(path.dirname(entry), { recursive: true });
      fs.writeFileSync(
        entry,
        `process.stdout.write(${JSON.stringify(fixture('pi-models-list.txt'))});`,
      );
      const shim = path.join(bin, 'pi.cmd');
      fs.writeFileSync(
        shim,
        '@ECHO off\r\n"%dp0%\\node.exe" "%dp0%\\node_modules\\example-pi\\cli.js" %*\r\n',
      );
      const models = await installedModels('pi', shim);
      assert.deepStrictEqual(models.map((model) => model.value), [
        '~anthropic/claude-opus-latest',
        'anthropic/claude-opus-4.1',
        'moonshotai/kimi-k3',
      ]);
    });

    it('takes the list from a CLI that printed it and then exited unhappily', async () => {
      const models = await installedModels(
        'grok',
        fakeBinary('grok', fixture('grok-models-list.txt'), { exitCode: 1 }),
      );
      assert.strictEqual(models.length, 4);
    });

    it('answers nothing, rather than failing, for a binary that is not there', async () => {
      assert.deepStrictEqual(await installedModels('grok', path.join(dir, 'absent')), []);
    });

    it('answers nothing for a runtime that publishes no such command', async () => {
      assert.deepStrictEqual(await installedModels('claude', '/does/not/matter'), []);
    });

    it('asks once per runtime, not once per session', async () => {
      const binary = fakeBinary('grok', fixture('grok-models-list.txt'));
      const first = await installedModels('grok', binary);
      fs.writeFileSync(binary, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      const second = await installedModels('grok', binary);
      assert.deepStrictEqual(second, first);
    });
  });
});
