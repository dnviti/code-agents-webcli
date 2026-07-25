const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ToolCallCard and DiffView are the densest surface in chat mode: every tool
// status, every tool kind and every diff shape lands here. They are .tsx and
// never reach dist/ on their own, so this bundles them for Node the same way
// test/relay-components.test.js bundles the Relay primitives, and renders each
// state. Typechecking proves they compile; only rendering proves that a lookup
// table returns something, that a half-arrived JSON fragment does not throw,
// and that a 10k-line output does not become a 10k-line DOM.

const ROOT = path.join(__dirname, '..');
const CHAT_DIR = path.join(ROOT, 'src', 'client', 'shell', 'chat');

let mod;
let bundle;

before(function () {
  this.timeout(60000);

  const contents = [
    `export { renderToStaticMarkup } from 'react-dom/server';`,
    `export * as React from 'react';`,
    `export { ToolCallCard } from ${JSON.stringify(path.join(CHAT_DIR, 'ToolCallCard'))};`,
    `export { DiffView } from ${JSON.stringify(path.join(CHAT_DIR, 'DiffView'))};`,
  ].join('\n');

  bundle = path.join(os.tmpdir(), `chat-tools-${process.pid}.js`);
  require('esbuild').buildSync({
    // stdin rather than a temp entry file: an entry written to /tmp resolves
    // its bare imports relative to /tmp, where there is no node_modules.
    stdin: { contents, resolveDir: ROOT, loader: 'tsx', sourcefile: 'chat-tools.tsx' },
    bundle: true,
    outfile: bundle,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    target: ['node20'],
    logLevel: 'silent',
  });

  mod = require(bundle);
});

after(function () {
  if (bundle) fs.rmSync(bundle, { force: true });
});

function render(component, props) {
  return mod.renderToStaticMarkup(mod.React.createElement(component, props));
}

function tool(overrides) {
  return Object.assign(
    {
      kind: 'tool',
      toolId: 't1',
      name: 'Read',
      toolKind: 'read',
      status: 'completed',
      input: { file_path: '/repo/src/index.ts' },
    },
    overrides,
  );
}

const STATUSES = ['pending', 'running', 'completed', 'failed', 'denied', 'canceled'];
const KINDS = [
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'task',
  'todo',
  'other',
];

