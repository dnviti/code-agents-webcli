const assert = require('assert');
const crypto = require('crypto');
const fsSync = require('fs');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { SessionStore } = require('../dist/server/services/session-store.js');
const {
  WorkspaceSessionDatabase,
} = require('../dist/server/services/workspace-session-database.js');
const { openDatabase } = require('../dist/server/services/sqlite.js');
const {
  openWorkspaceStorageDirectorySync,
} = require('../dist/server/services/workspace-session-storage.js');

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

    it('round-trips plan mode and reads a pre-migration row as off', async function () {
      await sessionStore.saveSessions(new Map([
        ['planning', createSessionRecord({ id: 'planning', ownerUserId, surface: 'chat', chatPlanMode: true })],
        ['ordinary', createSessionRecord({ id: 'ordinary', ownerUserId, surface: 'chat' })],
      ]));
      sessionStore.database.close();
      sessionStore = new SessionStore({ dataDir: tempDir });
      let loaded = await sessionStore.loadSessions();
      assert.strictEqual(loaded.get('planning').chatPlanMode, true);
      assert.strictEqual(loaded.get('ordinary').chatPlanMode, false);

      sessionStore.database.raw.exec('ALTER TABLE runtime_sessions DROP COLUMN chat_plan_mode');
      sessionStore.database.close();
      sessionStore = new SessionStore({ dataDir: tempDir });
      loaded = await sessionStore.loadSessions();
      assert.strictEqual(loaded.get('planning').chatPlanMode, false, 'a pre-plan row must never be restored in plan mode');
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

  describe('workspace-local state', function () {
    it('round-trips bounded composer drafts in the workspace database only', async function () {
      const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-workspace-draft-'));
      const scope = { workspaceRoot, ownerKey: '4'.repeat(64) };
      let store = new SessionStore(scope);
      try {
        const draft = {
          text: 'finish this after restart',
          attachments: [{
            url: '/api/sessions/draft-session/chat-attachments/0123456789ab-photo.png',
            name: 'photo.png',
            mime: 'image/png',
            size: 123,
          }],
          revision: 7,
        };
        await store.saveSessions(new Map([
          ['draft-session', createSessionRecord({
            id: 'draft-session', ownerUserId, surface: 'chat', storageScope: scope,
            workingDir: workspaceRoot, chatDraft: draft,
          })],
        ]));
        store.database.close();

        store = new SessionStore(scope);
        assert.deepStrictEqual((await store.loadSessions()).get('draft-session').chatDraft, draft);

        store.database.raw.prepare(`
          UPDATE runtime_sessions SET chat_draft_json = ? WHERE owner_key = ? AND id = ?
        `).run(JSON.stringify({
          text: 'forged', revision: 8,
          attachments: [{ url: '/etc/passwd', name: 'passwd' }],
        }), scope.ownerKey, 'draft-session');
        store.database.close();
        store = new SessionStore(scope);
        assert.deepStrictEqual(
          (await store.loadSessions()).get('draft-session').chatDraft,
          { text: 'forged', attachments: [], revision: 8 },
          'untrusted attachment paths are discarded through the normal draft validator',
        );
      } finally {
        try { store.database.close(); } catch { /* already closed */ }
        await fs.rm(workspaceRoot, { recursive: true, force: true });
      }
    });

    it('uses the portable handle/stat backend without changing workspace-root permissions', async function () {
      const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-workspace-portable-'));
      const customIgnore = Buffer.from('keep-this-byte-for-byte\n');
      try {
        await fs.chmod(workspaceRoot, 0o755);
        await fs.mkdir(path.join(workspaceRoot, '.cc-web'), { mode: 0o755 });
        await fs.writeFile(path.join(workspaceRoot, '.cc-web', '.gitignore'), customIgnore);

        const lease = openWorkspaceStorageDirectorySync(workspaceRoot, { forcePathFallback: true });
        assert.strictEqual(lease.accessPath, path.join(workspaceRoot, '.cc-web'));
        fsSync.writeFileSync(path.join(lease.accessPath, 'portable-check'), 'ok', { mode: 0o600 });
        lease.close();
        lease.close();

        assert.deepStrictEqual(
          await fs.readFile(path.join(workspaceRoot, '.cc-web', '.gitignore')),
          customIgnore,
        );
        assert.strictEqual((await fs.stat(workspaceRoot)).mode & 0o777, 0o755);
        assert.strictEqual((await fs.stat(path.join(workspaceRoot, '.cc-web'))).mode & 0o777, 0o700);
      } finally {
        await fs.rm(workspaceRoot, { recursive: true, force: true });
      }
    });

    it('refuses SQLite entry mutations on an unproved pathname fallback', async function () {
      const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-workspace-db-deny-'));
      const ownerKey = 'd'.repeat(64);
      const databasePath = path.join(workspaceRoot, '.cc-web', 'session-state.sqlite');
      await fs.mkdir(path.dirname(databasePath), { recursive: true, mode: 0o700 });
      try {
        assert.throws(
          () => new WorkspaceSessionDatabase({
            workspaceRoot,
            ownerKey,
            workspaceStorageOpenOptions: { forcePathFallback: true },
          }),
          (error) => error && error.code === 'UNSAFE_WORKSPACE_STORAGE'
            && /descriptor-relative|handle-pinned/i.test(error.message),
        );
        assert.strictEqual(fsSync.existsSync(databasePath), false);
        assert.deepStrictEqual(await fs.readdir(path.dirname(databasePath)), []);
      } finally {
        await fs.rm(workspaceRoot, { recursive: true, force: true });
      }
    });

    it('keeps the global database import-only even when no workspace can be loaded', async function () {
      await sessionStore.saveSessions(new Map([
        ['blocked-legacy', createSessionRecord({ id: 'blocked-legacy', ownerUserId })],
      ]));
      const coordinator = new SessionStore({
        database: sessionStore.database,
        workspaceCoordinator: true,
      });

      assert.strictEqual(await coordinator.saveSessions(new Map()), true);
      assert.strictEqual(
        sessionStore.database.raw.prepare(
          'SELECT COUNT(*) AS count FROM runtime_sessions WHERE id = ?',
        ).get('blocked-legacy').count,
        1,
      );
    });

    it('keeps a migration-blocked record read-only without copying it into either database', async function () {
      const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-workspace-blocked-'));
      const scope = { workspaceRoot, ownerKey: '9'.repeat(64) };
      const coordinator = new SessionStore({
        database: sessionStore.database,
        workspaceCoordinator: true,
      });
      try {
        const blocked = createSessionRecord({
          id: 'blocked-visible-only',
          ownerUserId,
          storageScope: scope,
          persistenceUnavailable: 'Workspace is read-only',
        });

        assert.strictEqual(
          await coordinator.saveSessions(new Map([[blocked.id, blocked]])),
          true,
        );
        assert.strictEqual(
          sessionStore.database.raw.prepare(
            'SELECT COUNT(*) AS count FROM runtime_sessions WHERE id = ?',
          ).get(blocked.id).count,
          0,
          'an autosave must not create a new legacy/global copy',
        );
        assert.strictEqual(
          fsSync.existsSync(path.join(workspaceRoot, '.cc-web', 'session-state.sqlite')),
          false,
          'an autosave must not materialise a partial workspace row either',
        );
      } finally {
        coordinator.closeWorkspaces();
        await fs.rm(workspaceRoot, { recursive: true, force: true });
      }
    });

    it('preserves scoped rows withheld by a persistence gate during mixed and all-gated autosaves', async function () {
      const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-workspace-gated-save-'));
      const scope = { workspaceRoot, ownerKey: '7'.repeat(64) };
      const coordinator = new SessionStore({
        database: sessionStore.database,
        workspaceCoordinator: true,
      });
      try {
        const gated = createSessionRecord({
          id: 'gated-existing', ownerUserId, name: 'Persisted gated row', storageScope: scope,
        });
        const healthy = createSessionRecord({
          id: 'healthy-existing', ownerUserId, name: 'Persisted healthy row', storageScope: scope,
        });
        assert.strictEqual(
          await coordinator.saveSessions(new Map([[gated.id, gated], [healthy.id, healthy]])),
          true,
        );

        gated.persistenceUnavailable = 'Lifecycle gate is active';
        healthy.name = 'Healthy row updated';
        assert.strictEqual(
          await coordinator.saveSessions(new Map([[gated.id, gated], [healthy.id, healthy]])),
          true,
        );
        let restored = await coordinator.openWorkspace(scope).loadSessions();
        assert.strictEqual(restored.get(gated.id).name, 'Persisted gated row');
        assert.strictEqual(restored.get(healthy.id).name, 'Healthy row updated');

        healthy.persistenceUnavailable = 'Lifecycle gate is active';
        gated.name = 'Must not overwrite the authoritative row';
        healthy.name = 'Must not overwrite this row either';
        assert.strictEqual(
          await coordinator.saveSessions(new Map([[gated.id, gated], [healthy.id, healthy]])),
          true,
        );
        restored = await coordinator.openWorkspace(scope).loadSessions();
        assert.strictEqual(restored.get(gated.id).name, 'Persisted gated row');
        assert.strictEqual(restored.get(healthy.id).name, 'Healthy row updated');
        assert.strictEqual(restored.size, 2, 'an all-gated autosave is not an empty-scope prune');
      } finally {
        coordinator.closeWorkspaces();
        await fs.rm(workspaceRoot, { recursive: true, force: true });
      }
    });

    it('does not prune a restored archive until its complete state is published', async function () {
      const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-workspace-publish-'));
      const scope = { workspaceRoot, ownerKey: '8'.repeat(64) };
      const coordinator = new SessionStore({
        database: sessionStore.database,
        workspaceCoordinator: true,
      });
      try {
        const bound = coordinator.openWorkspace(scope);
        await bound.saveSessions(new Map([
          ['still-loading', createSessionRecord({ id: 'still-loading', storageScope: scope })],
        ]));
        await bound.loadSessions();

        assert.strictEqual(await coordinator.saveSessions(new Map()), true);
        assert.strictEqual(
          (await bound.loadSessions()).has('still-loading'),
          true,
          'a readable archive is not yet authoritative for deletion while migration confirms it',
        );

        coordinator.markWorkspacePublished(scope);
        assert.strictEqual(await coordinator.saveSessions(new Map()), true);
        assert.strictEqual(
          (await bound.loadSessions()).size,
          0,
          'after atomic publication, omission from the complete live map is a real deletion',
        );
      } finally {
        coordinator.closeWorkspaces();
        await fs.rm(workspaceRoot, { recursive: true, force: true });
      }
    });

    it('keeps same-id records isolated by workspace owner key and writes no global copy', async function () {
      const firstRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-workspace-a-'));
      const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-workspace-b-'));
      const first = { workspaceRoot: firstRoot, ownerKey: 'a'.repeat(64) };
      const second = { workspaceRoot: secondRoot, ownerKey: 'b'.repeat(64) };
      try {
        await sessionStore.saveSessions(new Map([
          ['same', createSessionRecord({ id: 'same', ownerUserId, name: 'First', storageScope: first })],
          ['same-2', createSessionRecord({ id: 'same-2', ownerUserId, name: 'Second', storageScope: second })],
        ]));
        assert.strictEqual(
          sessionStore.database.raw.prepare('SELECT COUNT(*) AS count FROM runtime_sessions').get().count,
          0,
        );
        assert.strictEqual((await sessionStore.openWorkspace(first).loadSessions()).get('same').name, 'First');
        assert.strictEqual((await sessionStore.openWorkspace(second).loadSessions()).get('same-2').name, 'Second');
        assert.strictEqual((await sessionStore.loadOpenedSessions()).size, 2);
        assert.strictEqual((await fs.stat(path.join(firstRoot, '.cc-web'))).mode & 0o777, 0o700);
        assert.strictEqual((await fs.stat(path.join(firstRoot, '.cc-web', 'session-state.sqlite'))).mode & 0o777, 0o600);
      } finally {
        sessionStore.openWorkspace(first).database.close();
        sessionStore.openWorkspace(second).database.close();
        await fs.rm(firstRoot, { recursive: true, force: true });
        await fs.rm(secondRoot, { recursive: true, force: true });
      }
    });

    it('rejects a colliding session id across two authorised workspace archives', async function () {
      const firstRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-workspace-collision-a-'));
      const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-workspace-collision-b-'));
      const first = { workspaceRoot: firstRoot, ownerKey: '1'.repeat(64) };
      const second = { workspaceRoot: secondRoot, ownerKey: '2'.repeat(64) };
      const coordinator = new SessionStore({
        database: sessionStore.database,
        workspaceCoordinator: true,
      });
      try {
        await coordinator.openWorkspace(first).saveSessions(new Map([
          ['collision', createSessionRecord({ id: 'collision', storageScope: first })],
        ]));
        await coordinator.openWorkspace(second).saveSessions(new Map([
          ['collision', createSessionRecord({ id: 'collision', storageScope: second })],
        ]));

        await assert.rejects(
          () => coordinator.loadOpenedSessions(),
          /Session id collision for collision/,
        );
      } finally {
        coordinator.closeWorkspaces();
        await fs.rm(firstRoot, { recursive: true, force: true });
        await fs.rm(secondRoot, { recursive: true, force: true });
      }
    });

    it('migrates only explicitly assigned legacy sessions after verifying the copy', async function () {
      const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-workspace-migrate-'));
      const scope = { workspaceRoot, ownerKey: 'c'.repeat(64) };
      try {
        await sessionStore.saveSessions(new Map([
          ['move', createSessionRecord({ id: 'move', ownerUserId, name: 'Move me' })],
          ['keep', createSessionRecord({ id: 'keep', ownerUserId, name: 'Keep me' })],
        ]));
        sessionStore.database.raw.prepare(`
          INSERT INTO usage_jobs (
            id, session_id, turn_id, user_id, user_login, agent,
            project, project_source, started_at, ended_at, outcome, turns,
            tool_calls, input_tokens, output_tokens, cache_read_tokens,
            cache_write_tokens, total_tokens, reports_usage, reports_cost
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
        `).run(
          'legacy-derived-fields',
          'move',
          'turn-1',
          ownerUserId,
          'tester',
          'claude',
          'legacy-project',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:01.000Z',
          'completed',
          1,
          0,
          4,
          5,
          6,
          7,
          1,
          0,
        );
        assert.strictEqual(sessionStore.migrateLegacySessions(scope, sessionStore.database, ownerUserId, ['move']), true);
        const workspace = sessionStore.openWorkspace(scope);
        assert.strictEqual((await workspace.loadSessions()).get('move').name, 'Move me');
        assert.deepStrictEqual(
          { ...workspace.database.raw.prepare(`
            SELECT project_source, total_tokens
            FROM usage_jobs WHERE owner_key = ? AND id = ?
          `).get(scope.ownerKey, 'legacy-derived-fields') },
          { project_source: 'observed', total_tokens: 22 },
          'derived compatibility fields are normalised only in the workspace copy',
        );
        assert.strictEqual(
          sessionStore.database.raw.prepare('SELECT COUNT(*) AS count FROM runtime_sessions WHERE id = ?').get('move').count,
          0,
        );
        assert.strictEqual(
          sessionStore.database.raw.prepare('SELECT COUNT(*) AS count FROM usage_jobs WHERE id = ?')
            .get('legacy-derived-fields').count,
          0,
        );
        assert.strictEqual(
          sessionStore.database.raw.prepare('SELECT COUNT(*) AS count FROM runtime_sessions WHERE id = ?').get('keep').count,
          1,
        );
      } finally {
        sessionStore.openWorkspace(scope).database.close();
        await fs.rm(workspaceRoot, { recursive: true, force: true });
      }
    });

    it('enforces parent-descendant closure at the SQLite cutover seam', async function () {
      const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-workspace-unit-'));
      const scope = { workspaceRoot, ownerKey: 'f'.repeat(64) };
      const parent = createSessionRecord({ id: 'unit-parent', ownerUserId });
      const child = createSessionRecord({
        id: 'unit-child', ownerUserId, ownerSessionId: parent.id,
      });
      const grandchild = createSessionRecord({
        id: 'unit-grandchild', ownerUserId, ownerSessionId: child.id,
      });
      const independent = createSessionRecord({ id: 'unit-independent', ownerUserId });
      try {
        await sessionStore.saveSessions(new Map([
          [parent.id, parent],
          [child.id, child],
          [grandchild.id, grandchild],
          [independent.id, independent],
        ]));

        assert.strictEqual(
          sessionStore.migrateLegacySessions(
            scope, sessionStore.database, ownerUserId, [child.id, grandchild.id],
          ),
          false,
          'a child cannot cut over without its parent',
        );
        assert.strictEqual(
          sessionStore.migrateLegacySessions(
            scope, sessionStore.database, ownerUserId, [parent.id, child.id],
          ),
          false,
          'a parent cannot leave a transitive descendant behind',
        );
        assert.strictEqual(
          sessionStore.database.raw.prepare(`
            SELECT COUNT(*) AS count FROM runtime_sessions WHERE owner_user_id = ?
          `).get(ownerUserId).count,
          4,
          'failed closure checks leave the whole source untouched',
        );

        const unitIds = [parent.id, child.id, grandchild.id];
        assert.strictEqual(
          sessionStore.migrateLegacySessions(
            scope, sessionStore.database, ownerUserId, unitIds,
          ),
          true,
        );
        assert.strictEqual(
          sessionStore.database.raw.prepare(`
            SELECT COUNT(*) AS count FROM runtime_sessions WHERE owner_user_id = ?
          `).get(ownerUserId).count,
          1,
          'the unrelated unit remains independently authoritative in legacy storage',
        );
        assert.strictEqual(
          sessionStore.migrateLegacySessions(
            scope, sessionStore.database, ownerUserId, unitIds,
          ),
          true,
          'a retry accepts members which are already present only in the target',
        );

        const lateChild = createSessionRecord({
          id: 'unit-late-child', ownerUserId, ownerSessionId: parent.id,
        });
        await sessionStore.saveSessions(new Map([[lateChild.id, lateChild]]));
        assert.strictEqual(
          sessionStore.migrateLegacySessions(
            scope,
            sessionStore.database,
            ownerUserId,
            [parent.id, lateChild.id],
          ),
          true,
          'an already migrated parent can anchor the remaining source members on retry',
        );
        const local = await sessionStore.openWorkspace(scope).loadSessions();
        assert.deepStrictEqual(
          [...local.keys()].sort(),
          [parent.id, child.id, grandchild.id, lateChild.id].sort(),
        );
      } finally {
        sessionStore.openWorkspace(scope).database.close();
        await fs.rm(workspaceRoot, { recursive: true, force: true });
      }
    });

    it('authenticates restored controls as part of the verified legacy cutover', async function () {
      const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-workspace-migrate-envelope-'));
      const scope = { workspaceRoot, ownerKey: 'b'.repeat(64) };
      const coordinator = new SessionStore({
        database: sessionStore.database,
        workspaceCoordinator: true,
        archiveTrust: createArchiveTrust(),
      });
      try {
        await sessionStore.saveSessions(new Map([
          ['legacy-signed', createSessionRecord({
            id: 'legacy-signed', ownerUserId, workingDir: workspaceRoot,
            surface: 'chat', nativeChatSessionId: 'native-before-cutover',
            sessionStartTime: new Date('2025-03-04T05:06:07.000Z'),
            chatBypassPermissions: false, chatModelOverride: 'migrated-model',
            chatPlanMode: true,
          })],
        ]));
        assert.strictEqual(
          coordinator.migrateLegacySessions(
            scope,
            sessionStore.database,
            ownerUserId,
            ['legacy-signed'],
          ),
          true,
        );

        const bound = coordinator.openWorkspace(scope);
        const row = bound.database.raw.prepare(`
          SELECT operational_envelope FROM runtime_sessions WHERE owner_key = ? AND id = ?
        `).get(scope.ownerKey, 'legacy-signed');
        assert.ok(row.operational_envelope);
        const restored = (await bound.loadSessions()).get('legacy-signed');
        assert.strictEqual(restored.surface, 'chat');
        assert.strictEqual(restored.nativeChatSessionId, 'native-before-cutover');
        assert.strictEqual(restored.sessionStartTime.toISOString(), '2025-03-04T05:06:07.000Z');
        assert.strictEqual(restored.chatBypassPermissions, false);
        assert.strictEqual(restored.chatModelOverride, 'migrated-model');
        assert.strictEqual(restored.chatPlanMode, true);
        assert.strictEqual(
          sessionStore.database.raw.prepare(
            'SELECT COUNT(*) AS count FROM runtime_sessions WHERE id = ?',
          ).get('legacy-signed').count,
          0,
        );
      } finally {
        coordinator.closeWorkspaces();
        await fs.rm(workspaceRoot, { recursive: true, force: true });
      }
    });

    it('compensates an earlier workspace commit when a later workspace save fails', async function () {
      const firstRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-workspace-rollback-a-'));
      const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-workspace-rollback-b-'));
      const first = { workspaceRoot: firstRoot, ownerKey: 'd'.repeat(64) };
      const second = { workspaceRoot: secondRoot, ownerKey: 'e'.repeat(64) };
      const firstStore = sessionStore.openWorkspace(first);
      const secondStore = sessionStore.openWorkspace(second);
      const originalSecondSave = secondStore.saveSessions.bind(secondStore);
      try {
        assert.strictEqual(await sessionStore.saveSessions(new Map([
          ['first', createSessionRecord({ id: 'first', name: 'Before A', active: true, storageScope: first })],
          ['second', createSessionRecord({ id: 'second', name: 'Before B', storageScope: second })],
        ])), true);

        let injected = false;
        secondStore.saveSessions = async (sessions) => {
          if (!injected) {
            injected = true;
            return false;
          }
          return originalSecondSave(sessions);
        };
        assert.strictEqual(await sessionStore.saveSessions(new Map([
          ['first', createSessionRecord({ id: 'first', name: 'After A', storageScope: first })],
          ['second', createSessionRecord({ id: 'second', name: 'After B', storageScope: second })],
        ])), false);

        assert.strictEqual((await firstStore.loadSessions()).get('first').name, 'Before A');
        assert.strictEqual((await secondStore.loadSessions()).get('second').name, 'Before B');
        assert.strictEqual(
          firstStore.database.raw.prepare(
            'SELECT active FROM runtime_sessions WHERE owner_key = ? AND id = ?',
          ).get(first.ownerKey, 'first').active,
          1,
          'compensation preserves the durable active bit from before the failed save',
        );

        let diagnostics = await sessionStore.getOpenedSessionMetadata();
        assert.match(
          diagnostics.scopes.find(({ scope }) => scope.ownerKey === second.ownerKey).metadata.error,
          /workspace save failed/,
        );
        assert.strictEqual(
          diagnostics.scopes.find(({ scope }) => scope.ownerKey === first.ownerKey).metadata.error,
          undefined,
        );

        assert.strictEqual(await sessionStore.saveSessions(new Map([
          ['first', createSessionRecord({ id: 'first', name: 'Before A', active: true, storageScope: first })],
          ['second', createSessionRecord({ id: 'second', name: 'Before B', storageScope: second })],
        ])), true);
        diagnostics = await sessionStore.getOpenedSessionMetadata();
        assert.strictEqual(
          diagnostics.scopes.find(({ scope }) => scope.ownerKey === second.ownerKey).metadata.error,
          undefined,
          'a later successful autosave clears the live persistence diagnostic',
        );
      } finally {
        secondStore.saveSessions = originalSecondSave;
        firstStore.database.close();
        secondStore.database.close();
        await fs.rm(firstRoot, { recursive: true, force: true });
        await fs.rm(secondRoot, { recursive: true, force: true });
      }
    });

    it('serializes active write-through after a failed cross-workspace rollback', async function () {
      const firstRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-workspace-active-a-'));
      const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-workspace-active-b-'));
      const first = { workspaceRoot: firstRoot, ownerKey: '6'.repeat(64) };
      const second = { workspaceRoot: secondRoot, ownerKey: '7'.repeat(64) };
      const coordinator = new SessionStore({
        database: sessionStore.database,
        workspaceCoordinator: true,
      });
      const firstStore = coordinator.openWorkspace(first);
      const secondStore = coordinator.openWorkspace(second);
      const originalSecondSave = secondStore.saveSessions.bind(secondStore);
      try {
        assert.strictEqual(await coordinator.saveSessions(new Map([
          ['first', createSessionRecord({ id: 'first', active: false, storageScope: first })],
          ['second', createSessionRecord({ id: 'second', active: false, storageScope: second })],
        ])), true);

        let injected = false;
        secondStore.saveSessions = async (sessions) => {
          if (!injected) {
            injected = true;
            return false;
          }
          return originalSecondSave(sessions);
        };
        const failedSave = coordinator.saveSessions(new Map([
          ['first', createSessionRecord({ id: 'first', name: 'Tentative', active: false, storageScope: first })],
          ['second', createSessionRecord({ id: 'second', name: 'Tentative', active: false, storageScope: second })],
        ]));
        const activeWrite = coordinator.setActive('first', true, first);

        assert.strictEqual(await failedSave, false);
        await activeWrite;
        const row = firstStore.database.raw.prepare(
          'SELECT name, active FROM runtime_sessions WHERE owner_key = ? AND id = ?',
        ).get(first.ownerKey, 'first');
        assert.strictEqual(row.name, 'Test Session');
        assert.strictEqual(row.active, 1);
      } finally {
        secondStore.saveSessions = originalSecondSave;
        coordinator.closeWorkspaces();
        await fs.rm(firstRoot, { recursive: true, force: true });
        await fs.rm(secondRoot, { recursive: true, force: true });
      }
    });

    it('refuses a workspace storage symlink rather than following it', async function () {
      const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-workspace-link-'));
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-outside-'));
      try {
        await fs.symlink(outside, path.join(workspaceRoot, '.cc-web'));
        assert.throws(
          () => new SessionStore({ workspaceRoot, ownerKey: 'f'.repeat(64) }),
          /\.cc-web storage path must be a real directory/,
        );
      } finally {
        await fs.rm(workspaceRoot, { recursive: true, force: true });
        await fs.rm(outside, { recursive: true, force: true });
      }
    });

    it('refuses a symlinked session-state.sqlite final component', async function () {
      const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-workspace-db-link-'));
      const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-db-link-target-'));
      const outside = path.join(outsideRoot, 'outside.sqlite');
      try {
        await fs.writeFile(outside, 'must remain ordinary user data', { mode: 0o644 });
        await fs.mkdir(path.join(workspaceRoot, '.cc-web'));
        await fs.symlink(outside, path.join(workspaceRoot, '.cc-web', 'session-state.sqlite'));
        assert.throws(
          () => new SessionStore({ workspaceRoot, ownerKey: '3'.repeat(64) }),
          /workspace database|symlinked workspace/i,
        );
        assert.strictEqual(await fs.readFile(outside, 'utf8'), 'must remain ordinary user data');
        assert.strictEqual((await fs.stat(outside)).mode & 0o777, 0o644);
      } finally {
        await fs.rm(workspaceRoot, { recursive: true, force: true });
        await fs.rm(outsideRoot, { recursive: true, force: true });
      }
    });

    it('refuses a hard-linked session-state.sqlite without touching the other name', async function () {
      const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-workspace-db-hardlink-'));
      const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-db-hardlink-target-'));
      const outside = path.join(outsideRoot, 'outside.sqlite');
      const original = Buffer.from('ordinary user data must not become a database');
      try {
        await fs.writeFile(outside, original, { mode: 0o644 });
        await fs.mkdir(path.join(workspaceRoot, '.cc-web'));
        await fs.link(outside, path.join(workspaceRoot, '.cc-web', 'session-state.sqlite'));
        assert.throws(
          () => new SessionStore({ workspaceRoot, ownerKey: '3'.repeat(64) }),
          /workspace database component is unsafe/i,
        );
        assert.deepStrictEqual(await fs.readFile(outside), original);
        assert.strictEqual((await fs.stat(outside)).mode & 0o777, 0o644);
        assert.strictEqual((await fs.stat(outside)).nlink, 2);
      } finally {
        await fs.rm(workspaceRoot, { recursive: true, force: true });
        await fs.rm(outsideRoot, { recursive: true, force: true });
      }
    });

    it('proves the inode opened by SQLite across a swap-and-restore race', async function () {
      if (process.platform !== 'linux' && process.platform !== 'win32') this.skip();
      const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-workspace-db-open-race-'));
      const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-db-open-race-target-'));
      const ownerKey = '4'.repeat(64);
      const dbPath = path.join(workspaceRoot, '.cc-web', 'session-state.sqlite');
      const parked = `${dbPath}.safe`;
      const canary = path.join(outsideRoot, 'canary.sqlite');
      let swapped = false;
      try {
        const initialized = new WorkspaceSessionDatabase({ workspaceRoot, ownerKey });
        initialized.close();

        const canaryDb = openDatabase(canary);
        canaryDb.exec('CREATE TABLE canary (value TEXT NOT NULL); INSERT INTO canary VALUES (\'unchanged\')');
        canaryDb.close();
        await fs.chmod(canary, 0o644);
        const canaryBefore = await fs.readFile(canary);

        let rejection;
        try {
          new WorkspaceSessionDatabase({
            workspaceRoot,
            ownerKey,
            sqliteOpenTestHooks: {
              beforeBackendOpen() {
                fsSync.renameSync(dbPath, parked);
                fsSync.linkSync(canary, dbPath);
                swapped = true;
              },
              afterBackendOpen() {
                if (!swapped) return;
                try {
                  fsSync.unlinkSync(dbPath);
                } catch (error) {
                  // On Windows this is the security property under test: the
                  // SQLite handle denies FILE_SHARE_DELETE, so the canary name
                  // cannot be removed and the original cannot be restored
                  // before the post-open identity check.
                  throw error;
                }
                fsSync.renameSync(parked, dbPath);
                swapped = false;
              },
            },
          });
        } catch (error) {
          rejection = error;
        }
        assert.ok(rejection, 'the swapped database must be rejected');
        if (process.platform === 'win32') {
          assert.ok(['EACCES', 'EBUSY', 'EPERM'].includes(rejection.code));
          // The constructor has closed SQLite after the rejected hook, so test
          // cleanup can now restore the original name safely.
          fsSync.unlinkSync(dbPath);
          fsSync.renameSync(parked, dbPath);
          swapped = false;
        } else {
          assert.match(rejection.message, /SQLite did not bind the verified workspace database inode/);
        }

        assert.deepStrictEqual(await fs.readFile(canary), canaryBefore);
        assert.strictEqual((await fs.stat(canary)).mode & 0o777, 0o644);
        assert.strictEqual((await fs.stat(canary)).nlink, 1);
        const reopened = new WorkspaceSessionDatabase({ workspaceRoot, ownerKey });
        reopened.close();
      } finally {
        if (swapped) {
          try { fsSync.unlinkSync(dbPath); } catch { /* Best-effort test restoration. */ }
          try { fsSync.renameSync(parked, dbPath); } catch { /* Best-effort test restoration. */ }
        }
        await fs.rm(workspaceRoot, { recursive: true, force: true });
        await fs.rm(outsideRoot, { recursive: true, force: true });
      }
    });

    for (const suffix of ['-wal', '-shm', '-journal']) {
      it(`refuses a hard-linked SQLite ${suffix} companion before schema access`, async function () {
        const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-workspace-db-sidecar-'));
        const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-db-sidecar-target-'));
        const outside = path.join(outsideRoot, `outside${suffix}`);
        const dbPath = path.join(workspaceRoot, '.cc-web', 'session-state.sqlite');
        let initialized = new SessionStore({ workspaceRoot, ownerKey: '5'.repeat(64) });
        try {
          initialized.database.close();
          await fs.rm(`${dbPath}${suffix}`, { force: true });
          await fs.writeFile(outside, `do not follow ${suffix}`, { mode: 0o644 });
          await fs.link(outside, `${dbPath}${suffix}`);
          assert.throws(
            () => new SessionStore({ workspaceRoot, ownerKey: '5'.repeat(64) }),
            /workspace database component is unsafe/i,
          );
          assert.strictEqual(await fs.readFile(outside, 'utf8'), `do not follow ${suffix}`);
          assert.strictEqual((await fs.stat(outside)).mode & 0o777, 0o644);
          assert.strictEqual((await fs.stat(outside)).nlink, 2);
        } finally {
          try { initialized.database.close(); } catch { /* already closed */ }
          await fs.rm(workspaceRoot, { recursive: true, force: true });
          await fs.rm(outsideRoot, { recursive: true, force: true });
        }
      });
    }

    it('adds workspace session columns idempotently to an older schema', async function () {
      const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-workspace-envelope-schema-'));
      const scope = { workspaceRoot, ownerKey: '7'.repeat(64) };
      let store = new SessionStore(scope);
      try {
        store.database.raw.exec('ALTER TABLE runtime_sessions DROP COLUMN operational_envelope');
        store.database.raw.exec('ALTER TABLE runtime_sessions DROP COLUMN chat_draft_json');
        store.database.raw.exec('ALTER TABLE runtime_sessions DROP COLUMN rollback_recovery_pending');
        store.database.close();

        store = new SessionStore(scope);
        let columns = store.database.raw.prepare('PRAGMA table_info(runtime_sessions)').all();
        assert.strictEqual(columns.filter((column) => column.name === 'operational_envelope').length, 1);
        assert.strictEqual(columns.filter((column) => column.name === 'chat_draft_json').length, 1);
        assert.strictEqual(columns.filter((column) => column.name === 'rollback_recovery_pending').length, 1);
        store.database.close();

        store = new SessionStore(scope);
        columns = store.database.raw.prepare('PRAGMA table_info(runtime_sessions)').all();
        assert.strictEqual(columns.filter((column) => column.name === 'operational_envelope').length, 1);
        assert.strictEqual(columns.filter((column) => column.name === 'chat_draft_json').length, 1);
        assert.strictEqual(columns.filter((column) => column.name === 'rollback_recovery_pending').length, 1);
      } finally {
        try { store.database.close(); } catch { /* already closed */ }
        await fs.rm(workspaceRoot, { recursive: true, force: true });
      }
    });

    it('restores a hidden rollback recovery anchor after a cold restart', async function () {
      const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-recovery-restart-'));
      const scope = { workspaceRoot, ownerKey: '9'.repeat(64) };
      const trust = createArchiveTrust();
      let store = new SessionStore({ ...scope, archiveTrust: trust });
      try {
        const anchor = createSessionRecord({
          id: 'recovery-anchor',
          ownerUserId,
          storageScope: scope,
          workingDir: workspaceRoot,
          surface: 'chat',
          tabOpen: false,
          rollbackRecoveryPending: true,
        });
        assert.strictEqual(await store.saveSessions(new Map([[anchor.id, anchor]])), true);
        store.database.close();

        store = new SessionStore({ ...scope, archiveTrust: trust });
        const restored = (await store.loadSessions()).get(anchor.id);
        assert.ok(restored, 'the workspace database remains the cleanup authority after boot');
        assert.strictEqual(restored.rollbackRecoveryPending, true);
        assert.strictEqual(restored.tabOpen, false);
        const row = store.database.raw.prepare(`
          SELECT rollback_recovery_pending, operational_envelope
          FROM runtime_sessions WHERE owner_key = ? AND id = ?
        `).get(scope.ownerKey, anchor.id);
        assert.strictEqual(row.rollback_recovery_pending, 1);
        assert.strictEqual(JSON.parse(trust.open(row.operational_envelope)).version, 2);
      } finally {
        try { store.database.close(); } catch { /* already closed */ }
        await fs.rm(workspaceRoot, { recursive: true, force: true });
      }
    });

    it('accepts and immediately upgrades a v1 operational envelope only for a non-recovery row', async function () {
      const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-envelope-v1-'));
      const scope = { workspaceRoot, ownerKey: '8'.repeat(64) };
      const trust = createArchiveTrust();
      let store = new SessionStore({ ...scope, archiveTrust: trust });
      try {
        const session = createSessionRecord({
          id: 'legacy-envelope',
          ownerUserId,
          storageScope: scope,
          workingDir: workspaceRoot,
          surface: 'chat',
          lastAgent: 'terminal',
          nativeChatSessionId: 'native-v1',
          chatBypassPermissions: false,
        });
        assert.strictEqual(await store.saveSessions(new Map([[session.id, session]])), true);
        const signed = store.database.raw.prepare(`
          SELECT operational_envelope FROM runtime_sessions WHERE owner_key = ? AND id = ?
        `).get(scope.ownerKey, session.id);
        const v1 = JSON.parse(trust.open(signed.operational_envelope));
        v1.version = 1;
        delete v1.operational.rollbackRecoveryPending;
        const v1Envelope = trust.seal(JSON.stringify(v1));
        store.database.raw.prepare(`
          UPDATE runtime_sessions SET operational_envelope = ? WHERE owner_key = ? AND id = ?
        `).run(v1Envelope, scope.ownerKey, session.id);
        store.database.close();

        store = new SessionStore({ ...scope, archiveTrust: trust });
        const restored = (await store.loadSessions()).get(session.id);
        assert.strictEqual(restored.surface, 'chat');
        assert.strictEqual(restored.lastAgent, 'terminal');
        assert.strictEqual(restored.nativeChatSessionId, 'native-v1');
        assert.strictEqual(restored.chatBypassPermissions, false);
        assert.strictEqual(restored.rollbackRecoveryPending, undefined);
        const upgraded = store.database.raw.prepare(`
          SELECT operational_envelope FROM runtime_sessions WHERE owner_key = ? AND id = ?
        `).get(scope.ownerKey, session.id);
        const v2 = JSON.parse(trust.open(upgraded.operational_envelope));
        assert.strictEqual(v2.version, 2);
        assert.strictEqual(v2.operational.rollbackRecoveryPending, 0);

        // A v1 signature says nothing about recovery authority. Reusing it with
        // a true bit must fail closed rather than manufacturing a cleanup row.
        store.database.raw.prepare(`
          UPDATE runtime_sessions
          SET rollback_recovery_pending = 1, operational_envelope = ?
          WHERE owner_key = ? AND id = ?
        `).run(v1Envelope, scope.ownerKey, session.id);
        store.database.close();
        store = new SessionStore({ ...scope, archiveTrust: trust });
        const rejected = (await store.loadSessions()).get(session.id);
        assert.strictEqual(rejected.surface, undefined);
        assert.strictEqual(rejected.nativeChatSessionId, undefined);
        assert.strictEqual(rejected.rollbackRecoveryPending, undefined);
      } finally {
        try { store.database.close(); } catch { /* already closed */ }
        await fs.rm(workspaceRoot, { recursive: true, force: true });
      }
    });

    it('fails closed on operational state when no archive trust verifier is supplied', async function () {
      const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-workspace-no-trust-'));
      const scope = { workspaceRoot, ownerKey: '0'.repeat(64) };
      const store = new SessionStore(scope);
      try {
        await store.saveSessions(new Map([
          ['unsigned', createSessionRecord({
            id: 'unsigned', name: 'Readable history', storageScope: scope,
            workingDir: path.join(workspaceRoot, 'untrusted-child'), surface: 'chat',
            lastAgent: 'terminal', nativeChatSessionId: 'untrusted-native',
            sessionStartTime: new Date('2099-01-01T00:00:00.000Z'),
            chatBypassPermissions: true, chatPlanMode: true,
          })],
        ]));

        const restored = (await store.loadSessions()).get('unsigned');
        assert.strictEqual(restored.name, 'Readable history');
        assert.strictEqual(restored.workingDir, path.resolve(workspaceRoot));
        assert.strictEqual(restored.surface, undefined);
        assert.strictEqual(restored.lastAgent, null);
        assert.strictEqual(restored.nativeChatSessionId, undefined);
        assert.strictEqual(restored.sessionStartTime, null);
        assert.strictEqual(restored.chatBypassPermissions, undefined);
        assert.strictEqual(restored.chatPlanMode, false);
      } finally {
        store.database.close();
        await fs.rm(workspaceRoot, { recursive: true, force: true });
      }
    });

    it('rejects SQL-tampered operational state even when the archive marker is valid', async function () {
      const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-workspace-record-tamper-'));
      const scope = { workspaceRoot, ownerKey: '6'.repeat(64) };
      const trust = createArchiveTrust();
      const trustedStartedAt = new Date('2025-01-02T03:04:05.000Z');
      let store = new SessionStore({ ...scope, archiveTrust: trust });
      try {
        const trustedWorkingDir = path.join(workspaceRoot, 'trusted-child');
        await store.saveSessions(new Map([
          ['signed', createSessionRecord({
            id: 'signed', name: 'History remains visible', storageScope: scope,
            workingDir: trustedWorkingDir, surface: 'chat', lastAgent: 'terminal',
            runtimeLabel: 'trusted runtime',
            terminalOptions: { mode: 'command', shell: 'bash', command: 'pwd' },
            sessionStartTime: trustedStartedAt,
            maxBufferSize: 2048, nativeChatSessionId: 'trusted-native',
            ownerSessionId: 'trusted-owner', chatBypassPermissions: false,
            chatModelOverride: 'trusted-model', chatModelPinned: 'trusted-pin',
            chatEffortOverride: 'high', chatPlanMode: true,
            projectId: 'trusted-project', projectWorkingDirKind: 'host',
          })],
        ]));
        const signed = store.database.raw.prepare(`
          SELECT operational_envelope FROM runtime_sessions WHERE owner_key = ? AND id = ?
        `).get(scope.ownerKey, 'signed');
        assert.ok(signed.operational_envelope, 'every saved workspace row has an envelope');

        store.database.close();
        store = new SessionStore({ ...scope, archiveTrust: trust });
        const verified = (await store.loadSessions()).get('signed');
        assert.strictEqual(verified.workingDir, trustedWorkingDir);
        assert.strictEqual(verified.surface, 'chat');
        assert.strictEqual(verified.runtimeLabel, 'trusted runtime');
        assert.strictEqual(verified.sessionStartTime.toISOString(), trustedStartedAt.toISOString());
        assert.strictEqual(verified.chatBypassPermissions, false);
        assert.strictEqual(verified.chatModelOverride, 'trusted-model');
        assert.strictEqual(verified.chatPlanMode, true);
        assert.strictEqual(verified.projectId, 'trusted-project');

        store.database.raw.prepare(`
          UPDATE runtime_sessions SET
            working_dir = ?, surface = 'chat', last_agent = 'terminal',
            runtime_label = 'attacker runtime',
            terminal_options_json = '{"mode":"command","command":"attacker"}',
            session_start_time = '2099-12-31T23:59:59.000Z', max_buffer_size = 999999,
            native_chat_session_id = 'attacker-native',
            owner_session_id = 'attacker-owner', chat_bypass_permissions = 1,
            chat_model_override = 'attacker-model', chat_model_pinned = 'attacker-pin',
            chat_effort_override = 'xhigh', chat_plan_mode = 1,
            project_id = 'attacker-project', project_working_dir_kind = 'container'
          WHERE owner_key = ? AND id = ?
        `).run('/attacker/working-dir', scope.ownerKey, 'signed');
        store.database.close();

        store = new SessionStore({ ...scope, archiveTrust: trust });
        const restored = (await store.loadSessions()).get('signed');
        assert.strictEqual(restored.name, 'History remains visible');
        assert.strictEqual(restored.workingDir, path.resolve(workspaceRoot));
        assert.strictEqual(restored.surface, undefined);
        assert.strictEqual(restored.lastAgent, null);
        assert.strictEqual(restored.runtimeLabel, null);
        assert.strictEqual(restored.terminalOptions, null);
        assert.strictEqual(restored.sessionStartTime, null);
        assert.strictEqual(restored.maxBufferSize, 1000);
        assert.strictEqual(restored.nativeChatSessionId, undefined);
        assert.strictEqual(restored.ownerSessionId, undefined);
        assert.strictEqual(restored.chatBypassPermissions, undefined);
        assert.strictEqual(restored.chatModelOverride, undefined);
        assert.strictEqual(restored.chatModelPinned, undefined);
        assert.strictEqual(restored.chatEffortOverride, undefined);
        assert.strictEqual(restored.chatPlanMode, false);
        assert.strictEqual(restored.projectId, undefined);
        assert.strictEqual(restored.projectWorkingDirKind, undefined);

        assert.strictEqual(await store.saveSessions(new Map([['signed', restored]])), true);
        store.database.close();
        store = new SessionStore({ ...scope, archiveTrust: trust });
        const admitted = (await store.loadSessions()).get('signed');
        assert.strictEqual(admitted.workingDir, path.resolve(workspaceRoot));
        assert.strictEqual(admitted.sessionStartTime, null);
        assert.strictEqual(admitted.chatBypassPermissions, undefined);
        assert.strictEqual(admitted.nativeChatSessionId, undefined);
      } finally {
        try { store.database.close(); } catch { /* already closed */ }
        await fs.rm(workspaceRoot, { recursive: true, force: true });
      }
    });

    it('sanitizes sensitive controls in a pre-existing archive before authenticating it', async function () {
      const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-workspace-untrusted-'));
      const scope = { workspaceRoot, ownerKey: '4'.repeat(64) };
      const trust = {
        seal: (value) => `trusted:${Buffer.from(value).toString('base64')}`,
        open: (value) => Buffer.from(String(value).replace(/^trusted:/, ''), 'base64').toString(),
      };
      let seeded = new SessionStore(scope);
      try {
        await seeded.saveSessions(new Map([
          ['injected', createSessionRecord({
            id: 'injected', storageScope: scope, surface: 'chat',
            sessionStartTime: new Date('2099-01-01T00:00:00.000Z'),
            nativeChatSessionId: 'attacker-native', ownerSessionId: 'attacker-parent',
            chatBypassPermissions: true, chatModelOverride: 'attacker-model',
            chatPlanMode: true,
          })],
        ]));
        seeded.database.close();

        let reopened = new SessionStore({ ...scope, archiveTrust: trust });
        const loaded = await reopened.loadSessions();
        const record = loaded.get('injected');
        assert.strictEqual(record.chatBypassPermissions, undefined);
        assert.strictEqual(record.sessionStartTime, null);
        assert.strictEqual(record.nativeChatSessionId, undefined);
        assert.strictEqual(record.ownerSessionId, undefined);
        assert.strictEqual(record.chatModelOverride, undefined);
        assert.strictEqual(record.chatPlanMode, false);

        await reopened.saveSessions(loaded);
        reopened.database.close();
        reopened = new SessionStore({ ...scope, archiveTrust: trust });
        const admitted = (await reopened.loadSessions()).get('injected');
        assert.strictEqual(admitted.chatBypassPermissions, undefined);
        assert.strictEqual(admitted.nativeChatSessionId, undefined);
        reopened.database.close();
      } finally {
        try { seeded.database.close(); } catch { /* already closed */ }
        await fs.rm(workspaceRoot, { recursive: true, force: true });
      }
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

function createArchiveTrust() {
  const key = crypto.randomBytes(32);
  return {
    seal(value) {
      const payload = Buffer.from(value, 'utf8').toString('base64url');
      const tag = crypto.createHmac('sha256', key).update(payload).digest('base64url');
      return `${payload}.${tag}`;
    },
    open(envelope) {
      const [payload, tag, extra] = String(envelope).split('.');
      if (!payload || !tag || extra !== undefined) throw new Error('invalid envelope');
      const expected = crypto.createHmac('sha256', key).update(payload).digest();
      const supplied = Buffer.from(tag, 'base64url');
      if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
        throw new Error('invalid envelope');
      }
      return Buffer.from(payload, 'base64url').toString('utf8');
    },
  };
}
