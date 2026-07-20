const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { MessageProcessor } = require('../dist/server/websocket/messages.js');
const { createSessionRoutes } = require('../dist/server/routes/sessions.js');
const { HistoryStore } = require('../dist/server/services/history-store.js');

function makeSession(id, ownerUserId) {
  return {
    id,
    ownerUserId,
    name: `sessione ${id}`,
    created: new Date('2026-01-02T03:04:05Z'),
    lastActivity: new Date('2026-01-02T04:00:00Z'),
    active: false,
    agent: null,
    lastAgent: null,
    runtimeLabel: null,
    terminalOptions: null,
    stopRequested: false,
    workingDir: '/home/tizio/progetto',
    connections: new Set(),
    outputBuffer: [],
    sessionStartTime: null,
    sessionUsage: {},
    maxBufferSize: 1000,
  };
}

/** Captures what the processor would have sent over the socket. */
function fakeSocket() {
  const sent = [];
  return {
    sent,
    ws: { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) },
  };
}

describe('history access control', function () {
  let dir;
  let historyStore;
  let sessions;

  beforeEach(async function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-access-'));
    historyStore = new HistoryStore({ storageDir: dir });

    sessions = new Map();
    sessions.set('owned', makeSession('owned', 1));
    sessions.set('someone-else', makeSession('someone-else', 2));

    historyStore.append({ id: 'someone-else', ownerUserId: 2 }, ['CHIAVE-PRIVATA-ALTRUI']);
    historyStore.append({ id: 'owned', ownerUserId: 1 }, ['roba mia']);
    await historyStore.stat({ id: 'owned', ownerUserId: 1 });
    await historyStore.stat({ id: 'someone-else', ownerUserId: 2 });
  });

  afterEach(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('history_request over the WebSocket', function () {
    function makeProcessor(connections) {
      return new MessageProcessor({
        dev: false,
        claudeSessions: sessions,
        webSocketConnections: connections,
        baseFolder: '/home',
        sessionDurationHours: 5,
        aliases: { claude: 'Claude', codex: 'Codex', agent: 'Agent' },
        validatePath: () => ({ valid: true, path: '/home' }),
        getSelectedWorkingDir: () => null,
        createSessionRecord: () => makeSession('x', 1),
        getRuntimeBridge: () => null,
        saveSessionsToDisk: async () => {},
        transcriptStore: {
          ensureTranscript: async () => '',
          appendOutput: () => {},
          readTranscriptChunks: async () => [],
          deleteTranscript: async () => {},
        },
        historyStore,
        usageReader: {},
        usageAnalytics: {},
      });
    }

    it('serves history for a session the caller owns', async function () {
      const socket = fakeSocket();
      const connections = new Map([['ws1', { id: 'ws1', userId: 1, claudeSessionId: 'owned', ws: socket.ws }]]);

      await makeProcessor(connections).handleMessage('ws1', {
        type: 'history_request',
        sessionId: 'owned',
        fromLine: 0,
        count: 10,
      });

      assert.strictEqual(socket.sent.length, 1);
      assert.strictEqual(socket.sent[0].type, 'history_chunk');
      assert.deepStrictEqual(socket.sent[0].lines, ['roba mia']);
    });

    it('refuses history for a session owned by another user', async function () {
      const socket = fakeSocket();
      const connections = new Map([['ws1', { id: 'ws1', userId: 1, claudeSessionId: 'owned', ws: socket.ws }]]);

      await makeProcessor(connections).handleMessage('ws1', {
        type: 'history_request',
        sessionId: 'someone-else',
        fromLine: 0,
        count: 10,
      });

      assert.strictEqual(socket.sent.length, 1);
      assert.strictEqual(socket.sent[0].type, 'error');
      const serialized = JSON.stringify(socket.sent);
      assert.ok(
        !serialized.includes('CHIAVE-PRIVATA-ALTRUI'),
        'another user\'s terminal history must never be sent',
      );
    });

    it('echoes the request id so a late reply cannot be mistaken for a fresh one', async function () {
      const socket = fakeSocket();
      const connections = new Map([['ws1', { id: 'ws1', userId: 1, claudeSessionId: 'owned', ws: socket.ws }]]);

      await makeProcessor(connections).handleMessage('ws1', {
        type: 'history_request',
        sessionId: 'owned',
        fromLine: 0,
        count: 10,
        requestId: 'req-42',
      });

      assert.strictEqual(socket.sent[0].requestId, 'req-42');
    });
  });

  describe('markdown export', function () {
    let server;
    let baseUrl;
    let currentUser;

    beforeEach(async function () {
      const app = express();
      app.use((_req, res, next) => {
        res.locals.authContext = { user: currentUser, authSessionId: null };
        next();
      });
      app.use(
        createSessionRoutes({
          claudeSessions: sessions,
          webSocketConnections: new Map(),
          baseFolder: '/home',
          dev: false,
          validatePath: () => ({ valid: true, path: '/home' }),
          createSessionRecord: () => makeSession('x', 1),
          getRuntimeBridge: () => null,
          saveSessionsToDisk: async () => {},
          transcriptStore: {
            ensureTranscript: async () => '',
            appendOutput: () => {},
            readTranscriptChunks: async () => [],
            deleteTranscript: async () => {},
          },
          historyStore,
          getScreenSnapshot: () => [],
          disposeRecorder: () => {},
          getSelectedWorkingDir: () => null,
          sessionStore: { getSessionMetadata: async () => ({}) },
        }),
      );

      await new Promise((resolve) => {
        server = app.listen(0, '127.0.0.1', resolve);
      });
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      currentUser = { id: 1, githubId: '1', githubLogin: 'tizio', githubName: null, avatarUrl: null, email: null };
    });

    afterEach(async function () {
      await new Promise((resolve) => server.close(resolve));
    });

    it('downloads the caller\'s own session as markdown', async function () {
      const response = await fetch(`${baseUrl}/api/sessions/owned/export.md`);
      assert.strictEqual(response.status, 200);
      assert.match(response.headers.get('content-type'), /text\/markdown/);
      assert.match(
        response.headers.get('content-disposition'),
        /attachment; filename="sessione-owned-2026-01-02\.md"/,
      );

      const body = await response.text();
      assert.ok(body.startsWith('# sessione owned'));
      assert.ok(body.includes('/home/tizio/progetto'));
      assert.ok(body.includes('roba mia'));
    });

    it('strips ANSI so the file is readable text', async function () {
      historyStore.append({ id: 'owned', ownerUserId: 1 }, [
        '\x1b[0;1;38;5;196mERRORE\x1b[0m qualcosa \x1b]0;titolo\x07finito',
      ]);
      await historyStore.stat({ id: 'owned', ownerUserId: 1 });

      const body = await (await fetch(`${baseUrl}/api/sessions/owned/export.md`)).text();
      assert.ok(body.includes('ERRORE qualcosa finito'));
      assert.ok(!body.includes('\x1b'), 'no escape sequences should reach the file');
    });

    it('refuses to export a session owned by another user', async function () {
      const response = await fetch(`${baseUrl}/api/sessions/someone-else/export.md`);
      assert.strictEqual(response.status, 404);
      const body = await response.text();
      assert.ok(!body.includes('CHIAVE-PRIVATA-ALTRUI'));
    });

    it('refuses to export without a signed-in user', async function () {
      currentUser = null;
      const response = await fetch(`${baseUrl}/api/sessions/owned/export.md`);
      assert.strictEqual(response.status, 401);
    });
  });
});
