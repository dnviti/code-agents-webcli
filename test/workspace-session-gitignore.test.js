const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  openWorkspaceStorageDirectorySync,
  workspaceDescriptorRoot,
} = require('../dist/server/services/workspace-session-storage.js');

function assertUnsafe(operation, pattern) {
  assert.throws(
    operation,
    (error) => error
      && error.code === 'UNSAFE_WORKSPACE_STORAGE'
      && pattern.test(error.message),
  );
}

describe('workspace .gitignore hardening', function () {
  let root;
  let container;
  let ignore;

  beforeEach(function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-workspace-ignore-'));
    container = path.join(root, '.cc-web');
    ignore = path.join(container, '.gitignore');
    fs.mkdirSync(container, { mode: 0o700 });
  });

  afterEach(function () {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('rejects a pre-existing symlink without touching its target', function () {
    const outside = path.join(root, 'outside-ignore');
    const sentinel = Buffer.from('outside-sentinel\n');
    fs.writeFileSync(outside, sentinel, { mode: 0o644 });
    try {
      fs.symlinkSync(outside, ignore, 'file');
    } catch (error) {
      if (error && (error.code === 'EPERM' || error.code === 'EACCES')) this.skip();
      throw error;
    }

    assertUnsafe(
      () => openWorkspaceStorageDirectorySync(root),
      /regular non-symlink/i,
    );
    assert.deepStrictEqual(fs.readFileSync(outside), sentinel);
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(outside).mode & 0o7777, 0o644);
    }
  });

  it('rejects a directory occupying the pre-existing marker name', function () {
    fs.mkdirSync(ignore, { mode: 0o700 });

    assertUnsafe(
      () => openWorkspaceStorageDirectorySync(root),
      /regular non-symlink/i,
    );
    assert.strictEqual(fs.statSync(ignore).isDirectory(), true);
  });

  it('rejects a hard-linked marker without chmodding its other name', function () {
    const outsideName = path.join(root, 'shared-ignore');
    fs.writeFileSync(outsideName, 'shared bytes\n', { mode: 0o644 });
    try {
      fs.linkSync(outsideName, ignore);
    } catch (error) {
      if (error && (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'ENOTSUP')) {
        this.skip();
      }
      throw error;
    }

    assertUnsafe(
      () => openWorkspaceStorageDirectorySync(root),
      /private regular non-symlink/i,
    );
    assert.strictEqual(fs.statSync(outsideName).nlink, 2);
    if (process.platform !== 'win32') {
      assert.strictEqual(
        fs.statSync(outsideName).mode & 0o7777,
        0o644,
        'refusal must happen before chmod can mutate the external link name',
      );
    }
  });

  it('hardens a world-readable pre-existing marker to exactly 0600', function () {
    fs.writeFileSync(ignore, 'user-owned bytes\n', { mode: 0o600 });
    fs.chmodSync(ignore, 0o6754);

    const lease = openWorkspaceStorageDirectorySync(root);
    lease.close();

    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(ignore).mode & 0o7777, 0o600);
    }
  });

  it('preserves every byte of a valid pre-existing marker', function () {
    const custom = Buffer.from([0x23, 0x20, 0x75, 0x73, 0x65, 0x72, 0x0a, 0x00, 0xff, 0x0a]);
    fs.writeFileSync(ignore, custom, { mode: 0o600 });

    const lease = openWorkspaceStorageDirectorySync(root);
    lease.close();

    assert.deepStrictEqual(fs.readFileSync(ignore), custom);
  });

  it('rejects a transient final-entry replacement during descriptor-relative open', function () {
    if (!workspaceDescriptorRoot()) this.skip();
    const original = Buffer.from('original-user-ignore\n');
    const replacement = Buffer.from('transient-attacker-ignore\n');
    const parked = path.join(container, '.gitignore.parked');
    fs.writeFileSync(ignore, original, { mode: 0o644 });

    const originalOpenSync = fs.openSync;
    let raced = false;
    fs.openSync = function (file, flags, mode) {
      if (
        !raced
        && path.basename(String(file)) === '.gitignore'
        && (Number(flags) & fs.constants.O_CREAT) === 0
      ) {
        raced = true;
        fs.renameSync(ignore, parked);
        const replacementFd = originalOpenSync.call(
          fs,
          ignore,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
          0o600,
        );
        try {
          fs.writeSync(replacementFd, replacement);
        } finally {
          fs.closeSync(replacementFd);
        }
        let opened;
        try {
          opened = originalOpenSync.call(fs, file, flags, mode);
        } finally {
          fs.unlinkSync(ignore);
          fs.renameSync(parked, ignore);
        }
        return opened;
      }
      return originalOpenSync.call(fs, file, flags, mode);
    };

    try {
      assertUnsafe(
        () => openWorkspaceStorageDirectorySync(root),
        /changed while it was being opened/i,
      );
    } finally {
      fs.openSync = originalOpenSync;
      if (fs.existsSync(parked) && !fs.existsSync(ignore)) fs.renameSync(parked, ignore);
    }

    assert.strictEqual(raced, true, 'the test must replace the entry during the protected open');
    assert.deepStrictEqual(fs.readFileSync(ignore), original);
    assert.strictEqual(fs.existsSync(parked), false);
    if (process.platform !== 'win32') {
      assert.strictEqual(
        fs.statSync(ignore).mode & 0o7777,
        0o644,
        'a rejected replacement must not chmod the original inode',
      );
    }
  });
});
