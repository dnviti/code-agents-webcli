const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { createSessionRoutes } = require('../dist/server/routes/sessions.js');
const { HistoryStore } = require('../dist/server/services/history-store.js');

/**
 * A downloaded transcript gets opened in editors and `cat`ed into terminals, so
 * nothing in it may still be an escape sequence, and nothing in the recorded
 * output may close the code fence and start being interpreted as Markdown.
 */
describe('markdown export sanitising', function () {
  let dir;
  let historyStore;
  let server;
  let baseUrl;
  const SESSION_ID = 'export-test';

  const session = {
    id: SESSION_ID,
    ownerUserId: 1,
    name: 'prova',
    created: new Date('2026-05-06T00:00:00Z'),
    lastActivity: new Date('2026-05-06T01:00:00Z'),
    active: false,
    agent: null,
    lastAgent: null,
    runtimeLabel: null,
    terminalOptions: null,
    stopRequested: false,
    workingDir: '/tmp',
    connections: new Set(),
    outputBuffer: [],
    sessionStartTime: null,
    sessionUsage: {},
    maxBufferSize: 1000,
  };

  beforeEach(async function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-export-'));
    historyStore = new HistoryStore({ storageDir: dir });

    const sessions = new Map([[SESSION_ID, session]]);
    const app = express();
    app.use((_req, res, next) => {
      res.locals.authContext = {
        user: { id: 1, githubId: '1', githubLogin: 'tizio', githubName: null, avatarUrl: null, email: null },
        authSessionId: null,
      };
      next();
    });
    app.use(
      createSessionRoutes({
        claudeSessions: sessions,
        webSocketConnections: new Map(),
        baseFolder: '/tmp',
        dev: false,
        validatePath: () => ({ valid: true, path: '/tmp' }),
        createSessionRecord: () => session,
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
  });

  afterEach(async function () {
    // Undrained keep-alive sockets keep close() pending forever.
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function exportWith(lines) {
    historyStore.append({ id: SESSION_ID, ownerUserId: 1 }, lines);
    await historyStore.stat({ id: SESSION_ID, ownerUserId: 1 });
    return (await fetch(`${baseUrl}/api/sessions/${SESSION_ID}/export.md`)).text();
  }

  const nasty = [
    ['SGR', '\x1b[0;1;31mrosso\x1b[0m'],
    ['colon-form SGR', '\x1b[38:2::255:0:0mcolonne\x1b[0m'],
    ['private CSI', '\x1b[>c\x1b[?25l visibile'],
    ['OSC with BEL', '\x1b]0;titolo\x07testo'],
    ['OSC 8 hyperlink', '\x1b]8;;http://evil.example\x07clicca\x1b]8;;\x07'],
    ['OSC with ST', '\x1b]2;altro\x1b\\dopo'],
    ['DCS', '\x1b P+q544e\x1b\\finito'.replace(' ', '')],
    ['APC', '\x1b_apc-payload\x1b\\coda'],
    ['charset designator', '\x1b#8riempimento'],
    ['bare control bytes', 'prima\x00\x08\x07dopo'],
  ];

  nasty.forEach(function ([label, payload]) {
    it(`strips ${label} completely`, async function () {
      const body = await exportWith([payload]);
      assert.ok(!body.includes('\x1b'), `an ESC survived for ${label}`);
      assert.ok(!body.includes('\x07'), `a BEL survived for ${label}`);
    });
  });

  it('keeps the visible text while removing the sequences', async function () {
    const body = await exportWith(['\x1b[0;1;31mERRORE\x1b[0m: \x1b]0;t\x07qualcosa è andato storto']);
    assert.ok(body.includes('ERRORE: qualcosa è andato storto'), body.slice(0, 400));
  });

  it('cannot be made to close its own code fence', async function () {
    const body = await exportWith(['`'.repeat(40), 'non piu dentro il blocco?']);
    const fences = body.split('\n').filter((line) => /^`{10,}$/.test(line));
    assert.strictEqual(fences.length, 2, 'exactly the opening and closing fence');
  });

  it('does not let a session name inject a response header', async function () {
    session.name = 'evil"\r\nX-Injected: si\r\n\r\n<script>';
    const response = await fetch(`${baseUrl}/api/sessions/${SESSION_ID}/export.md`);
    await response.text();
    const disposition = response.headers.get('content-disposition');
    assert.ok(!/[\r\n]/.test(disposition), disposition);
    assert.ok(!response.headers.get('x-injected'));
    session.name = 'prova';
  });
});
