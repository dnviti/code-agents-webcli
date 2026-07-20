const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PasteStore } = require('../dist/server/services/paste-store.js');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('PasteStore .gitignore', function () {
  let storageDir;
  let workingDir;
  let store;

  beforeEach(function () {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-gi-store-'));
    workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-gi-wd-'));
    store = new PasteStore({ storageDir });
  });

  afterEach(function () {
    fs.rmSync(storageDir, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
  });

  const gitignorePath = () => path.join(workingDir, '.cc-web', '.gitignore');

  it('ignores its own directory on the first save', async function () {
    await store.save({ id: 'ok', ownerUserId: 1, workingDir }, PNG);
    const body = fs.readFileSync(gitignorePath(), 'utf8');
    // "*" in a subdirectory ignores that tree and the ignore file itself, so
    // git status stays clean at any depth.
    assert.ok(body.split('\n').includes('*'));
    assert.match(body, /code-agents-webcli/);
  });

  it('never touches the repository\'s own .gitignore', async function () {
    const rootIgnore = path.join(workingDir, '.gitignore');
    const original = '# mine\nnode_modules\n';
    fs.writeFileSync(rootIgnore, original);

    await store.save({ id: 'ok', ownerUserId: 1, workingDir }, PNG);

    // That file is tracked, user-owned, and the agent may be editing it in the
    // same second. Appending to it is the pollution this feature avoids.
    assert.strictEqual(fs.readFileSync(rootIgnore, 'utf8'), original);
  });

  it('leaves an existing .cc-web/.gitignore byte-identical', async function () {
    fs.mkdirSync(path.join(workingDir, '.cc-web'));
    const custom = '# mine\n!keep-this\n';
    fs.writeFileSync(gitignorePath(), custom);

    await store.save({ id: 'ok', ownerUserId: 1, workingDir }, PNG);

    // If a user edited it, they win, permanently.
    assert.strictEqual(fs.readFileSync(gitignorePath(), 'utf8'), custom);
  });

  it('writes the marker exactly once across many saves', async function () {
    await store.save({ id: 'ok', ownerUserId: 1, workingDir }, PNG);
    await store.save({ id: 'ok', ownerUserId: 1, workingDir }, PNG);
    await store.save({ id: 'ok', ownerUserId: 1, workingDir }, PNG);

    const body = fs.readFileSync(gitignorePath(), 'utf8');
    assert.strictEqual(body.split('code-agents-webcli').length - 1, 1);
  });

  it('works the same outside a git repository', async function () {
    await store.save({ id: 'ok', ownerUserId: 1, workingDir }, PNG);
    assert.ok(fs.existsSync(gitignorePath()));
    // No git is ever invoked: no cwd trust, no PATH dependency, and no way for
    // a hostile repo's config to get a subprocess executed.
    assert.ok(!fs.existsSync(path.join(workingDir, '.git')));
  });
});

describe('PasteStore cleanup', function () {
  let storageDir;
  let workingDir;
  let store;

  beforeEach(function () {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-clean-store-'));
    workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-clean-wd-'));
    store = new PasteStore({ storageDir });
  });

  afterEach(function () {
    fs.rmSync(storageDir, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
  });

  it('removes every file it wrote, and the directories it created', async function () {
    const a = await store.save({ id: 'ok', ownerUserId: 1, workingDir }, PNG);
    const b = await store.save({ id: 'ok', ownerUserId: 1, workingDir }, PNG);

    await store.deletePastes({ id: 'ok', ownerUserId: 1 });

    assert.ok(!fs.existsSync(a.absolutePath));
    assert.ok(!fs.existsSync(b.absolutePath));
    assert.ok(!fs.existsSync(path.join(workingDir, '.cc-web')));
  });

  it('deletes files under a working directory the session has since left', async function () {
    const second = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-clean-wd2-'));
    try {
      const a = await store.save({ id: 'ok', ownerUserId: 1, workingDir }, PNG);
      // POST /api/set-working-dir mutates workingDir in place, so recomputing
      // the path at deletion time would strand everything written before.
      const b = await store.save({ id: 'ok', ownerUserId: 1, workingDir: second }, PNG);

      await store.deletePastes({ id: 'ok', ownerUserId: 1 });

      assert.ok(!fs.existsSync(a.absolutePath), 'the old directory must be cleaned too');
      assert.ok(!fs.existsSync(b.absolutePath));
    } finally {
      fs.rmSync(second, { recursive: true, force: true });
    }
  });

  it('keeps a directory that gained the user\'s own files', async function () {
    const saved = await store.save({ id: 'ok', ownerUserId: 1, workingDir }, PNG);
    const note = path.join(path.dirname(saved.absolutePath), 'note.txt');
    fs.writeFileSync(note, 'mine');

    await store.deletePastes({ id: 'ok', ownerUserId: 1 });

    assert.ok(!fs.existsSync(saved.absolutePath));
    // rmdir is non-recursive on purpose: it fails on a non-empty directory,
    // and that failure is the safety property.
    assert.ok(fs.existsSync(note), 'a user file must survive');
  });

  it('leaves another session\'s images alone', async function () {
    const mine = await store.save({ id: 'mine', ownerUserId: 1, workingDir }, PNG);
    const theirs = await store.save({ id: 'theirs', ownerUserId: 1, workingDir }, PNG);

    await store.deletePastes({ id: 'mine', ownerUserId: 1 });

    assert.ok(!fs.existsSync(mine.absolutePath));
    assert.ok(fs.existsSync(theirs.absolutePath), 'sessions sharing a directory must not collide');
  });

  it('resolves when the working directory is gone', async function () {
    const doomed = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-clean-gone-'));
    await store.save({ id: 'ok', ownerUserId: 1, workingDir: doomed }, PNG);
    fs.rmSync(doomed, { recursive: true, force: true });

    // The caller is fire-and-forget, so this must never reject.
    await assert.doesNotReject(() => store.deletePastes({ id: 'ok', ownerUserId: 1 }));
  });

  it('resolves for a session that never pasted anything', async function () {
    await assert.doesNotReject(() => store.deletePastes({ id: 'never', ownerUserId: 1 }));
    assert.ok(!fs.existsSync(path.join(workingDir, '.cc-web')));
  });

  it('does not reject on an unsafe session id', async function () {
    await assert.doesNotReject(() => store.deletePastes({ id: '../../etc', ownerUserId: 1 }));
  });

  it('still removes the files when the manifest is truncated', async function () {
    const saved = await store.save({ id: 'ok', ownerUserId: 1, workingDir }, PNG);
    const manifest = path.join(storageDir, 'pastes', '1', 'ok.json');
    fs.writeFileSync(manifest, '{"version":1,"entr');

    await assert.doesNotReject(() => store.deletePastes({ id: 'ok', ownerUserId: 1 }));
    // The entries are unreadable, so the image itself survives; what must not
    // happen is a throw that leaves the manifest behind forever.
    assert.ok(!fs.existsSync(manifest));
    assert.ok(fs.existsSync(saved.absolutePath));
  });

  it('refuses an upload that arrives after the session was deleted', async function () {
    await store.save({ id: 'ok', ownerUserId: 1, workingDir }, PNG);
    await store.deletePastes({ id: 'ok', ownerUserId: 1 });

    // Otherwise a 10 MB upload racing the delete re-creates the directory and
    // the manifest for a session that no longer exists.
    await assert.rejects(
      () => store.save({ id: 'ok', ownerUserId: 1, workingDir }, PNG),
      /gone/i,
    );
  });

  it('serialises concurrent saves for one session', async function () {
    const results = await Promise.all([
      store.save({ id: 'ok', ownerUserId: 1, workingDir }, PNG),
      store.save({ id: 'ok', ownerUserId: 1, workingDir }, PNG),
      store.save({ id: 'ok', ownerUserId: 1, workingDir }, PNG),
    ]);

    const manifest = JSON.parse(
      fs.readFileSync(path.join(storageDir, 'pastes', '1', 'ok.json'), 'utf8'),
    );
    // A burst must not interleave into a half-written manifest and lose
    // entries, which would leak the files it forgot.
    assert.strictEqual(manifest.entries.length, 3);
    assert.strictEqual(new Set(results.map((r) => r.absolutePath)).size, 3);
  });
});
