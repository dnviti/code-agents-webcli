const assert = require('assert');
const fs = require('fs').promises;
const http = require('http');
const os = require('os');
const path = require('path');

const { ClaudeCodeWebServer } = require('../dist/server/index.js');
const { ChatStore } = require('../dist/server/chat/store.js');
const { AppDatabase } = require('../dist/server/services/database.js');
const { HistoryStore } = require('../dist/server/services/history-store.js');
const { PasteStore } = require('../dist/server/services/paste-store.js');
const { SessionStore } = require('../dist/server/services/session-store.js');
const { TranscriptStore } = require('../dist/server/services/transcript-store.js');
const { UsageStore } = require('../dist/server/services/usage-store.js');
const {
  WorkspaceSessionArtifactMigrator,
} = require('../dist/server/services/workspace-session-migrator.js');

function sessionRecord(id, ownerUserId, overrides = {}) {
  const created = new Date('2026-08-01T10:00:00.000Z');
  return {
    id,
    ownerUserId,
    name: `Session ${id}`,
    created,
    lastActivity: created,
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
      models: {},
    },
    maxBufferSize: 1000,
    ...overrides,
  };
}

function usageJob(sessionId, turnId, userId, userLogin, overrides = {}) {
  return {
    sessionId,
    nativeSessionId: null,
    turnId,
    userId,
    userLogin,
    agent: 'claude',
    model: 'claude-sonnet',
    project: null,
    startedAt: '2026-08-01T10:00:00.000Z',
    endedAt: '2026-08-01T10:00:01.000Z',
    durationMs: 1000,
    outcome: 'completed',
    modelTurns: 1,
    toolCalls: 0,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 15,
    costUsd: 0.01,
    reportsUsage: true,
    reportsCost: true,
    tools: [],
    models: [],
    ...overrides,
  };
}

async function fileExists(file) {
  return fs.access(file).then(() => true).catch(() => false);
}

