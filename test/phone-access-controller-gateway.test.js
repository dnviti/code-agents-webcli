'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CONTROLLER_AUTH_HEADER,
  createControllerGateway,
} = require('../desktop/controller-gateway.js');

describe('desktop phone-access controller seam', function () {
  let directory;
  let gateway;
  let origin;
  let capability;

  beforeEach(function () {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-controller-'));
    fs.writeFileSync(path.join(directory, 'index.html'), '<!doctype html><title>Controller</title>');
  });

  afterEach(async function () {
    if (gateway) await gateway.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  async function start(phoneAccess) {
    gateway = createControllerGateway({
      publicDir: directory,
      controller: {
        listTargets: () => [],
        request: () => { throw new Error('phone management must not proxy through a target'); },
        action: () => { throw new Error('phone management must not use catalog actions'); },
      },
      phoneAccess,
    });
    ({ origin } = await gateway.listen());
    capability = gateway.authentication().value;
  }

  function request(url, init = {}) {
    return fetch(`${origin}${url}`, {
      ...init,
      headers: {
        [CONTROLLER_AUTH_HEADER]: capability,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers || {}),
      },
    });
  }

  it('keeps management behind the Electron capability and dispatches every operation', async function () {
    const calls = [];
    const phoneAccess = {
      status: async () => ({ state: 'off' }),
      exportCa: async () => { calls.push(['export-ca']); return Buffer.from('test-ca'); },
      start: async (value) => { calls.push(['start', value]); return { state: 'running' }; },
      createPairing: async (value) => { calls.push(['pair', value]); return { pairing: { url: 'https://lan/auth/pair#token=secret' } }; },
      revoke: async (id) => { calls.push(['revoke', id]); return { revoked: true }; },
      stop: async () => { calls.push(['stop']); return { state: 'off' }; },
      checkTailscale: async () => { calls.push(['check']); return { installed: true }; },
      setTailscaleOrigin: async (value) => { calls.push(['origin', value]); return { origin: value }; },
    };
    await start(phoneAccess);

    assert.strictEqual((await fetch(`${origin}/api/controller/phone-access`)).status, 401);
    assert.deepStrictEqual(await (await request('/api/controller/phone-access')).json(), { state: 'off' });
    const exported = await request('/api/controller/phone-access/ca');
    assert.strictEqual(exported.status, 200);
    assert.strictEqual(exported.headers.get('content-type'), 'application/x-x509-ca-cert');
    assert.strictEqual(await exported.text(), 'test-ca');
    assert.strictEqual((await request('/api/controller/phone-access/start', {
      method: 'POST', body: JSON.stringify({ mode: 'both', address: '192.168.1.20', port: 32354 }),
    })).status, 200);
    await request('/api/controller/phone-access/pairing', {
      method: 'POST', body: JSON.stringify({ origin: 'https://192.168.1.20:32354' }),
    });
    await request('/api/controller/phone-access/devices/device%2Fone', { method: 'DELETE' });
    assert.strictEqual((await request('/api/controller/phone-access/devices/%E0%A4%A', {
      method: 'DELETE',
    })).status, 400);
    await request('/api/controller/phone-access/tailscale/check', { method: 'POST', body: '{}' });
    await request('/api/controller/phone-access/tailscale-origin', {
      method: 'POST', body: JSON.stringify({ origin: 'https://host.tailnet.ts.net' }),
    });
    await request('/api/controller/phone-access', { method: 'DELETE' });

    assert.deepStrictEqual(calls, [
      ['export-ca'],
      ['start', { mode: 'both', address: '192.168.1.20', port: 32354 }],
      ['pair', { origin: 'https://192.168.1.20:32354' }],
      ['revoke', 'device/one'],
      ['check'],
      ['origin', 'https://host.tailnet.ts.net'],
      ['stop'],
    ]);
  });

  it('reports builds without the main-owned service instead of falling through to catalog actions', async function () {
    await start(null);
    const response = await request('/api/controller/phone-access');
    assert.strictEqual(response.status, 501);
    assert.deepStrictEqual(await response.json(), {
      error: 'phone_access_unavailable',
      message: 'Phone access is unavailable in this desktop build.',
    });
  });
});
