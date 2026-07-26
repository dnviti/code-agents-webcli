const assert = require('assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { SessionStore } = require('../dist/server/services/session-store.js');

describe('SessionStore', function() {
  let sessionStore;
  let tempDir;
  let ownerUserId;

  beforeEach(async function() {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'code-agents-webcli-sessions-'));
    sessionStore = new SessionStore({ dataDir: tempDir });
    ownerUserId = sessionStore.database.upsertGitHubUser({
      githubId: '1001',
      githubLogin: 'tester',
      githubName: 'Test User',
      email: 'tester@example.com'
    }).id;
  });

  afterEach(async function() {
    sessionStore.database.close();

    // Clean up temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('saveSessions', function() {
    it('should save sessions to sqlite', async function() {
      const now = new Date();
      const testSessions = new Map([
        ['session1', createSessionRecord({
          ownerUserId,
          created: now,
          lastActivity: now,
        })]
      ]);

      const saved = await sessionStore.saveSessions(testSessions);
      const dbExists = await fs.access(sessionStore.dbPath).then(() => true).catch(() => false);
      const row = sessionStore.database.raw
        .prepare('SELECT COUNT(*) AS count FROM runtime_sessions')
        .get();

      assert.strictEqual(saved, true);
      assert.strictEqual(dbExists, true);
      assert.strictEqual(row.count, 1);
    });
  });

  describe('loadSessions', function() {
    it('should return empty Map when no session exists in sqlite', async function() {
      const sessions = await sessionStore.loadSessions();
      assert(sessions instanceof Map);
      assert.strictEqual(sessions.size, 0);
    });

    it('should load sessions from sqlite', async function() {
      const now = new Date();

      // First save some sessions
      const testSessions = new Map([
        ['session1', createSessionRecord({
          ownerUserId,
          created: now,
          lastActivity: now,
          lastAgent: 'terminal',
          runtimeLabel: 'watch podman ps',
          terminalOptions: {
            mode: 'command',
            shell: 'bash',
            command: 'watch podman ps'
          }
        })]
      ]);

      await sessionStore.saveSessions(testSessions);
      sessionStore.database.close();
      sessionStore = new SessionStore({ dataDir: tempDir });

      // Then load them
      const loadedSessions = await sessionStore.loadSessions();
      assert(loadedSessions instanceof Map);
      assert.strictEqual(loadedSessions.size, 1);
      assert(loadedSessions.has('session1'));
      assert.strictEqual(loadedSessions.get('session1').ownerUserId, ownerUserId);
      assert.strictEqual(loadedSessions.get('session1').lastAgent, 'terminal');
      assert.strictEqual(loadedSessions.get('session1').runtimeLabel, 'watch podman ps');
      assert.deepStrictEqual(loadedSessions.get('session1').terminalOptions, {
        mode: 'command',
        shell: 'bash',
        command: 'watch podman ps'
      });
    });

    it('remembers which conversation a shell belonged to', async function() {
      // The one fact that keeps a conversation's terminal out of every tab
      // strip. Lost across a restart, the shell would come back looking like a
      // standalone session on every device the user has open.
      await sessionStore.saveSessions(new Map([
        ['chat', createSessionRecord({ id: 'chat', ownerUserId, surface: 'chat' })],
        ['shell', createSessionRecord({ id: 'shell', ownerUserId, ownerSessionId: 'chat' })],
      ]));
      sessionStore.database.close();
      sessionStore = new SessionStore({ dataDir: tempDir });

      const loaded = await sessionStore.loadSessions();
      assert.strictEqual(loaded.get('shell').ownerSessionId, 'chat');
      // Absent, not empty-string: `undefined` is what reads as "standalone".
      assert.strictEqual(loaded.get('chat').ownerSessionId, undefined);
    });

    it('remembers the approval mode a conversation was running in', async function() {
      // The mode is part of how the user set the conversation up. Lost across a
      // restart, a chat started with approvals bypassed comes back asking for
      // them — and the header says nothing about the change.
      await sessionStore.saveSessions(new Map([
        ['bypass', createSessionRecord({
          id: 'bypass',
          ownerUserId,
          surface: 'chat',
          chatBypassPermissions: true,
        })],
        ['manual', createSessionRecord({ id: 'manual', ownerUserId, surface: 'chat' })],
      ]));
      sessionStore.database.close();
      sessionStore = new SessionStore({ dataDir: tempDir });

      const loaded = await sessionStore.loadSessions();
      assert.strictEqual(loaded.get('bypass').chatBypassPermissions, true);
      // Absent rather than false: a conversation that never chose the bypass
      // must never be restored into it, and `undefined` is what reads as
      // "asks first" everywhere downstream.
      assert.strictEqual(loaded.get('manual').chatBypassPermissions, undefined);
    });

    it('remembers a conversation-scoped model override', async function () {
      // The override is per conversation, not a new default: a restart must
      // bring back exactly the choice made for this record and nothing for
      // any other, and a record that never set one must read as "no override"
      // rather than an empty string.
      await sessionStore.saveSessions(new Map([
        ['custom', createSessionRecord({
          id: 'custom',
          ownerUserId,
          surface: 'chat',
          chatModelOverride: 'grok-3-fast',
        })],
        ['default', createSessionRecord({ id: 'default', ownerUserId, surface: 'chat' })],
      ]));
      sessionStore.database.close();
      sessionStore = new SessionStore({ dataDir: tempDir });

      const loaded = await sessionStore.loadSessions();
      assert.strictEqual(loaded.get('custom').chatModelOverride, 'grok-3-fast');
      assert.strictEqual(loaded.get('default').chatModelOverride, undefined);
    });

    it('adds the model-override column to a database that predates it', async function () {
      await sessionStore.saveSessions(new Map([
        ['old', createSessionRecord({ id: 'old', ownerUserId, surface: 'chat' })],
      ]));
      sessionStore.database.raw.exec(
        'ALTER TABLE runtime_sessions DROP COLUMN chat_model_override',
      );
      sessionStore.database.close();

      sessionStore = new SessionStore({ dataDir: tempDir });
      const loaded = await sessionStore.loadSessions();

      assert.strictEqual(loaded.size, 1, 'the upgrade must not cost the user their sessions');
      assert.strictEqual(loaded.get('old').chatModelOverride, undefined);

      sessionStore.database.close();
      sessionStore = new SessionStore({ dataDir: tempDir });
      assert.strictEqual((await sessionStore.loadSessions()).size, 1);
    });

    it('adds the approval-mode column to a database that predates it', async function () {
      // Every install being upgraded has a session table written by an older
      // build. The column is added on boot rather than by a migration file, so
      // the thing worth proving is that the boot path finds a table without it,
      // adds it, and leaves the rows that were already there alone.
      await sessionStore.saveSessions(new Map([
        ['old', createSessionRecord({ id: 'old', ownerUserId, surface: 'chat' })],
      ]));
      sessionStore.database.raw.exec(
        'ALTER TABLE runtime_sessions DROP COLUMN chat_bypass_permissions',
      );
      sessionStore.database.close();

      sessionStore = new SessionStore({ dataDir: tempDir });
      const loaded = await sessionStore.loadSessions();

      assert.strictEqual(loaded.size, 1, 'the upgrade must not cost the user their sessions');
      assert.strictEqual(loaded.get('old').chatBypassPermissions, undefined);

      // And again on the next boot: the column is there now, and asking for it
      // twice is an error rather than a no-op in SQLite.
      sessionStore.database.close();
      sessionStore = new SessionStore({ dataDir: tempDir });
      assert.strictEqual((await sessionStore.loadSessions()).size, 1);
    });
  });
});

function createSessionRecord(overrides = {}) {
  const created = overrides.created || new Date();
  const lastActivity = overrides.lastActivity || created;

  return {
    id: 'session1',
    ownerUserId: 1,
    name: 'Test Session',
    created,
    lastActivity,
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
    sessionUsage: {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheTokens: 0,
      totalCost: 0,
      models: {}
    },
    maxBufferSize: 1000,
    ...overrides
  };
}
