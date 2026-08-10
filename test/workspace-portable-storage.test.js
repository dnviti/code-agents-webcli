const assert = require('assert');
const childProcess = require('child_process');
const { createHash } = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  openSerializedDatabase,
} = require('../dist/server/services/sqlite.js');
const {
  WorkspaceSessionDatabase,
} = require('../dist/server/services/workspace-session-database.js');
const {
  closeWorkspaceSessionDirectoryLease,
  openCanonicalDirectoryLeaseSync,
  openWorkspaceAttachmentDirectorySync,
  openWorkspacePasteDirectorySync,
  openWorkspaceStorageDirectorySync,
  workspaceSessionAccessDirectory,
  workspaceSessionFileParentLease,
} = require('../dist/server/services/workspace-session-storage.js');
const {
  runWorkspaceCwdHelper,
  publishLargeWorkspaceCwdFile,
  publishNewWorkspaceCwdFile,
  setWorkspaceCwdHelperSpawnerForTests,
} = require('../dist/server/services/workspace-cwd-helper.js');

const OWNER_A = 'portable-owner-key-a';
const OWNER_B = 'portable-owner-key-b';
const CHILD = path.join(__dirname, '..', 'dist', 'server', 'services', 'workspace-cwd-helper-child.js');

function childProcessesWork() {
  const probe = childProcess.spawnSync(process.execPath, ['-e', 'process.exit(0)'], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  const supported = !probe.error && probe.status === 0;
  if (!supported && process.env.CCWEB_TEST_STRICT === '1') {
    assert.fail(`nestedSubprocess capability disappeared after strict preflight: ${probe.error?.code || probe.stderr || probe.status}`);
  }
  return supported;
}

function childRequest(cwd, request, cutpoint) {
  const identity = fs.statSync(cwd, { bigint: true });
  const result = childProcess.spawnSync(process.execPath, [CHILD], {
    cwd,
    input: JSON.stringify({
      version: 1,
      expectedDev: identity.dev.toString(),
      expectedIno: identity.ino.toString(),
      ...request,
    }),
    encoding: 'utf8',
    timeout: 10_000,
    ...(cutpoint ? {
      env: { ...process.env, CODE_AGENTS_WEBCLI_HELPER_TEST_CUTPOINT: cutpoint },
    } : {}),
  });
  const parse = (text) => {
    try { return JSON.parse(String(text).trim()); } catch { return null; }
  };
  return { ...result, response: parse(result.stdout), errorResponse: parse(result.stderr) };
}

function assertChildFailure(result, expression) {
  assert.notStrictEqual(result.status, 0, `child unexpectedly succeeded: ${result.stdout}`);
  assert.strictEqual(result.errorResponse?.code, 'UNSAFE_WORKSPACE_STORAGE');
  assert.match(result.errorResponse?.message ?? '', expression);
}

function directLease(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY);
  return { canonicalPath: directory, fd, verify: () => {} };
}

function helperResponse(directory, name) {
  const stat = fs.lstatSync(path.join(directory, name), { bigint: true });
  return {
    error: undefined, status: 0, signal: null,
    stdout: `${JSON.stringify({ ok: true, origin: 'source', dev: String(stat.dev), ino: String(stat.ino) })}\n`,
    stderr: '',
  };
}

/** A tiny in-process model of the helper's completed namespace mutation. */
function applyHelperWire(options) {
  const wire = JSON.parse(options.input);
  const entry = (name) => path.join(options.cwd, name);
  const replyName = () => (
    ['rename', 'publish', 'claim', 'isolate', 'reconcile-publish', 'reconcile-rename'].includes(wire.operation)
      ? wire.target : wire.name
  );
  switch (wire.operation) {
    case 'inspect-directory':
      if (!fs.lstatSync(entry(wire.name)).isDirectory() || fs.lstatSync(entry(wire.name)).isSymbolicLink()) {
        throw new Error('not a test directory');
      }
      break;
    case 'ensure-directory':
      if (!fs.existsSync(entry(wire.name))) {
        if (!wire.createIfMissing) throw Object.assign(new Error('missing test directory'), { code: 'ENOENT' });
        fs.mkdirSync(entry(wire.name), { mode: 0o700 });
      }
      if (wire.harden) fs.chmodSync(entry(wire.name), 0o700);
      break;
    case 'list': {
      const entries = fs.readdirSync(options.cwd).map((name) => {
        const stat = fs.lstatSync(entry(name), { bigint: true });
        return {
          name, dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size),
          nlink: String(stat.nlink), mode: String(stat.mode),
          type: stat.isSymbolicLink() ? 'symlink' : stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'special',
        };
      });
      return {
        error: undefined, status: 0, signal: null,
        stdout: `${JSON.stringify({ ok: true, origin: 'source', entries: JSON.stringify(entries) })}\n`, stderr: '',
      };
    }
    case 'authority-read':
    case 'stat':
    case 'read': {
      const stat = fs.lstatSync(entry(wire.name), { bigint: true });
      const data = wire.operation === 'read'
        ? fs.readFileSync(entry(wire.name)).subarray(wire.offset, wire.offset + wire.length).toString('base64')
        : wire.operation === 'authority-read' ? fs.readFileSync(entry(wire.name)).toString('base64') : '';
      return {
        error: undefined, status: 0, signal: null,
        stdout: `${JSON.stringify({
          ok: true, origin: 'source', dev: String(stat.dev), ino: String(stat.ino), data,
          size: String(stat.size), nlink: String(stat.nlink), mode: String(stat.mode),
          mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs), birthtimeNs: String(stat.birthtimeNs),
        })}\n`, stderr: '',
      };
    }
    case 'create':
      fs.writeFileSync(entry(wire.name), Buffer.from(wire.data, 'base64'), { flag: 'wx', mode: wire.mode ?? 0o600 });
      break;
    case 'publish':
      fs.linkSync(entry(wire.name), entry(wire.target));
      fs.unlinkSync(entry(wire.name));
      break;
    case 'rename':
      fs.renameSync(entry(wire.name), entry(wire.target));
      break;
    case 'append':
      fs.appendFileSync(entry(wire.name), Buffer.from(wire.data, 'base64'));
      break;
    case 'write': {
      const fd = fs.openSync(entry(wire.name), 'r+');
      try { fs.writeSync(fd, Buffer.from(wire.data, 'base64'), 0, undefined, wire.offset); } finally { fs.closeSync(fd); }
      break;
    }
    case 'truncate':
      fs.truncateSync(entry(wire.name), wire.length);
      break;
    case 'harden':
      fs.chmodSync(entry(wire.name), wire.mode ?? 0o600);
      break;
    case 'migration-retire':
      fs.unlinkSync(entry(wire.name));
      return { error: undefined, status: 0, signal: null, stdout: '{"ok":true,"origin":"source"}\n', stderr: '' };
    case 'recover-migration-retire':
      return { error: undefined, status: 0, signal: null, stdout: '{"ok":true,"origin":"source"}\n', stderr: '' };
    case 'cleanup-create':
      if (fs.existsSync(entry(wire.name))) fs.unlinkSync(entry(wire.name));
      return { error: undefined, status: 0, signal: null, stdout: '{"ok":true,"origin":"source"}\n', stderr: '' };
    case 'recover-publish': {
      const hash = createHash('sha256').update(wire.name).digest('hex').slice(0, 24);
      for (const candidate of fs.readdirSync(options.cwd)) {
        if (candidate.startsWith(`.ccweb-quarantine-publish-${hash}-`)) fs.unlinkSync(entry(candidate));
      }
      return { error: undefined, status: 0, signal: null, stdout: '{"ok":true,"origin":"source"}\n', stderr: '' };
    }
    case 'isolate':
      fs.unlinkSync(entry(wire.name));
      break;
    case 'reconcile-publish':
    case 'reconcile-rename': {
      const target = fs.lstatSync(entry(wire.target), { bigint: true });
      if (String(target.dev) !== wire.expectedEntryDev || String(target.ino) !== wire.expectedEntryIno) {
        throw new Error('test helper reconciliation target mismatch');
      }
      if (wire.operation === 'reconcile-publish' && fs.existsSync(entry(wire.name))) {
        const source = fs.lstatSync(entry(wire.name), { bigint: true });
        if (source.dev !== target.dev || source.ino !== target.ino || source.nlink !== 2n) {
          throw new Error('test helper reconciliation source mismatch');
        }
        fs.unlinkSync(entry(wire.name));
      }
      break;
    }
    case 'verify-absent':
      if (fs.existsSync(entry(wire.name))) throw new Error('test helper expected an absent entry');
      return {
        error: undefined, status: 0, signal: null,
        stdout: `${JSON.stringify({ ok: true, origin: 'source' })}\n`, stderr: '',
      };
    case 'unlink': {
      const stat = fs.lstatSync(entry(wire.name), { bigint: true });
      if (String(stat.dev) !== wire.expectedEntryDev || String(stat.ino) !== wire.expectedEntryIno) {
        return {
          error: undefined, status: 1, signal: null, stdout: '',
          stderr: JSON.stringify({ code: 'UNSAFE_WORKSPACE_STORAGE', message: 'helper refuses changed entry' }),
        };
      }
      fs.unlinkSync(entry(wire.name));
      return {
        error: undefined, status: 0, signal: null,
        stdout: `${JSON.stringify({ ok: true, origin: 'source' })}\n`, stderr: '',
      };
    }
    default:
      throw new Error(`test helper does not model ${wire.operation}`);
  }
  return helperResponse(options.cwd, replyName());
}

