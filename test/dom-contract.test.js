const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Several modules reach into the page by selector rather than being handed a
// node, and every one of those lookups is written defensively:
//
//   const main = document.querySelector('.main');
//   if (!main) return;
//
// which means deleting the element does not throw, does not log, and does not
// fail a unit test — the feature just stops existing. Converting the chrome to
// React removed <main class="main"> and split view silently died exactly that
// way. This pins the contract so the next restructure fails loudly instead.
//
// Curated on purpose: it lists the selectors whose absence is silent, not every
// selector in the client.

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'src', 'public', 'index.html'), 'utf8');

const CONTRACT = [
  {
    selector: '.main',
    html: /class="main"/,
    required_by: 'src/client/splits/split-container.ts',
    breaks: 'createSplitElements() early-returns, so split view cannot be opened at all',
  },
  {
    selector: '#terminalContainer',
    html: /id="terminalContainer"/,
    required_by: 'src/client/splits/split-container.ts (show/hide when splitting)',
    breaks: 'the terminal is never hidden when a split opens, so both render at once',
  },
  {
    selector: '#terminal',
    html: /id="terminal"/,
    required_by: 'src/client/terminal/setup.ts',
    breaks: 'xterm has nothing to attach to and no terminal renders',
  },
  {
    selector: '#relayRoot',
    html: /id="relayRoot"/,
    required_by: 'src/client/shell/mount.tsx',
    breaks: 'the Relay shell does not mount, leaving the app with no chrome',
  },
];

describe('index.html DOM contract', function () {
  CONTRACT.forEach(function (entry) {
    it(`still provides ${entry.selector} for ${entry.required_by}`, function () {
      assert.ok(
        entry.html.test(HTML),
        `${entry.selector} is gone from src/public/index.html.\n` +
          `Required by: ${entry.required_by}\n` +
          `Without it: ${entry.breaks}`,
      );
    });
  });

  it('keeps .main as an ancestor of the terminal, not a sibling', function () {
    // SplitContainer appends its panes into .main and toggles them against
    // #terminalContainer, so the two have to share that parent. If .main were
    // moved elsewhere the lookup would still succeed and the split panes would
    // render somewhere unrelated.
    const mainOpen = HTML.indexOf('class="main"');
    const mainClose = HTML.indexOf('</main>', mainOpen);
    const terminal = HTML.indexOf('id="terminalContainer"');

    assert.ok(mainOpen !== -1 && mainClose !== -1, '<main class="main"> must be present and closed');
    assert.ok(
      terminal > mainOpen && terminal < mainClose,
      '#terminalContainer must be nested inside <main class="main">',
    );
  });

  it('still publishes the drag payload split view reads on drop', function () {
    // The same class of silent failure, one layer up. SplitContainer's drop
    // handler reads `application/x-session-id` off the dataTransfer and returns
    // early when it is absent — so a tab strip that stops setting it does not
    // throw, it just makes drag-to-split quietly impossible. The strip is React
    // now, and the two ends of this contract live in different files.
    const shell = fs.readFileSync(
      path.join(ROOT, 'src', 'client', 'shell', 'AppShell.tsx'), 'utf8',
    );
    const splits = fs.readFileSync(
      path.join(ROOT, 'src', 'client', 'splits', 'split-container.ts'), 'utf8',
    );

    for (const key of ['application/x-session-id', 'x-source-pane']) {
      assert.ok(
        shell.includes(key),
        `AppShell must publish "${key}" via TabBar's dragPayload; without it a tab drag `
          + 'carries nothing split view can identify.',
      );
    }
    assert.ok(
      splits.includes('application/x-session-id'),
      'split-container must still read the key AppShell publishes',
    );
  });

  it('leaves nothing but the terminal for React to collide with', function () {
    // Everything the app renders now lives inside #relayRoot, and React
    // discards foreign children of a root it owns. The terminal is the one
    // exception, and it is deliberately a sibling — never a child.
    const rootIdx = HTML.indexOf('id="relayRoot"');
    const mainIdx = HTML.indexOf('class="main"');
    assert.ok(rootIdx !== -1 && mainIdx !== -1);
    assert.ok(
      rootIdx < mainIdx,
      '#relayRoot must precede <main class="main">, not contain it',
    );
  });
});
