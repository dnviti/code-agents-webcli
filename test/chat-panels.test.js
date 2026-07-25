const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Same approach as test/relay-components.test.js: these are .tsx and never
// reach dist/ on their own, so this bundles them for Node with esbuild and
// renders with renderToStaticMarkup, which is what catches a bad import, a
// lookup table that returns undefined for a real ToolKind/status, or a hook
// misuse — none of which tsc alone would notice.

const ROOT = path.join(__dirname, '..');
const CHAT_DIR = path.join(ROOT, 'src', 'client', 'shell', 'chat');

let mod;
let bundle;

before(function () {
  this.timeout(60000);

  const contents = [
    `export { renderToStaticMarkup } from 'react-dom/server';`,
    `export * as React from 'react';`,
    `export { PermissionCard } from ${JSON.stringify(path.join(CHAT_DIR, 'PermissionCard'))};`,
    `export { PlanPanel } from ${JSON.stringify(path.join(CHAT_DIR, 'PlanPanel'))};`,
    `export { UsageMeter } from ${JSON.stringify(path.join(CHAT_DIR, 'UsageMeter'))};`,
  ].join('\n');

  bundle = path.join(os.tmpdir(), `chat-panels-smoke-${process.pid}.js`);
  require('esbuild').buildSync({
    stdin: { contents, resolveDir: ROOT, loader: 'tsx', sourcefile: 'chat-panels-smoke.tsx' },
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

function render(name, props) {
  const { renderToStaticMarkup, React } = mod;
  return renderToStaticMarkup(React.createElement(mod[name], props));
}

// ---------------------------------------------------------------------------
// PermissionCard
// ---------------------------------------------------------------------------

const DEFAULT_OPTIONS = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow_always', name: 'Allow for this session', kind: 'allow_always' },
  { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
];

describe('PermissionCard', function () {
  it('renders a command approval with full data (input, reason, all options)', function () {
    const html = render('PermissionCard', {
      request: {
        requestId: 'req-1',
        toolId: 'tool-1',
        title: 'Run shell command',
        toolKind: 'execute',
        input: { command: 'rm', args: ['-rf', '/tmp/scratch'] },
        reason: 'This will permanently delete the directory.',
        options: DEFAULT_OPTIONS,
        ts: Date.now(),
      },
      onRespond: () => {},
    });
    assert.ok(html.length > 0, 'must render something');
    assert.ok(html.includes('Run shell command'));
    assert.ok(html.includes('rm -rf /tmp/scratch'), 'shows the actual command being approved');
    assert.ok(html.includes('permanently delete'));
    assert.ok(html.includes('Allow once'));
    assert.ok(html.includes('Deny'));
  });

  it('renders a diff-carrying request through DiffView', function () {
    const html = render('PermissionCard', {
      request: {
        requestId: 'req-2',
        title: 'Apply patch',
        toolKind: 'edit',
        diffs: [
          {
            path: 'src/index.ts',
            kind: 'update',
            added: 3,
            removed: 1,
            hunks: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 3,
                lines: [' const x = 1;', '-const y = 2;', '+const y = 3;', '+const z = 4;'],
              },
            ],
          },
        ],
        options: DEFAULT_OPTIONS,
        ts: Date.now(),
      },
      onRespond: () => {},
    });
    assert.ok(html.includes('src/index.ts'));
    assert.ok(html.includes('const y = 3'));
  });

  it('renders a minimal request with no input, reason or diffs (empty data)', function () {
    const html = render('PermissionCard', {
      request: {
        requestId: 'req-3',
        title: 'Read a file',
        toolKind: 'read',
        options: [{ optionId: 'allow_once', name: 'Allow', kind: 'allow_once' }],
        ts: Date.now(),
      },
      onRespond: () => {},
    });
    assert.ok(html.length > 0);
    assert.ok(html.includes('Read a file'));
    assert.ok(html.includes('Allow'));
  });

  it('renders a busy state that disables the buttons', function () {
    const html = render('PermissionCard', {
      request: {
        requestId: 'req-4',
        title: 'Delete branch',
        toolKind: 'delete',
        options: DEFAULT_OPTIONS,
        ts: Date.now(),
      },
      onRespond: () => {},
      busy: true,
    });
    assert.ok(html.includes('Sending'));
    assert.ok(/disabled/.test(html), 'buttons must be disabled while a response is in flight');
  });

  it('renders a deny-only request (no allow option to autofocus)', function () {
    const html = render('PermissionCard', {
      request: {
        requestId: 'req-5',
        title: 'Force push to main',
        toolKind: 'execute',
        input: 'git push --force origin main',
        options: [{ optionId: 'reject_once', name: 'Deny', kind: 'reject_once' }],
        ts: Date.now(),
      },
      onRespond: () => {},
    });
    assert.ok(html.includes('git push --force origin main'));
    assert.ok(html.includes('Deny'));
  });

  it('handles a very long command without throwing', function () {
    const longCommand = 'echo ' + 'x'.repeat(2000);
    const html = render('PermissionCard', {
      request: {
        requestId: 'req-6',
        title: 'Run shell command',
        toolKind: 'execute',
        input: { command: longCommand },
        options: DEFAULT_OPTIONS,
        ts: Date.now(),
      },
      onRespond: () => {},
    });
    assert.ok(html.includes(longCommand));
  });
});

// ---------------------------------------------------------------------------
// PlanPanel
// ---------------------------------------------------------------------------

describe('PlanPanel', function () {
  it('renders a full plan with mixed statuses and priorities', function () {
    const html = render('PlanPanel', {
      items: [
        { text: 'Read the existing bridge code', status: 'completed', priority: 'high' },
        { text: 'Write the new adapter', status: 'in_progress', priority: 'high' },
        { text: 'Add tests', status: 'pending' },
      ],
    });
    assert.ok(html.length > 0);
    assert.ok(html.includes('Read the existing bridge code'));
    assert.ok(html.includes('Write the new adapter'));
    assert.ok(html.includes('Add tests'));
    assert.ok(html.includes('1 of 3'), 'shows an N of M progress summary');
    assert.ok(html.includes('high'));
  });

  it('renders partial data (no priorities, compact) without dropping items', function () {
    const html = render('PlanPanel', {
      items: [
        { text: 'Step one', status: 'completed' },
        { text: 'Step two', status: 'pending' },
      ],
      compact: true,
    });
    assert.ok(html.includes('Step one'));
    assert.ok(html.includes('Step two'));
    assert.ok(html.includes('1 of 2'));
  });

  it('renders nothing for an empty plan', function () {
    const html = render('PlanPanel', { items: [] });
    assert.strictEqual(html, '', 'an empty plan must render nothing, not empty chrome');
  });

  it('does not convey completed status by colour alone (strikethrough + distinct icon)', function () {
    const html = render('PlanPanel', {
      items: [{ text: 'Done thing', status: 'completed' }],
    });
    assert.ok(html.includes('line-through'), 'completed items must be struck through');
  });

  it('handles a very long item without throwing', function () {
    const longText = 'Investigate '.repeat(200);
    const html = render('PlanPanel', {
      items: [{ text: longText, status: 'in_progress' }],
    });
    assert.ok(html.includes(longText.trim()));
  });
});

// ---------------------------------------------------------------------------
// UsageMeter
// ---------------------------------------------------------------------------

const FULL_CAPS = {
  streaming: true,
  thinking: true,
  toolCalls: true,
  diffs: true,
  permissions: true,
  interrupt: true,
  resume: true,
  fork: true,
  attachments: true,
  usage: true,
  cost: true,
  plan: true,
};

describe('UsageMeter', function () {
  it('renders full usage: token breakdown, total, cost and context bar', function () {
    const html = render('UsageMeter', {
      usage: {
        inputTokens: 12421,
        outputTokens: 3204,
        cacheReadTokens: 81234,
        cacheWriteTokens: 512,
        reasoningTokens: 900,
        totalTokens: 98271,
        costUsd: 0.0842,
        contextWindow: 200000,
        contextUsed: 84200,
      },
      capabilities: FULL_CAPS,
    });
    assert.ok(html.length > 0);
    assert.ok(html.includes('12.4k'), 'formats large token counts compactly');
    assert.ok(html.includes('$0.0842'), 'keeps enough precision at small dollar amounts');
    assert.ok(/role="progressbar"/.test(html), 'shows a context-fullness bar when both fields are known');
    assert.ok(html.includes('42%'));
  });

  it('renders partial usage (tokens only, no cost or context) without inventing fields', function () {
    const html = render('UsageMeter', {
      usage: { inputTokens: 500, outputTokens: 250 },
      capabilities: FULL_CAPS,
    });
    assert.ok(html.includes('500'));
    assert.ok(html.includes('250'));
    assert.ok(!html.includes('$'), 'must not show a cost figure that was never reported');
    assert.ok(!/role="progressbar"/.test(html), 'must not show a context bar with no context data');
  });

  it('renders nothing for an empty usage object', function () {
    const html = render('UsageMeter', { usage: {}, capabilities: FULL_CAPS });
    assert.strictEqual(html, '', 'no fields reported must mean no meter, not a confident zero');
  });

  it('renders nothing when the runtime does not report usage or cost, even with stale fields', function () {
    const html = render('UsageMeter', {
      usage: { inputTokens: 500, costUsd: 1.2 },
      capabilities: { ...FULL_CAPS, usage: false, cost: false },
    });
    assert.strictEqual(html, '');
  });

  it('renders a compact one-line summary', function () {
    const html = render('UsageMeter', {
      usage: { totalTokens: 1500000, costUsd: 4.5, contextWindow: 100000, contextUsed: 99000 },
      capabilities: FULL_CAPS,
      compact: true,
    });
    assert.ok(html.includes('1.5M'));
    assert.ok(html.includes('$4.50'));
    assert.ok(/role="progressbar"/.test(html));
  });

  it('formats a very small cost with useful precision', function () {
    const html = render('UsageMeter', {
      usage: { costUsd: 0.0004 },
      capabilities: FULL_CAPS,
    });
    assert.ok(html.includes('$0.0004'));
  });
});
