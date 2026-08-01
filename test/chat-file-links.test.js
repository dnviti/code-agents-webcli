const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Client-only TypeScript is bundled by esbuild rather than emitted into dist.
// Keep this helper under direct unit coverage: it is the line between a file
// link opening in Monaco and the browser requesting that path from Express.
const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'src', 'client', 'chat', 'file-links.ts');

let bundle;
let links;

before(function () {
  this.timeout(60000);
  bundle = path.join(os.tmpdir(), `chat-file-links-${process.pid}.js`);
  require('esbuild').buildSync({
    stdin: {
      contents: `export * from ${JSON.stringify(SOURCE)};`,
      resolveDir: ROOT,
      loader: 'ts',
      sourcefile: 'chat-file-links-entry.ts',
    },
    bundle: true,
    outfile: bundle,
    format: 'cjs',
    platform: 'node',
    target: ['node20'],
    logLevel: 'silent',
  });
  links = require(bundle);
});

after(function () {
  if (bundle) fs.rmSync(bundle, { force: true });
});

describe('chat workspace file links', function () {
  const root = '/home/dev/projects/webcli';

  it('maps an absolute project file without inventing a line', function () {
    assert.deepStrictEqual(
      links.workspaceFileTarget('/home/dev/projects/webcli/src/app.ts', root),
      { path: '/home/dev/projects/webcli/src/app.ts' },
    );
  });

  it('separates a final positive line number from the file path', function () {
    assert.deepStrictEqual(
      links.workspaceFileTarget('/home/dev/projects/webcli/src/server/chat/registry.ts:228', root),
      { path: '/home/dev/projects/webcli/src/server/chat/registry.ts', line: 228 },
    );
  });

  it('decodes a path before mapping it to the workspace', function () {
    assert.deepStrictEqual(
      links.workspaceFileTarget('/home/dev/projects/webcli/src/a%20file.ts:7', root),
      { path: '/home/dev/projects/webcli/src/a file.ts', line: 7 },
    );
  });

  it('normalises harmless dot segments for the containment comparison', function () {
    assert.deepStrictEqual(
      links.workspaceFileTarget('/home/dev/projects/webcli/src/../test/app.test.ts:9', root),
      { path: '/home/dev/projects/webcli/src/../test/app.test.ts', line: 9 },
    );
  });

  it('maps Windows drive-letter paths case-insensitively', function () {
    const windowsRoot = String.raw`C:\dev\webcli`;
    const file = String.raw`c:\DEV\webcli\src\app.ts`;
    assert.deepStrictEqual(
      links.workspaceFileTarget(`${file}:31`, windowsRoot),
      { path: file, line: 31 },
    );
  });

  it('maps UNC paths without letting a sibling share through', function () {
    const uncRoot = String.raw`\\buildbox\work\webcli`;
    const file = String.raw`\\BUILDBOX\WORK\webcli\src\app.ts`;
    assert.deepStrictEqual(
      links.workspaceFileTarget(`${file}:44`, uncRoot),
      { path: file, line: 44 },
    );
    assert.strictEqual(
      links.workspaceFileTarget(String.raw`\\buildbox\other\webcli\src\app.ts:44`, uncRoot),
      null,
    );
  });

  it('does not confuse a sibling prefix with the workspace', function () {
    assert.strictEqual(
      links.workspaceFileTarget('/home/dev/projects/webcli-other/src/app.ts:2', root),
      null,
    );
  });

  it('rejects traversal out, files elsewhere, relative routes and web URLs', function () {
    const rejected = [
      '/home/dev/projects/webcli/../../secret.ts:1',
      '/etc/passwd:1',
      'src/app.ts:1',
      '../src/app.ts:1',
      'https://example.com/source.ts:1',
      '/api/workspace/session/file?path=src/app.ts',
      String.raw`C:src\app.ts:1`,
    ];
    for (const href of rejected) {
      assert.strictEqual(links.workspaceFileTarget(href, root), null, href);
    }
  });

  it('rejects zero, unsafe and malformed encoded locations', function () {
    assert.strictEqual(links.workspaceFileTarget(`${root}/src/app.ts:0`, root), null);
    assert.strictEqual(
      links.workspaceFileTarget(`${root}/src/app.ts:999999999999999999999999`, root),
      null,
    );
    assert.strictEqual(links.workspaceFileTarget(`${root}/src/bad%2`, root), null);
    assert.strictEqual(links.workspaceFileTarget(`${root}/src/bad%00name.ts`, root), null);
  });
});
