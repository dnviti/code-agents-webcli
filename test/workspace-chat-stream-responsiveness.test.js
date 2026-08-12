const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ChatStore } = require('../dist/server/chat/store.js');

const {
  appendSessionFile,
  publishPreparedSessionFile,
  unlinkSessionEntry,
  writePreparedSessionFile,
} = require('../dist/server/services/safe-session-file.js');
const workspaceCwdHelper = require('../dist/server/services/workspace-cwd-helper.js');
const {
  closeWorkspaceCwdHelpers,
  runWorkspaceCwdHelperAsync,
} = workspaceCwdHelper;
const {
  closeWorkspaceSessionDirectoryLease,
  closeWorkspaceSessionDirectoryLeasesForScope,
  ensureWorkspaceSessionDirectory,
  workspaceSessionAccessDirectory,
  workspaceSessionDirectory,
  workspaceSessionFileParentLease,
} = require('../dist/server/services/workspace-session-storage.js');

describe('workspace chat stream responsiveness', function () {
  let root;
  let session;
  let file;
  let persistence;

  beforeEach(function () {
    persistence = undefined;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-chat-stream-'));
    session = {
      id: 'stream-response',
      ownerUserId: 1,
      ownerKey: '1',
      storageRoot: root,
    };
    file = path.join(workspaceSessionDirectory(session), 'chat.jsonl');
    closeWorkspaceCwdHelpers();
  });

  afterEach(async function () {
    await persistence?.catch(() => undefined);
    closeWorkspaceCwdHelpers();
    await closeWorkspaceSessionDirectoryLease(session);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('yields the server event loop while a cwd-helper append is in flight', async function () {
    this.timeout(30_000);
    workspaceSessionAccessDirectory(session, { forceCwdHelper: true });
    const order = [];
    const heartbeat = new Promise((resolve) => setImmediate(() => {
      order.push('heartbeat');
      resolve();
    }));
    persistence = appendSessionFile(file, '{"t":"block_delta"}\n', 'utf8')
      .then(() => order.push('persistence'));

    await heartbeat;
    assert.deepStrictEqual(
      order,
      ['heartbeat'],
      `project-local chat persistence blocked the event loop: ${order.join(', ')}`,
    );
    await persistence;
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"t":"block_delta"}\n');
  });

  it('keeps timer heartbeats moving while dense chat events persist', async function () {
    this.timeout(30_000);
    const store = new ChatStore({ storageDir: path.join(root, 'legacy-server-store') });
    let heartbeats = 0;
    let lastHeartbeat = performance.now();
    let maximumGapMs = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      maximumGapMs = Math.max(maximumGapMs, now - lastHeartbeat);
      lastHeartbeat = now;
      heartbeats += 1;
    }, 2);
    try {
      const writes = Array.from({ length: 20 }, (_, index) => {
        const seq = index + 1;
        return store.append(session, [{ t: 'state', seq, ts: seq, state: 'running' }]);
      });
      persistence = Promise.all(writes);
      await persistence;
      await new Promise((resolve) => setTimeout(resolve, 5));
    } finally {
      clearInterval(timer);
    }
    assert.ok(heartbeats > 2, 'stream persistence starved timer heartbeats');
    assert.ok(
      maximumGapMs < 75,
      `stream persistence blocked a timer heartbeat for ${maximumGapMs.toFixed(1)}ms`,
    );
    assert.strictEqual((await store.read(session, 1, 100)).events.length, 20);
  });

  it('proves the retained directory identity in the worker, not on the server thread', async function () {
    this.timeout(30_000);
    workspaceSessionAccessDirectory(session, { forceCwdHelper: true });
    await appendSessionFile(file, 'seed\n', 'utf8');
    const lease = workspaceSessionFileParentLease(file);
    assert.ok(lease, 'expected a project-local parent lease');
    const result = await runWorkspaceCwdHelperAsync({
      ...lease,
      verify: () => { throw new Error('server-thread lease verification must not run'); },
    }, { operation: 'stat', name: 'chat.jsonl' });
    assert.strictEqual(result.size, '5');
  });

  it('retains the directory descriptor until an in-flight helper operation settles', async function () {
    this.timeout(30_000);
    workspaceSessionAccessDirectory(session, { forceCwdHelper: true });
    await appendSessionFile(file, 'seed\n', 'utf8');
    const lease = workspaceSessionFileParentLease(file);
    assert.ok(lease, 'expected a project-local parent lease');
    persistence = runWorkspaceCwdHelperAsync(lease, {
      operation: 'append', name: 'chat.jsonl', data: Buffer.from('held\n'), mode: 0o600,
    });
    closeWorkspaceSessionDirectoryLease(session);
    await persistence;
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'seed\nheld\n');
  });

  it('drains a cold opening before its workspace scope is retired', async function () {
    if (process.platform !== 'win32') this.skip();
    this.timeout(30_000);
    const order = [];
    persistence = ensureWorkspaceSessionDirectory(session);
    const opening = persistence.then(
      () => assert.fail('cancelled cold opening unexpectedly completed'),
      (error) => {
        assert.match(error.message, /opening was retired/);
        order.push('opening-settled');
      },
    );
    const retirement = closeWorkspaceSessionDirectoryLeasesForScope({
      workspaceRoot: root,
      ownerKey: session.ownerKey,
    })
      .then(() => order.push('retired'));
    await Promise.all([opening, retirement]);
    assert.deepStrictEqual(order, ['opening-settled', 'retired']);
    assert.strictEqual(workspaceSessionFileParentLease(file), null);
    const sessionDirectory = path.dirname(file);
    fs.rmSync(sessionDirectory, { recursive: true, force: true });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.strictEqual(fs.existsSync(sessionDirectory), false, 'worker mutated after retirement');
  });

  it('retires a stopped mutation worker before starting recovery work', async function () {
    this.timeout(30_000);
    workspaceSessionAccessDirectory(session, { forceCwdHelper: true });
    await appendSessionFile(file, 'seed\n', 'utf8');
    const lease = workspaceSessionFileParentLease(file);
    assert.ok(lease, 'expected a project-local parent lease');

    const order = [];
    const interrupted = runWorkspaceCwdHelperAsync(lease, {
      operation: 'append', name: 'chat.jsonl', data: Buffer.from('interrupted\n'), mode: 0o600,
    }).then(
      () => assert.fail('closed mutation worker unexpectedly completed'),
      (error) => {
        assert.strictEqual(error.code, 'WORKSPACE_HELPER_TRANSPORT');
        order.push('retired');
      },
    );
    closeWorkspaceCwdHelpers();
    const recovered = runWorkspaceCwdHelperAsync(lease, {
      operation: 'stat', name: 'chat.jsonl',
    }).then(() => order.push('recovery'));

    await Promise.all([interrupted, recovered]);
    assert.deepStrictEqual(order, ['retired', 'recovery']);
  });

  it('reconciles a rename whose successful transport reply is lost', async function () {
    this.timeout(30_000);
    workspaceSessionAccessDirectory(session, { forceCwdHelper: true });
    const prepared = path.join(path.dirname(file), 'prepared.tmp');
    await writePreparedSessionFile(prepared, 'published\n', 'utf8');
    const original = workspaceCwdHelper.runWorkspaceCwdHelperAsync;
    let droppedReply = false;
    workspaceCwdHelper.runWorkspaceCwdHelperAsync = async (lease, operation) => {
      const result = await original(lease, operation);
      if (!droppedReply && operation.operation === 'rename') {
        droppedReply = true;
        throw Object.assign(new Error('simulated lost rename reply'), {
          code: 'WORKSPACE_HELPER_TRANSPORT',
        });
      }
      return result;
    };
    try {
      await publishPreparedSessionFile(prepared, file);
    } finally {
      workspaceCwdHelper.runWorkspaceCwdHelperAsync = original;
    }
    assert.strictEqual(droppedReply, true, 'rename transport seam was not exercised');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'published\n');
    assert.strictEqual(fs.existsSync(prepared), false);
  });

  it('reconciles an unlink whose successful transport reply is lost', async function () {
    this.timeout(30_000);
    workspaceSessionAccessDirectory(session, { forceCwdHelper: true });
    await appendSessionFile(file, 'remove me\n', 'utf8');
    const original = workspaceCwdHelper.runWorkspaceCwdHelperAsync;
    let droppedReply = false;
    workspaceCwdHelper.runWorkspaceCwdHelperAsync = async (lease, operation) => {
      const result = await original(lease, operation);
      if (!droppedReply && operation.operation === 'unlink') {
        droppedReply = true;
        throw Object.assign(new Error('simulated lost unlink reply'), {
          code: 'WORKSPACE_HELPER_TRANSPORT',
        });
      }
      return result;
    };
    try {
      await unlinkSessionEntry(file);
    } finally {
      workspaceCwdHelper.runWorkspaceCwdHelperAsync = original;
    }
    assert.strictEqual(droppedReply, true, 'unlink transport seam was not exercised');
    assert.strictEqual(fs.existsSync(file), false);
  });
});
