const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Composer.tsx never reaches dist/ on its own — esbuild bundles it straight
// into app.bundle.js for the browser, same as the Relay primitives. This
// bundles it for Node and renders it with representative capability
// combinations, which is what catches a control that renders when its
// runtime cannot back it (a stop button with no interrupt, an attach button
// with no upload handler) or one that fails to render when it should.

const ROOT = path.join(__dirname, '..');

let mod;

before(function () {
  this.timeout(60000);
  const contents = [
    `export { renderToStaticMarkup } from 'react-dom/server';`,
    `export * as React from 'react';`,
    `export { Composer } from ${JSON.stringify(path.join(ROOT, 'src/client/shell/chat/Composer'))};`,
  ].join('\n');

  const out = path.join(os.tmpdir(), `chat-composer-${process.pid}.js`);
  require('esbuild').buildSync({
    stdin: { contents, resolveDir: ROOT, loader: 'tsx', sourcefile: 'chat-composer.tsx' },
    bundle: true,
    outfile: out,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    target: ['node20'],
    logLevel: 'silent',
  });
  mod = require(out);
  mod.__file = out;
});

after(function () {
  if (mod && mod.__file) fs.rmSync(mod.__file, { force: true });
});

// Every ChatCapabilities field, defaulted off, so each test only turns on
// what it means to exercise.
function caps(overrides) {
  return Object.assign(
    {
      streaming: false,
      thinking: false,
      toolCalls: false,
      diffs: false,
      permissions: false,
      interrupt: false,
      resume: false,
      fork: false,
      attachments: false,
      usage: false,
      cost: false,
      plan: false,
    },
    overrides,
  );
}

function render(props) {
  const { renderToStaticMarkup, React, Composer } = mod;
  return renderToStaticMarkup(
    React.createElement(Composer, Object.assign({ onSend() {}, onInterrupt() {}, busy: false, capabilities: caps({}) }, props)),
  );
}

