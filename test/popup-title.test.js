const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Issue #114: a popup title is cut, never spilled.
 *
 * Every popup in this app is a `Dialog`, and its title was the one item in the
 * header row with no permission to shrink. A flex item's automatic minimum size
 * is its content, so a title carrying a `white-space: nowrap` span — the issue
 * reader's, the file editor's — made the whole row wider than the panel and
 * shoved the controls block, which is `flex-shrink: 0`, bodily outside it. At a
 * phone width the Close button ended up hundreds of pixels off the right of the
 * screen with the title painted across the strip it should have occupied. A
 * plain-string title failed the other way and wrapped, taking the title bar from
 * one line to five.
 *
 * The geometry is the browser check's job (`checkALongPopupTitleStaysInsideItsWindow`);
 * this is the cheap half that pins the declarations a layout engine needs to be
 * given in the first place, and the callers that have to hand it the right shape
 * of markup. Rendered through `renderToStaticMarkup` rather than asserted
 * against the source text, so a style object that never reaches the element —
 * spread over, overridden, dropped by a refactor — fails here.
 */

const ROOT = path.join(__dirname, '..');
const CHAT_DIR = path.join(ROOT, 'src', 'client', 'shell', 'chat');

/** The four declarations that, together, let a flex item be ellipsised. */
const CLAMP = ['min-width:0', 'overflow:hidden', 'text-overflow:ellipsis', 'white-space:nowrap'];

/** A title nobody has room for: 140 characters, all of them ordinary words. */
const LONG_TITLE =
  'Answered questions come back blank after switching tabs and the choices must stay marked exactly as they were sent, on every runtime';

