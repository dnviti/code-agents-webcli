const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  measureStorageUsage,
  removeUnreferencedToolVersionsSafely,
  removeStorageCacheSafely,
  STORAGE_SCAN_MAX_DIRECTORY_DEPTH,
  storageCachePath,
  storageHomeCategory,
} = require('../dist/server/services/storage-usage.js');

describe('storage usage accounting', () => {
  let root;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cawc-storage-'));
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('classifies durable agent and tooling paths by segment', () => {
    assert.equal(storageHomeCategory('.codex/auth.json'), 'agents');
    assert.equal(storageHomeCategory('.local/share/mise/installs/node'), 'tooling');
    assert.equal(storageHomeCategory('.codex-backup/auth.json'), 'other');
    assert.equal(storageHomeCategory('notes.txt'), 'other');
  });

  it('measures home, workspace and overlay data without following symlinks', async () => {
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    const overlay = path.join(root, 'overlay');
    const outside = path.join(root, 'outside');
    await Promise.all([
      fsp.mkdir(path.join(home, '.codex'), { recursive: true }),
      fsp.mkdir(path.join(home, '.local/share/mise'), { recursive: true }),
      fsp.mkdir(workspace, { recursive: true }),
      fsp.mkdir(overlay, { recursive: true }),
      fsp.mkdir(outside, { recursive: true }),
    ]);
    await Promise.all([
      fsp.writeFile(path.join(home, '.codex', 'session'), Buffer.alloc(2048)),
      fsp.writeFile(path.join(home, '.local/share/mise', 'node'), Buffer.alloc(3072)),
      fsp.writeFile(path.join(home, 'notes'), Buffer.alloc(1024)),
      fsp.writeFile(path.join(workspace, 'source'), Buffer.alloc(4096)),
      fsp.writeFile(path.join(overlay, 'settings'), Buffer.alloc(512)),
      fsp.writeFile(path.join(outside, 'must-not-count'), Buffer.alloc(1024 * 1024)),
    ]);
    await fsp.symlink(outside, path.join(home, 'outside-link'));

    const report = await measureStorageUsage({
      homePaths: [home],
      projects: [{ id: 'p1', name: 'one', workspacePath: workspace, overlayPath: overlay }],
      thresholds: { userWarningBytes: 1, adminWarningBytes: Number.MAX_SAFE_INTEGER },
    });

    assert.equal(report.complete, true);
    assert.ok(report.agentsBytes > 0);
    assert.ok(report.toolingBytes > 0);
    assert.ok(report.otherHomeBytes > 0);
    assert.ok(report.projects[0].workspaceBytes > 0);
    assert.ok(report.projects[0].overlayBytes > 0);
    assert.ok(report.totalBytes < 1024 * 1024, 'symlink target was not traversed');
    assert.equal(report.warnings.user, true);
    assert.equal(report.warnings.admin, false);
  });

  it('deduplicates hard-linked file content across measured roots', async function () {
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    await Promise.all([fsp.mkdir(home), fsp.mkdir(workspace)]);
    const source = path.join(home, 'shared');
    await fsp.writeFile(source, Buffer.alloc(8192));
    try {
      await fsp.link(source, path.join(workspace, 'shared-again'));
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EOPNOTSUPP') this.skip();
      throw error;
    }

    const oneRoot = await measureStorageUsage({ homePaths: [home], projects: [] });
    const withLink = await measureStorageUsage({
      homePaths: [home],
      projects: [{ id: 'p1', name: 'one', workspacePath: workspace, overlayPath: path.join(root, 'missing') }],
    });
    assert.ok(withLink.totalBytes - oneRoot.totalBytes < 8192, 'hard-linked content was not charged twice');
  });

  it('returns partial results when a scan budget is exhausted', async () => {
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    await Promise.all(Array.from({ length: 8 }, (_, index) => (
      fsp.writeFile(path.join(home, `file-${index}`), String(index))
    )));

    const report = await measureStorageUsage(
      { homePaths: [home], projects: [] },
      { maxEntries: 2 },
    );
    assert.equal(report.complete, false);
    assert.equal(report.errors.some((error) => error.code === 'limit'), true);
    assert.ok(report.homeBytes > 0, 'bytes accumulated before the limit are retained');
    assert.equal(report.totalBytes, report.homeBytes);
  });

  it('bounds live directory handles for an adversarially deep tree', async function () {
    if (process.platform !== 'linux') this.skip();
    const home = path.join(root, 'home');
    let current = home;
    await fsp.mkdir(current);
    for (let index = 0; index < STORAGE_SCAN_MAX_DIRECTORY_DEPTH + 12; index += 1) {
      current = path.join(current, `level-${index}`);
      await fsp.mkdir(current);
    }
    let active = 0;
    let maxActive = 0;

    const report = await measureStorageUsage({ homePaths: [home], projects: [] }, {
      open: async (...args) => {
        const handle = await fsp.open(...args);
        active += 1;
        maxActive = Math.max(maxActive, active);
        let closed = false;
        return new Proxy(handle, {
          get(target, property) {
            if (property === 'close') return async () => {
              if (!closed) { closed = true; active -= 1; }
              return target.close();
            };
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
      opendir: async (...args) => {
        const dir = await fsp.opendir(...args);
        active += 1;
        maxActive = Math.max(maxActive, active);
        let closed = false;
        return new Proxy(dir, {
          get(target, property) {
            if (property === 'close') return async () => {
              if (!closed) { closed = true; active -= 1; }
              return target.close();
            };
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    });

    assert.equal(report.complete, false);
    assert.equal(report.errors.some((error) => error.code === 'limit'), true);
    assert.ok(maxActive <= STORAGE_SCAN_MAX_DIRECTORY_DEPTH + 2, `opened ${maxActive} directory handles`);
  });

  it('bounds a stalled filesystem read and retains bytes measured before timeout', async () => {
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    await fsp.writeFile(path.join(home, 'file'), 'content');
    const started = Date.now();

    const report = await measureStorageUsage(
      { homePaths: [home], projects: [] },
      { timeoutMs: 25, opendir: () => new Promise(() => undefined) },
    );

    assert.ok(Date.now() - started < 1_000, 'a stalled filesystem await is deadline-bounded');
    assert.equal(report.complete, false);
    assert.equal(report.errors.some((error) => error.code === 'timeout'), true);
    assert.ok(report.homeBytes > 0, 'the opened root remains in the partial measurement');
  });

  it('fails closed when a directory becomes a symlink between lstat and open', async function () {
    if (process.platform !== 'linux') this.skip();
    const home = path.join(root, 'home');
    const victim = path.join(home, 'victim');
    const moved = path.join(home, 'victim-moved');
    const outside = path.join(root, 'outside');
    await Promise.all([fsp.mkdir(victim, { recursive: true }), fsp.mkdir(outside)]);
    await Promise.all([
      fsp.writeFile(path.join(victim, 'small'), 'x'),
      fsp.writeFile(path.join(outside, 'must-not-count'), Buffer.alloc(2 * 1024 * 1024)),
    ]);
    let swapped = false;

    const report = await measureStorageUsage(
      { homePaths: [home], projects: [] },
      {
        lstat: async (candidate, ...args) => {
          const stat = await fsp.lstat(candidate, ...args);
          if (!swapped && String(candidate).endsWith('/victim')) {
            swapped = true;
            await fsp.rename(victim, moved);
            await fsp.symlink(outside, victim);
          }
          return stat;
        },
      },
    );

    assert.equal(swapped, true);
    assert.equal(report.complete, false);
    assert.equal(report.errors.some((error) => error.code === 'io'), true);
    assert.ok(report.homeBytes > 0, 'pre-race accounting is retained');
    assert.ok(report.totalBytes < 2 * 1024 * 1024, 'the replacement symlink was never traversed');
  });

  it('maps opaque cleanup actions beneath the durable home', () => {
    const home = path.join(root, 'home');
    assert.equal(storageCachePath(home, 'miseDownloads'), path.join(home, '.cache/code-agents/mise'));
    assert.equal(fs.existsSync(storageCachePath(home, 'miseDownloads')), false);
  });

  it('keeps an outside target intact across a cache rename-and-symlink swap', async function () {
    if (process.platform !== 'linux') this.skip();
    const home = path.join(root, 'home');
    const cache = storageCachePath(home, 'miseDownloads');
    const moved = path.join(home, '.cache', 'code-agents', 'mise-moved');
    const outside = path.join(root, 'outside');
    await Promise.all([fsp.mkdir(cache, { recursive: true }), fsp.mkdir(outside)]);
    await Promise.all([
      fsp.writeFile(path.join(cache, 'download'), 'disposable'),
      fsp.writeFile(path.join(outside, 'keep'), 'important'),
    ]);
    let swapped = false;

    await assert.rejects(removeStorageCacheSafely(home, 'miseDownloads', {
      opendir: async (...args) => {
        if (!swapped) {
          swapped = true;
          await fsp.rename(cache, moved);
          await fsp.symlink(outside, cache);
        }
        return fsp.opendir(...args);
      },
    }), /changed during cleanup/);

    assert.equal(swapped, true);
    assert.equal(await fsp.readFile(path.join(outside, 'keep'), 'utf8'), 'important');
    assert.equal(fs.existsSync(path.join(outside, 'download')), false);
  });

  it('does not follow a swapped installed-version symlink during unused cleanup', async function () {
    if (process.platform !== 'linux') this.skip();
    const home = path.join(root, 'home');
    const versions = path.join(home, '.local', 'share', 'code-agents', 'mise', 'installs', 'node');
    const installed = path.join(versions, '1.2.3');
    const moved = path.join(versions, '1.2.3-moved');
    const outside = path.join(root, 'outside');
    await Promise.all([fsp.mkdir(installed, { recursive: true }), fsp.mkdir(outside)]);
    await Promise.all([
      fsp.writeFile(path.join(installed, 'node'), 'disposable'),
      fsp.writeFile(path.join(outside, 'keep'), 'important'),
    ]);
    let swapped = false;

    await removeUnreferencedToolVersionsSafely(home, {
      withVersionLock: (_candidate, operation) => operation(),
      isReferenced: () => false,
    }, {
      lstat: async (candidate, ...args) => {
        const stat = await fsp.lstat(candidate, ...args);
        if (!swapped && String(candidate).endsWith('/1.2.3')) {
          swapped = true;
          await fsp.rename(installed, moved);
          await fsp.symlink(outside, installed);
        }
        return stat;
      },
    });

    assert.equal(swapped, true);
    assert.equal(await fsp.readFile(path.join(outside, 'keep'), 'utf8'), 'important');
    assert.equal(fs.existsSync(path.join(outside, 'node')), false);
    assert.equal(fs.existsSync(installed), false, 'replacement symlink itself was unlinked');
    assert.equal(fs.existsSync(path.join(moved, 'node')), true, 'the renamed inode was not followed by path');
  });

  it('fails closed when secure cache cleanup lacks Linux procfd semantics', async () => {
    const home = path.join(root, 'home');
    const cache = storageCachePath(home, 'miseDownloads');
    await fsp.mkdir(cache, { recursive: true });
    await fsp.writeFile(path.join(cache, 'keep'), 'x');

    await assert.rejects(
      removeStorageCacheSafely(home, 'miseDownloads', { platform: 'darwin' }),
      /requires Linux \/proc\/self\/fd/,
    );
    assert.equal(await fsp.readFile(path.join(cache, 'keep'), 'utf8'), 'x');
  });
});