describe('workspace session migration regressions', function () {
  this.timeout(15_000);

  it('publishes restored child shells without deleting their transcript or history', async function () {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-child-cold-restore-'));
    const dataDir = path.join(root, 'data');
    const workspaceRoot = path.join(root, 'workspace');
    await Promise.all([fs.mkdir(dataDir), fs.mkdir(workspaceRoot)]);
    const server = new ClaudeCodeWebServer({ dataDir, baseFolder: root, noAuth: true, port: 0 });
    try {
      const owner = server.database.upsertGitHubUser({
        githubId: 'child-restore-owner', githubLogin: 'child-restore-owner',
        githubName: null, email: null,
      });
      const scope = server.sessionStorageScope(owner.id, workspaceRoot);
      const parent = sessionRecord('parent-chat', owner.id, {
        workingDir: workspaceRoot, storageScope: scope, surface: 'chat',
      });
      const child = sessionRecord('child-shell', owner.id, {
        workingDir: workspaceRoot, storageScope: scope, ownerSessionId: parent.id,
        lastAgent: 'terminal',
      });
      const bound = server.sessionStore.openWorkspace(scope);
      assert.strictEqual(await bound.saveSessions(new Map([
        [parent.id, parent], [child.id, child],
      ])), true);

      server.transcriptStore.appendOutput(child, 'transcript survives\n');
      server.historyStore.append(child, ['history survives']);
      assert.match((await server.transcriptStore.readTranscriptChunks(child)).join(''), /survives/);
      assert.strictEqual((await server.historyStore.stat(child)).totalLines, 1);

      server.usageStore.unregister(scope);
      server.sessionStore.closeWorkspace(scope);
      await server.loadWorkspaceSessions(owner.id, workspaceRoot);

      assert.strictEqual(server.claudeSessions.has(parent.id), true);
      assert.strictEqual(server.claudeSessions.has(child.id), true);
      const restored = server.claudeSessions.get(child.id);
      assert.strictEqual(restored.ownerSessionId, parent.id);
      assert.match((await server.transcriptStore.readTranscriptChunks(restored)).join(''), /transcript survives/);
      assert.deepStrictEqual((await server.historyStore.read(restored, 0, 10)).lines, ['history survives']);
    } finally {
      await server.shutdown().catch(() => undefined);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('re-suspends a failed project reopen and blocks a generic diagnostic for its unloaded scope', async function () {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-project-reopen-failure-'));
    const dataDir = path.join(root, 'data');
    await fs.mkdir(dataDir);
    const server = new ClaudeCodeWebServer({ dataDir, baseFolder: root, noAuth: true, port: 0 });
    try {
      const owner = server.database.upsertGitHubUser({
        githubId: 'project-reopen-owner', githubLogin: 'project-reopen-owner',
        githubName: null, email: null,
      });
      const project = server.projectStore.createProject({
        ownerUserId: owner.id,
        name: 'Project with unavailable archive',
        executionKind: 'host',
      });
      const workspaceRoot = path.join(root, project.id);
      server.projectPaths.worktreePath = () => workspaceRoot;
      const scope = server.projectSessionStorageScope(project);
      const key = `${scope.ownerKey}\u0000${scope.workspaceRoot}`;
      await fs.mkdir(scope.workspaceRoot, { recursive: true });
      server.sessionStore.suspendWorkspace(scope);
      server.suspendedProjectScopes.set(project.id, scope);

      const originalLoad = server.loadWorkspaceSessions;
      server.loadWorkspaceSessions = async () => { throw new Error('archive owner binding is invalid'); };
      try {
        await assert.rejects(
          () => server.afterProjectWorkspaceRestored(project),
          /archive owner binding is invalid/,
        );
      } finally {
        server.loadWorkspaceSessions = originalLoad;
      }

      assert.throws(
        () => server.sessionStore.openWorkspace(scope),
        /temporarily suspended/,
        'a failed loader may not leave an empty writable archive behind',
      );
      assert.strictEqual(server.loadedWorkspaceScopes.has(key), false);
      assert.strictEqual(
        await server.projectHasIncompleteBinaryMigration(project),
        true,
        'every persistence error blocks rebuild even when the scope was never loaded',
      );
      assert.match(server.workspacePersistenceErrors.get(key), /owner binding/);
    } finally {
      await server.shutdown().catch(() => undefined);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('keeps live project sessions read-only while their exact archive is crash-staged', async function () {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-project-live-staging-'));
    const dataDir = path.join(root, 'data');
    const projectsRoot = path.join(root, 'projects');
    await Promise.all([fs.mkdir(dataDir), fs.mkdir(projectsRoot)]);
    const server = new ClaudeCodeWebServer({ dataDir, baseFolder: root, noAuth: true, port: 0 });
    let listener;
    try {
      const owner = server.database.upsertGitHubUser({
        githubId: 'project-live-staging-owner', githubLogin: 'project-live-staging-owner',
        githubName: null, email: null,
      });
      const project = server.projectStore.createProject({
        ownerUserId: owner.id,
        name: 'Project with a staged live archive',
        executionKind: 'host',
      });
      const workspaceRoot = path.join(projectsRoot, project.id);
      server.projectPaths.worktreePath = () => workspaceRoot;
      await fs.mkdir(workspaceRoot);
      const scope = server.projectSessionStorageScope(project);
      const key = `${scope.ownerKey}\u0000${scope.workspaceRoot}`;
      const session = sessionRecord('project-live-staged-chat', owner.id, {
        workingDir: workspaceRoot,
        storageScope: scope,
        surface: 'chat',
        projectId: project.id,
        projectWorkingDirKind: 'host',
        lastAgent: 'claude',
      });
      server.claudeSessions.set(session.id, session);
      const bound = server.sessionStore.openWorkspace(scope);
      assert.strictEqual(await bound.saveSessions(new Map([[session.id, session]])), true);
      server.usageStore.register(scope, bound.database);
      server.loadedWorkspaceScopes.add(key);

      const canonicalArchive = path.join(workspaceRoot, '.cc-web');
      const stagedArchive = path.join(
        path.dirname(workspaceRoot),
        `.${project.id}.ccweb-session-storage-retained`,
      );
      const archiveIdentity = await fs.lstat(canonicalArchive, { bigint: true });

      const authority = await server.beforeProjectWorkspaceReplacement(project);
      assert.strictEqual(authority.required, true);
      assert.strictEqual(authority.identity.dev, archiveIdentity.dev);
      assert.strictEqual(authority.identity.ino, archiveIdentity.ino);
      assert.match(session.persistenceUnavailable, /temporarily unavailable/i);
      assert.match(server.workspacePersistenceErrors.get(key), /temporarily unavailable/i);
      await fs.rename(canonicalArchive, stagedArchive);
      const stagedIdentity = await fs.lstat(stagedArchive, { bigint: true });
      assert.strictEqual(stagedIdentity.dev, archiveIdentity.dev);
      assert.strictEqual(stagedIdentity.ino, archiveIdentity.ino);

      const authSessionId = 'project-live-staging-auth';
      server.database.createAuthSession(
        authSessionId,
        owner.id,
        new Date(Date.now() + 60_000),
      );
      listener = http.createServer(server.app);
      await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
      const baseUrl = `http://127.0.0.1:${listener.address().port}`;
      const headers = { Cookie: `code_agents_webcli_session=${authSessionId}` };

      const upload = await fetch(
        `${baseUrl}/api/sessions/${session.id}/chat-attachments?name=blocked.txt`,
        { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: 'blocked' },
      );
      assert.strictEqual(upload.status, 409);
      assert.strictEqual((await upload.json()).error, 'session_persistence_unavailable');

      const paste = await fetch(`${baseUrl}/api/sessions/${session.id}/paste-image`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'image/png' },
        body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      });
      assert.strictEqual(paste.status, 409);
      assert.strictEqual((await paste.json()).error, 'session_persistence_unavailable');

      const branch = await fetch(`${baseUrl}/api/sessions/${session.id}/branch`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ turnId: 'unreachable-turn' }),
      });
      assert.strictEqual(branch.status, 409);
      assert.strictEqual((await branch.json()).error, 'session_persistence_unavailable');
      assert.strictEqual(
        await fileExists(canonicalArchive),
        false,
        'read-only routes cannot create a replacement archive over the staged authority',
      );

      const environmentOwner = server.getEnvironmentOwner(owner.id);
      assert.ok(environmentOwner);
      assert.strictEqual(
        await server.projectPaths.restoreWorkspaceSessionStorage(
          project,
          environmentOwner,
          authority.identity,
        ),
        true,
      );
      const reopened = await server.afterProjectWorkspaceRestored(project, authority.identity);
      assert.deepStrictEqual(reopened, authority.identity);
      await server.projectPaths.completeWorkspaceSessionStorageRestore(
        project,
        environmentOwner,
        reopened,
      );
      assert.deepStrictEqual(
        server.confirmProjectWorkspaceRestored(project, authority.identity),
        authority.identity,
      );
      const restored = server.claudeSessions.get(session.id);
      assert.ok(restored);
      assert.strictEqual(restored.persistenceUnavailable, undefined);
      assert.strictEqual(server.workspacePersistenceErrors.has(key), false);
      const restoredIdentity = await fs.lstat(canonicalArchive, { bigint: true });
      assert.strictEqual(restoredIdentity.dev, archiveIdentity.dev);
      assert.strictEqual(restoredIdentity.ino, archiveIdentity.ino);
      assert.strictEqual(await fileExists(stagedArchive), false);
    } finally {
      if (listener) {
        listener.closeAllConnections?.();
        await new Promise((resolve) => listener.close(() => resolve()));
      }
      await server.shutdown().catch(() => undefined);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('drains an already-admitted artifact append before committing lifecycle suspension', async function () {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-project-artifact-barrier-'));
    const dataDir = path.join(root, 'data');
    const projectsRoot = path.join(root, 'projects');
    await Promise.all([fs.mkdir(dataDir), fs.mkdir(projectsRoot)]);
    const server = new ClaudeCodeWebServer({ dataDir, baseFolder: root, noAuth: true, port: 0 });
    try {
      const owner = server.database.upsertGitHubUser({
        githubId: 'project-artifact-barrier-owner', githubLogin: 'project-artifact-barrier-owner',
        githubName: null, email: null,
      });
      const project = server.projectStore.createProject({
        ownerUserId: owner.id,
        name: 'Project with an admitted artifact append',
        executionKind: 'host',
      });
      const workspaceRoot = path.join(projectsRoot, project.id);
      server.projectPaths.worktreePath = () => workspaceRoot;
      await fs.mkdir(workspaceRoot);
      const scope = server.projectSessionStorageScope(project);
      const key = `${scope.ownerKey}\u0000${scope.workspaceRoot}`;
      const session = sessionRecord('project-artifact-barrier-chat', owner.id, {
        workingDir: workspaceRoot,
        storageScope: scope,
        surface: 'chat',
        projectId: project.id,
        projectWorkingDirKind: 'host',
      });
      server.claudeSessions.set(session.id, session);
      const bound = server.sessionStore.openWorkspace(scope);
      assert.strictEqual(await bound.saveSessions(new Map([[session.id, session]])), true);
      server.loadedWorkspaceScopes.add(key);

      const base = server.chatStore.basePath(session);
      let releaseAdmitted;
      const admittedGate = new Promise((resolve) => { releaseAdmitted = resolve; });
      server.chatStore.queues.set(base, admittedGate);
      const append = server.chatStore.append(session, [{
        t: 'message', seq: 1, id: 'admitted-message', role: 'user',
        content: 'durable before staging', at: '2026-08-05T12:00:00.000Z',
      }]);

      const originalFlush = server.chatStore.flush.bind(server.chatStore);
      let signalFlush;
      const flushStarted = new Promise((resolve) => { signalFlush = resolve; });
      server.chatStore.flush = async (ref) => {
        signalFlush();
        return originalFlush(ref);
      };
      const replacement = server.beforeProjectWorkspaceReplacement(project);
      await flushStarted;

      assert.match(session.persistenceUnavailable, /temporarily unavailable/i);
      assert.strictEqual(server.suspendedProjectScopes.has(project.id), false);
      assert.strictEqual(
        await fileExists(path.join(path.dirname(workspaceRoot), `.${project.id}.ccweb-session-storage-intent`)),
        false,
        'authority is not committed while an earlier append is still queued',
      );
      assert.strictEqual(
        await server.saveSessionsToDisk(),
        true,
        'an autosave may run while lifecycle is waiting on the artifact barrier',
      );
      assert.strictEqual(
        bound.database.raw.prepare(
          'SELECT COUNT(*) AS count FROM runtime_sessions WHERE id = ?',
        ).get(session.id).count,
        1,
        'the temporary lifecycle gate is not interpreted as session deletion',
      );

      releaseAdmitted();
      await append;
      const authority = await replacement;
      server.chatStore.flush = originalFlush;
      assert.strictEqual(authority.required, true);
      assert.strictEqual(server.suspendedProjectScopes.has(project.id), true);
      assert.match(
        await fs.readFile(
          path.join(workspaceRoot, '.cc-web', 'sessions', scope.ownerKey, session.id, 'chat.jsonl'),
          'utf8',
        ),
        /durable before staging/,
      );

      const environmentOwner = server.getEnvironmentOwner(owner.id);
      assert.ok(environmentOwner);
      await server.projectPaths.restoreWorkspaceSessionStorage(
        project,
        environmentOwner,
        authority.identity,
      );
      const reopened = await server.afterProjectWorkspaceRestored(project, authority.identity);
      await server.projectPaths.completeWorkspaceSessionStorageRestore(
        project,
        environmentOwner,
        reopened,
      );
      server.confirmProjectWorkspaceRestored(project, authority.identity);
    } finally {
      await server.shutdown().catch(() => undefined);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('takes lifecycle authority from the open database lease, never an already-swapped pathname', async function () {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-project-open-lease-authority-'));
    const dataDir = path.join(root, 'data');
    const projectsRoot = path.join(root, 'projects');
    await Promise.all([fs.mkdir(dataDir), fs.mkdir(projectsRoot)]);
    const server = new ClaudeCodeWebServer({ dataDir, baseFolder: root, noAuth: true, port: 0 });
    try {
      const owner = server.database.upsertGitHubUser({
        githubId: 'project-open-lease-owner', githubLogin: 'project-open-lease-owner',
        githubName: null, email: null,
      });
      const project = server.projectStore.createProject({
        ownerUserId: owner.id,
        name: 'Project with a pre-lifecycle archive swap',
        executionKind: 'host',
      });
      const workspaceRoot = path.join(projectsRoot, project.id);
      server.projectPaths.worktreePath = () => workspaceRoot;
      await fs.mkdir(workspaceRoot);
      const scope = server.projectSessionStorageScope(project);
      const key = `${scope.ownerKey}\u0000${scope.workspaceRoot}`;
      const session = sessionRecord('project-open-lease-chat', owner.id, {
        workingDir: workspaceRoot,
        storageScope: scope,
        surface: 'chat',
        projectId: project.id,
        projectWorkingDirKind: 'host',
      });
      server.claudeSessions.set(session.id, session);
      const bound = server.sessionStore.openWorkspace(scope);
      assert.strictEqual(await bound.saveSessions(new Map([[session.id, session]])), true);
      server.loadedWorkspaceScopes.add(key);

      const canonical = path.join(workspaceRoot, '.cc-web');
      const authoritative = path.join(workspaceRoot, '.cc-web-opened-original');
      await fs.rename(canonical, authoritative);
      await fs.mkdir(canonical);
      const replacementDatabase = path.join(canonical, 'session-state.sqlite');
      await fs.writeFile(replacementDatabase, 'safe-looking replacement must remain untouched');
      const replacementBefore = await fs.stat(replacementDatabase);

      await assert.rejects(
        () => server.beforeProjectWorkspaceReplacement(project),
        /Workspace directory changed|storage authority|authorised inode/,
      );

      assert.strictEqual(
        await fs.readFile(replacementDatabase, 'utf8'),
        'safe-looking replacement must remain untouched',
      );
      const replacementAfter = await fs.stat(replacementDatabase);
      assert.strictEqual(replacementAfter.ino, replacementBefore.ino);
      assert.strictEqual(replacementAfter.size, replacementBefore.size);
      assert.strictEqual(server.suspendedProjectScopes.has(project.id), false);
      assert.strictEqual(server.loadedWorkspaceScopes.has(key), true);
      const environmentOwner = server.getEnvironmentOwner(owner.id);
      assert.ok(environmentOwner);
      assert.strictEqual(
        await server.projectPaths.hasStagedWorkspaceSessionStorage(project, environmentOwner),
        false,
        'a failed pre-suspension lease check does not mint authority for the replacement',
      );
      assert.strictEqual(await fileExists(authoritative), true);
    } finally {
      await server.shutdown().catch(() => undefined);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('keeps an intent-only container archive unavailable when project environments are disabled', async function () {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-project-dark-intent-'));
    const dataDir = path.join(root, 'data');
    const projectsRoot = path.join(root, 'projects');
    await Promise.all([fs.mkdir(dataDir), fs.mkdir(projectsRoot)]);
    const server = new ClaudeCodeWebServer({ dataDir, baseFolder: root, noAuth: true, port: 0 });
    try {
      assert.strictEqual(server.containerizedEnvironmentsEnabled, false);
      const owner = server.database.upsertGitHubUser({
        githubId: 'project-dark-intent-owner', githubLogin: 'project-dark-intent-owner',
        githubName: null, email: null,
      });
      const project = server.projectStore.createProject({
        ownerUserId: owner.id,
        name: 'Container project with an intent-only archive',
        executionKind: 'container',
      });
      const workspaceRoot = path.join(projectsRoot, project.id);
      server.projectPaths.worktreePath = () => workspaceRoot;
      await fs.mkdir(workspaceRoot);
      const scope = server.projectSessionStorageScope(project);
      const key = `${scope.ownerKey}\u0000${scope.workspaceRoot}`;
      const bound = server.sessionStore.openWorkspace(scope);
      await bound.saveSessions(new Map());
      const environmentOwner = server.getEnvironmentOwner(owner.id);
      assert.ok(environmentOwner);
      const identity = bound.database.storageIdentity();
      await server.projectPaths.recordWorkspaceSessionStorageIntent(project, environmentOwner, identity);
      server.sessionStore.closeWorkspace(scope);

      const canonical = path.join(workspaceRoot, '.cc-web');
      const authoritative = path.join(workspaceRoot, '.cc-web-authoritative-offline');
      await fs.rename(canonical, authoritative);
      await fs.mkdir(canonical);
      await fs.writeFile(path.join(canonical, 'session-state.sqlite'), 'replacement must stay dark');

      await server.restoreStagedProjectSessionArchives();
      await server.discoverWorkspaceSessions();

      assert.strictEqual(server.unrestoredProjectScopes.has(key), true);
      assert.match(server.workspacePersistenceErrors.get(key), /crash-staged|enable project environments/i);
      assert.strictEqual(server.loadedWorkspaceScopes.has(key), false);
      assert.strictEqual(
        await fs.readFile(path.join(canonical, 'session-state.sqlite'), 'utf8'),
        'replacement must stay dark',
      );
      assert.strictEqual(await fileExists(authoritative), true);
    } finally {
      await server.shutdown().catch(() => undefined);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('cuts over independent units in one workspace while a conflicting sibling remains legacy', async function () {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-independent-units-'));
    const dataDir = path.join(root, 'data');
    const workspaceRoot = path.join(root, 'workspace');
    await Promise.all([fs.mkdir(dataDir), fs.mkdir(workspaceRoot)]);
    const server = new ClaudeCodeWebServer({ dataDir, baseFolder: root, noAuth: true, port: 0 });
    try {
      const owner = server.database.upsertGitHubUser({
        githubId: 'independent-unit-owner', githubLogin: 'independent-unit-owner',
        githubName: null, email: null,
      });
      const scope = server.sessionStorageScope(owner.id, workspaceRoot);
      const first = sessionRecord('unit-a', owner.id, { workingDir: workspaceRoot, surface: 'chat' });
      const second = sessionRecord('unit-b', owner.id, { workingDir: workspaceRoot, surface: 'chat' });
      const legacyStore = new SessionStore({ database: server.database });
      assert.strictEqual(await legacyStore.saveSessions(new Map([
        [first.id, first], [second.id, second],
      ])), true);

      // Model the recoverable duplicate state left by a destination commit
      // whose source transaction did not commit. The blocked unit must keep
      // this row as well as its global authority across an autosave.
      const bound = server.sessionStore.openWorkspace(scope);
      assert.strictEqual(await bound.saveSessions(new Map([
        [second.id, { ...second, storageScope: scope }],
      ])), true);

      const confirmed = [];
      server.workspaceArtifactMigrator = {
        migrate: async ({ id }) => id === second.id
          ? {
              status: 'partial',
              artifacts: [{ artifact: 'chat_log', state: 'blocked', reason: 'target_conflict' }],
            }
          : { status: 'complete', artifacts: [] },
        confirm: async ({ id }) => { confirmed.push(id); },
      };

      await server.migrateLegacySessions(new Map([
        [first.id, first], [second.id, second],
      ]));

      const legacyCount = (id) => server.database.raw.prepare(`
        SELECT COUNT(*) AS count FROM runtime_sessions WHERE owner_user_id = ? AND id = ?
      `).get(owner.id, id).count;
      const localCount = (id) => bound.database.raw.prepare(`
        SELECT COUNT(*) AS count FROM runtime_sessions WHERE owner_key = ? AND id = ?
      `).get(scope.ownerKey, id).count;
      assert.strictEqual(legacyCount(first.id), 0, 'independent unit A must cut over');
      assert.strictEqual(legacyCount(second.id), 1, 'conflicting unit B stays legacy');
      assert.strictEqual(localCount(first.id), 1);
      assert.strictEqual(localCount(second.id), 1, 'recoverable duplicate is retained');
      assert.strictEqual(server.claudeSessions.get(first.id).persistenceUnavailable, undefined);
      assert.match(server.claudeSessions.get(second.id).persistenceUnavailable, /unit unit-b/i);
      assert.ok(confirmed.includes(first.id));
      assert.strictEqual(confirmed.includes(second.id), false, 'legacy B files are not confirmed');

      assert.strictEqual(await server.saveSessionsToDisk(), true);
      assert.strictEqual(
        localCount(second.id),
        1,
        'a partial live map cannot prune a destination row while B remains legacy',
      );
    } finally {
      await server.shutdown().catch(() => undefined);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('keeps a parent and every descendant shell in one atomic unit and retries idempotently', async function () {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-dependent-unit-'));
    const dataDir = path.join(root, 'data');
    const workspaceRoot = path.join(root, 'workspace');
    await Promise.all([fs.mkdir(dataDir), fs.mkdir(workspaceRoot)]);
    const server = new ClaudeCodeWebServer({ dataDir, baseFolder: root, noAuth: true, port: 0 });
    try {
      const owner = server.database.upsertGitHubUser({
        githubId: 'dependent-unit-owner', githubLogin: 'dependent-unit-owner',
        githubName: null, email: null,
      });
      const parent = sessionRecord('parent-unit', owner.id, {
        workingDir: workspaceRoot, surface: 'chat',
      });
      const child = sessionRecord('child-unit', owner.id, {
        workingDir: workspaceRoot, ownerSessionId: parent.id,
      });
      const grandchild = sessionRecord('grandchild-unit', owner.id, {
        workingDir: workspaceRoot, ownerSessionId: child.id,
      });
      const legacyStore = new SessionStore({ database: server.database });
      assert.strictEqual(await legacyStore.saveSessions(new Map([
        [parent.id, parent], [child.id, child], [grandchild.id, grandchild],
      ])), true);

      let blockChild = true;
      let artifactOrder = [];
      const confirmed = [];
      server.workspaceArtifactMigrator = {
        migrate: async ({ id }) => {
          artifactOrder.push(id);
          if (blockChild && id === child.id) {
            return {
              status: 'partial',
              artifacts: [{ artifact: 'history_log', state: 'blocked', reason: 'target_conflict' }],
            };
          }
          return { status: 'complete', artifacts: [] };
        },
        confirm: async ({ id }) => { confirmed.push(id); },
      };
      const cutovers = [];
      const originalCutover = server.sessionStore.migrateLegacySessions.bind(server.sessionStore);
      server.sessionStore.migrateLegacySessions = (scope, database, ownerUserId, ids) => {
        const unitIds = [...ids];
        cutovers.push(unitIds);
        return originalCutover(scope, database, ownerUserId, unitIds);
      };

      // Reverse input order to prove dependency order is derived from the
      // ownership graph rather than SQLite/Map iteration order.
      await server.migrateLegacySessions(new Map([
        [grandchild.id, grandchild], [child.id, child], [parent.id, parent],
      ]));
      assert.deepStrictEqual(artifactOrder, [parent.id, child.id]);
      assert.deepStrictEqual(cutovers, [], 'no descendant cuts over without its parent unit');
      for (const session of [parent, child, grandchild]) {
        assert.strictEqual(
          server.database.raw.prepare(`
            SELECT COUNT(*) AS count FROM runtime_sessions WHERE owner_user_id = ? AND id = ?
          `).get(owner.id, session.id).count,
          1,
        );
        assert.match(server.claudeSessions.get(session.id).persistenceUnavailable, /parent-unit/i);
      }
      assert.deepStrictEqual(confirmed, []);

      blockChild = false;
      artifactOrder = [];
      await server.migrateLegacySessions(await legacyStore.loadSessions());
      assert.deepStrictEqual(artifactOrder, [parent.id, child.id, grandchild.id]);
      assert.deepStrictEqual(cutovers, [[parent.id, child.id, grandchild.id]]);
      const scope = server.sessionStorageScope(owner.id, workspaceRoot);
      const local = await server.sessionStore.openWorkspace(scope).loadSessions();
      for (const session of [parent, child, grandchild]) {
        assert.strictEqual(
          server.database.raw.prepare(`
            SELECT COUNT(*) AS count FROM runtime_sessions WHERE owner_user_id = ? AND id = ?
          `).get(owner.id, session.id).count,
          0,
        );
        assert.strictEqual(local.has(session.id), true);
        assert.strictEqual(server.claudeSessions.get(session.id).persistenceUnavailable, undefined);
        assert.ok(confirmed.includes(session.id));
      }

      // A further retry sees no source rows and neither duplicates nor prunes
      // the already completed unit.
      await server.migrateLegacySessions(await legacyStore.loadSessions());
      assert.deepStrictEqual(cutovers, [[parent.id, child.id, grandchild.id]]);
      assert.strictEqual((await server.sessionStore.openWorkspace(scope).loadSessions()).size, 3);
    } finally {
      await server.shutdown().catch(() => undefined);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an authorised-base child cwd that escapes its owner conversation workspace', async function () {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-child-scope-escape-'));
    const dataDir = path.join(root, 'data');
    const workspaceRoot = path.join(root, 'workspace');
    const escapedRoot = path.join(root, 'other-authorised-folder');
    await Promise.all([fs.mkdir(dataDir), fs.mkdir(workspaceRoot), fs.mkdir(escapedRoot)]);
    const server = new ClaudeCodeWebServer({ dataDir, baseFolder: root, noAuth: true, port: 0 });
    try {
      const owner = server.database.upsertGitHubUser({
        githubId: 'child-scope-owner', githubLogin: 'child-scope-owner',
        githubName: null, email: null,
      });
      const parent = sessionRecord('scope-parent', owner.id, {
        workingDir: workspaceRoot,
        surface: 'chat',
      });
      const child = sessionRecord('scope-child', owner.id, {
        workingDir: escapedRoot,
        ownerSessionId: parent.id,
      });
      const legacyStore = new SessionStore({ database: server.database });
      assert.strictEqual(await legacyStore.saveSessions(new Map([
        [parent.id, parent],
        [child.id, child],
      ])), true);
      const migrated = [];
      server.workspaceArtifactMigrator = {
        migrate: async ({ id }) => {
          migrated.push(id);
          return { status: 'complete', artifacts: [] };
        },
        confirm: async () => {},
      };

      await server.migrateLegacySessions(new Map([
        [parent.id, parent],
        [child.id, child],
      ]));

      assert.deepStrictEqual(migrated, [parent.id]);
      assert.strictEqual(
        server.database.raw.prepare(`
          SELECT COUNT(*) AS count FROM runtime_sessions WHERE owner_user_id = ? AND id = ?
        `).get(owner.id, child.id).count,
        1,
      );
      assert.match(
        server.claudeSessions.get(child.id).persistenceUnavailable,
        /leaves its owner conversation workspace/i,
      );
    } finally {
      await server.shutdown().catch(() => undefined);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('retries a legacy migration when its missing workspace is opened without a restart', async function () {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-live-migration-retry-'));
    const dataDir = path.join(root, 'data');
    const workspaceRoot = path.join(root, 'restored-workspace');
    await fs.mkdir(dataDir);
    const server = new ClaudeCodeWebServer({ dataDir, baseFolder: root, noAuth: true, port: 0 });
    try {
      const owner = server.database.upsertGitHubUser({
        githubId: 'live-retry-owner', githubLogin: 'live-retry-owner',
        githubName: null, email: null,
      });
      const session = sessionRecord('live-retry', owner.id, {
        workingDir: workspaceRoot,
        surface: 'chat',
      });
      const legacyStore = new SessionStore({ database: server.database });
      assert.strictEqual(await legacyStore.saveSessions(new Map([[session.id, session]])), true);

      await server.migrateLegacySessions(new Map([[session.id, session]]));
      assert.strictEqual(
        server.database.raw.prepare(`
          SELECT COUNT(*) AS count FROM runtime_sessions WHERE owner_user_id = ? AND id = ?
        `).get(owner.id, session.id).count,
        1,
      );
      assert.match(server.claudeSessions.get(session.id).persistenceUnavailable, /workspace|folder/i);

      await fs.mkdir(workspaceRoot);
      let migrationAttempts = 0;
      server.workspaceArtifactMigrator = {
        migrate: async () => {
          migrationAttempts += 1;
          // Keep the retry in flight for one microtask so the second lazy open
          // must join the same promise rather than start another cutover.
          await Promise.resolve();
          return { status: 'complete', artifacts: [] };
        },
        confirm: async () => {},
      };

      await Promise.all([
        server.loadWorkspaceSessions(owner.id, workspaceRoot),
        server.loadWorkspaceSessions(owner.id, workspaceRoot),
      ]);

      assert.strictEqual(migrationAttempts, 1, 'concurrent opens share one targeted retry');
      assert.strictEqual(
        server.database.raw.prepare(`
          SELECT COUNT(*) AS count FROM runtime_sessions WHERE owner_user_id = ? AND id = ?
        `).get(owner.id, session.id).count,
        0,
      );
      const restored = server.claudeSessions.get(session.id);
      assert.strictEqual(restored.persistenceUnavailable, undefined);
      assert.strictEqual(restored.storageScope.workspaceRoot, workspaceRoot);
      const scope = server.sessionStorageScope(owner.id, workspaceRoot);
      assert.strictEqual(
        (await server.sessionStore.openWorkspace(scope).loadSessions()).has(session.id),
        true,
      );
      assert.strictEqual(
        Array.from(server.workspacePersistenceErrors.keys())
          .some((key) => key.endsWith(`legacy:${session.id}`)),
        false,
        'the stale unavailable-root diagnostic is retired after live recovery',
      );
    } finally {
      await server.shutdown().catch(() => undefined);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('pins the orphan-usage destination before copying and never switches it on retry', async function () {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-orphan-pin-'));
    const dataDir = path.join(root, 'data');
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    await Promise.all([
      fs.mkdir(dataDir),
      fs.mkdir(first),
      fs.mkdir(second),
    ]);
    const server = new ClaudeCodeWebServer({
      dataDir,
      baseFolder: root,
      noAuth: true,
      port: 0,
    });
    try {
      const owner = server.database.upsertGitHubUser({
        githubId: 'stable-orphan-owner',
        githubLogin: 'orphan-owner',
        githubName: null,
        email: null,
      });
      new UsageStore(server.database).record(
        usageJob('deleted-session', 'turn-1', owner.id, owner.githubLogin),
      );
      server.database.setUserSetting(owner.id, 'selectedWorkingDir', first);

      const attempted = [];
      const prepared = [];
      server.sessionStore.migrateLegacyOrphanUsage = (scope, legacy, ownerUserId) => {
        attempted.push(scope.workspaceRoot);
        prepared.push(
          legacy.getUserSetting(ownerUserId, 'legacyUsageWorkspaceRoot.v1'),
        );
        return false;
      };

      await server.migrateLegacySessions(new Map());
      server.database.setUserSetting(owner.id, 'selectedWorkingDir', second);
      await server.migrateLegacySessions(new Map());

      assert.deepStrictEqual(attempted, [first, first]);
      assert.deepStrictEqual(
        prepared,
        [first, first],
        'the durable prepare marker must exist before either copy attempt',
      );
      assert.strictEqual(
        server.database.getUserSetting(owner.id, 'legacyUsageWorkspaceRoot.v1'),
        first,
      );
      assert.strictEqual(
        server.database.raw.prepare(
          'SELECT COUNT(*) AS count FROM usage_jobs WHERE user_id = ?',
        ).get(owner.id).count,
        1,
        'a failed retry keeps the legacy source',
      );
    } finally {
      await server.shutdown();
      server.saveSessionsToDisk = async () => {};
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('does not overwrite a non-equivalent workspace session with the same legacy id', async function () {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-session-collision-'));
    const dataDir = path.join(root, 'data');
    const workspaceRoot = path.join(root, 'workspace');
    await Promise.all([fs.mkdir(dataDir), fs.mkdir(workspaceRoot)]);
    const legacy = new SessionStore({ dataDir });
    const owner = legacy.database.upsertGitHubUser({
      githubId: 'collision-owner',
      githubLogin: 'collision-owner',
      githubName: null,
      email: null,
    });
    const scope = { workspaceRoot, ownerKey: 'c'.repeat(64) };
    try {
      await legacy.saveSessions(new Map([
        ['same-id', sessionRecord('same-id', owner.id, { name: 'Legacy source' })],
      ]));
      const target = legacy.openWorkspace(scope);
      await target.saveSessions(new Map([
        ['same-id', sessionRecord('same-id', owner.id, { name: 'Workspace record' })],
      ]));

      assert.strictEqual(
        legacy.migrateLegacySessions(scope, legacy.database, owner.id, ['same-id']),
        false,
      );
      assert.strictEqual((await target.loadSessions()).get('same-id').name, 'Workspace record');
      assert.strictEqual(
        legacy.database.raw.prepare(
          'SELECT name FROM runtime_sessions WHERE owner_user_id = ? AND id = ?',
        ).get(owner.id, 'same-id').name,
        'Legacy source',
      );
    } finally {
      legacy.closeWorkspaces();
      legacy.database.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('holds a source write reservation across session select, copy, verification, and delete', async function () {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-session-source-lock-'));
    const dataDir = path.join(root, 'data');
    const workspaceRoot = path.join(root, 'workspace');
    await Promise.all([fs.mkdir(dataDir), fs.mkdir(workspaceRoot)]);
    const legacy = new SessionStore({ dataDir });
    const owner = legacy.database.upsertGitHubUser({
      githubId: 'locked-session-owner',
      githubLogin: 'locked-session-owner',
      githubName: null,
      email: null,
    });
    const contender = new AppDatabase({ dataDir });
    contender.raw.pragma('busy_timeout = 0');
    const scope = { workspaceRoot, ownerKey: 'l'.repeat(64) };
    const id = 'locked-source';
    const target = legacy.openWorkspace(scope);
    const targetRaw = target.database.raw;
    const originalPrepare = targetRaw.prepare;
    let attempted = false;
    let contenderError = null;
    try {
      await legacy.saveSessions(new Map([
        [id, sessionRecord(id, owner.id, { name: 'Selected before lock' })],
      ]));
      targetRaw.prepare = function (sql) {
        if (!attempted && sql.includes('SELECT COUNT(*) AS n FROM runtime_sessions')) {
          attempted = true;
          try {
            contender.raw.prepare(`
              UPDATE runtime_sessions SET name = ? WHERE owner_user_id = ? AND id = ?
            `).run('Committed after SELECT', owner.id, id);
          } catch (error) {
            contenderError = error;
          }
        }
        return originalPrepare.call(this, sql);
      };

      assert.strictEqual(
        legacy.migrateLegacySessions(scope, legacy.database, owner.id, [id]),
        true,
      );
      assert.strictEqual(attempted, true);
      assert.match(String(contenderError?.message), /database is locked/i);
      assert.strictEqual((await target.loadSessions()).get(id).name, 'Selected before lock');
      assert.strictEqual(
        legacy.database.raw.prepare(
          'SELECT COUNT(*) AS count FROM runtime_sessions WHERE owner_user_id = ? AND id = ?',
        ).get(owner.id, id).count,
        0,
      );
    } finally {
      targetRaw.prepare = originalPrepare;
      contender.close();
      legacy.closeWorkspaces();
      legacy.database.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('retains rollback copies until SQLite cutover and binds cleanup to both owner identities', async function () {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-cross-store-cutover-'));
    const dataDir = path.join(root, 'data');
    const workspaceRoot = path.join(root, 'workspace');
    await Promise.all([fs.mkdir(dataDir), fs.mkdir(workspaceRoot)]);
    const legacy = new SessionStore({ dataDir });
    const owner = legacy.database.upsertGitHubUser({
      githubId: 'cross-store-owner',
      githubLogin: 'cross-store-owner',
      githubName: null,
      email: null,
    });
    const scope = { workspaceRoot, ownerKey: 'x'.repeat(64) };
    const id = 'cross-store';
    const source = path.join(dataDir, String(owner.id), `${id}.jsonl`);
    const backup = path.join(
      path.dirname(source),
      `.${path.basename(source)}.ccweb-session-migration.bak`,
    );
    const ref = { id, ownerUserId: owner.id, storageScope: scope };
    const migrator = new WorkspaceSessionArtifactMigrator({ legacyStorageDir: dataDir });
    try {
      await legacy.saveSessions(new Map([[id, sessionRecord(id, owner.id)]]));
      await fs.mkdir(path.dirname(source), { recursive: true });
      await fs.writeFile(source, '{"seq":1,"type":"session"}\n');

      assert.strictEqual((await migrator.migrate(ref)).status, 'complete');
      assert.strictEqual(await fs.access(source).then(() => true).catch(() => false), false);
      assert.strictEqual(await fs.access(backup).then(() => true).catch(() => false), true);
      assert.strictEqual(
        legacy.database.raw.prepare('SELECT COUNT(*) AS count FROM runtime_sessions WHERE id = ?').get(id).count,
        1,
        'file verification alone must not cut over the SQLite authority',
      );

      assert.strictEqual(
        legacy.migrateLegacySessions(scope, legacy.database, owner.id, [id]),
        true,
      );
      assert.strictEqual(
        legacy.database.raw.prepare('SELECT COUNT(*) AS count FROM runtime_sessions WHERE id = ?').get(id).count,
        0,
      );

      // A workspace marker is user-modifiable and cannot nominate a numeric
      // legacy namespace. A recreated installation with a different local id
      // must leave the old rollback authority untouched for explicit repair.
      await assert.rejects(
        migrator.confirm({ ...ref, ownerUserId: 909 }),
        /Invalid legacy migration marker/,
      );
      assert.strictEqual(await fs.access(backup).then(() => true).catch(() => false), true);

      await migrator.confirm(ref);
      assert.strictEqual(await fs.access(backup).then(() => true).catch(() => false), false);
    } finally {
      legacy.closeWorkspaces();
      legacy.database.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('does not overwrite a non-equivalent orphan usage job with the same id', async function () {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-usage-collision-'));
    const dataDir = path.join(root, 'data');
    const workspaceRoot = path.join(root, 'workspace');
    await Promise.all([fs.mkdir(dataDir), fs.mkdir(workspaceRoot)]);
    const legacy = new SessionStore({ dataDir });
    const owner = legacy.database.upsertGitHubUser({
      githubId: 'usage-collision-owner',
      githubLogin: 'usage-collision-owner',
      githubName: null,
      email: null,
    });
    const scope = { workspaceRoot, ownerKey: 'u'.repeat(64) };
    try {
      new UsageStore(legacy.database).record(
        usageJob('deleted-session', 'turn-1', owner.id, owner.githubLogin, { costUsd: 1.25 }),
      );
      const target = legacy.openWorkspace(scope);
      new UsageStore({ database: target.database, ownerKey: scope.ownerKey }).record(
        usageJob('deleted-session', 'turn-1', owner.id, owner.githubLogin, { costUsd: 9.99 }),
      );

      assert.strictEqual(
        legacy.migrateLegacyOrphanUsage(scope, legacy.database, owner.id),
        false,
      );
      assert.strictEqual(
        target.database.raw.prepare(
          'SELECT cost_usd FROM usage_jobs WHERE owner_key = ? AND id = ?',
        ).get(scope.ownerKey, 'deleted-session:turn-1').cost_usd,
        9.99,
      );
      assert.strictEqual(
        legacy.database.raw.prepare(
          'SELECT cost_usd FROM usage_jobs WHERE user_id = ? AND id = ?',
        ).get(owner.id, 'deleted-session:turn-1').cost_usd,
        1.25,
      );
    } finally {
      legacy.closeWorkspaces();
      legacy.database.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('holds a source write reservation while orphan usage and its children are copied', async function () {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-orphan-source-lock-'));
    const dataDir = path.join(root, 'data');
    const workspaceRoot = path.join(root, 'workspace');
    await Promise.all([fs.mkdir(dataDir), fs.mkdir(workspaceRoot)]);
    const legacy = new SessionStore({ dataDir });
    const owner = legacy.database.upsertGitHubUser({
      githubId: 'locked-orphan-owner',
      githubLogin: 'locked-orphan-owner',
      githubName: null,
      email: null,
    });
    new UsageStore(legacy.database).record(
      usageJob('deleted-session', 'turn-locked', owner.id, owner.githubLogin, {
        costUsd: 2.5,
        tools: [{ tool: 'Read', calls: 2 }],
      }),
    );
    const contender = new AppDatabase({ dataDir });
    contender.raw.pragma('busy_timeout = 0');
    const scope = { workspaceRoot, ownerKey: 'o'.repeat(64) };
    const target = legacy.openWorkspace(scope);
    const targetRaw = target.database.raw;
    const originalPrepare = targetRaw.prepare;
    let attempted = false;
    let contenderError = null;
    try {
      targetRaw.prepare = function (sql) {
        if (!attempted && sql.includes('SELECT COUNT(*) AS n FROM usage_jobs')) {
          attempted = true;
          try {
            contender.raw.prepare(`
              UPDATE usage_jobs SET cost_usd = ? WHERE user_id = ? AND id = ?
            `).run(99, owner.id, 'deleted-session:turn-locked');
          } catch (error) {
            contenderError = error;
          }
        }
        return originalPrepare.call(this, sql);
      };

      assert.strictEqual(
        legacy.migrateLegacyOrphanUsage(scope, legacy.database, owner.id),
        true,
      );
      assert.strictEqual(attempted, true);
      assert.match(String(contenderError?.message), /database is locked/i);
      assert.strictEqual(
        target.database.raw.prepare(
          'SELECT cost_usd FROM usage_jobs WHERE owner_key = ? AND id = ?',
        ).get(scope.ownerKey, 'deleted-session:turn-locked').cost_usd,
        2.5,
      );
      assert.strictEqual(
        target.database.raw.prepare(
          'SELECT calls FROM usage_job_tools WHERE owner_key = ? AND job_id = ? AND tool = ?',
        ).get(scope.ownerKey, 'deleted-session:turn-locked', 'Read').calls,
        2,
      );
      assert.strictEqual(
        legacy.database.raw.prepare(
          'SELECT COUNT(*) AS count FROM usage_jobs WHERE user_id = ? AND id = ?',
        ).get(owner.id, 'deleted-session:turn-locked').count,
        0,
      );
    } finally {
      targetRaw.prepare = originalPrepare;
      contender.close();
      legacy.closeWorkspaces();
      legacy.database.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rebinds numeric owner identity and login only inside the stable owner key', async function () {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-owner-rebind-'));
    const stableOwnerKey = 'a'.repeat(64);
    const otherOwnerKey = 'b'.repeat(64);
    let store = new SessionStore({ workspaceRoot, ownerKey: stableOwnerKey });
    try {
      await store.saveSessions(new Map([
        ['owned', sessionRecord('owned', 41)],
      ]));
      new UsageStore({ database: store.database, ownerKey: stableOwnerKey }).record(
        usageJob('owned', 'turn-1', 41, 'old-login'),
      );
      store.database.close();

      const other = new SessionStore({ workspaceRoot, ownerKey: otherOwnerKey });
      await other.saveSessions(new Map([
        ['other', sessionRecord('other', 77)],
      ]));
      new UsageStore({ database: other.database, ownerKey: otherOwnerKey }).record(
        usageJob('other', 'turn-1', 77, 'other-login'),
      );
      other.database.close();

      store = new SessionStore({ workspaceRoot, ownerKey: stableOwnerKey });
      store.rebindWorkspaceOwner(909, 'renamed-login');

      assert.strictEqual((await store.loadSessions()).get('owned').ownerUserId, 909);
      assert.deepStrictEqual(
        { ...store.database.raw.prepare(
          'SELECT user_id, user_login FROM usage_jobs WHERE owner_key = ? AND id = ?',
        ).get(stableOwnerKey, 'owned:turn-1') },
        { user_id: 909, user_login: 'renamed-login' },
      );
      assert.strictEqual(
        store.database.raw.prepare(
          'SELECT owner_user_id FROM runtime_sessions WHERE owner_key = ? AND id = ?',
        ).get(otherOwnerKey, 'other').owner_user_id,
        77,
      );
      assert.deepStrictEqual(
        { ...store.database.raw.prepare(
          'SELECT user_id, user_login FROM usage_jobs WHERE owner_key = ? AND id = ?',
        ).get(otherOwnerKey, 'other:turn-1') },
        { user_id: 77, user_login: 'other-login' },
      );
    } finally {
      store.database.close();
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('migrates and cold-restores a complete semantic legacy fixture exactly once', async function () {
    this.timeout(30_000);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-semantic-migration-'));
    const dataDir = path.join(root, 'data');
    const workspaceRoot = path.join(root, 'workspace');
    await Promise.all([fs.mkdir(dataDir), fs.mkdir(workspaceRoot)]);

    const sessionId = 'semantic-legacy-session';
    const turnId = 'semantic-turn';
    const nativeSessionId = 'native-semantic-session';
    const encryptionKey = Buffer.alloc(32, 29).toString('base64');
    const serverOptions = {
      dataDir,
      baseFolder: root,
      port: 0,
      githubClientId: 'semantic-migration-client',
      githubClientSecret: 'semantic-migration-secret',
      allowedGitHubIds: 'semantic-migration-owner',
      encryptionKey,
    };
    let legacyDatabase = null;
    let firstServer = null;
    let secondServer = null;
    let listener = null;

    try {
      // Produce every source artifact through the same stores used by the
      // pre-workspace release. Hand-authored stand-ins can miss an index or a
      // manifest invariant and would not prove that a real installation moves.
      legacyDatabase = new AppDatabase({ dataDir });
      const owner = legacyDatabase.upsertGitHubUser({
        githubId: 'semantic-migration-owner',
        githubLogin: 'semantic-owner',
        githubName: 'Semantic Owner',
        email: 'semantic@example.test',
      });
      const legacySession = sessionRecord(sessionId, owner.id, {
        name: 'Legacy semantic chat',
        customName: 'Migrated semantic chat',
        workingDir: workspaceRoot,
        surface: 'chat',
        lastAgent: 'claude',
        runtimeLabel: 'Claude semantic fixture',
        nativeChatSessionId: nativeSessionId,
        chatModelOverride: 'claude-sonnet-4',
        chatModelPinned: 'claude-sonnet-4',
        chatEffortOverride: 'high',
        chatPlanMode: true,
        tabOpen: true,
        tabOrder: 0,
      });
      const legacySessionStore = new SessionStore({ database: legacyDatabase });
      assert.strictEqual(
        await legacySessionStore.saveSessions(new Map([[sessionId, legacySession]])),
        true,
      );

      const legacyRef = { id: sessionId, ownerUserId: owner.id };
      const chatStore = new ChatStore({ storageDir: dataDir });
      const fixtureEvents = (await fs.readFile(
        path.join(__dirname, 'fixtures', 'chat', 'store-events.jsonl'),
        'utf8',
      )).trim().split('\n').map((line) => JSON.parse(line));
      fixtureEvents[0] = {
        ...fixtureEvents[0],
        nativeSessionId,
        cwd: workspaceRoot,
      };
      const pendingQuestion = {
        requestId: 'semantic-question',
        origin: 'structured_handoff',
        question: 'Which migration result should be retained?',
        header: 'Migration choice',
        multiSelect: false,
        options: [
          { optionId: 'complete', label: 'Complete', description: 'Keep every artifact.' },
          { optionId: 'partial', label: 'Partial', description: 'Keep only the chat log.' },
        ],
        ts: 1013,
      };
      await chatStore.append(legacyRef, [
        ...fixtureEvents,
        { t: 'question', seq: 14, ts: 1013, request: pendingQuestion },
      ]);
      const planDocument = {
        markdown: '# Durable migration plan\n\n- Preserve every semantic store.\n- Reopen cold.',
        revision: 3,
        ts: 1014,
      };
      await chatStore.setPlanDocument(legacyRef, planDocument);

      const transcriptStore = new TranscriptStore({ storageDir: dataDir });
      transcriptStore.appendOutput(legacyRef, 'semantic transcript: command output survives\n');
      assert.match(
        (await transcriptStore.readTranscriptChunks(legacyRef)).join(''),
        /command output survives/,
      );

      const historyStore = new HistoryStore({ storageDir: dataDir });
      const historyLines = [
        'semantic history line one',
        'semantic history line two',
      ];
      historyStore.append(legacyRef, historyLines);
      assert.strictEqual((await historyStore.stat(legacyRef)).totalLines, historyLines.length);

      const firstPng = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
      ]);
      const pasteStore = new PasteStore({
        storageDir: dataDir,
        now: () => new Date('2026-08-01T10:02:00.000Z'),
        randomId: () => 'semanticpaste',
      });
      const firstPaste = await pasteStore.save(
        { ...legacyRef, workingDir: workspaceRoot },
        firstPng,
      );
      assert.deepStrictEqual(await fs.readFile(firstPaste.absolutePath), firstPng);

      const usageStore = new UsageStore(legacyDatabase);
      const usageId = usageStore.record(usageJob(
        sessionId,
        turnId,
        owner.id,
        owner.githubLogin,
        {
          nativeSessionId,
          model: 'claude-sonnet-4',
          modelTurns: 3,
          toolCalls: 3,
          inputTokens: 170,
          outputTokens: 65,
          cacheReadTokens: 20,
          cacheWriteTokens: 4,
          reasoningTokens: 12,
          totalTokens: 271,
          costUsd: 0.031,
          tools: [
            { tool: 'Read', calls: 2 },
            { tool: 'Bash', calls: 1 },
          ],
          models: [
            {
              model: 'claude-sonnet-4', calls: 2,
              inputTokens: 150, outputTokens: 60,
              cacheReadTokens: 20, cacheWriteTokens: 4, costUsd: 0.026,
            },
            {
              model: 'claude-haiku-3-5', calls: 1,
              inputTokens: 20, outputTokens: 5,
              cacheReadTokens: null, cacheWriteTokens: null, costUsd: 0.005,
            },
          ],
        },
      ));

      const legacyArtifactPaths = [
        path.join(dataDir, String(owner.id), `${sessionId}.jsonl`),
        path.join(dataDir, String(owner.id), `${sessionId}.idx`),
        path.join(dataDir, String(owner.id), `${sessionId}.plan`),
        path.join(dataDir, 'transcripts', String(owner.id), `${sessionId}.md`),
        path.join(dataDir, 'history', String(owner.id), `${sessionId}.log`),
        path.join(dataDir, 'history', String(owner.id), `${sessionId}.idx`),
        path.join(dataDir, 'pastes', String(owner.id), `${sessionId}.json`),
      ];
      for (const source of legacyArtifactPaths) {
        assert.strictEqual(await fileExists(source), true, `real legacy fixture missing ${source}`);
      }

      legacyDatabase.close();
      legacyDatabase = null;

      firstServer = new ClaudeCodeWebServer(serverOptions);
      await firstServer.loadPersistedSessions();
      const migrated = firstServer.claudeSessions.get(sessionId);
      assert.ok(migrated, 'the migrated chat is published after verified cutover');
      assert.strictEqual(migrated.persistenceUnavailable, undefined);
      assert.strictEqual(migrated.nativeChatSessionId, nativeSessionId);
      assert.strictEqual(migrated.chatPlanMode, true);
      assert.strictEqual(migrated.chatEffortOverride, 'high');
      assert.strictEqual(migrated.customName, 'Migrated semantic chat');
      const scope = migrated.storageScope;
      assert.ok(scope);
      assert.strictEqual(scope.workspaceRoot, workspaceRoot);

      const workspaceStore = firstServer.sessionStore.openWorkspace(scope);
      const localDb = workspaceStore.database.raw;
      const localCounts = () => ({
        sessions: localDb.prepare(
          'SELECT COUNT(*) AS count FROM runtime_sessions WHERE owner_key = ? AND id = ?',
        ).get(scope.ownerKey, sessionId).count,
        usage: localDb.prepare(
          'SELECT COUNT(*) AS count FROM usage_jobs WHERE owner_key = ? AND id = ?',
        ).get(scope.ownerKey, usageId).count,
        models: localDb.prepare(
          'SELECT COUNT(*) AS count FROM usage_job_models WHERE owner_key = ? AND job_id = ?',
        ).get(scope.ownerKey, usageId).count,
        tools: localDb.prepare(
          'SELECT COUNT(*) AS count FROM usage_job_tools WHERE owner_key = ? AND job_id = ?',
        ).get(scope.ownerKey, usageId).count,
      });
      assert.deepStrictEqual(localCounts(), { sessions: 1, usage: 1, models: 2, tools: 2 });

      const sessionDir = path.join(
        workspaceRoot,
        '.cc-web',
        'sessions',
        scope.ownerKey,
        sessionId,
      );
      for (const target of [
        'chat.jsonl', 'chat.idx', 'chat.plan', 'transcript.md',
        'history.log', 'history.idx', 'paste-manifest.json',
      ]) {
        assert.strictEqual(await fileExists(path.join(sessionDir, target)), true, `missing ${target}`);
      }

      // Retrying the real coordinator after the source authority has gone is
      // a no-op: it neither duplicates child rows nor prunes the completed row.
      const retrySource = await firstServer.sessionStore.loadLegacySessions(owner.id);
      assert.strictEqual(retrySource.size, 0);
      await firstServer.migrateLegacySessions(retrySource);
      assert.deepStrictEqual(localCounts(), { sessions: 1, usage: 1, models: 2, tools: 2 });

      const assertNoGlobalResidue = async (server) => {
        assert.strictEqual(server.database.raw.prepare(
          'SELECT COUNT(*) AS count FROM runtime_sessions WHERE owner_user_id = ? AND id = ?',
        ).get(owner.id, sessionId).count, 0);
        assert.strictEqual(server.database.raw.prepare(
          'SELECT COUNT(*) AS count FROM usage_jobs WHERE user_id = ? AND id = ?',
        ).get(owner.id, usageId).count, 0);
        assert.strictEqual(server.database.raw.prepare(
          'SELECT COUNT(*) AS count FROM usage_job_models WHERE job_id = ?',
        ).get(usageId).count, 0);
        assert.strictEqual(server.database.raw.prepare(
          'SELECT COUNT(*) AS count FROM usage_job_tools WHERE job_id = ?',
        ).get(usageId).count, 0);
        for (const source of legacyArtifactPaths) {
          assert.strictEqual(await fileExists(source), false, `legacy source remains at ${source}`);
          const backup = path.join(
            path.dirname(source),
            `.${path.basename(source)}.ccweb-session-migration.bak`,
          );
          assert.strictEqual(await fileExists(backup), false, `rollback backup remains at ${backup}`);
        }
        assert.strictEqual(
          await fileExists(path.join(sessionDir, '.legacy-artifact-migration.v1.json')),
          false,
          'the confirmed per-session migration marker is retired',
        );
      };
      await assertNoGlobalResidue(firstServer);

      await firstServer.shutdown();
      firstServer.saveSessionsToDisk = async () => {};
      firstServer = null;

      // A brand-new process model has only the global owner/root catalog and
      // the workspace archive. It must rediscover and reopen the whole chat.
      secondServer = new ClaudeCodeWebServer(serverOptions);
      await secondServer.loadPersistedSessions();
      const restored = secondServer.claudeSessions.get(sessionId);
      assert.ok(restored, 'cold startup rediscovers the workspace-local session');
      assert.strictEqual(restored.storageScope.ownerKey, scope.ownerKey);
      assert.strictEqual(restored.tabOpen, true);
      assert.strictEqual(restored.chatModelOverride, 'claude-sonnet-4');

      const snapshot = await secondServer.chatStore.snapshot(restored, { runtime: 'claude' });
      assert.match(JSON.stringify(snapshot.messages), /Fix the login bug please/);
      assert.deepStrictEqual(
        snapshot.pendingQuestions.map((question) => question.requestId),
        [pendingQuestion.requestId],
      );
      assert.deepStrictEqual(await secondServer.chatStore.planDocument(restored), planDocument);
      assert.strictEqual(
        (await secondServer.transcriptStore.readTranscriptChunks(restored)).join(''),
        'semantic transcript: command output survives\n',
      );
      assert.deepStrictEqual(
        (await secondServer.historyStore.read(restored, 0, 20)).lines,
        historyLines,
      );

      const restoredUsage = secondServer.usageStore.job(usageId, {
        userId: owner.id,
        scope: 'self',
      });
      assert.ok(restoredUsage);
      assert.strictEqual(restoredUsage.totalTokens, 271);
      assert.deepStrictEqual(restoredUsage.tools.map((tool) => ({ ...tool })), [
        { tool: 'Read', calls: 2 },
        { tool: 'Bash', calls: 1 },
      ]);
      assert.deepStrictEqual(restoredUsage.models, [
        {
          model: 'claude-sonnet-4', calls: 2,
          inputTokens: 150, outputTokens: 60,
          cacheReadTokens: 20, cacheWriteTokens: 4, costUsd: 0.026,
        },
        {
          model: 'claude-haiku-3-5', calls: 1,
          inputTokens: 20, outputTokens: 5,
          cacheReadTokens: null, cacheWriteTokens: null, costUsd: 0.005,
        },
      ]);
      assert.deepStrictEqual(
        secondServer.usageStore.export({ userId: owner.id, scope: 'self' })
          .jobs.map((job) => job.id),
        [usageId],
      );

      const migratedManifest = JSON.parse(await fs.readFile(
        path.join(sessionDir, 'paste-manifest.json'),
        'utf8',
      ));
      assert.strictEqual(migratedManifest.entries.length, 1);
      assert.strictEqual(migratedManifest.entries[0].path, firstPaste.absolutePath);
      assert.deepStrictEqual(await fs.readFile(firstPaste.absolutePath), firstPng);
      const secondPng = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01,
      ]);
      await secondServer.pasteStore.save(restored, secondPng);
      assert.strictEqual(
        JSON.parse(await fs.readFile(path.join(sessionDir, 'paste-manifest.json'), 'utf8'))
          .entries.length,
        2,
        'the cold store reads and extends the migrated manifest',
      );

      const authSessionId = 'semantic-migration-auth-session';
      secondServer.database.createAuthSession(
        authSessionId,
        owner.id,
        new Date(Date.now() + 60_000),
      );
      listener = http.createServer(secondServer.app);
      await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
      const baseUrl = `http://127.0.0.1:${listener.address().port}`;
      const headers = { Cookie: `code_agents_webcli_session=${authSessionId}` };

      const listResponse = await fetch(`${baseUrl}/api/sessions/list`, { headers });
      assert.strictEqual(listResponse.status, 200);
      assert.deepStrictEqual(
        (await listResponse.json()).sessions.map((session) => session.id),
        [sessionId],
      );

      const exportResponse = await fetch(
        `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/export.md`,
        { headers },
      );
      assert.strictEqual(exportResponse.status, 200);
      const exported = await exportResponse.text();
      assert.match(exported, /# Migrated semantic chat/);
      assert.match(exported, /semantic history line one/);
      assert.match(exported, /semantic history line two/);

      await assertNoGlobalResidue(secondServer);
    } finally {
      if (listener) {
        listener.closeAllConnections?.();
        await new Promise((resolve) => listener.close(() => resolve()));
      }
      if (secondServer) {
        await secondServer.shutdown().catch(() => undefined);
        secondServer.saveSessionsToDisk = async () => {};
      }
      if (firstServer) {
        await firstServer.shutdown().catch(() => undefined);
        firstServer.saveSessionsToDisk = async () => {};
      }
      legacyDatabase?.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
