const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The activity projection is the new home of every reasoning block and tool
// call. Two properties matter more than any formatting detail: ids are stable
// across re-derivation (or an expanded row collapses on the next token), and
// events hold the *live* block (or a running call freezes at whatever its
// arguments were when the list was last built).

const ROOT = path.join(__dirname, '..');
const CHAT_DIR = path.join(ROOT, 'src', 'client', 'chat');

let bundle;
let mod;

before(function () {
  this.timeout(60000);

  const contents = [
    `export * from ${JSON.stringify(path.join(CHAT_DIR, 'activity'))};`,
    `export { groupTurns } from ${JSON.stringify(path.join(CHAT_DIR, 'turns'))};`,
  ].join('\n');

  bundle = path.join(os.tmpdir(), `chat-activity-${process.pid}.js`);
  require('esbuild').buildSync({
    stdin: { contents, resolveDir: ROOT, loader: 'ts', sourcefile: 'chat-activity.ts' },
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
  return { id: `m${seq}`, seq, turnId: 't1', role, ts: seq * 1000, blocks, ...extra };
}

function tool(overrides = {}) {
  return {
    kind: 'tool',
    toolId: 'x1',
    name: 'bash',
    toolKind: 'execute',
    status: 'completed',
    input: { command: 'npm test' },
    ...overrides,
  };
}

beforeEach(function () {
  seq = 0;
});

describe('activityEvents', function () {
  it('emits one event per reasoning block and per tool call, in order', function () {
    const messages = [
      msg('user', [{ kind: 'text', text: 'go' }]),
      msg('assistant', [
        { kind: 'thinking', text: 'think think' },
        tool(),
        { kind: 'text', text: 'done' },
        tool({ toolId: 'x2', name: 'grep', toolKind: 'search', input: { pattern: 'S[1-6]' } }),
      ]),
    ];

    const events = mod.activityEvents(messages);

    assert.deepStrictEqual(events.map((e) => e.kind), ['reasoning', 'tool', 'tool']);
    assert.deepStrictEqual(events.map((e) => e.name), [undefined, 'bash', 'grep']);
  });

  it('gives every event a stable id built from its message and block index', function () {
    const messages = [msg('assistant', [{ kind: 'thinking', text: 'a' }, tool()])];
    const first = mod.activityEvents(messages);
    const second = mod.activityEvents(messages);

    assert.deepStrictEqual(first.map((e) => e.id), ['m1:0', 'm1:1']);
    assert.deepStrictEqual(first.map((e) => e.id), second.map((e) => e.id));
  });

  it('holds the live block rather than a copy of it', function () {
    // The reducer mutates blocks in place. An event that copied would leave a
    // running call showing whatever it looked like when the list was derived.
    const block = tool({ status: 'running', output: '' });
    const messages = [msg('assistant', [block])];
    const [event] = mod.activityEvents(messages);

    block.status = 'completed';
    block.output = '68 passing';

    assert.strictEqual(event.block, block);
    assert.strictEqual(event.block.output, '68 passing');
  });

  it('reuses the tool card’s own target extraction', function () {
    const messages = [msg('assistant', [tool({ input: { command: 'npm run deploy -- --env staging' } })])];
    assert.strictEqual(mod.activityEvents(messages)[0].target, 'npm run deploy -- --env staging');
  });

  it('shows a target for arguments that are still arriving', function () {
    const messages = [
      msg('assistant', [tool({ input: undefined, inputPartial: '{"command": "git status' })]),
    ];
    assert.strictEqual(mod.activityEvents(messages)[0].target, 'receiving arguments…');
  });

  it('treats the open last block of a streaming message as still running', function () {
    const messages = [
      msg('assistant', [{ kind: 'thinking', text: 'still going' }], { streaming: true }),
    ];
    assert.strictEqual(mod.activityEvents(messages)[0].status, 'running');
  });

  it('honours the display settings by leaving blocks out of the projection', function () {
    const messages = [msg('assistant', [{ kind: 'thinking', text: 'a' }, tool()])];

    assert.strictEqual(mod.activityEvents(messages, { reasoning: false }).length, 1);
    assert.strictEqual(mod.activityEvents(messages, { tools: false }).length, 1);
    assert.strictEqual(mod.activityEvents(messages, { tools: false, reasoning: false }).length, 0);
  });
});

describe('filterActivity', function () {
  const messages = () => [
    msg('assistant', [
      { kind: 'thinking', text: 'a' },
      tool({ toolKind: 'execute', input: { command: 'ls' } }),
      tool({ toolKind: 'edit', input: { file_path: 'docs/notes.md' }, diffs: [{ path: 'docs/notes.md', kind: 'update', hunks: [], added: 12, removed: 4 }] }),
    ]),
  ];

  it('keeps everything under "all"', function () {
    assert.strictEqual(mod.filterActivity(mod.activityEvents(messages()), 'all').length, 3);
  });

  it('separates tools from reasoning', function () {
    const events = mod.activityEvents(messages());
    assert.strictEqual(mod.filterActivity(events, 'tools').length, 2);
    assert.strictEqual(mod.filterActivity(events, 'reasoning').length, 1);
  });

  it('narrows "files" to calls that actually touched one', function () {
    const events = mod.activityEvents(messages());
    const files = mod.filterActivity(events, 'files');
    assert.strictEqual(files.length, 1);
    assert.strictEqual(files[0].toolKind, 'edit');
  });
});

describe('activityMeta', function () {
  it('prefers the diff tally over the duration, because it says what happened', function () {
    const messages = [
      msg('assistant', [
        tool({
          toolKind: 'edit',
          durationMs: 400,
          diffs: [{ path: 'a.md', kind: 'update', hunks: [], added: 12, removed: 4 }],
        }),
      ]),
    ];
    assert.strictEqual(mod.activityMeta(mod.activityEvents(messages)[0]), '+12 −4');
  });

  it('falls back to the duration when there is no diff', function () {
    const messages = [msg('assistant', [tool({ durationMs: 2400 })])];
    assert.strictEqual(mod.activityMeta(mod.activityEvents(messages)[0]), '2.4s');
  });

  it('reports reasoning by its size', function () {
    const messages = [msg('assistant', [{ kind: 'thinking', text: 'one\ntwo\nthree' }])];
    assert.ok(/^3 lines · ~\d+ tok$/.test(mod.activityMeta(mod.activityEvents(messages)[0])));
  });
});

describe('activityForTurn', function () {
  it('returns only the events belonging to that turn', function () {
    const messages = [
      msg('user', [{ kind: 'text', text: 'one' }]),
      msg('assistant', [tool()]),
      msg('user', [{ kind: 'text', text: 'two' }]),
      msg('assistant', [tool({ toolId: 'x2', name: 'grep' })]),
    ];
    const turns = mod.groupTurns(messages, 'idle');
    const all = mod.activityEvents(messages);

    assert.deepStrictEqual(mod.activityForTurn(turns[0], all).map((e) => e.name), ['bash']);
    assert.deepStrictEqual(mod.activityForTurn(turns[1], all).map((e) => e.name), ['grep']);
  });
});

describe('workSummary', function () {
  it('reads as a sentence about the work, with no zero counts in it', function () {
    const messages = [
      msg('assistant', [{ kind: 'thinking', text: 'a' }, tool(), tool({ toolId: 'x2' })]),
    ];
    assert.strictEqual(
      mod.workSummary(mod.activityEvents(messages), 8100),
      '2 commands · 1 reasoning · 8.1s',
    );
  });

  it('is empty when there was no work to describe', function () {
    assert.strictEqual(mod.workSummary([]), '');
  });
});
