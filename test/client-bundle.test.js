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

/**
 * The Monaco chunk, and the promise that it stays a chunk.
 *
 * Monaco is 4.6 MB. The whole reason it is built separately (see the [monaco]
 * step in scripts/build.js) is that the file editor opens from one row of one
 * panel and most sessions never touch it — so the cost of being wrong here is
 * not subtle, it is a five-fold increase in what every session downloads before
 * it can show a prompt. One stray `import` from anything the main bundle
 * reaches would do it, and nothing else in the build would complain.
 */
describe('the code editor chunk', function () {
  const PUBLIC = path.join(__dirname, '..', 'dist', 'public');
  const read = (name) => fs.readFileSync(path.join(PUBLIC, name), 'utf8');
  const size = (name) => fs.statSync(path.join(PUBLIC, name)).size;

  it('ships the script, its styles and its worker', function () {
    // A worker cannot be part of the IIFE a <script> tag loads; it has to be
    // its own file, and MonacoEnvironment fetches it by that name.
    for (const name of ['monaco.bundle.js', 'monaco.bundle.css', 'monaco-editor.worker.js']) {
      assert.ok(fs.existsSync(path.join(PUBLIC, name)), `${name} is missing from the build`);
      assert.ok(size(name) > 50_000, `${name} is too small to be real (${size(name)} bytes)`);
    }
  });

  it('keeps Monaco out of the main bundle', function () {
    const main = size('app.bundle.js');
    // The main bundle is around 950 kB with the whole Relay shell, xterm and
    // the chat surface in it. Monaco alone is four times that, so this cannot
    // be tripped by ordinary growth — only by the chunk collapsing into it.
    assert.ok(
      main < 2 * 1024 * 1024,
      `app.bundle.js is ${(main / 1024 / 1024).toFixed(1)} MB — the editor chunk has probably been pulled in`,
    );
  });

  it('inlines the icon font instead of leaving a path to chase', function () {
    const css = read('monaco.bundle.css');
    assert.ok(css.includes('url(data:font/ttf'), 'the codicon font must be inlined');
    // Anything left pointing at a file is a request that resolves against the
    // page's own URL, not the stylesheet's, and 404s.
    const external = css.match(/url\((?!data:)[^)]+\)/g) || [];
    assert.deepStrictEqual(external, [], `the stylesheet still fetches ${external.join(', ')}`);
  });

  it('carries the editor contributions, not just the API', function () {
    // `editor.api` alone renders a file and cannot be typed into: in 0.56 the
    // contributions — find, folding, the core editing commands — exist only in
    // `editor.main`. The find widget's own class is the cheapest proof that the
    // larger entry is the one that got bundled.
    const chunk = read('monaco.bundle.js');
    assert.ok(chunk.includes('find-widget'), 'the find contribution is missing: this is editor.api, not editor.main');
  });

  it('asks for a same-origin worker rather than a CDN', function () {
    const chunk = read('monaco.bundle.js');
    assert.ok(chunk.includes('/monaco-editor.worker.js'), 'the worker path is missing');
    for (const cdn of ['cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com']) {
      assert.ok(!chunk.includes(cdn), `the editor chunk reaches out to ${cdn}; this app runs on LANs with no route out`);
    }
  });
});
