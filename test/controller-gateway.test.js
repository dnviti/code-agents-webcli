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
  createControllerGateway,
} = require('../desktop/controller-gateway.js');
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
    return typeof response === 'function' ? response(request) : response;
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

    const attachment = await (await authenticated(`/api/sessions/${encodeURIComponent(qualified)}/chat-attachments`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from([1, 2, 3]),
    })).json();
    const attachmentId = decodeURIComponent(/^\/api\/sessions\/([^/]+)/.exec(attachment.url)[1]);
    assert.deepStrictEqual(parseQualifiedSessionId(attachmentId), { serverId: 'remote', sessionId: 'raw/id' });
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
