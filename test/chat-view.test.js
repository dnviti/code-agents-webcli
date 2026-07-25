const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ChatView is .tsx and only ever reaches the browser through esbuild, so
// typechecking proves it compiles and nothing more. This bundles it for Node
// and renders it once per transcript state, which is what catches a header
// that goes blank when the process dies, a permission region that never
// mounts, or a rail that renders on a phone.

const ROOT = path.join(__dirname, '..');
const CHAT_DIR = path.join(ROOT, 'src', 'client', 'shell', 'chat');

let bundle;
let mod;

before(function () {
  this.timeout(60000);

  const contents = [
    `export { renderToStaticMarkup } from 'react-dom/server';`,
    `export * as React from 'react';`,
    `export { ChatView } from ${JSON.stringify(path.join(CHAT_DIR, 'ChatView'))};`,
    `export { ChatController } from ${JSON.stringify(path.join(ROOT, 'src', 'client', 'chat', 'controller'))};`,
  ].join('\n');

  bundle = path.join(os.tmpdir(), `chat-view-${process.pid}.js`);
  require('esbuild').buildSync({
    // stdin rather than a temp entry file: an entry written to /tmp resolves
    // its bare imports relative to /tmp, where there is no node_modules.
    stdin: { contents, resolveDir: ROOT, loader: 'tsx', sourcefile: 'chat-view.tsx' },
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

const CAPABILITIES = {
  streaming: true,
  thinking: true,
  toolCalls: true,
  diffs: true,
  permissions: true,
  interrupt: true,
  resume: true,
  fork: false,
  attachments: false,
  usage: true,
  cost: true,
  plan: true,
};

function snapshot(overrides) {
  return {
    sessionId: 's1',
    runtime: 'claude',
    messages: [],
    state: 'idle',
    capabilities: CAPABILITIES,
    pendingPermissions: [],
    firstSeq: 0,
    cursor: 0,
    live: true,
    bypassPermissions: false,
    ...overrides,
  };
}

/** A controller hydrated the way the socket hydrates one, so the real path runs. */
function controllerWith(overrides, events = []) {
  const sent = [];
  const controller = new mod.ChatController({ send: (m) => sent.push(m) });
  controller.handle({ type: 'chat_snapshot', sessionId: 's1', snapshot: snapshot(overrides) });
  for (const event of events) controller.transcript.apply(event);
  controller.sent = sent;
  return controller;
}

function render(props) {
  const { renderToStaticMarkup, React, ChatView } = mod;
  return renderToStaticMarkup(
    React.createElement(ChatView, {
      runtime: 'claude',
      runtimeLabel: 'Claude Code',
      workingDir: '/home/dev/projects/webcli',
      ...props,
    }),
  );
}

function message(id, seq, role, text, extra) {
  return {
    id,
    seq,
    turnId: 't1',
    role,
    ts: 1,
    blocks: [{ kind: 'text', text }],
    ...extra,
  };
}

describe('ChatView', function () {
  it('renders an empty transcript as a quiet prompt, not a blank pane', function () {
    const html = render({ controller: controllerWith({}) });

    assert.ok(html.includes('Nothing here yet'), 'empty transcript needs its invitation');
    assert.ok(html.includes('Claude Code'), 'header must name the runtime');
    assert.ok(html.includes('Beta'), 'the surface is still beta and must say so');
    // Basename in the chrome, full path still reachable by assistive tech.
    assert.ok(html.includes('webcli'), 'working directory leaf missing');
    assert.ok(html.includes('/home/dev/projects/webcli'), 'full path must stay announced');
    assert.ok(html.includes('Ready'), 'idle state indicator missing');
    assert.ok(html.includes('aria-live="polite"'), 'state indicator must be announced');
    assert.ok(!html.includes('Pending approvals'), 'nothing is pending here');
    assert.ok(html.includes('Message Claude Code'), 'composer placeholder missing');
  });

  it('shows the live state and the streamed text while a turn runs', function () {
    const controller = controllerWith({
      state: 'thinking',
      messages: [
        message('m1', 1, 'user', 'refactor the parser'),
        message('m2', 2, 'assistant', 'Reading the parser now', { streaming: true }),
      ],
      cursor: 2,
    });

    const html = render({ controller });

    assert.ok(html.includes('Thinking'), 'thinking state must reach the header');
    assert.ok(html.includes('refactor the parser'), 'user turn missing');
    assert.ok(html.includes('Reading the parser now'), 'streamed assistant text missing');
    assert.ok(!html.includes('Nothing here yet'), 'the transcript is not empty');
  });

  it('pins a pending approval outside the scroller and announces it', function () {
    const controller = controllerWith({
      state: 'awaiting_permission',
      pendingPermissions: [
        {
          requestId: 'p1',
          title: 'Run npm test',
          toolKind: 'execute',
          input: { command: 'npm', args: ['test'] },
          options: [
            { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
          ],
          ts: 1,
        },
      ],
    });

    const html = render({ controller });

    assert.ok(html.includes('aria-label="Pending approvals"'), 'approval region missing');
    assert.ok(html.includes('aria-live="assertive"'), 'a blocked agent must interrupt');
    assert.ok(html.includes('Run npm test'), 'approval title missing');
    assert.ok(html.includes('Allow once') && html.includes('Deny'), 'approval options missing');
    assert.ok(html.includes('Waiting for you'), 'header must show the session is blocked');
    // The composer cannot move this forward, so it must not pretend it can.
    assert.ok(/<textarea[^>]*disabled/.test(html), 'composer stays disabled while blocked');
  });

  it('puts the plan in a right rail on desktop', function () {
    const controller = controllerWith({
      plan: [
        { text: 'Read the reducer', status: 'completed' },
        { text: 'Wire the view', status: 'in_progress' },
      ],
    });

    const html = render({ controller });

    assert.ok(html.includes('aria-label="Plan"'), 'plan rail missing');
    assert.ok(html.includes('Wire the view'), 'plan item missing');
    assert.ok(html.includes('1 of 2'), 'plan progress missing');
  });

  it('states plainly that an exited session is over and offers nothing it cannot do', function () {
    const controller = controllerWith({ state: 'exited', live: false });
    const html = render({ controller });

    assert.ok(html.includes('has exited'), 'exit must be stated');
    assert.ok(html.includes('read-only'), 'the transcript is read-only after an exit');
    assert.ok(html.includes('Exited'), 'header indicator must follow the state');
    assert.ok(/<textarea[^>]*disabled/.test(html), 'a dead process cannot take input');
    for (const word of ['Restart', 'Resume', 'Reconnect', 'Try again']) {
      assert.ok(!html.includes(word), `${word} promises something this pane cannot do`);
    }
  });

  it('surfaces the transcript error rather than an empty error state', function () {
    const controller = controllerWith({}, [
      { t: 'error', seq: 1, ts: 1, message: 'stdio closed unexpectedly', fatal: true },
    ]);

    const html = render({ controller });

    assert.ok(html.includes('stdio closed unexpectedly'), 'lastError must be shown verbatim');
    assert.ok(html.includes('role="alert"'), 'a fatal error must be announced immediately');
    assert.ok(html.includes('Error'), 'header indicator must follow the state');
  });

  it('collapses the rails and keeps touch targets on mobile', function () {
    const controller = controllerWith({
      plan: [{ text: 'Wire the view', status: 'in_progress' }],
    });

    const html = render({ controller, isMobile: true });

    assert.ok(!html.includes('aria-label="Plan"'), 'the side rail must not survive on a phone');
    assert.ok(html.includes('aria-expanded="false"'), 'plan collapses to a disclosure');
    assert.ok(html.includes('0 of 1'), 'the collapsed summary still reports progress');
    assert.ok(html.includes('env(safe-area-inset-bottom'), 'composer must clear the home bar');
    // Every control in this pane has to be thumb-sized; 34 is the app's floor.
    assert.ok(html.includes('min-height:34px'), 'disclosure below the touch-target floor');
  });

  it('keeps an active permission bypass on screen for the whole session', function () {
    const html = render({ controller: controllerWith({}), bypassPermissions: true });
    assert.ok(html.includes('Approvals bypassed'), 'an active bypass must stay visible');

    const off = render({ controller: controllerWith({}) });
    assert.ok(!off.includes('Approvals bypassed'), 'no warning when nothing is bypassed');
  });

  it('themes from CSS custom properties rather than baked-in colours', function () {
    const html = render({
      controller: controllerWith({
        state: 'awaiting_permission',
        plan: [{ text: 'Wire the view', status: 'in_progress' }],
        messages: [message('m1', 1, 'user', 'hello')],
        cursor: 1,
      }),
    });

    const withoutSvg = html.replace(/<svg[\s\S]*?<\/svg>/g, '');
    const hex = withoutSvg.match(/(?:color|background|border|fill)[^;"']*#[0-9a-fA-F]{3,8}/g);
    assert.deepStrictEqual(hex, null, `hardcoded colours found: ${hex && hex.join(', ')}`);
  });

  it('wires the composer and the approval buttons to the controller', function () {
    // The rendered markup cannot prove a callback landed, so the wiring is
    // checked against the messages the controller would put on the socket.
    const controller = controllerWith({});
    controller.sendTurn('do the thing', []);
    controller.respondPermission('p1', 'allow_once');
    controller.interrupt();

    assert.deepStrictEqual(
      controller.sent.map((m) => m.type),
      ['chat_send', 'chat_permission_response', 'chat_interrupt'],
    );
  });
});
