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
    assert.ok(!html.includes('aria-label="Attach a file"'), 'attachments capability is off');
    assert.ok(!html.includes('role="listbox"'), 'no commands were advertised');
    assert.ok(!html.includes('role="combobox"'), 'combobox role is not worn when there are no commands to complete');
  });

  it('shows a live stop button only when busy and the runtime supports interrupt', function () {
    const idle = render({ busy: false, capabilities: caps({ interrupt: true }) });
    assert.ok(!idle.includes('aria-label="Stop"'), 'interrupt capability alone, while idle, must not show Stop');

    const busyWithInterrupt = render({ busy: true, capabilities: caps({ interrupt: true }) });
    assert.ok(busyWithInterrupt.includes('aria-label="Stop"'), 'busy + interrupt: Stop must appear');
    assert.ok(!busyWithInterrupt.includes('aria-label="Send message"'), 'Stop replaces Send, it does not sit beside it');
    assert.ok(!busyWithInterrupt.includes('disabled'), 'a working Stop control must not be disabled');

    const busyWithoutInterrupt = render({ busy: true, capabilities: caps({ interrupt: false }) });
    assert.ok(!busyWithoutInterrupt.includes('aria-label="Stop"'), 'no bare "Stop" label when the runtime cannot honour it');
    assert.ok(
      busyWithoutInterrupt.includes('This runtime cannot be interrupted'),
      'the control must explain itself rather than silently doing nothing',
    );
  });

  it('renders the attach affordance only when both the capability and an upload handler are present', function () {
    const noCapability = render({ capabilities: caps({ attachments: true }) }); // no onUpload
    assert.ok(!noCapability.includes('aria-label="Attach a file"'), 'attachments advertised but nothing to do the uploading');

    const noFlag = render({ capabilities: caps({ attachments: false }), onUpload: async () => ({ url: '/x', mime: 'image/png', name: 'x', size: 1 }) });
    assert.ok(!noFlag.includes('aria-label="Attach a file"'), 'onUpload alone is not the capability');

    const both = render({
      capabilities: caps({ attachments: true }),
      onUpload: async () => ({ url: '/x', mime: 'image/png', name: 'x', size: 1 }),
    });
    assert.ok(both.includes('aria-label="Attach a file"'), 'capability + handler: the paperclip must appear');
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

  it('disables the whole composer via the disabled prop', function () {
    const html = render({ disabled: true, capabilities: caps({ attachments: true, interrupt: true }), onUpload: async () => ({ url: '/x', mime: 'image/png', name: 'x', size: 1 }) });
    assert.ok(html.length > 0);
    assert.ok(/<textarea[^>]*disabled=""/.test(html), 'the textarea itself must go inert');
  });

  it('survives an empty draft and a very long one', function () {
    const empty = render({ draft: '' });
    assert.ok(empty.length > 0);

    const long = render({ draft: 'x'.repeat(20000) });
    assert.ok(long.length > 0);
    assert.ok(long.includes('x'.repeat(200)), 'the long draft text itself is rendered, not truncated');
  });
});
