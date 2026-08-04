const assert = require('assert');
const express = require('express');
const http = require('http');

const { createConfig } = require('../dist/server/config.js');
const {
  createServerIdentity,
  registerServerIdentityRoute,
  SERVER_NAME_MAX_LENGTH,
} = require('../dist/server/services/server-identity.js');
const {
  LAN_DISCOVERY_PROBE,
  LanDiscoveryResponder,
  isLanDiscoveryProbe,
  parseLanDiscoveryResponse,
} = require('../dist/server/services/lan-discovery.js');

describe('server identity and LAN discovery', function() {
  const identity = createServerIdentity({
    serverName: 'Studio server',
    address: 'https://agents.example.test',
    version: '6.1.0',
  });

  it('serves only the small unauthenticated compatibility identity contract', async function() {
    const app = express();
    registerServerIdentityRoute(app, identity);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/identity`);
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.headers.get('cache-control'), 'no-store');
      const body = await response.json();
      assert.deepStrictEqual(body, {
        product: { id: 'code-agents-webcli', name: 'CODE AGENTS' },
        version: '6.1.0',
        protocolVersion: 1,
        capabilities: ['remote-controller', 'lan-discovery'],
        serverName: 'Studio server',
        address: 'https://agents.example.test',
      });
      for (const forbidden of ['user', 'users', 'session', 'credential', 'token', 'email']) {
        assert.ok(!JSON.stringify(body).toLowerCase().includes(forbidden), `${forbidden} leaked from identity`);
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('reads explicit operator configuration and keeps LAN discovery disabled by default', function() {
    const envKeys = [
      'CODE_AGENTS_WEBCLI_LAN_DISCOVERABLE',
      'CODE_AGENTS_WEBCLI_SERVER_NAME',
      'CODE_AGENTS_WEBCLI_PUBLIC_DISCOVERABLE_URL',
    ];
    const old = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    for (const key of envKeys) delete process.env[key];
    try {
      assert.strictEqual(createConfig({}).lanDiscoverable, false);
      assert.throws(
        () => createConfig({ lanDiscoverable: true }),
        /LAN discovery requires --public-discoverable-url/,
      );
      assert.strictEqual(
        createConfig({ lanDiscoverable: true, publicDiscoverableUrl: 'https://agents.example.test' }).lanDiscoverable,
        true,
      );
      assert.strictEqual(createConfig({ publicDiscoverableUrl: 'https://agents.example.test/' }).publicDiscoverableUrl, 'https://agents.example.test');
      process.env.CODE_AGENTS_WEBCLI_SERVER_NAME = 'Office server';
      process.env.CODE_AGENTS_WEBCLI_PUBLIC_DISCOVERABLE_URL = 'https://office.example.test/';
      process.env.CODE_AGENTS_WEBCLI_LAN_DISCOVERABLE = 'true';
      const configured = createConfig({});
      assert.strictEqual(configured.serverName, 'Office server');
      assert.strictEqual(configured.publicDiscoverableUrl, 'https://office.example.test');
      assert.strictEqual(configured.lanDiscoverable, true);
      assert.throws(
        () => createConfig({ publicDiscoverableUrl: 'http://agents.example.test' }),
        /HTTPS origin/,
      );
    } finally {
      for (const key of envKeys) {
        if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key];
      }
    }
  });

  it('normalizes public names and bounds their UDP footprint', function() {
    assert.strictEqual(createConfig({ serverName: '  Studio\nserver  ' }).serverName, 'Studioserver');
    assert.throws(() => createConfig({ serverName: ' \u0000\n\t ' }), /visible character/);
    const capped = createConfig({ serverName: 'x'.repeat(SERVER_NAME_MAX_LENGTH + 50) }).serverName;
    assert.strictEqual(capped.length, SERVER_NAME_MAX_LENGTH);
  });

  it('only responds to the exact discovery probe and emits a validated identity response', function() {
    const listeners = new Map();
    const sent = [];
    const socket = {
      bind() {}, close() {},
      on(event, listener) { listeners.set(event, listener); return this; },
      send(message, port, address) { sent.push({ message, port, address }); },
    };
    const responder = new LanDiscoveryResponder({
      enabled: true,
      identity,
      createSocket: () => socket,
      port: 0,
      bindAddress: '127.0.0.1',
    });
    responder.start();
    assert.strictEqual(responder.started, true);
    assert.strictEqual(isLanDiscoveryProbe(Buffer.from(`${LAN_DISCOVERY_PROBE}\n`)), false);
    listeners.get('message')(Buffer.from('unrelated'), { address: '192.0.2.9', port: 4444 });
    assert.deepStrictEqual(sent, []);
    listeners.get('message')(Buffer.from(LAN_DISCOVERY_PROBE), { address: '192.0.2.9', port: 4444 });
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].address, '192.0.2.9');
    assert.strictEqual(sent[0].port, 4444);
    assert.deepStrictEqual(parseLanDiscoveryResponse(Buffer.from(sent[0].message)), identity);
    assert.strictEqual(parseLanDiscoveryResponse(Buffer.from('{"type":"CODE_AGENTS_IDENTITY/1","identity":{}}')), null);
    responder.stop();
    assert.strictEqual(responder.started, false);
  });

  it('does not create a UDP socket while discovery is disabled', function() {
    let created = false;
    const responder = new LanDiscoveryResponder({
      enabled: false,
      identity,
      createSocket: () => { created = true; throw new Error('must not create socket'); },
    });
    responder.start();
    assert.strictEqual(created, false);
    assert.strictEqual(responder.started, false);
  });
});
