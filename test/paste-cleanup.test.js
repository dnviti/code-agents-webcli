const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  MAX_PASTE_MANIFEST_BYTES,
  PasteStore,
} = require('../dist/server/services/paste-store.js');
const {
  closeWorkspaceSessionDirectoryLeases,
} = require('../dist/server/services/workspace-session-storage.js');

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
    closeWorkspaceSessionDirectoryLeases();
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

  it('retries the marker after a failed write instead of memoising the failure', async function () {
    const container = path.join(workingDir, '.cc-web');
    fs.mkdirSync(container, { mode: 0o500 });

    try {
      // Read-only directory: the write fails with EACCES.
      await store.ensureGitignore(container);
      assert.ok(
        !fs.existsSync(path.join(container, '.gitignore')),
        'the write was expected to fail for this test to mean anything',
      );
      // Memoising a failure would leave every later paste into this project
      // unignored for the rest of the process's life.
      assert.ok(!store.ignoredDirs.has(container), 'a failed write must not be memoised');
    } finally {
      fs.chmodSync(container, 0o700);
    }

    await store.ensureGitignore(container);
    assert.ok(fs.existsSync(path.join(container, '.gitignore')), 'the next attempt must retry');
  });

  it('puts the marker back when the directory cannot be removed', async function () {
    const container = path.join(workingDir, '.cc-web');
    await store.save({ id: 'ok', ownerUserId: 1, workingDir }, PNG);
    fs.rmSync(path.join(container, 'pasted'), { recursive: true, force: true });

    // rmdir needs write permission on the PARENT, so this makes the removal
    // fail after the marker has already been deleted — the same end state as
    // another session racing in and re-creating pasted/.
    fs.chmodSync(workingDir, 0o500);
    try {
      await store.removeContainerIfEmpty(container);
      assert.ok(fs.existsSync(container), 'the directory was expected to survive');
      assert.ok(
        fs.existsSync(path.join(container, '.gitignore')),
        'a directory that survives must keep its ignore marker',
      );
    } finally {
      fs.chmodSync(workingDir, 0o700);
    }
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
    closeWorkspaceSessionDirectoryLeases();
    fs.rmSync(storageDir, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
  });

  it('removes every file it wrote while retaining the safe shared container', async function () {
    const a = await store.save({ id: 'ok', ownerUserId: 1, workingDir }, PNG);
    const b = await store.save({ id: 'ok', ownerUserId: 1, workingDir }, PNG);

    await store.deletePastes({ id: 'ok', ownerUserId: 1 });

    assert.ok(!fs.existsSync(a.absolutePath));
    assert.ok(!fs.existsSync(b.absolutePath));
    assert.ok(fs.existsSync(path.join(workingDir, '.cc-web', '.gitignore')));
    assert.deepStrictEqual(fs.readdirSync(path.join(workingDir, '.cc-web', 'pasted')), []);
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
    // The surviving images must stay ignored. Removing the marker while they
    // are still there would make them plain untracked files, and an agent
    // running `git add -A` would commit them.
    assert.ok(
      fs.existsSync(path.join(workingDir, '.cc-web', '.gitignore')),
      'the ignore marker must survive while another session still has images',
    );
  });

  it('keeps the ignore marker when a cleaned directory is used again', async function () {
    await store.save({ id: 'first', ownerUserId: 1, workingDir }, PNG);
    await store.deletePastes({ id: 'first', ownerUserId: 1 });
    assert.ok(fs.existsSync(path.join(workingDir, '.cc-web', '.gitignore')));

    await store.save({ id: 'second', ownerUserId: 1, workingDir }, PNG);

    assert.ok(
      fs.existsSync(path.join(workingDir, '.cc-web', '.gitignore')),
      'the ignore marker must be rewritten for the new session',
    );
  });

  it('keeps the marker when the user has their own files in .cc-web', async function () {
    await store.save({ id: 'ok', ownerUserId: 1, workingDir }, PNG);
    const userFile = path.join(workingDir, '.cc-web', 'notes.txt');
    fs.writeFileSync(userFile, 'mine');

    await store.deletePastes({ id: 'ok', ownerUserId: 1 });

    assert.ok(fs.existsSync(userFile), 'a user file must survive');
    assert.ok(
      fs.existsSync(path.join(workingDir, '.cc-web', '.gitignore')),
      'a surviving directory must stay ignored',
    );
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

  it('retires an oversized manifest without reading it into memory', async function () {
    const saved = await store.save({ id: 'oversized', ownerUserId: 1, workingDir }, PNG);
    const manifest = path.join(storageDir, 'pastes', '1', 'oversized.json');
    fs.writeFileSync(manifest, Buffer.alloc(MAX_PASTE_MANIFEST_BYTES + 1, 0x20));

    await assert.doesNotReject(() => store.deletePastes({ id: 'oversized', ownerUserId: 1 }));
    assert.ok(!fs.existsSync(manifest));
    assert.ok(fs.existsSync(saved.absolutePath), 'untrusted oversized entries are not deletion authority');
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

  it('stores workspace-routed manifests beside the session, not in server storage', async function () {
    const local = {
      id: 'local-manifest', ownerUserId: 1, workingDir,
      storageRoot: workingDir, ownerKey: 'stable-owner',
    };
    await store.save(local, PNG);

    const manifest = path.join(
      workingDir, '.cc-web', 'sessions', 'stable-owner', 'local-manifest', 'paste-manifest.json',
    );
    assert.ok(fs.existsSync(manifest));
    assert.ok(!fs.existsSync(path.join(storageDir, 'pastes', '1', 'local-manifest.json')));
  });

  it('never writes a workspace manifest through a symlinked final component', async function () {
    const local = {
      id: 'symlinked-manifest', ownerUserId: 1, workingDir,
      storageScope: { workspaceRoot: workingDir, ownerKey: 'stable-owner' },
    };
    const saved = await store.save(local, PNG);
    const manifest = path.join(
      workingDir, '.cc-web', 'sessions', 'stable-owner', 'symlinked-manifest', 'paste-manifest.json',
    );
    const canary = path.join(workingDir, 'manifest-canary.json');
    fs.writeFileSync(canary, 'outside-sentinel');
    fs.unlinkSync(manifest);
    fs.symlinkSync(canary, manifest);
    const pasteDirectory = path.dirname(saved.absolutePath);
    const entriesBefore = fs.readdirSync(pasteDirectory).sort();

    await assert.rejects(() => store.save(local, PNG), /unsafe workspace session file/i);

    assert.strictEqual(fs.readFileSync(canary, 'utf8'), 'outside-sentinel');
    assert.strictEqual(fs.lstatSync(manifest).isSymbolicLink(), true);
    assert.deepStrictEqual(
      fs.readdirSync(pasteDirectory).sort(),
      entriesBefore,
      'a paste without a durable manifest must not leave an untracked image behind',
    );
  });

  it('never treats workspace manifest paths as deletion authority', async function () {
    const local = {
      id: 'tampered-manifest', ownerUserId: 1, workingDir,
      storageScope: { workspaceRoot: workingDir, ownerKey: 'stable-owner' },
    };
    await store.save(local, PNG);
    const manifest = path.join(
      workingDir, '.cc-web', 'sessions', 'stable-owner', 'tampered-manifest', 'paste-manifest.json',
    );
    const canary = path.join(workingDir, 'must-survive.txt');
    fs.writeFileSync(canary, 'user data');
    fs.writeFileSync(manifest, JSON.stringify({
      version: 1,
      entries: [{ path: canary, root: canary, bytes: 9 }],
    }));

    await store.deletePastes(local);
    assert.strictEqual(fs.readFileSync(canary, 'utf8'), 'user data');
    assert.ok(!fs.existsSync(manifest), 'only the session-owned manifest itself is retired');
  });

  it('keeps cleanup bound to the pinned pasted directory through a transient swap', async function () {
    if (process.platform !== 'linux' || !fs.existsSync('/proc/self/fd')) this.skip();
    const local = {
      id: 'transient-cleanup', ownerUserId: 1, workingDir,
      storageScope: { workspaceRoot: workingDir, ownerKey: 'stable-owner' },
    };
    const saved = await store.save(local, PNG);
    const pasted = path.join(workingDir, '.cc-web', 'pasted');
    const parked = `${pasted}.parked`;
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-clean-external-'));
    const externalCanary = path.join(external, path.basename(saved.absolutePath));
    fs.writeFileSync(externalCanary, 'external-canary', { mode: 0o600 });

    const originalUnlink = fs.promises.unlink;
    let swapped = false;
    fs.promises.unlink = async function (file, ...rest) {
      if (!swapped && path.basename(String(file)) === path.basename(saved.absolutePath)) {
        swapped = true;
        fs.renameSync(pasted, parked);
        fs.symlinkSync(external, pasted, 'dir');
        try {
          return await originalUnlink.call(this, file, ...rest);
        } finally {
          fs.unlinkSync(pasted);
          fs.renameSync(parked, pasted);
        }
      }
      return originalUnlink.call(this, file, ...rest);
    };

    try {
      await store.deletePastes(local);
    } finally {
      fs.promises.unlink = originalUnlink;
    }

    try {
      assert.strictEqual(swapped, true, 'the test must exchange the visible parent during unlink');
      assert.strictEqual(fs.existsSync(saved.absolutePath), false);
      assert.strictEqual(fs.readFileSync(externalCanary, 'utf8'), 'external-canary');
    } finally {
      fs.rmSync(external, { recursive: true, force: true });
    }
  });

  it('does not perform path-based cleanup on the portable fallback', async function () {
    const local = {
      id: 'portable-cleanup', ownerUserId: 1, workingDir,
      storageScope: { workspaceRoot: workingDir, ownerKey: 'stable-owner' },
    };
    const saved = await store.save(local, PNG);
    const manifest = path.join(
      workingDir, '.cc-web', 'sessions', 'stable-owner', 'portable-cleanup', 'paste-manifest.json',
    );
    const fallback = new PasteStore({ storageDir, forcePathFallback: true });
    const originalError = console.error;
    console.error = () => undefined;
    try {
      await fallback.deletePastes(local);
    } finally {
      console.error = originalError;
    }

    assert.ok(fs.existsSync(saved.absolutePath), 'fallback cleanup must leave paste bytes untouched');
    assert.ok(fs.existsSync(manifest), 'the manifest must remain available for a safe retry');
  });
});
