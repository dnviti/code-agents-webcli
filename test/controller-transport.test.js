'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const WebSocket = require('ws');

const {
  ControllerTransportError,
  canonicalTarget,
  classifyTransportError,
  createControllerTransport,
  normalizeFingerprint256,
  sanitizeRequestHeaders,
  validateIdentity,
} = require('../desktop/controller-transport.js');

function openssl(args, cwd) {
  execFileSync('openssl', args, { cwd, stdio: 'ignore' });
}

function issueCertificates(directory) {
  openssl([
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-subj', '/CN=Controller Test CA', '-keyout', 'ca.key', '-out', 'ca.crt',
  ], directory);

  function signed(name, hostname) {
    openssl([
      'req', '-new', '-newkey', 'rsa:2048', '-nodes', `-subj=/CN=${hostname}`,
      '-keyout', `${name}.key`, '-out', `${name}.csr`,
    ], directory);
    openssl([
      'x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key',
      '-CAcreateserial', '-days', '2', '-sha256', `-extfile=${name}.ext`, '-out', `${name}.crt`,
    ], directory);
  }

  fs.writeFileSync(path.join(directory, 'valid.ext'), 'subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n');
  signed('valid', 'localhost');
  fs.writeFileSync(path.join(directory, 'mismatch.ext'), 'subjectAltName=DNS:wrong.example\nextendedKeyUsage=serverAuth\n');
  signed('mismatch', 'wrong.example');
  fs.writeFileSync(path.join(directory, 'replacement.ext'), 'subjectAltName=DNS:wrong.example\nextendedKeyUsage=serverAuth\n');
  signed('replacement', 'wrong.example');
  openssl([
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
    '-keyout', 'self.key', '-out', 'self.crt',
  ], directory);
}

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, 'localhost', resolve);
  });
  return `https://localhost:${server.address().port}`;
}

async function close(server) {
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
}