describe('portable workspace storage', function () {
  describe('cwd-bound helper child protocol', function () {
    let dir;

    beforeEach(function () {
      if (!childProcessesWork()) this.skip();
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-cwd-helper-'));
    });

    afterEach(function () {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    });

    it('creates, replaces, renames, publishes, unlinks and removes only direct safe entries', function () {
      let result = childRequest(dir, {
        operation: 'mkdir', name: 'child-dir', mode: 0o700,
      });
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(result.response.ok, true);
      assert.strictEqual(fs.statSync(path.join(dir, 'child-dir')).mode & 0o777, 0o700);

      result = childRequest(dir, {
        operation: 'create', name: 'source.tmp', data: Buffer.from('first').toString('base64'), mode: 0o600,
      });
      assert.strictEqual(result.status, 0, result.stderr);
      const source = fs.statSync(path.join(dir, 'source.tmp'), { bigint: true });
      assert.strictEqual(fs.readFileSync(path.join(dir, 'source.tmp'), 'utf8'), 'first');
      assert.strictEqual(Number(source.mode & 0o777n), 0o600);

      result = childRequest(dir, {
        operation: 'rename', name: 'source.tmp', target: 'renamed.tmp',
        expectedEntryDev: source.dev.toString(), expectedEntryIno: source.ino.toString(),
      });
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(fs.existsSync(path.join(dir, 'source.tmp')), false);
      assert.strictEqual(fs.readFileSync(path.join(dir, 'renamed.tmp'), 'utf8'), 'first');

      result = childRequest(dir, {
        operation: 'create', name: 'replacement.tmp', data: Buffer.from('replaced').toString('base64'), mode: 0o600,
      });
      assert.strictEqual(result.status, 0, result.stderr);
      const replacement = fs.statSync(path.join(dir, 'replacement.tmp'), { bigint: true });
      result = childRequest(dir, {
        operation: 'rename', name: 'replacement.tmp', target: 'renamed.tmp',
        expectedEntryDev: replacement.dev.toString(), expectedEntryIno: replacement.ino.toString(),
      });
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(fs.readFileSync(path.join(dir, 'renamed.tmp'), 'utf8'), 'replaced');

      result = childRequest(dir, {
        operation: 'create', name: 'publish.tmp', data: Buffer.from('published').toString('base64'), mode: 0o600,
      });
      assert.strictEqual(result.status, 0, result.stderr);
      const publish = fs.statSync(path.join(dir, 'publish.tmp'), { bigint: true });
      result = childRequest(dir, {
        operation: 'publish', name: 'publish.tmp', target: 'published.txt',
        expectedEntryDev: publish.dev.toString(), expectedEntryIno: publish.ino.toString(),
      });
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(fs.existsSync(path.join(dir, 'publish.tmp')), false);
      assert.strictEqual(fs.readFileSync(path.join(dir, 'published.txt'), 'utf8'), 'published');

      const published = fs.statSync(path.join(dir, 'published.txt'), { bigint: true });
      result = childRequest(dir, {
        operation: 'unlink', name: 'published.txt',
        expectedEntryDev: published.dev.toString(), expectedEntryIno: published.ino.toString(),
      });
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(fs.existsSync(path.join(dir, 'published.txt')), false);

      const childDir = fs.statSync(path.join(dir, 'child-dir'), { bigint: true });
      result = childRequest(dir, {
        operation: 'rmdir', name: 'child-dir',
        expectedEntryDev: childDir.dev.toString(), expectedEntryIno: childDir.ino.toString(),
      });
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(fs.existsSync(path.join(dir, 'child-dir')), false);
    });

    it('rejects bad identities, malformed components, fifos and multiply-linked files', function () {
      let result = childRequest(dir, {
        operation: 'create', name: 'wrong-parent', data: '', expectedDev: '0', expectedIno: '0',
      });
      assertChildFailure(result, /cwd identity/i);

      result = childRequest(dir, { operation: 'mkdir', name: '../escape' });
      assertChildFailure(result, /direct basename/i);
      result = childRequest(dir, { operation: 'mkdir', name: '.' });
      assertChildFailure(result, /direct basename/i);
      result = childRequest(dir, { operation: 'mkdir', name: 42 });
      assertChildFailure(result, /must be a string/i);
      result = childRequest(dir, { operation: 'rename', name: 'regular' });
      assertChildFailure(result, /must be a string/i);

      fs.writeFileSync(path.join(dir, 'regular'), 'safe');
      fs.symlinkSync(path.join(dir, 'regular'), path.join(dir, 'symlink'));
      const symlink = fs.lstatSync(path.join(dir, 'symlink'), { bigint: true });
      result = childRequest(dir, {
        operation: 'unlink', name: 'symlink',
        expectedEntryDev: symlink.dev.toString(), expectedEntryIno: symlink.ino.toString(),
      });
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(fs.existsSync(path.join(dir, 'symlink')), false);
      assert.strictEqual(fs.readFileSync(path.join(dir, 'regular'), 'utf8'), 'safe');

      fs.linkSync(path.join(dir, 'regular'), path.join(dir, 'hardlink'));
      const hardlink = fs.lstatSync(path.join(dir, 'hardlink'), { bigint: true });
      result = childRequest(dir, {
        operation: 'unlink', name: 'hardlink',
        expectedEntryDev: hardlink.dev.toString(), expectedEntryIno: hardlink.ino.toString(),
      });
      assertChildFailure(result, /multiply-linked/i);
      assert.ok(fs.existsSync(path.join(dir, 'hardlink')));

      const fifo = path.join(dir, 'pipe');
      const made = childProcess.spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
      if (!made.error && made.status === 0) {
        const pipe = fs.lstatSync(fifo, { bigint: true });
        result = childRequest(dir, {
          operation: 'unlink', name: 'pipe',
          expectedEntryDev: pipe.dev.toString(), expectedEntryIno: pipe.ino.toString(),
        });
        assertChildFailure(result, /special/i);
        assert.ok(fs.lstatSync(fifo).isFIFO());
      }
    });

    it('recovers exact private-link crash states without deleting raced fixed entries', function () {
      fs.writeFileSync(path.join(dir, 'rename.tmp'), 'new');
      fs.writeFileSync(path.join(dir, 'target.txt'), 'old');
      let source = fs.lstatSync(path.join(dir, 'rename.tmp'), { bigint: true });

      let result = childRequest(dir, {
        operation: 'rename', name: 'rename.tmp', target: 'target.txt',
        expectedEntryDev: source.dev.toString(), expectedEntryIno: source.ino.toString(),
      }, 'rename-private-link');
      assert.notStrictEqual(result.status, 0);
      assert.strictEqual(fs.readFileSync(path.join(dir, 'target.txt'), 'utf8'), 'old');

      result = childRequest(dir, {
        operation: 'reconcile-rename', name: 'rename.tmp', target: 'target.txt',
        expectedEntryDev: source.dev.toString(), expectedEntryIno: source.ino.toString(),
      });
      assert.notStrictEqual(result.status, 0, 'pre-publication crash must not reconcile as success');
      assert.strictEqual(fs.readFileSync(path.join(dir, 'target.txt'), 'utf8'), 'old');
      assert.strictEqual(fs.existsSync(path.join(dir, 'rename.tmp')), false);
      assert.strictEqual(
        fs.readdirSync(dir).filter((name) => name.startsWith('.ccweb-quarantine-rename-')).length,
        0,
      );

      fs.writeFileSync(path.join(dir, 'rename.tmp'), 'new');
      source = fs.lstatSync(path.join(dir, 'rename.tmp'), { bigint: true });
      result = childRequest(dir, {
        operation: 'rename', name: 'rename.tmp', target: 'target.txt',
        expectedEntryDev: source.dev.toString(), expectedEntryIno: source.ino.toString(),
      }, 'rename-target-rename');
      assert.notStrictEqual(result.status, 0);
      result = childRequest(dir, {
        operation: 'reconcile-rename', name: 'rename.tmp', target: 'target.txt',
        expectedEntryDev: source.dev.toString(), expectedEntryIno: source.ino.toString(),
      });
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(fs.existsSync(path.join(dir, 'rename.tmp')), false);
      assert.strictEqual(fs.readFileSync(path.join(dir, 'target.txt'), 'utf8'), 'new');
      assert.strictEqual(
        fs.readdirSync(dir).filter((name) => name.startsWith('.ccweb-quarantine-')).length,
        0,
      );
    });

    it('recovers quarantined unlink, rmdir, and authority-claim cutpoints by exact identity', function () {
      fs.writeFileSync(path.join(dir, 'remove.txt'), 'remove');
      const file = fs.lstatSync(path.join(dir, 'remove.txt'), { bigint: true });
      let result = childRequest(dir, {
        operation: 'unlink', name: 'remove.txt',
        expectedEntryDev: file.dev.toString(), expectedEntryIno: file.ino.toString(),
      }, 'unlink-quarantine');
      assert.notStrictEqual(result.status, 0);
      result = childRequest(dir, {
        operation: 'verify-absent', name: 'remove.txt',
        expectedEntryDev: file.dev.toString(), expectedEntryIno: file.ino.toString(),
      });
      assert.strictEqual(result.status, 0, result.stderr);

      fs.mkdirSync(path.join(dir, 'remove-dir'));
      const directory = fs.lstatSync(path.join(dir, 'remove-dir'), { bigint: true });
      result = childRequest(dir, {
        operation: 'rmdir', name: 'remove-dir',
        expectedEntryDev: directory.dev.toString(), expectedEntryIno: directory.ino.toString(),
      }, 'rmdir-quarantine');
      assert.notStrictEqual(result.status, 0);
      result = childRequest(dir, {
        operation: 'verify-absent', name: 'remove-dir', mode: 0o700,
        expectedEntryDev: directory.dev.toString(), expectedEntryIno: directory.ino.toString(),
      });
      assert.strictEqual(result.status, 0, result.stderr);

      fs.writeFileSync(path.join(dir, 'private.guard'), 'owner');
      const privateGuard = fs.lstatSync(path.join(dir, 'private.guard'), { bigint: true });
      result = childRequest(dir, {
        operation: 'claim', name: 'private.guard', target: 'private.guard.claim',
        expectedEntryDev: privateGuard.dev.toString(), expectedEntryIno: privateGuard.ino.toString(),
      }, 'claim-private-link');
      assert.notStrictEqual(result.status, 0);
      result = childRequest(dir, {
        operation: 'claim', name: 'private.guard', target: 'private.guard.claim',
        expectedEntryDev: privateGuard.dev.toString(), expectedEntryIno: privateGuard.ino.toString(),
      });
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(fs.lstatSync(path.join(dir, 'private.guard'), { bigint: true }).nlink, 2n);
      result = childRequest(dir, {
        operation: 'retire', name: 'private.guard', target: 'private.guard.claim',
        expectedEntryDev: privateGuard.dev.toString(), expectedEntryIno: privateGuard.ino.toString(),
      });
      assert.strictEqual(result.status, 0, result.stderr);

      fs.writeFileSync(path.join(dir, 'writer.guard'), 'owner');
      const guard = fs.lstatSync(path.join(dir, 'writer.guard'), { bigint: true });
      result = childRequest(dir, {
        operation: 'claim', name: 'writer.guard', target: 'writer.guard.claim',
        expectedEntryDev: guard.dev.toString(), expectedEntryIno: guard.ino.toString(),
      }, 'claim-target-link');
      assert.notStrictEqual(result.status, 0);
      result = childRequest(dir, {
        operation: 'claim', name: 'writer.guard', target: 'writer.guard.claim',
        expectedEntryDev: guard.dev.toString(), expectedEntryIno: guard.ino.toString(),
      });
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(fs.lstatSync(path.join(dir, 'writer.guard'), { bigint: true }).nlink, 2n);
      result = childRequest(dir, {
        operation: 'retire', name: 'writer.guard', target: 'writer.guard.claim',
        expectedEntryDev: guard.dev.toString(), expectedEntryIno: guard.ino.toString(),
      });
      assert.strictEqual(result.status, 0, result.stderr);

      for (const cutpoint of ['retire-source-quarantine', 'retire-claim-quarantine']) {
        const sourceName = `${cutpoint}.guard`;
        const claimName = `${sourceName}.claim`;
        fs.writeFileSync(path.join(dir, sourceName), 'owner');
        const identity = fs.lstatSync(path.join(dir, sourceName), { bigint: true });
        result = childRequest(dir, {
          operation: 'claim', name: sourceName, target: claimName,
          expectedEntryDev: identity.dev.toString(), expectedEntryIno: identity.ino.toString(),
        });
        assert.strictEqual(result.status, 0, result.stderr);
        result = childRequest(dir, {
          operation: 'retire', name: sourceName, target: claimName,
          expectedEntryDev: identity.dev.toString(), expectedEntryIno: identity.ino.toString(),
        }, cutpoint);
        assert.notStrictEqual(result.status, 0);
        result = childRequest(dir, {
          operation: 'retire', name: sourceName, target: claimName,
          expectedEntryDev: identity.dev.toString(), expectedEntryIno: identity.ino.toString(),
        });
        assert.strictEqual(result.status, 0, result.stderr);
        assert.strictEqual(
          fs.readdirSync(dir).filter((name) => name.startsWith('.ccweb-quarantine-')).length,
          0,
        );
      }
    });

    it('cold-recovers every authority claim and retirement crash cutpoint', function () {
      const owner = JSON.stringify({
        version: 1, pid: 2147483647, host: os.hostname(), token: 'dead-cutpoint-owner',
        startedAt: 0, incarnation: 'dead-incarnation',
      });
      for (const cutpoint of [
        'claim-private-link', 'claim-target-link',
        'retire-source-quarantine', 'retire-claim-quarantine',
      ]) {
        const root = path.join(dir, cutpoint);
        const storage = path.join(root, '.cc-web');
        fs.mkdirSync(storage, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(storage, '.gitignore'), '*\n', { mode: 0o600 });
        fs.writeFileSync(path.join(storage, '.session-state.writer.guard'), owner, { mode: 0o600 });
        const guard = fs.lstatSync(path.join(storage, '.session-state.writer.guard'), { bigint: true });
        const request = {
          name: '.session-state.writer.guard', target: '.session-state.writer.guard.claim',
          expectedEntryDev: guard.dev.toString(), expectedEntryIno: guard.ino.toString(),
        };
        if (cutpoint.startsWith('retire-')) {
          const claimed = childRequest(storage, { operation: 'claim', ...request });
          assert.strictEqual(claimed.status, 0, claimed.stderr);
        }
        const crashed = childRequest(storage, {
          operation: cutpoint.startsWith('retire-') ? 'retire' : 'claim', ...request,
        }, cutpoint);
        assert.notStrictEqual(crashed.status, 0);

        const database = new WorkspaceSessionDatabase({
          workspaceRoot: root, ownerKey: OWNER_A,
          workspaceStorageOpenOptions: { forceCwdHelper: true },
        });
        database.close();
        assert.deepStrictEqual(
          fs.readdirSync(storage).filter((name) => name.startsWith('.ccweb-quarantine-')),
          [],
        );
      }
    });

    it('cold-recovers database replacement before and after the atomic target rename', function () {
      for (const cutpoint of ['rename-private-link', 'rename-target-rename']) {
        const root = path.join(dir, `database-${cutpoint}`);
        fs.mkdirSync(root, { mode: 0o700 });
        let database = new WorkspaceSessionDatabase({
          workspaceRoot: root, ownerKey: OWNER_A,
          workspaceStorageOpenOptions: { forceCwdHelper: true },
        });
        database.setSetting('cold-rename', cutpoint);
        database.close();

        const storage = path.join(root, '.cc-web');
        const image = fs.readFileSync(path.join(storage, 'session-state.sqlite'));
        const temporary = '.ccweb-parent-cold-recovery.tmp';
        let result = childRequest(storage, {
          operation: 'create', name: temporary, data: image.toString('base64'), mode: 0o600,
        });
        assert.strictEqual(result.status, 0, result.stderr);
        const source = fs.lstatSync(path.join(storage, temporary), { bigint: true });
        result = childRequest(storage, {
          operation: 'rename', name: temporary, target: 'session-state.sqlite',
          expectedEntryDev: source.dev.toString(), expectedEntryIno: source.ino.toString(),
        }, cutpoint);
        assert.notStrictEqual(result.status, 0);

        database = new WorkspaceSessionDatabase({
          workspaceRoot: root, ownerKey: OWNER_A,
          workspaceStorageOpenOptions: { forceCwdHelper: true },
        });
        assert.strictEqual(database.getSetting('cold-rename'), cutpoint);
        database.close();
        assert.deepStrictEqual(
          fs.readdirSync(storage).filter((name) => name.startsWith('.ccweb-quarantine-rename-')),
          [],
        );
      }
    });

    it('cold-normalizes every no-clobber publication crash cutpoint', function () {
      for (const cutpoint of [
        'publish-private-link', 'publish-target-link', 'publish-source-quarantine',
      ]) {
        const sourceName = `${cutpoint}.tmp`;
        const targetName = `${cutpoint}.txt`;
        fs.writeFileSync(path.join(dir, sourceName), cutpoint);
        const source = fs.lstatSync(path.join(dir, sourceName), { bigint: true });
        let result = childRequest(dir, {
          operation: 'publish', name: sourceName, target: targetName,
          expectedEntryDev: source.dev.toString(), expectedEntryIno: source.ino.toString(),
        }, cutpoint);
        assert.notStrictEqual(result.status, 0);
        result = childRequest(dir, { operation: 'recover-publish', name: targetName });
        assert.strictEqual(result.status, 0, result.stderr);
        if (cutpoint === 'publish-private-link') {
          assert.strictEqual(fs.existsSync(path.join(dir, targetName)), false);
        } else {
          const target = fs.lstatSync(path.join(dir, targetName), { bigint: true });
          assert.strictEqual(target.nlink, 1n);
          assert.strictEqual(fs.readFileSync(path.join(dir, targetName), 'utf8'), cutpoint);
        }
        assert.deepStrictEqual(
          fs.readdirSync(dir).filter((name) => name.startsWith('.ccweb-quarantine-publish-')),
          [],
        );
      }
    });
  });

  describe('broker and serialized workspace database', function () {
    let root;

    beforeEach(function () {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-portable-db-'));
    });

    afterEach(function () {
      if (root) fs.rmSync(root, { recursive: true, force: true });
    });

    it('fails bad helper components before it can spawn a child', function () {
      const fd = fs.openSync(root, fs.constants.O_RDONLY);
      const lease = {
        canonicalPath: root,
        fd,
        verify: () => {},
      };
      try {
        assert.throws(
          () => runWorkspaceCwdHelper(lease, { operation: 'mkdir', name: '../escape' }),
          (error) => error.code === 'UNSAFE_WORKSPACE_STORAGE',
        );
      } finally {
        fs.closeSync(fd);
      }
    });

    it('publishes only committed serialized changes and restores them after reopen', function () {
      const images = [];
      const first = openSerializedDatabase({ publish: (image) => images.push(Buffer.from(image)) });
      first.exec('CREATE TABLE state (value TEXT)');
      const afterSchema = images.length;
      assert.throws(() => first.transaction(() => {
        first.prepare('INSERT INTO state VALUES (?)').run('rollback');
        throw new Error('rollback');
      })(), /rollback/);
      assert.strictEqual(images.length, afterSchema, 'rollback must not publish an image');
      first.transaction(() => first.prepare('INSERT INTO state VALUES (?)').run('commit'))();
      assert.strictEqual(images.length, afterSchema + 1);
      first.close();

      const reopened = openSerializedDatabase({
        initialImage: images.at(-1),
        publish: () => assert.fail('read-only reopen unexpectedly published'),
      });
      assert.deepStrictEqual(
        reopened.prepare('SELECT value FROM state').all().map((row) => row.value),
        ['commit'],
      );
      reopened.close();
    });

    it('poisons every operation after publication fails and rejects a corrupt initial image', function () {
      let fail = false;
      const database = openSerializedDatabase({
        publish: () => { if (fail) throw new Error('injected publish failure'); },
      });
      database.exec('CREATE TABLE state (value TEXT)');
      fail = true;
      assert.throws(
        () => database.prepare('INSERT INTO state VALUES (?)').run('lost'),
        (error) => error.code === 'WORKSPACE_DATABASE_POISONED',
      );
      for (const operation of [
        () => database.prepare('SELECT * FROM state'),
        () => database.prepare('SELECT * FROM state').get(),
        () => database.exec('CREATE TABLE never_created (value TEXT)'),
        () => database.pragma('foreign_keys'),
        () => database.transaction(() => {})(),
      ]) {
        assert.throws(operation, (error) => error.code === 'WORKSPACE_DATABASE_POISONED');
      }
      database.close();
      const corrupt = openSerializedDatabase({
        initialImage: Buffer.from('not a sqlite image'),
        publish: () => assert.fail('corrupt image must not publish'),
      });
      try {
        assert.throws(() => corrupt.prepare('SELECT * FROM sqlite_master').all(), /not a database/i);
      } finally {
        corrupt.close();
      }
    });

    it('publishes exactly once for nested and raw outer transactions', function () {
      const images = [];
      const database = openSerializedDatabase({ publish: (image) => images.push(Buffer.from(image)) });
      database.exec('CREATE TABLE state (value TEXT)');
      const afterSchema = images.length;
      const inner = database.transaction(() => database.prepare('INSERT INTO state VALUES (?)').run('inner'));
      database.transaction(() => {
        database.prepare('INSERT INTO state VALUES (?)').run('outer');
        inner();
      })();
      assert.strictEqual(images.length, afterSchema + 1, 'nested transaction must publish at the outer commit only');

      database.exec('BEGIN');
      database.prepare('INSERT INTO state VALUES (?)').run('raw');
      assert.strictEqual(images.length, afterSchema + 1, 'raw BEGIN must defer publication');
      database.exec('COMMIT');
      assert.strictEqual(images.length, afterSchema + 2, 'raw COMMIT must publish the complete image once');
      database.close();
    });

    it('propagates the cwd-helper policy to every workspace hierarchy and refuses a swapped container', function () {
      if (!childProcessesWork()) this.skip();
      const options = { forceCwdHelper: true };
      const storage = openWorkspaceStorageDirectorySync(root, options);
      const paste = openWorkspacePasteDirectorySync(root, options);
      const attachment = openWorkspaceAttachmentDirectorySync(root, OWNER_A, 'portable-session', options);
      const session = { id: 'portable-session', ownerUserId: 1, storageRoot: root, ownerKey: OWNER_A };
      try {
        const sessionDirectory = workspaceSessionAccessDirectory(session, options);
        const parent = workspaceSessionFileParentLease(path.join(sessionDirectory, 'chat.jsonl'));
        for (const lease of [storage, paste, attachment, parent]) {
          assert.strictEqual(lease.entryMutationPolicy, 'cwd-helper');
          assert.strictEqual(lease.pathFallback, true);
        }

        const canonical = path.join(root, '.cc-web');
        const parked = `${canonical}.parked`;
        fs.renameSync(canonical, parked);
        fs.mkdirSync(canonical, { mode: 0o700 });
        fs.writeFileSync(path.join(canonical, 'canary'), 'must-stay');
        assert.throws(
          () => runWorkspaceCwdHelper(storage, { operation: 'create', name: 'must-not-create', data: Buffer.from('x') }),
          /identity|authorised parent|unsafe/i,
        );
        assert.strictEqual(fs.existsSync(path.join(canonical, 'must-not-create')), false);
        assert.strictEqual(fs.readFileSync(path.join(canonical, 'canary'), 'utf8'), 'must-stay');
        fs.rmSync(canonical, { recursive: true, force: true });
        fs.renameSync(parked, canonical);
      } finally {
        closeWorkspaceSessionDirectoryLease(session);
        attachment.close();
        paste.close();
        storage.close();
      }
    });

    it('uses one portable image for multiple owners, removes its writer lease, and leaves no SQLite sidecars', function () {
      if (!childProcessesWork()) this.skip();
      const options = { workspaceRoot: root, workspaceStorageOpenOptions: { forceCwdHelper: true } };
      const first = new WorkspaceSessionDatabase({ ...options, ownerKey: OWNER_A });
      const second = new WorkspaceSessionDatabase({ ...options, ownerKey: OWNER_B });
      try {
        assert.strictEqual(
          first.sharedSerialized,
          second.sharedSerialized,
          'owners in one process must share one underlying serialized connection and lease',
        );
        assert.notStrictEqual(first.raw, second.raw, 'each owner facade must retain its own close guard');
        first.setSetting('owner-a', 'one');
        second.setSetting('owner-b', 'two');
        assert.strictEqual(first.getSetting('owner-b'), 'two');
      } finally {
        first.close();
        second.close();
      }

      const storage = path.join(root, '.cc-web');
      assert.strictEqual(fs.existsSync(path.join(storage, '.session-state.writer')), false);
      assert.deepStrictEqual(
        fs.readdirSync(storage).filter((name) => /session-state\.sqlite-(?:wal|shm|journal)$/.test(name)),
        [],
      );

      const reopened = new WorkspaceSessionDatabase({ ...options, ownerKey: OWNER_A });
      try {
        assert.strictEqual(reopened.getSetting('owner-a'), 'one');
        assert.strictEqual(reopened.getSetting('owner-b'), 'two');
      } finally {
        reopened.close();
      }
    });

    it('rejects a second writer, reclaims a dead exact lease, and fail-stops after writer replacement', function () {
      if (!childProcessesWork()) this.skip();
      const options = { workspaceRoot: root, workspaceStorageOpenOptions: { forceCwdHelper: true } };
      const first = new WorkspaceSessionDatabase({ ...options, ownerKey: OWNER_A });
      try {
        const program = `
          const { WorkspaceSessionDatabase } = require(${JSON.stringify(path.join(__dirname, '..', 'dist', 'server', 'services', 'workspace-session-database.js'))});
          try {
            new WorkspaceSessionDatabase(${JSON.stringify({ ...options, ownerKey: OWNER_B })});
            process.exit(10);
          } catch (error) {
            process.exit(error && error.code === 'UNSAFE_WORKSPACE_STORAGE' ? 0 : 11);
          }
        `;
        const contender = childProcess.spawnSync(process.execPath, ['-e', program], { encoding: 'utf8', timeout: 20_000 });
        assert.ifError(contender.error);
        assert.strictEqual(contender.status, 0, `${contender.stdout}\n${contender.stderr}`);

        const lock = path.join(root, '.cc-web', '.session-state.writer');
        fs.unlinkSync(lock);
        fs.writeFileSync(lock, JSON.stringify({
          version: 1, pid: 999_999_999, host: os.hostname(), token: 'replacement-owner', startedAt: 0,
        }), { mode: 0o600 });
        assert.throws(
          () => first.setSetting('must-not-publish', 'x'),
          (error) => error.code === 'WORKSPACE_DATABASE_POISONED',
        );
        assert.throws(
          () => first.getSetting('must-not-publish'),
          (error) => error.code === 'WORKSPACE_DATABASE_POISONED',
        );
      } finally {
        try { first.close(); } catch { /* Replacement deliberately revokes close authority. */ }
      }

      const storage = path.join(root, '.cc-web');
      fs.rmSync(path.join(storage, '.session-state.writer'), { force: true });
      fs.writeFileSync(
        path.join(storage, '.session-state.writer'),
        JSON.stringify({
          version: 1, pid: 999_999_999, host: os.hostname(), token: 'dead-owner', startedAt: 0,
        }),
        { mode: 0o600 },
      );
      const reclaimed = new WorkspaceSessionDatabase({ ...options, ownerKey: OWNER_B });
      reclaimed.setSetting('reclaimed', 'yes');
      reclaimed.close();
      assert.strictEqual(fs.existsSync(path.join(storage, '.session-state.writer')), false);
    });

    it('refuses existing WAL, SHM, and rollback-journal companions on the serialized backend', function () {
      if (!childProcessesWork()) this.skip();
      const storage = path.join(root, '.cc-web');
      fs.mkdirSync(storage, { mode: 0o700 });
      fs.writeFileSync(path.join(storage, '.gitignore'), '*\n', { mode: 0o600 });
      for (const suffix of ['-wal', '-shm', '-journal']) {
        fs.writeFileSync(path.join(storage, `session-state.sqlite${suffix}`), 'companion', { mode: 0o600 });
        assert.throws(
          () => new WorkspaceSessionDatabase({
            workspaceRoot: root,
            ownerKey: OWNER_A,
            workspaceStorageOpenOptions: { forceCwdHelper: true },
          }),
          /refuses an existing SQLite companion/i,
        );
        fs.rmSync(path.join(storage, `session-state.sqlite${suffix}`));
      }
    });

    it('refuses an oversized serialized image before reading it into process memory', function () {
      if (!childProcessesWork()) this.skip();
      const storage = path.join(root, '.cc-web');
      fs.mkdirSync(storage, { mode: 0o700 });
      fs.writeFileSync(path.join(storage, '.gitignore'), '*\n', { mode: 0o600 });
      const image = path.join(storage, 'session-state.sqlite');
      const fd = fs.openSync(image, 'w', 0o600);
      try {
        // Sparse truncate exercises the admission check without allocating a 384 MiB fixture.
        fs.ftruncateSync(fd, 384 * 1024 * 1024 + 1);
      } finally {
        fs.closeSync(fd);
      }
      assert.throws(
        () => new WorkspaceSessionDatabase({
          workspaceRoot: root,
          ownerKey: OWNER_A,
          workspaceStorageOpenOptions: { forceCwdHelper: true },
        }),
        /portable size limit/i,
      );
    });
  });

  describe('deterministic helper-loss and writer-authority recovery', function () {
    let dir;
    let lease;

    beforeEach(function () {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-helper-seam-'));
      lease = directLease(dir);
    });

    afterEach(function () {
      setWorkspaceCwdHelperSpawnerForTests(null);
      if (lease) fs.closeSync(lease.fd);
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    });

    it('inspects canonical directory paths with spaces and Unicode without changing modes', function () {
      const nested = path.join(dir, 'space ü', 'child directory');
      fs.mkdirSync(nested, { recursive: true, mode: 0o755 });
      fs.chmodSync(path.dirname(nested), 0o755);
      fs.chmodSync(nested, 0o755);
      const helperCwds = [];
      setWorkspaceCwdHelperSpawnerForTests((_, __, options) => {
        helperCwds.push(options.cwd);
        return applyHelperWire(options);
      });
      const proof = openCanonicalDirectoryLeaseSync(nested, { forceCwdHelper: true });
      try {
        proof.verify();
        assert.strictEqual(proof.canonicalPath, nested);
        assert.strictEqual(proof.entryMutationPolicy, 'cwd-helper');
        runWorkspaceCwdHelper(proof, {
          operation: 'create', name: 'proof.txt', data: Buffer.from('root-to-leaf'), mode: 0o600,
        });
        const expectedCwds = [];
        let cursor = path.parse(nested).root;
        for (const component of path.relative(cursor, nested).split(path.sep).filter(Boolean)) {
          expectedCwds.push(cursor);
          cursor = path.join(cursor, component);
        }
        expectedCwds.push(nested);
        let previous = -1;
        for (const expectedCwd of expectedCwds) {
          const found = helperCwds.indexOf(expectedCwd, previous + 1);
          assert.ok(found > previous, `missing ordered cwd-helper proof for ${expectedCwd}`);
          previous = found;
        }
        assert.strictEqual(helperCwds.at(-1), nested);
        assert.strictEqual(fs.readFileSync(path.join(nested, 'proof.txt'), 'utf8'), 'root-to-leaf');
        assert.strictEqual(fs.statSync(nested).mode & 0o777, 0o755);
        assert.strictEqual(fs.statSync(path.dirname(nested)).mode & 0o777, 0o755);
      } finally {
        proof.close();
      }
    });

    it('does not expose parent loader options or credentials to the helper', function () {
      const previousNodeOptions = process.env.NODE_OPTIONS;
      const previousSecret = process.env.CCWEB_HELPER_TEST_SECRET;
      process.env.NODE_OPTIONS = '--require=/should/not/be/inherited.js';
      process.env.CCWEB_HELPER_TEST_SECRET = 'not-for-child';
      let childEnv;
      try {
        setWorkspaceCwdHelperSpawnerForTests((_, __, options) => {
          childEnv = options.env;
          return applyHelperWire(options);
        });
        runWorkspaceCwdHelper(lease, {
          operation: 'create', name: 'minimal-env.tmp', data: Buffer.from('ok'), mode: 0o600,
        });
        assert.strictEqual(childEnv.NODE_OPTIONS, undefined);
        assert.strictEqual(childEnv.CCWEB_HELPER_TEST_SECRET, undefined);
        assert.deepStrictEqual(
          Object.keys(childEnv).filter((key) => key !== 'ELECTRON_RUN_AS_NODE'),
          [],
        );
      } finally {
        if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
        else process.env.NODE_OPTIONS = previousNodeOptions;
        if (previousSecret === undefined) delete process.env.CCWEB_HELPER_TEST_SECRET;
        else process.env.CCWEB_HELPER_TEST_SECRET = previousSecret;
      }
    });

    it('frames the exact maximum helper payload below the child request bound', function () {
      let requestBytes = 0;
      setWorkspaceCwdHelperSpawnerForTests((_, __, options) => {
        requestBytes = Buffer.byteLength(options.input);
        return {
          error: undefined, status: 0, signal: null,
          stdout: '{"ok":true,"origin":"source","dev":"1","ino":"1"}\n', stderr: '',
        };
      });
      runWorkspaceCwdHelper(lease, {
        operation: 'create', name: 'maximum.bin', data: Buffer.alloc(24 * 1024 * 1024), mode: 0o600,
      });
      assert.ok(requestBytes > 32 * 1024 * 1024);
      assert.ok(requestBytes < 34 * 1024 * 1024);
    });

    it('reconciles a lost publish response only when the exact completed target is visible', function () {
      const calls = [];
      setWorkspaceCwdHelperSpawnerForTests((_, __, options) => {
        const wire = JSON.parse(options.input);
        calls.push(wire);
        const completed = applyHelperWire(options);
        if (wire.operation === 'publish') {
          return { error: undefined, status: 1, signal: null, stdout: '', stderr: '{"code":"EIO"}' };
        }
        return completed;
      });

      assert.doesNotThrow(() => publishNewWorkspaceCwdFile(lease, 'published.txt', Buffer.from('atomic')));
      assert.strictEqual(fs.readFileSync(path.join(dir, 'published.txt'), 'utf8'), 'atomic');
      assert.strictEqual(fs.readdirSync(dir).some((name) => name.startsWith('.ccweb-new-')), false);
      assert.deepStrictEqual(
        calls.map((call) => call.operation),
        ['create', 'publish', 'reconcile-publish'],
      );
    });

    it('reconciles a lost rename response after verifying the exact completed image', function () {
      setWorkspaceCwdHelperSpawnerForTests((_, __, options) => {
        const wire = JSON.parse(options.input);
        const completed = applyHelperWire(options);
        if (wire.operation === 'rename') {
          return { error: undefined, status: 1, signal: null, stdout: '', stderr: '{"code":"EIO"}' };
        }
        return completed;
      });

      assert.doesNotThrow(() => publishLargeWorkspaceCwdFile(lease, 'image.sqlite', Buffer.from('image')));
      assert.strictEqual(fs.readFileSync(path.join(dir, 'image.sqlite'), 'utf8'), 'image');
      assert.strictEqual(fs.readdirSync(dir).some((name) => name.startsWith('.ccweb-parent-')), false);
    });

    it('does not accept a lost create response and removes its exact unreported temporary', function () {
      let temporary = null;
      setWorkspaceCwdHelperSpawnerForTests((_, __, options) => {
        const wire = JSON.parse(options.input);
        const completed = applyHelperWire(options);
        if (wire.operation === 'create') {
          temporary = wire.name;
          return { error: undefined, status: 1, signal: null, stdout: '', stderr: '{"code":"EIO"}' };
        }
        return completed;
      });

      assert.throws(() => publishNewWorkspaceCwdFile(lease, 'never-published.txt', Buffer.from('data')),
        /helper failed/i);
      assert.ok(temporary, 'the injected helper must have created a temporary before losing its response');
      assert.strictEqual(fs.existsSync(path.join(dir, temporary)), false, 'unreported exact temporary must be cleaned up');
      assert.strictEqual(fs.existsSync(path.join(dir, 'never-published.txt')), false);
    });

    it('accepts a lost authority-create reply only after exact token readback', function () {
      let lost = false;
      fs.mkdirSync(path.join(dir, '.cc-web'), { mode: 0o700 });
      setWorkspaceCwdHelperSpawnerForTests((_, __, options) => {
        const wire = JSON.parse(options.input);
        const completed = applyHelperWire(options);
        if (!lost && wire.operation === 'create' && wire.name === '.session-state.writer.guard') {
          lost = true;
          return { error: undefined, status: 1, signal: null, stdout: '', stderr: '{"code":"EIO"}' };
        }
        return completed;
      });
      const database = new WorkspaceSessionDatabase({
        workspaceRoot: dir,
        ownerKey: OWNER_A,
        workspaceStorageOpenOptions: { forceCwdHelper: true },
      });
      try {
        assert.strictEqual(lost, true);
        database.setSetting('authority-create-recovered', 'yes');
      } finally {
        database.close();
      }
      assert.strictEqual(fs.existsSync(path.join(dir, '.cc-web', '.session-state.writer')), false);
    });

    it('retries one exact writer-guard unlink without leaking authority or its storage lease', function () {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-guard-unlink-'));
      const guardUnlinks = [];
      let failGuardUnlink = true;
      let database;
      try {
        setWorkspaceCwdHelperSpawnerForTests((_, __, options) => {
          const wire = JSON.parse(options.input);
          if (wire.operation === 'unlink' && wire.name === '.session-state.writer.guard') {
            guardUnlinks.push({ dev: wire.expectedEntryDev, ino: wire.expectedEntryIno });
            if (failGuardUnlink) {
              failGuardUnlink = false;
              return {
                error: undefined, status: 1, signal: null, stdout: '',
                stderr: '{"code":"EIO","message":"injected guard unlink failure"}',
              };
            }
          }
          return applyHelperWire(options);
        });

        database = new WorkspaceSessionDatabase({
          workspaceRoot: root,
          ownerKey: OWNER_A,
          workspaceStorageOpenOptions: { forceCwdHelper: true },
        });
        const storageFd = database.storageLease.fd;
        assert.deepStrictEqual(guardUnlinks.length, 2);
        assert.deepStrictEqual(guardUnlinks[0], guardUnlinks[1], 'retry must target the same guard inode');
        assert.strictEqual(fs.existsSync(path.join(root, '.cc-web', '.session-state.writer.guard')), false);
        assert.strictEqual(fs.existsSync(path.join(root, '.cc-web', '.session-state.writer.guard.claim')), false);
        database.close();
        database = null;
        assert.throws(
          () => fs.fstatSync(storageFd),
          (error) => error && error.code === 'EBADF',
          'successful close releases the storage authority descriptor',
        );
        assert.strictEqual(fs.existsSync(path.join(root, '.cc-web', '.session-state.writer')), false);

        const reopened = new WorkspaceSessionDatabase({
          workspaceRoot: root,
          ownerKey: OWNER_A,
          workspaceStorageOpenOptions: { forceCwdHelper: true },
        });
        reopened.close();
        assert.strictEqual(fs.existsSync(path.join(root, '.cc-web', '.session-state.writer')), false);
      } finally {
        try { database?.close(); } catch { /* Assertion cleanup. */ }
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('never reclaims a live writer whose incarnation is missing or explicitly unavailable', function () {
      setWorkspaceCwdHelperSpawnerForTests((_, __, options) => applyHelperWire(options));
      for (const incarnation of [undefined, 'unavailable']) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-live-writer-'));
        try {
          const storage = path.join(root, '.cc-web');
          fs.mkdirSync(storage, { mode: 0o700 });
          fs.writeFileSync(path.join(storage, '.gitignore'), '*\n', { mode: 0o600 });
          const owner = {
            version: 1,
            pid: process.pid,
            host: os.hostname(),
            token: `live-${incarnation ?? 'missing'}`,
            startedAt: Math.floor(Date.now() - process.uptime() * 1000),
            ...(incarnation === undefined ? {} : { incarnation }),
          };
          const authority = path.join(storage, '.session-state.writer');
          const bytes = JSON.stringify(owner);
          fs.writeFileSync(authority, bytes, { mode: 0o600 });

          assert.throws(
            () => new WorkspaceSessionDatabase({
              workspaceRoot: root,
              ownerKey: OWNER_A,
              workspaceStorageOpenOptions: { forceCwdHelper: true },
            }),
            /another process owns|live or ambiguous/i,
          );
          assert.strictEqual(fs.readFileSync(authority, 'utf8'), bytes);
          assert.strictEqual(fs.existsSync(path.join(storage, '.session-state.writer.guard')), false);
          assert.strictEqual(fs.existsSync(path.join(storage, '.session-state.writer.claim')), false);

          fs.unlinkSync(authority);
          const reopened = new WorkspaceSessionDatabase({
            workspaceRoot: root,
            ownerKey: OWNER_A,
            workspaceStorageOpenOptions: { forceCwdHelper: true },
          });
          reopened.close();
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      }
    });

    it('rejects malformed success responses and identity-checked unlink removes only a symlink entry', function () {
      fs.writeFileSync(path.join(dir, 'outside'), 'sentinel');
      fs.symlinkSync(path.join(dir, 'outside'), path.join(dir, 'link'));
      const link = fs.lstatSync(path.join(dir, 'link'), { bigint: true });
      let seen;
      setWorkspaceCwdHelperSpawnerForTests((_, __, options) => {
        const wire = JSON.parse(options.input);
        seen = wire;
        return applyHelperWire(options);
      });
      runWorkspaceCwdHelper(lease, {
        operation: 'unlink', name: 'link', expectedEntry: { dev: link.dev, ino: link.ino },
      });
      assert.strictEqual(seen.expectedEntryDev, String(link.dev));
      assert.strictEqual(seen.expectedEntryIno, String(link.ino));
      assert.strictEqual(fs.existsSync(path.join(dir, 'link')), false);
      assert.strictEqual(fs.readFileSync(path.join(dir, 'outside'), 'utf8'), 'sentinel');

      setWorkspaceCwdHelperSpawnerForTests(() => ({
        error: undefined, status: 0, signal: null, stdout: 'not-json', stderr: '',
      }));
      assert.throws(
        () => runWorkspaceCwdHelper(lease, { operation: 'mkdir', name: 'not-accepted' }),
        /invalid response/i,
      );
      assert.strictEqual(fs.existsSync(path.join(dir, 'not-accepted')), false);
    });

    it('fails closed and preserves interrupted writer claim state', function () {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-writer-claim-'));
      try {
        const storage = path.join(root, '.cc-web');
        fs.mkdirSync(storage, { mode: 0o700 });
        fs.writeFileSync(path.join(storage, '.gitignore'), '*\n', { mode: 0o600 });
        for (const claim of ['.session-state.writer.guard.claim', '.session-state.writer.claim']) {
          fs.writeFileSync(path.join(storage, claim), 'interrupted', { mode: 0o600 });
          assert.throws(
            () => new WorkspaceSessionDatabase({ workspaceRoot: root, ownerKey: OWNER_A }),
            /claim is (ambiguous|malformed)/i,
          );
          assert.strictEqual(fs.readFileSync(path.join(storage, claim), 'utf8'), 'interrupted');
          fs.unlinkSync(path.join(storage, claim));
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('recovers exact stale interrupted writer and guard claims', function () {
      const owner = JSON.stringify({
        version: 1,
        pid: 2147483647,
        host: os.hostname(),
        token: 'dead-owner',
        startedAt: 0,
        incarnation: 'dead-incarnation',
      });
      for (const [sourceName, claimName, orphan] of [
        ['.session-state.writer.guard', '.session-state.writer.guard.claim', false],
        ['.session-state.writer', '.session-state.writer.claim', false],
        ['.session-state.writer.guard', '.session-state.writer.guard.claim', true],
        ['.session-state.writer', '.session-state.writer.claim', true],
      ]) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-stale-claim-'));
        try {
          const storage = path.join(root, '.cc-web');
          fs.mkdirSync(storage, { mode: 0o700 });
          fs.writeFileSync(path.join(storage, '.gitignore'), '*\n', { mode: 0o600 });
          fs.writeFileSync(path.join(storage, sourceName), owner, { mode: 0o600 });
          fs.linkSync(path.join(storage, sourceName), path.join(storage, claimName));
          if (orphan) fs.unlinkSync(path.join(storage, sourceName));
          const database = new WorkspaceSessionDatabase({ workspaceRoot: root, ownerKey: OWNER_A });
          database.close();
          assert.strictEqual(fs.existsSync(path.join(storage, claimName)), false);
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      }
    });

    it('retains writer authority and the lease when raw close fails, then permits an exact retry', function () {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-writer-close-'));
      let database;
      const closeSync = fs.closeSync;
      const closed = [];
      try {
        database = new WorkspaceSessionDatabase({ workspaceRoot: root, ownerKey: OWNER_A });
        const storageFd = database.storageLease.fd;
        const authority = path.join(root, '.cc-web', '.session-state.writer');
        const sharedRaw = database.sharedSerialized.db;
        const rawClose = sharedRaw.close.bind(sharedRaw);
        assert.ok(fs.existsSync(authority));
        sharedRaw.close = () => {
          assert.ok(fs.existsSync(authority), 'authority must remain until the underlying raw connection closes');
          throw new Error('injected raw close failure');
        };
        fs.closeSync = function (fd, ...rest) {
          if (fd === storageFd) closed.push(fd);
          return closeSync.call(this, fd, ...rest);
        };
        assert.throws(() => database.close(), /injected raw close failure/);
        assert.strictEqual(fs.existsSync(authority), true, 'failed raw close must retain writer authority');
        assert.strictEqual(closed.includes(storageFd), false, 'failed raw close must retain the storage lease');
        assert.throws(
          () => database.raw.prepare('SELECT 1').get(),
          (error) => error.code === 'WORKSPACE_DATABASE_POISONED',
        );
        assert.throws(
          () => new WorkspaceSessionDatabase({ workspaceRoot: root, ownerKey: OWNER_B }),
          /writer is poisoned/i,
        );
        sharedRaw.close = rawClose;
        database.close();
        assert.strictEqual(fs.existsSync(authority), false, 'successful retry must retire exact authority');
        assert.ok(closed.includes(storageFd), 'successful retry must release the storage lease');
      } finally {
        fs.closeSync = closeSync;
        try { database?.close(); } catch { /* The injected close is intentionally terminal. */ }
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('closes only one owner facade while its shared peer remains usable', function () {
      const first = new WorkspaceSessionDatabase({ workspaceRoot: dir, ownerKey: OWNER_A });
      const second = new WorkspaceSessionDatabase({ workspaceRoot: dir, ownerKey: OWNER_B });
      try {
        first.setSetting('shared-before-close', 'yes');
        first.close();
        assert.throws(() => first.getSetting('shared-before-close'), /facade is closed/i);
        assert.throws(() => first.raw.prepare('SELECT 1').get(), /facade is closed/i);
        second.setSetting('peer-after-close', 'durable');
        assert.strictEqual(second.getSetting('shared-before-close'), 'yes');
        assert.strictEqual(second.getSetting('peer-after-close'), 'durable');
      } finally {
        try { first.close(); } catch { /* Test cleanup. */ }
        second.close();
      }
    });
  });

  describe('Windows cwd helper premise', function () {
    it('pins the exact child cwd against rename and removal until the helper exits', async function () {
      if (process.platform !== 'win32') this.skip();
      let directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-win-cwd-pin-'));
      const moved = `${directory}-moved`;
      let child = null;
      try {
        const expected = fs.statSync(directory, { bigint: true });
        const program = `
          const fs = require('node:fs');
          const expected = JSON.parse(process.argv[1]);
          const cwd = fs.statSync('.', { bigint: true });
          if (cwd.dev.toString() !== expected.dev || cwd.ino.toString() !== expected.ino) process.exit(41);
          process.stdout.write(JSON.stringify({ ready: true, dev: cwd.dev.toString(), ino: cwd.ino.toString() }) + '\\n');
          process.on('SIGTERM', () => process.exit(0));
          setInterval(() => {}, 1_000);
        `;
        child = childProcess.spawn(process.execPath, ['-e', program, JSON.stringify({
          dev: expected.dev.toString(), ino: expected.ino.toString(),
        })], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += String(chunk); });
        const ready = await new Promise((resolve, reject) => {
          let stdout = '';
          const cleanup = () => {
            clearTimeout(timer);
            child.off('error', onError);
            child.off('exit', onExit);
            child.stdout.off('data', onData);
          };
          const fail = (error) => { cleanup(); reject(error); };
          const onError = (error) => fail(error);
          const onExit = (code) => {
            cleanup();
            reject(new Error(`Windows cwd child exited before readiness (${code}): ${stderr}`));
          };
          const onData = (chunk) => {
            stdout += String(chunk);
            const newline = stdout.indexOf('\n');
            if (newline < 0) return;
            try {
              const value = JSON.parse(stdout.slice(0, newline));
              cleanup();
              resolve(value);
            } catch (error) {
              fail(error);
            }
          };
          const timer = setTimeout(() => fail(new Error(`Windows cwd child did not become ready: ${stderr}`)), 10_000);
          child.once('error', onError);
          child.once('exit', onExit);
          child.stdout.on('data', onData);
        });
        assert.deepStrictEqual(ready, {
          ready: true, dev: expected.dev.toString(), ino: expected.ino.toString(),
        });
        const sharingFailure = (error) => /^(EPERM|EACCES|EBUSY)$/.test(error?.code);
        assert.throws(() => fs.renameSync(directory, moved), sharingFailure,
          'Windows must not rename a directory held as the helper process cwd');
        assert.throws(() => fs.rmdirSync(directory), sharingFailure,
          'Windows must not remove a directory held as the helper process cwd');

        const exited = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Windows cwd child did not exit')), 10_000);
          child.once('exit', () => { clearTimeout(timer); resolve(); });
        });
        assert.strictEqual(child.kill(), true);
        await exited;
        child = null;
        fs.renameSync(directory, moved);
        directory = null;
        assert.ok(fs.statSync(moved).isDirectory(), 'exact cwd directory must become renameable after child exit');
        fs.rmdirSync(moved);
      } finally {
        if (child && !child.killed) child.kill();
        if (directory) fs.rmSync(directory, { recursive: true, force: true });
        fs.rmSync(moved, { recursive: true, force: true });
      }
    });
  });
});
