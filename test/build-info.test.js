const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  readBuildInfo,
  resetBuildInfoCache,
  shortSha,
} = require('../dist/server/services/build-info.js');

const VALID = 'd79d6d716aa66b0bcb6cfd1323fce6de56399e14';

describe('readBuildInfo', function () {
  let dir;

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-build-'));
    // The cache is keyed by path, but two cases can still share one temp name
    // across a fast run; clearing keeps each assertion honest.
    resetBuildInfoCache();
  });

  afterEach(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(contents) {
    const file = path.join(dir, 'build-info.json');
    fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
    return file;
  }

  // The sha is interpolated into a GitHub API path, so anything that is not
  // exactly 40 lowercase hex has to become null.
  const shaCases = [
    ['a valid 40-hex sha', VALID, VALID],
    ['a short sha', 'd79d6d7', null],
    ['an uppercase sha', VALID.toUpperCase(), null],
    ['a path traversal', '../../etc/passwd', null],
    ['a sha with a path appended', `${'a'.repeat(40)}/../../x`, null],
    ['a full URL', 'https://evil.example/x', null],
    ['a number', 42, null],
    ['null', null, null],
    // RegExp.test stringifies its argument, so a one-element array passes a
    // bare regex check. The typeof guard is what stops it.
    ['a single-element array', [VALID], null],
    ['a nested array', [['..', '..']], null],
    ['an object', { toString: () => VALID }, null],
  ];

  shaCases.forEach(function ([label, input, expected]) {
    it(`nulls the sha for ${label}`, function () {
      const info = readBuildInfo(write({ version: '4.0.0', sha: input }));
      assert.strictEqual(info.sha, expected);
    });
  });

  it('reads a well-formed file', function () {
    const info = readBuildInfo(write({
      version: '4.1.0',
      sha: VALID,
      commitDate: '2026-07-20T14:31:26Z',
      dirty: false,
      source: 'git',
      builtAt: '2026-07-20T15:00:00.000Z',
    }));

    assert.strictEqual(info.version, '4.1.0');
    assert.strictEqual(info.sha, VALID);
    assert.strictEqual(info.commitDate, '2026-07-20T14:31:26Z');
    assert.strictEqual(info.dirty, false);
    assert.strictEqual(info.source, 'git');
  });

  it('does not throw when the file is missing', function () {
    const info = readBuildInfo(path.join(dir, 'absent.json'));
    assert.strictEqual(info.sha, null);
    assert.strictEqual(info.source, 'unknown');
    assert.ok(info.version.length > 0, 'the version must always be populated');
  });

  it('does not throw on malformed JSON', function () {
    const info = readBuildInfo(write('{"sha": "trunc'));
    assert.strictEqual(info.sha, null);
    assert.strictEqual(info.source, 'unknown');
  });

  it('rejects an unrecognised source', function () {
    const info = readBuildInfo(write({ sha: VALID, source: 'handcrafted' }));
    assert.strictEqual(info.source, 'unknown');
  });

  it('treats a non-boolean dirty flag as clean', function () {
    // Anything but true means clean; otherwise a stray string would silently
    // disable updates by putting the install into the dev_build state.
    const info = readBuildInfo(write({ sha: VALID, dirty: 'yes' }));
    assert.strictEqual(info.dirty, false);
  });

  it('caches per path rather than globally', function () {
    const first = readBuildInfo(write({ sha: VALID }));
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-build2-'));
    try {
      const otherFile = path.join(otherDir, 'build-info.json');
      fs.writeFileSync(otherFile, JSON.stringify({ sha: 'nope' }));
      const second = readBuildInfo(otherFile);

      assert.strictEqual(first.sha, VALID);
      // A single global cache slot would hand back the first result here, and
      // every table case above would become vacuous.
      assert.strictEqual(second.sha, null);
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('shortens a sha for display and passes null through', function () {
    assert.strictEqual(shortSha(VALID), 'd79d6d7');
    assert.strictEqual(shortSha(null), null);
  });
});

describe('build identity packaging', function () {
  const root = path.join(__dirname, '..');

  it('writes build-info.json during the build', function () {
    // npm test builds first, so this file must exist by now. Its absence means
    // every install would report "commit unknown" and never offer an update.
    assert.ok(
      fs.existsSync(path.join(root, 'dist', 'build-info.json')),
      'scripts/build.js must emit dist/build-info.json',
    );
  });

  it('ships build-info.json to installed copies', function () {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    // The "files" whitelist decides what an install actually receives, and it
    // beats .npmignore. Dropping "dist" would silently disable update checks
    // for every user while every test here still passed.
    assert.ok(pkg.files.includes('dist'), '"dist" must stay in package.json files');
  });

  it('stamps the service worker cache with the build', function () {
    const sw = fs.readFileSync(path.join(root, 'dist', 'public', 'service-worker.js'), 'utf8');
    assert.doesNotMatch(sw, /__BUILD_ID__/, 'the placeholder must be substituted at build time');
    // A constant cache name would keep serving the previous client after an
    // update, because the activate handler only evicts caches it does not know.
    assert.match(sw, /const CACHE_NAME = 'code-agents-webcli-.+'/);
  });

  it('gives a working-tree build a cache name of its own', function () {
    // `<sha>-dirty` was the same string for every build from the same commit,
    // so rebuilding a fix and reloading kept serving the cached broken client:
    // the cache could not be busted exactly when it most needed to be. A dirty
    // build now carries the build timestamp; a clean one still gets only its
    // commit, so released builds stay reproducible.
    const info = JSON.parse(fs.readFileSync(path.join(root, 'dist', 'build-info.json'), 'utf8'));
    const sw = fs.readFileSync(path.join(root, 'dist', 'public', 'service-worker.js'), 'utf8');
    const name = sw.match(/const CACHE_NAME = '([^']+)'/)[1];

    assert.doesNotMatch(name, /-dirty$/, 'a fixed suffix cannot bust a cache');
    if (info.dirty || !info.sha) {
      assert.match(name, /\d{12,}$/, `expected a build stamp in ${name}`);
    } else {
      assert.strictEqual(name, `code-agents-webcli-${info.sha.slice(0, 12)}`);
    }
  });
});
