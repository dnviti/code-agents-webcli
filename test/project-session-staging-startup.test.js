const assert = require('assert');
const fs = require('fs').promises;
const http = require('http');
const os = require('os');
const path = require('path');

const { ClaudeCodeWebServer } = require('../dist/server/index.js');

function sessionRecord(id, ownerUserId, workspaceRoot, projectId, storageScope) {
  const created = new Date('2026-08-05T10:00:00.000Z');
  return {
    id,
    ownerUserId,
    name: 'Crash-staged project chat',
    created,
    lastActivity: created,
    active: false,
    agent: null,
    lastAgent: 'claude',
    runtimeLabel: null,
    terminalOptions: null,
    stopRequested: false,
    workingDir: workspaceRoot,
    projectId,
    projectWorkingDirKind: 'host',
    storageScope,
    surface: 'chat',
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
  };
}

describe('project session archive startup recovery', function () {
  this.timeout(30_000);

  it('quiesces runtimes before restoring a crash-staged archive and cold-loads its chat', async function () {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-project-staged-startup-'));
    const dataDir = path.join(root, 'data');
    const projectsRoot = path.join(root, 'projects');
    await Promise.all([fs.mkdir(dataDir), fs.mkdir(projectsRoot)]);

    let first;
    let second;
    let listener;
    const originalPath = process.env.PATH;
    try {
      if (process.platform === 'win32') {
        const gitOpenSsl = 'C:\\Program Files\\Git\\mingw64\\bin';
        if (await fs.access(path.join(gitOpenSsl, 'openssl.exe')).then(() => true).catch(() => false)) {
          process.env.PATH = `${gitOpenSsl}${path.delimiter}${originalPath || ''}`;
        }
      }
      first = new ClaudeCodeWebServer({
        dataDir,
        baseFolder: root,
        noAuth: true,
        port: 0,
        githubClientId: 'staged-startup-client',
        githubClientSecret: 'staged-startup-secret',
        allowedGitHubIds: 'staged-startup-owner',
      });
      const owner = first.database.upsertGitHubUser({
        githubId: 'staged-startup-owner',
        githubLogin: 'staged-startup-owner',
        githubName: null,
        email: null,
      });
      const project = first.projectStore.createProject({
        ownerUserId: owner.id,
        name: 'Staged startup project',
        executionKind: 'host',
      });
      const workspaceRoot = path.join(projectsRoot, project.id);
      first.projectPaths.worktreePath = () => workspaceRoot;
      await fs.mkdir(workspaceRoot);
      const scope = first.sessionStorageScope(owner.id, workspaceRoot);
      const session = sessionRecord(
        'staged-project-chat',
        owner.id,
        workspaceRoot,
        project.id,
        scope,
      );
      first.claudeSessions.set(session.id, session);
      assert.strictEqual(await first.saveSessionsToDisk(), true);
      assert.strictEqual(
        await fs.access(path.join(workspaceRoot, '.cc-web', 'session-state.sqlite'))
          .then(() => true).catch(() => false),
        false,
        'project archives contain artifacts, never a SQLite database',
      );
      const fixtureEvents = (await fs.readFile(
        path.join(__dirname, 'fixtures', 'chat', 'store-events.jsonl'),
        'utf8',
      )).trim().split('\n').map((line) => JSON.parse(line));
      await first.chatStore.append(session, fixtureEvents);
      assert.ok((await first.chatStore.stat(session)).cursor > 0);

      await first.shutdown();
      first = null;

      const canonicalArchive = path.join(workspaceRoot, '.cc-web');
      const stagedArchive = path.join(
        path.dirname(workspaceRoot),
        `.${project.id}.ccweb-session-storage-retained`,
      );
      await fs.rename(canonicalArchive, stagedArchive);

      second = new ClaudeCodeWebServer({
        dataDir,
        baseFolder: root,
        noAuth: true,
        port: 0,
        githubClientId: 'staged-startup-client',
        githubClientSecret: 'staged-startup-secret',
        allowedGitHubIds: 'staged-startup-owner',
      });
      second.projectPaths.worktreePath = () => workspaceRoot;
      // Exercise the enabled-project startup ordering without contacting a real
      // engine. The reconciliation seam represents a still-live runtime and
      // must observe that plaintext history is not exposed yet.
      Object.defineProperty(second, 'containerizedEnvironmentsEnabled', { value: true });
      const order = [];
      second.projects.reconcileOnBoot = async () => {
        order.push('quiesce');
        assert.strictEqual(await fs.access(stagedArchive).then(() => true), true);
        assert.strictEqual(
          await fs.access(canonicalArchive).then(() => true).catch(() => false),
          false,
          'the archive stays outside the bind-mounted root until runtimes are quiescent',
        );
      };
      const originalLoad = second.loadPersistedSessions.bind(second);
      second.loadPersistedSessions = async () => {
        order.push('load');
        assert.strictEqual(
          await fs.access(canonicalArchive).then(() => true).catch(() => false),
          true,
          'the exact artifact archive is restored before shared session metadata is loaded',
        );
        return originalLoad();
      };

      await second.start();
      assert.deepStrictEqual(order, ['quiesce', 'load']);
      assert.strictEqual(
        await fs.access(stagedArchive).then(() => true).catch(() => false),
        false,
      );
      const restored = second.claudeSessions.get(session.id);
      assert.ok(restored, 'the staged session is visible after cold startup');
      assert.strictEqual(restored.projectId, project.id);
      assert.ok((await second.chatStore.stat(restored)).cursor > 0);

      const authSessionId = 'staged-project-http-session';
      second.database.createAuthSession(
        authSessionId,
        owner.id,
        new Date(Date.now() + 60_000),
      );
      listener = http.createServer(second.app);
      await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
      const response = await fetch(
        `http://127.0.0.1:${listener.address().port}/api/sessions/list`, {
        headers: { Cookie: `code_agents_webcli_session=${authSessionId}` },
        },
      );
      assert.strictEqual(response.status, 200);
      assert.ok((await response.json()).sessions.some((entry) => entry.id === session.id));
    } finally {
      if (listener) {
        listener.closeAllConnections?.();
        await new Promise((resolve) => listener.close(() => resolve()));
      }
      await second?.shutdown().catch(() => undefined);
      await first?.shutdown().catch(() => undefined);
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
