'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const WebSocket = require('ws');

const {
  MAX_ROUTING_BODY,
  SESSION_COOKIE,
  createPhoneAccessGateway,
} = require('../desktop/phone-access-gateway.js');

const PUBLIC_ORIGIN = 'https://phone.example';

function upstreamResponse(statusCode, headers = {}, body = '') {
  const stream = new PassThrough();
  stream.statusCode = statusCode;
  stream.headers = headers;
  queueMicrotask(() => stream.end(body));
  return stream;
}

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method: options.method || 'GET',
      headers: {
        Host: 'phone.example',
        ...(options.origin === false ? {} : { Origin: PUBLIC_ORIGIN }),
        ...(options.headers || {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.once('error', reject);
    req.end(options.body);
  });
}

function controller(overrides = {}) {
  return {
    listTargets: () => [{ id: 'local', status: 'ready' }],
    request: async () => upstreamResponse(200, { 'content-type': 'application/json' }, '{}'),
    ...overrides,
  };
}

async function startGateway(facade, options = {}) {
  const gateway = createPhoneAccessGateway({
    controller: facade,
    allowEphemeralPort: true,
    ...options,
  });
  const bound = await gateway.start({
    mode: 'tailscale',
    port: 0,
    tailscaleOrigin: PUBLIC_ORIGIN,
  });
  return { gateway, port: bound.port };
}

async function pair(gateway, port, label = 'Test phone') {
  const pairing = gateway.createPairing(PUBLIC_ORIGIN);
  const token = new URL(pairing.url).hash.slice('#token='.length);
  const response = await request(port, '/auth/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, label }),
  });
  assert.strictEqual(response.statusCode, 200);
  return {
    cookie: response.headers['set-cookie'][0].split(';', 1)[0],
    device: JSON.parse(response.body.toString('utf8')).device,
  };
}

function rawRequest(port, bytes) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let response = '';
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.once('connect', () => socket.end(bytes));
    socket.on('data', (chunk) => { response += chunk; });
    socket.once('close', () => resolve(response));
  });
}

function waitForClose(socket) {
  return new Promise((resolve) => socket.once('close', (code) => resolve(code)));
}

