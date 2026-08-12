const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Streaming content mutates one message in place. These tests exercise the
// selector that feeds both live activity surfaces and count target reads, so a
// future accidental whole-transcript scan fails deterministically rather than
// relying on a machine-dependent timing threshold.

const ROOT = path.join(__dirname, '..');

let bundle;
let mod;

before(function () {
  this.timeout(60000);

  const contents = [
    `export { ChatTranscript } from ${JSON.stringify(path.join(ROOT, 'src/client/chat/transcript'))};`,
    `export { projectedActivityEvents } from ${JSON.stringify(path.join(ROOT, 'src/client/chat/activity-projection'))};`,
    `export { ribbonLabel } from ${JSON.stringify(path.join(ROOT, 'src/client/shell/chat/StreamRibbon'))};`,
  ].join('\n');

  bundle = path.join(os.tmpdir(), `chat-activity-projection-${process.pid}.js`);
  require('esbuild').buildSync({
    stdin: { contents, resolveDir: ROOT, loader: 'tsx', sourcefile: 'chat-activity-projection.tsx' },
    bundle: true,
    outfile: bundle,
    format: 'cjs',
    platform: 'node',
    target: ['node20'],
    logLevel: 'silent',
  });
  mod = require(bundle);
});

after(function () {
  if (bundle) fs.rmSync(bundle, { force: true });
});

function message(id, blocks, extra = {}) {
  return {
    id,
    seq: Number(id.replace(/\D/g, '')) || 1,
    turnId: 'turn-1',
    role: 'assistant',
    ts: 1,
    blocks,
    ...extra,
  };
}

function countedTool(id, command, counter, status = 'completed') {
  const block = {
    kind: 'tool',
    toolId: id,
    name: 'bash',
    toolKind: 'execute',
    status,
  };
  Object.defineProperty(block, 'input', {
    enumerable: true,
    configurable: true,
    get() {
      counter.reads += 1;
      return { command };
    },
  });
  return block;
}

function transcript(messages, cursor = messages.length) {
  const value = new mod.ChatTranscript();
  value.hydrate({
    sessionId: `session-${Math.random()}`,
    runtime: 'claude',
    messages,
    state: 'running',
    capabilities: value.capabilities,
    pendingPermissions: [],
    firstSeq: 0,
    replayFrom: 0,
    cursor,
    live: true,
    bypassPermissions: false,
  });
  return value;
}

