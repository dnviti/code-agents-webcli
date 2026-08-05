'use strict';

const assert = require('node:assert');

const {
  PhoneAccessService,
  listNetworkInterfaces,
  safeTailscaleStatus,
} = require('../desktop/phone-access-service.js');

function controller() {
  return {
    listTargets: () => [{ id: 'local', name: 'Local computer', status: 'ready', secret: 'never publish' }],
    request: async () => { throw new Error('not used'); },
    connectWebSocket: async () => { throw new Error('not used'); },
  };
}

class FakeGateway {
  constructor(options = {}) {
    this.options = options;
    this.stopped = 0;
    this.revoked = [];
    this.rows = [];
  }
  async start(config) {
    this.config = config;
    if (this.options.startError) throw this.options.startError;
    return {
      mode: config.mode,
      port: config.port || 43123,
      origins: {
        ...(config.mode === 'lan' || config.mode === 'both' ? { lan: `https://${config.address}:${config.port || 43123}` } : {}),
        ...((config.mode === 'tailscale' || config.mode === 'both') && config.tailscaleOrigin
          ? { tailscale: config.tailscaleOrigin } : {}),
      },
    };
  }
  async stop() { this.stopped += 1; }
  createPairing(origin) {
    const selected = origin || (this.config.mode === 'lan' ? `https://${this.config.address}:${this.config.port || 43123}` : this.config.tailscaleOrigin);
    return { url: `${selected}/auth/pair#token=capability`, origin: selected, expiresAt: '2030-01-01T00:00:00.000Z' };
  }
  setTailscaleOrigin(origin) {
    this.config.tailscaleOrigin = origin;
    return {
      mode: this.config.mode,
      port: this.config.port || 43123,
      origins: {
        ...(this.config.mode === 'both' ? { lan: `https://${this.config.address}:${this.config.port || 43123}` } : {}),
        tailscale: origin,
      },
    };
  }
  revoke(id) { this.revoked.push(id); this.rows = this.rows.filter((row) => row.id !== id); return true; }
  devices() { return this.rows.map((row) => ({ ...row })); }
}