async function responseBody(response) {
  const chunks = [];
  for await (const chunk of response) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function fakeTlsConnection({ authorized, fingerprint, authorizationError = null }) {
  const socket = new EventEmitter();
  socket.authorized = authorized;
  socket.authorizationError = authorizationError;
  socket.destroyed = false;
  socket.destroy = () => { socket.destroyed = true; };
  socket.getPeerCertificate = () => ({
    fingerprint256: fingerprint,
    subject: { CN: 'fixture' },
    issuer: { CN: 'fixture CA' },
  });
  const connect = (_options, callback) => {
    queueMicrotask(callback);
    return socket;
  };
  return { socket, connect };
}

function fakeResponse(statusCode = 200, headers = {}, body = 'ok') {
  const response = new PassThrough();
  response.statusCode = statusCode;
  response.headers = headers;
  queueMicrotask(() => response.end(body));
  return response;
}

function fakeRequest(response, observations) {
  return (url, options, callback) => {
    observations.calls += 1;
    observations.url = url.href;
    observations.options = options;
    const request = new PassThrough();
    request.setTimeout = () => {};
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('finish', () => {
      observations.body = Buffer.concat(chunks).toString('utf8');
      options.agent.createConnection({}, (error, socket) => {
        if (error) request.emit('error', error);
        else {
          observations.socket = socket;
          callback(response);
        }
      });
    });
    return request;
  };
}

describe('desktop controller transport boundary', function () {
  this.timeout(30_000);

  describe('target and header policy', function () {
    it('accepts only a canonical HTTPS origin', function () {
      assert.strictEqual(canonicalTarget(' HTTPS://Example.COM:443/ '), 'https://example.com');
      assert.strictEqual(canonicalTarget('https://example.com:8443/'), 'https://example.com:8443');
      for (const address of [
        'http://example.com',
        'ws://example.com',
        'https://user:secret@example.com',
        'https://example.com/path',
        'https://example.com/?query=1',
        'https://example.com/#fragment',
      ]) {
        assert.throws(() => canonicalTarget(address), ControllerTransportError, address);
      }
    });

    it('strips hop-by-hop, forwarded, cookie, host, and caller-controlled origin headers', function () {
      const sanitized = sanitizeRequestHeaders({
        Connection: 'keep-alive, X-Private-Hop',
        'Keep-Alive': 'timeout=5',
        Host: 'attacker.example',
        Origin: 'https://attacker.example',
        Cookie: 'secret=caller-controlled',
        Forwarded: 'host=attacker.example',
        'X-Forwarded-For': '127.0.0.1',
        'X-Private-Hop': 'remove me',
        Authorization: 'Bearer retained-for-the-selected-target',
        Accept: 'application/json',
      }, { rewriteOrigin: true, targetOrigin: 'https://server.example' });
      assert.deepStrictEqual(sanitized, {
        authorization: 'Bearer retained-for-the-selected-target',
        accept: 'application/json',
        origin: 'https://server.example',
      });
    });

    it('normalizes exact SHA-256 pins and rejects weaker fingerprints', function () {
      const compact = 'ab'.repeat(32);
      assert.strictEqual(normalizeFingerprint256(compact), Array(32).fill('AB').join(':'));
      assert.throws(() => normalizeFingerprint256('AA:BB'), /SHA-256/);
    });

    it('rejects a certificate approval carried over from a different exact origin', function () {
      assert.throws(
        () => createControllerTransport({
          origin: 'https://new.example',
          certificateApproval: {
            origin: 'https://old.example',
            fingerprint: 'AB'.repeat(32),
          },
        }),
        (error) => error.code === 'INVALID_CERTIFICATE_APPROVAL',
      );
    });

    it('classifies DNS and reachability failures for the controller UI', function () {
      assert.strictEqual(classifyTransportError(Object.assign(new Error(), { code: 'ENOTFOUND' })).category, 'dns');
      assert.strictEqual(classifyTransportError(Object.assign(new Error(), { code: 'ECONNREFUSED' })).category, 'unreachable');
      assert.strictEqual(classifyTransportError(Object.assign(new Error(), { code: 'EPROTO' })).category, 'unsupported-protocol');
    });
  });

  describe('pin-before-sensitive-data invariant', function () {
    const first = Array(32).fill('11').join(':');
    const second = Array(32).fill('22').join(':');

    it('does not fetch cookies, create a request, or touch a body when an invalid certificate is unapproved', async function () {
      const tlsFixture = fakeTlsConnection({
        authorized: false,
        fingerprint: first,
        authorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT',
      });
      let cookieCalls = 0;
      let requestCalls = 0;
      let bodyPipes = 0;
      const body = {
        pipe() { bodyPipes += 1; },
        once() {},
      };
      const transport = createControllerTransport({
        origin: 'https://server.example',
        tlsConnect: tlsFixture.connect,
        cookieProvider: async () => { cookieCalls += 1; return 'session=secret'; },
        requestImpl: () => { requestCalls += 1; throw new Error('must not be called'); },
      });

      await assert.rejects(
        () => transport.requestTarget({ path: '/api/private', method: 'POST', body }),
        (error) => error.code === 'TLS_CERTIFICATE' && error.fingerprint256 === first,
      );
      assert.strictEqual(cookieCalls, 0);
      assert.strictEqual(requestCalls, 0);
      assert.strictEqual(bodyPipes, 0);
      assert.strictEqual(tlsFixture.socket.destroyed, true);
    });

    it('marks a different invalid fingerprint as renewed-approval and still sends nothing', async function () {
      const tlsFixture = fakeTlsConnection({
        authorized: false,
        fingerprint: second,
        authorizationError: 'ERR_TLS_CERT_ALTNAME_INVALID',
      });
      let cookieCalls = 0;
      let requestCalls = 0;
      const transport = createControllerTransport({
        origin: 'https://server.example',
        approvedFingerprint256: first,
        tlsConnect: tlsFixture.connect,
        cookieProvider: async () => { cookieCalls += 1; return 'session=secret'; },
        requestImpl: () => { requestCalls += 1; },
      });

      await assert.rejects(
        () => transport.requestTarget({ path: '/api/private', method: 'POST', body: 'top secret' }),
        (error) => error.code === 'TLS_CERTIFICATE_CHANGED'
          && error.requiresRenewedApproval === true
          && error.fingerprint256 === second,
      );
      assert.strictEqual(cookieCalls, 0);
      assert.strictEqual(requestCalls, 0);
    });

    it('uses the pinned socket, provider cookies, repeated Set-Cookie sink, and raw streaming response', async function () {
      const tlsFixture = fakeTlsConnection({
        authorized: false,
        fingerprint: first,
        authorizationError: 'CERT_HAS_EXPIRED',
      });
      const observations = { calls: 0 };
      const stored = [];
      const response = fakeResponse(200, { 'set-cookie': ['a=1; Secure', 'b=2; Secure'] }, 'streamed');
      const transport = createControllerTransport({
        origin: 'https://server.example',
        approvedFingerprint256: first,
        tlsConnect: tlsFixture.connect,
        cookieProvider: async () => [{ name: 'session', value: 'secret' }],
        cookieSink: async (...args) => stored.push(args),
        requestImpl: fakeRequest(response, observations),
      });

      const incoming = await transport.requestTarget({
        path: '/download',
        method: 'POST',
        headers: { Host: 'bad.example', Origin: 'https://local.invalid' },
        body: 'payload',
      });
      assert.strictEqual(incoming, response, 'the transport returns the raw response stream');
      assert.strictEqual(await responseBody(incoming), 'streamed');
      assert.strictEqual(observations.body, 'payload');
      assert.strictEqual(observations.options.headers.cookie, 'session=secret');
      assert.strictEqual(observations.options.headers.origin, 'https://server.example');
      assert.strictEqual(observations.options.headers.host, undefined);
      assert.strictEqual(observations.socket, tlsFixture.socket);
      assert.deepStrictEqual(stored, [[
        'https://server.example',
        ['a=1; Secure', 'b=2; Secure'],
        'https://server.example/download',
      ]]);
    });

    it('refuses external OAuth and other cross-origin destinations before opening TLS', async function () {
      let connects = 0;
      const transport = createControllerTransport({
        origin: 'https://server.example',
        tlsConnect: () => { connects += 1; },
      });
      await assert.rejects(
        () => transport.requestTarget({ url: 'https://github.com/login/oauth/authorize' }),
        (error) => error.code === 'TARGET_ORIGIN_MISMATCH',
      );
      await assert.rejects(
        () => transport.connectTargetWebSocket({ url: 'wss://other.example/socket' }),
        (error) => error.code === 'TARGET_ORIGIN_MISMATCH',
      );
      assert.strictEqual(connects, 0);
    });
  });

  describe('identity compatibility', function () {
    const origin = 'https://server.example';
    const identity = {
      product: { id: 'code-agents-webcli', name: 'CODE AGENTS' },
      version: '6.1.0',
      protocolVersion: 1,
      capabilities: ['remote-controller'],
      serverName: 'Build host',
      address: origin,
    };

    it('accepts the exact product, protocol, capability, and advertised origin', function () {
      assert.strictEqual(validateIdentity(identity, origin), identity);
    });

    it('separates unrelated, incompatible, and unsupported responses', function () {
      assert.throws(
        () => validateIdentity({ product: { id: 'a-web-site' } }, origin),
        (error) => error.category === 'unrelated-response',
      );
      assert.throws(
        () => validateIdentity({ ...identity, capabilities: [] }, origin),
        (error) => error.category === 'incompatible-response',
      );
      assert.throws(
        () => validateIdentity({ ...identity, protocolVersion: 999 }, origin),
        (error) => error.category === 'unsupported-protocol',
      );
      assert.throws(
        () => validateIdentity({ ...identity, address: 'https://other.example' }, origin),
        (error) => error.category === 'incompatible-response',
      );
    });

    it('classifies an identity endpoint that requires sign-in without requesting cookies', async function () {
      const tlsFixture = fakeTlsConnection({
        authorized: true,
        fingerprint: Array(32).fill('AA').join(':'),
      });
      let cookieCalls = 0;
      let cookieWrites = 0;
      const transport = createControllerTransport({
        origin,
        tlsConnect: tlsFixture.connect,
        cookieProvider: async () => { cookieCalls += 1; return 'session=secret'; },
        cookieSink: async () => { cookieWrites += 1; },
        requestImpl: fakeRequest(fakeResponse(401, { 'set-cookie': 'attacker=credential' }), { calls: 0 }),
      });
      await assert.rejects(
        () => transport.verifyTarget(),
        (error) => error.category === 'auth-required' && error.statusCode === 401,
      );
      assert.strictEqual(cookieCalls, 0);
      assert.strictEqual(cookieWrites, 0);
    });
  });

  describe('local TLS integration', function () {
    let directory;
    let ca;

    before(function () {
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'controller-transport-'));
      issueCertificates(directory);
      ca = fs.readFileSync(path.join(directory, 'ca.crt'));
    });

    after(function () {
      fs.rmSync(directory, { recursive: true, force: true });
    });

    function serverFor(name, handler) {
      return https.createServer({
        key: fs.readFileSync(path.join(directory, `${name}.key`)),
        cert: fs.readFileSync(path.join(directory, `${name}.crt`)),
      }, handler);
    }

    it('uses normal CA and hostname verification for a valid certificate', async function () {
      const server = serverFor('valid', (_request, response) => response.end('trusted'));
      const origin = await listen(server);
      try {
        const transport = createControllerTransport({ origin, ca });
        const probe = await transport.probeCertificate();
        assert.strictEqual(probe.valid, true);
        const response = await transport.requestTarget({ path: '/' });
        assert.strictEqual(await responseBody(response), 'trusted');
      } finally {
        await close(server);
      }
    });

    it('probes self-signed certificates without cookies or HTTP bytes, then permits the exact pin', async function () {
      let requests = 0;
      let cookieCalls = 0;
      const server = serverFor('self', (_request, response) => {
        requests += 1;
        response.end('self-signed');
      });
      const origin = await listen(server);
      try {
        const unapproved = createControllerTransport({
          origin,
          cookieProvider: async () => { cookieCalls += 1; return 'session=secret'; },
        });
        const probe = await unapproved.probeCertificate();
        assert.strictEqual(probe.valid, false);
        assert.ok(probe.fingerprint256);
        assert.strictEqual(requests, 0, 'the certificate probe sent no HTTP request');
        assert.strictEqual(cookieCalls, 0, 'the certificate probe did not access cookies');

        const approved = createControllerTransport({
          origin,
          approvedFingerprint256: probe.fingerprint256,
          cookieProvider: async () => { cookieCalls += 1; return 'session=secret'; },
        });
        const response = await approved.requestTarget({ path: '/private' });
        assert.strictEqual(await responseBody(response), 'self-signed');
        assert.strictEqual(requests, 1);
        assert.strictEqual(cookieCalls, 1);
      } finally {
        await close(server);
      }
    });

    it('allows a pinned hostname mismatch and blocks a replacement before sensitive HTTP bytes', async function () {
      let firstRequests = 0;
      const firstServer = serverFor('mismatch', (_request, response) => {
        firstRequests += 1;
        response.end('mismatch');
      });
      const firstOrigin = await listen(firstServer);
      const firstProbe = await createControllerTransport({ origin: firstOrigin, ca }).probeCertificate();
      assert.strictEqual(firstProbe.valid, false);
      const firstResponse = await createControllerTransport({
        origin: firstOrigin,
        ca,
        approvedFingerprint256: firstProbe.fingerprint256,
        cookieProvider: async () => 'session=secret',
      }).requestTarget({ path: '/private', method: 'POST', body: 'command=destroy' });
      assert.strictEqual(await responseBody(firstResponse), 'mismatch');
      assert.strictEqual(firstRequests, 1);
      const port = new URL(firstOrigin).port;
      await close(firstServer);

      let replacementRequests = 0;
      const replacementServer = serverFor('replacement', (_request, response) => {
        replacementRequests += 1;
        response.end('replacement');
      });
      const replacementOrigin = await listen(replacementServer, Number(port));
      try {
        assert.strictEqual(replacementOrigin, firstOrigin, 'the certificate changed at the exact approved origin');
        const replacement = createControllerTransport({
          origin: replacementOrigin,
          ca,
          approvedFingerprint256: firstProbe.fingerprint256,
          cookieProvider: async () => 'session=secret',
        });
        await assert.rejects(
          () => replacement.requestTarget({ path: '/private', method: 'POST', body: 'command=destroy' }),
          (error) => error.code === 'TLS_CERTIFICATE_CHANGED' && error.requiresRenewedApproval,
        );
        assert.strictEqual(replacementRequests, 0, 'no HTTP bytes reached the replacement certificate');
      } finally {
        await close(replacementServer);
      }
    });

    it('does not report a WebSocket connection before an authenticated upgrade succeeds', async function () {
      for (const expectation of [
        { status: 401, reason: 'Unauthorized', code: 'AUTH_REQUIRED' },
        { status: 403, reason: 'Forbidden', code: 'REQUEST_FAILED' },
      ]) {
        const server = serverFor('valid', () => {});
        server.on('upgrade', (_request, socket) => {
          socket.end([
            `HTTP/1.1 ${expectation.status} ${expectation.reason}`,
            'Connection: close',
            'Content-Length: 0',
            '',
            '',
          ].join('\r\n'));
        });
        const origin = await listen(server);
        try {
          const transport = createControllerTransport({
            origin,
            ca,
            cookieProvider: async () => [{ name: 'session', value: 'expired' }],
          });
          await assert.rejects(
            () => transport.connectTargetWebSocket({ path: '/terminal' }),
            (error) => error.code === expectation.code && error.statusCode === expectation.status,
          );
        } finally {
          await close(server);
        }
      }
    });

    it('connects WebSockets over the already verified socket with scoped cookies and origin', async function () {
      let upgradeHeaders;
      const server = serverFor('valid', () => {});
      const websocketServer = new WebSocket.Server({ server });
      websocketServer.on('connection', (socket, request) => {
        upgradeHeaders = request.headers;
        socket.send('connected');
      });
      const origin = await listen(server);
      try {
        const transport = createControllerTransport({
          origin,
          ca,
          cookieProvider: async () => [{ name: 'session', value: 'socket-secret' }],
        });
        const socket = await transport.connectTargetWebSocket({
          path: '/terminal',
          headers: { Origin: 'https://attacker.example', Host: 'attacker.example' },
        });
        const message = await new Promise((resolve, reject) => {
          socket.once('message', (data) => resolve(data.toString()));
          socket.once('error', reject);
        });
        assert.strictEqual(message, 'connected');
        assert.strictEqual(upgradeHeaders.cookie, 'session=socket-secret');
        assert.strictEqual(upgradeHeaders.origin, origin);
        assert.strictEqual(upgradeHeaders.host, new URL(origin).host);
        socket.close();
      } finally {
        websocketServer.close();
        await close(server);
      }
    });
  });
});
