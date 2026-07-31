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
    `export { Composer, placeByPickOrder } from ${JSON.stringify(path.join(ROOT, 'src/client/shell/chat/Composer'))};`,
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

  describe('the files on the unsent message', function () {
    // Attachments belong to the message, and the message belongs to the
    // conversation rather than to the window it is being typed in (#163). So a
    // chip has to be drawable from what every screen has — a url, a name and a
    // size — and not only from the `File` the picking browser happens to hold.
    const shot = {
      url: '/api/sessions/s1/chat-attachments/abc123-shot.png',
      name: 'abc123-shot.png',
      mime: 'image/png',
      size: 4096,
    };

    it('draws a file picked on another screen, which sent no File with it', function () {
      const html = render({ attachments: [shot], onAttachmentsChange() {} });
      assert.ok(html.includes('aria-label="Attachments"'), 'the row of chips must be there at all');
      assert.ok(html.includes('abc123-shot.png'), 'the name is the only thing that says which file it is');
      assert.ok(html.includes('4 kB'), 'and the size, as it does for a local one');
    });

    it('shows the picture from the server, not from a blob only one window can resolve', function () {
      const html = render({ attachments: [shot], onAttachmentsChange() {} });
      assert.ok(
        html.includes(`src="${shot.url}"`),
        'a blob: url would draw a broken image on every screen but the one that picked it',
      );
    });

    it('offers to take it off the message, by name', function () {
      const html = render({ attachments: [shot], onAttachmentsChange() {} });
      assert.ok(html.includes('aria-label="Remove abc123-shot.png"'));
    });

    it('draws an icon rather than a picture for something that is not one', function () {
      const html = render({
        attachments: [{ ...shot, name: 'notes.pdf', mime: 'application/pdf' }],
        onAttachmentsChange() {},
      });
      assert.ok(!html.includes(`src="${shot.url}"`), 'a pdf is not a thumbnail');
      assert.ok(html.includes('notes.pdf'));
    });

    it('can send with nothing typed, as long as something is attached', function () {
      const html = render({ attachments: [shot], onAttachmentsChange() {} });
      assert.ok(!html.includes('aria-label="Send message" disabled'), 'a screenshot on its own is a message');
    });

    // Uploads run at the same time, so a small file overtakes a large one. What
    // must not change is the order the files were *picked* in: "here is before,
    // here is after" reaching the agent the other way round is not cosmetic.
    describe('the order they were picked in', function () {
      const at = (n) => ({ url: `/u/${n}`, name: `${n}.png`, mime: 'image/png', size: 1 });
      const seen = (list) => list.map((a) => a.name).join(' ');

      it('puts a file that finished second back in front of one picked after it', function () {
        const order = new Map([['/u/c', 3]]);
        // c was picked third and landed first; b was picked second.
        const list = mod.placeByPickOrder([at('c')], at('b'), 2, order);
        assert.strictEqual(seen(list), 'b.png c.png');
      });

      it('appends one picked after everything already there', function () {
        const order = new Map([['/u/a', 1]]);
        assert.strictEqual(seen(mod.placeByPickOrder([at('a')], at('b'), 2, order)), 'a.png b.png');
      });

      it('never moves a file that came from another screen', function () {
        // Nothing is known about when the peer's file was chosen, so it stays
        // where it is and the local one goes after it.
        const list = mod.placeByPickOrder([at('peer')], at('mine'), 1, new Map());
        assert.strictEqual(seen(list), 'peer.png mine.png');
      });

      it('keeps a whole batch in order however it finishes', function () {
        const order = new Map();
        let list = [];
        for (const [name, picked] of [['c', 3], ['a', 1], ['d', 4], ['b', 2]]) {
          list = mod.placeByPickOrder(list, at(name), picked, order);
          order.set(`/u/${name}`, picked);
        }
        assert.strictEqual(seen(list), 'a.png b.png c.png d.png');
      });
    });

    it('draws no row at all when the message has no files', function () {
      const html = render({ attachments: [], onAttachmentsChange() {} });
      assert.ok(!html.includes('aria-label="Attachments"'));
    });
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

    // Issue #135. A model reaches a conversation three ways — this chat's own
    // pick, the account's standing choice, the active runtime profile — and
    // until now the control said nothing about which. On a profile-pinned
    // install that was the worst case: the pin was genuinely in force and the
    // chip read the literal word "model". The menu is click-toggled state, so
    // the browser check owns the open sheet; what a static pass reaches is the
    // resting hover, which is also the only route to this on a desktop without
    // covering the composer.
    describe('where the model came from', function () {
      it('names the account’s standing choice', function () {
        const html = render({
          model: 'claude-opus-4-6',
          capabilities: caps({}),
          modelDefault: { model: 'claude-opus-4-6', source: 'personal' },
        });
        assert.ok(
          html.includes('Your standing choice for this runtime: claude-opus-4-6.'),
          html.match(/title="Model[^"]*"/)?.[0] || 'no model title',
        );
      });

      it('names the profile that pinned it', function () {
        const html = render({
          model: 'profile-model',
          capabilities: caps({}),
          modelDefault: { model: 'profile-model', source: 'profile', profileName: 'House' },
        });
        assert.ok(
          html.includes('From the &quot;House&quot; runtime profile: profile-model.'),
          html.match(/title="Model[^"]*"/)?.[0] || 'no model title',
        );
      });

      it('says plainly when nobody has chosen', function () {
        const html = render({
          model: 'grok-build',
          capabilities: caps({}),
          modelDefault: { model: null, source: 'runtime' },
        });
        assert.ok(
          html.includes('No default set — this runtime picks for itself.'),
          html.match(/title="Model[^"]*"/)?.[0] || 'no model title',
        );
      });

      // Clearing does not fall back to a standing choice, it forgets one — and
      // saying "falls back to your last choice" would describe the opposite of
      // what the click does.
      it('says a conversation-only pick is exactly that, and what clearing it costs', function () {
        const html = render({
          model: 'claude-haiku',
          modelOverride: 'claude-haiku',
          capabilities: caps({}),
          modelDefault: { model: 'claude-opus-4-6', source: 'personal' },
        });
        assert.ok(html.includes('Chosen for this conversation only.'), 'the override is named as one');
        assert.ok(
          html.includes('forgets claude-opus-4-6 as your standing choice for this runtime'),
          html.match(/title="Model[^"]*"/)?.[0] || 'no model title',
        );
      });

      it('falls back to the profile when this conversation is the only thing overriding it', function () {
        const html = render({
          model: 'claude-haiku',
          modelOverride: 'claude-haiku',
          capabilities: caps({}),
          modelDefault: { model: 'profile-model', source: 'profile', profileName: 'House' },
        });
        assert.ok(
          html.includes('Clearing falls back to the &quot;House&quot; runtime profile: profile-model.'),
          html.match(/title="Model[^"]*"/)?.[0] || 'no model title',
        );
      });

      // The word "model" used to sit on the chip for the whole of a
      // conversation whose runtime never emits a session event, which is every
      // conversation before its first turn.
      //
      // Restated: this asserted the *default* was what the chip named, which was
      // the defect the adversarial review caught. A default is what the next new
      // chat would open on — it changes under an open conversation every time
      // the same account picks a model in another tab, and it may never have
      // been applied to this one at all. What the chip names is the model the
      // launch actually used, which the server now sends as `modelPinned`.
      it('names the model this conversation launched on, not the word “model”', function () {
        const html = render({
          capabilities: caps({}),
          modelPinned: 'profile-model',
          modelDefault: { model: 'profile-model', source: 'profile', profileName: 'House' },
        });
        assert.ok(html.includes('>profile-model<'), 'what the launch used is what the chip names');
      });

      // The half of the same defect that the restatement above cannot show: a
      // default the conversation was never launched on must not reach the chip.
      it('never names a default this conversation was not launched on', function () {
        const html = render({
          capabilities: caps({}),
          modelPinned: null,
          modelDefault: { model: 'claude-opus-4-6', source: 'personal' },
        });
        assert.ok(
          !html.includes('>claude-opus-4-6<'),
          'this conversation launched with no model flag; the standing choice is for the next one',
        );
        assert.ok(html.includes('>model<'), 'so the chip claims nothing, as it always did');
      });

      // And says so, rather than leaving a sentence about the default to be read
      // as a statement about what is running.
      it('says a pinned conversation is staying on its model when the default has moved', function () {
        const html = render({
          capabilities: caps({}),
          modelPinned: 'claude-sonnet-4-5',
          modelDefault: { model: 'claude-opus-4-6', source: 'personal' },
        });
        assert.ok(
          html.includes('Staying on claude-sonnet-4-5.'),
          html.match(/title="Model[^"]*"/)?.[0] || 'no model title',
        );
        assert.ok(
          html.includes('Your standing choice for this runtime: claude-opus-4-6.'),
          'and the default is still named, as the answer for the next new chat',
        );
      });

      // The ladder (#171). A conversation running on a rung has to say which
      // rung, because the whole reason somebody builds one is to control what
      // each turn costs — and "which model" without "how expensive" is half the
      // answer they were after.
      it('names the rung on the chip itself, not only in the menu', function () {
        const html = render({
          capabilities: caps({}),
          modelPinned: 'gateway/mid-model',
          modelOrigin: {
            model: 'gateway/mid-model',
            source: 'ladder',
            profileName: 'Economy',
            tier: 'mid',
          },
        });
        assert.ok(html.includes('gateway/mid-model · mid'), 'the rung belongs beside the model');
      });

      it('says the model came from the ladder, and from which rung', function () {
        const html = render({
          capabilities: caps({}),
          modelPinned: 'gateway/mid-model',
          modelOrigin: {
            model: 'gateway/mid-model',
            source: 'ladder',
            profileName: 'Economy',
            tier: 'mid',
          },
        });
        assert.ok(
          html.includes('Running on the mid rung of the &quot;Economy&quot; ladder.'),
          html.match(/title="Model[^"]*"/)?.[0] || 'no model title',
        );
      });

      it('explains a rung it fell to rather than reporting one nobody chose', function () {
        const html = render({
          capabilities: caps({}),
          modelPinned: 'h',
          modelOrigin: {
            model: 'h', source: 'ladder', profileName: 'Economy', tier: 'high', requestedTier: 'mid',
          },
        });
        assert.ok(
          html.includes('mid is blank, so the nearest filled rung answered'),
          html.match(/title="Model[^"]*"/)?.[0] || 'no model title',
        );
      });

      it('says when a standing choice is what is running, not the ladder', function () {
        const html = render({
          capabilities: caps({}),
          modelPinned: 'my/standing-choice',
          modelOrigin: { model: 'my/standing-choice', source: 'personal' },
          modelDefault: { model: 'my/standing-choice', source: 'personal' },
        });
        assert.ok(
          html.includes('Running on your standing choice for this runtime.'),
          html.match(/title="Model[^"]*"/)?.[0] || 'no model title',
        );
        assert.ok(!html.includes(' · mid'), 'no rung, because no rung decided this');
      });

      // The pin and the default agreeing is the ordinary case, and it must not
      // produce a sentence telling the user something is staying put.
      it('says nothing about staying when the pin is the default', function () {
        const html = render({
          capabilities: caps({}),
          modelPinned: 'profile-model',
          modelDefault: { model: 'profile-model', source: 'profile', profileName: 'House' },
        });
        assert.ok(!html.includes('Staying on'), html.match(/title="Model[^"]*"/)?.[0] || 'no title');
      });

      // A pin and a choice arrive under the same origin source, because the
      // record cannot tell a model apart by where it came from once a
      // conversation is fixed to it. Only one of them is something the user
      // said, and the sentence has to be the one that is true — the picker
      // "must not describe it as a choice" is the pin field's own rule.
      it('does not call a model the conversation launched on a choice', function () {
        const html = render({
          capabilities: caps({}),
          modelPinned: 'from/the-profile',
          modelOrigin: { model: 'from/the-profile', source: 'override' },
          modelDefault: { model: 'something/else', source: 'profile', profileName: 'House' },
        });
        assert.ok(
          html.includes('Staying on from/the-profile, the model it launched on.'),
          html.match(/title="Model[^"]*"/)?.[0] || 'no model title',
        );
        assert.ok(
          !html.includes('Chosen for this conversation only'),
          'nobody chose it, and there is nothing here to clear',
        );
      });

      it('still calls a model the user picked a choice', function () {
        const html = render({
          capabilities: caps({}),
          modelOverride: 'picked/in-this-chat',
          modelOrigin: { model: 'picked/in-this-chat', source: 'override' },
        });
        assert.ok(
          html.includes('Chosen for this conversation only.'),
          html.match(/title="Model[^"]*"/)?.[0] || 'no model title',
        );
      });

      // Version skew: a server that predates this says nothing, and the control
      // has to read exactly as it shipped rather than assert a source.
      it('renders exactly as before against a server that says nothing', function () {
        const before = render({ model: 'grok-build', capabilities: caps({}) });
        const after = render({ model: 'grok-build', capabilities: caps({}), modelDefault: null });
        assert.strictEqual(after, before);
        assert.ok(before.includes('title="Model: grok-build"'), 'and the hover is the old one');
      });
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
