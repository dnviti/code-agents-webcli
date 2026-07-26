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
    `export * as viewSettings from ${JSON.stringify(path.join(ROOT, 'src', 'client', 'chat', 'view-settings'))};`,
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
  const controller = new mod.ChatController('s1', { send: (m) => sent.push(m) });
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
    // Basename in the chrome, full path still reachable by assistive tech.
    assert.ok(html.includes('webcli'), 'working directory leaf missing');
    assert.ok(html.includes('/home/dev/projects/webcli'), 'full path must stay announced');
    assert.ok(html.includes('ready'), 'idle state indicator missing');
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

    assert.ok(html.includes('thinking'), 'thinking state must reach the header');
    assert.ok(html.includes('refactor the parser'), 'user turn missing');
    assert.ok(html.includes('Reading the parser now'), 'streamed assistant text missing');
    assert.ok(!html.includes('Nothing here yet'), 'the transcript is not empty');
  });

  it('folds every turn but the newest, and keeps its ask readable while folded', function () {
    const controller = controllerWith({
      messages: [
        message('m1', 1, 'user', 'run the tests'),
        message('m2', 2, 'assistant', 'all green'),
        message('m3', 3, 'user', 'now deploy'),
        message('m4', 4, 'assistant', 'deployed'),
      ],
      cursor: 4,
    });

    const html = render({ controller });

    // Turn 1's disclosure reads closed and its body is hidden, without either
    // its ask or its outcome leaving the strip — folding history must not
    // mean losing the map of it.
    const closedToggle = /aria-label="Expand turn 1"[^>]*aria-expanded="false"|aria-expanded="false"[^>]*aria-label="Expand turn 1"/;
    assert.ok(closedToggle.test(html), 'turn 1 must read as collapsed');
    assert.ok(/id="turn-body-m1"[^>]*hidden=""/.test(html), 'turn 1 body must be hidden');
    assert.ok(html.includes('run the tests'), 'a collapsed turn must still show what was asked');

    // The newest turn opens by default and its body is not hidden.
    const openToggle = /aria-label="Collapse turn 2"[^>]*aria-expanded="true"|aria-expanded="true"[^>]*aria-label="Collapse turn 2"/;
    assert.ok(openToggle.test(html), 'turn 2 must read as open');
    assert.ok(!/id="turn-body-m3"[^>]*hidden=""/.test(html), 'the current turn must not be hidden');
    assert.ok(html.includes('deployed'), 'the open turn must show its content');

    // The strip stays mounted — and its actions reachable — for a folded turn.
    assert.ok(/aria-label="Copy this turn as Markdown"/.test(html), 'copy control must survive folding');
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
    assert.ok(html.includes('waiting for you'), 'header must show the session is blocked');
    // The composer stays live. Answering the approval is what unblocks the
    // agent, but the moment it is waiting on you is exactly when the follow-up
    // is worth typing — it is accepted and queued rather than refused.
    assert.ok(!/<textarea[^>]*disabled/.test(html), 'composer keeps accepting type-ahead while blocked');
    assert.ok(html.includes('Answer above'), 'the placeholder says what happens rather than forbidding it');
  });

  it('keeps the composer inside the conversation column, not across the whole surface', function () {
    // The composer used to be a sibling of the row that holds the workspace
    // rail, so it ran the full width of the surface: the rail was drawn over
    // the end of the input, and widening the rail covered more of it. The rail
    // now sits to the *right* of the column, so the order is reversed — what
    // has not changed is that the two are siblings in one flex row and neither
    // is drawn over the other.
    const html = render({
      controller: controllerWith({}),
      view: { ...mod.viewSettings.DEFAULT_CHAT_VIEW, panelOpen: true, panelTab: 'files' },
    });

    const composer = html.indexOf('aria-label="Message"');
    const rail = html.indexOf('aria-label="Workspace"');
    assert.ok(rail !== -1 && composer !== -1, 'both the rail and the composer should render');
    assert.ok(composer < rail, 'the composer belongs to the column that precedes the rail');
    // And the column has closed before the rail opens.
    assert.ok(html.lastIndexOf('</div>', rail) < rail);
  });

  it('carries the queue and its withdraw control down to the composer', function () {
    const controller = controllerWith({ state: 'thinking' });
    controller.handle({
      type: 'chat_queue',
      sessionId: 's1',
      queued: [{ id: 'q1', text: 'and then run the tests', ts: 2 }],
    });

    const html = render({ controller });
    assert.ok(html.includes('and then run the tests'), 'a waiting turn belongs on screen');
    assert.ok(html.includes('aria-label="Remove queued message 1"'), 'and must be withdrawable from here');
  });

  it('puts the plan at the top of the trace rail on desktop', function () {
    const controller = controllerWith({
      plan: [
        { text: 'Read the reducer', status: 'completed' },
        { text: 'Wire the view', status: 'in_progress' },
      ],
    });

    const html = render({ controller });

    assert.ok(html.includes('aria-label="Plan"'), 'plan panel missing');
    assert.ok(html.includes('Wire the view'), 'plan item missing');
    assert.ok(html.includes('1 / 2'), 'plan progress missing');
    // And the timeline underneath it, which is the rest of the tab.
    assert.ok(html.includes('aria-label="Activity"'), 'the trace timeline belongs below it');
  });

  it('moves reasoning and tool calls to the rail rather than dropping them', function () {
    const controller = controllerWith({
      messages: [
        message('m1', 1, 'user', 'run the tests'),
        {
          id: 'm2',
          seq: 2,
          turnId: 't1',
          role: 'assistant',
          ts: 2,
          blocks: [
            { kind: 'text', text: 'all green' },
            { kind: 'thinking', text: 'checking the suite' },
            {
              kind: 'tool',
              toolId: 'x1',
              name: 'bash',
              toolKind: 'execute',
              status: 'completed',
              input: { command: 'npm test' },
              output: '68 passing',
            },
          ],
        },
      ],
      cursor: 2,
    });

    const html = render({ controller });

    // On the timeline…
    assert.ok(html.includes('npm test'), 'the tool call belongs on the rail');
    assert.ok(html.includes('reasoning'), 'and so does the reasoning');
    // …and not in the prose, which keeps its answer.
    assert.ok(html.includes('all green'));
    assert.ok(!html.includes('68 passing'), 'tool output must not be back in the transcript');
    assert.ok(html.includes('show work'), 'the transcript keeps a pointer to it');
  });

  it('states plainly that an exited session is over', function () {
    // An empty transcript is the discriminator: there is no conversation to
    // offer to resume, so this is the plain statement and nothing else.
    const controller = controllerWith({ state: 'exited', live: false });
    const html = render({ controller });

    assert.ok(html.includes('has exited'), 'exit must be stated');
    assert.ok(html.includes('read-only'), 'the transcript is read-only after an exit');
    assert.ok(html.includes('exited'), 'header indicator must follow the state');
    assert.ok(/<textarea[^>]*disabled/.test(html), 'a dead process cannot take input');
    for (const word of ['Resume this conversation', 'Start a new chat']) {
      assert.ok(!html.includes(word), `${word} promises something there is nothing to do it to`);
    }
  });

  // The server keeps chat sessions in memory and transcripts on disk, so a
  // restart leaves exactly this: a conversation on screen with nothing running
  // it. What the user used to get was the app-wide "Connection error" panel and
  // a Retry that reconnected a socket which had never been the problem.
  describe('a conversation whose process is gone', function () {
    const DEAD = {
      live: false,
      state: 'idle',
      messages: [message('m1', 1, 'user', 'where were we?')],
      firstSeq: 1,
      cursor: 1,
    };

    it('offers to resume it or to start again, in the same tab', function () {
      const controller = controllerWith({ ...DEAD, nativeSessionId: 'native-7' });
      const html = render({ controller });

      assert.ok(html.includes('is no longer running'), 'the user must be told');
      assert.ok(html.includes('Resume this conversation'), 'resume must be offered');
      assert.ok(html.includes('Start a new chat'), 'starting over must be offered');
      assert.ok(html.includes('role="alert"'), 'this interrupts what the user was doing');
      assert.ok(
        /<textarea[^>]*disabled/.test(html),
        'typing would only produce the same failure again',
      );
    });

    it('names the runtime it knows rather than calling it "the agent"', function () {
      const controller = controllerWith({ ...DEAD, nativeSessionId: 'native-7' });
      const html = render({ controller });

      assert.ok(html.includes('Claude Code is no longer running'), 'the pane knows the name');
    });

    it('does not go on reporting Ready above a notice saying it is not', function () {
      // The log replays to `idle` on its own — a conversation that ended on a
      // finished turn reads as Ready — so the process state has to win.
      const controller = controllerWith({ ...DEAD, nativeSessionId: 'native-7' });
      const html = render({ controller });

      assert.ok(html.includes('exited'), 'the header must follow the process');
      assert.ok(!/>\s*ready\s*</.test(html), 'a dead session is not ready for anything');
    });

    it('does not offer a resume it cannot deliver', function () {
      // No native id recorded: the agent cannot be handed its own context back,
      // and a Resume that quietly produced a stranger would be the expensive
      // kind of wrong — it looks like it worked.
      const controller = controllerWith(DEAD);
      const html = render({ controller });

      assert.ok(html.includes('Start a new chat'), 'starting over is always possible');
      assert.ok(!html.includes('Resume this conversation'), 'resume must not be offered');
      assert.ok(html.includes('cannot be given its context back'), 'and the reason must be said');
    });

    it('asks the server to resume this session, not to open another', function () {
      const controller = controllerWith({ ...DEAD, nativeSessionId: 'native-7' });
      controller.relaunch('claude', { resume: true });

      const start = controller.sent.find((m) => m.type === 'start_chat');
      assert.ok(start, 'a relaunch must be requested');
      assert.strictEqual(start.sessionId, 's1', 'the same session, so the transcript stays');
      assert.strictEqual(start.options.resume, true);
    });

    it('starting again is a different request from resuming', function () {
      const controller = controllerWith({ ...DEAD, nativeSessionId: 'native-7' });
      controller.relaunch('claude', { resume: false });

      const start = controller.sent.find((m) => m.type === 'start_chat');
      assert.strictEqual(start.options.resume, false, 'the server clears the window on this');
    });

    it('takes the offer down on chat_started alone, with no new snapshot', function () {
      // The server announces a relaunch and sends no transcript with it —
      // rightly, since the browser already has this conversation. Clearing only
      // the stored reason left the derived one reporting the same thing from
      // `transcript.live`, so the offer sat over a session that was already
      // running and nothing changed until the page was reloaded.
      const controller = controllerWith({ ...DEAD, nativeSessionId: 'native-7' });
      assert.ok(controller.unavailableReason, 'the offer starts up');

      controller.handle({ type: 'chat_started', sessionId: 's1' });

      assert.strictEqual(controller.unavailableReason, null, 'and comes straight down');
      assert.strictEqual(controller.transcript.live, true, 'the transcript knows it is alive');
    });

    it('lets the composer come back, rather than staying disabled until a reload', function () {
      const controller = controllerWith({ ...DEAD, state: 'exited', nativeSessionId: 'native-7' });
      assert.ok(/<textarea[^>]*disabled/.test(render({ controller })), 'disabled to begin with');

      controller.handle({ type: 'chat_started', sessionId: 's1' });
      // What the relaunched session emits first.
      controller.transcript.apply({ t: 'state', seq: 41, ts: 1, state: 'idle' });

      const html = render({ controller });
      assert.ok(!/<textarea[^>]*disabled/.test(html), 'a running session takes input');
      assert.ok(!html.includes('is no longer running'));
    });

    it('offers it for a cleared conversation too, which has no messages left', function () {
      // `/clear` and "start a new chat" both empty the window while leaving the
      // log — and the runtime behind it can still be gone. Gating the offer on
      // having messages put this case back into the failure it exists to fix.
      const controller = controllerWith({
        live: false,
        state: 'idle',
        messages: [],
        firstSeq: 40,
        cursor: 40,
        nativeSessionId: 'native-7',
      });

      assert.ok(controller.unavailableReason, 'an empty window is not an empty session');
      assert.ok(render({ controller }).includes('is no longer running'));
    });

    it('says nothing at all about a session where chat never started', function () {
      // Same shape from the store — no process, no messages — and the right
      // answer is the opposite one: there is nothing here to resume.
      const controller = controllerWith({ live: false, state: 'idle', messages: [], firstSeq: 1, cursor: 0 });

      assert.strictEqual(controller.unavailableReason, null);
      assert.ok(!render({ controller }).includes('is no longer running'));
    });

    it('reports a send that found nothing to send to as this, not as an error', function () {
      const controller = controllerWith({ live: true, state: 'idle' });
      const claimed = controller.handle({
        type: 'chat_unavailable',
        sessionId: 's1',
        runtimeLabel: 'Claude',
        canResume: true,
        message: 'this chat session is not running',
      });

      assert.ok(claimed, 'the chat surface owns this message');
      assert.strictEqual(controller.unavailableReason.runtimeLabel, 'Claude');
      assert.strictEqual(controller.unavailableReason.canResume, true);
    });
  });

  it('surfaces the transcript error rather than an empty error state', function () {
    const controller = controllerWith({}, [
      { t: 'error', seq: 1, ts: 1, message: 'stdio closed unexpectedly', fatal: true },
    ]);

    const html = render({ controller });

    assert.ok(html.includes('stdio closed unexpectedly'), 'lastError must be shown verbatim');
    assert.ok(html.includes('role="alert"'), 'a fatal error must be announced immediately');
    assert.ok(html.includes('>error<'), 'header indicator must follow the state');
  });

  it('collapses the rails and keeps touch targets on mobile', function () {
    const controller = controllerWith({
      plan: [{ text: 'Wire the view', status: 'in_progress' }],
    });

    // Told to show the conversation, which is what a phone is given: whether
    // the rail is open is the shell's answer now, not a stored preference this
    // component reads — see AppShell's `phonePanel`, and the shell test that
    // asserts a phone never opens onto a panel.
    const html = render({
      controller,
      isMobile: true,
      view: { ...mod.viewSettings.DEFAULT_CHAT_VIEW, panelOpen: false },
    });

    assert.ok(!html.includes('aria-label="Workspace"'), 'the conversation is what is showing');
    assert.ok(html.includes('aria-expanded="false"'), 'plan collapses to a disclosure');
    assert.ok(html.includes('0 of 1'), 'the collapsed summary still reports progress');
    assert.ok(html.includes('env(safe-area-inset-bottom'), 'composer must clear the home bar');
    // Every control in this pane has to be thumb-sized; 34 is the app's floor.
    assert.ok(html.includes('min-height:34px'), 'disclosure below the touch-target floor');
  });

  // Acceptance criterion §7.6: a blocked agent must stay answerable with the
  // rail closed, the terminal open, and on a phone. The phone was the case that
  // broke — the rail took over the whole column, approvals and composer with it.
  it('keeps a pending approval answerable on a phone with the rail open', function () {
    const controller = controllerWith({
      state: 'awaiting_permission',
      pendingPermissions: [
        {
          requestId: 'p1',
          title: 'Remove the build directory',
          toolKind: 'delete',
          input: { path: 'dist' },
          options: [
            { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
          ],
          ts: 1,
        },
      ],
    });

    const html = render({
      controller,
      isMobile: true,
      view: { ...mod.viewSettings.DEFAULT_CHAT_VIEW, panelOpen: true, panelTab: 'trace' },
    });

    assert.ok(html.includes('Remove the build directory'), 'the approval must stay on screen');
    assert.ok(html.includes('Allow once') && html.includes('Deny'), 'and must stay answerable');
    assert.ok(html.includes('aria-label="Message"'), 'and the composer must survive with it');
  });

  it('keeps a pending approval answerable with the terminal open', function () {
    const controller = controllerWith({
      state: 'awaiting_permission',
      pendingPermissions: [
        {
          requestId: 'p1',
          title: 'Run npm test',
          toolKind: 'execute',
          options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
          ts: 1,
        },
      ],
    });

    const html = render({
      controller,
      view: { ...mod.viewSettings.DEFAULT_CHAT_VIEW, terminalOpen: true },
    });

    assert.ok(html.includes('Run npm test'));
    assert.ok(html.includes('Allow once'));
    assert.ok(html.includes('aria-label="Resize the terminal"'), 'with the split actually open');
  });

  it('keeps an active permission bypass on screen for the whole session', function () {
    // Read off the snapshot rather than handed in as a prop: the server records
    // the mode against the conversation, and this is the path that has to answer
    // for a chat rejoined after its agent — or the whole server — has gone.
    const html = render({ controller: controllerWith({ bypassPermissions: true }) });
    assert.ok(html.includes('Approvals bypassed'), 'an active bypass must stay visible');

    const off = render({ controller: controllerWith({}) });
    assert.ok(!off.includes('Approvals bypassed'), 'no warning when nothing is bypassed');
  });

  it('states the mode of a conversation with nothing running it', function () {
    // The case the fix exists for. The process is gone and only the transcript is
    // on screen; the badge still has to say which mode a relaunch comes back in,
    // because a silently restored bypass is as bad as a silently dropped one.
    const html = render({
      controller: controllerWith({ bypassPermissions: true, live: false, cursor: 4 }),
    });

    assert.ok(html.includes('Approvals bypassed'), 'an offline chat still has a mode');
  });

  it('takes a relaunch mode from the server rather than asking for one', function () {
    // A browser's copy of the mode is exactly the thing that used to be wrong
    // after a restart, so a relaunch names none and the server restores the one
    // recorded against the conversation.
    const controller = controllerWith({ bypassPermissions: true, live: false, cursor: 4 });
    controller.relaunch('claude', { resume: true });

    const launch = controller.sent.filter((m) => m.type === 'start_chat').pop();
    assert.ok(launch, 'the relaunch must reach the server');
    assert.strictEqual(launch.options.resume, true);
    assert.ok(
      !('dangerouslySkipPermissions' in launch.options),
      'the client must not ask for a standing permission',
    );
  });

  it('follows the mode the launch reports, not the one it asked for', function () {
    const controller = controllerWith({});
    assert.strictEqual(controller.transcript.bypassing, false);

    controller.handle({ type: 'chat_started', sessionId: 's1', bypassPermissions: true });
    assert.strictEqual(controller.transcript.bypassing, true);
    assert.ok(
      render({ controller }).includes('Approvals bypassed'),
      'the restored mode has to be stated when the conversation comes back',
    );
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
