'use strict';

const assert = require('node:assert');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const WebSocket = require('ws');

const {
  MAX_PROXY_BODY,
  MAX_ROUTING_BODY,
  SESSION_COOKIE,
  boundedBody,
  createPhoneAccessGateway,
  isAttachmentUpload,
  isControllerPath,
  isSafeImmutableAssetPath,
  proxyRequestHeaders,
  proxyResponseHeaders,
  safeRedirect,
} = require('../desktop/phone-access-gateway.js');

function response(statusCode, headers, body) {
  const stream = new PassThrough();
  stream.statusCode = statusCode;
  stream.headers = headers;
  queueMicrotask(() => stream.end(body));
  return stream;
}

function request(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path,
      method: options.method || 'GET',
      headers: {
        Host: 'phone.example',
        ...(options.origin === false ? {} : { Origin: 'https://phone.example' }),
        ...(options.headers || {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.once('error', reject);
    req.end(options.body);
  });
}

function rejectedUpgrade(port, path, headers) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    let settled = false;
    socket.once('unexpected-response', (_request, response) => {
      settled = true;
      response.resume();
      resolve(response.statusCode);
    });
    socket.once('open', () => reject(new Error('The forbidden WebSocket unexpectedly opened')));
    socket.once('error', (error) => { if (!settled) reject(error); });
  });
}

