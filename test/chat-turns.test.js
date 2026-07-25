const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Turn grouping is what the index, the sticky strip and "jump to turn 12" all
// read. It is pure, so it is tested directly rather than through a render —
// but it lives under src/client, which only ever reaches Node through esbuild.

const ROOT = path.join(__dirname, '..');
const CHAT_DIR = path.join(ROOT, 'src', 'client', 'chat');

let bundle;
let mod;

before(function () {
  this.timeout(60000);

  const contents = [
    `export * from ${JSON.stringify(path.join(CHAT_DIR, 'turns'))};`,
  ].join('\n');

  bundle = path.join(os.tmpdir(), `chat-turns-${process.pid}.js`);
  require('esbuild').buildSync({
    stdin: { contents, resolveDir: ROOT, loader: 'ts', sourcefile: 'chat-turns.ts' },
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

let seq = 0;

function msg(role, blocks, extra = {}) {
  seq += 1;
  return {
    id: `m${seq}`,
    seq,
    turnId: `t${seq}`,
    role,
    ts: seq * 1000,
    blocks,
    ...extra,
  };
}

function text(value) {
  return { kind: 'text', text: value };
}

function tool(status, extra = {}) {
  return {
    kind: 'tool',
    toolId: `tool-${Math.random().toString(36).slice(2)}`,
    name: 'bash',
    toolKind: 'execute',
    status,
    ...extra,
  };
}

function thinking(value = 'weighing it up') {
  return { kind: 'thinking', text: value };
}

beforeEach(function () {
  seq = 0;
});

describe('groupTurns', function () {
  it('starts a turn at every user message and ends it before the next', function () {
    const messages = [
      msg('user', [text('run the tests')]),
      msg('assistant', [text('all green')]),
      msg('user', [text('now deploy')]),
      msg('assistant', [text('deployed')]),
    ];

    const turns = mod.groupTurns(messages, 'idle');

    assert.strictEqual(turns.length, 2);
    assert.deepStrictEqual(turns.map((t) => t.label), ['run the tests', 'now deploy']);
    assert.deepStrictEqual(turns.map((t) => t.index), [1, 2]);
    assert.deepStrictEqual(turns[0].messageIds, ['m1', 'm2']);
    assert.deepStrictEqual(turns[1].messageIds, ['m3', 'm4']);
  });

  it('does not drop messages that arrive before the first user turn', function () {
    // A resumed transcript's tail, or a compaction marker replayed on join.
    // They are on screen, so they need a strip and an index row like anything
    // else — silently omitting them would leave the transcript with a
    // headerless region nothing in the index points at.
    const messages = [
      msg('system', [{ kind: 'notice', notice: 'compacted', text: 'Context compacted' }]),
      msg('user', [text('carry on')]),
    ];

    const turns = mod.groupTurns(messages, 'idle');

    assert.strictEqual(turns.length, 2);
    assert.strictEqual(turns[0].label, 'Context compacted');
    assert.deepStrictEqual(turns[0].messageIds, ['m1']);
  });

  it('takes only the first line of a multi-line ask as the label', function () {
    const messages = [msg('user', [text('fix the pty test\n\nit times out on the second write')])];
    assert.strictEqual(mod.groupTurns(messages, 'idle')[0].label, 'fix the pty test');
  });

  it('names an attachments-only turn rather than leaving it blank', function () {
    const messages = [msg('user', [{ kind: 'image', mime: 'image/png', url: '/a.png' }])];
    assert.strictEqual(mod.groupTurns(messages, 'idle')[0].label, 'attachment');
  });

  it('returns nothing for an empty transcript', function () {
    assert.deepStrictEqual(mod.groupTurns([], 'idle'), []);
  });

  describe('status', function () {
    it('marks only the last turn as running, never the earlier ones', function () {
      // Session state is session-wide; reading it onto every turn is how every
      // row in the index ends up spinning at once.
      const messages = [
        msg('user', [text('first')]),
        msg('assistant', [text('done')]),
        msg('user', [text('second')]),
        msg('assistant', [text('working')], { streaming: true }),
      ];

      const turns = mod.groupTurns(messages, 'running');

      assert.strictEqual(turns[0].status, 'done');
      assert.strictEqual(turns[1].status, 'running');
    });

    it('reports waiting when the session is blocked on an approval', function () {
      const messages = [msg('user', [text('rm the build dir')]), msg('assistant', [tool('pending')])];
      assert.strictEqual(mod.groupTurns(messages, 'awaiting_permission')[0].status, 'waiting');
    });

    it('reports failed for a turn holding a failed tool call', function () {
      const messages = [
        msg('user', [text('run it')]),
        msg('assistant', [tool('failed')]),
        msg('user', [text('and again')]),
      ];
      assert.strictEqual(mod.groupTurns(messages, 'idle')[0].status, 'failed');
    });

    it('reports failed for a turn holding an error block', function () {
      const messages = [msg('user', [text('go')]), msg('assistant', [{ kind: 'error', text: 'stdio closed' }])];
      assert.strictEqual(mod.groupTurns(messages, 'idle')[0].status, 'failed');
    });

    it('does not treat a denied call as a failure', function () {
      // "You refused this" is not "this broke", and the index must not paint
      // the user's own decision red.
      const messages = [msg('user', [text('go')]), msg('assistant', [tool('denied')])];
      assert.strictEqual(mod.groupTurns(messages, 'idle')[0].status, 'done');
    });
  });

  it('counts tools and reasoning across every message in the turn', function () {
    const messages = [
      msg('user', [text('investigate')]),
      msg('assistant', [thinking(), tool('completed'), tool('completed')]),
      msg('assistant', [thinking(), text('here is what I found')]),
    ];

    const turn = mod.groupTurns(messages, 'idle')[0];
    assert.strictEqual(turn.toolCount, 2);
    assert.strictEqual(turn.reasoningCount, 2);
  });

  it('sums usage over the turn rather than reporting the last message only', function () {
    const messages = [
      msg('user', [text('go')]),
      msg('assistant', [text('a')], { usage: { outputTokens: 100, costUsd: 0.01 } }),
      msg('assistant', [text('b')], { usage: { outputTokens: 50, costUsd: 0.02 } }),
    ];

    const turn = mod.groupTurns(messages, 'idle')[0];
    assert.strictEqual(turn.usage.outputTokens, 150);
    assert.ok(Math.abs(turn.usage.costUsd - 0.03) < 1e-9);
  });

  it('leaves a running turn without a duration', function () {
    // A "duration so far" frozen at whatever the last event stamped reads as a
    // finished number, and is not one.
    const messages = [msg('user', [text('go')]), msg('assistant', [text('…')], { streaming: true })];
    assert.strictEqual(mod.groupTurns(messages, 'running')[0].durationMs, undefined);
  });

  it('measures a finished turn from its opening message', function () {
    const messages = [msg('user', [text('go')]), msg('assistant', [text('done')])];
    assert.strictEqual(mod.groupTurns(messages, 'idle')[0].durationMs, 1000);
  });
});

describe('turnOf', function () {
  it('finds the turn a message belongs to', function () {
    const messages = [
      msg('user', [text('one')]),
      msg('assistant', [text('a')]),
      msg('user', [text('two')]),
      msg('assistant', [text('b')]),
    ];
    const turns = mod.groupTurns(messages, 'idle');

    assert.strictEqual(mod.turnOf('m4', turns).label, 'two');
    assert.strictEqual(mod.turnOf('nope', turns), undefined);
  });
});

describe('formatTurnMeta', function () {
  it('says nothing rather than zero for a turn that did nothing', function () {
    const messages = [msg('user', [text('hello')]), msg('assistant', [text('hi')])];
    const meta = mod.formatTurnMeta(mod.groupTurns(messages, 'idle')[0]);

    assert.strictEqual(meta.tools, '');
    assert.strictEqual(meta.reasoning, '');
    assert.strictEqual(meta.cost, '');
  });

  it('pluralises tools and formats money to four places', function () {
    const messages = [
      msg('user', [text('go')]),
      msg('assistant', [tool('completed')], { usage: { costUsd: 0.0412 } }),
    ];
    const meta = mod.formatTurnMeta(mod.groupTurns(messages, 'idle')[0]);

    assert.strictEqual(meta.tools, '1 tool');
    assert.strictEqual(meta.cost, '$0.0412');
  });
});
