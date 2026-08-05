const fs = require('fs');
const net = require('net');
const path = require('path');

const { DataDirLease } = require('../../dist/server/services/data-dir-lease.js');
const { ClaudeCodeWebServer } = require('../../dist/server/index.js');

function send(message) {
  if (typeof process.send === 'function') process.send(message);
}

async function hold() {
  const dataDir = process.argv[3];
  const artifact = process.argv[4];
  const heartbeatIntervalMs = Number(process.argv[5] || 2_000);
  const staleAfterMs = Number(process.argv[6] || 30_000);
  const lease = await DataDirLease.acquire(dataDir, {
    heartbeatIntervalMs,
    staleAfterMs,
  });
  const artifactFd = fs.openSync(artifact, 'a', 0o600);
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  send({ type: 'ready', port: address.port });

  const finish = async () => {
    fs.closeSync(artifactFd);
    await new Promise((resolve) => listener.close(resolve));
    const released = await lease.release();
    send({ type: 'released', released });
    process.exit(released ? 0 : 3);
  };
  process.once('message', (message) => {
    if (message === 'release') void finish();
  });
}

async function startServer() {
  const dataDir = process.argv[3];
  const baseFolder = process.argv[4];
  const port = Number(process.argv[5]);
  let server;
  try {
    server = new ClaudeCodeWebServer({
      dataDir,
      baseFolder,
      port,
      host: '127.0.0.1',
      desktop: {
        authToken: 'data-dir-lease-test-token',
        username: 'lease-test-user',
      },
    });
    await server.start();
    send({ type: 'unexpected-start' });
    await server.shutdown();
    process.exit(4);
  } catch (error) {
    send({
      type: 'start-error',
      name: error?.name,
      code: error?.code,
      message: error?.message,
    });
    process.exit(0);
  }
}

async function failAfterDatabaseOpen() {
  const dataDir = process.argv[3];
  const baseFolder = process.argv[4];
  try {
    new ClaudeCodeWebServer({
      dataDir,
      baseFolder,
    });
    send({ type: 'unexpected-construction' });
    process.exit(5);
  } catch (error) {
    send({ type: 'constructor-error', message: error?.message });
    // The constructor deliberately retained the lease because AppDatabase had
    // already opened. Stay alive so a real contender can prove it is excluded.
    setInterval(() => {}, 60_000);
  }
}

async function loseServerLease() {
  const dataDir = process.argv[3];
  const baseFolder = process.argv[4];
  new ClaudeCodeWebServer({
    dataDir,
    baseFolder,
    host: '127.0.0.1',
    port: 0,
    desktop: { authToken: 'lease-loss-token', username: 'lease-loss-user' },
  });
  const ownerPath = path.join(dataDir, '.cc-web-server.lease', 'owner.json');
  const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
  owner.token = 'e'.repeat(64);
  fs.writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  send({ type: 'lease-corrupted' });
  // The server callback must terminate this process on the next heartbeat.
  setInterval(() => {}, 60_000);
}

const mode = process.argv[2];
const task = mode === 'hold'
  ? hold()
  : mode === 'start-server'
    ? startServer()
    : mode === 'fail-after-db'
      ? failAfterDatabaseOpen()
      : mode === 'lose-server-lease'
        ? loseServerLease()
        : null;
if (!task) {
  throw new Error(`Unknown data-dir lease child mode: ${mode}`);
}
task.catch((error) => {
  send({ type: 'fatal', name: error?.name, code: error?.code, message: error?.message });
  process.exit(2);
});