describe('desktop phone access gateway', function () {
  it('has no listener by default, issues one-use fragment pairings, and proxies only through local', async function () {
    const calls = [];
    const controller = {
      listTargets: () => [{ id: 'local', status: 'ready' }],
      async request(serverId, options) {
        calls.push({ serverId, options });
        return response(200, {
          'content-type': 'application/json',
          'set-cookie': 'desktop_secret=must-not-escape',
          'x-controller-server-id': 'desktop-secret-id',
        }, JSON.stringify({ ok: true }));
      },
    };
    const gateway = createPhoneAccessGateway({ controller, allowEphemeralPort: true });
    assert.strictEqual(gateway.address(), null);
    const bound = await gateway.start({
      mode: 'tailscale', port: 0, tailscaleOrigin: 'https://phone.example',
    });
    try {
      assert.ok(bound.port > 0);
      assert.deepStrictEqual(bound.origins, { tailscale: 'https://phone.example' });
      const pairing = gateway.createPairing();
      assert.match(pairing.url, /^https:\/\/phone\.example\/auth\/pair#token=[A-Za-z0-9_-]{43}$/);
      assert.ok(Date.parse(pairing.expiresAt) > Date.now());

      const bootstrap = await request(bound.port, '/auth/pair', { origin: false });
      assert.strictEqual(bootstrap.statusCode, 200);
      assert.match(bootstrap.headers['content-security-policy'], /default-src 'none'/);
      assert.match(bootstrap.body, /history\.replaceState\([^)]*\/auth\/pair/);
      assert.ok(!bootstrap.body.includes(pairing.url.split('#token=')[1]), 'the server response never receives the fragment token');

      const publicAsset = await request(bound.port, '/app.bundle.js', { origin: false });
      assert.strictEqual(publicAsset.statusCode, 200);
      assert.deepStrictEqual(JSON.parse(publicAsset.body), { ok: true });

      const token = new URL(pairing.url).hash.slice('#token='.length);
      const paired = await request(bound.port, '/auth/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, label: 'Test phone' }),
      });
      assert.strictEqual(paired.statusCode, 200);
      const cookie = paired.headers['set-cookie'][0];
      assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43}; Path=/; Secure; HttpOnly; SameSite=Strict`));

      const reused = await request(bound.port, '/auth/pair', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      assert.strictEqual(reused.statusCode, 401);

      const authenticated = await request(bound.port, '/api/config', {
        headers: {
          Cookie: cookie.split(';', 1)[0],
          Authorization: 'Bearer browser-secret',
          'X-Forwarded-For': '198.51.100.7',
          'X-Tailscale-User-Login': 'someone@example.com',
          'Sec-Fetch-Site': 'same-origin',
        },
      });
      assert.strictEqual(authenticated.statusCode, 200);
      assert.strictEqual(authenticated.headers['set-cookie'], undefined);
      assert.strictEqual(authenticated.headers['x-controller-server-id'], undefined);
      assert.strictEqual(calls.length, 2);
      assert.strictEqual(calls[1].serverId, 'local');
      assert.strictEqual(calls[1].options.headers.authorization, undefined);
      assert.strictEqual(calls[1].options.headers.cookie, undefined);
      assert.strictEqual(calls[1].options.headers['x-forwarded-for'], undefined);
      assert.strictEqual(calls[1].options.headers['x-tailscale-user-login'], undefined);
      assert.strictEqual(calls[1].options.headers.origin, 'https://phone-access.invalid');

      const controllerDenied = await request(bound.port, '/api/controller/bootstrap', {
        headers: { Cookie: cookie.split(';', 1)[0], 'Sec-Fetch-Site': 'same-origin' },
      });
      assert.strictEqual(controllerDenied.statusCode, 404);
      assert.strictEqual(calls.length, 2, 'controller-management HTTP never reaches the local transport');
      assert.strictEqual(await rejectedUpgrade(bound.port, '/api/controller', {
        Host: 'phone.example', Origin: 'https://phone.example',
        Cookie: cookie.split(';', 1)[0], 'Sec-Fetch-Site': 'same-origin',
      }), 403);

      const denied = await request(bound.port, '/', { headers: { Host: 'attacker.example' } });
      assert.strictEqual(denied.statusCode, 403);
      const crossSite = await request(bound.port, '/', { headers: { 'Sec-Fetch-Site': 'same-site' } });
      assert.strictEqual(crossSite.statusCode, 403);
    } finally {
      await gateway.stop();
    }
    assert.strictEqual(gateway.address(), null);
  });

  it('keeps only explicitly safe asset paths and response redirects', function () {
    assert.strictEqual(isControllerPath('/api/controller'), true);
    assert.strictEqual(isControllerPath('/api/controller/phone-access'), true);
    assert.strictEqual(isControllerPath('/api/controllers'), false);
    assert.strictEqual(isSafeImmutableAssetPath('/app.bundle.js'), true);
    assert.strictEqual(isSafeImmutableAssetPath('/css/main.css'), true);
    assert.strictEqual(isSafeImmutableAssetPath('/icons/icon-192.png'), true);
    for (const path of ['/', '/index.html', '/service-worker.js', '/css/../index.html', '/icons/%2e%2e/secret']) {
      assert.strictEqual(isSafeImmutableAssetPath(path), false, path);
    }
    assert.strictEqual(safeRedirect('/sessions?id=1'), '/sessions?id=1');
    assert.strictEqual(safeRedirect('//attacker.example'), null);
    assert.strictEqual(safeRedirect('https://attacker.example'), null);
    assert.throws(() => proxyResponseHeaders({ location: 'https://attacker.example', 'set-cookie': 'secret=1' }), /unsafe redirect/);
    assert.deepStrictEqual(proxyResponseHeaders({
      location: '/safe', 'set-cookie': 'secret=1', Connection: 'X-Hop', 'X-Hop': 'secret',
    }), { location: '/safe' });
  });

  it('strips connection-nominated and identity headers without consuming range metadata', function () {
    assert.deepStrictEqual(proxyRequestHeaders({
      connection: 'keep-alive, x-private',
      'x-private': 'remove',
      cookie: 'remove', authorization: 'remove',
      forwarded: 'remove', via: 'remove',
      'x-code-agents-controller-auth': 'remove',
      'x-controller-server-id': 'remove',
      'tailscale-user-login': 'remove',
      'x-tailscale-user-name': 'remove',
      'sec-fetch-site': 'same-origin',
      range: 'bytes=10-20', accept: 'application/octet-stream',
    }), {
      range: 'bytes=10-20',
      accept: 'application/octet-stream',
      origin: 'https://phone-access.invalid',
    });
  });

  it('keeps ordinary routing bodies at 1 MiB and reserves 20 MiB for exact attachment uploads', function () {
    const ordinary = new PassThrough();
    ordinary.headers = { 'content-length': String(MAX_ROUTING_BODY + 1) };
    assert.throws(() => boundedBody(ordinary, MAX_ROUTING_BODY), (error) => error.statusCode === 413);
    assert.strictEqual(isAttachmentUpload('POST', '/api/sessions/local-id/chat-attachments'), true);
    assert.strictEqual(isAttachmentUpload('PUT', '/api/sessions/local-id/chat-attachments'), false);
    assert.strictEqual(isAttachmentUpload('POST', '/api/sessions/local-id/chat-attachments/extra'), false);
    const attachment = new PassThrough();
    attachment.headers = { 'content-length': String(MAX_ROUTING_BODY + 1) };
    const stream = boundedBody(attachment, MAX_PROXY_BODY);
    stream.destroy();
    attachment.destroy();
  });

  it('rolls back every bound listener when a multi-ingress start fails', async function () {
    class FakeServer extends EventEmitter {
      constructor(fail) { super(); this.fail = fail; this.listening = false; this.closed = false; }
      listen(options) {
        queueMicrotask(() => {
          if (this.fail) { this.emit('error', Object.assign(new Error('occupied'), { code: 'EADDRINUSE' })); return; }
          this.listening = true;
          this.bound = { address: options.host, family: 'IPv4', port: 43210 };
          this.emit('listening');
        });
      }
      address() { return this.bound; }
      close(callback) { this.closed = true; this.listening = false; queueMicrotask(callback); }
    }
    const first = new FakeServer(false);
    const second = new FakeServer(true);
    const gateway = createPhoneAccessGateway({
      controller: { listTargets: () => [], request: async () => response(200, {}, '') },
      createHttpsServer: () => first,
      createHttpServer: () => second,
      createWebSocketServer: () => ({ close() {}, handleUpgrade() {} }),
      allowEphemeralPort: true,
    });
    await assert.rejects(() => gateway.start({
      mode: 'both', address: '192.168.2.20', port: 0,
      tailscaleOrigin: 'https://phone.example', tls: { key: 'key', cert: 'cert' },
    }), (error) => error.code === 'EADDRINUSE');
    assert.strictEqual(first.closed, true);
    assert.strictEqual(gateway.address(), null);
  });

  it('keeps a Tailscale backend dark until an exact origin is confirmed and replaces it synchronously', async function () {
    const gateway = createPhoneAccessGateway({
      controller: { listTargets: () => [], request: async () => response(200, {}, '') },
      allowEphemeralPort: true,
    });
    const bound = await gateway.start({ mode: 'tailscale', port: 0 });
    try {
      assert.deepStrictEqual(bound.origins, {});
      assert.throws(() => gateway.createPairing(), /confirmed HTTPS origin/);
      gateway.setTailscaleOrigin('https://phone.devnet.ts.net');
      const first = gateway.createPairing('https://phone.devnet.ts.net');
      assert.match(first.url, /^https:\/\/phone\.devnet\.ts\.net\/auth\/pair#token=/);
      gateway.setTailscaleOrigin('https://replacement.devnet.ts.net');
      assert.strictEqual(gateway.address().origins.tailscale, 'https://replacement.devnet.ts.net');
      assert.throws(() => gateway.createPairing('https://phone.devnet.ts.net'), /not an active phone ingress/);
      assert.match(gateway.createPairing().url, /^https:\/\/replacement\.devnet\.ts\.net\/auth\/pair#token=/);
    } finally {
      await gateway.stop();
    }
  });
});
