const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { CLIENT_TARGET } = require('../scripts/client-bundle.js');

const BUNDLE = path.join(__dirname, '..', 'dist', 'public', 'app.bundle.js');

/**
 * Guards on the shipped client bundle.
 *
 * The browser checks cover this too, but they skip themselves when Chrome is
 * absent — which is exactly the environment where nobody would notice. These
 * run everywhere.
 */
describe('client bundle', function () {
  let bundle;

  before(function () {
    bundle = fs.readFileSync(BUNDLE, 'utf8');
  });

  it('assigns to nothing it has not declared', function () {
    // `void 0 || (x = {})` is what esbuild emits when it lowers `let x; ... x ||= {}`
    // for a target without logical assignment *and* the minifier has already
    // dropped the write-only declaration. The result assigns to a free name,
    // which throws `ReferenceError` in a strict-mode bundle — this one.
    //
    // It landed inside xterm's DECRQM handler, so every terminal-mode query
    // threw from inside the write loop: the terminal stopped parsing, and since
    // one Terminal instance is shared by every session tab, the whole UI went
    // black. Oh My Pi queries five modes before drawing anything, so it never
    // appeared at all.
    const matches = bundle.match(/void 0\s*\|\|\s*\([A-Za-z0-9_$]+\s*=\s*\{\}\)/g);
    assert.strictEqual(
      matches,
      null,
      `bundle assigns to an undeclared name: ${JSON.stringify(matches)}`,
    );
  });

  it('keeps logical assignment native rather than lowering it', function () {
    // The root cause, pinned directly: the lowering only happens below es2021.
    const edition = Number(String(CLIENT_TARGET[0]).replace(/^es/, ''));
    assert.ok(
      Number.isFinite(edition) && edition >= 2021,
      `client target must be es2021 or newer, got ${CLIENT_TARGET[0]}`,
    );
  });

  it('still answers terminal mode queries', function () {
    // A cheap proof the handler survived minification with its enum intact.
    // The behavioural version of this lives in the browser checks.
    assert.ok(bundle.includes('$y'), 'no DECRPM reply template in the bundle');
    assert.ok(/requestMode\([^)]*\)\{\s*(let|var|const)\s/.test(bundle),
      'requestMode no longer opens with a declaration');
  });
});
