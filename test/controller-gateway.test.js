'use strict';

const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { PassThrough, Readable } = require('node:stream');
const WebSocket = require('ws');

const {
  CONTROLLER_AUTH_HEADER,
  CONTROLLER_HEADER,
  MAX_ATTACHMENT_BYTES,
  createControllerGateway,
} = require('../desktop/controller-gateway.js');
const { createLocalControllerTransport } = require('../desktop/controller-runtime.js');
const { parseQualifiedSessionId, qualifySessionId } = require('../desktop/controller-protocol.js');

class MockSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = WebSocket.OPEN;
    this.sent = [];
  }
  send(data) { this.sent.push(JSON.parse(String(data))); }
  close() { this.readyState = WebSocket.CLOSED; this.emit('close'); }
  upstream(message) { this.emit('message', Buffer.from(JSON.stringify(message)), false); }
}

class MockController {
  constructor(targets) {
    this.targets = targets;
    this.responses = new Map();
    this.requests = [];
    this.sockets = new Map();
    this.socketHistory = new Map();
    this.socketRequests = [];
    this.connectingIds = new Set();
    this.actions = [];
    this.actionResults = new Map();
  }
  listTargets() { return this.targets; }
  request(serverId, request) {
    this.requests.push({ serverId, ...request });
    const key = `${serverId} ${request.method} ${request.path}`;
    const response = this.responses.get(key);
    if (response instanceof Error) throw response;
    if (!response) throw new Error(`No mock response for ${key}`);
    if (typeof response === 'function') return response(request);
    // A real HTTP transport cannot complete an upload response without either
    // consuming or aborting its request body. Keep canned responses honest so
    // the gateway's input-completion invariant is exercised instead of leaving
    // its bounded stream permanently unread.
    if (request.body && typeof request.body.pipe === 'function') {
      return requestBytes(request.body).then(() => response);
    }
    return response;
  }
  connectWebSocket(serverId, request) {
    this.socketRequests.push({ serverId, ...request });
    const socket = new MockSocket();
    if (this.connectingIds.has(serverId)) socket.readyState = WebSocket.CONNECTING;
    this.sockets.set(serverId, socket);
    const history = this.socketHistory.get(serverId) || [];
    history.push(socket);
    this.socketHistory.set(serverId, history);
    return socket;
  }
  action(name, payload) {
    this.actions.push({ name, payload });
    if (this.actionResults.has(name)) return this.actionResults.get(name);
    return { target: { id: payload.serverId || 'new', name: 'Safe', status: 'connected', secret: 'no' } };
  }
}

function upstream(body, options = {}) {
  return {
    statusCode: options.statusCode || 200,
    headers: options.headers || { 'content-type': 'application/json' },
    body: body && typeof body.pipe === 'function'
      ? body : Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]),
  };
}

