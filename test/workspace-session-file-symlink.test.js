const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ChatStore } = require('../dist/server/chat/store.js');
const { HistoryStore } = require('../dist/server/services/history-store.js');
const { TranscriptStore } = require('../dist/server/services/transcript-store.js');
const {
  closeWorkspaceSessionDirectoryLease,
  openWorkspaceStorageDirectorySync,
  probeWorkspacePathMutationPin,
  resolveWorkspaceEntryMutationPolicy,
  workspaceSessionAccessDirectory,
} = require('../dist/server/services/workspace-session-storage.js');
const {
  appendSessionFile,
  openSessionFileForAppend,
  openSessionFileForRead,
  publishPreparedSessionFile,
  replaceSessionFile,
  unlinkSessionEntry,
  writePreparedSessionFile,
} = require('../dist/server/services/safe-session-file.js');

const OWNER_KEY = 'owner-key-safe';

function chatEvents(start, count) {
  return Array.from({ length: count }, (_, index) => ({
    t: 'state',
    seq: start + index,
    ts: start + index,
    state: 'idle',
  }));
}

describe('workspace session final-component symlink safety', function () {
  let root;
  let session;
  let sessionDir;
  let outside;

  beforeEach(function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-session-file-symlink-'));
    session = {
      id: 'symlink-session',
      ownerUserId: 7,
      storageRoot: root,
      ownerKey: OWNER_KEY,
    };
    sessionDir = path.join(root, '.cc-web', 'sessions', OWNER_KEY, session.id);
    outside = path.join(root, 'outside.txt');
    fs.writeFileSync(outside, 'outside-sentinel');
  });

  afterEach(function () {
    closeWorkspaceSessionDirectoryLease(session);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('binds path-fallback read, append, replace, publish, and delete to the leased parent inode', async function () {
    const descriptorDir = workspaceSessionAccessDirectory(session);
    const readTarget = path.join(descriptorDir, 'read.txt');
    const appendTarget = path.join(descriptorDir, 'append.txt');
    const replaceTarget = path.join(descriptorDir, 'replace.txt');
    const deleteTarget = path.join(descriptorDir, 'delete.txt');
    const preparedTarget = path.join(descriptorDir, 'publish.tmp');
    for (const [file, contents] of [
      [readTarget, 'original-read'],
      [appendTarget, 'original-append'],
      [replaceTarget, 'original-replace'],
      [deleteTarget, 'original-delete'],
    ]) {
      await appendSessionFile(file, contents);
    }
    await writePreparedSessionFile(preparedTarget, 'original-prepared');
    closeWorkspaceSessionDirectoryLease(session);

    const accessDir = workspaceSessionAccessDirectory(session, { forcePathFallback: true });
    assert.strictEqual(accessDir, sessionDir, 'the test must exercise the canonical-path fallback');

    const fallbackReadTarget = path.join(accessDir, 'read.txt');
    const fallbackAppendTarget = path.join(accessDir, 'append.txt');
    const fallbackReplaceTarget = path.join(accessDir, 'replace.txt');
    const fallbackDeleteTarget = path.join(accessDir, 'delete.txt');
    const fallbackPreparedTarget = path.join(accessDir, 'publish.tmp');

    const parked = `${sessionDir}.parked`;
    const external = path.join(root, 'external-session');
    fs.renameSync(sessionDir, parked);
    fs.mkdirSync(external, { mode: 0o700 });
    for (const name of ['read.txt', 'append.txt', 'replace.txt', 'delete.txt', 'publish.tmp']) {
      fs.writeFileSync(path.join(external, name), `external-canary:${name}`, { mode: 0o600 });
    }
    fs.symlinkSync(external, sessionDir, 'dir');

    assert.throws(
      () => workspaceSessionAccessDirectory(session),
      /session directory changed while leased/i,
      'a live lease must never be rebound to the replacement directory',
    );
    await assert.rejects(async () => {
      const handle = await openSessionFileForRead(fallbackReadTarget);
      try {
        await handle.readFile();
      } finally {
        await handle.close();
      }
    }, /parent directory changed/i);
    await assert.rejects(() => appendSessionFile(fallbackAppendTarget, ':must-not-escape'), /parent directory changed/i);
    await assert.rejects(
      () => appendSessionFile(path.join(accessDir, 'must-not-be-created.txt'), 'must-not-escape'),
      /parent directory changed/i,
    );
    await assert.rejects(() => replaceSessionFile(fallbackReplaceTarget, 'must-not-escape'), /parent directory changed/i);
    await assert.rejects(
      () => publishPreparedSessionFile(fallbackPreparedTarget, fallbackReplaceTarget),
      /parent directory changed|requires descriptor-relative/i,
    );
    await assert.rejects(
      () => unlinkSessionEntry(fallbackDeleteTarget),
      /parent directory changed|requires descriptor-relative/i,
    );

    assert.strictEqual(fs.existsSync(path.join(external, 'must-not-be-created.txt')), false);
    assert.deepStrictEqual(
      fs.readdirSync(external).sort(),
      ['append.txt', 'delete.txt', 'publish.tmp', 'read.txt', 'replace.txt'],
      'failed replace/publish paths must not leave an external temporary',
    );
    for (const name of fs.readdirSync(external)) {
      assert.strictEqual(fs.readFileSync(path.join(external, name), 'utf8'), `external-canary:${name}`);
    }
    assert.strictEqual(fs.readFileSync(path.join(parked, 'read.txt'), 'utf8'), 'original-read');
    assert.strictEqual(fs.readFileSync(path.join(parked, 'append.txt'), 'utf8'), 'original-append');
    assert.strictEqual(fs.readFileSync(path.join(parked, 'replace.txt'), 'utf8'), 'original-replace');
    assert.strictEqual(fs.readFileSync(path.join(parked, 'delete.txt'), 'utf8'), 'original-delete');
    assert.strictEqual(fs.readFileSync(path.join(parked, 'publish.tmp'), 'utf8'), 'original-prepared');
  });

  it('fails closed before path-based create, unlink or rename on the portable backend', async function () {
    const descriptorDir = workspaceSessionAccessDirectory(session);
    await appendSessionFile(path.join(descriptorDir, 'delete.txt'), 'owned-data');
    await writePreparedSessionFile(path.join(descriptorDir, 'publish.tmp'), 'prepared-data');
    await appendSessionFile(path.join(descriptorDir, 'publish.txt'), 'target-data');
    closeWorkspaceSessionDirectoryLease(session);
    const accessDir = workspaceSessionAccessDirectory(session, { forcePathFallback: true });

    const external = path.join(root, 'transient-external');
    fs.mkdirSync(external, { mode: 0o700 });
    fs.writeFileSync(path.join(external, 'delete.txt'), 'external-canary', { mode: 0o600 });
    fs.writeFileSync(path.join(external, 'publish.tmp'), 'external-prepared', { mode: 0o600 });
    fs.writeFileSync(path.join(external, 'publish.txt'), 'external-target', { mode: 0o600 });
    const parked = `${sessionDir}.portable-parked`;
    const originalOpen = fs.promises.open;
    const originalUnlink = fs.promises.unlink;
    const originalRename = fs.promises.rename;
    let createSyscallReached = false;
    let unlinkSyscallReached = false;
    let renameSyscallReached = false;

    const transientSwap = async (operation) => {
      fs.renameSync(sessionDir, parked);
      fs.symlinkSync(external, sessionDir, 'dir');
      try {
        return await operation();
      } finally {
        fs.unlinkSync(sessionDir);
        fs.renameSync(parked, sessionDir);
      }
    };

    fs.promises.open = async function (file, flags, ...rest) {
      if (file === path.join(accessDir, 'created.txt')) {
        createSyscallReached = true;
        return transientSwap(() => originalOpen.call(this, file, flags, ...rest));
      }
      return originalOpen.call(this, file, flags, ...rest);
    };
    fs.promises.unlink = async function (file, ...rest) {
      if (file === path.join(accessDir, 'delete.txt')) {
        unlinkSyscallReached = true;
        return transientSwap(() => originalUnlink.call(this, file, ...rest));
      }
      return originalUnlink.call(this, file, ...rest);
    };
    fs.promises.rename = async function (from, to, ...rest) {
      if (from === path.join(accessDir, 'publish.tmp')) {
        renameSyscallReached = true;
        return transientSwap(() => originalRename.call(this, from, to, ...rest));
      }
      return originalRename.call(this, from, to, ...rest);
    };

    try {
      await assert.rejects(
        () => appendSessionFile(path.join(accessDir, 'created.txt'), 'must-not-escape'),
        /requires descriptor-relative access/i,
      );
      await assert.rejects(
        () => unlinkSessionEntry(path.join(accessDir, 'delete.txt')),
        /requires descriptor-relative access/i,
      );
      await assert.rejects(
        () => publishPreparedSessionFile(
          path.join(accessDir, 'publish.tmp'),
          path.join(accessDir, 'publish.txt'),
        ),
        /requires descriptor-relative access/i,
      );
    } finally {
      fs.promises.open = originalOpen;
      fs.promises.unlink = originalUnlink;
      fs.promises.rename = originalRename;
    }

    assert.strictEqual(createSyscallReached, false, 'unsafe O_CREAT must never be attempted');
    assert.strictEqual(unlinkSyscallReached, false, 'unsafe unlink must never be attempted');
    assert.strictEqual(renameSyscallReached, false, 'unsafe rename must never be attempted');
    assert.strictEqual(fs.existsSync(path.join(external, 'created.txt')), false);
    assert.strictEqual(fs.readFileSync(path.join(external, 'delete.txt'), 'utf8'), 'external-canary');
    assert.strictEqual(fs.readFileSync(path.join(external, 'publish.tmp'), 'utf8'), 'external-prepared');
    assert.strictEqual(fs.readFileSync(path.join(external, 'publish.txt'), 'utf8'), 'external-target');
    assert.strictEqual(fs.readFileSync(path.join(sessionDir, 'delete.txt'), 'utf8'), 'owned-data');
    assert.strictEqual(fs.readFileSync(path.join(sessionDir, 'publish.tmp'), 'utf8'), 'prepared-data');
    assert.strictEqual(fs.readFileSync(path.join(sessionDir, 'publish.txt'), 'utf8'), 'target-data');
  });

  it('does not create a missing workspace hierarchy through the portable pathname backend', function () {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-portable-create-'));
    const originalMkdir = fs.mkdirSync;
    let mkdirReached = false;
    fs.mkdirSync = function (target, ...args) {
      if (target === path.join(fresh, '.cc-web')) mkdirReached = true;
      return originalMkdir.call(this, target, ...args);
    };
    try {
      assert.throws(
        () => openWorkspaceStorageDirectorySync(fresh, { forcePathFallback: true }),
        /requires descriptor-relative access/i,
      );
    } finally {
      fs.mkdirSync = originalMkdir;
    }
    try {
      assert.strictEqual(mkdirReached, false, 'unsafe mkdir must never be attempted');
      assert.strictEqual(fs.existsSync(path.join(fresh, '.cc-web')), false);
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('keeps unproven pathname fallbacks read-only for directory-entry mutations', async function () {
    const portableRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-portable-deny-'));
    const portableSession = {
      id: 'portable-session',
      ownerUserId: 9,
      storageRoot: portableRoot,
      ownerKey: 'portable-owner',
    };
    try {
      const prepared = path.join(
        portableRoot,
        '.cc-web',
        'sessions',
        'portable-owner',
        'portable-session',
      );
      fs.mkdirSync(prepared, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(prepared, 'existing.log'), 'seed', { mode: 0o600 });
      fs.writeFileSync(path.join(portableRoot, '.cc-web', '.gitignore'), '*\n', { mode: 0o600 });

      const accessDir = workspaceSessionAccessDirectory(portableSession, { forcePathFallback: true });
      assert.strictEqual(
        accessDir,
        path.join(portableRoot, '.cc-web', 'sessions', 'portable-owner', 'portable-session'),
      );
      const existing = path.join(accessDir, 'existing.log');
      await appendSessionFile(existing, ':append-safe');
      assert.strictEqual(fs.readFileSync(existing, 'utf8'), 'seed:append-safe');
      await assert.rejects(
        () => appendSessionFile(path.join(accessDir, 'new.log'), 'must-not-create'),
        /requires descriptor-relative access/i,
      );
      await assert.rejects(
        () => unlinkSessionEntry(existing),
        /requires descriptor-relative access/i,
      );
      assert.strictEqual(fs.readFileSync(existing, 'utf8'), 'seed:append-safe');
      assert.ok(fs.existsSync(path.join(portableRoot, '.cc-web', '.gitignore')));
    } finally {
      closeWorkspaceSessionDirectoryLease(portableSession);
      fs.rmSync(portableRoot, { recursive: true, force: true });
    }
  });

  it('selects descriptor mutation or the cwd-bound helper, never a Windows pathname pin', function () {
    assert.strictEqual(
      resolveWorkspaceEntryMutationPolicy('/dev/fd', 'darwin', false),
      'descriptor',
    );
    assert.strictEqual(
      resolveWorkspaceEntryMutationPolicy('/dev/fd', 'freebsd', false),
      'descriptor',
    );
    assert.strictEqual(resolveWorkspaceEntryMutationPolicy(null, 'darwin', false), 'cwd-helper');
    assert.strictEqual(resolveWorkspaceEntryMutationPolicy(null, 'linux', false), 'cwd-helper');
    assert.strictEqual(
      resolveWorkspaceEntryMutationPolicy(null, 'win32', true),
      'cwd-helper',
    );
    assert.strictEqual(resolveWorkspaceEntryMutationPolicy(null, 'win32', false), 'cwd-helper');
  });

  it('never treats Windows ancestor rename pinning as pathname mutation authority', function () {
    const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-windows-pin-probe-'));
    const fd = fs.openSync(probeRoot, fs.constants.O_RDONLY);
    const originalRename = fs.renameSync;
    // Both volume behaviours are modelled explicitly rather than by removing
    // the stub, because a real Windows host pins the ancestor rename itself and
    // could not otherwise exercise the unpinned branch deterministically.
    let pinsRenames = true;
    let renameBlockedWhileOpen = false;
    fs.renameSync = function (from, to, ...rest) {
      if (path.basename(String(from)).startsWith('.cc-web-pin-rename-')) {
        if (!pinsRenames) return undefined;
        if (!renameBlockedWhileOpen) {
          // Only the attempt made while the descendant handle is open is
          // refused; the probe requires the retry after close to succeed.
          renameBlockedWhileOpen = true;
          throw Object.assign(new Error('simulated sharing violation'), { code: 'EBUSY' });
        }
      }
      return originalRename.call(this, from, to, ...rest);
    };
    try {
      // libuv opens directories with FILE_SHARE_DELETE, so a live handle never
      // prevents its own directory from being removed. Requiring that as well
      // left this capability unreachable on every real Windows host, and the
      // policy stuck at 'deny' with `.cc-web` impossible to create. The
      // ancestor rename pin is what the probe now establishes.
      assert.strictEqual(probeWorkspacePathMutationPin(probeRoot, fd), false);
      assert.strictEqual(renameBlockedWhileOpen, false, 'the unsafe probe must not mutate the namespace');

      // Without rename pinning there is no namespace guarantee left to rely on.
      pinsRenames = false;
      assert.strictEqual(probeWorkspacePathMutationPin(probeRoot, fd), false);
    } finally {
      fs.renameSync = originalRename;
      fs.closeSync(fd);
      fs.rmSync(probeRoot, { recursive: true, force: true });
    }
  });

  it('closes the existing append handle when permission hardening fails', async function () {
    if (process.platform === 'win32') this.skip();
    const file = path.join(root, 'existing.log');
    fs.writeFileSync(file, 'seed', { mode: 0o600 });
    const originalOpen = fs.promises.open;
    let closeCalls = 0;
    fs.promises.open = async function (...args) {
      const handle = await originalOpen.apply(this, args);
      const originalClose = handle.close.bind(handle);
      handle.chmod = async () => {
        throw Object.assign(new Error('simulated chmod failure'), { code: 'EACCES' });
      };
      handle.close = async (...closeArgs) => {
        closeCalls += 1;
        return originalClose(...closeArgs);
      };
      return handle;
    };
    try {
      await assert.rejects(() => openSessionFileForAppend(file), /simulated chmod failure/);
    } finally {
      fs.promises.open = originalOpen;
    }
    assert.strictEqual(closeCalls, 1, 'the verified handle must be closed on a chmod failure');
  });

  it('never follows a transcript.md symlink for create, append, read, trim, or delete', async function () {
    const store = new TranscriptStore({
      storageDir: path.join(root, 'legacy'),
      maxTranscriptBytes: 1,
    });
    const transcript = await store.ensureTranscript(session);
    fs.unlinkSync(transcript);
    fs.symlinkSync(outside, transcript);

    await assert.rejects(() => store.ensureTranscript(session), /unsafe workspace session file/i);
    store.appendOutput(session, 'must-not-escape');
    await assert.rejects(() => store.readTranscriptChunks(session), /unsafe workspace session file/i);
    assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'outside-sentinel');

    await store.deleteTranscript(session);
    assert.strictEqual(fs.existsSync(transcript), false, 'delete must unlink only the workspace entry');
    assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'outside-sentinel');
  });

  it('never follows history log/index symlinks and unlinks only their directory entries', async function () {
    const options = { storageDir: path.join(root, 'legacy-history') };
    const writer = new HistoryStore(options);
    writer.append(session, ['one']);
    await writer.stat(session);

    const log = path.join(sessionDir, 'history.log');
    fs.unlinkSync(log);
    fs.symlinkSync(outside, log);
    await assert.rejects(() => new HistoryStore(options).stat(session), /unsafe workspace session file/i);
    assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'outside-sentinel');

    fs.unlinkSync(log);
    fs.writeFileSync(log, 'one\n', { mode: 0o600 });
    const index = path.join(sessionDir, 'history.idx');
    fs.unlinkSync(index);
    fs.symlinkSync(outside, index);
    await assert.rejects(() => new HistoryStore(options).read(session, 0, 1), /unsafe workspace session file/i);
    assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'outside-sentinel');

    await new HistoryStore(options).deleteHistory(session);
    assert.strictEqual(fs.existsSync(index), false);
    assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'outside-sentinel');
  });

  it('rejects symlinked history retention temporaries before copying or publishing', async function () {
    const options = {
      storageDir: path.join(root, 'legacy-history'),
      maxLines: 1,
      trimChunkLines: 1,
    };
    const store = new HistoryStore(options);
    store.append(session, ['one']);
    await store.stat(session);

    fs.symlinkSync(outside, path.join(sessionDir, 'history.log.tmp'));
    store.append(session, ['two']);
    // A read drains the fire-and-forget append queue. The append itself may
    // remain durable even when its optional retention pass is refused.
    await store.stat(session);
    assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'outside-sentinel');
  });

  it('never follows chat log/index symlinks during append, recovery, or positioned reads', async function () {
    const options = { storageDir: path.join(root, 'legacy-chat') };
    const writer = new ChatStore(options);
    await writer.append(session, chatEvents(1, 2));

    const log = path.join(sessionDir, 'chat.jsonl');
    fs.unlinkSync(log);
    fs.symlinkSync(outside, log);
    await assert.rejects(() => new ChatStore(options).stat(session), /unsafe workspace session file/i);
    await assert.rejects(() => new ChatStore(options).append(session, chatEvents(3, 1)), /unsafe workspace session file/i);
    assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'outside-sentinel');

    fs.unlinkSync(log);
    fs.writeFileSync(log, `${JSON.stringify(chatEvents(1, 1)[0])}\n`, { mode: 0o600 });
    const index = path.join(sessionDir, 'chat.idx');
    fs.unlinkSync(index);
    fs.symlinkSync(outside, index);
    await assert.rejects(() => new ChatStore(options).read(session, 1, 1), /unsafe workspace session file/i);
    assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'outside-sentinel');

    await new ChatStore(options).deleteChat(session);
    assert.strictEqual(fs.existsSync(index), false);
    assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'outside-sentinel');
  });

  it('rejects symlinked chat context, plan, and retention temporary components', async function () {
    const options = {
      storageDir: path.join(root, 'legacy-chat'),
      maxEvents: 2,
      trimChunkEvents: 1,
    };
    const store = new ChatStore(options);
    await store.append(session, chatEvents(1, 2));

    const context = path.join(sessionDir, 'chat.ctx');
    fs.symlinkSync(outside, context);
    await assert.rejects(() => store.setOpeningContext(session, 'must-not-escape'), /unsafe workspace session file/i);
    await assert.rejects(() => store.openingContext(session), /unsafe workspace session file/i);
    assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'outside-sentinel');
    await store.clearOpeningContext(session);

    const plan = path.join(sessionDir, 'chat.plan');
    fs.symlinkSync(outside, plan);
    await assert.rejects(
      () => store.setPlanDocument(session, { markdown: '# unsafe', revision: 1, ts: 1 }),
      /unsafe workspace session file/i,
    );
    await assert.rejects(() => store.planDocument(session), /unsafe workspace session file/i);
    assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'outside-sentinel');
    await store.clearPlanDocument(session);

    fs.symlinkSync(outside, path.join(sessionDir, 'chat.jsonl.tmp'));
    await store.append(session, chatEvents(3, 1));
    assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'outside-sentinel');
  });
});