describe('ToolCallCard', function () {
  it('renders every tool status with a distinct glyph and a status word', function () {
    const seen = new Set();
    for (const status of STATUSES) {
      const html = render(mod.ToolCallCard, { block: tool({ status }) });
      assert.ok(html.length > 0, `${status} rendered nothing`);
      // Status must survive the loss of colour: the label is in the markup.
      const label = status.charAt(0).toUpperCase() + status.slice(1);
      assert.ok(html.includes(label), `${status} does not name itself in the markup`);
      const svg = /<svg[\s\S]*?<\/svg>/.exec(html);
      assert.ok(svg, `${status} rendered no status glyph`);
      seen.add(svg[0]);
    }
    // pending and running share the spinner; the other four are distinct.
    assert.ok(seen.size >= 5, 'statuses must not all share one glyph');
  });

  it('spins only while the call is still open', function () {
    for (const status of STATUSES) {
      const html = render(mod.ToolCallCard, { block: tool({ status }) });
      const spinning = html.includes('relay-spin');
      assert.strictEqual(
        spinning,
        status === 'pending' || status === 'running',
        `${status} spin state is wrong`,
      );
    }
  });

  it('renders every tool kind', function () {
    for (const toolKind of KINDS) {
      const html = render(mod.ToolCallCard, {
        block: tool({ toolKind, name: toolKind, input: { file_path: 'a.ts' } }),
      });
      assert.ok(html.length > 0, `${toolKind} rendered nothing`);
      assert.ok(html.includes('<svg'), `${toolKind} rendered no kind icon`);
    }
  });

  it('pulls the target out of the input per kind', function () {
    const cases = [
      [tool({ toolKind: 'execute', input: { command: 'npm test -- --watch' } }), 'npm test'],
      [tool({ toolKind: 'search', input: { pattern: 'TODO', path: 'src' } }), 'TODO'],
      [tool({ toolKind: 'fetch', input: { url: 'https://example.com/a' } }), 'example.com'],
      [
        tool({ toolKind: 'move', input: { source: 'a.ts', destination: 'b.ts' } }),
        'a.ts',
      ],
      [tool({ toolKind: 'todo', input: { todos: [1, 2, 3] } }), '3 items'],
      [tool({ toolKind: 'other', input: {}, locations: ['/repo/only/here.ts'] }), 'here.ts'],
    ];
    for (const [block, expected] of cases) {
      const html = render(mod.ToolCallCard, { block });
      assert.ok(html.includes(expected), `${block.toolKind} summary missing ${expected}`);
    }
  });

  it('shows something sensible while arguments are still streaming', function () {
    const streaming = tool({
      status: 'running',
      input: undefined,
      inputPartial: '{"file_path": "/repo/src/a.ts", "old_str',
    });
    const html = render(mod.ToolCallCard, { block: streaming, defaultOpen: true });
    assert.ok(html.includes('/repo/src/a.ts'), 'target not recovered from partial JSON');
    assert.ok(html.includes('old_str'), 'the raw fragment should still be shown when expanded');

    // A fragment with no complete pair yet must still render, not throw.
    const bare = render(mod.ToolCallCard, {
      block: tool({ status: 'pending', input: undefined, inputPartial: '{"comm' }),
      defaultOpen: true,
    });
    assert.ok(bare.length > 0 && !bare.includes('undefined'), 'bare fragment rendered badly');
  });

  it('keeps the body behind the disclosure until asked', function () {
    const block = tool({ output: 'hello from the tool' });
    const closed = render(mod.ToolCallCard, { block });
    assert.ok(closed.includes('aria-expanded="false"'), 'closed card must report aria-expanded');
    assert.ok(!closed.includes('hello from the tool'), 'output leaked into the closed row');

    const open = render(mod.ToolCallCard, { block, defaultOpen: true });
    assert.ok(open.includes('aria-expanded="true"'), 'open card must report aria-expanded');
    assert.ok(open.includes('hello from the tool'), 'output missing when expanded');
  });

  it('truncates a huge output instead of rendering every line', function () {
    const lines = [];
    for (let i = 0; i < 10000; i += 1) lines.push(`ok ${i} — assertion passed`);
    const html = render(mod.ToolCallCard, {
      block: tool({ toolKind: 'execute', input: { command: 'npm test' }, output: lines.join('\n') }),
      defaultOpen: true,
    });
    assert.ok(html.includes('ok 0 '), 'the head of the output must be shown');
    assert.ok(!html.includes('ok 500 '), 'a clamped output must not carry the whole run');
    assert.ok(/Show \d+ more lines/.test(html), 'no affordance to see the rest');
    assert.ok(html.length < 200000, `clamped output still rendered ${html.length} bytes`);
  });

  it('renders a failure with its error text', function () {
    const html = render(mod.ToolCallCard, {
      block: tool({ status: 'failed', error: 'ENOENT: no such file or directory' }),
      defaultOpen: true,
    });
    assert.ok(html.includes('ENOENT'), 'error text missing');
    assert.ok(html.includes('failed'), 'failed badge missing');
  });

  it('renders an empty call and a call with no arguments at all', function () {
    const bare = render(mod.ToolCallCard, {
      block: { kind: 'tool', toolId: 'x', name: '', toolKind: 'other', status: 'pending' },
      defaultOpen: true,
    });
    assert.ok(bare.length > 0, 'a bare tool block must still render');
    assert.ok(bare.includes('Nothing reported'), 'an empty call should say so');
  });

  it('renders diffs attached to a call', function () {
    const html = render(mod.ToolCallCard, {
      block: tool({
        toolKind: 'edit',
        name: 'Edit',
        diffs: [
          {
            path: 'src/a.ts',
            kind: 'update',
            added: 1,
            removed: 1,
            hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: ['-old', '+new'] }],
          },
        ],
      }),
      defaultOpen: true,
    });
    assert.ok(html.includes('src/a.ts'), 'diff path missing');
    assert.ok(html.includes('@@ -1,2 +1,2 @@'), 'hunk header missing');
  });

  it('formats durations without pretending to precision it lacks', function () {
    const cases = [
      [820, '820ms'],
      [3400, '3.4s'],
      [125000, '2m 05s'],
    ];
    for (const [durationMs, expected] of cases) {
      const html = render(mod.ToolCallCard, { block: tool({ durationMs }) });
      assert.ok(html.includes(expected), `${durationMs}ms should read as ${expected}`);
    }
  });
});

