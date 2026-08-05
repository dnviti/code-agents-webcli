const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { createWorkspaceRoutes } = require('../dist/server/routes/workspace.js');
const { createChatAttachmentRoutes } = require('../dist/server/routes/chat-attachments.js');
const { AttachmentStore } = require('../dist/server/services/attachment-store.js');
const { ProjectAwareAttachmentStore } = require('../dist/server/services/project-attachment-store.js');
const { MessageProcessor } = require('../dist/server/websocket/messages.js');

const USER = {
  id: 88,
  githubId: '88',
  githubLogin: 'workspace-owner',
  githubName: null,
  avatarUrl: null,
  email: null,
};

function sessionRecord(workingDir, overrides = {}) {
  const now = new Date();
  return {
    id: 'session-1', ownerUserId: USER.id, name: 'Container workspace', created: now,
    lastActivity: now, active: false, agent: null, lastAgent: null, runtimeLabel: null,
    terminalOptions: null, stopRequested: false, workingDir, connections: new Set(),
    outputBuffer: [], termCols: 80, termRows: 24, sessionStartTime: null,
    sessionUsage: {}, maxBufferSize: 1000, projectId: 'project-1',
    projectWorkingDirKind: 'container',
    ...overrides,
  };
}

function fakeProjectManager(containerRoot, hostCheckout) {
  let leaseNumber = 0;
  const ensured = [];
  const released = [];
  const execs = [];
  const children = [];
  const closeTimes = [];
  const processControlStops = [];
  const unverifiedProcesses = [];
  const workspaceOperations = [];
  let slowRead = false;
  let processControlFactory = async () => {};
  let omitProcessControl = false;

  const toHost = (containerPath) => {
    if (typeof containerPath !== 'string' || !containerPath.startsWith('/')) {
      throw new Error('expected an absolute container path');
    }
    return path.join(containerRoot, containerPath.slice(1));
  };
  const toContainer = (hostPath) => {
    const relative = path.relative(containerRoot, hostPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('container escape');
    return relative ? `/${relative.split(path.sep).join('/')}` : '/';
  };
  const real = (value) => toContainer(fs.realpathSync(toHost(value)));
  const failure = (message, code = 2, stdout = '') => {
    const error = new Error(message);
    error.code = code;
    error.stdout = stdout;
    error.stderr = message;
    throw error;
  };

  const manager = {
    ensured,
    released,
    execs,
    children,
    closeTimes,
    processControlStops,
    unverifiedProcesses,
    workspaceOperations,
    setSlowRead(value) { slowRead = value; },
    setProcessControl(factory) { processControlFactory = factory; },
    setOmitProcessControl(value) { omitProcessControl = value; },
    getForUser: (userId, projectId) =>
      userId === USER.id && projectId === 'project-1' ? { id: projectId } : null,
    projectWorkspaceRoot: (userId, projectId) =>
      userId === USER.id && projectId === 'project-1' ? hostCheckout : null,
    withProjectWorkspace: async (userId, projectId, operation) => {
      if (userId !== USER.id || projectId !== 'project-1') throw new Error('project is unavailable');
      workspaceOperations.push({ phase: 'start', userId, projectId });
      try {
        return await operation(hostCheckout);
      } finally {
        workspaceOperations.push({ phase: 'end', userId, projectId });
      }
    },
    ensureForSession: async (userId, projectId) => {
      const leaseId = `workspace-${++leaseNumber}`;
      ensured.push({ userId, projectId, leaseId });
      return {
        ok: true,
        environment: {
          kind: 'container', name: 'fake-project', homeDir: hostCheckout,
          containerHome: '/home/workspace-owner', shells: [], mounts: [], nodePath: 'node',
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
          ownerHomeRoot: '/home/workspace-owner',
        },
        leaseId,
      };
    },
    releaseSessionLease: (userId, projectId, leaseId) => {
      released.push({ userId, projectId, leaseId, at: Date.now() });
      return true;
    },
    registerUnverifiedSessionProcess: (userId, projectId, leaseId, recovery) => {
      unverifiedProcesses.push({ userId, projectId, leaseId, recovery });
    },
    touchActivity: () => {},
    execInSessionContainer: async (userId, projectId, leaseId, cwd, command, args, signal) => {
      execs.push({ userId, projectId, leaseId, cwd, command, args });
      assert(signal instanceof AbortSignal);

      if (command === 'env') {
        const index = args.findIndex((arg) => !/^[A-Z_][A-Z0-9_]*=/.test(arg));
        const executable = args[index];
        const argv = args.slice(index + 1);
        if (executable === 'gh') {
          if (argv[0] === '--version') return { stdout: 'gh version 9.9.9\n', stderr: '' };
          if (argv[0] === 'auth') return { stdout: '', stderr: '' };
          if (argv[0] === 'repo') {
            return {
              stdout: JSON.stringify({
                nameWithOwner: 'owner/repo',
                url: 'https://github.com/owner/repo',
                defaultBranchRef: { name: 'main' },
              }),
              stderr: '',
            };
          }
          if ((argv[0] === 'pr' || argv[0] === 'issue') && argv[1] === 'list') {
            return { stdout: '[]', stderr: '' };
          }
          failure(`unsupported fake gh call: ${argv.join(' ')}`);
        }
        const result = spawnSync(executable, argv, {
          cwd: toHost(cwd),
          encoding: 'utf8',
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
        });
        if (result.status !== 0) failure(String(result.stderr || 'command failed'), result.status, String(result.stdout || ''));
        return { stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
      }

      assert.strictEqual(command, 'node');
      const script = args[1];
      const first = args[2];
      try {
        if (script.includes('fs.statSync(value).isDirectory()')) {
          const canonical = real(first);
          if (!fs.statSync(toHost(canonical)).isDirectory()) failure('not a directory');
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
        if (script.includes("value.toString('base64')")) {
          const bytes = fs.readFileSync(toHost(first));
          if (bytes.length > Number(args[3])) failure('too large', 3);
          return { stdout: bytes.toString('base64'), stderr: '' };
        }
        if (script.includes('fs.readSync(handle, buffer')) {
          const bytes = fs.readFileSync(toHost(first)).subarray(0, Number(args[3]));
          return { stdout: bytes.toString('base64'), stderr: '' };
        }
        if (script.includes("const queue = ['.']")) {
          const root = toHost(first);
          const maxFiles = Number(args[3]);
          const maxDirs = Number(args[4]);
          const skip = new Set(JSON.parse(args[5]));
          const found = [];
          const queue = ['.'];
          let visited = 0;
          let truncated = false;
          while (queue.length) {
            if (visited++ >= maxDirs) { truncated = true; break; }
            const relative = queue.shift();
            for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
              if (entry.isSymbolicLink()) continue;
              const child = relative === '.' ? entry.name : `${relative}/${entry.name}`;
              if (entry.isDirectory()) { if (!skip.has(entry.name)) queue.push(child); continue; }
              if (!entry.isFile()) continue;
              if (found.length >= maxFiles) { truncated = true; queue.length = 0; break; }
              found.push(child);
            }
          }
          return { stdout: JSON.stringify({ paths: found, truncated, source: 'walk' }), stderr: '' };
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
      } catch (error) {
        failure(error.message, error.code === 'EEXIST' ? 17 : 2);
      }
      failure('unexpected project helper script');
    },
    spawnSessionFileCommand: async (userId, projectId, leaseId, input) => {
      const hostPath = toHost(input.path);
      let child;
      if (input.operation === 'read' && slowRead) {
        child = spawn(process.execPath, ['-e', [
          "process.stdout.write('x');",
          "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),200));",
          'setInterval(()=>{},1000);',
        ].join('')], { stdio: ['pipe', 'pipe', 'pipe'] });
      } else if (input.operation === 'read') {
        child = spawn(process.execPath, ['-e', [
          "const fs=require('fs');",
          'const b=fs.readFileSync(process.argv[1]);',
          'const o=Number(process.argv[2]||0);',
          "const raw=process.argv[3];",
          "const out=raw===''?b.subarray(o):b.subarray(o,o+Number(raw));",
          'process.stdout.write(out);',
        ].join(''), hostPath, String(input.offset || 0), input.length === undefined ? '' : String(input.length)], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } else {
        child = spawn(process.execPath, ['-e', [
          "const fs=require('fs');const chunks=[];",
          "process.stdin.on('data',c=>chunks.push(c));",
          "process.stdin.on('end',()=>{try{fs.writeFileSync(process.argv[1],Buffer.concat(chunks),{flag:process.argv[2]});}",
          "catch(e){process.stderr.write(String(e.message));process.exit(e.code==='EEXIST'?17:2);}});",
        ].join(''), hostPath, input.exclusive ? 'wx' : input.append ? 'a' : 'w'], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      }
      children.push({ userId, projectId, leaseId, input, child });
      child.once('close', () => closeTimes.push(Date.now()));
      if (!omitProcessControl) {
        child.processControl = {
          stop: async () => {
            processControlStops.push({ leaseId, input, at: Date.now() });
            await processControlFactory({ leaseId, input, child });
          },
        };
      }
      return child;
    },
  };
  return manager;
}

async function startServer(sessions, manager) {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.authContext = { user: USER, authSessionId: 'auth' };
    next();
  });
  manager.attachmentStore = new ProjectAwareAttachmentStore(
    new AttachmentStore(),
    manager,
    async () => { manager.saves += 1; },
  );
  app.use(createChatAttachmentRoutes({
    claudeSessions: sessions,
    attachmentStore: manager.attachmentStore,
    validatePath: () => { throw new Error('project container path reached host validation'); },
  }));
  app.use(createWorkspaceRoutes({
    claudeSessions: sessions,
    saveSessionsToDisk: async () => { manager.saves += 1; },
    validatePath: () => { throw new Error('project container path reached host validation'); },
    ensureEnvironment: async () => { throw new Error('legacy environment used'); },
    projectsManager: manager,
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

describe('arbitrary project container workspaces', function () {
  let containerRoot;
  let hostCheckout;
  let hostTwin;
  let containerPath;
  let manager;
  let sessions;
  let server;
  let base;

  beforeEach(async function () {
    containerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-workspace-container-'));
    hostCheckout = fs.mkdtempSync(path.join(os.tmpdir(), 'project-workspace-checkout-'));
    fs.mkdirSync(path.join(containerRoot, 'workspace', 'repo'), { recursive: true });
    fs.mkdirSync(path.join(containerRoot, 'home', 'workspace-owner'), { recursive: true });
    const nonce = `cc-web-project-workspace-${process.pid}-${Date.now()}`;
    containerPath = `/tmp/${nonce}`;
    hostTwin = path.join(os.tmpdir(), nonce);
    fs.mkdirSync(hostTwin);
    fs.mkdirSync(path.join(containerRoot, 'tmp', nonce), { recursive: true });
    fs.writeFileSync(path.join(hostTwin, 'note.txt'), 'HOST CANARY');
    fs.writeFileSync(path.join(containerRoot, 'tmp', nonce, 'note.txt'), 'container note');
    fs.mkdirSync(path.join(hostTwin, 'host-only'));
    fs.mkdirSync(path.join(containerRoot, 'tmp', nonce, 'container-only'));

    spawnSync('git', ['init', '-q'], { cwd: path.join(containerRoot, 'tmp', nonce) });
    spawnSync('git', ['add', 'note.txt'], { cwd: path.join(containerRoot, 'tmp', nonce) });
    manager = fakeProjectManager(containerRoot, hostCheckout);
    manager.saves = 0;
    sessions = new Map([['session-1', sessionRecord(containerPath)]]);
    ({ server, base } = await startServer(sessions, manager));
  });

  afterEach(async function () {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(containerRoot, { recursive: true, force: true });
    fs.rmSync(hostCheckout, { recursive: true, force: true });
    fs.rmSync(hostTwin, { recursive: true, force: true });
  });

  it('routes list/read/write/upload/raw/find/git/gh through the exact project backend', async function () {
    const listed = await (await fetch(`${base}/api/workspace/session-1/files`)).json();
    assert(listed.entries.some((entry) => entry.name === 'container-only'));
    assert(!listed.entries.some((entry) => entry.name === 'host-only'));
    assert.strictEqual(listed.projectWorkingDirKind, 'container');
    assert.strictEqual(listed.lifetime, 'disposable');

    const openedResponse = await fetch(`${base}/api/workspace/session-1/file?path=note.txt`);
    assert.strictEqual(openedResponse.status, 200);
    const opened = await openedResponse.json();
    assert.strictEqual(opened.content, 'container note');

    const saved = await fetch(`${base}/api/workspace/session-1/file`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'note.txt', content: 'container edited', mtimeMs: opened.mtimeMs }),
    });
    assert.strictEqual(saved.status, 200);
    assert.strictEqual(fs.readFileSync(path.join(hostTwin, 'note.txt'), 'utf8'), 'HOST CANARY');
    assert.strictEqual(
      fs.readFileSync(path.join(containerRoot, containerPath.slice(1), 'note.txt'), 'utf8'),
      'container edited',
    );

    const uploaded = await fetch(
      `${base}/api/workspace/session-1/upload?dir=.&name=inside.bin`,
      { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from('inside') },
    );
    assert.strictEqual(uploaded.status, 200);
    assert.strictEqual(fs.existsSync(path.join(hostTwin, 'inside.bin')), false);
    assert.strictEqual(
      fs.readFileSync(path.join(containerRoot, containerPath.slice(1), 'inside.bin'), 'utf8'),
      'inside',
    );

    const raw = await fetch(`${base}/api/workspace/session-1/raw?path=note.txt`);
    assert.strictEqual(raw.status, 200);
    assert.strictEqual(await raw.text(), 'container edited');

    const found = await (await fetch(`${base}/api/workspace/session-1/find?q=note&refresh=1`)).json();
    assert(found.matches.includes('note.txt'));
    const git = await (await fetch(`${base}/api/workspace/session-1/git`)).json();
    assert.strictEqual(git.repo, true);
    const github = await (await fetch(`${base}/api/workspace/session-1/github?refresh=1`)).json();
    assert.strictEqual(github.available, true);
    assert.strictEqual(github.repo.nameWithOwner, 'owner/repo');

    assert.strictEqual(fs.readFileSync(path.join(hostTwin, 'note.txt'), 'utf8'), 'HOST CANARY');
    assert(manager.execs.some((entry) => entry.command === 'env' && entry.args.includes('git')));
    assert(manager.execs.some((entry) => entry.command === 'env' && entry.args.includes('gh')));
    assert(manager.execs.every((entry) => entry.userId === USER.id && entry.projectId === 'project-1'));
    assert.strictEqual(manager.ensured.length, manager.released.length);
  });

  it('uploads, serves and resolves chat attachments inside the project container', async function () {
    sessions.get('session-1').storageScope = {
      workspaceRoot: hostCheckout,
      ownerKey: 'stable-project-owner',
    };
    const uploaded = await fetch(
      `${base}/api/sessions/session-1/chat-attachments?name=notes.txt`,
      { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: Buffer.from('container attachment') },
    );
    assert.strictEqual(uploaded.status, 200);
    const attachment = await uploaded.json();
    assert.strictEqual(attachment.name, 'notes.txt');
    assert.strictEqual(
      attachment.path.startsWith('/workspace/repo/.cc-web/attachments/stable-project-owner/session-1/'),
      true,
    );
    assert.strictEqual(fs.existsSync(path.join(hostTwin, '.cc-web', 'attachments')), false,
      'an equal-looking host path must remain untouched');
    assert.strictEqual(
      fs.readFileSync(path.join(
        hostCheckout,
        '.cc-web',
        'attachments',
        'stable-project-owner',
        'session-1',
        path.basename(attachment.path),
      ), 'utf8'),
      'container attachment',
    );

    const downloaded = await fetch(`${base}${attachment.url}`);
    assert.strictEqual(downloaded.status, 200);
    assert.strictEqual(await downloaded.text(), 'container attachment');

    const resolved = await manager.attachmentStore.resolveForTurn(
      sessions.get('session-1'),
      { ...attachment, path: '/tmp/forged-host-path', name: 'forged.txt' },
    );
    assert.strictEqual(resolved.path, attachment.path);
    assert.strictEqual(resolved.name, 'notes.txt');
    assert.strictEqual(manager.ensured.length, manager.released.length);
  });

  it('clones project attachment bytes in the canonical host checkout without starting a runtime', async function () {
    const source = sessions.get('session-1');
    source.storageScope = {
      workspaceRoot: hostCheckout,
      ownerKey: 'stable-project-owner',
    };
    const target = sessionRecord(containerPath, {
      id: 'session-branch',
      storageScope: source.storageScope,
    });
    const bytes = Buffer.from('project branch attachment');
    const stored = await manager.attachmentStore.save(source, {
      filename: 'branch.txt', declaredMime: 'text/plain', bytes,
    });
    const sourceUrl = `/api/sessions/${source.id}/chat-attachments/${stored.storedName}`;
    const admissionsBefore = manager.ensured.length;
    const workspaceOperationsBefore = manager.workspaceOperations.length;

    await assert.rejects(
      () => manager.attachmentStore.cloneForBranch(source, source, {
        url: sourceUrl,
        name: stored.name,
        mime: stored.mime,
        size: stored.bytes,
      }),
      (error) => error && error.code === 'INVALID_TARGET',
    );
    assert.strictEqual(
      manager.ensured.length,
      admissionsBefore,
      'same-session rejection happens before project admission or filesystem access',
    );
    await assert.rejects(
      () => manager.attachmentStore.cloneForBranch(source, {
        ...target,
        projectId: 'project-other',
      }, {
        url: sourceUrl,
        name: stored.name,
        mime: stored.mime,
        size: stored.bytes,
      }),
      (error) => error && error.code === 'PROJECT_MISMATCH',
    );
    assert.strictEqual(
      manager.workspaceOperations.length,
      workspaceOperationsBefore,
      'cross-project targets are rejected before lifecycle admission',
    );

    const cloned = await manager.attachmentStore.cloneForBranch(source, target, {
      url: sourceUrl,
      name: 'forged.txt',
      mime: 'text/plain',
      size: 1,
      path: '/tmp/forged',
    });

    assert.strictEqual(cloned.name, 'branch.txt');
    assert.ok(cloned.url.startsWith('/api/sessions/session-branch/chat-attachments/'));
    assert.ok(cloned.path.startsWith(path.join(
      hostCheckout,
      '.cc-web',
      'attachments',
      'stable-project-owner',
      'session-branch',
    )));
    assert.deepStrictEqual(
      fs.readFileSync(path.join(
        hostCheckout,
        '.cc-web',
        'attachments',
        'stable-project-owner',
        'session-branch',
        path.basename(cloned.path),
      )),
      bytes,
    );
    assert.deepStrictEqual(fs.readFileSync(path.join(
      hostCheckout,
      '.cc-web',
      'attachments',
      'stable-project-owner',
      source.id,
      path.basename(stored.absolutePath),
    )), bytes, 'source bytes remain owned by source');
    assert.strictEqual(
      manager.ensured.length,
      admissionsBefore,
      'durable branch copying does not start or admit the project runtime',
    );
    assert.deepStrictEqual(
      manager.workspaceOperations.slice(workspaceOperationsBefore).map((entry) => entry.phase),
      ['start', 'end'],
      'one no-start lifecycle gate spans the complete bounded copy',
    );

    const resolved = await manager.attachmentStore.resolveForTurn(target, cloned);
    assert.ok(
      resolved.path.startsWith('/workspace/repo/.cc-web/attachments/stable-project-owner/session-branch/'),
      'runtime resolution maps the durable host URL into the container only at launch',
    );
    assert.strictEqual(manager.ensured.length, admissionsBefore + 1);
    assert.strictEqual(manager.ensured.length, manager.released.length);
  });

  it('rejects a project branch copy when the opened source changes size during the read', async function () {
    const source = sessions.get('session-1');
    source.storageScope = {
      workspaceRoot: hostCheckout,
      ownerKey: 'stable-project-owner',
    };
    const target = sessionRecord(containerPath, {
      id: 'session-size-race',
      storageScope: source.storageScope,
    });
    let sourceHostPath = '';
    let changed = false;
    const host = new AttachmentStore({
      testHooks: {
        afterBranchCloneChunk(pass) {
          if (pass === 'copy' && !changed) {
            changed = true;
            fs.truncateSync(sourceHostPath, bytes.length - 17);
          }
        },
      },
    });
    const projectStore = new ProjectAwareAttachmentStore(host, manager, async () => {});
    const bytes = Buffer.alloc(128 * 1024, 0x61);
    const stored = await projectStore.save(source, {
      filename: 'mutable.bin', declaredMime: 'application/octet-stream', bytes,
    });
    sourceHostPath = path.join(
      hostCheckout,
      '.cc-web',
      'attachments',
      source.storageScope.ownerKey,
      source.id,
      stored.storedName,
    );

    await assert.rejects(
      () => projectStore.cloneForBranch(source, target, {
        url: `/api/sessions/${source.id}/chat-attachments/${stored.storedName}`,
        name: stored.name,
        mime: stored.mime,
        size: stored.bytes,
      }),
      (error) => error && error.code === 'SOURCE_ATTACHMENT_CHANGED',
    );
    assert.strictEqual(changed, true);
    assert.strictEqual(
      fs.existsSync(path.join(
        hostCheckout,
        '.cc-web',
        'attachments',
        source.storageScope.ownerKey,
        target.id,
      )),
      false,
      'a changed source is rejected before target quota or bytes are created',
    );
    assert.strictEqual(manager.ensured.length, manager.released.length);
  });

  it('drains an already-admitted project upload and rejects later uploads at the lifecycle gate', async function () {
    const current = sessions.get('session-1');
    current.storageScope = {
      workspaceRoot: hostCheckout,
      ownerKey: 'stable-project-owner',
    };
    let uploadOpened;
    const atUpload = new Promise((resolve) => { uploadOpened = resolve; });
    let finishUpload;
    const uploadMayFinish = new Promise((resolve) => { finishUpload = resolve; });
    const host = new AttachmentStore({
      testHooks: {
        afterDirectoryOpened: async (operation) => {
          if (operation !== 'save') return;
          uploadOpened();
          await uploadMayFinish;
        },
      },
    });
    const projectStore = new ProjectAwareAttachmentStore(host, manager, async () => {});

    const admitted = projectStore.save(current, {
      filename: 'admitted.txt',
      declaredMime: 'text/plain',
      bytes: Buffer.from('durable before lifecycle suspension'),
    });
    await atUpload;

    // This is the synchronous admission gate installed by project lifecycle
    // before it asks the store to drain earlier mutations.
    current.persistenceUnavailable = 'Project workspace session storage is temporarily unavailable';
    let drained = false;
    const flushing = projectStore.flush(current).then(() => { drained = true; });
    await Promise.resolve();
    assert.strictEqual(drained, false, 'flush must include a save admitted before the gate');
    await assert.rejects(
      () => projectStore.save(current, {
        filename: 'too-late.txt',
        declaredMime: 'text/plain',
        bytes: Buffer.from('must not be written'),
      }),
      (error) => error && error.code === 'SESSION_PERSISTENCE_UNAVAILABLE',
    );

    finishUpload();
    const stored = await admitted;
    await flushing;
    assert.strictEqual(drained, true);
    assert.strictEqual(
      fs.readFileSync(path.join(
        hostCheckout,
        '.cc-web',
        'attachments',
        current.storageScope.ownerKey,
        current.id,
        stored.storedName,
      ), 'utf8'),
      'durable before lifecycle suspension',
    );
    assert.strictEqual(manager.ensured.length, manager.released.length);
  });

  it('does not deadlock lifecycle flush on an upload still queued for project admission', async function () {
    const current = sessions.get('session-1');
    current.storageScope = {
      workspaceRoot: hostCheckout,
      ownerKey: 'stable-project-owner',
    };
    const originalEnsure = manager.ensureForSession.bind(manager);
    let signalEnsureQueued;
    const ensureQueued = new Promise((resolve) => { signalEnsureQueued = resolve; });
    let releaseEnsure;
    const ensureMayProceed = new Promise((resolve) => { releaseEnsure = resolve; });
    manager.ensureForSession = async (...args) => {
      signalEnsureQueued();
      await ensureMayProceed;
      return originalEnsure(...args);
    };

    let hostSaveCalled = false;
    let hostFlushes = 0;
    const host = {
      save: async () => {
        hostSaveCalled = true;
        throw new Error('a post-gate upload reached durable storage');
      },
      flush: async () => { hostFlushes += 1; },
    };
    const projectStore = new ProjectAwareAttachmentStore(host, manager, async () => {
      throw new Error('a post-gate upload attempted cwd write-through');
    });
    const saving = projectStore.save(current, {
      filename: 'queued.txt',
      declaredMime: 'text/plain',
      bytes: Buffer.from('still waiting for the lifecycle lock'),
    });
    await ensureQueued;

    // Faithfully model beforeWorkspaceReplacement while it owns the same
    // exclusive lock that ensureForSession is queued behind.
    current.persistenceUnavailable = 'Project workspace session storage is temporarily unavailable';
    const flushOutcome = await Promise.race([
      projectStore.flush(current).then(() => 'flushed'),
      new Promise((resolve) => setImmediate(() => resolve('blocked'))),
    ]);
    assert.strictEqual(
      flushOutcome,
      'flushed',
      'lifecycle must not wait for a request which cannot acquire its lock',
    );
    assert.strictEqual(hostFlushes, 1);

    releaseEnsure();
    await assert.rejects(
      () => saving,
      (error) => error && error.code === 'SESSION_PERSISTENCE_UNAVAILABLE',
    );
    assert.strictEqual(hostSaveCalled, false);
    assert.strictEqual(manager.ensured.length, manager.released.length);
  });

  it('deletes project attachments from an already-exclusive project teardown without re-entering its gate', async function () {
    const current = sessions.get('session-1');
    current.storageScope = {
      workspaceRoot: hostCheckout,
      ownerKey: 'stable-project-owner',
    };
    const sibling = sessionRecord(containerPath, {
      id: 'session-sibling',
      storageScope: current.storageScope,
    });
    const target = await manager.attachmentStore.save(current, {
      filename: 'target.txt', declaredMime: 'text/plain', bytes: Buffer.from('delete me'),
    });
    const canary = await manager.attachmentStore.save(sibling, {
      filename: 'canary.txt', declaredMime: 'text/plain', bytes: Buffer.from('keep me'),
    });
    const admissionsBeforeDelete = manager.ensured.length;
    const targetHostDir = path.join(
      hostCheckout, '.cc-web', 'attachments', 'stable-project-owner', 'session-1',
    );
    assert.strictEqual(fs.existsSync(path.join(targetHostDir, path.basename(target.absolutePath))), true);

    await manager.attachmentStore.deleteSessionAttachments(current, {
      projectLifecycleExclusive: true,
    });

    assert.strictEqual(fs.existsSync(targetHostDir), false);
    assert.strictEqual(fs.readFileSync(path.join(
      hostCheckout,
      '.cc-web',
      'attachments',
      'stable-project-owner',
      'session-sibling',
      path.basename(canary.absolutePath),
    ), 'utf8'), 'keep me');
    assert.strictEqual(
      manager.ensured.length,
      admissionsBeforeDelete,
      'definitive cleanup must not start or lease a project runtime',
    );
    assert.deepStrictEqual(manager.workspaceOperations, [], 'project deletion does not deadlock by reacquiring its gate');
    assert.strictEqual(manager.ensured.length, manager.released.length);
  });

  it('refuses project cleanup when a persisted storage scope is not the manager-derived root', async function () {
    const staleRoot = path.join(containerRoot, 'stale-project-root');
    fs.mkdirSync(staleRoot);
    const current = sessions.get('session-1');
    current.storageScope = {
      workspaceRoot: staleRoot,
      ownerKey: 'stable-project-owner',
    };
    const staleRef = {
      ...current,
      workingDir: staleRoot,
      projectId: undefined,
      projectWorkingDirKind: undefined,
    };
    const stale = await new AttachmentStore().save(staleRef, {
      filename: 'canary.txt', declaredMime: 'text/plain', bytes: Buffer.from('keep stale canary'),
    });
    const admissionsBeforeDelete = manager.ensured.length;

    await assert.rejects(
      () => manager.attachmentStore.deleteSessionAttachments(current),
      (error) => error && error.code === 'UNSAFE_ATTACHMENT_DIR',
    );

    assert.strictEqual(fs.readFileSync(stale.absolutePath, 'utf8'), 'keep stale canary');
    assert.strictEqual(
      manager.ensured.length,
      admissionsBeforeDelete,
      'rejected cleanup does not start or admit a project runtime',
    );
    assert.deepStrictEqual(
      manager.workspaceOperations.map((entry) => entry.phase),
      ['start', 'end'],
      'the stale scope was checked inside the ordinary lifecycle gate',
    );
  });

  it('keeps ordinary cleanup on the stable project root while a checkout is replaced', async function () {
    const current = sessions.get('session-1');
    current.storageScope = {
      workspaceRoot: hostCheckout,
      ownerKey: 'stable-project-owner',
    };
    const checkout = path.join(hostCheckout, 'repo-checkout');
    fs.mkdirSync(checkout);
    fs.writeFileSync(path.join(checkout, 'old.txt'), 'old checkout');

    let deleteOpened;
    const atDelete = new Promise((resolve) => { deleteOpened = resolve; });
    let finishDelete;
    const deleteMayFinish = new Promise((resolve) => { finishDelete = resolve; });
    const host = new AttachmentStore({
      testHooks: {
        afterDirectoryOpened: async (operation) => {
          if (operation !== 'delete') return;
          deleteOpened();
          await deleteMayFinish;
        },
      },
    });
    const projectStore = new ProjectAwareAttachmentStore(host, manager, async () => {});
    const stored = await projectStore.save(current, {
      filename: 'retire.txt', declaredMime: 'text/plain', bytes: Buffer.from('retire me'),
    });
    const targetHostDir = path.join(
      hostCheckout,
      '.cc-web',
      'attachments',
      current.storageScope.ownerKey,
      current.id,
    );

    const deleting = projectStore.deleteSessionAttachments(current);
    await atDelete;
    const previousCheckout = path.join(hostCheckout, 'repo-checkout.previous');
    fs.renameSync(checkout, previousCheckout);
    fs.mkdirSync(checkout);
    fs.writeFileSync(path.join(checkout, 'new.txt'), 'new checkout');
    finishDelete();
    await deleting;

    assert.strictEqual(fs.existsSync(path.join(targetHostDir, stored.storedName)), false);
    assert.strictEqual(fs.readFileSync(path.join(checkout, 'new.txt'), 'utf8'), 'new checkout');
    assert.deepStrictEqual(
      manager.workspaceOperations.slice(-2).map((entry) => entry.phase),
      ['start', 'end'],
      'ordinary cleanup remains inside the project lifecycle gate',
    );
    assert.strictEqual(manager.ensured.length, manager.released.length);
  });

  it('falls a missing disposable cwd back to the host checkout and changes its namespace', async function () {
    sessions.get('session-1').workingDir = '/tmp/no-longer-present';
    fs.writeFileSync(path.join(hostCheckout, 'fallback.txt'), 'checkout');
    const response = await fetch(`${base}/api/workspace/session-1/files`);
    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.strictEqual(body.root, fs.realpathSync(hostCheckout));
    assert(body.entries.some((entry) => entry.name === 'fallback.txt'));
    assert.strictEqual(sessions.get('session-1').projectWorkingDirKind, 'host');
    assert.strictEqual(manager.saves, 1, 'the repaired cwd namespace is durable before the response');
    assert.strictEqual(manager.ensured.length, 1);
    assert.strictEqual(manager.released.length, 1);
  });

  it('serves ACP reads and writes from the leased container, including container /tmp', async function () {
    const prepared = await manager.ensureForSession(USER.id, 'project-1');
    const processor = new MessageProcessor({ projectsManager: manager });
    const access = processor.projectChatFileAccess(sessions.get('session-1'), prepared);

    assert.strictEqual(await access.readFile('note.txt'), 'container note');
    assert.strictEqual(await access.readFile(`${containerPath}/note.txt`), 'container note');
    await access.writeFile('notes/todo.md', 'inside only');
    assert.strictEqual(
      fs.readFileSync(path.join(containerRoot, containerPath.slice(1), 'notes', 'todo.md'), 'utf8'),
      'inside only',
    );
    assert.strictEqual(fs.existsSync(path.join(hostTwin, 'notes', 'todo.md')), false);
    assert.strictEqual(fs.readFileSync(path.join(hostTwin, 'note.txt'), 'utf8'), 'HOST CANARY');

    await assert.rejects(access.readFile('../../etc/passwd'), /outside the session directory/);
    fs.mkdirSync(path.join(containerRoot, 'etc'), { recursive: true });
    fs.writeFileSync(path.join(containerRoot, 'etc', 'secret'), 'container secret');
    fs.symlinkSync(
      path.relative(path.join(containerRoot, containerPath.slice(1)), path.join(containerRoot, 'etc')),
      path.join(containerRoot, containerPath.slice(1), 'escape'),
    );
    await assert.rejects(access.readFile('escape/secret'), /outside the session directory/);
    await assert.rejects(access.writeFile('escape/pwned', 'no'), /outside the session directory/);

    fs.writeFileSync(path.join(containerRoot, 'workspace', 'repo', 'mounted.txt'), 'mounted view');
    fs.writeFileSync(path.join(hostCheckout, 'mounted.txt'), 'host mount source');
    const hostKind = sessionRecord(hostCheckout, { projectWorkingDirKind: 'host' });
    const mountedAccess = processor.projectChatFileAccess(hostKind, prepared);
    assert.strictEqual(
      await mountedAccess.readFile('/workspace/repo/mounted.txt'),
      'mounted view',
      'ACP uses the runtime-visible mount rather than treating it as a host path',
    );
  });

  it('holds the lease until a disconnected stream child has actually closed', async function () {
    manager.setSlowRead(true);
    const closed = new Promise((resolve, reject) => {
      const request = http.get(`${base}/api/workspace/session-1/raw?path=note.txt`, (response) => {
        response.once('data', () => response.destroy());
        response.once('error', () => {});
        resolve();
      });
      request.once('error', reject);
    });
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual(manager.released.length, 0, 'lease released while child was still alive');

    const deadline = Date.now() + 2000;
    while (manager.released.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.strictEqual(manager.closeTimes.length, 1);
    assert.strictEqual(manager.released.length, 1);
    assert(manager.released[0].at >= manager.closeTimes[0]);
  });

  it('holds a disconnected stream lease until remote process death is verified', async function () {
    manager.setSlowRead(true);
    let proveStopped;
    const stopped = new Promise((resolve) => { proveStopped = resolve; });
    manager.setProcessControl(() => stopped);

    await new Promise((resolve, reject) => {
      const request = http.get(`${base}/api/workspace/session-1/raw?path=note.txt`, (response) => {
        response.once('data', () => response.destroy());
        response.once('error', () => {});
        resolve();
      });
      request.once('error', reject);
    });

    const localDeadline = Date.now() + 2000;
    while (manager.closeTimes.length === 0 && Date.now() < localDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.strictEqual(manager.closeTimes.length, 1, 'local exec client did not close');
    assert.strictEqual(manager.processControlStops.length, 1);
    assert.strictEqual(manager.released.length, 0, 'local client close released the lease before remote proof');

    proveStopped();
    const releaseDeadline = Date.now() + 2000;
    while (manager.released.length === 0 && Date.now() < releaseDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.strictEqual(manager.released.length, 1);
  });

  it('transfers PUT and upload helpers and requests manager-gated lease release', async function () {
    manager.setProcessControl(async () => {
      throw new Error('remote process group still exists');
    });
    const note = path.join(containerRoot, containerPath.slice(1), 'note.txt');
    const mtimeMs = fs.statSync(note).mtimeMs;

    const saved = await fetch(`${base}/api/workspace/session-1/file`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'note.txt', content: 'maybe written', mtimeMs }),
    });
    assert.strictEqual(saved.status, 503);
    assert.strictEqual(manager.released.length, 1, 'PUT must request release after recovery ownership transfers');
    assert.strictEqual(manager.unverifiedProcesses.length, 1);
    assert.strictEqual(typeof manager.unverifiedProcesses[0].recovery.stop, 'function');

    const uploaded = await fetch(
      `${base}/api/workspace/session-1/upload?dir=.&name=unverified.bin`,
      { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from('bytes') },
    );
    assert.strictEqual(uploaded.status, 503);
    assert.strictEqual(manager.released.length, 2, 'upload must request release after recovery ownership transfers');
    assert.strictEqual(manager.ensured.length, 2);
    assert.strictEqual(manager.unverifiedProcesses.length, 2);
  });

  it('transfers a retryable identity-bound stop proof to the lease manager', async function () {
    let attempts = 0;
    manager.setProcessControl(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient control failure');
    });
    const note = path.join(containerRoot, containerPath.slice(1), 'note.txt');
    const response = await fetch(`${base}/api/workspace/session-1/file`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: 'note.txt',
        content: 'retryable write',
        mtimeMs: fs.statSync(note).mtimeMs,
      }),
    });
    assert.strictEqual(response.status, 503);
    assert.strictEqual(manager.released.length, 1);
    const [{ recovery }] = manager.unverifiedProcesses;
    assert.strictEqual(typeof recovery.stop, 'function');
    await recovery.stop();
    assert.strictEqual(attempts, 2);
    assert.strictEqual(manager.released.length, 1, 'the route requests release while the manager gates completion');
  });

  it('fails closed when a project helper has no remote process control', async function () {
    manager.setOmitProcessControl(true);
    const note = path.join(containerRoot, containerPath.slice(1), 'note.txt');
    const response = await fetch(`${base}/api/workspace/session-1/file`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: 'note.txt',
        content: 'unverified write',
        mtimeMs: fs.statSync(note).mtimeMs,
      }),
    });
    assert.strictEqual(response.status, 503);
    assert.strictEqual(manager.released.length, 1);
    assert.strictEqual(manager.unverifiedProcesses.length, 1);
    assert.strictEqual(manager.unverifiedProcesses[0].recovery.stop, undefined);
  });

  it('retains the lease when an older manager cannot register recovery ownership', async function () {
    manager.registerUnverifiedSessionProcess = undefined;
    manager.setProcessControl(async () => {
      throw new Error('remote proof unavailable');
    });
    const note = path.join(containerRoot, containerPath.slice(1), 'note.txt');
    const response = await fetch(`${base}/api/workspace/session-1/file`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: 'note.txt',
        content: 'fail closed',
        mtimeMs: fs.statSync(note).mtimeMs,
      }),
    });
    assert.strictEqual(response.status, 503);
    assert.strictEqual(manager.released.length, 0);
    assert.strictEqual(manager.unverifiedProcesses.length, 0);
  });
});
