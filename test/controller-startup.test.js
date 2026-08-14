'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { createControllerGateway } = require('../desktop/controller/gateway.js');
const { readControllerPort } = require('../desktop/controller/endpoint.js');
const {
  recoverablePersistedBindError,
  startControllerGateway,
} = require('../desktop/controller/startup.js');

function failure(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function fakeFactory(outcomes, calls) {
  return ({ port }) => {
    const outcome = outcomes.shift();
    const gateway = {
      closed: 0,
      async listen() {
        calls.ports.push(port);
        if (outcome instanceof Error) throw outcome;
        return { host: '127.0.0.1', port: outcome, origin: `http://127.0.0.1:${outcome}` };
      },
      async close() {
        gateway.closed += 1;
        calls.closed.push(port);
      },
    };
    return gateway;
  };
}

describe('desktop controller startup', function () {
  it('classifies only unusable saved-port bind failures as recoverable', function () {
    assert.strictEqual(recoverablePersistedBindError(failure('EACCES')), true);
    assert.strictEqual(recoverablePersistedBindError(failure('EADDRINUSE')), true);
    assert.strictEqual(recoverablePersistedBindError(failure('EADDRNOTAVAIL')), false);
    assert.strictEqual(recoverablePersistedBindError(new Error('unknown')), false);
  });

  for (const code of ['EACCES', 'EADDRINUSE']) {
    it(`replaces a saved port after ${code} and closes the failed gateway`, async function () {
      const calls = { ports: [], closed: [], writes: [] };
      const started = await startControllerGateway({
        createGateway: fakeFactory([failure(code), 49123], calls),
        gatewayOptions: { marker: true },
        persistedPort: 58273,
        endpointFile: 'gateway.json',
        writePort: (file, port) => calls.writes.push([file, port]),
      });
      assert.deepStrictEqual(calls.ports, [58273, 0]);
      assert.deepStrictEqual(calls.closed, [58273]);
      assert.deepStrictEqual(calls.writes, [['gateway.json', 49123]]);
      assert.deepStrictEqual(started.recoveredFrom, { port: 58273, code });
      assert.strictEqual(started.endpoint.port, 49123);
    });
  }

  it('keeps a usable saved port and its renderer origin unchanged', async function () {
    const calls = { ports: [], closed: [], writes: [] };
    const started = await startControllerGateway({
      createGateway: fakeFactory([43127], calls),
      gatewayOptions: {},
      persistedPort: 43127,
      endpointFile: 'gateway.json',
      writePort: (file, port) => calls.writes.push([file, port]),
    });
    assert.deepStrictEqual(calls.ports, [43127]);
    assert.deepStrictEqual(calls.writes, []);
    assert.strictEqual(started.recoveredFrom, null);
  });

  it('does not retry a fresh ephemeral bind or a non-bind failure', async function () {
    for (const [port, code] of [[0, 'EACCES'], [58273, 'EADDRNOTAVAIL']]) {
      const calls = { ports: [], closed: [], writes: [] };
      await assert.rejects(startControllerGateway({
        createGateway: fakeFactory([failure(code), 49123], calls),
        gatewayOptions: {},
        persistedPort: port,
        endpointFile: 'gateway.json',
        writePort: (file, next) => calls.writes.push([file, next]),
      }), (error) => error.code === code);
      assert.deepStrictEqual(calls.ports, [port]);
      assert.deepStrictEqual(calls.closed, [port]);
      assert.deepStrictEqual(calls.writes, []);
    }
  });

  it('propagates a failed fallback and never persists it', async function () {
    const calls = { ports: [], closed: [], writes: [] };
    await assert.rejects(startControllerGateway({
      createGateway: fakeFactory([failure('EACCES'), failure('EPERM', 'fallback failed')], calls),
      gatewayOptions: {},
      persistedPort: 58273,
      endpointFile: 'gateway.json',
      writePort: (file, port) => calls.writes.push([file, port]),
    }), (error) => error.code === 'EPERM' && error.cause?.code === 'EACCES');
    assert.deepStrictEqual(calls.ports, [58273, 0]);
    assert.deepStrictEqual(calls.closed, [58273, 0]);
    assert.deepStrictEqual(calls.writes, []);
  });

  it('closes the new listener when replacement endpoint persistence fails', async function () {
    const calls = { ports: [], closed: [], writes: [] };
    await assert.rejects(startControllerGateway({
      createGateway: fakeFactory([failure('EACCES'), 49123], calls),
      gatewayOptions: {},
      persistedPort: 58273,
      endpointFile: 'gateway.json',
      writePort: () => { throw failure('EROFS', 'endpoint is read-only'); },
    }), (error) => error.code === 'EROFS');
    assert.deepStrictEqual(calls.ports, [58273, 0]);
    assert.deepStrictEqual(calls.closed, [58273, 0]);
  });

  it('falls back from a genuinely occupied port and persists the replacement atomically', async function () {
    this.timeout(10_000);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'controller-startup-'));
    const publicDir = path.join(directory, 'public');
    const endpointFile = path.join(directory, 'private', 'gateway.json');
    fs.mkdirSync(publicDir);
    fs.writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><title>Controller</title>');
    const occupied = http.createServer();
    await new Promise((resolve) => occupied.listen(0, '127.0.0.1', resolve));
    const occupiedPort = occupied.address().port;
    let started;
    try {
      started = await startControllerGateway({
        createGateway: createControllerGateway,
        gatewayOptions: {
          publicDir,
          controller: {
            listTargets: () => [],
            request: async () => ({ statusCode: 404, headers: {}, body: Buffer.alloc(0) }),
          },
        },
        persistedPort: occupiedPort,
        endpointFile,
      });
      assert.notStrictEqual(started.endpoint.port, occupiedPort);
      assert.strictEqual(started.endpoint.host, '127.0.0.1');
      assert.strictEqual(readControllerPort(endpointFile), started.endpoint.port);
      assert.deepStrictEqual(started.recoveredFrom, { port: occupiedPort, code: 'EADDRINUSE' });
      const authentication = started.gateway.authentication();
      const response = await fetch(started.endpoint.origin, {
        headers: { [authentication.header]: authentication.value, Connection: 'close' },
      });
      assert.strictEqual(response.status, 200);
      await response.arrayBuffer();

      const fallbackPort = started.endpoint.port;
      await started.gateway.close();
      started = null;
      const probe = http.createServer();
      await new Promise((resolve, reject) => {
        probe.once('error', reject);
        probe.listen(fallbackPort, '127.0.0.1', resolve);
      });
      await new Promise((resolve) => probe.close(resolve));
    } finally {
      await started?.gateway.close();
      await new Promise((resolve) => occupied.close(resolve));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