async function requestBytes(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function once(emitter, event) {
  return new Promise((resolve, reject) => {
    emitter.once(event, (...args) => resolve(args));
    emitter.once('error', reject);
  });
}

function wsMessages(socket) {
  const messages = [];
  socket.on('message', (data, binary) => {
    if (!binary) messages.push(JSON.parse(data.toString('utf8')));
  });
  return messages;
}

describe('desktop controller gateway', function () {
  let directory;
  let gateway;
  let base;
  let capability;

  beforeEach(async function () {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'controller-gateway-'));
    fs.writeFileSync(path.join(directory, 'index.html'), '<!doctype html><title>Controller</title>');
    fs.writeFileSync(path.join(directory, 'app.js'), 'globalThis.controller = true;');
  });

  afterEach(async function () {
    if (gateway) await gateway.close();
    gateway = null;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  async function start(controller, options = {}) {
    gateway = createControllerGateway({ publicDir: directory, controller, ...options });
    ({ origin: base } = await gateway.listen());
    capability = gateway.authentication().value;
  }

  function authenticated(url, init = {}) {
    return fetch(`${base}${url}`, {
      ...init,
      headers: { [CONTROLLER_AUTH_HEADER]: capability, ...(init.headers || {}) },
    });
  }

  it('keeps a high-entropy embedder capability out of HTTP and rejects bad auth, Host, origin, and traversal', async function () {
    const controller = new MockController([]);
    await start(controller, { randomBytes: () => Buffer.alloc(32, 7) });

    const unauthenticatedDocument = await fetch(`${base}/`);
    assert.strictEqual(unauthenticatedDocument.status, 401);
    assert.strictEqual(unauthenticatedDocument.headers.get('set-cookie'), null);
    assert.strictEqual((await fetch(`${base}/app.js`)).status, 401);
    assert.strictEqual((await authenticated('/')).status, 200);
    assert.strictEqual((await authenticated('/app.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.strictEqual((await authenticated('/api/controller/bootstrap', {
      headers: { origin: 'https://attacker.example' },
    })).status, 403);

    const address = gateway.address();
    const badHost = await new Promise((resolve, reject) => {
      const req = http.request({
        host: address.address,
        port: address.port,
        path: '/api/controller/bootstrap',
        headers: { host: 'attacker.example', [CONTROLLER_AUTH_HEADER]: capability },
      }, resolve);
      req.once('error', reject);
      req.end();
    });
    assert.strictEqual(badHost.statusCode, 403);
    badHost.resume();

    const traversal = await new Promise((resolve, reject) => {
      const req = http.request({
        host: address.address,
        port: address.port,
        path: '/%2e%2e/secret.txt',
        headers: { host: `${address.address}:${address.port}`, [CONTROLLER_AUTH_HEADER]: capability },
      }, resolve);
      req.once('error', reject);
      req.end();
    });
    assert.strictEqual(traversal.statusCode, 404);
    traversal.resume();
  });

  it('aggregates colliding live and cached session ids in global activity order', async function () {
    const controller = new MockController([
      { id: 'local', type: 'local', name: 'Local computer', status: 'ready' },
      {
        id: 'remote', type: 'remote', name: 'Build host', status: 'offline', authMarker: true,
        offlineMetadataCache: { sessions: [{ id: 'same', name: 'Cached work', lastActivity: 30 }] },
      },
      { id: 'other', type: 'remote', name: 'Other host', status: 'connected' },
    ]);
    controller.responses.set('local GET /api/sessions/list', upstream({
      sessions: [{ id: 'same', name: 'Local work', lastActivity: 10 }],
    }));
    controller.responses.set('other GET /api/sessions/list', upstream({
      sessions: [{ id: 'new', name: 'Other work', lastActivity: 20 }],
    }));
    await start(controller);

    const response = await authenticated('/api/sessions/list');
    assert.strictEqual(response.status, 200);
    const value = await response.json();
    assert.deepStrictEqual(value.sessions.map((session) => session.name), [
      'Cached work', 'Other work', 'Local work',
    ]);
    assert.strictEqual(new Set(value.sessions.map((session) => session.id)).size, 3);
    assert.deepStrictEqual(value.sessions.map((session) => parseQualifiedSessionId(session.id).serverId), [
      'remote', 'other', 'local',
    ]);
    assert.strictEqual(value.sessions[0].offline, true);
  });

  it('combines recent conversations with qualified ids and server-labelled groups', async function () {
    const controller = new MockController([
      { id: 'local', type: 'local', name: 'Local computer', status: 'ready' },
      { id: 'remote', type: 'remote', name: 'Build host', status: 'connected', insecure: true },
    ]);
    controller.responses.set('local GET /api/sessions/conversations', () => upstream({
      projects: [{ key: 'same', name: 'Project', lastActivity: '2026-01-01', conversations: [{ id: 'same', name: 'Local chat' }] }],
      total: 1, truncated: false,
    }));
    controller.responses.set('remote GET /api/sessions/conversations', () => upstream({
      projects: [{ key: 'same', name: 'Project', lastActivity: '2026-02-01', conversations: [{ id: 'same', name: 'Remote chat' }] }],
      total: 1, truncated: true,
    }));
    await start(controller);

    const value = await (await authenticated('/api/sessions/conversations')).json();
    assert.deepStrictEqual(value.projects.map((project) => project.name), [
      'Project · Build host', 'Project · Local computer',
    ]);
    assert.deepStrictEqual(value.projects.map((project) => project.serverId), ['remote', 'local']);
    assert.strictEqual(new Set(value.projects.map((project) => project.key)).size, 2);
    assert.deepStrictEqual(value.projects.map((project) => parseQualifiedSessionId(project.conversations[0].id).serverId), ['remote', 'local']);
    assert.strictEqual(value.projects[0].conversations[0].serverInsecure, true);
    assert.strictEqual(value.total, 2);
    assert.strictEqual(value.truncated, true);

    const selected = await (await authenticated('/api/sessions/conversations', {
      headers: { [CONTROLLER_HEADER]: 'remote' },
    })).json();
    assert.deepStrictEqual(selected.projects.map((project) => project.serverId), ['remote']);
    assert.strictEqual(parseQualifiedSessionId(selected.projects[0].conversations[0].id).serverId, 'remote');

    controller.responses.set('remote GET /api/sessions/conversations', upstream(
      { error: 'not_supported' }, { statusCode: 404 },
    ));
    const unavailable = await authenticated('/api/sessions/conversations', {
      headers: { [CONTROLLER_HEADER]: 'remote' },
    });
    assert.strictEqual(unavailable.status, 404);
    assert.deepStrictEqual(await unavailable.json(), { error: 'not_supported' });

    controller.responses.set('remote GET /api/sessions/conversations', () => upstream({ ok: true }));
    const malformed = await authenticated('/api/sessions/conversations', {
      headers: { [CONTROLLER_HEADER]: 'remote' },
    });
    assert.strictEqual(malformed.status, 502);
    assert.match((await malformed.json()).message, /invalid conversations response/);
  });

  it('routes qualified paths and explicit creates without cross-target fallback', async function () {
    const controller = new MockController([
      { id: 'local', name: 'Local', status: 'ready' },
      { id: 'remote', name: 'Remote', status: 'connected' },
    ]);
    controller.responses.set('remote DELETE /api/sessions/colliding%2Fid', upstream({ success: true }));
    controller.responses.set('remote GET /api/workspace/colliding%2Fid/files', upstream({ files: [] }));
    controller.responses.set('remote POST /api/sessions/create', upstream({ sessionId: 'made-here' }));
    await start(controller);

    const sessionId = qualifySessionId('remote', 'colliding/id');
    assert.strictEqual((await authenticated(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })).status, 200);
    assert.strictEqual(controller.requests.at(-1).serverId, 'remote');

    const workspace = await authenticated(`/api/workspace/${encodeURIComponent(sessionId)}/files`);
    assert.strictEqual(workspace.status, 200);
    assert.strictEqual(controller.requests.at(-1).serverId, 'remote');
    assert.strictEqual(controller.requests.at(-1).path, '/api/workspace/colliding%2Fid/files');

    const ambiguous = await authenticated('/api/sessions/create', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x' }),
    });
    assert.strictEqual(ambiguous.status, 400);

    const created = await authenticated('/api/sessions/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [CONTROLLER_HEADER]: 'remote' },
      body: JSON.stringify({ name: 'x' }),
    });
    assert.strictEqual(created.status, 200);
    assert.deepStrictEqual(parseQualifiedSessionId((await created.json()).sessionId), {
      serverId: 'remote', sessionId: 'made-here',
    });
    assert.deepStrictEqual(JSON.parse(controller.requests.at(-1).body.toString()), { name: 'x' });

    const wrong = await authenticated(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE', headers: { [CONTROLLER_HEADER]: 'local' },
    });
    assert.strictEqual(wrong.status, 400);
  });

  it('rejects cross-server HTTP reorder instead of writing any target', async function () {
    const controller = new MockController([
      { id: 'local', name: 'Local', status: 'ready' },
      { id: 'remote', name: 'Remote', status: 'connected' },
    ]);
    await start(controller);
    const response = await authenticated('/api/sessions/tabs/order', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionIds: [
        qualifySessionId('local', 'one'), qualifySessionId('remote', 'two'),
      ] }),
    });
    assert.strictEqual(response.status, 400);
    assert.strictEqual(controller.requests.length, 0);
  });

  it('returns a minimal config while local is down and keeps sanitized controller actions usable', async function () {
    const controller = new MockController([{
      id: 'local', name: 'Local computer', status: 'offline', error: { message: 'Child process exited' },
      credential: 'must-not-leak',
    }]);
    await start(controller);
    const config = await (await authenticated('/api/config')).json();
    assert.strictEqual(config.desktopController, true);
    assert.strictEqual(config.localServerUnavailable, true);
    assert.strictEqual(config.localServerError.message, 'Child process exited');

    const action = await authenticated('/api/controller/targets/remote/retry', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.strictEqual(action.status, 200);
    const result = await action.json();
    assert.strictEqual(result.target.secret, undefined);
    assert.deepStrictEqual(controller.actions, [{ name: 'retry', payload: { serverId: 'remote' } }]);
  });

  it('forwards explicit removal confirmation without exposing certificate secrets', async function () {
    const controller = new MockController([{
      id: 'remote', name: 'Remote', status: 'certificate-error', version: '6.1.0',
      protocolVersion: 1, capabilities: ['remote-controller'], credential: 'secret',
      stagedAddition: true,
      certificateFingerprint: 'APPROVED:PIN', runningWorkCount: 2,
      error: {
        code: 'TLS_CERTIFICATE', message: 'Approval required', fingerprint256: 'AA:BB',
        certificate: { subject: 'lab', raw: Buffer.from('secret') },
      },
    }]);
    await start(controller);
    const bootstrap = await (await authenticated('/api/controller/bootstrap')).json();
    assert.deepStrictEqual(bootstrap.targets[0].capabilities, ['remote-controller']);
    assert.strictEqual(bootstrap.targets[0].certificateFingerprint, 'APPROVED:PIN');
    assert.strictEqual(bootstrap.targets[0].runningWorkCount, 2);
    assert.strictEqual(bootstrap.targets[0].stagedAddition, true);
    assert.strictEqual(bootstrap.targets[0].credential, undefined);
    assert.deepStrictEqual(bootstrap.targets[0].error.certificate, { subject: 'lab' });

    await authenticated('/api/controller/targets/remote', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmRunning: true }),
    });
    assert.deepStrictEqual(controller.actions.at(-1), {
      name: 'remove', payload: { confirmRunning: true, serverId: 'remote' },
    });

    await authenticated('/api/controller/targets/remote/certificate', {
      method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.deepStrictEqual(controller.actions.at(-1), {
      name: 'requireValidCertificate', payload: { serverId: 'remote' },
    });
  });

  it('preserves streamed response bytes while stripping hop-by-hop and Set-Cookie headers', async function () {
    const controller = new MockController([{ id: 'remote', name: 'Remote', status: 'connected' }]);
    const stream = new PassThrough();
    controller.responses.set('remote GET /api/download', upstream(stream, {
      headers: {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment; filename="data.bin"',
        connection: 'x-secret',
        'x-secret': 'hop',
        'set-cookie': 'remote=credential',
        location: 'https://remote.example/login',
      },
    }));
    await start(controller);
    const responsePromise = authenticated('/api/download?serverId=remote');
    setImmediate(() => { stream.write(Buffer.from([0, 1, 2])); stream.end(Buffer.from([3, 4])); });
    const response = await responsePromise;
    assert.deepStrictEqual(Buffer.from(await response.arrayBuffer()), Buffer.from([0, 1, 2, 3, 4]));
    assert.strictEqual(response.headers.get('content-disposition'), 'attachment; filename="data.bin"');
    assert.strictEqual(response.headers.get('set-cookie'), null);
    assert.strictEqual(response.headers.get('x-secret'), null);
    assert.strictEqual(response.headers.get('location'), null);
    assert.strictEqual(response.headers.get('cache-control'), 'no-store');
    assert.strictEqual(controller.requests[0].path, '/api/download');
    assert.strictEqual(controller.requests[0].headers.cookie, undefined);
    assert.strictEqual(controller.requests[0].headers[CONTROLLER_AUTH_HEADER], undefined);
  });

  it('translates every HTTP session-id seam without changing its target owner', async function () {
    const controller = new MockController([
      { id: 'remote', name: 'Remote', status: 'connected' },
    ]);
    controller.responses.set('remote GET /api/folders?sessionId=raw%2Fid', upstream({ folders: [] }));
    controller.responses.set('remote POST /api/set-working-dir', upstream({ success: true }));
    controller.responses.set('remote GET /api/sessions/resumable?dir=%2Fwork', upstream({
      conversations: [{ id: 'raw/id', name: 'Old chat' }],
    }));
    controller.responses.set('remote POST /api/sessions/raw%2Fid/branch', upstream({ sessionId: 'branch/id', name: 'Branch' }));
    controller.responses.set('remote GET /api/sessions/raw%2Fid/children', upstream({
      sessionIds: ['child/one', 'child/two'],
    }));
    controller.responses.set('remote POST /api/sessions/raw%2Fid/chat-attachments', upstream({
      url: '/api/sessions/raw%2Fid/chat-attachments/image.png', name: 'image.png', mime: 'image/png', size: 3,
    }));
    await start(controller);
    const qualified = qualifySessionId('remote', 'raw/id');

    assert.strictEqual((await authenticated(`/api/folders?sessionId=${encodeURIComponent(qualified)}`)).status, 200);
    assert.strictEqual(controller.requests.at(-1).path, '/api/folders?sessionId=raw%2Fid');

    assert.strictEqual((await authenticated('/api/set-working-dir', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: qualified, path: '/work' }),
    })).status, 200);
    assert.deepStrictEqual(JSON.parse(controller.requests.at(-1).body.toString()), { sessionId: 'raw/id', path: '/work' });

    const resumable = await (await authenticated('/api/sessions/resumable?dir=%2Fwork', {
      headers: { [CONTROLLER_HEADER]: 'remote' },
    })).json();
    assert.deepStrictEqual(parseQualifiedSessionId(resumable.conversations[0].id), { serverId: 'remote', sessionId: 'raw/id' });
    assert.strictEqual(resumable.conversations[0].serverName, 'Remote');

    const branch = await (await authenticated(`/api/sessions/${encodeURIComponent(qualified)}/branch`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })).json();
    assert.deepStrictEqual(parseQualifiedSessionId(branch.sessionId), { serverId: 'remote', sessionId: 'branch/id' });

    const children = await (await authenticated(
      `/api/sessions/${encodeURIComponent(qualified)}/children`,
    )).json();
    assert.deepStrictEqual(
      children.sessionIds.map(parseQualifiedSessionId),
      [
        { serverId: 'remote', sessionId: 'child/one' },
        { serverId: 'remote', sessionId: 'child/two' },
      ],
    );

    const attachment = await (await authenticated(`/api/sessions/${encodeURIComponent(qualified)}/chat-attachments`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from([1, 2, 3]),
    })).json();
    const attachmentId = decodeURIComponent(/^\/api\/sessions\/([^/]+)/.exec(attachment.url)[1]);
    assert.deepStrictEqual(parseQualifiedSessionId(attachmentId), { serverId: 'remote', sessionId: 'raw/id' });
  });

  it('rejects a successful upload descriptor that is absolute or belongs to another session or target', async function () {
    const controller = new MockController([{ id: 'remote', name: 'Remote', status: 'connected' }]);
    const qualified = qualifySessionId('remote', 'raw/id');
    const cases = [
      ['absolute', 'http://127.0.0.1:9999/private'],
      ['session', '/api/sessions/other/chat-attachments/image.png'],
      [
        'target',
        `/api/sessions/${encodeURIComponent(qualifySessionId('other', 'raw/id'))}/chat-attachments/image.png`,
      ],
    ];
    for (const [name, url] of cases) {
      controller.responses.set(
        `remote POST /api/sessions/raw%2Fid/chat-attachments?name=${name}`,
        upstream({ url, name: 'image.png', mime: 'image/png', size: 3 }),
      );
    }
    await start(controller);

    for (const [name] of cases) {
      const response = await authenticated(
        `/api/sessions/${encodeURIComponent(qualified)}/chat-attachments?name=${name}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: Buffer.from([1, 2, 3]),
        },
      );
      assert.strictEqual(response.status, 502);
      assert.strictEqual((await response.json()).error, 'controller_request_failed');
    }
  });

  it('rejects attachment capabilities smuggled through generic target JSON', async function () {
    const controller = new MockController([{ id: 'remote', name: 'Remote', status: 'connected' }]);
    const qualified = qualifySessionId('remote', 'raw/id');
    controller.responses.set('remote POST /api/sessions/raw%2Fid/branch', upstream({
      sessionId: 'branch/id',
      url: `/api/sessions/${encodeURIComponent(qualifySessionId('local', 'other'))}/chat-attachments/image.png`,
    }));
    await start(controller);

    const response = await authenticated(`/api/sessions/${encodeURIComponent(qualified)}/branch`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.strictEqual(response.status, 502);
    assert.match((await response.json()).message, /unsafe response/i);
  });

  it('streams fixed and chunked attachment bytes to their qualified owner without JSON routing', async function () {
    const controller = new MockController([{ id: 'remote', name: 'Remote', status: 'connected' }]);
    const qualified = qualifySessionId('remote', 'raw/id');
    const path = `/api/sessions/${encodeURIComponent(qualified)}/chat-attachments?name=photo.png`;
    const seen = [];
    controller.responses.set('remote POST /api/sessions/raw%2Fid/chat-attachments?name=photo.png', async (request) => {
      seen.push({ headers: request.headers, bytes: await requestBytes(request.body) });
      return upstream({
        url: '/api/sessions/raw%2Fid/chat-attachments/photo.png', name: 'photo.png', mime: 'image/png', size: seen.at(-1).bytes.length,
      });
    });
    await start(controller);

    // Cross the gateway's unrelated 16 MiB aggregate-response limit: upload
    // bytes must remain a stream all the way to the selected target.
    const fixed = Buffer.alloc(16 * 1024 * 1024 + 257);
    for (let index = 0; index < fixed.length; index += 1) fixed[index] = index % 251;
    const fixedResponse = await authenticated(path, {
      method: 'POST', headers: { 'content-type': 'image/png' }, body: fixed,
    });
    assert.strictEqual(fixedResponse.status, 200);
    assert.deepStrictEqual(seen[0].bytes, fixed);
    assert.strictEqual(seen[0].headers['content-type'], 'image/png');
    assert.strictEqual(seen[0].headers['content-length'], String(fixed.length));
    const attachment = await fixedResponse.json();
    assert.deepStrictEqual(parseQualifiedSessionId(decodeURIComponent(/^\/api\/sessions\/([^/]+)/.exec(attachment.url)[1])), {
      serverId: 'remote', sessionId: 'raw/id',
    });

    const chunked = [Buffer.from([0, 255, 1]), Buffer.alloc(17, 127), Buffer.from([2, 3, 4, 5])];
    const target = new URL(base);
    const response = await new Promise((resolve, reject) => {
      const request = http.request({
        hostname: target.hostname,
        port: target.port,
        method: 'POST',
        path,
        headers: { [CONTROLLER_AUTH_HEADER]: capability, 'content-type': 'application/octet-stream' },
      }, resolve);
      request.once('error', reject);
      for (const chunk of chunked) request.write(chunk);
      request.end();
    });
    assert.strictEqual(response.statusCode, 200);
    await requestBytes(response);
    assert.deepStrictEqual(seen[1].bytes, Buffer.concat(chunked));
    assert.strictEqual(seen[1].headers['content-type'], 'application/octet-stream');
    assert.strictEqual(seen[1].headers['content-length'], undefined);
  });

  it('aborts the selected upload when the renderer disconnects and permits an immediate retry', async function () {
    const controller = new MockController([{ id: 'local', name: 'Local', status: 'ready' }]);
    const qualified = qualifySessionId('local', 'raw/id');
    const uploadPath = `/api/sessions/${encodeURIComponent(qualified)}/chat-attachments?name=retry.bin`;
    let attempts = 0;
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    let markAborted;
    const aborted = new Promise((resolve) => { markAborted = resolve; });
    controller.responses.set('local POST /api/sessions/raw%2Fid/chat-attachments?name=retry.bin', async (request) => {
      attempts += 1;
      if (attempts === 1) {
        request.body.on('error', () => {});
        request.body.resume();
        request.signal.addEventListener('abort', () => markAborted(), { once: true });
        markStarted();
        await new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('renderer disconnected'), { name: 'AbortError', code: 'ABORT_ERR' }));
        }, { once: true }));
      }
      const bytes = await requestBytes(request.body);
      return upstream({
        url: '/api/sessions/raw%2Fid/chat-attachments/retry.bin',
        name: 'retry.bin',
        mime: 'application/octet-stream',
        size: bytes.length,
      });
    });
    await start(controller);

    const target = new URL(base);
    const renderer = http.request({
      hostname: target.hostname,
      port: target.port,
      method: 'POST',
      path: uploadPath,
      headers: {
        [CONTROLLER_AUTH_HEADER]: capability,
        'content-type': 'application/octet-stream',
      },
    });
    const rendererClosed = new Promise((resolve) => renderer.once('error', resolve));
    renderer.write(Buffer.alloc(4096, 7));
    await started;
    renderer.destroy();
    await rendererClosed;
    await aborted;
    assert.strictEqual(controller.requests[0].signal.aborted, true);

    const retry = await authenticated(uploadPath, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.from([1, 2, 3, 4]),
    });
    assert.strictEqual(retry.status, 200);
    assert.strictEqual((await retry.json()).size, 4);
    assert.strictEqual(attempts, 2);
  });

  it('observes a body abort while a remote connection failure is still pending', async function () {
    const controller = new MockController([{ id: 'remote', name: 'Remote', status: 'connected' }]);
    const qualified = qualifySessionId('remote', 'raw/id');
    const uploadPath = `/api/sessions/${encodeURIComponent(qualified)}/chat-attachments?name=retry.bin`;
    let attempts = 0;
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    let markTransportFailed;
    const transportFailed = new Promise((resolve) => { markTransportFailed = resolve; });
    controller.responses.set('remote POST /api/sessions/raw%2Fid/chat-attachments?name=retry.bin', async (request) => {
      attempts += 1;
      if (attempts === 1) {
        markStarted();
        await new Promise((resolve) => setTimeout(resolve, 50));
        markTransportFailed();
        throw Object.assign(new Error('remote TLS connection failed'), { code: 'UNREACHABLE' });
      }
      const bytes = await requestBytes(request.body);
      return upstream({
        url: '/api/sessions/raw%2Fid/chat-attachments/retry.bin',
        name: 'retry.bin', mime: 'application/octet-stream', size: bytes.length,
      });
    });
    await start(controller);

    const unhandled = [];
    const recordUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', recordUnhandled);
    try {
      const target = new URL(base);
      const renderer = http.request({
        hostname: target.hostname,
        port: target.port,
        method: 'POST',
        path: uploadPath,
        headers: {
          [CONTROLLER_AUTH_HEADER]: capability,
          'content-type': 'application/octet-stream',
        },
      });
      const rendererClosed = new Promise((resolve) => renderer.once('error', resolve));
      renderer.write(Buffer.alloc(1024, 7));
      await started;
      renderer.destroy();
      await Promise.all([rendererClosed, transportFailed]);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepStrictEqual(unhandled, [], 'body rejection is observed before delayed remote failure');

      const retry = await authenticated(uploadPath, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.from([1, 2, 3]),
      });
      assert.strictEqual(retry.status, 200);
      assert.strictEqual((await retry.json()).size, 3);
      assert.strictEqual(attempts, 2);
    } finally {
      process.removeListener('unhandledRejection', recordUnhandled);
    }
  });

  it('preserves attachment upstream error bytes and rejects the canonical 20 MiB boundary before forwarding', async function () {
    const controller = new MockController([{ id: 'remote', name: 'Remote', status: 'connected' }]);
    const qualified = qualifySessionId('remote', 'raw/id');
    const path = `/api/sessions/${encodeURIComponent(qualified)}/chat-attachments`;
    const upstreamError = Buffer.from([0, 255, 2, 254, 3]);
    controller.responses.set('remote POST /api/sessions/raw%2Fid/chat-attachments', async (request) => {
      const received = await requestBytes(request.body);
      if (received.length === MAX_ATTACHMENT_BYTES) {
        return upstream({
          url: '/api/sessions/raw%2Fid/chat-attachments/limit.bin',
          name: 'limit.bin',
          mime: 'application/octet-stream',
          size: received.length,
        });
      }
      return upstream(Readable.from([upstreamError.subarray(0, 2), upstreamError.subarray(2)]), {
        statusCode: 422,
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(upstreamError.length) },
      });
    });
    await start(controller);

    const rejected = await authenticated(path, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from([9, 8, 7, 6]),
    });
    assert.strictEqual(rejected.status, 422);
    assert.strictEqual(rejected.headers.get('content-type'), 'application/octet-stream');
    assert.strictEqual(rejected.headers.get('content-length'), String(upstreamError.length));
    assert.deepStrictEqual(Buffer.from(await rejected.arrayBuffer()), upstreamError);

    assert.strictEqual(MAX_ATTACHMENT_BYTES, 20 * 1024 * 1024);
    const atLimit = await authenticated(path, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(MAX_ATTACHMENT_BYTES, 6),
    });
    assert.strictEqual(atLimit.status, 200);
    assert.strictEqual((await atLimit.json()).size, MAX_ATTACHMENT_BYTES);

    const target = new URL(base);
    const tooLarge = await new Promise((resolve, reject) => {
      const request = http.request({
        hostname: target.hostname,
        port: target.port,
        method: 'POST',
        path,
        headers: {
          [CONTROLLER_AUTH_HEADER]: capability,
          'content-type': 'application/octet-stream',
          'content-length': String(MAX_ATTACHMENT_BYTES + 1),
        },
      }, resolve);
      request.once('error', reject);
      request.end(Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 5));
    });
    assert.strictEqual(tooLarge.statusCode, 413);
    const tooLargeBody = JSON.parse((await requestBytes(tooLarge)).toString('utf8'));
    assert.deepStrictEqual(tooLargeBody, {
      error: 'file_too_large',
      message: 'Attachment exceeds the 20 MiB limit',
      limitBytes: MAX_ATTACHMENT_BYTES,
    });
    assert.strictEqual(controller.requests.length, 2, 'the oversized request never reaches its owner');

    const chunkedTooLarge = await new Promise((resolve, reject) => {
      let received = false;
      const request = http.request({
        hostname: target.hostname,
        port: target.port,
        method: 'POST',
        path,
        headers: {
          [CONTROLLER_AUTH_HEADER]: capability,
          'content-type': 'application/octet-stream',
        },
      }, (response) => {
        received = true;
        resolve(response);
      });
      request.once('error', (error) => { if (!received) reject(error); });
      request.write(Buffer.alloc(MAX_ATTACHMENT_BYTES, 4));
      request.end(Buffer.from([5]));
    });
    assert.strictEqual(chunkedTooLarge.statusCode, 413);
    assert.strictEqual(JSON.parse((await requestBytes(chunkedTooLarge)).toString()).error, 'file_too_large');
    assert.strictEqual(controller.requests.length, 3, 'chunked size is enforced while streaming upstream');
    assert.strictEqual(
      controller.requests.at(-1).signal.aborted,
      true,
      'a client-size rejection is an aborted request, not a target health failure',
    );

    const retry = await authenticated(path, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from([1]),
    });
    assert.strictEqual(retry.status, 422, 'the selected target remains usable after a rejected upload');
  });

  it('keeps a chunked limit rejection at 413 through the real local transport abort', async function () {
    this.timeout(15_000);
    const rawSessionId = 'raw/id';
    const upstreamServer = http.createServer((request, response) => {
      let bytes = 0;
      request.on('data', (chunk) => { bytes += chunk.length; });
      request.on('error', () => undefined);
      request.on('end', () => {
        const body = Buffer.from(JSON.stringify({
          url: `/api/sessions/${encodeURIComponent(rawSessionId)}/chat-attachments/retry.bin`,
          name: 'retry.bin', mime: 'application/octet-stream', size: bytes,
        }));
        response.writeHead(200, {
          'content-type': 'application/json',
          'content-length': String(body.length),
        });
        response.end(body);
      });
    });
    await new Promise((resolve, reject) => {
      upstreamServer.once('error', reject);
      upstreamServer.listen(0, '127.0.0.1', resolve);
    });
    const upstreamAddress = upstreamServer.address();
    const transport = createLocalControllerTransport({
      origin: `http://127.0.0.1:${upstreamAddress.port}`,
      auth: { name: 'session', value: 'local-cookie' },
    });
    const controller = {
      listTargets: () => [{ id: 'local', name: 'Local computer', status: 'ready' }],
      request: (serverId, request) => {
        assert.strictEqual(serverId, 'local');
        return transport.requestTarget(request);
      },
      connectWebSocket: () => { throw new Error('not used'); },
    };
    try {
      await start(controller);
      const qualified = qualifySessionId('local', rawSessionId);
      const uploadPath = `/api/sessions/${encodeURIComponent(qualified)}/chat-attachments`;
      const target = new URL(base);
      const tooLarge = await new Promise((resolve, reject) => {
        let received = false;
        const request = http.request({
          hostname: target.hostname,
          port: target.port,
          method: 'POST',
          path: uploadPath,
          headers: {
            [CONTROLLER_AUTH_HEADER]: capability,
            'content-type': 'application/octet-stream',
          },
        }, (response) => {
          received = true;
          resolve(response);
        });
        request.once('error', (error) => { if (!received) reject(error); });
        request.write(Buffer.alloc(MAX_ATTACHMENT_BYTES, 7));
        request.end(Buffer.from([8]));
      });
      assert.strictEqual(tooLarge.statusCode, 413);
      assert.strictEqual(JSON.parse((await requestBytes(tooLarge)).toString()).error, 'file_too_large');

      const retry = await authenticated(uploadPath, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.from([1, 2, 3]),
      });
      assert.strictEqual(retry.status, 200);
      assert.strictEqual((await retry.json()).size, 3);
    } finally {
      upstreamServer.closeAllConnections?.();
      await new Promise((resolve) => upstreamServer.close(() => resolve()));
    }
  });

  it('forwards an early local attachment rejection without waiting for the renderer body', async function () {
    this.timeout(10_000);
    const rawSessionId = 'raw/id';
    const upstreamServer = http.createServer((request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.searchParams.get('name') === 'reject.bin') {
        const body = Buffer.from(JSON.stringify({ error: 'session_deleted', message: 'gone before body' }));
        response.writeHead(404, {
          connection: 'close',
          'content-type': 'application/json',
          'content-length': String(body.length),
        });
        response.end(body);
        return;
      }
      requestBytes(request).then((bytes) => {
        const body = Buffer.from(JSON.stringify({
          url: `/api/sessions/${encodeURIComponent(rawSessionId)}/chat-attachments/retry.bin`,
          name: 'retry.bin', mime: 'application/octet-stream', size: bytes.length,
        }));
        response.writeHead(200, {
          'content-type': 'application/json',
          'content-length': String(body.length),
        });
        response.end(body);
      }, () => response.destroy());
    });
    await new Promise((resolve, reject) => {
      upstreamServer.once('error', reject);
      upstreamServer.listen(0, '127.0.0.1', resolve);
    });
    const upstreamAddress = upstreamServer.address();
    const transport = createLocalControllerTransport({
      origin: `http://127.0.0.1:${upstreamAddress.port}`,
      auth: { name: 'session', value: 'local-cookie' },
    });
    const controller = {
      listTargets: () => [{ id: 'local', name: 'Local computer', status: 'ready' }],
      request: (serverId, request) => {
        assert.strictEqual(serverId, 'local');
        return transport.requestTarget(request);
      },
      connectWebSocket: () => { throw new Error('not used'); },
    };
    try {
      await start(controller);
      const qualified = qualifySessionId('local', rawSessionId);
      const uploadPath = `/api/sessions/${encodeURIComponent(qualified)}/chat-attachments`;
      const target = new URL(base);
      const early = await Promise.race([
        new Promise((resolve, reject) => {
          let received = false;
          const request = http.request({
            hostname: target.hostname,
            port: target.port,
            method: 'POST',
            path: `${uploadPath}?name=reject.bin`,
            headers: {
              [CONTROLLER_AUTH_HEADER]: capability,
              'content-type': 'application/octet-stream',
            },
          }, (response) => {
            received = true;
            resolve({ request, response });
          });
          request.once('error', (error) => { if (!received) reject(error); });
          // Deliberately keep the request writable. A pre-body 4xx must reach
          // the renderer even when the picker is still streaming a large file.
          request.write(Buffer.alloc(1024, 9));
        }),
        new Promise((_, reject) => setTimeout(
          () => reject(new Error('the early attachment rejection was not forwarded')),
          2_000,
        )),
      ]);
      assert.strictEqual(early.response.statusCode, 404);
      assert.deepStrictEqual(JSON.parse((await requestBytes(early.response)).toString()), {
        error: 'session_deleted', message: 'gone before body',
      });
      early.request.destroy();

      const retry = await authenticated(`${uploadPath}?name=retry.bin`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.from([1, 2, 3]),
      });
      assert.strictEqual(retry.status, 200);
      assert.strictEqual((await retry.json()).size, 3);
    } finally {
      upstreamServer.closeAllConnections?.();
      await new Promise((resolve) => upstreamServer.close(() => resolve()));
    }
  });

  it('multiplexes target sockets, qualifies inbound ids, and isolates outbound routing', async function () {
    const controller = new MockController([
      { id: 'local', name: 'Local', status: 'ready' },
      { id: 'remote', name: 'Remote', status: 'connected' },
    ]);
    controller.connectingIds.add('remote');
    await start(controller);
    const initialId = qualifySessionId('remote', 'same');
    const ws = new WebSocket(`${base.replace('http:', 'ws:')}?sessionId=${encodeURIComponent(initialId)}`, {
      headers: { [CONTROLLER_AUTH_HEADER]: capability, origin: base },
    });
    const messages = wsMessages(ws);
    await once(ws, 'open');
    for (let count = 0; count < 30 && controller.sockets.size < 2; count += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.strictEqual(controller.sockets.size, 2);
    assert.deepStrictEqual(controller.socketRequests.sort((a, b) => a.serverId.localeCompare(b.serverId)), [
      { serverId: 'local', path: '/' },
      { serverId: 'remote', path: '/?sessionId=same' },
    ]);

    ws.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepStrictEqual(controller.sockets.get('remote').sent, []);
    controller.sockets.get('remote').readyState = WebSocket.OPEN;
    controller.sockets.get('remote').emit('open');
    for (let count = 0; count < 30 && controller.sockets.get('remote').sent.length < 1; count += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepStrictEqual(controller.sockets.get('remote').sent, [{ type: 'resize', cols: 80, rows: 24 }]);
    assert.deepStrictEqual(controller.sockets.get('local').sent, []);

    controller.sockets.get('remote').upstream({ type: 'attention', sessionId: 'same' });
    for (let count = 0; count < 30 && !messages.some((message) => message.type === 'attention'); count += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const attention = messages.find((message) => message.type === 'attention');
    assert.deepStrictEqual(parseQualifiedSessionId(attention.sessionId), {
      serverId: 'remote', sessionId: 'same',
    });
    assert.strictEqual(attention.serverName, undefined);

    const messageCount = messages.length;
    controller.sockets.get('remote').upstream({
      type: 'chat_snapshot',
      sessionId: 'same',
      attachments: [{
        url: `/api/sessions/${encodeURIComponent(qualifySessionId('local', 'one'))}/chat-attachments/image.png`,
      }],
    });
    for (let count = 0; count < 30 && messages.length === messageCount; count += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(messages.some((message, index) => index >= messageCount
      && message.type === 'controller_error'
      && message.serverId === 'remote'
      && /invalid message/.test(message.message)));
    assert.ok(!messages.some((message, index) => index >= messageCount
      && message.type === 'chat_snapshot'));

    ws.send(JSON.stringify({
      type: 'reorder_tabs',
      sessionIds: [qualifySessionId('local', 'one'), qualifySessionId('remote', 'two')],
    }));
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.deepStrictEqual(controller.sockets.get('local').sent, []);
    assert.strictEqual(controller.sockets.get('remote').sent.length, 1);
    assert.ok(messages.some((message) => message.type === 'controller_error' && /cross-server/.test(message.message)));
    assert.ok(messages.some((message) => message.type === 'controller_server_status'
      && message.serverName === 'Remote'
      && message.status === 'connected'
      && Number.isFinite(message.lastSuccessfulContact)));
    ws.close();
    await once(ws, 'close');
  });

  it('closes the exact upstream immediately after sign-out without waiting for polling', async function () {
    const controller = new MockController([
      { id: 'local', name: 'Local', status: 'ready' },
      { id: 'remote', name: 'Remote', status: 'connected' },
    ]);
    await start(controller);
    const ws = new WebSocket(base.replace('http:', 'ws:'), {
      headers: { [CONTROLLER_AUTH_HEADER]: capability, origin: base },
    });
    await once(ws, 'open');
    for (let count = 0; count < 30 && controller.sockets.size < 2; count += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const local = controller.sockets.get('local');
    const remote = controller.sockets.get('remote');
    assert.strictEqual(remote.readyState, WebSocket.OPEN);

    const response = await authenticated('/api/controller/targets/remote/sign-out', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(remote.readyState, WebSocket.CLOSED);
    assert.strictEqual(local.readyState, WebSocket.OPEN);
    ws.close();
    await once(ws, 'close');
  });

  it('closes the old upstream immediately when an address edit waits for certificate approval', async function () {
    const controller = new MockController([
      { id: 'local', name: 'Local', status: 'ready' },
      { id: 'remote', name: 'Remote', status: 'connected' },
    ]);
    controller.actionResults.set('update', {
      success: false,
      requiresApproval: true,
      stagedDestinationChanged: true,
      target: {
        id: 'remote', name: 'Remote', status: 'certificate-error', stagedDestination: true,
        error: { code: 'TLS_CERTIFICATE', fingerprint256: 'AA:BB' },
      },
    });
    await start(controller);
    const ws = new WebSocket(base.replace('http:', 'ws:'), {
      headers: { [CONTROLLER_AUTH_HEADER]: capability, origin: base },
    });
    await once(ws, 'open');
    for (let count = 0; count < 30 && controller.sockets.size < 2; count += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const local = controller.sockets.get('local');
    const oldRemote = controller.sockets.get('remote');
    assert.strictEqual(oldRemote.readyState, WebSocket.OPEN);

    const response = await authenticated('/api/controller/targets/remote', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Remote', origin: 'https://replacement.example' }),
    });
    assert.strictEqual(response.status, 200);
    assert.strictEqual((await response.json()).requiresApproval, true);
    assert.strictEqual(oldRemote.readyState, WebSocket.CLOSED);
    assert.strictEqual(local.readyState, WebSocket.OPEN);
    ws.close();
    await once(ws, 'close');
  });

  it('keeps chat subscriptions background-scoped, filters attached streams, and reconnects drops', async function () {
    const controller = new MockController([
      { id: 'local', name: 'Local', status: 'ready' },
      { id: 'remote', name: 'Remote', status: 'connected' },
    ]);
    await start(controller, { upstreamReconnectMs: 10 });
    const initialId = qualifySessionId('remote', 'active');
    const ws = new WebSocket(`${base.replace('http:', 'ws:')}?sessionId=${encodeURIComponent(initialId)}`, {
      headers: { [CONTROLLER_AUTH_HEADER]: capability, origin: base },
    });
    const messages = wsMessages(ws);
    await once(ws, 'open');
    for (let count = 0; count < 30 && controller.sockets.size < 2; count += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    ws.send(JSON.stringify({ type: 'chat_subscribe', sessionId: qualifySessionId('local', 'background') }));
    ws.send(JSON.stringify({ type: 'resize', cols: 91, rows: 31 }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepStrictEqual(controller.sockets.get('local').sent, [{ type: 'chat_subscribe', sessionId: 'background' }]);
    assert.deepStrictEqual(controller.sockets.get('remote').sent, [{ type: 'resize', cols: 91, rows: 31 }]);

    controller.sockets.get('local').upstream({ type: 'output', data: 'wrong terminal' });
    controller.sockets.get('local').upstream({ type: 'attention', sessionId: 'background' });
    controller.sockets.get('remote').upstream({ type: 'output', data: 'active terminal' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(!messages.some((message) => message.data === 'wrong terminal'));
    assert.ok(messages.some((message) => message.data === 'active terminal'));
    assert.ok(messages.some((message) => message.type === 'attention'
      && parseQualifiedSessionId(message.sessionId)?.serverId === 'local'));

    controller.sockets.get('remote').close();
    for (let count = 0; count < 50 && (controller.socketHistory.get('remote')?.length || 0) < 2; count += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.strictEqual(controller.socketHistory.get('remote').length, 2);
    ws.close();
    await once(ws, 'close');
  });

  it('rejects unauthenticated and cross-origin WebSocket upgrades', async function () {
    const controller = new MockController([]);
    await start(controller);
    for (const options of [
      {},
      { headers: { [CONTROLLER_AUTH_HEADER]: capability, origin: 'https://attacker.example' } },
    ]) {
      const ws = new WebSocket(base.replace('http:', 'ws:'), options);
      const [error] = await once(ws, 'error');
      assert.match(error.message, /401/);
    }
  });
});
