const assert = require('assert');
const { fork } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ClaudeCodeWebServer } = require('../dist/server/index.js');
const { AppDatabase } = require('../dist/server/services/database.js');
const {
  DATA_DIR_LEASE_DIRECTORY,
  DATA_DIR_LEASE_LOST_EXIT_CODE,
  DataDirLease,
} = require('../dist/server/services/data-dir-lease.js');

const CHILD = path.join(__dirname, 'fixtures', 'data-dir-lease-child.js');

function waitForMessage(child, predicate, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for child ${child.pid}`));
    }, timeoutMs);
    const onMessage = (message) => {
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`Child ${child.pid} exited first (${code ?? signal})`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off('message', onMessage);
      child.off('exit', onExit);
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
  });
}

function waitForExit(child, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for child ${child.pid} to exit`));
    }, timeoutMs);
    const onExit = (code, signal) => {
      cleanup();
      resolve({ code, signal });
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off('exit', onExit);
    };
    child.once('exit', onExit);
  });
}

function spawnChild(args) {
  return fork(CHILD, args, {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
}

function mode(target) {
  return fs.statSync(target).mode & 0o777;
}

describe('installation data-directory lease', function () {
  this.timeout(20_000);

  it('blocks a real second server before database construction or a later EADDRINUSE', async function () {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cc-web-data-lease-'));
    const dataDir = path.join(root, 'data');
    const fixtureDatabase = new AppDatabase({ dataDir });
    fixtureDatabase.setSetting('lease.fixture', 'unchanged');
    fixtureDatabase.close();

    const databasePath = path.join(dataDir, 'app.sqlite');
    const source = path.join(dataDir, 'held-open.fixture');
    await fs.promises.writeFile(source, 'held\n', { mode: 0o600 });
    const holder = spawnChild(['hold', dataDir, source]);
    let contender = null;
    try {
      const ready = await waitForMessage(holder, (message) => message?.type === 'ready');
      const before = await fs.promises.lstat(source);
      const beforeBytes = await fs.promises.readFile(source);
      const beforeDatabase = await fs.promises.readFile(databasePath);

      // The holder owns this port too. Without the lease, the contender would
      // get as far as constructing AppDatabase and then fail with EADDRINUSE.
      contender = spawnChild([
        'start-server',
        dataDir,
        root,
        String(ready.port),
      ]);
      const refused = await waitForMessage(
        contender,
        (message) => message?.type === 'start-error' || message?.type === 'fatal',
      );
      assert.strictEqual(refused.type, 'start-error');
      assert.strictEqual(refused.code, 'data_dir_in_use');
      assert.ok(!/EADDRINUSE/u.test(refused.message));
      assert.strictEqual((await waitForExit(contender)).code, 0);

      const after = await fs.promises.lstat(source);
      assert.strictEqual(after.ino, before.ino);
      assert.strictEqual(after.size, before.size);
      assert.strictEqual(after.mtimeMs, before.mtimeMs);
      assert.deepStrictEqual(await fs.promises.readFile(source), beforeBytes);
      assert.deepStrictEqual(
        await fs.promises.readFile(databasePath),
        beforeDatabase,
        'the rejected process must not open or update app.sqlite',
      );
      holder.send('release');
      const released = await waitForMessage(holder, (message) => message?.type === 'released');
      assert.strictEqual(released.released, true);
      assert.strictEqual((await waitForExit(holder)).code, 0);

      const verifiedDatabase = new AppDatabase({ dataDir });
      try {
        assert.strictEqual(verifiedDatabase.getSetting('lease.fixture'), 'unchanged');
        assert.deepStrictEqual(verifiedDatabase.listUsers(), []);
      } finally {
        verifiedDatabase.close();
      }
    } finally {
      if (contender && contender.exitCode === null && contender.signalCode === null) {
        contender.kill('SIGKILL');
      }
      if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL');
      await Promise.allSettled([
        contender ? waitForExit(contender, 2_000) : Promise.resolve(),
        waitForExit(holder, 2_000),
      ]);
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it('recovers only after both a dead process incarnation and stale heartbeat', async function () {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cc-web-stale-lease-'));
    const artifact = path.join(root, 'legacy.log');
    await fs.promises.writeFile(artifact, 'held\n');
    const holder = spawnChild(['hold', root, artifact, '20', '140']);
    try {
      await waitForMessage(holder, (message) => message?.type === 'ready');
      const ownerPath = path.join(root, DATA_DIR_LEASE_DIRECTORY, 'owner.json');
      const originalOwner = JSON.parse(await fs.promises.readFile(ownerPath, 'utf8'));
      holder.kill('SIGKILL');
      await waitForExit(holder);

      await assert.rejects(
        () => DataDirLease.acquire(root, { heartbeatIntervalMs: 20, staleAfterMs: 140 }),
        (error) => error?.code === 'data_dir_in_use',
        'a dead PID alone must not authorize recovery while its heartbeat is fresh',
      );

      await new Promise((resolve) => setTimeout(resolve, 180));
      const recovered = await DataDirLease.acquire(root, {
        heartbeatIntervalMs: 20,
        staleAfterMs: 140,
      });
      const replacementOwner = JSON.parse(await fs.promises.readFile(ownerPath, 'utf8'));
      assert.notStrictEqual(replacementOwner.token, originalOwner.token);
      assert.strictEqual(await recovered.release(), true);
    } finally {
      if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL');
      await Promise.allSettled([waitForExit(holder, 2_000)]);
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed on an ownerless stale initialization directory', async function () {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cc-web-empty-lease-'));
    const leasePath = path.join(root, DATA_DIR_LEASE_DIRECTORY);
    await fs.promises.mkdir(leasePath, { mode: 0o700 });
    const old = new Date(Date.now() - 10_000);
    await fs.promises.utimes(leasePath, old, old);
    try {
      await assert.rejects(
        () => DataDirLease.acquire(root, {
          heartbeatIntervalMs: 20,
          staleAfterMs: 100,
          guardWaitMs: 100,
        }),
        (error) => error?.code === 'data_dir_in_use',
      );
      assert.strictEqual(fs.existsSync(leasePath), true);
      assert.deepStrictEqual(await fs.promises.readdir(leasePath), []);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it('uses private entries and never removes a lease whose token changed', async function () {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cc-web-token-lease-'));
    const lease = DataDirLease.acquireSync(root);
    const leasePath = path.join(root, DATA_DIR_LEASE_DIRECTORY);
    const ownerPath = path.join(leasePath, 'owner.json');
    const heartbeatPath = path.join(leasePath, 'heartbeat.json');
    try {
      assert.strictEqual(mode(leasePath), 0o700);
      assert.strictEqual(mode(ownerPath), 0o600);
      assert.strictEqual(mode(heartbeatPath), 0o600);

      const owner = JSON.parse(await fs.promises.readFile(ownerPath, 'utf8'));
      owner.token = 'f'.repeat(64);
      await fs.promises.writeFile(ownerPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
      assert.strictEqual(await lease.release(), false);
      assert.strictEqual(fs.existsSync(leasePath), true);
      assert.strictEqual(
        JSON.parse(await fs.promises.readFile(ownerPath, 'utf8')).token,
        'f'.repeat(64),
      );
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it('never treats an unverifiable owner identity as PID reuse', async function () {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cc-web-identity-lease-'));
    const lease = DataDirLease.acquireSync(root, {
      heartbeatIntervalMs: 1_000,
      staleAfterMs: 2_000,
    });
    const leasePath = path.join(root, DATA_DIR_LEASE_DIRECTORY);
    const ownerPath = path.join(leasePath, 'owner.json');
    const heartbeatPath = path.join(leasePath, 'heartbeat.json');
    try {
      const owner = JSON.parse(await fs.promises.readFile(ownerPath, 'utf8'));
      owner.processStartIdentity = `runtime:${process.platform}:unverifiable`;
      owner.acquiredAt = Date.now() - 10_000;
      await fs.promises.writeFile(ownerPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
      const old = new Date(Date.now() - 10_000);
      await fs.promises.utimes(ownerPath, old, old);
      await fs.promises.utimes(heartbeatPath, old, old);

      assert.throws(
        () => DataDirLease.acquireSync(root, {
          heartbeatIntervalMs: 1_000,
          staleAfterMs: 2_000,
        }),
        (error) => error?.code === 'data_dir_in_use',
      );
      assert.strictEqual(fs.existsSync(leasePath), true);
      assert.strictEqual(await lease.release(), true);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it('retains the lease when construction fails after AppDatabase opened', async function () {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cc-web-constructor-lease-'));
    const dataDir = path.join(root, 'data');
    const fixtureDatabase = new AppDatabase({ dataDir });
    fixtureDatabase.setSetting('deploy.encryptionKeyId', 'corrupt-fixture-key');
    fixtureDatabase.setSetting('deploy.encryptionKeys.corrupt-fixture-key', '{not-json');
    fixtureDatabase.close();
    const failed = spawnChild(['fail-after-db', dataDir, root]);
    let contender = null;
    try {
      const construction = await waitForMessage(
        failed,
        (message) => message?.type === 'constructor-error',
      );
      assert.match(construction.message, /corrupt key record/u);
      assert.strictEqual(fs.existsSync(path.join(dataDir, 'app.sqlite')), true);

      contender = spawnChild(['start-server', dataDir, root, '0']);
      const refused = await waitForMessage(
        contender,
        (message) => message?.type === 'start-error' || message?.type === 'fatal',
      );
      assert.strictEqual(refused.type, 'start-error');
      assert.strictEqual(refused.code, 'data_dir_in_use');
      assert.strictEqual((await waitForExit(contender)).code, 0);
      assert.strictEqual(failed.exitCode, null, 'the failed constructor still owns native state');
    } finally {
      if (contender && contender.exitCode === null && contender.signalCode === null) {
        contender.kill('SIGKILL');
      }
      if (failed.exitCode === null && failed.signalCode === null) failed.kill('SIGKILL');
      await Promise.allSettled([
        contender ? waitForExit(contender, 2_000) : Promise.resolve(),
        waitForExit(failed, 2_000),
      ]);
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it('fail-stops the process if live lease ownership is replaced', async function () {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cc-web-lost-lease-'));
    const dataDir = path.join(root, 'data');
    const child = spawnChild(['lose-server-lease', dataDir, root]);
    try {
      await waitForMessage(child, (message) => message?.type === 'lease-corrupted');
      const exited = await waitForExit(child, 8_000);
      assert.deepStrictEqual(exited, {
        code: DATA_DIR_LEASE_LOST_EXIT_CODE,
        signal: null,
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await Promise.allSettled([waitForExit(child, 2_000)]);
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it('releases after pre-database validation and owned startup failures', async function () {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cc-web-start-lease-'));
    try {
      const untouched = path.join(root, 'invalid-config');
      assert.throws(
        () => new ClaudeCodeWebServer({ dataDir: untouched, cert: '/only-a-cert.pem' }),
        /without --key/u,
      );
      assert.strictEqual(fs.existsSync(untouched), false);
      const invalidKeyRoot = path.join(root, 'invalid-key-config');
      assert.throws(
        () => new ClaudeCodeWebServer({
          dataDir: invalidKeyRoot,
          encryptionKey: 'not-a-32-byte-key',
        }),
        /key must be 32 bytes/u,
      );
      assert.strictEqual(fs.existsSync(invalidKeyRoot), false);
      assert.throws(
        () => new ClaudeCodeWebServer({
          dataDir: root,
          desktop: { authToken: 'token', username: 'lease-test' },
        }),
        /127\.0\.0\.1/u,
      );
      const afterConstructor = DataDirLease.acquireSync(root);
      assert.strictEqual(afterConstructor.releaseSync(), true);

      const server = new ClaudeCodeWebServer({
        dataDir: root,
        baseFolder: root,
        host: '127.0.0.1',
        port: 0,
        desktop: { authToken: 'token', username: 'lease-test' },
      });
      server.authService.ensureConfiguredInteractive = async () => {
        throw new Error('injected startup failure after lease acquisition');
      };
      await assert.rejects(
        () => server.start(),
        /injected startup failure after lease acquisition/u,
      );

      const afterStart = DataDirLease.acquireSync(root);
      assert.strictEqual(afterStart.releaseSync(), true);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it('holds the lease for the complete listening lifetime and releases after writer close', async function () {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cc-web-live-lease-'));
    const server = new ClaudeCodeWebServer({
      dataDir: root,
      baseFolder: root,
      host: '127.0.0.1',
      port: 0,
      desktop: { authToken: 'live-token', username: 'lease-test' },
    });
    let shutdown = false;
    try {
      await server.start();
      assert.throws(
        () => DataDirLease.acquireSync(root),
        (error) => error?.code === 'data_dir_in_use',
      );
      await server.shutdown();
      shutdown = true;
      const replacement = DataDirLease.acquireSync(root);
      assert.strictEqual(replacement.releaseSync(), true);
    } finally {
      if (!shutdown) await server.shutdown().catch(() => undefined);
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it('serializes shutdown requested while startup is suspended', async function () {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cc-web-start-shutdown-'));
    const first = new ClaudeCodeWebServer({
      dataDir: root,
      baseFolder: root,
      host: '127.0.0.1',
      port: 0,
      desktop: { authToken: 'first-token', username: 'lease-test' },
    });
    let enteredAuth;
    const authEntered = new Promise((resolve) => { enteredAuth = resolve; });
    let releaseAuth;
    const authGate = new Promise((resolve) => { releaseAuth = resolve; });
    first.authService.ensureConfiguredInteractive = async () => {
      enteredAuth();
      await authGate;
    };
    let second = null;
    try {
      const starting = first.start();
      const rejectedStart = assert.rejects(
        starting,
        (error) => error?.code === 'server_shutdown',
      );
      await authEntered;
      const shuttingDown = first.shutdown();
      releaseAuth();
      await Promise.all([rejectedStart, shuttingDown]);

      assert.strictEqual(first.localUrl, null);
      assert.strictEqual(first.listener, null);
      assert.strictEqual(first.autoSaveInterval, null);

      second = new ClaudeCodeWebServer({
        dataDir: root,
        baseFolder: root,
        host: '127.0.0.1',
        port: 0,
        desktop: { authToken: 'second-token', username: 'lease-test' },
      });
      await second.start();
      assert.match(second.localUrl, /^http:\/\/127\.0\.0\.1:\d+$/u);
      assert.strictEqual(first.localUrl, null, 'the cancelled first start must never resurrect');
      await second.shutdown();
      second = null;
    } finally {
      releaseAuth?.();
      await first.shutdown().catch(() => undefined);
      if (second) await second.shutdown().catch(() => undefined);
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});