describe('incremental activity projection', function () {
  it('does not revisit historical activity for streamed answer text', function () {
    const counter = { reads: 0 };
    const messages = [];
    for (let i = 1; i <= 400; i += 1) {
      messages.push(message(`m${i}`, [countedTool(`tool-${i}`, `command ${i}`, counter)]));
    }
    const live = message('m401', [{ kind: 'text', text: '' }], { streaming: true });
    messages.push(live);
    const value = transcript(messages, 401);

    const first = mod.projectedActivityEvents(value);
    const initialReads = counter.reads;
    const initialVersion = value.getContentVersion();
    assert.strictEqual(first.length, 400);
    assert.ok(initialReads >= 400, 'the baseline must actually derive every historical tool');

    for (let seq = 402; seq <= 501; seq += 1) {
      value.apply({
        t: 'block_delta',
        seq,
        ts: seq,
        msgId: live.id,
        index: 0,
        text: 'x',
      });
    }

    const changes = value.contentChangesSince(initialVersion);
    assert.ok(changes);
    assert.strictEqual(changes.length, 1, 'consecutive deltas for one message must coalesce');

    const second = mod.projectedActivityEvents(value);
    assert.strictEqual(second, first, 'answer text adds no activity and should keep the projection');
    assert.strictEqual(
      counter.reads,
      initialReads,
      'no historical tool target may be read again for answer text',
    );

    // The trace and live ribbon ask independently during one React update. The
    // shared selector must make the second consumer a zero-work cache hit.
    assert.strictEqual(mod.projectedActivityEvents(value), second);
    assert.strictEqual(counter.reads, initialReads);
  });

  it('reprojects only the named message, even when it is in the middle', function () {
    const counters = [{ reads: 0 }, { reads: 0 }, { reads: 0 }];
    const messages = counters.map((counter, index) => message(
      `m${index + 1}`,
      [countedTool(`tool-${index + 1}`, `command ${index + 1}`, counter)],
    ));
    const value = transcript(messages, 3);
    const first = mod.projectedActivityEvents(value);
    const before = [...first];
    const reads = counters.map((counter) => counter.reads);

    value.apply({
      t: 'tool',
      seq: 4,
      ts: 4,
      toolId: 'tool-2',
      patch: { status: 'running' },
    });
    const second = mod.projectedActivityEvents(value);

    assert.strictEqual(second, first, 'the event container is updated without copying history');
    assert.strictEqual(second[0], before[0], 'the earlier event object stays stable');
    assert.notStrictEqual(second[1], before[1], 'the changed event gets a new snapshot');
    assert.strictEqual(second[2], before[2], 'the later event object stays stable');
    assert.strictEqual(counters[0].reads, reads[0]);
    assert.ok(counters[1].reads > reads[1]);
    assert.strictEqual(counters[2].reads, reads[2]);
  });

  it('isolates caches by transcript and resets safely on hydration', function () {
    const aCount = { reads: 0 };
    const bCount = { reads: 0 };
    const a = transcript([message('m1', [countedTool('tool-1', 'alpha', aCount)])]);
    const b = transcript([message('m1', [countedTool('tool-1', 'beta', bCount)])]);

    const aFirst = mod.projectedActivityEvents(a);
    const bFirst = mod.projectedActivityEvents(b);
    const aFirstEvent = aFirst[0];
    assert.notStrictEqual(aFirst, bFirst);
    assert.strictEqual(aFirst[0].target, 'alpha');
    assert.strictEqual(bFirst[0].target, 'beta');

    const replacementCount = { reads: 0 };
    a.hydrate({
      sessionId: 'session-rehydrated',
      runtime: 'claude',
      messages: [message('m1', [countedTool('tool-1', 'replacement', replacementCount)])],
      state: 'idle',
      capabilities: a.capabilities,
      pendingPermissions: [],
      firstSeq: 0,
      replayFrom: 0,
      cursor: 2,
      live: false,
      bypassPermissions: false,
    });

    const aSecond = mod.projectedActivityEvents(a);
    assert.strictEqual(aSecond, aFirst, 'reset replaces contents without replacing the container');
    assert.notStrictEqual(aSecond[0], aFirstEvent);
    assert.strictEqual(aSecond[0].target, 'replacement');
    assert.strictEqual(mod.projectedActivityEvents(b), bFirst, 'another session is untouched');
  });

  it('keeps display-setting projections independent', function () {
    const value = transcript([
      message('m1', [
        { kind: 'thinking', text: 'considering' },
        {
          kind: 'tool', toolId: 'tool-1', name: 'bash', toolKind: 'execute',
          status: 'completed', input: { command: 'npm test' },
        },
      ]),
    ]);

    const all = mod.projectedActivityEvents(value);
    const tools = mod.projectedActivityEvents(value, { reasoning: false });
    assert.deepStrictEqual(all.map((event) => event.kind), ['reasoning', 'tool']);
    assert.deepStrictEqual(tools.map((event) => event.kind), ['tool']);
    assert.strictEqual(mod.projectedActivityEvents(value), all);
    assert.strictEqual(mod.projectedActivityEvents(value, { reasoning: false }), tools);
  });

  it('rebuilds safely when a consumer falls behind the bounded change journal', function () {
    const counters = [{ reads: 0 }, { reads: 0 }];
    const value = transcript(counters.map((counter, index) => message(
      `m${index + 1}`,
      [countedTool(`tool-${index + 1}`, `command ${index + 1}`, counter, 'running')],
    )), 2);
    const projection = mod.projectedActivityEvents(value);
    const version = value.getContentVersion();
    const initialReads = counters.map((counter) => counter.reads);

    for (let offset = 0; offset < 65; offset += 1) {
      value.apply({
        t: 'tool',
        seq: 3 + offset,
        ts: 3 + offset,
        toolId: `tool-${(offset % 2) + 1}`,
        patch: { status: offset === 64 ? 'completed' : 'running' },
      });
    }

    assert.strictEqual(value.contentChangesSince(version), null, 'the old journal cursor must expire');
    const rebuilt = mod.projectedActivityEvents(value);
    assert.strictEqual(rebuilt, projection, 'a fallback rebuild keeps the shared container stable');
    assert.strictEqual(rebuilt[0].status, 'completed');
    assert.ok(counters[0].reads > initialReads[0]);
    assert.ok(counters[1].reads > initialReads[1]);
  });

  it('finds the ribbon label from the tail without filtering all history', function () {
    const history = [];
    for (let i = 0; i < 1000; i += 1) {
      history.push({
        id: `old:${i}`,
        messageId: `old-${i}`,
        blockIndex: 0,
        kind: 'tool',
        name: 'bash',
        target: `command ${i}`,
        status: 'completed',
        touchesFiles: false,
        block: {},
        ts: i,
      });
    }
    history.push({
      id: 'live:0',
      messageId: 'live',
      blockIndex: 0,
      kind: 'tool',
      name: 'bash',
      target: 'npm test',
      status: 'running',
      touchesFiles: false,
      block: {},
      ts: 1001,
    });

    let indexedReads = 0;
    const observed = new Proxy(history, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) indexedReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });

    assert.strictEqual(
      mod.ribbonLabel(observed, new Set(['live']), 'running'),
      'Working \u2014 bash npm test',
    );
    assert.strictEqual(indexedReads, 1, 'the live tail should end the reverse scan immediately');
  });
});
