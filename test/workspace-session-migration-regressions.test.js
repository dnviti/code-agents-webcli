const assert = require('assert');
const fsSync = require('fs');
const fs = fsSync.promises;
const http = require('http');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');

const { ClaudeCodeWebServer } = require('../dist/server/index.js');
const { AppDatabase } = require('../dist/server/services/database.js');
const { SessionStore } = require('../dist/server/services/session-store.js');
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
      server.claudeSessions.set(parent.id, parent);
      server.claudeSessions.set(child.id, child);
      assert.strictEqual(await server.saveSessionsToDisk(), true);

      server.transcriptStore.appendOutput(child, 'transcript survives\n');
      server.historyStore.append(child, ['history survives']);
      assert.match((await server.transcriptStore.readTranscriptChunks(child)).join(''), /survives/);
      assert.strictEqual((await server.historyStore.stat(child)).totalLines, 1);

      server.claudeSessions.clear();
      await server.loadPersistedSessions();

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
      server.suspendedProjectScopes.set(project.id, scope);

      const originalIdentity = server.projectPaths.workspaceSessionStorageIdentity;
      server.projectPaths.workspaceSessionStorageIdentity = async () => {
        throw new Error('archive owner binding is invalid');
      };
      try {
        await assert.rejects(
          () => server.afterProjectWorkspaceRestored(project),
          /archive owner binding is invalid/,
        );
      } finally {
        server.projectPaths.workspaceSessionStorageIdentity = originalIdentity;
      }

      assert.strictEqual(server.suspendedProjectScopes.has(project.id), true);
      assert.strictEqual(server.loadedWorkspaceScopes.has(key), false);
      assert.strictEqual(
        await server.projectSessionStorageIsUnavailable(project),
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
      assert.strictEqual(await server.saveSessionsToDisk(), true);
      await server.chatStore.append(session, [{
        t: 'state', seq: 1, ts: 1, state: 'idle',
      }]);
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
        await server.confirmProjectWorkspaceRestored(project, authority.identity),
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
    let releaseAdmitted = () => {};
    let originalFlush;
    let append;
    let replacement;
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
      assert.strictEqual(await server.saveSessionsToDisk(), true);
      server.loadedWorkspaceScopes.add(key);

      const base = server.chatStore.basePath(session);
      const admittedGate = new Promise((resolve) => { releaseAdmitted = resolve; });
      server.chatStore.queues.set(base, admittedGate);
      append = server.chatStore.append(session, [{
        t: 'message', seq: 1, id: 'admitted-message', role: 'user',
        content: 'durable before staging', at: '2026-08-05T12:00:00.000Z',
      }]);

      originalFlush = server.chatStore.flush.bind(server.chatStore);
      let signalFlush;
      const flushStarted = new Promise((resolve) => { signalFlush = resolve; });
      server.chatStore.flush = async (ref) => {
        signalFlush();
        return originalFlush(ref);
      };
      replacement = server.beforeProjectWorkspaceReplacement(project);
      let flushDeadline;
      try {
        await Promise.race([
          flushStarted,
          new Promise((_, reject) => {
            flushDeadline = setTimeout(
              () => reject(new Error('Project replacement did not enter the artifact flush barrier')),
              5_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(flushDeadline);
      }

      assert.match(session.persistenceUnavailable, /temporarily unavailable/i);
      assert.strictEqual(
        server.suspendedProjectScopes.has(project.id),
        true,
        'the scope gate closes before already-admitted artifact writes are drained',
      );
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
        server.database.raw.prepare(
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
        fsSync.readFileSync(
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
      releaseAdmitted();
      await Promise.allSettled([append, replacement].filter(Boolean));
      if (originalFlush) server.chatStore.flush = originalFlush;
      await server.shutdown().catch(() => undefined);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('takes lifecycle authority from the admitted artifact inode, never a swapped pathname', async function () {
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
      await server.loadWorkspaceSessions(owner.id, workspaceRoot);
      server.claudeSessions.set(session.id, session);
      assert.strictEqual(await server.saveSessionsToDisk(), true);
      server.loadedWorkspaceScopes.add(key);

      const canonical = path.join(workspaceRoot, '.cc-web');
      const authoritative = path.join(workspaceRoot, '.cc-web-opened-original');
      await fs.rename(canonical, authoritative);
      await fs.mkdir(canonical);
      const replacementArtifact = path.join(canonical, 'replacement.txt');
      await fs.writeFile(replacementArtifact, 'safe-looking replacement must remain untouched');
      const replacementBefore = await fs.stat(replacementArtifact);

      await assert.rejects(
        () => server.beforeProjectWorkspaceReplacement(project),
        /changed|identity|authorised|binding/i,
      );

      assert.strictEqual(
        await fs.readFile(replacementArtifact, 'utf8'),
        'safe-looking replacement must remain untouched',
      );
      const replacementAfter = await fs.stat(replacementArtifact);
      assert.strictEqual(replacementAfter.ino, replacementBefore.ino);
      assert.strictEqual(replacementAfter.size, replacementBefore.size);
      assert.strictEqual(
        server.suspendedProjectScopes.has(project.id),
        true,
        'an admitted archive identity mismatch keeps the project scope fail-closed',
      );
      assert.strictEqual(server.loadedWorkspaceScopes.has(key), false);
      const environmentOwner = server.getEnvironmentOwner(owner.id);
      assert.ok(environmentOwner);
      assert.strictEqual(
        await server.projectPaths.hasStagedWorkspaceSessionStorage(project, environmentOwner),
        false,
        'a failed pre-suspension identity check does not mint authority for the replacement',
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
      const environmentOwner = server.getEnvironmentOwner(owner.id);
      assert.ok(environmentOwner);
      const canonical = path.join(workspaceRoot, '.cc-web');
      await fs.mkdir(canonical);
      await fs.writeFile(path.join(canonical, 'artifact.txt'), 'authoritative project history');
      const identity = await server.projectPaths.workspaceSessionStorageIdentity(project, environmentOwner);
      assert.ok(identity);
      await server.projectPaths.recordWorkspaceSessionStorageIntent(project, environmentOwner, identity);

      const authoritative = path.join(workspaceRoot, '.cc-web-authoritative-offline');
      await fs.rename(canonical, authoritative);
      await fs.mkdir(canonical);
      await fs.writeFile(path.join(canonical, 'replacement.txt'), 'replacement must stay dark');

      await server.restoreStagedProjectSessionArchives();

      assert.strictEqual(server.unrestoredProjectScopes.has(key), true);
      assert.match(server.workspacePersistenceErrors.get(key), /crash-staged|enable project environments/i);
      assert.strictEqual(server.loadedWorkspaceScopes.has(key), false);
      assert.strictEqual(
        await fs.readFile(path.join(canonical, 'replacement.txt'), 'utf8'),
        'replacement must stay dark',
      );
      assert.strictEqual(await fileExists(authoritative), true);
    } finally {
      await server.shutdown().catch(() => undefined);
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

  it('cold-loads shared SQLite metadata and leaves legacy artifact decoys untouched', async function () {
    this.timeout(60_000);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-cataloged-cold-load-'));
    const dataDir = path.join(root, 'data');
    const workspaceRoot = path.join(root, 'workspace');
    await Promise.all([fs.mkdir(dataDir), fs.mkdir(workspaceRoot)]);

    const sessionId = 'cataloged-workspace-session';
    let globalArtifactBytes = new Map();
    let database = null;
    let server = null;
    const migratorCalls = [];
    const originalMigrate = WorkspaceSessionArtifactMigrator.prototype.migrate;
    const originalConfirm = WorkspaceSessionArtifactMigrator.prototype.confirm;

    try {
      database = new AppDatabase({ dataDir });
      const owner = database.upsertGitHubUser({
        githubId: 'cataloged-cold-load-owner',
        githubLogin: 'cataloged-cold-load-owner',
        githubName: null,
        email: null,
      });
      globalArtifactBytes = new Map([
        [path.join(dataDir, String(owner.id), `${sessionId}.jsonl`), 'global chat decoy\n'],
        [path.join(dataDir, 'transcripts', String(owner.id), `${sessionId}.md`), 'global transcript decoy\n'],
        [path.join(dataDir, 'history', String(owner.id), `${sessionId}.log`), 'global history decoy\n'],
      ]);
      const ownerKey = createHash('sha256')
        .update(`cc-web-session-owner:v1:${owner.githubId}`)
        .digest('hex');
      const scope = { workspaceRoot, ownerKey };
      const globalStore = new SessionStore({ database, scopedGlobalStore: true });
      await globalStore.loadSessions();
      assert.strictEqual(await globalStore.saveSessions(new Map([
        [sessionId, sessionRecord(sessionId, owner.id, {
          name: 'Shared SQLite authority',
          workingDir: workspaceRoot,
          storageScope: scope,
          surface: 'chat',
        })],
      ])), true);
      const projectSessionDir = path.join(
        workspaceRoot, '.cc-web', 'sessions', ownerKey, sessionId,
      );
      await fs.mkdir(projectSessionDir, { recursive: true });
      await fs.writeFile(
        path.join(workspaceRoot, '.cc-web', '.gitignore'),
        '# Written by code-agents-webcli. Workspace session artefacts are local.\n*\n',
      );
      await fs.writeFile(path.join(projectSessionDir, 'transcript.md'), 'project transcript authority\n');
      for (const [file, bytes] of globalArtifactBytes) {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, bytes);
      }
      database.close();
      database = null;

      // Any automatic legacy orchestration is a regression. Shared app.sqlite
      // metadata and the already-local project artifact tree are authoritative.
      WorkspaceSessionArtifactMigrator.prototype.migrate = async function (ref) {
        migratorCalls.push(`migrate:${ref.id}`);
        throw new Error('automatic legacy artifact migration must not run');
      };
      WorkspaceSessionArtifactMigrator.prototype.confirm = async function (ref) {
        migratorCalls.push(`confirm:${ref.id}`);
        throw new Error('automatic legacy artifact confirmation must not run');
      };

      server = new ClaudeCodeWebServer({ dataDir, baseFolder: root, noAuth: true, port: 0 });
      await server.loadPersistedSessions();

      assert.deepStrictEqual(migratorCalls, []);
      const restored = server.claudeSessions.get(sessionId);
      assert.ok(restored, 'cold startup loads the shared metadata row');
      assert.strictEqual(restored.name, 'Shared SQLite authority');
      assert.deepStrictEqual(restored.storageScope, scope);
      assert.strictEqual(
        server.database.raw.prepare(`
          SELECT name FROM runtime_sessions WHERE owner_user_id = ? AND id = ?
        `).get(owner.id, sessionId).name,
        'Shared SQLite authority',
        'the shared global row remains authoritative',
      );
      assert.strictEqual(
        await fs.readFile(path.join(projectSessionDir, 'transcript.md'), 'utf8'),
        'project transcript authority\n',
      );
      assert.strictEqual(await fileExists(path.join(workspaceRoot, '.cc-web', 'session-state.sqlite')), false);
      for (const [file, bytes] of globalArtifactBytes) {
        assert.strictEqual(await fs.readFile(file, 'utf8'), bytes);
        assert.strictEqual(
          await fileExists(path.join(
            path.dirname(file),
            `.${path.basename(file)}.ccweb-session-migration.bak`,
          )),
          false,
          `cold discovery must not prepare a rollback copy for ${file}`,
        );
      }
    } finally {
      WorkspaceSessionArtifactMigrator.prototype.migrate = originalMigrate;
      WorkspaceSessionArtifactMigrator.prototype.confirm = originalConfirm;
      if (server) {
        server.saveSessionsToDisk = async () => true;
        await server.shutdown().catch(() => undefined);
      }
      try { database?.close(); } catch { /* Already closed. */ }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

});
