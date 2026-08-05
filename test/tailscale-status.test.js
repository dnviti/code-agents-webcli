'use strict';

const assert = require('node:assert');

const {
  MAX_TAILSCALE_BYTES,
  MAX_TAILSCALE_TIMEOUT_MS,
  inspectTailscale,
} = require('../desktop/tailscale-status.js');

function runner(responses, calls = []) {
  return {
    calls,
    execFileImpl(file, args, options, callback) {
      calls.push({ file, args, options });
      const response = responses.shift();
      callback(response.error || null, response.stdout || '', response.stderr || '');
    },
  };
}

describe('desktop Tailscale status', function () {
  it('reports exact Serve and Funnel state from fixed read-only commands', async function () {
    const fake = runner([
      { stdout: JSON.stringify({
        BackendState: 'Running',
        Self: { Online: true, DNSName: 'Laptop.My-Tailnet.TS.NET.' },
      }) },
      { stdout: JSON.stringify({
        Web: { 'laptop.my-tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1' } } } },
        AllowFunnel: { 'laptop.my-tailnet.ts.net:443': true },
      }) },
    ]);

    assert.deepStrictEqual(await inspectTailscale({ execFileImpl: fake.execFileImpl }), {
      installed: true,
      online: true,
      serve: true,
      funnel: true,
      origin: 'https://laptop.my-tailnet.ts.net',
    });
    assert.deepStrictEqual(fake.calls.map(({ file, args }) => [file, args]), [
      ['tailscale', ['status', '--json']],
      ['tailscale', ['serve', 'status', '--json']],
    ]);
    assert.ok(fake.calls.every(({ options }) => options.shell === false));
  });

  it('distinguishes an absent binary from an installed offline daemon', async function () {
    const absent = runner([{ error: Object.assign(new Error('secret path'), { code: 'ENOENT' }) }]);
    assert.deepStrictEqual(await inspectTailscale({ execFileImpl: absent.execFileImpl }), {
      installed: false, online: false, serve: false, funnel: false, origin: null,
      message: 'Tailscale is not installed.',
    });

    const offline = runner([{ stdout: JSON.stringify({
      BackendState: 'Stopped', Self: { Online: false, DNSName: 'host.tail.ts.net.' },
    }) }]);
    const result = await inspectTailscale({ execFileImpl: offline.execFileImpl });
    assert.strictEqual(result.installed, true);
    assert.strictEqual(result.online, false);
    assert.strictEqual(offline.calls.length, 1, 'offline inspection does not probe Serve');
  });

  it('uses only a valid Self DNS name and exact matching Serve entry', async function () {
    const fake = runner([
      { stdout: JSON.stringify({
        BackendState: 'Running', Self: { Online: true, DNSName: 'safe.tail.ts.net.' },
      }) },
      { stdout: JSON.stringify({
        Web: { 'other.tail.ts.net:443': { Handlers: { '/': {} } } },
        AllowFunnel: { 'other.tail.ts.net:443': true },
      }) },
    ]);
    const result = await inspectTailscale({ execFileImpl: fake.execFileImpl });
    assert.strictEqual(result.origin, 'https://safe.tail.ts.net');
    assert.strictEqual(result.serve, false);
    assert.strictEqual(result.funnel, false);

    const invalid = runner([{ stdout: JSON.stringify({
      BackendState: 'Running', Self: { Online: true, DNSName: 'example.com/path?secret' },
    }) }]);
    const invalidResult = await inspectTailscale({ execFileImpl: invalid.execFileImpl });
    assert.strictEqual(invalidResult.origin, null);
    assert.doesNotMatch(invalidResult.message, /example|secret/);
  });

  it('checks that Serve targets the exact selected loopback backend port', async function () {
    const status = {
      BackendState: 'Running', Self: { Online: true, DNSName: 'desk.tail.ts.net.' },
    };
    const wrong = runner([
      { stdout: JSON.stringify(status) },
      { stdout: JSON.stringify({
        Web: { 'desk.tail.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } },
      }) },
    ]);
    const wrongResult = await inspectTailscale({ execFileImpl: wrong.execFileImpl, port: 32354 });
    assert.strictEqual(wrongResult.serve, false);
    assert.match(wrongResult.message, /127\.0\.0\.1:32354/);

    const exact = runner([
      { stdout: JSON.stringify(status) },
      { stdout: JSON.stringify({
        Web: { 'desk.tail.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:32354/' } } } },
      }) },
    ]);
    const exactResult = await inspectTailscale({ execFileImpl: exact.execFileImpl, port: 32354 });
    assert.strictEqual(exactResult.serve, true);
    assert.strictEqual(exactResult.message, undefined);

    for (const handlers of [
      { '/phone': { Proxy: 'http://127.0.0.1:32354/' } },
      { '/': { Proxy: 'http://127.0.0.1:32354/prefix' } },
    ]) {
      const partial = runner([
        { stdout: JSON.stringify(status) },
        { stdout: JSON.stringify({ Web: { 'desk.tail.ts.net:443': { Handlers: handlers } } }) },
      ]);
      assert.strictEqual((await inspectTailscale({ execFileImpl: partial.execFileImpl, port: 32354 })).serve, false);
    }
  });

  it('detects foreground Serve and Funnel configurations', async function () {
    const status = {
      BackendState: 'Running', Self: { Online: true, DNSName: 'desk.tail.ts.net.' },
    };
    const foregroundServe = runner([
      { stdout: JSON.stringify(status) },
      { stdout: JSON.stringify({
        Foreground: {
          'session-1': {
            Web: { 'desk.tail.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:32354/' } } } },
          },
        },
      }) },
    ]);
    const foregroundResult = await inspectTailscale({
      execFileImpl: foregroundServe.execFileImpl,
      port: 32354,
    });
    assert.strictEqual(foregroundResult.serve, true);
    assert.strictEqual(foregroundResult.funnel, false);

    const mixed = runner([
      { stdout: JSON.stringify(status) },
      { stdout: JSON.stringify({
        Web: { 'desk.tail.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:32354/' } } } },
        Foreground: {
          'session-2': { AllowFunnel: { 'desk.tail.ts.net:443': true } },
        },
      }) },
    ]);
    const mixedResult = await inspectTailscale({ execFileImpl: mixed.execFileImpl, port: 32354 });
    assert.strictEqual(mixedResult.serve, true);
    assert.strictEqual(mixedResult.funnel, true);
  });

  it('bounds runner time and output options', async function () {
    const fake = runner([{ stdout: JSON.stringify({ BackendState: 'Stopped' }) }]);
    await inspectTailscale({
      execFileImpl: fake.execFileImpl,
      timeoutMs: Number.MAX_SAFE_INTEGER,
      maxBytes: Number.MAX_SAFE_INTEGER,
    });
    assert.strictEqual(fake.calls[0].options.timeout, MAX_TAILSCALE_TIMEOUT_MS);
    assert.strictEqual(fake.calls[0].options.maxBuffer, MAX_TAILSCALE_BYTES);
  });
});
