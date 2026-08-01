const assert = require('assert');
const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { createFolderRoutes } = require('../dist/server/routes/folders.js');

const USER = {
  id: 77,
  githubId: '77',
  githubLogin: 'folder-owner',
  githubName: null,
  avatarUrl: null,
  email: null,
};

function record(overrides = {}) {
  const now = new Date();
  return {
    id: 'session-1', ownerUserId: USER.id, name: 'Project session', created: now,
    lastActivity: now, active: false, agent: null, lastAgent: null, runtimeLabel: null,
    terminalOptions: null, stopRequested: false, workingDir: '/host/checkout',
    connections: new Set(), outputBuffer: [], termCols: 80, termRows: 24,
    sessionStartTime: null, sessionUsage: {}, maxBufferSize: 1000,
    projectId: 'project-1', projectWorkingDirKind: 'host',
    ...overrides,
  };
}

/**
 * Execute the server-owned Node helper scripts against an isolated fake
 * container root. Container `/tmp/x` maps below `containerRoot`, never to this
 * test process's real `/tmp/x`; that is the namespace boundary under test.
 */
function projectManager(containerRoot, hostCheckout) {
  let lease = 0;
  const ensured = [];
  const released = [];
  const unverifiedProcesses = [];
  let failClosed = false;
  const toHost = (containerPath) => {
    if (typeof containerPath !== 'string' || !containerPath.startsWith('/')) {
      throw new Error('expected an absolute container path');
    }
    return path.join(containerRoot, containerPath.slice(1));
  };
  const toContainer = (hostPath) => {
    const relative = path.relative(containerRoot, hostPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('fake helper escaped its container root');
    }
    return `/${relative.split(path.sep).join('/')}`.replace(/\/$/, '') || '/';
  };
  const real = (containerPath) => toContainer(fs.realpathSync(toHost(containerPath)));

  const manager = {
    ensured,
    released,
    unverifiedProcesses,
    setFailClosed(value) { failClosed = value; },
    getForUser: (userId, projectId) =>
      userId === USER.id && projectId === 'project-1' ? { id: projectId } : null,
    ensureForSession: async (userId, projectId) => {
      ensured.push([userId, projectId]);
      return {
        ok: true,
        environment: {
          kind: 'container', name: 'fake-project', homeDir: hostCheckout,
          containerHome: '/home/folder-owner', shells: [], mounts: [], nodePath: 'node',
          toContainerPath: (value) => {
            const relative = path.relative(hostCheckout, value);
            if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('outside checkout');
            return path.posix.join('/workspace/repo', relative.split(path.sep).join('/'));
          },
          toHostPath: (value) => value,
          wrap: (command, args, options = {}) => ({ command, args, env: options.env || {} }),
        },
        workingDir: hostCheckout,
        allowedWorkingDirs: [hostCheckout],
        containerAccess: {
          projectId,
          ownerUserId: userId,
          containerName: 'fake-project',
          containerIdentity: 'fake-project-id',
          root: '/',
          workspaceRoot: '/workspace',
          ownerHomeRoot: '/home/folder-owner',
        },
        leaseId: `folder-${++lease}`,
      };
    },
    releaseSessionLease: (userId, projectId, leaseId) => {
      released.push([userId, projectId, leaseId]);
      return true;
    },
    registerUnverifiedSessionProcess: (userId, projectId, leaseId, recovery) => {
      unverifiedProcesses.push({ userId, projectId, leaseId, recovery });
    },
    touchActivity: () => {},
    execInSessionContainer: async (_userId, _projectId, _leaseId, _cwd, command, args, signal) => {
      if (failClosed) {
        const error = new Error('remote helper stop was not verified');
        error.retainProjectLease = true;
        throw error;
      }
      assert.strictEqual(command, 'node');
      assert(signal instanceof AbortSignal);
      const script = args[1];
      const first = args[2];
      if (script.includes('fs.statSync(value).isDirectory()')) {
        const canonical = real(first);
        if (!fs.statSync(toHost(canonical)).isDirectory()) throw new Error('not a directory');
        return { stdout: canonical, stderr: '' };
      }
      if (script.includes("const type = stat.isFile() ? 'file'")) {
        const stat = fs.statSync(toHost(first));
        const type = stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other';
        return { stdout: JSON.stringify({ type, size: stat.size, mtimeMs: stat.mtimeMs }), stderr: '' };
      }
      if (script.includes('fs.readdirSync(root, { withFileTypes: true })')) {
        const limit = Number(args[3]);
        const showHidden = args[4] === '1';
        const all = fs.readdirSync(toHost(first), { withFileTypes: true })
          .filter((entry) => showHidden || !entry.name.startsWith('.'));
        const entries = all.slice(0, limit).map((entry) => ({
          name: entry.name,
          path: path.posix.join(first, entry.name),
          isDirectory: entry.isDirectory(),
          ...(entry.isFile() ? { size: fs.statSync(path.join(toHost(first), entry.name)).size } : {}),
        }));
        return { stdout: JSON.stringify({ entries, truncated: all.length > limit }), stderr: '' };
      }
      if (script.includes('fs.mkdirSync(target)')) {
        const parent = real(first);
        const target = path.posix.join(parent, args[3]);
        fs.mkdirSync(toHost(target));
        return { stdout: real(target), stderr: '' };
      }
      if (script.includes('fs.realpathSync(process.argv[1])')) {
        return { stdout: real(first), stderr: '' };
      }
      throw new Error('unexpected project helper script');
    },
    spawnSessionFileCommand: async () => { throw new Error('folder routes do not spawn file streams'); },
  };
  return manager;
}

