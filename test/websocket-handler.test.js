const assert = require('assert');
const { EventEmitter } = require('events');

const { WebSocketHandler } = require('../dist/server/websocket/handler.js');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
    this.closed = null;
  }

  send(value) { this.sent.push(JSON.parse(value)); }
  close(code, reason) { this.closed = { code, reason }; }
}

describe('WebSocket initial session admission', function () {
  it('queues terminal frames until the requested session has been joined', async function () {
    const joining = deferred();
    const handled = [];
    let joined = null;
    const connections = new Map();
    const processor = {
      joinSession(wsId, sessionId) {
        joined = { wsId, sessionId };
        return joining.promise;
      },
      async handleMessage(wsId, message) { handled.push({ wsId, message }); },
      cleanupConnection() {},
    };
    const handler = new WebSocketHandler({
      dev: false,
      claudeSessions: new Map([['project-shell', {}]]),
      webSocketConnections: connections,
      getAuthContext: () => ({ user: { id: 7, githubLogin: 'ada' } }),
    }, processor);
    const socket = new FakeSocket();

    handler.handleConnection(socket, { url: '/?sessionId=project-shell' });
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'resize', cols: 100, rows: 30 })));
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'start_terminal', options: {} })));
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(joined.sessionId, 'project-shell');
    assert.deepStrictEqual(handled, [], 'no terminal frame may overtake project admission');

    joining.resolve();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepStrictEqual(handled.map((entry) => entry.message.type), ['resize', 'start_terminal']);
    assert.ok(handled.every((entry) => entry.wsId === joined.wsId));
  });

  it('keeps start, Plan mode, and the first prompt in wire order', async function () {
    const chatStarted = deferred();
    const modeChanged = deferred();
    const handled = [];
    const connections = new Map();
    const processor = {
      async joinSession() {},
      async handleMessage(_wsId, message) {
        handled.push(`${message.type}:start`);
        if (message.type === 'start_chat') await chatStarted.promise;
        if (message.type === 'chat_set_plan_mode') await modeChanged.promise;
        handled.push(`${message.type}:end`);
      },
      cleanupConnection() {},
    };
    const handler = new WebSocketHandler({
      dev: false,
      claudeSessions: new Map(),
      webSocketConnections: connections,
      getAuthContext: () => ({ user: { id: 7, githubLogin: 'ada' } }),
    }, processor);
    const socket = new FakeSocket();

    handler.handleConnection(socket, { url: '/' });
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'start_chat',
      agentKind: 'codex',
      sessionId: 'planning',
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'chat_set_plan_mode',
      sessionId: 'planning',
      planMode: true,
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'chat_send',
      sessionId: 'planning',
      text: 'Prepare a plan',
    })));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepStrictEqual(
      handled,
      ['start_chat:start'],
      'Plan mode must wait until its chat has started',
    );

    chatStarted.resolve();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepStrictEqual(handled, [
      'start_chat:start',
      'start_chat:end',
      'chat_set_plan_mode:start',
    ]);

    modeChanged.resolve();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepStrictEqual(handled, [
      'start_chat:start',
      'start_chat:end',
      'chat_set_plan_mode:start',
      'chat_set_plan_mode:end',
      'chat_send:start',
      'chat_send:end',
    ]);
  });
});