describe('a popup title that is longer than its window (#114)', function () {
  let bundle;
  let mod;

  before(function () {
    this.timeout(60000);

    const contents = [
      `export { renderToStaticMarkup } from 'react-dom/server';`,
      `export * as React from 'react';`,
      `export { Dialog } from ${JSON.stringify(path.join(ROOT, 'src', 'client', 'ui', 'relay', 'Dialog'))};`,
      `export { WorkflowPopup } from ${JSON.stringify(path.join(CHAT_DIR, 'WorkflowPopup'))};`,
      `export { GitHubItemDialog } from ${JSON.stringify(path.join(CHAT_DIR, 'GitHubItemDialog'))};`,
      `export { ChatTranscript } from ${JSON.stringify(path.join(ROOT, 'src', 'client', 'chat', 'transcript'))};`,
    ].join('\n');

    bundle = path.join(os.tmpdir(), `popup-title-${process.pid}.js`);
    // stdin rather than a temp entry file: an entry written to /tmp resolves
    // its bare imports relative to /tmp, where there is no node_modules.
    require('esbuild').buildSync({
      stdin: { contents, resolveDir: ROOT, loader: 'tsx', sourcefile: 'popup-title.tsx' },
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

  /** The `<h2>` the dialog labels itself by, with its inline style. */
  function titleTag(html) {
    const match = /<h2[^>]*id="[^"]*-title"[^>]*>/.exec(html);
    assert.ok(match, 'the dialog should draw a title element at all');
    return match[0];
  }

  it('gives up its own width, so the controls beside it never leave the panel', function () {
    const { React, renderToStaticMarkup, Dialog } = mod;
    const html = renderToStaticMarkup(
      React.createElement(Dialog, { open: true, title: LONG_TITLE, onClose: () => {} }, 'body'),
    );
    const tag = titleTag(html);
    for (const declaration of CLAMP) {
      assert.ok(
        tag.replace(/\s/g, '').includes(declaration),
        `the title should carry ${declaration} so it can be cut instead of pushing the controls out — got ${tag}`,
      );
    }
  });

  it('keeps the whole title readable, on hover and to a screen reader', function () {
    const { React, renderToStaticMarkup, Dialog } = mod;
    const html = renderToStaticMarkup(
      React.createElement(Dialog, { open: true, title: LONG_TITLE, onClose: () => {} }, 'body'),
    );
    assert.ok(
      titleTag(html).includes(`title="${LONG_TITLE}"`),
      'a string title should become its own hover text, so the cut costs nothing',
    );
    assert.ok(
      html.includes(LONG_TITLE),
      'the full string should still be in the element, which is what aria-labelledby reads',
    );
  });

  it('takes the hover text from a title made of nodes, which has no string of its own', function () {
    const { React, renderToStaticMarkup, Dialog } = mod;
    const html = renderToStaticMarkup(
      React.createElement(
        Dialog,
        {
          open: true,
          titleText: LONG_TITLE,
          title: React.createElement('span', null, LONG_TITLE),
          onClose: () => {},
        },
        'body',
      ),
    );
    assert.ok(
      titleTag(html).includes(`title="${LONG_TITLE}"`),
      'a rich title should hand its plain text to the tooltip through titleText',
    );
  });

  it('says nothing on hover when there is nothing to say', function () {
    const { React, renderToStaticMarkup, Dialog } = mod;
    const html = renderToStaticMarkup(
      React.createElement(
        Dialog,
        { open: true, title: React.createElement('span', null, 'x'), onClose: () => {} },
        'body',
      ),
    );
    assert.ok(
      !/\stitle="/.test(titleTag(html)),
      'a node title with no titleText should leave the tooltip alone rather than inventing "[object Object]"',
    );
  });

  it('lets the name inside a rich title be the part that is cut', function () {
    const { React, renderToStaticMarkup, ChatTranscript, WorkflowPopup } = mod;
    const transcript = new ChatTranscript();
    transcript.apply({ t: 'msg_start', seq: 1, ts: 1, id: 'm1', role: 'assistant', turnId: 't1' });
    transcript.apply({
      t: 'block_start',
      seq: 2,
      ts: 2,
      msgId: 'm1',
      index: 0,
      block: {
        kind: 'tool',
        toolId: 'wf1',
        name: 'Workflow',
        toolKind: 'task',
        status: 'running',
        input: { name: LONG_TITLE },
      },
    });
    const html = renderToStaticMarkup(
      React.createElement(WorkflowPopup, { open: true, transcript, toolId: 'wf1', onClose: () => {} }),
    );

    const flat = html.replace(/\s/g, '');
    assert.ok(
      !/<h2[^>]*id="[^"]*-title"[^>]*>\s*<span style="display:inline-flex/.test(html),
      'the title wrapper must be a block-level flex box: an inline-level one inside a nowrap title '
      + 'is laid out at max-content and then chopped with no ellipsis',
    );
    assert.ok(
      flat.includes('min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'),
      'the run name inside the title should be the item that ellipsises',
    );
    assert.ok(
      flat.includes('display:inline-flex;flex-shrink:0'),
      'the status badge should be pinned, so a long name never clips the one word that changes',
    );
    assert.ok(
      titleTag(html).includes('title='),
      'the popup should hand the run name to the tooltip, since its title is nodes',
    );
  });

  it('pins the icon and the number in the issue reader, and cuts only the sentence', function () {
    const { React, renderToStaticMarkup, GitHubItemDialog } = mod;
    // The fetch lives in a useEffect, which static rendering never runs, so this
    // paints the pre-load title: the icon, the number, and the fallback label.
    const html = renderToStaticMarkup(
      React.createElement(GitHubItemDialog, {
        sessionId: 's1',
        kind: 'issue',
        number: 114,
        onClose: () => {},
      }),
    );
    const flat = html.replace(/\s/g, '');
    assert.ok(
      !/<h2[^>]*id="[^"]*-title"[^>]*>\s*<span style="display:inline-flex/.test(html),
      'the issue reader title wrapper must be a block-level flex box, not inline-flex',
    );
    assert.ok(
      flat.includes('color:var(--muted-foreground);flex-shrink:0'),
      'the issue number should never be the part that is cut — it is what identifies the item',
    );
    assert.ok(
      flat.includes('min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'),
      'the issue title should be the item that ellipsises',
    );
  });
});
