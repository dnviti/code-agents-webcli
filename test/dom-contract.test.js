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
  {
    selector: '#updateBanner',
    html: /id="updateBanner"/,
    required_by: 'src/client/ui/update-banner.ts',
    breaks: 'update notices are never shown',
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

  it('keeps the update banner outside the shell mount point', function () {
    // The banner is a sibling of #relayRoot in #app's column. React owns
    // everything inside #relayRoot and would discard foreign children on
    // render, so the banner must not be moved in there.
    const rootIdx = HTML.indexOf('id="relayRoot"');
    const bannerIdx = HTML.indexOf('id="updateBanner"');
    assert.ok(rootIdx !== -1 && bannerIdx !== -1);
    assert.ok(
      bannerIdx < rootIdx,
      'the update banner must precede #relayRoot so it keeps its own row above the shell',
    );
  });
});
