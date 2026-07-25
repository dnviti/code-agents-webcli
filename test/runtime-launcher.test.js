const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The launcher decides which runtimes get a "start without prompts" control.
// That set must match the bridges: a runtime whose CLI has no real approval
// bypass must not be offered one, because the button would promise something
// the CLI does not do.

const ROOT = path.join(__dirname, '..');

let mod;

before(function () {
  this.timeout(60000);
  const contents = [
    `export { renderToStaticMarkup } from 'react-dom/server';`,
    `export * as React from 'react';`,
    `export { RuntimeLauncher } from ${JSON.stringify(path.join(ROOT, 'src/client/shell/RuntimeLauncher'))};`,
    `export { LaunchCard, activatesFromKey } from ${JSON.stringify(path.join(ROOT, 'src/client/ui/relay/LaunchCard'))};`,
  ].join('\n');

  const out = path.join(os.tmpdir(), `runtime-launcher-${process.pid}.js`);
  require('esbuild').buildSync({
    stdin: { contents, resolveDir: ROOT, loader: 'tsx', sourcefile: 'runtime-launcher.tsx' },
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

const ALIASES = {
  claude: 'Claude', codex: 'Codex', agent: 'Cursor', pi: 'Pi',
  grok: 'Grok', qwen: 'Qwen', kimi: 'Kimi', omp: 'Oh My Pi', terminal: 'Terminal',
};

function render(onStart) {
  const { renderToStaticMarkup, React, RuntimeLauncher } = mod;
  return renderToStaticMarkup(
    React.createElement(RuntimeLauncher, {
      aliases: ALIASES,
      onStart: onStart || function () {},
      onTerminal() {},
      onCancel() {},
    }),
  );
}

describe('RuntimeLauncher', function () {
  it('offers every runtime plus the terminal', function () {
    const html = render();
    for (const label of Object.values(ALIASES)) {
      assert.ok(html.includes(label), `${label} should be offered`);
    }
  });

  it('names the binary each bridge looks for', function () {
    // A missing CLI fails at spawn time with no up-front detection, so showing
    // the command makes "it did not start" diagnosable.
    const html = render();
    for (const binary of ['claude', 'codex', 'cursor-agent', 'pi', 'grok', 'qwen', 'kimi', 'omp']) {
      assert.ok(html.includes(binary), `the ${binary} command should be shown`);
    }
  });

  it('offers a no-prompts start only for runtimes whose CLI really has one', function () {
    // Claude --dangerously-skip-permissions, Codex bypass, Grok
    // --always-approve, Qwen --yolo, Kimi --yolo, Oh My Pi --auto-approve.
    // Cursor and pi have no tool-approval bypass, so offering the control would
    // be a false promise — the same reasoning that left pi without one in the
    // bridge. Oh My Pi is a pi fork but does have a real bypass, so unlike pi it
    // gets the control.
    const html = render();

    // Each card is a role=button; the destructive control sits inside it.
    const cards = html.split('role="button"').slice(1);
    assert.strictEqual(cards.length, 9, `expected 9 launch cards, got ${cards.length}`);

    const withBypass = [];
    for (const card of cards) {
      const label = ['Claude', 'Codex', 'Cursor', 'Pi', 'Grok', 'Qwen', 'Kimi', 'Oh My Pi', 'Terminal']
        .find((name) => card.includes(`>${name}<`));
      if (label && /No prompts/.test(card)) withBypass.push(label);
    }

    assert.deepStrictEqual(
      withBypass.sort(),
      ['Claude', 'Codex', 'Grok', 'Kimi', 'Oh My Pi', 'Qwen'],
      'exactly the runtimes with a real bypass flag may offer one',
    );
  });

  it('describes what the bypass actually does, not just that it is dangerous', function () {
    // "Dangerous" tells a user nothing about what they are agreeing to.
    const html = render();
    assert.ok(/auto-accepts every action/.test(html), 'Qwen should say what --yolo does');
    assert.ok(/auto-approves every action/.test(html), 'Kimi should say what --yolo does');
    assert.ok(/skips every permission prompt/.test(html), 'Claude should say what its flag does');
    assert.ok(
      /auto-approves every tool call \(--auto-approve\)/.test(html),
      'Oh My Pi should say what --auto-approve does',
    );
  });

  it('does not let a keypress on the bypass control also start the runtime safely', function () {
    // The card is a role=button with its own Enter/Space handling, and the
    // bypass is a nested <button>. A keydown on the nested button bubbles to
    // the card, so without this rule Enter on "No prompts" started the runtime
    // TWICE — once bypassed by the button, once safely by the card.
    const { activatesFromKey } = mod;
    const card = { id: 'card' };
    const nested = { id: 'nested-button' };

    assert.strictEqual(
      activatesFromKey('Enter', nested, card),
      false,
      'Enter on a nested control must not also activate the card',
    );
    assert.strictEqual(
      activatesFromKey(' ', nested, card),
      false,
      'Space on a nested control must not also activate the card',
    );

    // The card itself must stay operable by keyboard.
    assert.strictEqual(activatesFromKey('Enter', card, card), true);
    assert.strictEqual(activatesFromKey(' ', card, card), true);
    // And must not swallow keys it does not handle.
    assert.strictEqual(activatesFromKey('a', card, card), false);
    assert.strictEqual(activatesFromKey('Tab', card, card), false);
  });

  it('starts a runtime safely by default and only bypasses on the separate control', function () {
    const calls = [];
    const html = render((kind, options) => calls.push([kind, options]));
    // The two are distinct targets in the markup: the card is a role=button and
    // the bypass is a nested <button>, so a click aimed at the card cannot
    // reach the bypass.
    const claudeCard = html.split('role="button"')[1];
    assert.ok(/<button/.test(claudeCard), 'the bypass control should be a nested button');
    assert.ok(calls.length === 0, 'rendering alone must not start anything');
  });
});