describe('desktop phone access service', function () {
  const network = () => ({
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    wifi: [{ address: '192.168.50.20', family: 'IPv4', internal: false }],
    vpn: [{ address: '10.9.0.2', family: 4, internal: false }],
  });

  it('reports unavailable until local work is ready, then owns the full LAN lifecycle', async function () {
    let gateway;
    const service = new PhoneAccessService({
      controller: controller(),
      network,
      now: () => Date.parse('2029-01-01T00:00:00.000Z'),
      certificate: async ({ hosts }) => ({
        key: Buffer.from(`key:${hosts[0]}`),
        cert: Buffer.from(`cert:${hosts[0]}`),
        ca: Buffer.from('ca'),
        fingerprint: 'AA:BB:CC',
      }),
      gatewayFactory: (options) => { gateway = new FakeGateway(); gateway.factoryOptions = options; return gateway; },
    });
    assert.deepStrictEqual(service.status(), {
      state: 'unavailable', available: false,
      interfaces: [
        { name: 'vpn', address: '10.9.0.2', family: 'IPv4' },
        { name: 'wifi', address: '192.168.50.20', family: 'IPv4' },
      ],
      origins: {}, devices: [], error: 'The local server is unavailable.',
    });
    await assert.rejects(() => service.start({ mode: 'lan', address: '192.168.50.20', port: 43123 }), /unavailable/);
    await service.setLocalAvailable(true);
    const running = await service.start({ mode: 'lan', address: '192.168.50.20', port: 43123 });
    assert.strictEqual(running.state, 'running');
    assert.strictEqual(running.available, true);
    assert.strictEqual(running.port, 43123);
    assert.deepStrictEqual(running.origins, { lan: 'https://192.168.50.20:43123' });
    assert.deepStrictEqual(running.ca, {
      downloadUrl: 'https://192.168.50.20:43123/ca.crt', fingerprint: 'AA:BB:CC',
    });
    assert.strictEqual(service.exportCa().toString(), 'ca');
    assert.strictEqual(gateway.config.tls.key.toString(), 'key:192.168.50.20');
    assert.strictEqual(gateway.factoryOptions.controller.listTargets()[0].secret, 'never publish');
    assert.strictEqual(JSON.stringify(running).includes('never publish'), false);

    const paired = service.createPairing();
    assert.match(paired.pairing.url, /#token=capability$/);
    gateway.rows.push({ id: 'device-1', label: 'Phone', origin: running.origins.lan, lastSeen: '2029-01-01' });
    assert.strictEqual(service.status().devices.length, 1);
    assert.strictEqual(service.revoke('device-1').devices.length, 0);
    assert.deepStrictEqual(gateway.revoked, ['device-1']);

    const stopped = await service.stop();
    assert.strictEqual(stopped.state, 'off');
    assert.deepStrictEqual(stopped.origins, {});
    assert.strictEqual(stopped.pairing, undefined);
    assert.strictEqual(gateway.stopped, 1);
    assert.throws(() => service.exportCa(), /unavailable/);
    await service.close();
    assert.strictEqual(service.status().available, false);
  });

  it('starts a loopback Tailscale backend first, then adopts an exact confirmed origin live', async function () {
    let gateway;
    const calls = [];
    let detectedOrigin = 'https://phone.devnet.ts.net';
    const tailscale = {
      async check(context) {
        calls.push(context);
        return { installed: true, online: true, serve: true, funnel: false, origin: detectedOrigin, extraSecret: 'remove' };
      },
    };
    const service = new PhoneAccessService({
      controller: controller(), localAvailable: true, network, tailscale,
      gatewayFactory: () => { gateway = new FakeGateway(); return gateway; },
    });
    const backend = await service.start({ mode: 'tailscale' });
    assert.strictEqual(backend.port, 32354);
    assert.deepStrictEqual(backend.origins, {});
    assert.strictEqual(gateway.config.tls, undefined);
    const running = await service.setTailscaleOrigin('HTTPS://Phone.Devnet.TS.NET:443/');
    assert.strictEqual(running.origins.tailscale, 'https://phone.devnet.ts.net');
    assert.strictEqual(running.pairing.origin, 'https://phone.devnet.ts.net');
    const checked = await service.checkTailscale();
    assert.deepStrictEqual(checked.tailscale, {
      installed: true, online: true, serve: true, funnel: false, origin: 'https://phone.devnet.ts.net',
    });
    await assert.rejects(() => service.setTailscaleOrigin('https://new.example'), /ts\.net/);
    detectedOrigin = 'https://new.devnet.ts.net';
    const replaced = await service.setTailscaleOrigin('https://new.devnet.ts.net');
    assert.strictEqual(replaced.origins.tailscale, 'https://new.devnet.ts.net');
    await service.stop();
    assert.deepStrictEqual(calls, [{ port: 32354 }, { port: 32354 }, { port: 32354 }]);
  });

  it('cancels a listener that finishes binding after Local computer becomes unavailable', async function () {
    let releaseStart;
    let announceStart;
    const startReleased = new Promise((resolve) => { releaseStart = resolve; });
    const startEntered = new Promise((resolve) => { announceStart = resolve; });
    let gateway;
    class DeferredGateway extends FakeGateway {
      async start(config) {
        this.config = config;
        announceStart();
        await startReleased;
        return { mode: config.mode, port: config.port, origins: {} };
      }
    }
    const service = new PhoneAccessService({
      controller: controller(), localAvailable: true, network,
      gatewayFactory: () => { gateway = new DeferredGateway(); return gateway; },
    });
    const starting = service.start({ mode: 'tailscale', port: 43123 });
    await startEntered;
    const unavailable = service.setLocalAvailable(false, 'Local computer stopped.');
    releaseStart();
    await assert.rejects(() => starting, /Local computer stopped/);
    await unavailable;
    assert.strictEqual(gateway.stopped, 1);
    assert.deepStrictEqual(service.status().origins, {});
    assert.strictEqual(service.status().pairing, undefined);
    assert.strictEqual(service.status().state, 'unavailable');
  });

  it('rolls the gateway back if listener startup fails', async function () {
    let gateway;
    const failure = new Error('tailscale serve refused the backend');
    const service = new PhoneAccessService({
      controller: controller(), localAvailable: true, network,
      gatewayFactory: () => { gateway = new FakeGateway({ startError: failure }); return gateway; },
    });
    await assert.rejects(() => service.start({ mode: 'tailscale', port: 43123 }), failure);
    assert.strictEqual(gateway.stopped, 1);
    const status = service.status();
    assert.strictEqual(status.state, 'error');
    assert.strictEqual(status.error, failure.message);
    assert.deepStrictEqual(status.origins, {});
  });

  it('stops access and invalidates the pairing when the selected LAN interface disappears', async function () {
    let current = network();
    let poll;
    let gateway;
    const service = new PhoneAccessService({
      controller: controller(), localAvailable: true,
      network: () => current,
      certificate: async () => ({ key: Buffer.from('key'), cert: Buffer.from('cert') }),
      gatewayFactory: () => { gateway = new FakeGateway(); return gateway; },
      setIntervalImpl: (callback) => { poll = callback; return { unref() {} }; },
      clearIntervalImpl: () => {},
    });
    const running = await service.start({ mode: 'lan', address: '192.168.50.20', port: 43123 });
    assert.strictEqual(running.pairing.origin, 'https://192.168.50.20:43123');
    current = { lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] };
    poll();
    await service.transition;
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(gateway.stopped, 1);
    assert.strictEqual(service.status().state, 'error');
    assert.match(service.status().error, /no longer assigned/);
    assert.strictEqual(service.status().pairing, undefined);
  });

  it('surfaces and refuses a detected Tailscale Funnel exposure', async function () {
    const service = new PhoneAccessService({
      controller: controller(), localAvailable: true, network,
      tailscale: { check: async () => ({ installed: true, online: true, serve: true, funnel: true, origin: 'https://phone.devnet.ts.net' }) },
      gatewayFactory: () => new FakeGateway(),
    });
    await service.start({ mode: 'tailscale' });
    const checked = await service.checkTailscale();
    assert.strictEqual(checked.tailscale.funnel, true);
    assert.match(checked.tailscale.message, /Disable Funnel/);
    await assert.rejects(() => service.setTailscaleOrigin('https://phone.devnet.ts.net'), /Disable Tailscale Funnel/);
    await service.stop();
  });

  it('requires each confirmation to match a fresh clean Tailscale inspection', async function () {
    let result = { installed: true, online: true, serve: true, funnel: false, origin: 'https://phone.devnet.ts.net' };
    const service = new PhoneAccessService({
      controller: controller(), localAvailable: true, network,
      tailscale: { check: async () => result }, gatewayFactory: () => new FakeGateway(),
    });
    await service.start({ mode: 'tailscale', port: 43123 });
    await service.checkTailscale();

    result = { ...result, funnel: true };
    await assert.rejects(() => service.setTailscaleOrigin('https://phone.devnet.ts.net'), /Disable Tailscale Funnel/);
    result = { ...result, funnel: false, online: false };
    await assert.rejects(() => service.setTailscaleOrigin('https://phone.devnet.ts.net'), /Connect this computer/);
    result = { ...result, online: true, serve: false };
    await assert.rejects(() => service.setTailscaleOrigin('https://phone.devnet.ts.net'), /127\.0\.0\.1:43123/);
    result = { ...result, serve: true, origin: 'https://other.devnet.ts.net' };
    await assert.rejects(() => service.setTailscaleOrigin('https://phone.devnet.ts.net'), /does not match/);
    assert.deepStrictEqual(service.status().origins, {});
    assert.strictEqual(service.status().pairing, undefined);
    await service.stop();
  });

  it('normalizes helper output into JSON-safe interface and Tailscale records', function () {
    assert.deepStrictEqual(listNetworkInterfaces(network), [
      { name: 'vpn', address: '10.9.0.2', family: 'IPv4' },
      { name: 'wifi', address: '192.168.50.20', family: 'IPv4' },
    ]);
    assert.deepStrictEqual(safeTailscaleStatus({
      installed: true, online: 1, serve: true, funnel: false,
      origin: 'https://phone.example/path', message: 'ok', secret: 'remove',
    }), {
      installed: true, online: false, serve: true, funnel: false, message: 'ok',
    });
  });
});
