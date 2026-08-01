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

    it('remembers whether a conversation is in the account tab strip', async function () {
      await sessionStore.saveSessions(new Map([
        ['closed', createSessionRecord({
          id: 'closed',
          ownerUserId,
          surface: 'chat',
          tabOpen: false,
        })],
        ['legacy-open', createSessionRecord({
          id: 'legacy-open',
          ownerUserId,
          surface: 'chat',
        })],
      ]));
      sessionStore.database.close();
      sessionStore = new SessionStore({ dataDir: tempDir });

      const loaded = await sessionStore.loadSessions();
      assert.strictEqual(loaded.get('closed').tabOpen, false);
      assert.strictEqual(
        loaded.get('legacy-open').tabOpen,
        undefined,
        'a pre-feature record remains visibly open but available for one-time migration',
      );
    });

    it('remembers the account-owned tab order while leaving legacy rows unordered', async function () {
      await sessionStore.saveSessions(new Map([
        ['first', createSessionRecord({ id: 'first', ownerUserId, tabOrder: 0 })],
        ['second', createSessionRecord({ id: 'second', ownerUserId, tabOrder: 1 })],
        ['legacy', createSessionRecord({ id: 'legacy', ownerUserId })],
      ]));
      sessionStore.database.close();
      sessionStore = new SessionStore({ dataDir: tempDir });

      const loaded = await sessionStore.loadSessions();
      assert.strictEqual(loaded.get('first').tabOrder, 0);
      assert.strictEqual(loaded.get('second').tabOrder, 1);
      assert.strictEqual(
        loaded.get('legacy').tabOrder,
        undefined,
        'an upgraded database preserves the pre-feature stable load order',
      );
    });

    it('keeps project container paths distinct from host paths', async function() {
      const insertProject = sessionStore.database.raw.prepare(`
        INSERT INTO projects (
          id, owner_user_id, name, state, last_activity_at, created_at, updated_at
        ) VALUES (?, ?, ?, 'stopped', ?, ?, ?)
      `);
      const now = new Date().toISOString();
      for (const id of ['project-1', 'project-2', 'project-3']) {
        insertProject.run(id, ownerUserId, id, now, now, now);
      }

      await sessionStore.saveSessions(new Map([
        ['container', createSessionRecord({
          id: 'container',
          ownerUserId,
          projectId: 'project-1',
          workingDir: '/opt/disposable-work',
          projectWorkingDirKind: 'container',
        })],
        ['host', createSessionRecord({
          id: 'host',
          ownerUserId,
          projectId: 'project-2',
          workingDir: '/host/project-workspace',
          projectWorkingDirKind: 'host',
        })],
        ['legacy', createSessionRecord({
          id: 'legacy',
          ownerUserId,
          projectId: 'project-3',
          workingDir: '/host/legacy-project-workspace',
        })],
      ]));
      sessionStore.database.close();
      sessionStore = new SessionStore({ dataDir: tempDir });

      const loaded = await sessionStore.loadSessions();
      assert.strictEqual(loaded.get('container').projectWorkingDirKind, 'container');
      assert.strictEqual(loaded.get('container').workingDir, '/opt/disposable-work');
      assert.strictEqual(loaded.get('host').projectWorkingDirKind, 'host');
      assert.strictEqual(loaded.get('legacy').projectWorkingDirKind, undefined);
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
      // Absent, not false: this record has never been launched at all, so
      // nothing has been granted to it either way.
      assert.strictEqual(loaded.get('manual').chatBypassPermissions, undefined);
    });

    it('keeps “granted approvals” apart from “nothing granted”', async function () {
      // Three states, not two, since #134. A conversation that launched and
      // asked is recorded as `false`, which is a decision the rule replays on
      // every resume; a record that has never launched is `undefined`, and is
      // the only one a preference may ever decide for. Stored as the same
      // value they used to share, a preference switched on afterwards would
      // widen a conversation that had already chosen to ask.
      await sessionStore.saveSessions(new Map([
        ['asked', createSessionRecord({
          id: 'asked',
          ownerUserId,
          surface: 'chat',
          chatBypassPermissions: false,
        })],
        ['never', createSessionRecord({ id: 'never', ownerUserId, surface: 'chat' })],
      ]));
      sessionStore.database.close();
      sessionStore = new SessionStore({ dataDir: tempDir });

      const loaded = await sessionStore.loadSessions();
      assert.strictEqual(loaded.get('asked').chatBypassPermissions, false);
      assert.strictEqual(loaded.get('never').chatBypassPermissions, undefined);
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

    // Three states, and all three have to survive: a name, "launched with no
    // model flag at all", and "nothing recorded". A restart is precisely when
    // this is read — it is the moment every open conversation gets relaunched —
    // so a pin held only in memory would be gone exactly when it is needed
    // (#135). The middle one is why the column is not just nullable text: a
    // conversation that ran bare must not be re-modelled by a profile added
    // afterwards.
    it('remembers the model a conversation was launched on, including “none”', async function () {
      await sessionStore.saveSessions(new Map([
        ['pinned', createSessionRecord({
          id: 'pinned',
          ownerUserId,
          surface: 'chat',
          chatModelPinned: 'claude-opus-4-6',
        })],
        ['bare', createSessionRecord({
          id: 'bare',
          ownerUserId,
          surface: 'chat',
          chatModelPinned: null,
        })],
        ['unlaunched', createSessionRecord({ id: 'unlaunched', ownerUserId, surface: 'chat' })],
      ]));
      sessionStore.database.close();
      sessionStore = new SessionStore({ dataDir: tempDir });

      const loaded = await sessionStore.loadSessions();
      assert.strictEqual(loaded.get('pinned').chatModelPinned, 'claude-opus-4-6');
      assert.strictEqual(
        loaded.get('bare').chatModelPinned,
        null,
        'it ran with no flag, which is an answer and not an absence',
      );
      assert.strictEqual(
        loaded.get('unlaunched').chatModelPinned,
        undefined,
        'and nothing recorded still reads as nothing recorded',
      );
    });

    it('remembers the name the user gave a session', async function () {
      // The one moment a chosen name matters most is coming back to a set of
      // long-running sessions after a restart, which is exactly the moment it
      // has to survive. A session nobody renamed reads as "never renamed", not
      // as an empty name.
      await sessionStore.saveSessions(new Map([
        ['named', createSessionRecord({ id: 'named', ownerUserId, customName: 'the good one' })],
        ['plain', createSessionRecord({ id: 'plain', ownerUserId })],
      ]));
      sessionStore.database.close();
      sessionStore = new SessionStore({ dataDir: tempDir });

      const loaded = await sessionStore.loadSessions();
      assert.strictEqual(loaded.get('named').customName, 'the good one');
      assert.strictEqual(loaded.get('plain').customName, undefined);
      assert.strictEqual(
        loaded.get('named').name,
        createSessionRecord({ id: 'named', ownerUserId }).name,
        'the created name is kept alongside the chosen one',
      );
    });

    it('adds the custom-name column to a database that predates it', async function () {
      await sessionStore.saveSessions(new Map([
        ['old', createSessionRecord({ id: 'old', ownerUserId })],
      ]));
      sessionStore.database.raw.exec('ALTER TABLE runtime_sessions DROP COLUMN custom_name');
      sessionStore.database.close();

      sessionStore = new SessionStore({ dataDir: tempDir });
      const loaded = await sessionStore.loadSessions();

      assert.strictEqual(loaded.size, 1, 'the upgrade must not cost the user their sessions');
      assert.strictEqual(loaded.get('old').customName, undefined);
    });

    it('adds the tab-open column to a database that predates it', async function () {
      await sessionStore.saveSessions(new Map([
        ['old', createSessionRecord({ id: 'old', ownerUserId, surface: 'chat' })],
      ]));
      sessionStore.database.raw.exec('ALTER TABLE runtime_sessions DROP COLUMN tab_open');
      sessionStore.database.close();

      sessionStore = new SessionStore({ dataDir: tempDir });
      const loaded = await sessionStore.loadSessions();

      assert.strictEqual(loaded.size, 1, 'the upgrade must not cost the user their sessions');
      assert.strictEqual(
        loaded.get('old').tabOpen,
        undefined,
        'every pre-feature tab remains visibly open and marked as not yet migrated',
      );

      sessionStore.database.close();
      sessionStore = new SessionStore({ dataDir: tempDir });
      assert.strictEqual((await sessionStore.loadSessions()).get('old').tabOpen, undefined);
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

    it('adds the launched-model column to a database that predates it', async function () {
      await sessionStore.saveSessions(new Map([
        ['old', createSessionRecord({ id: 'old', ownerUserId, surface: 'chat' })],
      ]));
      sessionStore.database.raw.exec(
        'ALTER TABLE runtime_sessions DROP COLUMN chat_model_pinned',
      );
      sessionStore.database.close();

      sessionStore = new SessionStore({ dataDir: tempDir });
      const loaded = await sessionStore.loadSessions();

      assert.strictEqual(loaded.size, 1, 'the upgrade must not cost the user their sessions');
      // Absent, not null: a row from before the column existed recorded no
      // launch, so it still falls to the profile exactly as it did then.
      assert.strictEqual(loaded.get('old').chatModelPinned, undefined);
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
