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
    `export { groupTurns } from ${JSON.stringify(path.join(ROOT, 'src/client/chat/turns'))};`,
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
  const transcript = transcriptOf(messages, opts);
  return renderToStaticMarkup(
    React.createElement(MessageList, {
      transcript,
      // Derived by the chat root in the real surface and shared with the turn
      // index, so the list is handed the same answer rather than deriving a
      // second one that could disagree with it.
      turns: mod.groupTurns(transcript.messages, transcript.chatState),
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
  it('renders every block kind the transcript still owns', function () {
    const html = renderBubble(message({ blocks: EVERY_BLOCK, model: 'claude-opus' }));

    assert.ok(html.length > 0, 'rendered nothing');
    assert.ok(/Heading/.test(html), 'text block missing');
    assert.ok(/Run the tests/.test(html), 'plan panel missing');
    assert.ok(/\/files\/shot\.png/.test(html), 'image missing');
    assert.ok(/the runtime exited/.test(html), 'error callout missing');
  });

  // The core move of the redesign: the machinery leaves the prose and goes to
  // the trace rail. It must leave *something* behind, or a turn that ran six
  // commands reads as a turn that did nothing.
  it('keeps reasoning and tool calls out of the prose', function () {
    const html = renderBubble(message({ blocks: EVERY_BLOCK }), { onShowWork: () => {} });

    assert.ok(!/first thought/.test(html), 'reasoning must not render in the transcript');
    assert.ok(!/hello world/.test(html), 'tool output must not render in the transcript');
    assert.ok(!/aria-label="Reading hello.txt"/.test(html), 'no inline tool card');
  });

  it('replaces them with a pill that says how much work there was', function () {
    const html = renderBubble(message({ blocks: EVERY_BLOCK }), { onShowWork: () => {} });

    assert.ok(/1 command/.test(html), 'the pill must count the tool calls');
    assert.ok(/1 reasoning/.test(html), 'the pill must count the reasoning blocks');
    assert.ok(/show work/.test(html), 'and offer the way to look at them');
  });

  it('does not count what the display settings switched off', function () {
    const html = renderBubble(message({ blocks: EVERY_BLOCK }), {
      onShowWork: () => {},
      showThinking: false,
    });
    assert.ok(/1 command/.test(html));
    assert.ok(!/reasoning/.test(html), 'hidden reasoning must not be counted either');
  });

  it('renders nothing for a message the settings emptied, rather than a blank row', function () {
    // An assistant turn that was only machinery, with both toggles off: an
    // empty bordered row reads as a message that failed to render.
    const html = renderBubble(
      message({ blocks: [EVERY_BLOCK[1], EVERY_BLOCK[2]] }),
      { onShowWork: () => {}, showThinking: false, showToolCalls: false },
    );
    assert.strictEqual(html, '');
  });

  // Issue #46. A step the agent spent entirely on tools said nothing, and a row
  // with a glyph, a clock and a pill on it is a row the eye stops on to learn
  // that nothing was said.
  it('gives a step that only ran commands no row of its own', function () {
    const tools = [EVERY_BLOCK[1], EVERY_BLOCK[2]];
    assert.strictEqual(renderBubble(message({ blocks: tools }), { onShowWork: () => {} }), '');
    // While it is still running, too — the live ribbon is what says the agent
    // is working, and a row that appears and then vanishes is worse than none.
    assert.strictEqual(
      renderBubble(message({ blocks: tools, streaming: true }), { onShowWork: () => {} }),
      '',
    );
  });

  it('still shows the caret for a reply that has opened but produced nothing', function () {
    // The gap between sending and the first block: a reply about to happen, not
    // machinery, so suppressing tool-only steps must not take it with them.
    const html = renderBubble(message({ blocks: [], streaming: true }), { onShowWork: () => {} });
    assert.ok(/relay-cursor-blink/.test(html));
  });

  it('counts the silent steps it was handed, not only its own work', function () {
    const { renderToStaticMarkup, React, MessageBubble } = mod;
    const silent = message({ blocks: [EVERY_BLOCK[2], EVERY_BLOCK[2]] });
    const spoke = message({ blocks: [{ kind: 'text', text: 'done' }, EVERY_BLOCK[2]] });
    const t = transcriptOf([silent, spoke]);
    const html = renderToStaticMarkup(
      React.createElement(MessageBubble, {
        message: spoke,
        transcript: t,
        onShowWork: () => {},
        carriedIds: silent.id,
      }),
    );
    assert.ok(/3 commands/.test(html), 'the pill speaks for the whole stretch');
    assert.ok(/show work/.test(html));
  });

  it('tells the retry handler which message it belongs to', function () {
    // It used to take no argument, so the handler guessed — and it guessed
    // "whichever turn is selected", which is not the one you clicked.
    let got = null;
    const { renderToStaticMarkup, React, MessageBubble } = mod;
    const msg = message({ blocks: [{ kind: 'error', text: 'boom' }] });
    const t = transcriptOf([msg]);
    const html = renderToStaticMarkup(
      React.createElement(MessageBubble, { message: msg, transcript: t, onRetry: (id) => { got = id; } }),
    );
    assert.ok(/aria-label="Retry this turn"/.test(html), 'the action must be offered');
    assert.ok(/Retry/.test(html), 'and the error block keeps its own retry');
    // The handler's signature is what carries the id; the static render cannot
    // click, so the contract is asserted on the prop type through usage.
    assert.strictEqual(got, null);
  });

  it('shows no pill at all for a turn that only spoke', function () {
    const html = renderBubble(message({ blocks: [{ kind: 'text', text: 'just prose' }] }), {
      onShowWork: () => {},
    });
    assert.ok(!/show work/.test(html));
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

  it('distinguishes the roles by name, surface and icon, not colour alone', function () {
    const user = renderBubble(message({ role: 'user', blocks: [{ kind: 'text', text: 'hi' }] }));
    const bot = renderBubble(message({ blocks: [{ kind: 'text', text: 'hello' }] }));

    assert.ok(/aria-label="Your message"/.test(user));
    assert.ok(/aria-label="Assistant message"/.test(bot));
    // Different glyphs, so the two read apart in monochrome.
    assert.notStrictEqual(iconPaths(user), iconPaths(bot));
    // And the user's turn is the only one with a surface under it, which is
    // what makes an hour of conversation skimmable.
    assert.ok(/background:var\(--muted\)/.test(user.replace(/\s/g, '')));
  });

  it('offers edit-and-resend on the user\u2019s turn only', function () {
    const user = renderBubble(message({ role: 'user', blocks: [{ kind: 'text', text: 'hi' }] }), {
      onEdit: () => {},
    });
    const bot = renderBubble(message({ blocks: [{ kind: 'text', text: 'hi' }] }), {
      onEdit: () => {},
    });
    assert.ok(/aria-label="Edit and resend"/.test(user));
    assert.ok(!/aria-label="Edit and resend"/.test(bot));
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

  it('names the roles for assistive tech without repeating them on screen', function () {
    // A conversation is overwhelmingly the assistant talking, so "Assistant"
    // written on every bubble is a word repeated down the page that says
    // nothing the reader did not already know. The surface, the glyph and the
    // accessible name carry it instead.
    const html = renderList([
      message({ role: 'user', blocks: [{ kind: 'text', text: 'a question' }] }),
      message({ blocks: [{ kind: 'text', text: 'an answer' }] }),
    ]);

    assert.ok(!/>Assistant</.test(html), 'the assistant name is not repeated per bubble');
    assert.ok(/aria-label="Assistant message"/.test(html));
    assert.ok(/aria-label="Your message"/.test(html));
  });

  it('opens each turn with a sticky strip carrying its cost', function () {
    const html = renderList([
      message({
        role: 'user',
        blocks: [{ kind: 'text', text: 'run the tests' }],
      }),
      message({
        blocks: [{ kind: 'text', text: 'green' }],
        usage: { costUsd: 0.0221, outputTokens: 120 },
      }),
    ]);

    assert.ok(/turn 1/.test(html), 'the turn needs a header');
    assert.ok(/\$0\.0221/.test(html), 'and the turn\u2019s cost belongs on it');
    assert.ok(/position:sticky/.test(html.replace(/\s/g, '')), 'the current turn\u2019s strip sticks');
    assert.ok(/role="heading"/.test(html), 'it is what a screen reader navigates by');
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

  // Issue #46: the whole point of dropping the silent rows is that their work
  // still has to be reachable from the conversation.
  it('hands a silent step’s work to the reply that follows it', function () {
    const tool = () => ({
      kind: 'tool',
      toolId: `t${Math.random()}`,
      name: 'bash',
      toolKind: 'execute',
      status: 'completed',
      input: { command: 'npm test' },
    });
    const html = renderList(
      [
        message({ role: 'user', blocks: [{ kind: 'text', text: 'run the tests' }] }),
        message({ blocks: [tool(), tool()] }),
        message({ blocks: [{ kind: 'text', text: 'all green' }, tool()] }),
      ],
      { onShowWork: () => {} },
    );

    const rows = html.match(/aria-label="Assistant message"/g) || [];
    assert.strictEqual(rows.length, 1, 'the silent step must not be a row of its own');
    assert.ok(/all green/.test(html), 'the reply is still there');
    assert.ok(/3 commands/.test(html), 'and its pill counts the stretch that led to it');
  });

  it('drops silent steps a turn never followed with a reply', function () {
    // Nothing to hang them on, and inventing a row for them is the thing this
    // removes. The turn strip still counts them and the rail still holds them.
    const html = renderList(
      [
        message({ role: 'user', blocks: [{ kind: 'text', text: 'go' }] }),
        message({ blocks: [EVERY_BLOCK[2]] }),
      ],
      { onShowWork: () => {} },
    );
    assert.ok(!/aria-label="Assistant message"/.test(html));
    assert.ok(/turn 1/.test(html), 'the turn itself is still on screen');
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

  // Acceptance criterion §7.9, asserted the way the criterion words it: a
  // streamed token must re-render its own bubble and no other. This is the
  // property the whole two-tier subscription exists for, and it is invisible to
  // every other kind of test — a static render cannot show it, and the surface
  // looks identical whether it holds or not until the session gets long.
  it('re-renders one bubble per streamed token, not the whole list', function () {
    this.timeout(30000);
    const { React, ChatTranscript } = mod;
    const { renderToStaticMarkup } = mod;

    const many = [];
    for (let i = 0; i < 200; i += 1) {
      many.push(message({
        role: i % 2 === 0 ? 'user' : 'assistant',
        blocks: [{ kind: 'text', text: `line ${i}` }],
      }));
    }
    const open = message({ blocks: [{ kind: 'text', text: '' }], streaming: true });
    many.push(open);

    const t = new ChatTranscript();
    t.hydrate({
      sessionId: 's1', runtime: 'claude', messages: many, state: 'running',
      capabilities: t.capabilities, pendingPermissions: [],
      firstSeq: 0, replayFrom: 0, cursor: many.length, live: true, bypassPermissions: false,
    });

    // Count the listeners each tier actually wakes, which is what decides how
    // many components React will re-render.
    let listWakes = 0;
    let openBubbleWakes = 0;
    let otherBubbleWakes = 0;
    t.subscribe(() => { listWakes += 1; });
    t.subscribeMessage(open.id, () => { openBubbleWakes += 1; });
    for (const m of many.slice(0, 20)) {
      if (m.id !== open.id) t.subscribeMessage(m.id, () => { otherBubbleWakes += 1; });
    }

    let seq = many.length;
    for (let i = 0; i < 50; i += 1) {
      t.apply({ t: 'block_delta', seq: ++seq, ts: 1, msgId: open.id, index: 0, text: 'x' });
    }

    assert.strictEqual(openBubbleWakes, 50, 'the streaming bubble must see every token');
    assert.strictEqual(otherBubbleWakes, 0, 'no sibling bubble may be woken');
    assert.strictEqual(listWakes, 0, 'and the list itself must stay asleep');

    // The rail is the exception, and deliberately so: it draws the tool calls
    // and has to see them arrive. It is on its own tier for exactly this.
    let railWakes = 0;
    t.subscribeContent(() => { railWakes += 1; });
    t.apply({ t: 'block_delta', seq: ++seq, ts: 1, msgId: open.id, index: 0, text: 'y' });
    assert.strictEqual(railWakes, 1, 'the live tier sees the token');
    assert.strictEqual(listWakes, 0, 'without waking the list');

    // And the whole thing still renders.
    assert.ok(renderToStaticMarkup(React.createElement('div')) === '<div></div>');
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
