const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { ClaudeCodeWebServer } = require('../dist/server/index.js');

const ENCRYPTION_KEY = Buffer.alloc(32, 17).toString('base64');
const COOKIE = 'code_agents_webcli_session';
const FEATURE_ENV = 'CODE_AGENTS_WEBCLI_DEPLOY_TARGETS_ENABLED';

function createServer(options, featureEnabled) {
  const previous = process.env[FEATURE_ENV];
  if (featureEnabled) process.env[FEATURE_ENV] = 'true';
  else delete process.env[FEATURE_ENV];
  try {
    return new ClaudeCodeWebServer(options);
  } finally {
    if (previous === undefined) delete process.env[FEATURE_ENV];
    else process.env[FEATURE_ENV] = previous;
  }
}

async function makeHarness({ featureEnabled = true, containers = false } = {}) {
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'project-server-composition-'));
  const appServer = createServer({
    dataDir,
    githubClientId: 'composition-client',
    githubClientSecret: 'composition-secret',
    allowedGitHubIds: 'composition-user',
    encryptionKey: ENCRYPTION_KEY,
    containers,
  }, featureEnabled);
  const owner = appServer.database.upsertGitHubUser({
    githubId: 'composition-user',
    githubLogin: 'composition-owner',
    githubName: 'Composition Owner',
    email: 'owner@example.test',
  });
  const authSessionId = 'composition-auth-session';
  appServer.database.createAuthSession(
    authSessionId,
    owner.id,
    new Date(Date.now() + 60_000),
  );

  const listener = http.createServer(appServer.app);
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${listener.address().port}`;

  const request = async (method, requestPath, body) => {
    const response = await fetch(`${baseUrl}${requestPath}`, {
      method,
      headers: {
        Cookie: `${COOKIE}=${authSessionId}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : null,
    };
  };

  const close = async () => {
    listener.closeAllConnections?.();
    await new Promise((resolve) => listener.close(resolve));
    await appServer.shutdown();
    // The constructor installs a beforeExit save. Keep its eventual callback
    // harmless after this test has closed and removed the database.
    appServer.saveSessionsToDisk = async () => {};
    await fs.promises.rm(dataDir, { recursive: true, force: true });
  };

  return { appServer, owner, request, close };
}

