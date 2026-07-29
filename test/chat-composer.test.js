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

  it('shows one waiting message whole, and withdrawable', function () {
    const html = render({
      busy: true,
      capabilities: caps({ interrupt: true }),
      queued: [{ id: 'q1', text: 'first in line', ts: 1 }],
      onCancelQueued() {},
    });

    assert.ok(html.includes('aria-label="Messages waiting to be sent"'), 'the line is a labelled region');
    assert.ok(html.includes('first in line'), 'the message is shown');
    assert.ok(html.includes('aria-label="Remove queued message 1"'), 'and can be withdrawn');
    assert.ok(!/aria-label="Show \d+ more waiting/.test(html), 'with nothing to open behind it');
  });

  it('collapses more than one to the newest, with a count of the rest', function () {
    const html = render({
      busy: true,
      capabilities: caps({ interrupt: true }),
      queued: [
        { id: 'q1', text: 'first in line', ts: 1 },
        { id: 'q2', text: 'second in line', ts: 2 },
        { id: 'q3', text: 'third in line', ts: 3, attachments: [{ url: '/a', mime: 'image/png', name: 'a.png', size: 3 }] },
      ],
      onCancelQueued() {},
    });

    // The newest is the one still being reconsidered, so it is the one on show.
    assert.ok(html.includes('third in line'), 'the message just typed is the one drawn');
    assert.ok(!html.includes('first in line'), 'the rest are behind the count, not stacked up the screen');
    assert.ok(html.includes('aria-label="Show 2 more waiting messages"'), 'and the count says how many');
    assert.ok(html.includes('aria-expanded="false"'), 'the control reports that the list is shut');
    assert.ok(
      html.includes('aria-label="Remove queued message 3"'),
      'the message on show keeps everything it had',
    );
    assert.ok(
      /3 messages waiting to be sent, 2 hidden/.test(html),
      'and the count reaches a screen reader, not only the glyph on the button',
    );
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

    // Issue #128, the answer to the question #119 deliberately left open. The
    // box itself is raised by an effect and so never renders in a static pass —
    // the browser check owns that half. What is visible here is the other half
    // of the same rule: the hover, which a live confirmation used to hold for
    // the rest of the conversation, displacing the description of what the
    // control does with a sentence the chip underneath the pointer already says.
    it('lets a model change that took effect pass in silence, and reports the ones the chip cannot show', function () {
      const live = render({
        model: 'grok-3-fast',
        capabilities: caps({ models: [{ value: 'grok-3-fast', name: 'grok-3-fast' }] }),
        modelFeedback: { applied: 'live', message: 'Switched to grok-3-fast for this conversation.' },
      });
      assert.ok(
        !live.includes('Switched to grok-3-fast for this conversation.'),
        'a model that landed is announced by the chip relabelling itself, not by a second copy of the news',
      );
      assert.ok(
        live.includes('title="Model: grok-3-fast"'),
        'so the hover goes back to describing the control',
      );
      assert.ok(live.includes('>grok-3-fast<'), 'and the chip is the thing carrying the change');

      // Every other outcome means the conversation is not running on what was
      // picked. Dropping these would leave a change looking made that was not.
      for (const applied of ['sent', 'pending', 'cleared']) {
        const message = `an outcome the chip cannot show for itself: ${applied}`;
        const html = render({ model: 'grok-3-fast', capabilities: caps({}), modelFeedback: { applied, message } });
        assert.ok(
          html.includes(message),
          `${applied} is not a change that simply took effect, so it still has to reach the user`,
        );
      }
    });

    it('shows nothing extra when there is no feedback yet', function () {
      const html = render({ capabilities: caps({}) });
      assert.ok(!html.includes('role="status"'), 'no stray feedback region before anything has been picked');
    });
  });

  // The effort chip's popup is click-toggled state like the model chip's, so a
  // static render only ever shows it shut — these assert the trigger and what it
  // says about the level in force, not the menu behind it. The ladder here is
  // claude's, spaced the way `rankedEfforts` spaces a five-level list, because
  // the rank is what the colour and the meter are both computed from and a made
  // up spacing would be testing arithmetic this component does not do.
  describe('the effort control', function () {
    const efforts = [
      { value: 'low', name: 'Low', rank: 0 },
      { value: 'medium', name: 'Medium', rank: 0.25 },
      { value: 'high', name: 'High', rank: 0.5 },
      { value: 'xhigh', name: 'Extra high', rank: 0.75 },
      { value: 'max', name: 'Max', rank: 1 },
    ];

    it('offers a control when the runtime published a ladder to choose from', function () {
      const html = render({ capabilities: caps({ efforts }) });
      assert.ok(
        html.includes('aria-label="Change how hard the agent thinks"'),
        'a published ladder is the whole precondition for the control',
      );
      assert.ok(html.includes('aria-haspopup="listbox"'), 'the trigger says a menu is behind it');
      assert.ok(html.includes('aria-expanded="false"'), 'and that the menu is currently shut');
    });

    // The deliberate difference from the model chip above, which is always
    // present. A model can be typed at any runtime and tried, so offering the
    // control is never wrong. An effort level cannot: with no published ladder
    // there is no value the server would accept, so the control could only ever
    // refuse — and it would charge the row for the privilege, which on a phone
    // means pushing Send onto a line of its own to make room for a button that
    // does nothing.
    it('takes itself off the row entirely for a runtime that published no ladder', function () {
      const html = render({ capabilities: caps({}) });
      assert.ok(
        !html.includes('aria-label="Change how hard the agent thinks"'),
        'no ladder means no control at all — not a disabled one, and not an empty one',
      );
      assert.ok(html.includes('aria-label="Change model"'), 'while the model control, which can always be tried, stays');
      assert.ok(html.includes('aria-label="Send message"'), 'and the space goes back to the control that needed it');
    });

    it('takes itself off the row for a runtime that published an empty ladder', function () {
      const html = render({ capabilities: caps({ efforts: [] }) });
      assert.ok(
        !html.includes('aria-label="Change how hard the agent thinks"'),
        'a ladder with no rungs on it is the same offer as no ladder',
      );
    });

    it('names the level this conversation is running at, not the cheapest on the ladder', function () {
      const html = render({ effort: 'high', capabilities: caps({ efforts }) });
      assert.ok(html.includes('>High<'), 'the level in force is the one on the chip');
      assert.ok(!html.includes('Low'), 'the first entry of the ladder is not a default label');
      assert.ok(html.includes('title="Effort: High"'), 'and the long form names it too');
    });

    it('colours and fills the chip by where the level sits on its own runtime’s ladder', function () {
      const low = render({ effort: 'low', capabilities: caps({ efforts }) });
      const high = render({ effort: 'max', capabilities: caps({ efforts }) });
      // The bottom stop is a bare ramp variable; the top is the last stop mixed
      // fully over the one below it, which is what interpolating rather than
      // snapping costs at the end of the ladder.
      const lowTone = 'var(--effort-0)';
      const highTone = 'color-mix(in oklab, var(--effort-4) 100%, var(--effort-3))';
      assert.ok(low.includes(`color:${lowTone}`), 'the bottom of the ladder is the same grey as every other chip');
      assert.ok(high.includes(`color:${highTone}`), 'the top of it reaches the loud end of the ramp');
      assert.ok(!high.includes(`color:${lowTone}`), 'the two ends are not the same colour');
      // `low` is rank 0, so one bar; `max` is rank 1, so all four. The meter is
      // what survives a colourblind reader, so it has to move with the level
      // rather than sit at a decorative constant.
      const bars = (html, tone) => html.split(`background:${tone}`).length - 1;
      assert.strictEqual(bars(low, lowTone), 1, 'the least thinking lights one bar');
      assert.strictEqual(bars(high, highTone), 4, 'the most lights all of them');
      assert.strictEqual(bars(low, 'var(--border)'), 3, 'and the rest of the meter stays unlit at the bottom');
      assert.strictEqual(bars(high, 'var(--border)'), 0, 'with nothing left unlit at the top');
    });

    it('claims no rank for a level the runtime never published', function () {
      // A level left over from before a model switch narrowed the ladder. It
      // cannot be placed on this runtime's scale, so the chip declines to name
      // it rather than attaching this ladder's colour and meter to it.
      const html = render({ effort: 'ultra', capabilities: caps({ efforts }) });
      assert.ok(!html.includes('ultra'), 'a level off the ladder is not read back as though it were on it');
      assert.ok(html.includes('>effort<'), 'the chip names nothing instead');
      assert.ok(!html.includes('var(--effort-'), 'and takes none of the ramp with it');
      assert.strictEqual(
        (html.match(/background:var\(--border\)/g) || []).length,
        4,
        'every bar stays unfilled, because there is no rank to fill them to',
      );
    });

    it('is not disabled when the whole composer is', function () {
      // Same reasoning as the model control: a dead session is exactly when this
      // is worth touching, because the level is stored against the conversation
      // and applies the next time one starts.
      const html = render({ disabled: true, capabilities: caps({ efforts }) });
      assert.ok(html.includes('aria-label="Change how hard the agent thinks"'), 'the control survives a dead session');
      assert.ok(
        !/aria-label="Change how hard the agent thinks"[^>]*disabled/.test(html),
        'and stays usable, because what it saves is for next time',
      );
    });

    it('shows nothing extra before anything has been picked', function () {
      const html = render({ capabilities: caps({ efforts }) });
      assert.ok(!html.includes('role="status"'), 'no stray feedback region until the server has said something');
      assert.ok(!html.includes('role="listbox"'), 'and the menu stays shut until it is asked for');
    });

    // Issue #119. The popup itself is raised by an effect and so never renders
    // in a static pass — the browser check owns that half. What is visible here
    // is the other half of the same rule: the hover, which a live confirmation
    // used to hold for the rest of the conversation, displacing the description
    // of what the control does with a sentence the chip underneath the pointer
    // already spells out.
    it('lets a change that took effect pass in silence, and reports the ones the chip cannot show', function () {
      const live = render({
        effort: 'high',
        capabilities: caps({ efforts }),
        effortFeedback: { applied: 'live', message: 'Now thinking at high.' },
      });
      assert.ok(
        !live.includes('Now thinking at high.'),
        'a level that landed is announced by the chip redrawing, not by a second copy of the news',
      );
      assert.ok(
        live.includes('title="Effort: High"'),
        'so the hover goes back to describing the control',
      );
      assert.ok(live.includes('>High<'), 'and the chip is the thing carrying the change');

      // Every other outcome means the conversation is not running at what was
      // picked. Dropping these would leave a change looking made that was not.
      for (const applied of ['refused', 'pending', 'sent', 'cleared']) {
        const message = `an outcome the chip cannot show for itself: ${applied}`;
        const html = render({
          effort: 'high',
          capabilities: caps({ efforts }),
          effortFeedback: { applied, message },
        });
        assert.ok(
          html.includes(message),
          `${applied} is not a change that simply took effect, so it still has to reach the user`,
        );
      }
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
