const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// "If a ladder cannot be applied for any reason, the session still starts, and
// says the ladder was not applied" (#171).
//
// Said in the header rather than the transcript, and that placement is the
// point rather than an implementation detail: a launch-time notice drawn as a
// rule in the conversation is the whole of an empty one, and it numbers a turn
// that never happened — which is exactly what the approvals marker cost, and
// why that one draws nothing (#134). A standing fact about the session belongs
// beside the other standing fact about the session.

const ROOT = path.join(__dirname, '..');

let mod;

before(function () {
  this.timeout(60000);
  const contents = [
    `export { renderToStaticMarkup } from 'react-dom/server';`,
    `export * as React from 'react';`,
    `export { SessionHeader } from ${JSON.stringify(path.join(ROOT, 'src/client/shell/chat/SessionHeader'))};`,
  ].join('\n');

  const out = path.join(os.tmpdir(), `chat-ladder-header-${process.pid}.js`);
  require('esbuild').buildSync({
    stdin: { contents, resolveDir: ROOT, loader: 'tsx', sourcefile: 'header.tsx' },
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

function render(props) {
  const { renderToStaticMarkup, React, SessionHeader } = mod;
  return renderToStaticMarkup(
    React.createElement(
      SessionHeader,
      Object.assign(
        {
          runtimeLabel: 'pi',
          workingDir: '/tmp/project',
          usage: {},
          capabilities: {},
          state: 'idle',
        },
        props,
      ),
    ),
  );
}

describe('a ladder that was not applied', function () {
  it('says so in the header, where standing facts about the session live', function () {
    const html = render({ ladderError: 'the ladder could not be written to disk (EROFS)' });
    assert.ok(html.includes('Ladder not applied'), 'the badge has to be there to be read');
    assert.ok(
      html.includes('the ladder could not be written to disk (EROFS)'),
      'and carry the reason, not just the fact',
    );
  });

  it('says nothing at all when the ladder applied', function () {
    const html = render({});
    assert.ok(!html.includes('Ladder not applied'));
  });

  // On a phone it sits in the panel the strip opens, one tap away — the same
  // place, and behind the same tap, as "Approvals bypassed". That is deliberate:
  // the collapsed strip carries the two figures that change while you watch and
  // nothing else, and a phone has no hover, so the reason is spelled out in full
  // there rather than hidden in a `title` nobody can reach.
  //
  // A static render can only ever show the strip closed — `open` is internal
  // click-toggled state — so what is asserted here is that the phone bar does
  // not grow the badge, and the browser check owns the opened panel.
  it('leaves the collapsed phone strip to the two figures that change', function () {
    const html = render({
      isMobile: true,
      ladderError: 'pi would not start on the top rung’s model',
    });
    assert.ok(!html.includes('Ladder not applied'));
  });
});
