const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// MessageList and MessageBubble are .tsx and never reach dist/ on their own —
// esbuild bundles them straight into app.bundle.js. Typechecking proves they
// compile; it does not prove they render. This bundles them for Node and
// renders them, which is what catches a bad import, a hook called at module
// scope, or a block kind the switch quietly drops on the floor.

const ROOT = path.join(__dirname, '..');
const CHAT_DIR = path.join(ROOT, 'src', 'client', 'shell', 'chat');

let bundle;
let mod;

before(function () {
  this.timeout(60000);

  const contents = [
    `export { renderToStaticMarkup } from 'react-dom/server';`,
    `export * as React from 'react';`,
    `export { MessageList } from ${JSON.stringify(path.join(CHAT_DIR, 'MessageList'))};`,
    `export { MessageBubble, messageText } from ${JSON.stringify(path.join(CHAT_DIR, 'MessageBubble'))};`,
    `export { ChatTranscript } from ${JSON.stringify(path.join(ROOT, 'src/client/chat/transcript'))};`,
  ].join('\n');

  bundle = path.join(os.tmpdir(), `chat-messages-${process.pid}.js`);
  require('esbuild').buildSync({
    // stdin rather than a temp entry file: an entry written to /tmp resolves
    // its bare imports relative to /tmp, where there is no node_modules.
    stdin: { contents, resolveDir: ROOT, loader: 'tsx', sourcefile: 'chat-messages.tsx' },
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

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

let seq = 0;

function message(over) {
  seq += 1;
  return {
    id: `m${seq}`,
    seq,
    turnId: 't1',
    role: 'assistant',
    ts: 1700000000000,
    blocks: [],
    ...over,
  };
}

/**
 * A transcript holding exactly the messages given.
 *
 * `firstSeq` is the lowest seq the *server* still has and `replayFrom` is the
 * lowest one this snapshot actually carried; older history exists exactly when
 * they differ. Defaulting replayFrom to firstSeq is the "fully replayed" case,
 * where there is nothing above what the client already holds.
 */
function transcriptOf(messages, opts) {
  const { ChatTranscript } = mod;
  const t = new ChatTranscript();
  const firstSeq = opts && opts.firstSeq !== undefined ? opts.firstSeq : 0;
  t.hydrate({
    sessionId: 's1',
    runtime: 'claude',
    messages,
    state: (opts && opts.state) || 'idle',
    capabilities: t.capabilities,
    pendingPermissions: [],
    firstSeq,
    replayFrom: opts && opts.replayFrom !== undefined ? opts.replayFrom : firstSeq,
    cursor: messages.length,
    live: true,
    bypassPermissions: false,
  });
  return t;
}

function renderList(messages, props, opts) {
  const { renderToStaticMarkup, React, MessageList } = mod;
  return renderToStaticMarkup(
    React.createElement(MessageList, {
      transcript: transcriptOf(messages, opts),
      ...props,
    }),
  );
}

function renderBubble(msg, props) {
  const { renderToStaticMarkup, React, MessageBubble } = mod;
  const t = transcriptOf([msg]);
  return renderToStaticMarkup(
    React.createElement(MessageBubble, { message: msg, transcript: t, ...props }),
  );
}

const EVERY_BLOCK = [
  { kind: 'text', text: '# Heading\n\nSome **bold** prose and `code`.' },
  { kind: 'thinking', text: 'first thought\nsecond thought\nthird thought' },
  {
    kind: 'tool',
    toolId: 'tool-1',
    name: 'Read',
    title: 'Reading hello.txt',
    toolKind: 'read',
    status: 'completed',
    input: { path: 'hello.txt' },
    output: 'hello world',
    locations: ['hello.txt'],
    durationMs: 42,
  },
  {
    kind: 'plan',
    items: [
      { text: 'Read the file', status: 'completed' },
      { text: 'Change the file', status: 'in_progress' },
      { text: 'Run the tests', status: 'pending' },
    ],
  },
  { kind: 'image', mime: 'image/png', url: '/files/shot.png', alt: 'A screenshot' },
  { kind: 'error', text: 'the runtime exited before finishing' },
];

// --------------------------------------------------------------------------

describe('MessageBubble', function () {
  it('renders every block kind in one message', function () {
    const html = renderBubble(message({ blocks: EVERY_BLOCK, model: 'claude-opus' }));

    assert.ok(html.length > 0, 'rendered nothing');
    assert.ok(/Heading/.test(html), 'text block missing');
    assert.ok(/Reasoning/.test(html), 'thinking disclosure missing');
    assert.ok(/Read/.test(html), 'tool card missing');
    assert.ok(/Run the tests/.test(html), 'plan panel missing');
    assert.ok(/\/files\/shot\.png/.test(html), 'image missing');
    assert.ok(/the runtime exited/.test(html), 'error callout missing');
  });

  it('collapses reasoning by default and says so to assistive tech', function () {
    const html = renderBubble(
      message({ blocks: [{ kind: 'thinking', text: 'a\nb\nc\nd' }] }),
    );
    assert.ok(/aria-expanded="false"/.test(html), 'disclosure must start collapsed');
    // The size cue is the whole reason a collapsed block is acceptable.
    assert.ok(/4 lines/.test(html), 'line count missing from the collapsed label');
    assert.ok(!/aria-expanded="true"/.test(html));
  });

  it('echoes the user\'s own text literally rather than through markdown', function () {
    const raw = 'use `--flag` and *not* --other';
    const html = renderBubble(
      message({ role: 'user', blocks: [{ kind: 'text', text: raw }] }),
    );
    assert.ok(html.includes('use `--flag` and *not* --other'), 'user text was rewritten');
    assert.ok(!/<code/.test(html), 'user backticks must not become a code element');
    assert.ok(!/<em/.test(html), 'user asterisks must not become emphasis');
  });

  it('distinguishes the roles by label and icon, not colour alone', function () {
    const user = renderBubble(message({ role: 'user', blocks: [{ kind: 'text', text: 'hi' }] }));
    const bot = renderBubble(message({ blocks: [{ kind: 'text', text: 'hello' }] }));

    assert.ok(/aria-label="You message"/.test(user));
    assert.ok(/aria-label="Assistant message"/.test(bot));
    // Different glyphs, so the two read apart in monochrome.
    assert.notStrictEqual(iconPaths(user), iconPaths(bot));
  });

  it('marks a streaming message as still arriving', function () {
    const html = renderBubble(
      message({ blocks: [{ kind: 'text', text: 'partial' }], streaming: true }),
    );
    assert.ok(/relay-cursor-blink/.test(html), 'no caret while streaming');
    assert.ok(/is responding/.test(html), 'no live-region announcement while streaming');
  });

  it('renders a message with no blocks at all', function () {
    const html = renderBubble(message({ blocks: [], streaming: true }));
    assert.ok(html.length > 0);
    assert.ok(/relay-cursor-blink/.test(html), 'an empty streaming turn still needs a caret');
  });

  it('offers copy always and branching only when a handler exists', function () {
    const plain = renderBubble(message({ blocks: [{ kind: 'text', text: 'hi' }] }));
    assert.ok(/aria-label="Copy message"/.test(plain));
    assert.ok(!/Branch from here/.test(plain));

    const forkable = renderBubble(message({ blocks: [{ kind: 'text', text: 'hi' }] }), {
      onFork: () => {},
    });
    assert.ok(/aria-label="Branch from here"/.test(forkable));
    // Reachable by keyboard: a real button, never hidden from the tab order.
    assert.ok(!/Branch from here[^>]*tabindex="-1"/.test(forkable));
  });

  it('offers retry on an error only when a handler exists', function () {
    const blocks = [{ kind: 'error', text: 'boom' }];
    assert.ok(!/Retry/.test(renderBubble(message({ blocks }))));
    assert.ok(/Retry/.test(renderBubble(message({ blocks }), { onRetry: () => {} })));
  });

  it('shows usage and model quietly, and nothing when absent', function () {
    const withUsage = renderBubble(
      message({
        blocks: [{ kind: 'text', text: 'done' }],
        model: 'gpt-x',
        usage: { inputTokens: 12345, outputTokens: 240, costUsd: 0.0021 },
      }),
    );
    assert.ok(/gpt-x/.test(withUsage));
    assert.ok(/12k in/.test(withUsage), 'large token counts should be abbreviated');
    assert.ok(/\$0\.0021/.test(withUsage));

    const bare = renderBubble(message({ blocks: [{ kind: 'text', text: 'done' }] }));
    assert.ok(!/<footer/.test(bare), 'a message with no usage must not render an empty footer');
  });

  it('survives very long content', function () {
    const long = 'lorem ipsum dolor sit amet '.repeat(4000);
    const html = renderBubble(
      message({
        blocks: [
          { kind: 'text', text: long },
          { kind: 'thinking', text: long },
          { kind: 'error', text: long },
        ],
      }),
    );
    assert.ok(html.length > long.length, 'long content was truncated away entirely');
  });

  it('flattens a message to plain text for the clipboard', function () {
    const text = mod.messageText(message({ blocks: EVERY_BLOCK }));
    assert.ok(text.includes('Heading'));
    assert.ok(text.includes('hello world'));
    assert.ok(text.includes('[x] Read the file'));
    // Reasoning is working, not answer, and does not belong on the clipboard.
    assert.ok(!text.includes('first thought'));
  });
});

describe('MessageList', function () {
  it('renders a quiet prompt when there is nothing to show', function () {
    const html = renderList([]);
    assert.ok(html.length > 0);
    assert.ok(/Nothing here yet/.test(html));
    assert.ok(/start the conversation/.test(html));
  });

  it('labels the transcript as a live log region', function () {
    const html = renderList([message({ blocks: [{ kind: 'text', text: 'hi' }] })]);
    assert.ok(/role="log"/.test(html));
    assert.ok(/aria-label="Conversation"/.test(html));
    // Scrollable by keyboard, not only by pointer.
    assert.ok(/tabindex="0"/.test(html));
  });

  it('offers to page older history only when it exists and can be fetched', function () {
    const msgs = [message({ blocks: [{ kind: 'text', text: 'hi' }] })];
    const load = { onLoadMore: () => {} };

    // Nothing above what we hold: the replay reached the head of the log.
    assert.ok(!/earlier messages/.test(renderList(msgs, load, { firstSeq: 0, replayFrom: 0 })));
    // The regression this guards: seq numbering starts at 1, so a session with
    // one message and nothing above it reports firstSeq 1. Reading that as
    // "there is more" offered a control that could never finish, and the
    // spinner it raised never came down.
    assert.ok(!/earlier messages/.test(renderList(msgs, load, { firstSeq: 1, replayFrom: 1 })));
    // Genuinely trimmed: the log starts at 40 and the replay only reached 900.
    assert.ok(!/earlier messages/.test(renderList(msgs, {}, { firstSeq: 40, replayFrom: 900 })));
    assert.ok(
      /earlier messages/.test(renderList(msgs, load, { firstSeq: 40, replayFrom: 900 })),
    );
  });

  it('labels the user\u2019s turns and leaves the assistant\u2019s unlabelled', function () {
    // A conversation is overwhelmingly the assistant talking, so "Assistant"
    // on every bubble is a word repeated down the page that says nothing the
    // reader did not already know.
    const html = renderList([
      message({ role: 'user', blocks: [{ kind: 'text', text: 'a question' }] }),
      message({ blocks: [{ kind: 'text', text: 'an answer' }] }),
    ]);

    assert.ok(/>You</.test(html));
    assert.ok(!/>Assistant</.test(html), 'the assistant name is not repeated per bubble');
    // The accessible name is unconditional, so the roles are still announced.
    assert.ok(/aria-label="Assistant message"/.test(html));
    assert.ok(/aria-label="You message"/.test(html));
  });

  it('starts pinned to the bottom, so no jump affordance is shown', function () {
    const html = renderList([message({ blocks: [{ kind: 'text', text: 'hi' }] })]);
    assert.ok(!/Jump to latest/.test(html), 'the jump control belongs to the detached state only');
  });

  it('renders a streaming turn mid-transcript', function () {
    const html = renderList([
      message({ role: 'user', blocks: [{ kind: 'text', text: 'do the thing' }] }),
      message({ blocks: [{ kind: 'text', text: 'working on it' }], streaming: true }),
    ]);
    assert.ok(/do the thing/.test(html));
    assert.ok(/relay-cursor-blink/.test(html));
  });

  it('renders a 500-message transcript', function () {
    this.timeout(30000);
    const many = [];
    for (let i = 0; i < 500; i += 1) {
      many.push(
        message({
          role: i % 2 === 0 ? 'user' : 'assistant',
          blocks: i % 2 === 0
            ? [{ kind: 'text', text: `question ${i}` }]
            : [
                { kind: 'text', text: `answer ${i} with **markdown**` },
                { kind: 'thinking', text: `weighing ${i}` },
              ],
        }),
      );
    }

    const html = renderList(
      many,
      { onFork: () => {}, onRetry: () => {} },
      { firstSeq: 900, replayFrom: 1400 },
    );
    assert.ok(/question 0/.test(html), 'first message missing');
    assert.ok(/answer 499/.test(html), 'last message missing');
    assert.strictEqual(
      (html.match(/<article/g) || []).length,
      500,
      'every message must render its own bubble',
    );
  });

  it('themes from CSS custom properties rather than baked-in colours', function () {
    const html = renderList([
      message({ role: 'user', blocks: [{ kind: 'text', text: 'hi' }] }),
      message({ blocks: EVERY_BLOCK, model: 'm', usage: { inputTokens: 10 } }),
    ], { onFork: () => {}, onRetry: () => {} });

    const withoutSvg = html.replace(/<svg[\s\S]*?<\/svg>/g, '');
    const hex = withoutSvg.match(/(?:color|background|border|fill)[^;"']*#[0-9a-fA-F]{3,8}/g);
    assert.deepStrictEqual(hex, null, `hardcoded colours found: ${hex && hex.join(', ')}`);
  });

  it('never rounds a corner — the design system is sharp', function () {
    const html = renderList([message({ blocks: EVERY_BLOCK })]);
    const radii = html.match(/border-radius:\s*(?!var\(--radius)[^;"]+/g);
    assert.deepStrictEqual(radii, null, `literal radii found: ${radii && radii.join(', ')}`);
  });
});

/** The `d` attributes of every icon in a fragment, as a fingerprint of glyphs. */
function iconPaths(html) {
  return (html.match(/ d="[^"]+"/g) || []).join('|');
}