describe('desktop phone access adversarial integration', function () {
  this.timeout(20_000);

  it('consumes a pairing exactly once under a race, expires it, and rate-limits guesses', async function () {
    let clock = Date.parse('2030-01-01T00:00:00.000Z');
    const { gateway, port } = await startGateway(controller(), {
      now: () => clock,
      pairingTtlMs: 1_000,
    });
    try {
      const racing = gateway.createPairing(PUBLIC_ORIGIN);
      const token = new URL(racing.url).hash.slice('#token='.length);
      const redeem = () => request(port, '/auth/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const raced = await Promise.all([redeem(), redeem()]);
      assert.deepStrictEqual(raced.map((item) => item.statusCode).sort(), [200, 401]);
      assert.strictEqual(gateway.devices().length, 1);

      const expiring = gateway.createPairing(PUBLIC_ORIGIN);
      clock += 1_001;
      const expired = await request(port, '/auth/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: new URL(expiring.url).hash.slice('#token='.length) }),
      });
      assert.strictEqual(expired.statusCode, 401);
    } finally {
      await gateway.stop();
    }

    const limited = await startGateway(controller());
    try {
      const attempts = [];
      for (let index = 0; index < 9; index += 1) {
        attempts.push(await request(limited.port, '/auth/pair', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: `guess-${index}` }),
        }));
      }
      assert.deepStrictEqual(attempts.slice(0, 8).map((item) => item.statusCode), Array(8).fill(401));
      assert.strictEqual(attempts[8].statusCode, 429);
      assert.strictEqual(attempts[8].headers['retry-after'], '60');
    } finally {
      await limited.gateway.stop();
    }
  });

  it('rejects duplicate security headers and absolute-form targets before local routing', async function () {
    let calls = 0;
    const { gateway, port } = await startGateway(controller({
      request: async () => { calls += 1; return upstreamResponse(200); },
    }));
    try {
      const duplicate = await rawRequest(port,
        'GET /app.bundle.js HTTP/1.1\r\nHost: phone.example\r\nOrigin: https://phone.example\r\nOrigin: https://phone.example\r\nConnection: close\r\n\r\n');
      assert.match(duplicate, /^HTTP\/1\.1 400 /);
      const absolute = await rawRequest(port,
        'GET https://phone.example/app.bundle.js HTTP/1.1\r\nHost: phone.example\r\nConnection: close\r\n\r\n');
      assert.match(absolute, /^HTTP\/1\.1 400 /);
      assert.strictEqual(calls, 0);
    } finally {
      await gateway.stop();
    }
  });

  it('closes a rejected connection with an unread body before any pipelined request can run', async function () {
    let calls = 0;
    const { gateway, port } = await startGateway(controller({
      request: async () => { calls += 1; return upstreamResponse(200); },
    }));
    try {
      const { cookie } = await pair(gateway, port);
      const response = await rawRequest(port,
        `POST /api/config HTTP/1.1\r\nHost: phone.example\r\nOrigin: ${PUBLIC_ORIGIN}\r\nCookie: ${cookie}\r\nContent-Length: ${MAX_ROUTING_BODY + 1}\r\nConnection: keep-alive\r\n\r\n`
        + 'GET /app.bundle.js HTTP/1.1\r\nHost: phone.example\r\nConnection: close\r\n\r\n');
      assert.match(response, /^HTTP\/1\.1 413 /);
      assert.match(response, /\r\nconnection: close\r\n/i);
      assert.strictEqual((response.match(/HTTP\/1\.1 /g) || []).length, 1);
      assert.strictEqual(calls, 0);

      const earlyRejections = [
        {
          status: 400,
          headers: `Host: phone.example\r\nOrigin: ${PUBLIC_ORIGIN}\r\nOrigin: ${PUBLIC_ORIGIN}`,
        },
        {
          status: 403,
          headers: 'Host: phone.example\r\nOrigin: https://attacker.example',
        },
        {
          status: 401,
          headers: `Host: phone.example\r\nOrigin: ${PUBLIC_ORIGIN}`,
        },
      ];
      for (const rejection of earlyRejections) {
        const rejected = await rawRequest(port,
          `POST /api/config HTTP/1.1\r\n${rejection.headers}\r\nContent-Length: 512\r\nConnection: keep-alive\r\n\r\n`
          + 'GET /app.bundle.js HTTP/1.1\r\nHost: phone.example\r\nConnection: close\r\n\r\n');
        assert.match(rejected, new RegExp(`^HTTP/1\\.1 ${rejection.status} `));
        assert.match(rejected, /\r\nconnection: close\r\n/i);
        assert.strictEqual((rejected.match(/HTTP\/1\.1 /g) || []).length, 1);
      }
      assert.strictEqual(calls, 0);
    } finally {
      await gateway.stop();
    }
  });

  it('preserves ranges, reserves the larger limit for exact attachment uploads, and rejects oversized routing bodies', async function () {
    let attachmentBytes = null;
    let ordinaryCalls = 0;
    const { gateway, port } = await startGateway(controller({
      request: async (_serverId, options) => {
        if (options.path === '/download') {
          assert.strictEqual(options.headers.range, 'bytes=2-4');
          return upstreamResponse(206, {
            'content-type': 'application/octet-stream',
            'content-range': 'bytes 2-4/6',
            'content-length': '3',
          }, Buffer.from('cde'));
        }
        if (options.path.endsWith('/chat-attachments')) {
          const chunks = [];
          for await (const chunk of options.body) chunks.push(Buffer.from(chunk));
          attachmentBytes = Buffer.concat(chunks);
          return upstreamResponse(201, { 'content-type': 'application/json' }, '{"stored":true}');
        }
        ordinaryCalls += 1;
        return upstreamResponse(200);
      },
    }));
    try {
      const { cookie } = await pair(gateway, port);
      const range = await request(port, '/download', {
        headers: { Cookie: cookie, Range: 'bytes=2-4', 'Sec-Fetch-Site': 'same-origin' },
      });
      assert.strictEqual(range.statusCode, 206);
      assert.strictEqual(range.headers['content-range'], 'bytes 2-4/6');
      assert.strictEqual(range.body.toString(), 'cde');

      const tooLarge = await request(port, '/api/config', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Length': String(MAX_ROUTING_BODY + 1),
          'Sec-Fetch-Site': 'same-origin',
        },
      });
      assert.strictEqual(tooLarge.statusCode, 413);
      assert.strictEqual(ordinaryCalls, 0);

      const bytes = Buffer.alloc(MAX_ROUTING_BODY + 1, 0x5a);
      const upload = await request(port, '/api/sessions/local-id/chat-attachments', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'content-type': 'application/octet-stream',
          'content-length': String(bytes.length),
          'Sec-Fetch-Site': 'same-origin',
        },
        body: bytes,
      });
      assert.strictEqual(upload.statusCode, 201, upload.body.toString('utf8'));
      assert.deepStrictEqual(attachmentBytes, bytes);
    } finally {
      await gateway.stop();
    }
  });

  it('invalidates first and aborts an active streamed response plus a pending request', async function () {
    let streamedUpstream;
    let pendingSignal;
    let pendingStarted;
    const pendingReady = new Promise((resolve) => { pendingStarted = resolve; });
    const { gateway, port } = await startGateway(controller({
      request: async (_serverId, options) => {
        if (options.path === '/stream') {
          streamedUpstream = new PassThrough();
          streamedUpstream.statusCode = 200;
          streamedUpstream.headers = { 'content-type': 'text/event-stream' };
          queueMicrotask(() => streamedUpstream.write('data: live\n\n'));
          return streamedUpstream;
        }
        if (options.path === '/pending') {
          pendingSignal = options.signal;
          pendingStarted();
          return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }));
          }, { once: true }));
        }
        return upstreamResponse(200);
      },
    }));
    try {
      const first = await pair(gateway, port, 'Streaming phone');
      let streamResponse;
      const streamStarted = new Promise((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1', port, path: '/stream',
          headers: { Host: 'phone.example', Origin: PUBLIC_ORIGIN, Cookie: first.cookie },
        }, (res) => {
          streamResponse = res;
          res.once('data', resolve);
        });
        req.once('error', reject);
        req.end();
      });
      await streamStarted;
      const streamClosed = new Promise((resolve) => {
        streamResponse.once('aborted', resolve);
        streamResponse.once('close', resolve);
      });
      assert.strictEqual(gateway.revoke(first.device.id), true);
      await streamClosed;
      assert.strictEqual(streamedUpstream.destroyed, true);
      assert.strictEqual((await request(port, '/api/config', {
        headers: { Cookie: first.cookie },
      })).statusCode, 401);

      const second = await pair(gateway, port, 'Pending phone');
      const pendingClient = new Promise((resolve) => {
        const req = http.request({
          host: '127.0.0.1', port, path: '/pending',
          headers: { Host: 'phone.example', Origin: PUBLIC_ORIGIN, Cookie: second.cookie },
        });
        req.once('response', (res) => { res.resume(); res.once('close', resolve); });
        req.once('error', resolve);
        req.end();
      });
      await pendingReady;
      gateway.revoke(second.device.id);
      await pendingClient;
      assert.strictEqual(pendingSignal.aborted, true);
    } finally {
      await gateway.stop();
    }
  });

  it('revokes multiple browser and upstream WebSockets owned by one phone', async function () {
    const upstreamServer = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
    await new Promise((resolve) => upstreamServer.once('listening', resolve));
    const upstreamPort = upstreamServer.address().port;
    const upstreamSockets = new Set();
    upstreamServer.on('connection', (socket) => {
      upstreamSockets.add(socket);
      socket.once('close', () => upstreamSockets.delete(socket));
      socket.on('message', (message, binary) => socket.send(message, { binary }));
    });
    const { gateway, port } = await startGateway(controller({
      connectWebSocket: async () => new WebSocket(`ws://127.0.0.1:${upstreamPort}`),
    }));
    try {
      const paired = await pair(gateway, port, 'Socket phone');
      const open = () => new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/`, {
          headers: {
            Host: 'phone.example', Origin: PUBLIC_ORIGIN, Cookie: paired.cookie,
            'Sec-Fetch-Site': 'same-origin',
          },
        });
        socket.once('open', () => resolve(socket));
        socket.once('error', reject);
      });
      const [one, two] = await Promise.all([open(), open()]);
      const echoed = new Promise((resolve) => one.once('message', (message) => resolve(message.toString())));
      one.send('hello');
      assert.strictEqual(await echoed, 'hello');
      const closed = Promise.all([waitForClose(one), waitForClose(two)]);
      gateway.revoke(paired.device.id);
      const codes = await closed;
      assert.ok(codes.every((code) => code === 4401 || code === 1006));
      await new Promise((resolve) => setImmediate(resolve));
      assert.strictEqual(upstreamSockets.size, 0);
    } finally {
      await gateway.stop();
      await new Promise((resolve) => upstreamServer.close(resolve));
    }
  });

  it('keeps /auth/pair network-only in the installed service worker', function () {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'service-worker.js'), 'utf8');
    const authGuard = source.indexOf("url.pathname.startsWith('/auth/')");
    const networkFetch = source.indexOf('fetch(request).catch', authGuard);
    const cacheFallback = source.indexOf('caches.match(request)');
    assert.ok(authGuard >= 0 && networkFetch > authGuard && cacheFallback > networkFetch,
      'pairing routes reach the network branch before any shell-cache fallback');
    assert.doesNotMatch(source.slice(authGuard, cacheFallback), /caches\.match/);
  });
});
