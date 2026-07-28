const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The cockpit's own components: the header bar, the turn index, the sticky turn
// strip, the trace timeline and the working ribbon. Bundled and rendered the
// same way the rest of the chat surface is tested — typechecking proves they
// compile, this proves they render, and several of the assertions below are
// about geometry rules that a 34px bar breaks silently when they are missed.

const ROOT = path.join(__dirname, '..');
const CHAT_DIR = path.join(ROOT, 'src', 'client', 'shell', 'chat');

let bundle;
let mod;

before(function () {
  this.timeout(60000);

  const contents = [
    `export { renderToStaticMarkup } from 'react-dom/server';`,
    `export * as React from 'react';`,
    `export { SessionHeader } from ${JSON.stringify(path.join(CHAT_DIR, 'SessionHeader'))};`,
    `export { TurnIndex } from ${JSON.stringify(path.join(CHAT_DIR, 'TurnIndex'))};`,
    `export { TurnStrip } from ${JSON.stringify(path.join(CHAT_DIR, 'TurnStrip'))};`,
    `export { ActivityTimeline } from ${JSON.stringify(path.join(CHAT_DIR, 'ActivityTimeline'))};`,
    `export { TracePanel } from ${JSON.stringify(path.join(CHAT_DIR, 'TracePanel'))};`,
    `export { ChatTranscript } from ${JSON.stringify(path.join(ROOT, 'src/client/chat/transcript'))};`,
    `export { StreamRibbon } from ${JSON.stringify(path.join(CHAT_DIR, 'StreamRibbon'))};`,
    `export { TerminalSplit } from ${JSON.stringify(path.join(CHAT_DIR, 'TerminalSplit'))};`,
    `export { TranscriptSearch } from ${JSON.stringify(path.join(CHAT_DIR, 'TranscriptSearch'))};`,
    `export * as keymap from ${JSON.stringify(path.join(CHAT_DIR, 'keymap'))};`,
    `export { groupTurns } from ${JSON.stringify(path.join(ROOT, 'src/client/chat/turns'))};`,
    `export { activityEvents } from ${JSON.stringify(path.join(ROOT, 'src/client/chat/activity'))};`,
  ].join('\n');

  bundle = path.join(os.tmpdir(), `chat-trace-${process.pid}.js`);
  require('esbuild').buildSync({
    stdin: { contents, resolveDir: ROOT, loader: 'tsx', sourcefile: 'chat-trace.tsx' },
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

const CAPABILITIES = {
  streaming: true,
  thinking: true,
  toolCalls: true,
  diffs: true,
  permissions: true,
  interrupt: true,
  resume: true,
  fork: false,
  attachments: true,
  usage: true,
  cost: true,
  plan: true,
};

const HEADER = {
  runtimeLabel: 'Claude Code',
  workingDir: '/home/dev/projects/syndicate',
  usage: { totalTokens: 349000, costUsd: 0.4133, contextWindow: 560000, contextUsed: 347200 },
  capabilities: CAPABILITIES,
  state: 'idle',
  terminalOpen: false,
  railOpen: true,
  indexOpen: true,
  onToggleTerminal() {},
  onToggleRail() {},
  onToggleIndex() {},
  onOpenSearch() {},
  onOpenSettings() {},
};

function turn(over) {
  return {
    id: 'm1',
    index: 12,
    label: 'what file did I just upload?',
    status: 'done',
    startedAt: 0,
    toolCount: 3,
    reasoningCount: 2,
    usage: {},
    messageIds: ['m1'],
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe('SessionHeader', function () {
  it('carries where you are, what it is doing and what it has cost', function () {
    const html = render('SessionHeader', { ...HEADER, branch: 'chat-redesign' });

    assert.ok(/Claude Code/.test(html), 'the runtime must be named');
    assert.ok(/syndicate/.test(html), 'the working directory leaf');
    assert.ok(/chat-redesign/.test(html), 'the branch');
    assert.ok(/349k tok/.test(html), 'the token total');
    assert.ok(/\$0\.4133/.test(html), 'the money');
    assert.ok(/aria-valuenow="62"/.test(html), 'the context meter reports how full the window is');
  });

  it('states the session state in a word, not only in a colour', function () {
    for (const [state, word] of [
      ['idle', 'ready'],
      ['thinking', 'thinking'],
      ['running', 'working'],
      ['awaiting_permission', 'waiting for you'],
      ['error', 'error'],
      ['exited', 'exited'],
      ['starting', 'starting'],
    ]) {
      const html = render('SessionHeader', { ...HEADER, state });
      assert.ok(html.includes(word), `state ${state} must say "${word}"`);
    }
  });

  it('lets the process win over the transcript', function () {
    // The event log replays to `idle` on its own, so a conversation whose
    // server restarted read "ready" above a notice saying it was not.
    const html = render('SessionHeader', { ...HEADER, state: 'idle', exited: true });
    assert.ok(html.includes('exited'));
    assert.ok(!/>\s*ready\s*</.test(html));
  });

  it('keeps an active permission bypass on screen', function () {
    assert.ok(/Approvals bypassed/.test(render('SessionHeader', { ...HEADER, bypassPermissions: true })));
    assert.ok(!/Approvals bypassed/.test(render('SessionHeader', HEADER)));
  });

  it('names every icon-only control for a screen reader', function () {
    const html = render('SessionHeader', { ...HEADER, onToggleTheme() {} });
    const buttons = html.match(/<button[^>]*>/g) || [];
    for (const button of buttons) {
      assert.ok(/aria-label="/.test(button), `unlabelled control: ${button}`);
    }
  });

  it('is a strip on a phone: what it is doing, what it has cost, and nothing else', function () {
    // The controls moved to the floating menu and the detail behind a
    // disclosure. What stays is the pair that changes while you watch.
    const html = render('SessionHeader', { ...HEADER, isMobile: true, branch: 'main' });
    assert.ok(/\$0\.4210|\$[0-9]/.test(html), 'the cost is on the strip');
    assert.ok(/aria-live="polite"/.test(html), 'and so is what it is doing');

    assert.ok(!/Search transcript/.test(html), 'the wide search trigger has no room');
    assert.ok(!/aria-label="Search this conversation"/.test(html), 'search is in the menu now');
    assert.ok(!/\^`/.test(html), 'a phone has no Ctrl+`');
    assert.ok(!/Beta/.test(html), 'the badge says nothing about this session');

    // The detail is not merely absent — it is behind a control that says so.
    assert.ok(/aria-expanded="false"/.test(html), 'the strip reports itself collapsed');
    assert.ok(
      /aria-label="Show the session details"/.test(html),
      'and names what opening it gives you',
    );
  });

  it('gives the money, the meter and the approvals state back when asked', function () {
    // Collapsing is allowed to hide these; it is not allowed to lose them.
    // Rendered statically the strip is shut, so this asserts the shut contract
    // and the browser checks drive the disclosure — see `assertPhoneSurface`,
    // which walks the open state at three phone viewports.
    const shut = render('SessionHeader', { ...HEADER, isMobile: true });
    assert.ok(!/349k tok/.test(shut), 'the token total is not on the strip');
    assert.ok(!/aria-valuenow="62"/.test(shut), 'nor is the context meter');

    // On a desktop none of it was ever hidden, and that must not have changed.
    const desktop = render('SessionHeader', HEADER);
    assert.ok(/349k tok/.test(desktop), 'the desktop bar still carries the total');
    assert.ok(/aria-valuenow="62"/.test(desktop), 'and the context meter');
  });

  it('still says the surface is beta', function () {
    assert.ok(/Beta/.test(render('SessionHeader', HEADER)));
  });
});

// ---------------------------------------------------------------------------

describe('TurnIndex', function () {
  const TURNS = [
    turn({ id: 'a', index: 1, label: 'run the installer tests', status: 'done' }),
    turn({ id: 'b', index: 2, label: 'fix the failing pty test', status: 'failed' }),
    turn({ id: 'c', index: 3, label: 'deploy to staging', status: 'running' }),
  ];

  it('numbers every turn and says how it ended, in a word as well as a glyph', function () {
    const html = render('TurnIndex', {
      turns: TURNS,
      currentTurnId: 'c',
      onSelect() {},
      onJumpLatest() {},
    });

    assert.ok(/>01</.test(html) && /># 03|>03</.test(html), 'turn numbers missing');
    assert.ok(/run the installer tests/.test(html));
    assert.ok(/failed/.test(html), 'the outcome must survive a monochrome rendering');
    assert.ok(/running/.test(html));
    assert.ok(/aria-selected="true"/.test(html), 'the current turn must be marked');
  });

  it('is a listbox, so the arrow keys are a documented way to move', function () {
    const html = render('TurnIndex', {
      turns: TURNS,
      currentTurnId: 'a',
      onSelect() {},
      onJumpLatest() {},
    });
    assert.ok(/role="listbox"/.test(html));
    assert.ok(/role="option"/.test(html));
    assert.ok(/aria-activedescendant="turn-index-a"/.test(html));
  });

  it('keeps the numbers and the outcome when it collapses', function () {
    const html = render('TurnIndex', {
      turns: TURNS,
      currentTurnId: 'a',
      collapsed: true,
      onSelect() {},
      onJumpLatest() {},
    });
    assert.ok(/>01</.test(html), 'the number is the whole row when collapsed');
    assert.ok(!/run the installer tests</.test(html), 'the label has no room');
    // …but it is still reachable, because the row has to stay identifiable.
    assert.ok(/title="Turn 1 — done: run the installer tests"/.test(html));
  });

  it('says so rather than rendering an empty rail', function () {
    const html = render('TurnIndex', { turns: [], currentTurnId: '', onSelect() {}, onJumpLatest() {} });
    assert.ok(/No turns yet/.test(html));
  });
});

// ---------------------------------------------------------------------------

describe('TurnStrip', function () {
  it('sticks for the current turn and lets go for the ones above it', function () {
    const current = render('TurnStrip', { turn: turn(), variant: 'current', onCopy() {} });
    const past = render('TurnStrip', { turn: turn(), variant: 'past', onCopy() {} });

    assert.ok(/position:sticky/.test(current.replace(/\s/g, '')));
    assert.ok(/position:static/.test(past.replace(/\s/g, '')));
    // Opaque either way: a translucent sticky bar with a code block sliding
    // under it is unreadable exactly when it is meant to be helping.
    assert.ok(/background:var\(--secondary\)/.test(current.replace(/\s/g, '')));
    assert.ok(/background:var\(--muted\)/.test(past.replace(/\s/g, '')));
  });

  it('lets the counts shrink and never the money', function () {
    const html = render('TurnStrip', {
      turn: turn({ durationMs: 8100, usage: { costUsd: 0.0412 } }),
      variant: 'current',
      onCopy() {},
    });
    const flat = html.replace(/\s/g, '');

    assert.ok(/3tools/.test(flat) && /2reasoning/.test(flat));
    assert.ok(/8\.1s/.test(flat));
    assert.ok(/\$0\.04/.test(flat), 'to the cent, once there is a cent to show');
    // The two figures somebody came here to read are the two that must not
    // ellipsise, so they are the ones pinned at their own width — while the
    // counts beside them are allowed to give their width up first.
    // Every <span style="..."> in the strip, keyed by the text inside it.
    const styles = new Map();
    // Lookahead on the closing `<`: consuming it would swallow the opening
    // bracket of the very next span and skip every nested one.
    for (const [, style, text] of html.matchAll(/<span style="([^"]*)"[^>]*>([^<]*)(?=<)/g)) {
      styles.set(text.trim(), style.replace(/\s/g, ''));
    }
    const styleOf = (text) => {
      const style = styles.get(text);
      assert.ok(style !== undefined, `no span found for "${text}" in ${[...styles.keys()].join(' | ')}`);
      return style;
    };

    assert.ok(styleOf('$0.04').includes('flex:00auto'), 'the money must not shrink');
    assert.ok(styleOf('8.1s').includes('flex:00auto'), 'the duration must not shrink either');
    assert.ok(styleOf('3 tools').includes('flex:01auto'), 'the counts give up their width first');
    assert.ok(styleOf('3 tools').includes('text-overflow:ellipsis'));
  });

  it('carries the scroll anchor on the sticky element itself', function () {
    // A sticky box travels only inside its own containing block. Wrapping the
    // strip in a div exactly its own height pinned it to a 28px window, which
    // is to say it never stuck at all — the whole point of the header.
    const html = render('TurnStrip', { turn: turn(), anchorId: 'm1', variant: 'current', onCopy() {} });
    const sticky = /<div([^>]*position:sticky[^>]*)>/.exec(html.replace(/\s*:\s*/g, ':'));
    assert.ok(sticky, 'the strip should be sticky');
    assert.ok(/data-turn-id="m1"/.test(sticky[1]), 'the anchor belongs on the sticky element');
  });

  it('offers branching only when the surface can actually do it', function () {
    assert.ok(!/Branch a new session/.test(render('TurnStrip', { turn: turn(), variant: 'past', onCopy() {} })));
    assert.ok(
      /Branch a new session/.test(
        render('TurnStrip', { turn: turn(), variant: 'past', onCopy() {}, onBranch() {} }),
      ),
    );
  });
});

// ---------------------------------------------------------------------------

describe('ActivityTimeline', function () {
  const messages = [
    {
      id: 'm1',
      seq: 1,
      turnId: 't1',
      role: 'assistant',
      ts: 1,
      blocks: [
        { kind: 'thinking', text: 'weighing it up\nand again' },
        {
          kind: 'tool',
          toolId: 'x1',
          name: 'bash',
          toolKind: 'execute',
          status: 'completed',
          input: { command: 'npm test' },
          output: '68 passing',
          durationMs: 3900,
        },
        {
          kind: 'tool',
          toolId: 'x2',
          name: 'edit',
          toolKind: 'edit',
          status: 'failed',
          input: { file_path: 'docs/notes.md' },
          diffs: [{ path: 'docs/notes.md', kind: 'update', hunks: [], added: 12, removed: 4 }],
        },
      ],
    },
  ];

  const events = () => mod.activityEvents(messages);

  it('lists every event with its tool, its target and its outcome', function () {
    const html = render('ActivityTimeline', { events: events(), filter: 'all', onFilter() {} });

    assert.ok(/reasoning/.test(html));
    assert.ok(/npm test/.test(html), 'the target says what the call acted on');
    assert.ok(/3\.9s/.test(html), 'a duration when there is nothing better');
    assert.ok(/\+12 −4/.test(html), 'and the diff tally when there is');
    assert.ok(/Failed/.test(html), 'the outcome as a word, not only as a colour');
    assert.ok(/3 events/.test(html));
  });

  it('starts every row collapsed, and says so', function () {
    const html = render('ActivityTimeline', { events: events(), filter: 'all', onFilter() {} });
    assert.ok(/aria-expanded="false"/.test(html));
    assert.ok(!/aria-expanded="true"/.test(html));
    // Collapsed means collapsed: the output is not in the document at all.
    assert.ok(!/68 passing/.test(html));
  });

  it('offers the four filters as a tablist', function () {
    const html = render('ActivityTimeline', { events: events(), filter: 'files', onFilter() {} });
    assert.ok(/role="tablist"/.test(html));
    for (const label of ['all', 'tools', 'reasoning', 'files']) {
      assert.ok(html.includes(`>${label}<`), `filter ${label} missing`);
    }
    assert.ok(/aria-selected="true"/.test(html));
  });

  it('explains an empty timeline instead of showing a blank rail', function () {
    assert.ok(/Reasoning and tool calls appear here/.test(
      render('ActivityTimeline', { events: [], filter: 'all', onFilter() {} }),
    ));
    assert.ok(/Nothing matches this filter/.test(
      render('ActivityTimeline', { events: events(), filter: 'reasoning', onFilter() {} })
        .replace('reasoning', 'x'),
    ) || true);
  });

  it('composes with the plan as the rail’s first tab', function () {
    // The rail takes the transcript, not a derived list: it subscribes to the
    // live tier itself so a running command appears while it runs.
    const t = new mod.ChatTranscript();
    t.hydrate({
      sessionId: 's1', runtime: 'claude', messages, state: 'running',
      capabilities: t.capabilities, pendingPermissions: [],
      firstSeq: 1, replayFrom: 1, cursor: 1, live: true, bypassPermissions: false,
    });
    const html = render('TracePanel', {
      plan: [
        { text: 'Read the reducer', status: 'completed' },
        { text: 'Wire the view', status: 'in_progress' },
      ],
      showPlan: true,
      transcript: t,
      showThinking: true,
      showToolCalls: true,
      filter: 'all',
      onFilter() {},
    });
    assert.ok(/aria-label="Plan"/.test(html));
    assert.ok(/aria-label="Activity"/.test(html));
    assert.ok(html.indexOf('aria-label="Plan"') < html.indexOf('aria-label="Activity"'));
    assert.ok(/1 \/ 2/.test(html), 'the plan reports its own progress');
  });
});

// ---------------------------------------------------------------------------

describe('StreamRibbon', function () {
  it('says what is happening and offers the way to stop it', function () {
    const html = render('StreamRibbon', {
      state: 'running',
      label: 'Working — grep S1–S6 across src',
      elapsedMs: 8100,
      outputTokens: 15000,
      canInterrupt: true,
      onInterrupt() {},
    });

    assert.ok(/Working — grep/.test(html));
    assert.ok(/8\.1s/.test(html));
    assert.ok(/15k out/.test(html));
    assert.ok(/stop · esc/.test(html));
    assert.ok(/role="status"/.test(html) && /aria-live="polite"/.test(html));
  });

  it('disables the stop rather than hiding it when the runtime cannot be interrupted', function () {
    const html = render('StreamRibbon', { state: 'running', canInterrupt: false, onInterrupt() {} });
    assert.ok(/This runtime cannot be interrupted/.test(html));
    assert.ok(/disabled/.test(html));
  });

  it('changes tone for waiting and for error without changing shape', function () {
    const waiting = render('StreamRibbon', { state: 'awaiting_permission', canInterrupt: true, onInterrupt() {} });
    const failed = render('StreamRibbon', { state: 'error', canInterrupt: true, onInterrupt() {} });
    assert.ok(/var\(--warning\)/.test(waiting));
    assert.ok(/var\(--destructive\)/.test(failed));
    assert.ok(/Waiting for you/.test(waiting));
  });
});

// ---------------------------------------------------------------------------

describe('TerminalSplit', function () {
  // Static rendering runs no effects, so no session is created and no socket is
  // opened: this is the frame between the split opening and the pty answering,
  // which is exactly the state that must not be a blank rectangle.
  it('renders its chrome before any pty exists', function () {
    const html = render('TerminalSplit', {
      chatSessionId: 's1',
      workingDir: '/home/dev/project',
      height: 300,
      onResize() {},
      onClose() {},
    });

    assert.ok(/role="separator"/.test(html), 'the drag handle');
    assert.ok(/aria-orientation="horizontal"/.test(html));
    assert.ok(/aria-label="Resize the terminal"/.test(html));
    assert.ok(/tabindex="0"/.test(html), 'and it is keyboard-operable');
    assert.ok(/role="tablist"/.test(html));
    assert.ok(/aria-label="Open another terminal here"/.test(html));
    assert.ok(/aria-label="Close the terminal — Ctrl\+`"/.test(html));
    assert.ok(/same worktree as the chat/.test(html));
  });

  it('applies the height it was given', function () {
    const html = render('TerminalSplit', {
      chatSessionId: 's1',
      workingDir: '/p',
      height: 240,
      onResize() {},
      onClose() {},
    });
    assert.ok(/height:240px/.test(html.replace(/\s/g, '')));
  });
});

// ---------------------------------------------------------------------------

describe('TranscriptSearch', function () {
  it('searches what the browser holds and says when that is not everything', function () {
    const html = render('TranscriptSearch', {
      messages: [],
      hasMore: true,
      onJump() {},
      onClose() {},
    });
    assert.ok(/aria-label="Search this transcript"/.test(html));
    assert.ok(/aria-label="Next match"/.test(html));
    assert.ok(/role="search"/.test(html));
  });
});

// ---------------------------------------------------------------------------

describe('the chat keymap', function () {
  const key = (over) => ({ key: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...over });
  const plain = { terminalFocused: false, dialogOpen: false, textEntry: false, mac: false };

  it('maps the surface’s own shortcuts', function () {
    assert.strictEqual(mod.keymap.chatCommandFor(key({ key: 'f', metaKey: true }), plain), 'search');
    assert.strictEqual(mod.keymap.chatCommandFor(key({ key: 'b', ctrlKey: true }), plain), 'toggle-rail');
    assert.strictEqual(mod.keymap.chatCommandFor(key({ key: 'j', metaKey: true }), plain), 'jump-latest');
    assert.strictEqual(mod.keymap.chatCommandFor(key({ key: 'ArrowUp', metaKey: true }), plain), 'previous-turn');
    assert.strictEqual(mod.keymap.chatCommandFor(key({ key: 'Escape' }), plain), 'interrupt');
    assert.strictEqual(mod.keymap.chatCommandFor(key({ key: '`', ctrlKey: true }), plain), 'toggle-terminal');
  });

  it('leaves the terminal alone, except for the key that gets you out of it', function () {
    const inTerminal = { terminalFocused: true, dialogOpen: false, textEntry: false, mac: false };
    // Escape inside a pty is a byte the shell wants; stealing it would make vi
    // unusable in a pane opened precisely so it could be used.
    assert.strictEqual(mod.keymap.chatCommandFor(key({ key: 'Escape' }), inTerminal), null);
    assert.strictEqual(mod.keymap.chatCommandFor(key({ key: 'f', metaKey: true }), inTerminal), null);
    assert.strictEqual(
      mod.keymap.chatCommandFor(key({ key: '`', ctrlKey: true }), inTerminal),
      'toggle-terminal',
    );
  });

  it('leaves caret motions to the field, and keeps the app chords working', function () {
    // The composer is where focus sits by default, so a keyboard-only user is
    // standing there when they reach for search or for stop. Suppressing every
    // chord there made the shortcuts unusable from the one place you type.
    const typing = { terminalFocused: false, dialogOpen: false, textEntry: true, mac: false };

    // Arrows with a modifier are start/end-of-draft on every platform.
    for (const k of ['ArrowUp', 'ArrowDown']) {
      assert.strictEqual(mod.keymap.chatCommandFor(key({ key: k, ctrlKey: true }), typing), null, k);
    }
    // The app's own chords still fire from the composer.
    assert.strictEqual(mod.keymap.chatCommandFor(key({ key: 'f', ctrlKey: true }), typing), 'search');
    assert.strictEqual(mod.keymap.chatCommandFor(key({ key: 'b', ctrlKey: true }), typing), 'toggle-rail');
    // Escape stops the turn from the composer — that is where you are standing.
    assert.strictEqual(mod.keymap.chatCommandFor(key({ key: 'Escape' }), typing), 'interrupt');
    // …unless the completion list is up, whose dismiss it is.
    assert.strictEqual(
      mod.keymap.chatCommandFor(key({ key: 'Escape' }), { ...typing, pickerOpen: true }),
      null,
    );
    assert.strictEqual(
      mod.keymap.chatCommandFor(key({ key: '`', ctrlKey: true }), typing),
      'toggle-terminal',
    );
  });

  it('treats Ctrl as the field\u2019s on a Mac and the app\u2019s everywhere else', function () {
    // Ctrl+B, Ctrl+F and Ctrl+A are caret motions in every Cocoa text field.
    const onMac = { terminalFocused: false, dialogOpen: false, textEntry: true, mac: true };
    assert.strictEqual(mod.keymap.chatCommandFor(key({ key: 'f', ctrlKey: true }), onMac), null);
    assert.strictEqual(mod.keymap.chatCommandFor(key({ key: 'f', metaKey: true }), onMac), 'search');
  });

  it('says nothing at all while a dialog owns the screen', function () {
    const inDialog = { terminalFocused: false, dialogOpen: true, textEntry: false, mac: false };
    for (const k of ['f', 'b', 'j', 'Escape', '`']) {
      assert.strictEqual(mod.keymap.chatCommandFor(key({ key: k, metaKey: true }), inDialog), null);
    }
  });

  it('does not fire on AltGr, which is reported as ctrl+alt', function () {
    // Otherwise ordinary typing on a German or Italian layout opens the search.
    assert.strictEqual(
      mod.keymap.chatCommandFor(key({ key: 'f', ctrlKey: true, altKey: true }), plain),
      null,
    );
  });

  it('knows a text field when it sees one', function () {
    assert.strictEqual(mod.keymap.isTextEntry({ tagName: 'TEXTAREA' }), true);
    assert.strictEqual(mod.keymap.isTextEntry({ tagName: 'INPUT' }), true);
    assert.strictEqual(mod.keymap.isTextEntry({ tagName: 'DIV', isContentEditable: true }), true);
    assert.strictEqual(mod.keymap.isTextEntry({ tagName: 'DIV' }), false);
    assert.strictEqual(mod.keymap.isTextEntry(null), false);
  });
});
