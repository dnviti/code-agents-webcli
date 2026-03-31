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