describe('DiffView', function () {
  const update = {
    path: 'src/server/index.ts',
    kind: 'update',
    added: 2,
    removed: 1,
    hunks: [
      {
        oldStart: 10,
        oldLines: 3,
        newStart: 10,
        newLines: 4,
        lines: [' const a = 1;', '-const b = 2;', '+const b = 3;', '+const c = 4;'],
      },
      {
        oldStart: 40,
        oldLines: 2,
        newStart: 41,
        newLines: 2,
        lines: [' tail();', '\\ No newline at end of file'],
      },
    ],
  };
  const create = {
    path: 'src/new.ts',
    kind: 'create',
    added: 1,
    removed: 0,
    hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+export {};'] }],
  };
  const remove = {
    path: 'src/old.ts',
    kind: 'delete',
    added: 0,
    removed: 1,
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, lines: ['-export {};'] }],
  };
  const rename = {
    path: 'src/after.ts',
    oldPath: 'src/before.ts',
    kind: 'rename',
    added: 0,
    removed: 0,
    hunks: [],
  };
  const binary = {
    path: 'assets/logo.png',
    kind: 'update',
    added: 0,
    removed: 0,
    hunks: [],
    binary: true,
  };

  it('renders nothing for an empty diff array', function () {
    assert.strictEqual(render(mod.DiffView, { diffs: [] }), '');
  });

  it('renders multiple files with multiple hunks', function () {
    const html = render(mod.DiffView, { diffs: [update, create, remove] });
    for (const file of [update, create, remove]) {
      assert.ok(html.includes(file.path), `${file.path} missing`);
    }
    assert.ok(html.includes('@@ -10,3 +10,4 @@'), 'first hunk header missing');
    assert.ok(html.includes('@@ -40,2 +41,2 @@'), 'second hunk header missing');
    for (const kind of ['update', 'create', 'delete']) {
      assert.ok(html.includes(`>${kind}<`), `${kind} badge missing`);
    }
  });

  it('marks added and removed rows by glyph, not only by colour', function () {
    const html = render(mod.DiffView, { diffs: [update] });
    assert.ok(html.includes('>+<'), 'added rows must carry a + marker');
    assert.ok(html.includes('>-<'), 'removed rows must carry a - marker');
    // Colour still helps everyone else, and comes from the ANSI tokens.
    assert.ok(html.includes('--ansi-green'), 'added rows should tint green');
    assert.ok(html.includes('--ansi-red'), 'removed rows should tint red');
  });

  it('numbers both sides of the diff', function () {
    const html = render(mod.DiffView, { diffs: [update] });
    // ' const a = 1;' is line 10 on both sides; the removal takes old 11, the
    // two additions take new 11 and 12, and the second hunk restarts at 40/41.
    for (const n of ['10', '11', '12', '40', '41']) {
      assert.ok(html.includes(`>${n}<`), `line number ${n} missing`);
    }
    // The "\ No newline" row belongs to neither side and must number nothing.
    assert.ok(html.includes('\\'), 'the no-newline marker row was dropped');
  });

  it('shows a rename as oldPath -> path', function () {
    const html = render(mod.DiffView, { diffs: [rename] });
    assert.ok(html.includes('src/before.ts'), 'old path missing');
    assert.ok(html.includes('src/after.ts'), 'new path missing');
    assert.ok(html.includes('>rename<'), 'rename badge missing');
  });

  it('says "binary file" rather than rendering hunks', function () {
    const html = render(mod.DiffView, { diffs: [binary] });
    assert.ok(html.includes('binary file'), 'binary file not called out');
    assert.ok(!html.includes('@@'), 'binary file must not render a hunk header');
  });

  it('offers per-hunk apply and revert only when the callbacks are supplied', function () {
    const without = render(mod.DiffView, { diffs: [update] });
    assert.ok(!without.includes('apply'), 'apply offered with no handler');
    assert.ok(!without.includes('revert'), 'revert offered with no handler');

    const withBoth = render(mod.DiffView, {
      diffs: [update],
      onApplyHunk: () => {},
      onRevertHunk: () => {},
    });
    assert.ok(withBoth.includes('Apply hunk 1 of src/server/index.ts'), 'apply label missing');
    assert.ok(withBoth.includes('Revert hunk 2 of src/server/index.ts'), 'revert label missing');
  });

  it('collapses a long file and offers the whole thing', function () {
    const lines = [];
    for (let i = 0; i < 400; i += 1) lines.push(`+line ${i}`);
    const long = {
      path: 'src/long.ts',
      kind: 'update',
      added: 400,
      removed: 0,
      hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 400, lines }],
    };
    const html = render(mod.DiffView, { diffs: [long] });
    assert.ok(html.includes('line 0'), 'the head of a long diff must be shown');
    assert.ok(!html.includes('line 200'), 'a collapsed diff must not render every row');
    assert.ok(html.includes('Show all 400 lines'), 'no affordance to see the whole file');
  });

  it('starts closed when asked, and always reports its state', function () {
    const open = render(mod.DiffView, { diffs: [update] });
    assert.ok(open.includes('aria-expanded="true"'), 'default state not reported');
    assert.ok(open.includes('@@'), 'default state should show the diff');

    const closed = render(mod.DiffView, { diffs: [update], collapsedByDefault: true });
    assert.ok(closed.includes('aria-expanded="false"'), 'collapsed state not reported');
    assert.ok(!closed.includes('@@'), 'collapsed file must not render hunks');
    assert.ok(closed.includes(update.path), 'collapsed file must still name itself');
  });

  it('themes from tokens rather than baked-in colours', function () {
    const html = render(mod.DiffView, {
      diffs: [update, create, remove, rename, binary],
      onApplyHunk: () => {},
      onRevertHunk: () => {},
    });
    const withoutSvg = html.replace(/<svg[\s\S]*?<\/svg>/g, '');
    const hex = withoutSvg.match(/(?:color|background|border|fill)[^;"']*#[0-9a-fA-F]{3,8}/g);
    assert.deepStrictEqual(hex, null, `hardcoded colours: ${hex && hex.join(', ')}`);
  });
});