async function listen(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    base: `http://127.0.0.1:${server.address().port}`,
  };
}

describe('project container folder routes', function () {
  let containerRoot;
  let hostCheckout;
  let hostCanary;
  let manager;
  let sessions;
  let server;
  let base;
  let selectedWrites;
  let saves;

  beforeEach(async function () {
    containerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-folder-container-'));
    hostCheckout = fs.mkdtempSync(path.join(os.tmpdir(), 'project-folder-checkout-'));
    fs.mkdirSync(path.join(containerRoot, 'workspace', 'repo'), { recursive: true });
    fs.mkdirSync(path.join(containerRoot, 'home', 'folder-owner'), { recursive: true });
    const nonce = `cc-web-project-folder-${process.pid}-${Date.now()}`;
    hostCanary = path.join(os.tmpdir(), nonce);
    fs.mkdirSync(hostCanary);
    fs.mkdirSync(path.join(containerRoot, 'tmp', nonce), { recursive: true });
    fs.mkdirSync(path.join(hostCanary, 'host-only'));
    fs.mkdirSync(path.join(containerRoot, 'tmp', nonce, 'container-only'));

    manager = projectManager(containerRoot, hostCheckout);
    sessions = new Map([['session-1', record({ workingDir: hostCheckout })]]);
    selectedWrites = [];
    saves = 0;
    const app = express();
    app.use(express.json());
    app.use((_req, res, next) => {
      res.locals.authContext = { user: USER, authSessionId: 'auth' };
      next();
    });
    app.use(createFolderRoutes({
      baseFolder: hostCheckout,
      claudeSessions: sessions,
      validatePath: (value) => ({ valid: true, path: value }),
      getUserBaseFolder: () => hostCheckout,
      isPathWithinBase: () => true,
      getSelectedWorkingDir: () => hostCheckout,
      setSelectedWorkingDir: (_userId, value) => selectedWrites.push(value),
      saveSessionsToDisk: async () => { saves += 1; },
      projectsManager: manager,
    }));
    ({ server, base } = await listen(app));
  });

  afterEach(async function () {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(containerRoot, { recursive: true, force: true });
    fs.rmSync(hostCheckout, { recursive: true, force: true });
    fs.rmSync(hostCanary, { recursive: true, force: true });
  });

  it('browses the container namespace and reports each path lifetime', async function () {
    const opened = await fetch(`${base}/api/folders?projectId=project-1&sessionId=session-1`);
    assert.strictEqual(opened.status, 200);
    const home = await opened.json();
    assert.strictEqual(home.currentPath, '/workspace/repo');
    assert.strictEqual(home.workingDirKind, 'container');
    assert.strictEqual(home.lifetime, 'workspace');

    const nonce = path.basename(hostCanary);
    const disposable = await fetch(
      `${base}/api/folders?projectId=project-1&sessionId=session-1&path=${encodeURIComponent(`/tmp/${nonce}`)}`,
    );
    assert.strictEqual(disposable.status, 200);
    const body = await disposable.json();
    assert.strictEqual(body.lifetime, 'disposable');
    assert.deepStrictEqual(body.folders.map((entry) => entry.name), ['container-only']);
    assert(!body.folders.some((entry) => entry.name === 'host-only'));

    const ownerHome = await fetch(
      `${base}/api/folders?projectId=project-1&path=${encodeURIComponent('/home/folder-owner')}`,
    );
    assert.strictEqual((await ownerHome.json()).lifetime, 'owner_home');
    assert.strictEqual(manager.ensured.length, 3);
    assert.strictEqual(manager.released.length, 3);
  });

  it('durably repairs a missing disposable cwd before browsing its fallback', async function () {
    const session = sessions.get('session-1');
    session.workingDir = '/tmp/no-longer-present';
    session.projectWorkingDirKind = 'container';

    const response = await fetch(`${base}/api/folders?projectId=project-1&sessionId=session-1`);
    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.strictEqual(body.currentPath, '/workspace/repo');
    assert.strictEqual(session.workingDir, fs.realpathSync(hostCheckout));
    assert.strictEqual(session.projectWorkingDirKind, 'host');
    assert.strictEqual(saves, 1);
    assert.strictEqual(manager.released.length, 1);
  });

  it('creates and selects a container folder atomically without poisoning host preference', async function () {
    const nonce = path.basename(hostCanary);
    const parentPath = `/tmp/${nonce}`;
    const created = await fetch(`${base}/api/create-folder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'project-1', parentPath, folderName: 'picked' }),
    });
    assert.strictEqual(created.status, 200);
    assert(fs.statSync(path.join(containerRoot, 'tmp', nonce, 'picked')).isDirectory());
    assert.strictEqual(fs.existsSync(path.join(hostCanary, 'picked')), false);

    const selected = await fetch(`${base}/api/set-working-dir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: 'project-1',
        projectWorkingDirKind: 'container',
        sessionId: 'session-1',
        path: `${parentPath}/picked`,
      }),
    });
    assert.strictEqual(selected.status, 200);
    assert.strictEqual(sessions.get('session-1').workingDir, `${parentPath}/picked`);
    assert.strictEqual(sessions.get('session-1').projectWorkingDirKind, 'container');
    assert.strictEqual(saves, 1);
    assert.deepStrictEqual(selectedWrites, []);
    assert.strictEqual(manager.released.length, 2);
  });

  it('never downgrades malformed project ids or a project session to legacy host mode', async function () {
    const malformedQuery = await fetch(`${base}/api/folders?projectId=`);
    assert.strictEqual(malformedQuery.status, 400);

    for (const [url, body] of [
      ['/api/create-folder', { projectId: {}, parentPath: hostCheckout, folderName: 'bad' }],
      ['/api/set-working-dir', { projectId: [], sessionId: 'session-1', path: hostCheckout }],
      ['/api/folders/select', { projectId: '   ', path: hostCheckout }],
    ]) {
      const response = await fetch(`${base}${url}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.strictEqual(response.status, 400, url);
    }

    sessions.set('foreign-project-session', record({
      id: 'foreign-project-session',
      ownerUserId: USER.id + 1,
    }));
    const foreign = await fetch(`${base}/api/set-working-dir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'foreign-project-session', path: hostCheckout }),
    });
    assert.strictEqual(foreign.status, 404, 'ownership is checked before project context');

    const stale = await fetch(`${base}/api/set-working-dir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-1', path: hostCheckout }),
    });
    assert.strictEqual(stale.status, 409);
    assert.strictEqual(sessions.get('session-1').workingDir, hostCheckout);
    assert.strictEqual(sessions.get('session-1').projectWorkingDirKind, 'host');
    assert.deepStrictEqual(selectedWrites, []);
    assert.strictEqual(manager.ensured.length, 0);
  });

  it('retains the folder operation lease when remote helper stop is unverified', async function () {
    manager.setFailClosed(true);
    const response = await fetch(`${base}/api/folders?projectId=project-1`);
    assert.strictEqual(response.status, 503);
    assert.strictEqual(manager.ensured.length, 1);
    assert.strictEqual(manager.released.length, 0);
    assert.strictEqual(manager.unverifiedProcesses.length, 1);
  });
});