describe('Composer', function () {
  it('renders a bare idle composer with nothing extra a runtime did not opt into', function () {
    const html = render({});
    assert.ok(html.length > 0);
    assert.ok(html.includes('aria-label="Send message"'), 'idle state should offer a send control');
    assert.ok(!html.includes('aria-label="Stop"'), 'not busy: no stop control');
    assert.ok(!html.includes('cannot be interrupted'), 'not busy: no interrupt explainer either');
    assert.ok(!html.includes('aria-label="Attach a file or image"'), 'attachments capability is off');
    assert.ok(!html.includes('role="listbox"'), 'no commands were advertised');
    assert.ok(!html.includes('role="combobox"'), 'combobox role is not worn when there are no commands to complete');
  });

  it('shows a live stop button only when busy and the runtime supports interrupt', function () {
    const idle = render({ busy: false, capabilities: caps({ interrupt: true }) });
    assert.ok(!idle.includes('aria-label="Stop"'), 'interrupt capability alone, while idle, must not show Stop');

    const busyWithInterrupt = render({ busy: true, capabilities: caps({ interrupt: true }) });
    assert.ok(busyWithInterrupt.includes('aria-label="Stop"'), 'busy + interrupt: Stop must appear');
    // Stop no longer *replaces* Send: a turn typed while the agent works is
    // queued rather than refused, so both controls have a job at the same time.
    assert.ok(!busyWithInterrupt.includes('aria-label="Send message"'), 'while busy, sending is queueing and says so');
    assert.ok(busyWithInterrupt.includes('aria-label="Queue this message"'), 'the send control stays, relabelled');
    assert.ok(
      /aria-label="Stop" title="Stop"(?![^>]*disabled)/.test(busyWithInterrupt),
      'a working Stop control must not be disabled',
    );

    const busyWithoutInterrupt = render({ busy: true, capabilities: caps({ interrupt: false }) });
    assert.ok(!busyWithoutInterrupt.includes('aria-label="Stop"'), 'no bare "Stop" label when the runtime cannot honour it');
    assert.ok(
      busyWithoutInterrupt.includes('This runtime cannot be interrupted'),
      'the control must explain itself rather than silently doing nothing',
    );
  });

  it('renders the attach affordance only when both the capability and an upload handler are present', function () {
    const noCapability = render({ capabilities: caps({ attachments: true }) }); // no onUpload
    assert.ok(!noCapability.includes('aria-label="Attach a file or image"'), 'attachments advertised but nothing to do the uploading');

    const noFlag = render({ capabilities: caps({ attachments: false }), onUpload: async () => ({ url: '/x', mime: 'image/png', name: 'x', size: 1 }) });
    assert.ok(!noFlag.includes('aria-label="Attach a file or image"'), 'onUpload alone is not the capability');

    const both = render({
      capabilities: caps({ attachments: true }),
      onUpload: async () => ({ url: '/x', mime: 'image/png', name: 'x', size: 1 }),
    });
    assert.ok(both.includes('aria-label="Attach a file or image"'), 'capability + handler: the paperclip must appear');
    assert.ok(both.includes('type="file"'), 'a real file input backs the button');
  });

  it('shows the slash-command popup only with commands advertised and a matching draft', function () {
    const commands = [
      { name: 'clear', description: 'Clear the conversation' },
      { name: 'compact', description: 'Summarize context', hint: '[on|off]' },
    ];

    const noCommands = render({ capabilities: caps({ commands: [] }), draft: '/' });
    assert.ok(!noCommands.includes('role="listbox"'), 'an empty command list means no popup, ever');
    assert.ok(!noCommands.includes('role="combobox"'), 'and the textarea does not claim combobox semantics either');

    const notSlash = render({ capabilities: caps({ commands }), draft: 'hello' });
    assert.ok(!notSlash.includes('role="listbox"'), 'commands exist but the draft is not a slash command');
    assert.ok(notSlash.includes('aria-label="Slash commands and skills"'), 'a button reaches the list without typing "/"');
    assert.ok(notSlash.includes('role="combobox"'), 'the textarea still advertises the capability structurally');
    assert.ok(notSlash.includes('aria-expanded="false"'), 'closed combobox reports aria-expanded=false');

    const open = render({ capabilities: caps({ commands }), draft: '/' });
    assert.ok(open.includes('role="listbox"'), 'a bare slash with commands available must open the popup');
    assert.ok(open.includes('role="option"'), 'options are exposed with proper combobox semantics');
    assert.ok(open.includes('/clear') && open.includes('/compact'), 'every matching command is listed');
    assert.ok(open.includes('[on|off]'), 'a hint is shown when the command carries one');
    assert.ok(open.includes('aria-expanded="true"'), 'open combobox reports aria-expanded=true');
    assert.ok(open.includes('aria-activedescendant='), 'the active option is identified for assistive tech');

    const filtered = render({ capabilities: caps({ commands }), draft: '/comp' });
    assert.ok(filtered.includes('/compact') && !filtered.includes('/clear'), 'typing narrows the match list');
  });

  it('keeps sending available while the agent is busy, because a turn queues', function () {
    const busy = render({ busy: true, draft: 'the next thing', capabilities: caps({ interrupt: true }) });
    assert.ok(
      /aria-label="Queue this message"(?![^>]*disabled)/.test(busy),
      'a drafted message must be sendable mid-run — the server queues it',
    );
    assert.ok(busy.includes('will go as soon as this turn finishes'), 'and the composer says what will happen to it');
  });

  it('lists what is waiting, in order, each one withdrawable', function () {
    const html = render({
      busy: true,
      capabilities: caps({ interrupt: true }),
      queued: [
        { id: 'q1', text: 'first in line', ts: 1 },
        { id: 'q2', text: 'second in line', ts: 2, attachments: [{ url: '/a', mime: 'image/png', name: 'a.png', size: 3 }] },
      ],
      onCancelQueued() {},
    });

    assert.ok(html.includes('aria-label="Messages waiting to be sent"'), 'the line is a labelled region');
    assert.ok(html.indexOf('first in line') < html.indexOf('second in line'), 'oldest first');
    assert.ok(html.includes('aria-label="Remove queued message 1"'), 'each waiting turn can be withdrawn');
    assert.ok(html.includes('aria-label="Remove queued message 2"'));
  });

  it('offers no withdraw control when nothing can act on it', function () {
    const html = render({ queued: [{ id: 'q1', text: 'waiting', ts: 1 }] });
    assert.ok(html.includes('waiting'), 'the turn is still shown');
    assert.ok(!html.includes('aria-label="Remove queued message 1"'), 'but not a button that would do nothing');
  });

  it('renders nothing extra when the queue is empty', function () {
    assert.ok(!render({}).includes('Messages waiting to be sent'));
  });

  it('offers the file picker only when something can search for files', function () {
    const without = render({});
    assert.ok(!without.includes('aria-label="Reference a file from this project"'));
    assert.ok(!without.includes('role="combobox"'), 'nothing completes, so it is not a combobox');

    const with_ = render({ onFindFiles: async () => [] });
    assert.ok(with_.includes('aria-label="Reference a file from this project"'), 'the @ button needs no typing to find');
    assert.ok(with_.includes('role="combobox"'), 'the field completes, so it says so throughout');
  });

  it('does not offer the file picker on a dead session', function () {
    const html = render({ disabled: true, onFindFiles: async () => [] });
    assert.ok(!html.includes('aria-label="Reference a file from this project"'));
  });

  it('disables the whole composer via the disabled prop', function () {
    const html = render({ disabled: true, capabilities: caps({ attachments: true, interrupt: true }), onUpload: async () => ({ url: '/x', mime: 'image/png', name: 'x', size: 1 }) });
    assert.ok(html.length > 0);
    assert.ok(/<textarea[^>]*disabled=""/.test(html), 'the textarea itself must go inert');
  });

  // ModelChip's own open/closed state is a plain click-toggled useState, unlike
  // the slash-command popup above (whose "open" is derived from the draft, so
  // static markup can render it open). A static render can only ever show it
  // closed, so these assert what is true of every runtime regardless of
  // whether it has a model list, a live switch, or neither — the always-on
  // control and its labelling — rather than the popup's own contents.
  describe('the model control', function () {
    it('is always present and never disabled, even when the whole composer is', function () {
      const html = render({ disabled: true, capabilities: caps({}) });
      assert.ok(html.includes('aria-label="Change model"'), 'a runtime with no model list or /model command still gets a control');
      assert.ok(
        !/aria-label="Change model"[^>]*disabled/.test(html),
        'the model control must not be disabled by the composer being disabled — that is exactly the case where it saves for next session',
      );
    });

    it('labels the conversation’s own model over the menu’s first entry', function () {
      const models = [
        { value: 'a', name: 'Model A' },
        { value: 'b', name: 'Model B' },
      ];
      const html = render({ model: 'b', capabilities: caps({ models }) });
      assert.ok(html.includes('>Model B<'), 'the session’s actual model is shown, not the first item in the menu');
    });

    it('falls back to whatever was typed when it matches nothing in the menu', function () {
      const html = render({ model: 'a-custom-name', capabilities: caps({}) });
      assert.ok(html.includes('>a-custom-name<'), 'a free-typed override with no matching menu entry is still the label');
    });

    it('surfaces the server’s feedback after a pick, in each of the three shapes', function () {
      const live = render({ model: 'grok-3-fast', modelFeedback: { applied: 'live', message: 'Switched to grok-3-fast for this conversation.' } });
      assert.ok(live.includes('Switched to grok-3-fast for this conversation.'));

      const sent = render({ model: 'claude-opus', modelFeedback: { applied: 'sent', message: 'Sent "/model claude-opus" to the session — check the transcript to confirm it took.' } });
      assert.ok(sent.includes('check the transcript to confirm it took'));

      const pending = render({ model: 'some-model', modelFeedback: { applied: 'pending', message: 'Saved. some-model will be used the next time a new session starts for this conversation.' } });
      assert.ok(pending.includes('will be used the next time a new session starts'));
    });

    it('shows nothing extra when there is no feedback yet', function () {
      const html = render({ capabilities: caps({}) });
      assert.ok(!html.includes('role="status"'), 'no stray feedback region before anything has been picked');
    });
  });

  it('survives an empty draft and a very long one', function () {
    const empty = render({ draft: '' });
    assert.ok(empty.length > 0);

    const long = render({ draft: 'x'.repeat(20000) });
    assert.ok(long.length > 0);
    assert.ok(long.includes('x'.repeat(200)), 'the long draft text itself is rendered, not truncated');
  });
});
