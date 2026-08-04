const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AppDatabase } = require('../dist/server/services/database.js');
const { EncryptionKeyRing } = require('../dist/server/services/encryption.js');
const { ProjectStore } = require('../dist/server/services/projects/store.js');
const { openDatabase } = require('../dist/server/services/sqlite.js');

describe('composition persistence store', function () {
  let dir; let database; let store; let user;
  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-composition-store-'));
    database = new AppDatabase({ dataDir: dir });
    const keyRing = new EncryptionKeyRing({ settings: database, key: Buffer.alloc(32, 7).toString('base64'), warn: () => {} });
    store = new ProjectStore({ database, keyRing });
    user = database.upsertGitHubUser({ githubId: 'composition-owner', githubLogin: 'owner' });
  });
  afterEach(function () { database?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  function reopen() {
    database.close();
    database = new AppDatabase({ dataDir: dir });
    const keyRing = new EncryptionKeyRing({ settings: database, key: Buffer.alloc(32, 7).toString('base64'), warn: () => {} });
    store = new ProjectStore({ database, keyRing });
  }

  it('keeps revisions immutable and activates with an owner-scoped CAS', function () {
    const project = store.createProject({ ownerUserId: user.id, name: 'recipe', initialState: 'composition_pending' });
    assert.strictEqual(project.state, 'composition_pending');
    assert.strictEqual(store.countRunning(user.id), 0);
    const first = store.createCompositionDraft({ projectId: project.id, userId: user.id, catalogVersion: 'v1', detected: { node: '20' }, chosen: { node: '20.1.0' }, sourceOid: 'a'.repeat(40), installations: [{ itemId: 'node' }] });
    const second = store.createCompositionDraft({ projectId: project.id, userId: user.id, catalogVersion: 'v1', detected: {}, chosen: { node: '22.0.0' } });
    assert.ok(first && second);
    assert.throws(() => database.raw.prepare('UPDATE project_compositions SET chosen_json = ? WHERE id = ?').run('{}', first.id), /immutable/);
    assert.strictEqual(store.activateComposition({ projectId: project.id, userId: user.id, expectedCurrentRevision: null, revision: first.id }), true);
    assert.strictEqual(store.activateComposition({ projectId: project.id, userId: user.id, expectedCurrentRevision: null, revision: second.id }), false);
    assert.strictEqual(store.activateComposition({ projectId: project.id, userId: user.id, expectedCurrentRevision: first.id, revision: second.id }), true);
    assert.strictEqual(store.getProject(project.id).compositionRevision, second.id);
    assert.strictEqual(store.getProject(project.id).appliedCompositionRevision, null);
    assert.strictEqual(store.markCompositionApplied(project.id, user.id, second.id), true);
    assert.strictEqual(store.getProject(project.id).appliedCompositionRevision, second.id);
  });

  it('activates a composition in the same transaction as counted-state admission', function () {
    const project = store.createProject({
      ownerUserId: user.id,
      name: 'atomic recipe',
      initialState: 'composition_pending',
    });
    const composition = store.createCompositionDraft({
      projectId: project.id,
      userId: user.id,
      catalogVersion: 'v1',
      detected: {},
      chosen: {},
    });

    assert.deepStrictEqual(store.tryStartCounted({
      projectId: project.id,
      ownerUserId: user.id,
      toState: 'building',
      fromStates: ['composition_pending'],
      limit: 0,
      activateComposition: { revision: composition.id, expectedCurrentRevision: null },
    }).reason, 'run_limit');
    assert.deepStrictEqual(
      { state: store.getProject(project.id).state, revision: store.getProject(project.id).compositionRevision },
      { state: 'composition_pending', revision: null },
    );

    assert.deepStrictEqual(store.tryStartCounted({
      projectId: project.id,
      ownerUserId: user.id,
      toState: 'building',
      fromStates: ['composition_pending'],
      limit: 1,
      activateComposition: { revision: composition.id, expectedCurrentRevision: null },
    }), { ok: true });
    assert.deepStrictEqual(
      { state: store.getProject(project.id).state, revision: store.getProject(project.id).compositionRevision },
      { state: 'building', revision: composition.id },
    );
  });

  it('records independent installation retries and never exposes host plaintext', function () {
    const project = store.createProject({ ownerUserId: user.id, name: 'recipe' });
    const composition = store.createCompositionDraft({ projectId: project.id, userId: user.id, catalogVersion: 'v1', detected: {}, chosen: {}, installations: [{ itemId: 'node' }] });
    store.upsertCompositionInstallation(composition.id, 'node', { status: 'failed', errorCode: 'network', errorMessage: 'retry later', incrementAttempts: true });
    const installation = store.listCompositionInstallations(composition.id, user.id)[0];
    assert.deepStrictEqual({ status: installation.status, attempts: installation.attempts, errorCode: installation.errorCode }, { status: 'failed', attempts: 1, errorCode: 'network' });
    store.upsertConnectedHostToken(user.id, 'github.com', 'secret-token');
    const host = store.listConnectedHosts(user.id)[0];
    assert.strictEqual(host.validationStatus, 'unvalidated');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(host, 'credential'), false);
    assert.strictEqual(database.raw.prepare('SELECT credential_encrypted FROM connected_hosts').get().credential_encrypted.includes('secret-token'), false);
  });

  it('lists owner-scoped recipes with an installation currently in progress', function () {
    const project = store.createProject({ ownerUserId: user.id, name: 'recipe' });
    const installing = store.createCompositionDraft({
      projectId: project.id, userId: user.id, catalogVersion: 'v1', detected: {},
      chosen: { runtimes: [{ runtimeId: 'node', version: '22.14.0' }] },
      installations: [{ itemId: 'node' }],
    });
    const idle = store.createCompositionDraft({
      projectId: project.id, userId: user.id, catalogVersion: 'v1', detected: {},
      chosen: { runtimes: [{ runtimeId: 'python', version: '3.13.2' }] },
      installations: [{ itemId: 'python' }],
    });
    store.upsertCompositionInstallation(installing.id, 'node', { status: 'installing' });

    assert.deepStrictEqual(
      store.listInstallingCompositionsForUser(user.id).map((composition) => composition.id),
      [installing.id],
    );
    store.upsertCompositionInstallation(installing.id, 'node', { status: 'installed', installedVersion: '22.14.0' });
    assert.deepStrictEqual(store.listInstallingCompositionsForUser(user.id), []);
    assert.ok(idle);
  });

  it('resolves project and global identities and round-trips storage snapshots', function () {
    assert.strictEqual(store.usageWarnUserBytes(), null);
    assert.strictEqual(store.usageWarnAdminBytes(), null);
    const project = store.createProject({ ownerUserId: user.id, name: 'recipe' });
    store.upsertGitIdentity({ userId: user.id, name: 'Global', email: 'global@example.test' });
    assert.strictEqual(store.resolveGitIdentity({ userId: user.id, projectId: project.id }).source, 'global');
    store.upsertGitIdentity({ userId: user.id, projectId: project.id, name: 'Project', email: 'project@example.test' });
    assert.strictEqual(store.resolveGitIdentity({ userId: user.id, projectId: project.id }).identity.email, 'project@example.test');
    const snap = store.recordStorageUsageSnapshot({ userId: user.id, totalBytes: 42, breakdown: { ownerHome: 10, projects: { one: 32 } }, errors: ['permission denied'], freeBytes: 99 });
    assert.deepStrictEqual(store.latestStorageUsageSnapshot(user.id).breakdown, snap.breakdown);
    assert.deepStrictEqual(store.listStorageUsageSnapshots(user.id)[0].errors, ['permission denied']);
    store.setUsageWarnUserBytes(1024); store.setUsageWarnAdminBytes(2048);
    assert.strictEqual(store.usageWarnUserBytes(), 1024); assert.strictEqual(store.usageWarnAdminBytes(), 2048);
  });

  it('bounds user-triggerable storage snapshot history and returns the newest tied timestamp deterministically', function () {
    for (let index = 0; index < 105; index += 1) {
      store.recordStorageUsageSnapshot({ userId: user.id, totalBytes: index, breakdown: { index } });
    }
    assert.strictEqual(store.listStorageUsageSnapshots(user.id, 500).length, 100);
    assert.strictEqual(store.latestStorageUsageSnapshot(user.id).totalBytes, 104);
  });

  it('uses OAuth only as a fallback and never overwrites a preferred manual token', function () {
    store.upsertConnectedHostOAuth(user.id, 'github.com', 'oauth-one');
    assert.strictEqual(store.credentialFor(user.id, 'github.com'), 'oauth-one');
    store.upsertConnectedHostToken(user.id, 'github.com', 'manual-pat');
    store.upsertConnectedHostOAuth(user.id, 'github.com', 'oauth-two');

    assert.strictEqual(store.credentialFor(user.id, 'github.com'), 'manual-pat');
    assert.strictEqual(store.listConnectedHosts(user.id).length, 1);
    assert.strictEqual(store.listConnectedHosts(user.id)[0].credentialKind, 'token');
    assert.strictEqual(database.raw.prepare('SELECT COUNT(*) AS count FROM connected_hosts WHERE user_id = ? AND host = ?').get(user.id, 'github.com').count, 2);

    reopen();
    assert.strictEqual(store.credentialFor(user.id, 'github.com'), 'manual-pat');
    assert.strictEqual(store.listConnectedHosts(user.id)[0].credentialKind, 'token');
  });

  it('clears stale validation metadata on replacement and supports explicit expiry clearing', function () {
    store.upsertConnectedHostToken(user.id, 'git.example.test', 'first');
    store.setConnectedHostValidation({ userId: user.id, host: 'git.example.test', forgeKind: 'gitlab', status: 'valid', scopes: ['api'], expiresAt: '2030-01-01T00:00:00.000Z' });
    let host = store.listConnectedHosts(user.id)[0];
    assert.deepStrictEqual({ forge: host.forgeKind, status: host.validationStatus, scopes: host.scopes, expires: host.expiresAt }, { forge: 'gitlab', status: 'valid', scopes: ['api'], expires: '2030-01-01T00:00:00.000Z' });

    store.upsertConnectedHostToken(user.id, 'git.example.test', 'second');
    host = store.listConnectedHosts(user.id)[0];
    assert.deepStrictEqual({ forge: host.forgeKind, status: host.validationStatus, scopes: host.scopes, expires: host.expiresAt, revision: host.credentialRevision }, { forge: null, status: 'unvalidated', scopes: [], expires: null, revision: 2 });

    store.setConnectedHostValidation({ userId: user.id, host: 'git.example.test', forgeKind: 'gitlab', status: 'valid', expiresAt: '2031-01-01T00:00:00.000Z' });
    store.setConnectedHostValidation({ userId: user.id, host: 'git.example.test', status: 'valid', expiresAt: null });
    host = store.listConnectedHosts(user.id)[0];
    assert.strictEqual(host.forgeKind, 'gitlab', 'an omitted forge field preserves known metadata');
    assert.strictEqual(host.expiresAt, null, 'an explicit null clears expiry');
    reopen();
    host = store.listConnectedHosts(user.id)[0];
    assert.deepStrictEqual({ forge: host.forgeKind, status: host.validationStatus, expires: host.expiresAt, revision: host.credentialRevision }, { forge: 'gitlab', status: 'valid', expires: null, revision: 2 });
  });

  it('persists compositions, installation retries, identities, and snapshots across restart', function () {
    const project = store.createProject({ ownerUserId: user.id, name: 'durable', initialState: 'composition_pending' });
    const composition = store.saveCompositionDraft({ projectId: project.id, userId: user.id, catalogVersion: 'v1', detected: { python: '3.12' }, chosen: { python: '3.12.4' }, sourceOid: 'b'.repeat(40), installations: [{ itemId: 'python' }] });
    assert.strictEqual(store.activateComposition({ projectId: project.id, userId: user.id, expectedCurrentRevision: null, revision: composition.id }), true);
    store.updateCompositionInstallationForUser({ compositionId: composition.id, userId: user.id, itemId: 'python', patch: { status: 'failed', incrementAttempts: true, errorCode: 'download_failed', errorMessage: 'Retry safely' } });
    store.upsertGitIdentity({ userId: user.id, projectId: project.id, name: 'Project User', email: 'project@example.test' });
    store.recordStorageUsageSnapshot({ userId: user.id, totalBytes: 123, breakdown: { ownerHome: 100, projects: { [project.id]: 23 } }, errors: ['partial'], freeBytes: 456 });

    reopen();
    assert.strictEqual(store.getProject(project.id).compositionRevision, composition.id);
    assert.deepStrictEqual(store.getProjectComposition(project.id, user.id, composition.id).chosen, { python: '3.12.4' });
    assert.deepStrictEqual(store.listCompositionInstallations(composition.id, user.id).map((item) => [item.status, item.attempts, item.errorCode]), [['failed', 1, 'download_failed']]);
    assert.strictEqual(store.resolveGitIdentity({ userId: user.id, projectId: project.id }).identity.email, 'project@example.test');
    assert.deepStrictEqual(store.latestStorageUsageSnapshot(user.id).breakdown, { ownerHome: 100, projects: { [project.id]: 23 } });
  });

  it('migrates legacy project and connected-host rows additively', function () {
    database.close();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(dir, `app.sqlite${suffix}`), { force: true });
    const legacy = openDatabase(path.join(dir, 'app.sqlite'));
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, github_id TEXT NOT NULL UNIQUE,
        github_login TEXT NOT NULL, github_name TEXT, avatar_url TEXT, email TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_login_at TEXT NOT NULL
      );
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL, repo_url TEXT, repo_host TEXT, target_id TEXT, tier_id TEXT,
        state TEXT NOT NULL, state_detail TEXT, container_json TEXT,
        rebuild_required INTEGER NOT NULL DEFAULT 0, build_log_json TEXT,
        last_activity_at TEXT NOT NULL, last_preserved_commit TEXT, last_preserved_branch TEXT,
        composition_revision TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE connected_hosts (
        id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        host TEXT NOT NULL, kind TEXT NOT NULL, identity_id TEXT, credential_encrypted TEXT,
        scopes_json TEXT, expires_at TEXT, last_used_at TEXT, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, UNIQUE(user_id, host, kind)
      );
    `);
    const now = new Date().toISOString();
    legacy.prepare('INSERT INTO users (github_id, github_login, created_at, updated_at, last_login_at) VALUES (?, ?, ?, ?, ?)').run('legacy', 'legacy', now, now, now);
    legacy.prepare(`INSERT INTO projects (id, owner_user_id, name, state, last_activity_at, created_at, updated_at) VALUES ('legacy-project', 1, 'legacy', 'stopped', ?, ?, ?)`).run(now, now, now);
    legacy.prepare(`INSERT INTO connected_hosts (id, user_id, host, kind, credential_encrypted, created_at, updated_at) VALUES ('legacy-host', 1, 'github.com', 'token', 'opaque-envelope', ?, ?)`).run(now, now);
    legacy.close();

    database = new AppDatabase({ dataDir: dir });
    const keyRing = new EncryptionKeyRing({ settings: database, key: Buffer.alloc(32, 7).toString('base64'), warn: () => {} });
    store = new ProjectStore({ database, keyRing });
    const projectColumns = database.raw.prepare('PRAGMA table_info(projects)').all().map((column) => column.name);
    assert.ok(projectColumns.includes('applied_composition_revision'));
    assert.strictEqual(store.getProject('legacy-project').appliedCompositionRevision, null);
    assert.deepStrictEqual(store.listConnectedHosts(1).map((host) => ({ kind: host.credentialKind, status: host.validationStatus, revision: host.credentialRevision })), [{ kind: 'token', status: 'unvalidated', revision: 1 }]);
  });
});