describe('project server composition', function () {
  this.timeout(15_000);

  it('reports and clears live workspace write failures through persistence diagnostics', async function () {
    const harness = await makeHarness();
    const { appServer, owner, request } = harness;
    const workspaceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'workspace-write-diagnostic-'));
    let boundStore;
    let originalSave;
    try {
      const validatePath = appServer.validatePath.bind(appServer);
      appServer.validatePath = (target, userId) => (
        path.resolve(target) === workspaceRoot
          ? { valid: true, path: workspaceRoot }
          : validatePath(target, userId)
      );
      await appServer.loadWorkspaceSessions(owner.id, workspaceRoot);
      const session = appServer.createSessionRecord({
        id: 'write-diagnostic',
        ownerUserId: owner.id,
        workingDir: workspaceRoot,
        storageRoot: workspaceRoot,
      });
      appServer.claudeSessions.set(session.id, session);
      assert.strictEqual(await appServer.saveSessionsToDisk(), true);

      boundStore = appServer.sessionStore.openWorkspace(session.storageScope);
      originalSave = boundStore.saveSessions.bind(boundStore);
      boundStore.saveSessions = async () => false;
      session.customName = 'cannot persist';
      assert.strictEqual(await appServer.saveSessionsToDisk(), false);

      let diagnostic = await request('GET', '/api/sessions/persistence');
      assert.strictEqual(diagnostic.status, 200);
      assert.strictEqual(diagnostic.body.migrationComplete, false);
      assert.ok(diagnostic.body.unavailable.some((entry) => (
        entry.root === workspaceRoot && /workspace save failed|rollback failed/.test(entry.error)
      )));
      assert.strictEqual(
        diagnostic.body.workspaces.find((entry) => entry.root === workspaceRoot).available,
        false,
      );

      boundStore.saveSessions = originalSave;
      assert.strictEqual(await appServer.saveSessionsToDisk(), true);
      diagnostic = await request('GET', '/api/sessions/persistence');
      assert.strictEqual(diagnostic.body.migrationComplete, true);
      assert.strictEqual(
        diagnostic.body.unavailable.some((entry) => entry.root === workspaceRoot),
        false,
      );
      assert.strictEqual(
        diagnostic.body.workspaces.find((entry) => entry.root === workspaceRoot).available,
        true,
      );
    } finally {
      if (boundStore && originalSave) boundStore.saveSessions = originalSave;
      await harness.close();
      await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('keeps containerized environments and deploy-target configuration off by default', async function () {
    const harness = await makeHarness({ featureEnabled: false, containers: true });
    const { appServer, request } = harness;
    try {
      assert.strictEqual(appServer.containerizedEnvironmentsEnabled, false);
      assert.strictEqual(appServer.environments.enabled, false, 'legacy flags cannot bypass the feature gate');

      const config = await request('GET', '/api/config');
      assert.strictEqual(config.status, 200);
      assert.strictEqual(config.body.containerizedEnvironmentsEnabled, false);
      assert.ok(
        Array.isArray(config.body.supportedShells) && config.body.supportedShells.length > 0,
        'the client must receive shell choices for the server operating system',
      );

      assert.strictEqual((await request('GET', '/api/admin/deploy-targets')).status, 404);
      assert.strictEqual((await request('GET', '/api/admin/deploy-settings')).status, 404);
      assert.strictEqual(
        (await request('POST', '/api/admin/deploy-targets', { name: 'hidden', engine: 'docker' })).status,
        404,
      );

      const projects = await request('GET', '/api/projects');
      assert.strictEqual(projects.status, 200);
      assert.strictEqual(projects.body.availability.defaultExecutionKind, 'host');
    } finally {
      await harness.close();
    }
  });

  it('mounts project/host/admin APIs and protects durable target references', async function () {
    const harness = await makeHarness();
    const { appServer, owner, request } = harness;
    try {
      const projects = await request('GET', '/api/projects');
      assert.strictEqual(projects.status, 200);
      assert.deepStrictEqual(projects.body.projects, []);
      assert.strictEqual(typeof projects.body.availability.available, 'boolean');

      const savedHost = await request('POST', '/api/connected-hosts', {
        host: 'github.com',
        token: 'composition-token',
      });
      assert.strictEqual(savedHost.status, 200);
      assert.strictEqual(savedHost.body.host.host, 'github.com');
      assert.ok(!JSON.stringify(savedHost.body).includes('composition-token'));

      const hosts = await request('GET', '/api/connected-hosts');
      assert.strictEqual(hosts.status, 200);
      assert.deepStrictEqual(hosts.body.hosts.map((host) => host.host), ['github.com']);
      assert.ok(!JSON.stringify(hosts.body).includes('composition-token'));

      const defaults = await request('GET', '/api/admin/deploy-settings');
      assert.strictEqual(defaults.status, 200);
      assert.ok(defaults.body.runLimitPerUser > 0);

      const updated = await request('PUT', '/api/admin/deploy-settings', {
        runLimitPerUser: 2,
        idleStopMinutes: 5,
        idleReclaimMinutes: 10,
      });
      assert.deepStrictEqual(updated, {
        status: 200,
        body: {
          runLimitPerUser: 2,
          idleStopMinutes: 5,
          idleReclaimMinutes: 10,
          usageWarnUserBytes: null,
          usageWarnAdminBytes: null,
        },
      });
      const persisted = await request('GET', '/api/admin/deploy-settings');
      assert.deepStrictEqual(persisted.body, updated.body);

      const createdTarget = await request('POST', '/api/admin/deploy-targets', {
        name: 'Composition target',
        engine: 'docker',
      });
      assert.strictEqual(createdTarget.status, 201);
      const targetId = createdTarget.body.target.id;

      // No engine process is relevant to this referential-integrity check.
      appServer.environments.reachableEngines = () => new Map();
      const retained = appServer.projectStore.createProject({
        ownerUserId: owner.id,
        name: 'Stopped project',
        targetId,
      });

      const listed = await request('GET', '/api/projects');
      assert.strictEqual(listed.status, 200);
      assert.strictEqual(listed.body.projects[0].id, retained.id);
      assert.strictEqual(listed.body.projects[0].targetName, 'Composition target');

      const connectionEdit = await request('PUT', `/api/admin/deploy-targets/${targetId}`, {
        hostSecret: { host: 'tcp://docker.example.test:2375' },
      });
      assert.strictEqual(connectionEdit.status, 409);
      assert.strictEqual(connectionEdit.body.error, 'target_in_use');
      assert.deepStrictEqual(connectionEdit.body.projects, [retained.id]);

      const deletion = await request('DELETE', `/api/admin/deploy-targets/${targetId}`);
      assert.strictEqual(deletion.status, 409);
      assert.strictEqual(deletion.body.error, 'target_in_use');
      assert.deepStrictEqual(deletion.body.projects, [retained.id]);

      // Admission is closed durably by ProjectManager.shutdown(), and the
      // mounted route translates that state into a retryable service response.
      await appServer.projects.shutdown();
      const duringShutdown = await request('POST', '/api/projects', { name: 'Too late' });
      assert.strictEqual(duringShutdown.status, 503);
      assert.strictEqual(duringShutdown.body.error, 'shutting_down');
    } finally {
      await harness.close();
    }
  });

  it('protects active project roots, owned descendants, joins, and chat watches', async function () {
    const harness = await makeHarness();
    const { appServer, owner } = harness;
    try {
      const project = appServer.projectStore.createProject({
        ownerUserId: owner.id,
        name: 'Project one',
      });
      await fs.promises.mkdir(appServer.projectPaths.worktreePath(project, owner), {
        recursive: true,
        mode: 0o700,
      });
      const root = appServer.createSessionRecord({
        id: 'project-root', ownerUserId: owner.id, workingDir: '/workspace', projectId: project.id,
      });
      assert.strictEqual(
        root.storageScope.workspaceRoot,
        path.resolve(appServer.projectPaths.worktreePath(project, owner)),
        'a container-only cwd still stores session state at the canonical host project root',
      );
      appServer.claudeSessions.set(root.id, root);
      const child = appServer.createSessionRecord({
        id: 'project-child', ownerUserId: owner.id, workingDir: '/workspace', ownerSessionId: root.id,
      });
      appServer.claudeSessions.set(child.id, child);
      const grandchild = appServer.createSessionRecord({
        id: 'project-grandchild', ownerUserId: owner.id, workingDir: '/workspace', ownerSessionId: child.id,
      });
      appServer.claudeSessions.set(grandchild.id, grandchild);

      assert.strictEqual(appServer.hasLiveProjectWork(project.id), false, 'dormant records do not pin a project');
      appServer.messageProcessor.runtimeStarts.add(root.id);
      assert.strictEqual(appServer.hasLiveProjectWork(project.id), true, 'pre-lease launch admission is protected');
      appServer.messageProcessor.runtimeStarts.delete(root.id);
      grandchild.active = true;
      assert.strictEqual(appServer.hasLiveProjectWork(project.id), true, 'descendant runtime is protected');
      grandchild.active = false;

      child.connections.add('attached-socket');
      assert.strictEqual(appServer.hasLiveProjectWork(project.id), true, 'descendant attachment is protected');
      child.connections.clear();

      const socket = {
        id: 'socket-1',
        ws: { readyState: 0 },
        userId: owner.id,
        githubLogin: owner.githubLogin,
        claudeSessionId: grandchild.id,
        chatSessionIds: new Set(),
        created: new Date(),
      };
      appServer.webSocketConnections.set(socket.id, socket);
      assert.strictEqual(appServer.hasLiveProjectWork(project.id), true, 'primary join is protected');

      socket.claudeSessionId = null;
      socket.chatSessionIds.add(root.id);
      assert.strictEqual(appServer.hasLiveProjectWork(project.id), true, 'background chat watch is protected');
      socket.chatSessionIds.clear();
      assert.strictEqual(appServer.hasLiveProjectWork(project.id), false);

      const touches = [];
      appServer.projects.touchActivity = (projectId) => { touches.push(projectId); };
      appServer.chatManager.deps.broadcast(root.id, { type: 'assistant_delta' });
      assert.deepStrictEqual(
        touches,
        [],
        'conversation output must not persist activity metadata in the global project catalog',
      );

      const author = appServer.projects.deps.authorFor(owner.id);
      assert.deepStrictEqual(author, { name: 'Composition Owner', email: 'owner@example.test' });

      appServer.database.upsertGitHubUser({
        githubId: owner.githubId,
        githubLogin: 'changed\r\nlogin',
        githubName: 'Unsafe\nName',
        email: 'not an\r\nemail',
      });
      const sanitized = appServer.projects.deps.authorFor(owner.id);
      assert.strictEqual(sanitized.name, 'Unsafe Name');
      assert.strictEqual(
        sanitized.email,
        'compositionuser+changed-login@users.noreply.github.com',
      );
      assert.ok(!/[\r\n\u0000]/u.test(`${sanitized.name}${sanitized.email}`));
    } finally {
      await harness.close();
    }
  });

  it('does not close SQLite before the final in-flight project lease releases', async function () {
    const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'project-lease-drain-'));
    const appServer = createServer({
      dataDir,
      githubClientId: 'composition-client',
      githubClientSecret: 'composition-secret',
      allowedGitHubIds: 'composition-user',
      encryptionKey: ENCRYPTION_KEY,
    }, true);
    const events = [];
    try {
      const owner = appServer.database.upsertGitHubUser({
        githubId: 'composition-user', githubLogin: 'composition-owner',
      });
      const project = appServer.projectStore.createProject({
        ownerUserId: owner.id,
        name: 'Request in flight',
      });
      appServer.projectStore.setContainer(project.id, { name: 'composition-project' });
      appServer.projectStore.setState(project.id, 'running');
      appServer.projects.projects.ensure = async () => ({
        environment: appServer.environments.host(),
        workingDir: dataDir,
        allowedWorkingDirs: [dataDir],
        containerAccess: {
          projectId: project.id,
          ownerUserId: owner.id,
          containerName: 'composition-project',
          root: '/',
          persistentRoots: ['/workspace'],
        },
        containerName: 'composition-project',
        created: false,
      });
      const admission = await appServer.projects.ensureForSession(owner.id, project.id);
      assert.strictEqual(admission.ok, true);

      const closeDatabase = appServer.database.close.bind(appServer.database);
      appServer.database.close = () => {
        events.push('database');
        closeDatabase();
      };
      const shutdown = appServer.shutdown();

      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.deepStrictEqual(events, [], 'SQLite remains open while the request owns its lease');
      appServer.projects.releaseSessionLease(owner.id, project.id, admission.leaseId);
      events.push('lease-release');
      await shutdown;

      assert.deepStrictEqual(events, ['lease-release', 'database']);
    } finally {
      appServer.saveSessionsToDisk = async () => {};
      if (!appServer.isShuttingDown) await appServer.shutdown();
      await fs.promises.rm(dataDir, { recursive: true, force: true });
    }
  });

  it('stops runtime work before draining projects, environments, and SQLite', async function () {
    const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'project-shutdown-order-'));
    const appServer = new ClaudeCodeWebServer({
      dataDir,
      baseFolder: dataDir,
      githubClientId: 'composition-client',
      githubClientSecret: 'composition-secret',
      allowedGitHubIds: 'composition-user',
      encryptionKey: ENCRYPTION_KEY,
    });
    const events = [];
    try {
      const owner = appServer.database.upsertGitHubUser({
        githubId: 'composition-user', githubLogin: 'composition-owner',
      });
      const session = appServer.createSessionRecord({
        id: 'active-runtime', ownerUserId: owner.id, workingDir: dataDir,
      });
      session.active = true;
      session.agent = 'terminal';
      appServer.claudeSessions.set(session.id, session);

      appServer.saveSessionsToDisk = async () => {};
      appServer.messageProcessor.drainAllRecorders = async () => {};
      appServer.messageProcessor.drainPendingRuntimeStarts = async () => { events.push('pending-start-drain'); };
      appServer.messageProcessor.stopRuntime = async () => { events.push('runtime'); };
      appServer.projects.stopSweep = () => { events.push('project-stop-sweep'); };
      appServer.projects.shutdown = async () => { events.push('project-shutdown'); };
      Object.defineProperty(appServer.environments, 'enabled', {
        configurable: true,
        get: () => true,
      });
      appServer.environments.stopAll = async () => { events.push('environments'); };
      const closeDatabase = appServer.database.close.bind(appServer.database);
      appServer.database.close = () => {
        events.push('database');
        closeDatabase();
      };

      await appServer.shutdown();

      const position = (event) => events.indexOf(event);
      assert.ok(position('project-stop-sweep') >= 0);
      assert.ok(position('pending-start-drain') > position('project-stop-sweep'));
      assert.ok(position('runtime') > position('pending-start-drain'));
      assert.ok(position('project-shutdown') > position('runtime'));
      assert.ok(position('environments') > position('project-shutdown'));
      assert.ok(position('database') > position('environments'));
    } finally {
      appServer.saveSessionsToDisk = async () => {};
      await fs.promises.rm(dataDir, { recursive: true, force: true });
    }
  });

  it('surfaces a failed final session flush after closing shutdown resources', async function () {
    const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'project-shutdown-save-failure-'));
    const appServer = new ClaudeCodeWebServer({
      dataDir,
      baseFolder: dataDir,
      githubClientId: 'composition-client',
      githubClientSecret: 'composition-secret',
      allowedGitHubIds: 'composition-user',
      encryptionKey: ENCRYPTION_KEY,
    });
    let databaseClosed = false;
    try {
      appServer.saveSessionsToDisk = async () => false;
      const closeDatabase = appServer.database.close.bind(appServer.database);
      appServer.database.close = () => {
        databaseClosed = true;
        closeDatabase();
      };

      await assert.rejects(
        () => appServer.shutdown(),
        /Workspace session state could not be flushed during shutdown/,
      );
      assert.strictEqual(databaseClosed, true, 'shutdown still releases SQLite before reporting the flush failure');
    } finally {
      await fs.promises.rm(dataDir, { recursive: true, force: true });
    }
  });

  it('retries retained storage finalizers without replaying runtime teardown', async function () {
    const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'project-shutdown-close-retry-'));
    const appServer = new ClaudeCodeWebServer({
      dataDir,
      baseFolder: dataDir,
      githubClientId: 'composition-client',
      githubClientSecret: 'composition-secret',
      allowedGitHubIds: 'composition-user',
      encryptionKey: ENCRYPTION_KEY,
    });
    let projectShutdowns = 0;
    let workspaceCloses = 0;
    const closeWorkspaces = appServer.sessionStore.closeWorkspaces.bind(appServer.sessionStore);
    try {
      appServer.saveSessionsToDisk = async () => {};
      appServer.messageProcessor.drainAllRecorders = async () => {};
      appServer.messageProcessor.drainPendingRuntimeStarts = async () => {};
      appServer.projects.shutdown = async () => { projectShutdowns += 1; };
      appServer.sessionStore.closeWorkspaces = () => {
        workspaceCloses += 1;
        if (workspaceCloses === 1) throw new Error('injected transient workspace close');
        closeWorkspaces();
      };

      await assert.rejects(() => appServer.shutdown(), /injected transient workspace close/);
      await assert.doesNotReject(() => appServer.shutdown());
      assert.strictEqual(projectShutdowns, 1, 'runtime/project teardown must not be replayed');
      assert.strictEqual(workspaceCloses, 2, 'retained workspace finalizer must be retried');
    } finally {
      appServer.sessionStore.closeWorkspaces = closeWorkspaces;
      await fs.promises.rm(dataDir, { recursive: true, force: true });
    }
  });
});
