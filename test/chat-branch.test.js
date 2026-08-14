const assert = require('assert');
const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { ChatStore } = require('../dist/server/chat/store.js');
const { ChatSession } = require('../dist/server/chat/session.js');
const {
  createSessionRoutes,
  retireProjectSessions,
} = require('../dist/server/routes/sessions.js');
const { MessageProcessor } = require('../dist/server/websocket/messages.js');
const {
  AttachmentStore,
  storedAttachmentNameFromUrl,
} = require('../dist/server/services/attachment-store.js');
const { ProjectAwareAttachmentStore } = require('../dist/server/services/project-attachment-store.js');
const { SessionStore } = require('../dist/server/services/session-store.js');
const { SessionTeardownRegistry } = require('../dist/server/services/session-teardown.js');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

// Issue #34 asked for copy-a-turn and branch-from-a-turn together. Copy
// shipped; branch was announced in the changelog and never built — the hooks
// existed, nothing passed them, and no runtime here can fork a session at a
// point anyway. So a branch is two things this app does for itself, and both
// are what these tests are about: the new conversation really holds the turns
// up to the branch point, and the agent really receives that history on its
// first turn. Every one of these fails before the change, because before it
// there is no route to call.

const USER = { id: 7, githubLogin: 'dev' };

/**
 * A message processor over these records, with the chat process faked.
 *
 * Only used to launch a branch the route has really created: the approval mode
 * is decided at the launch, so a test that stops at the record proves nothing
 * about what the user gets.
 */
function launcherFor(sessions, sessionId, preference) {
  const chatManager = {
    calls: { start: [] },
    has: () => false,
    async start(record, options) {
      chatManager.calls.start.push({ record, options });
      return {
        runtimeKind: options.runtime,
        currentCapabilities: {},
        bypassing: Boolean(options.bypassPermissions),
      };
    },
    async snapshot() { return { sessionId, runtime: 'claude', messages: [] }; },
    async stop() {},
  };

  const processor = new MessageProcessor({
    dev: false,
    claudeSessions: sessions,
    webSocketConnections: new Map([['ws-1', {
      id: 'ws-1',
      ws: { readyState: 1, send() {} },
      userId: USER.id,
      githubLogin: USER.githubLogin,
      claudeSessionId: sessionId,
      chatSessionIds: new Set([sessionId]),
      created: new Date(),
    }]]),
    baseFolder: '/projects',
    sessionDurationHours: 5,
    aliases: { claude: 'Claude' },
    validatePath: () => ({ valid: true, path: '/projects' }),
    getSelectedWorkingDir: () => null,
    createSessionRecord: (params) => chatRecord(params.id, params.name, params.workingDir),
    getRuntimeBridge: () => null,
    saveSessionsToDisk: async () => {},
    resolveRuntimeProfile: () => null,
    getUserPreferences: () => ({ chatBypassPermissions: preference === true }),
    transcriptStore: {
      appendOutput() {},
      ensureTranscript: async () => {},
      readTranscriptChunks: async () => [],
    },
    historyStore: {
      append() {},
      stat: async () => ({ firstLine: 0, totalLines: 0 }),
      read: async () => ({ fromLine: 0, lines: [], firstLine: 0, totalLines: 0 }),
    },
    chatManager,
    usageReader: {},
    usageAnalytics: {},
  });

  return { processor, chatManager };
}

/**
 * A conversation with `turns` turns, each with a tool call and an answer.
 *
 * Shaped like the real thing rather than invented: every turn opens with the
 * user's own message (which is what opens a turn at all — see openTurnAfter),
 * carries reasoning and a tool call whose output is deliberately recognisable,
 * and ends with a `turn_end` carrying money.
 */
function conversation({ turns, contextWindow, nativeSessionId = 'native-source', padding = 0 }) {
  const events = [];
  let seq = 0;
  const push = (event) => {
    events.push({ ...event, seq: ++seq, ts: seq });
  };

  push({ t: 'session', nativeSessionId, capabilities: {} });
  if (contextWindow) {
    push({ t: 'usage', usage: { contextWindow, contextWindowSource: 'agent' } });
  }

  for (let i = 1; i <= turns; i++) {
    push({ t: 'msg_start', id: `u${i}`, role: 'user', turnId: `turn-${i}` });
    push({ t: 'block_start', msgId: `u${i}`, index: 0, block: { kind: 'text', text: `question ${i}` } });
    push({ t: 'msg_end', msgId: `u${i}` });
    push({ t: 'msg_start', id: `a${i}`, role: 'assistant', turnId: `turn-${i}` });
    push({ t: 'block_start', msgId: `a${i}`, index: 0, block: { kind: 'thinking', text: `REASONING-${i}` } });
    push({
      t: 'block_start',
      msgId: `a${i}`,
      index: 1,
      block: {
        kind: 'tool',
        toolId: `x${i}`,
        name: 'Bash',
        title: `ran step ${i}`,
        toolKind: 'execute',
        status: 'completed',
        output: `TOOL-OUTPUT-${i}`,
      },
    });
    push({
      t: 'block_start',
      msgId: `a${i}`,
      index: 2,
      block: { kind: 'text', text: `answer ${i}${' filler'.repeat(padding)}` },
    });
    push({ t: 'msg_end', msgId: `a${i}`, usage: { inputTokens: 1000, outputTokens: 500 } });
    push({ t: 'turn_end', turnId: `turn-${i}`, stopReason: 'end_turn', usage: { costUsd: 2.5 } });
  }
  return events;
}

function chatRecord(id, name, workingDir) {
  return {
    id,
    ownerUserId: USER.id,
    name: name || `Session ${id}`,
    created: new Date(),
    lastActivity: new Date(),
    active: false,
    agent: null,
    lastAgent: 'claude',
    runtimeLabel: 'Claude Code',
    surface: 'chat',
    terminalOptions: null,
    stopRequested: false,
    workingDir: workingDir || '/projects/alpha',
    connections: new Set(),
    outputBuffer: [],
    termCols: 80,
    termRows: 24,
    sessionStartTime: null,
    sessionUsage: { requests: 0, inputTokens: 0, outputTokens: 0, cacheTokens: 0, totalCost: 0, models: {} },
    maxBufferSize: 1000,
  };
}

describe('branching a conversation from one of its turns', function () {
  this.timeout(20000);

  let storageDir;
  let activeProfile;
  let store;
  let sessions;
  let server;
  let base;
  let saves;
  let saveResults;
  let transcriptArtifacts;
  let transcriptDeletes;
  let transcriptFailure;
  let attachmentStore;
  let workspaceDir;
  let routeDeps;
  let projectEnsures;
  let projectReleases;

  beforeEach(async function () {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-branch-'));
    workspaceDir = path.join(storageDir, 'workspace');
    fs.mkdirSync(workspaceDir);
    activeProfile = null;
    store = new ChatStore({ storageDir });
    attachmentStore = new AttachmentStore();
    attachmentStore.cloneForBranchInProjectWorkspace = async (
      source,
      target,
      attachment,
      workspaceRoot,
    ) => {
      const hostRef = (session) => ({
        ...session,
        workingDir: workspaceRoot,
        projectId: undefined,
        projectWorkingDirKind: undefined,
        storageScope: {
          ...session.storageScope,
          workspaceRoot,
        },
      });
      return attachmentStore.cloneForBranch(hostRef(source), hostRef(target), attachment);
    };
    sessions = new Map();
    saves = 0;
    saveResults = [];
    transcriptArtifacts = new Set();
    transcriptDeletes = [];
    transcriptFailure = null;
    projectEnsures = [];
    projectReleases = [];
    let projectLeaseNumber = 0;

    const app = express();
    app.use(express.json());
    app.use((_req, res, next) => {
      res.locals.authContext = { user: USER, authSessionId: 'a' };
      next();
    });
    routeDeps = {
        claudeSessions: sessions,
        webSocketConnections: new Map(),
        baseFolder: '/projects',
        dev: false,
        validatePath: (target) =>
          target.startsWith('/projects') ? { valid: true, path: target } : { valid: false, error: 'outside' },
        createSessionRecord: (params) => {
          const record = {
            ...chatRecord(params.id, params.name, params.workingDir),
            ownerSessionId: params.ownerSessionId,
            projectId: params.projectId,
            projectWorkingDirKind: params.projectWorkingDirKind,
          };
          // Only the focused attachment fixture uses workspace-local storage;
          // the original branch tests intentionally keep their legacy paths.
          if (params.storageRoot === workspaceDir) {
            record.storageScope = {
              workspaceRoot: workspaceDir,
              ownerKey: 'stable-branch-owner',
            };
          }
          return record;
        },
        getRuntimeBridge: () => null,
        saveSessionsToDisk: async () => {
          saves += 1;
          const result = saveResults.shift();
          if (result instanceof Error) throw result;
          return result;
        },
        transcriptStore: {
          ensureTranscript: async (session) => {
            transcriptArtifacts.add(session.id);
            if (transcriptFailure) throw transcriptFailure;
            return path.join(storageDir, `${session.id}.md`);
          },
          deleteTranscript: async (session) => {
            transcriptDeletes.push(session.id);
            transcriptArtifacts.delete(session.id);
          },
        },
        historyStore: { deleteHistory: async () => {} },
        getScreenSnapshot: () => [],
        disposeRecorder: () => {},
        getSelectedWorkingDir: () => null,
        // Read by the branch alone, and only to pin the model — see the test
        // for it below. A test that wants no profile clears this.
        activeProfileFor: () => activeProfile,
        sessionStore: { getSessionMetadata: async () => ({}) },
        projectsManager: {
          getForUser: (ownerUserId, projectId) => ownerUserId === USER.id && projectId === 'project-a'
            ? { id: projectId, name: 'Alpha project' }
            : null,
          ensureForSession: async (ownerUserId, projectId) => {
            const leaseId = `branch-project-${++projectLeaseNumber}`;
            projectEnsures.push({ ownerUserId, projectId, leaseId });
            return {
              ok: true,
              environment: {},
              workingDir: workspaceDir,
              allowedWorkingDirs: [workspaceDir],
              leaseId,
            };
          },
          releaseSessionLease: (ownerUserId, projectId, leaseId) => {
            projectReleases.push({ ownerUserId, projectId, leaseId });
            return true;
          },
          projectWorkspaceRoot: (ownerUserId, projectId) =>
            ownerUserId === USER.id && projectId === 'project-a' ? workspaceDir : null,
          withProjectWorkspace: async (ownerUserId, projectId, operation) => {
            assert.strictEqual(ownerUserId, USER.id);
            assert.strictEqual(projectId, 'project-a');
            return operation(workspaceDir);
          },
        },
        attachmentStore,
        chatStore: store,
      };
    const defaultTeardown = new SessionTeardownRegistry();
    defaultTeardown.register('chat-log', (session) => store.deleteChat(session));
    defaultTeardown.register('attachments', (session) => session.storageScope
      ? attachmentStore.deleteSessionAttachments(session)
      : Promise.resolve());
    routeDeps.sessionTeardown = defaultTeardown;
    app.use(createSessionRoutes(routeDeps));

    server = http.createServer(app);
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        base = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });

  afterEach(function () {
    if (server) server.close();
    if (storageDir) fs.rmSync(storageDir, { recursive: true, force: true });
  });

  async function record(id, events, name) {
    const session = chatRecord(id, name);
    sessions.set(id, session);
    store.append(session, events);
    // Forces the store's own queue to drain, so the log is on disk before the
    // route reads it.
    await store.stat(session);
  }

  async function branch(sessionId, turnId) {
    const response = await fetch(`${base}/api/sessions/${sessionId}/branch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }

  const logPath = (id) => path.join(storageDir, String(USER.id), `${id}.jsonl`);

  async function eventsOf(id) {
    const page = await store.read(sessions.get(id) || { id, ownerUserId: USER.id }, 1, 500);
    return page.events;
  }

  async function streamBytes(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  async function assertFailedBranchWasRemoved() {
    assert.deepStrictEqual(
      [...sessions.keys()],
      ['source'],
      'the source record is the only session left in memory',
    );
    assert.deepStrictEqual(
      await store.listSessions(USER.id),
      ['source'],
      'the failed branch log and index were removed without touching the source',
    );
    assert.deepStrictEqual(
      [...transcriptArtifacts],
      [],
      'a transcript prepared by the failed branch was removed too',
    );
    assert.ok(
      transcriptDeletes.length === 1 && transcriptDeletes[0] !== 'source',
      `cleanup targeted only the generated branch: ${JSON.stringify(transcriptDeletes)}`,
    );
  }

  // -------------------------------------------------------- what is carried

  it('refuses to branch a persistence-unavailable conversation without creating artifacts', async function () {
    await record('source', conversation({ turns: 2, contextWindow: 200_000 }));
    const reason = 'Workspace storage is waiting for write access';
    sessions.get('source').persistenceUnavailable = reason;
    const before = fs.readFileSync(logPath('source'));

    const made = await branch('source', 'turn-1');

    assert.strictEqual(made.status, 409);
    assert.deepStrictEqual(made.body, {
      error: 'session_persistence_unavailable',
      message: reason,
      retryable: true,
    });
    assert.deepStrictEqual([...sessions.keys()], ['source']);
    assert.deepStrictEqual(await store.listSessions(USER.id), ['source']);
    assert.deepStrictEqual(fs.readFileSync(logPath('source')), before);
    assert.strictEqual(saves, 0);
    assert.deepStrictEqual([...transcriptArtifacts], []);
  });

  it('gives persistence failure precedence over DELETE recovery and performs no cleanup', async function () {
    const recovery = chatRecord('blocked-recovery', 'Blocked recovery', workspaceDir);
    recovery.storageScope = {
      workspaceRoot: workspaceDir,
      ownerKey: 'stable-branch-owner',
    };
    recovery.rollbackRecoveryPending = true;
    recovery.persistenceUnavailable = 'Workspace storage is waiting for write access';
    recovery.tabOpen = false;
    sessions.set(recovery.id, recovery);
    const cleanup = [];
    const teardown = new SessionTeardownRegistry();
    teardown.register('sentinel', async () => { cleanup.push('ran'); });
    routeDeps.sessionTeardown = teardown;

    const response = await fetch(`${base}/api/sessions/${recovery.id}`, { method: 'DELETE' });
    assert.strictEqual(response.status, 409);
    assert.deepStrictEqual(await response.json(), {
      error: 'session_persistence_unavailable',
      message: recovery.persistenceUnavailable,
      retryable: true,
    });
    assert.deepStrictEqual(cleanup, []);
    assert.strictEqual(saves, 0);
    assert.strictEqual(sessions.get(recovery.id), recovery);
    assert.strictEqual(recovery.retiring, undefined);
  });

  it('carries the turns up to and including the one branched from, and no further', async function () {
    await record('source', conversation({ turns: 5, contextWindow: 200_000 }));

    const made = await branch('source', 'turn-3');
    assert.strictEqual(made.status, 200, JSON.stringify(made.body));
    assert.strictEqual(made.body.turnIndex, 3);
    assert.strictEqual(made.body.turns, 3);

    const index = await store.turnIndex({ id: made.body.sessionId, ownerUserId: USER.id });
    assert.deepStrictEqual(
      index.turns.map((turn) => turn.label),
      ['question 1', 'question 2', 'question 3'],
      'the branch holds the conversation as far as the turn it was cut at',
    );
    assert.strictEqual(index.complete, true, 'and it holds all of it, so its index says so');

    const events = await eventsOf(made.body.sessionId);
    const text = JSON.stringify(events);
    assert.ok(text.includes('answer 3'), 'the branch turn itself is carried');
    assert.ok(!text.includes('question 4'), 'the turns after it are not');
    assert.ok(!text.includes('answer 4'));
  });

  it('clones image and file bytes before commit, then survives source deletion and restart', async function () {
    const source = chatRecord('source-attachments', 'Files', workspaceDir);
    source.storageScope = {
      workspaceRoot: workspaceDir,
      ownerKey: 'stable-branch-owner',
    };
    sessions.set(source.id, source);

    const textBytes = Buffer.from('branch-owned text bytes\n');
    const text = await attachmentStore.save(source, {
      filename: 'notes.txt', declaredMime: 'text/plain', bytes: textBytes,
    });
    const image = await attachmentStore.save(source, {
      filename: 'pixel.png', declaredMime: 'image/png', bytes: PNG,
    });
    const events = conversation({ turns: 1, contextWindow: 200_000 });
    const userEnd = events.findIndex((event) => event.t === 'msg_end' && event.msgId === 'u1');
    events.splice(
      userEnd,
      0,
      {
        t: 'block_start', msgId: 'u1', index: 1,
        block: {
          kind: 'attachment',
          url: `/api/sessions/${source.id}/chat-attachments/${text.storedName}`,
          name: text.name,
          mime: text.mime,
          size: text.bytes,
        },
      },
      // Uploaded images were represented this way in older durable logs. A
      // branch must clone those bytes too, while leaving runtime image URLs be.
      {
        t: 'block_start', msgId: 'u1', index: 2,
        block: {
          kind: 'image',
          url: `/api/sessions/${source.id}/chat-attachments/${image.storedName}`,
          alt: image.name,
          mime: image.mime,
        },
      },
      {
        t: 'block_start', msgId: 'u1', index: 3,
        block: {
          kind: 'attachment',
          url: `/api/sessions/${source.id}/chat-attachments/${text.storedName}`,
          name: text.name,
          mime: text.mime,
          size: text.bytes,
        },
      },
    );
    events.forEach((event, index) => {
      event.seq = index + 1;
      event.ts = index + 1;
    });
    await store.append(source, events);
    await store.stat(source);

    const originalClone = attachmentStore.cloneForBranch.bind(attachmentStore);
    let cloneCalls = 0;
    attachmentStore.cloneForBranch = async (...args) => {
      cloneCalls += 1;
      return originalClone(...args);
    };
    const made = await branch(source.id, 'turn-1');
    assert.strictEqual(made.status, 200, JSON.stringify(made.body));
    assert.strictEqual(cloneCalls, 2, 'a duplicate URL is copied only once');
    const target = sessions.get(made.body.sessionId);
    const carried = (await eventsOf(target.id))
      .filter((event) => event.t === 'block_start')
      .map((event) => event.block)
      .filter((block) => block.kind === 'attachment' || block.kind === 'image');
    assert.strictEqual(carried.length, 3);
    assert.strictEqual(new Set(carried.map((block) => block.url)).size, 2);
    assert.ok(
      carried.every((block) => block.url.includes(`/sessions/${target.id}/chat-attachments/`)),
      'every carried URL is qualified for the branch session',
    );
    assert.ok(carried.every((block) => !block.url.includes(source.id)));

    await attachmentStore.deleteSessionAttachments(source);
    await store.deleteChat(source);
    sessions.delete(source.id);

    // A fresh store and chat reader model a cold restart: neither can rely on
    // source handles or process-local clone state.
    const restartedAttachments = new AttachmentStore();
    const restartedChat = new ChatStore({ storageDir });
    const restartedEvents = await restartedChat.read(target, 1, 500);
    const restartedBlocks = restartedEvents.events
      .filter((event) => event.t === 'block_start')
      .map((event) => event.block)
      .filter((block) => block.kind === 'attachment' || block.kind === 'image');
    const downloaded = [];
    for (const block of restartedBlocks) {
      const storedName = storedAttachmentNameFromUrl(block.url, target.id);
      assert.ok(storedName, `branch URL remained canonical: ${block.url}`);
      const opened = await restartedAttachments.openForDownload(target, storedName);
      downloaded.push(await streamBytes(opened.stream));
    }
    assert.ok(downloaded.some((bytes) => bytes.equals(textBytes)), 'non-image bytes survived');
    assert.ok(downloaded.some((bytes) => bytes.equals(PNG)), 'image bytes survived');
  });

  it('removes a partial attachment clone when a later branch copy fails', async function () {
    const source = chatRecord('source-rollback', 'Files', workspaceDir);
    source.storageScope = {
      workspaceRoot: workspaceDir,
      ownerKey: 'stable-branch-owner',
    };
    sessions.set(source.id, source);
    const first = await attachmentStore.save(source, {
      filename: 'one.txt', declaredMime: 'text/plain', bytes: Buffer.from('one'),
    });
    const second = await attachmentStore.save(source, {
      filename: 'two.txt', declaredMime: 'text/plain', bytes: Buffer.from('two'),
    });
    const events = conversation({ turns: 1, contextWindow: 200_000 });
    const userEnd = events.findIndex((event) => event.t === 'msg_end' && event.msgId === 'u1');
    for (const [offset, stored] of [first, second].entries()) {
      events.splice(userEnd + offset, 0, {
        t: 'block_start', msgId: 'u1', index: offset + 1,
        block: {
          kind: 'attachment',
          url: `/api/sessions/${source.id}/chat-attachments/${stored.storedName}`,
          name: stored.name, mime: stored.mime, size: stored.bytes,
        },
      });
    }
    events.forEach((event, index) => { event.seq = index + 1; event.ts = index + 1; });
    await store.append(source, events);
    await store.stat(source);

    const originalClone = attachmentStore.cloneForBranch.bind(attachmentStore);
    let calls = 0;
    let firstClone;
    attachmentStore.cloneForBranch = async (...args) => {
      calls += 1;
      if (calls === 2) throw Object.assign(new Error('injected clone conflict'), { code: 'EEXIST' });
      firstClone = await originalClone(...args);
      return firstClone;
    };

    const made = await branch(source.id, 'turn-1');
    assert.strictEqual(made.status, 500, JSON.stringify(made.body));
    assert.strictEqual(made.body.error, 'branch_failed');
    assert.strictEqual(calls, 2);
    assert.ok(firstClone);
    const targetId = transcriptDeletes[0];
    const failedTarget = {
      ...source,
      id: targetId,
    };
    const storedName = storedAttachmentNameFromUrl(firstClone.url, targetId);
    await assert.rejects(
      () => new AttachmentStore().openForDownload(failedTarget, storedName),
      (error) => error && error.code === 'NOT_FOUND',
      'the first copied file is removed with the failed branch',
    );
    assert.ok(fs.existsSync(first.absolutePath), 'source bytes remain intact');
    assert.ok(fs.existsSync(second.absolutePath), 'all source bytes remain intact');
  });

  it('removes every cloned attachment when append, transcript, or session commit fails', async function () {
    const source = chatRecord('source-post-clone-rollback', 'Files', workspaceDir);
    source.storageScope = {
      workspaceRoot: workspaceDir,
      ownerKey: 'stable-branch-owner',
    };
    sessions.set(source.id, source);
    const originals = [];
    for (const [index, value] of ['first', 'second'].entries()) {
      originals.push(await attachmentStore.save(source, {
        filename: `${value}.txt`,
        declaredMime: 'text/plain',
        bytes: Buffer.from(value),
      }));
    }
    const events = conversation({ turns: 1, contextWindow: 200_000 });
    const userEnd = events.findIndex((event) => event.t === 'msg_end' && event.msgId === 'u1');
    originals.forEach((stored, offset) => events.splice(userEnd + offset, 0, {
      t: 'block_start', msgId: 'u1', index: offset + 1,
      block: {
        kind: 'attachment',
        url: `/api/sessions/${source.id}/chat-attachments/${stored.storedName}`,
        name: stored.name, mime: stored.mime, size: stored.bytes,
      },
    }));
    events.forEach((event, index) => { event.seq = index + 1; event.ts = index + 1; });
    await store.append(source, events);
    await store.stat(source);

    for (const failure of ['append', 'transcript', 'save']) {
      const originalClone = attachmentStore.cloneForBranch.bind(attachmentStore);
      const clones = [];
      attachmentStore.cloneForBranch = async (...args) => {
        const cloned = await originalClone(...args);
        clones.push(cloned);
        return cloned;
      };
      const originalAppend = store.append.bind(store);
      if (failure === 'append') {
        store.append = async (ref, carried) => {
          await originalAppend(ref, carried);
          if (ref.id !== source.id) throw new Error('injected append failure after write');
        };
      } else if (failure === 'transcript') {
        transcriptFailure = new Error('injected transcript failure after clone');
      } else {
        saveResults.push(false, undefined);
      }

      const made = await branch(source.id, 'turn-1');
      store.append = originalAppend;
      transcriptFailure = null;
      attachmentStore.cloneForBranch = originalClone;

      assert.ok([500, 503].includes(made.status), `${failure}: ${JSON.stringify(made.body)}`);
      assert.strictEqual(clones.length, 2, `${failure}: both copies completed before failure`);
      const targetId = decodeURIComponent(clones[0].url.split('/')[3]);
      const failedTarget = { ...source, id: targetId };
      for (const cloned of clones) {
        const storedName = storedAttachmentNameFromUrl(cloned.url, targetId);
        await assert.rejects(
          () => new AttachmentStore().openForDownload(failedTarget, storedName),
          (error) => error && error.code === 'NOT_FOUND',
          `${failure}: cloned bytes were rolled back`,
        );
      }
    }
    for (const original of originals) {
      assert.ok(fs.existsSync(original.absolutePath), 'source attachment survives every rollback');
    }
  });

  it('renumbers the carried log from its own beginning and closes it with a rule', async function () {
    await record('source', conversation({ turns: 4, contextWindow: 200_000 }));
    const made = await branch('source', 'turn-2');

    const events = await eventsOf(made.body.sessionId);
    assert.deepStrictEqual(
      events.map((event) => event.seq),
      events.map((_event, position) => position + 1),
      'a new conversation log starts at one and stays contiguous',
    );

    const last = events[events.length - 1];
    assert.strictEqual(last.t, 'marker');
    assert.strictEqual(last.kind, 'branched');
    assert.ok(/turn 2/.test(last.detail), last.detail);
  });

  it('carries a workflow that failed, so a branch does not show it as done', async function () {
    // The launch acknowledgement is what the tool call carries — "Workflow
    // launched in background", no error — so a branch that replayed only that
    // would show a run that broke as a green "done" all over again, which is
    // the bug #140 was about, one conversation along.
    const events = conversation({ turns: 2 });
    let seq = events.length;
    events.push(
      {
        t: 'block_start',
        seq: ++seq,
        ts: seq,
        msgId: 'a1',
        index: 3,
        block: {
          kind: 'tool',
          toolId: 'wf1',
          name: 'Workflow',
          toolKind: 'task',
          status: 'completed',
          output: 'Workflow launched in background. Task ID: k1',
        },
      },
      {
        t: 'workflow_failed',
        seq: ++seq,
        ts: seq,
        parentToolId: 'wf1',
        name: 'nightly-audit',
        reason: 'usage limit reached',
      },
    );
    await record('source-wf', events);

    const made = await branch('source-wf', 'turn-2');
    assert.strictEqual(made.status, 200, JSON.stringify(made.body));
    const carried = await eventsOf(made.body.sessionId);

    const failure = carried.find((event) => event.t === 'workflow_failed');
    assert.ok(failure, 'the branch dropped the failure and kept only the launch');
    assert.strictEqual(failure.name, 'nightly-audit');
    assert.strictEqual(failure.reason, 'usage limit reached');
  });

  it('leaves the conversation it came from untouched', async function () {
    await record('source', conversation({ turns: 4, contextWindow: 200_000 }));
    const before = fs.readFileSync(logPath('source'));

    const made = await branch('source', 'turn-2');
    assert.strictEqual(made.status, 200);

    assert.ok(
      before.equals(fs.readFileSync(logPath('source'))),
      'branching is a read of the source and a write somewhere else',
    );
  });

  it('does not carry the source runtime’s own session id, or its bill', async function () {
    await record('source', conversation({ turns: 3, contextWindow: 200_000 }));
    const made = await branch('source', 'turn-2');

    const described = await store.describe({ id: made.body.sessionId, ownerUserId: USER.id });
    assert.strictEqual(
      described.nativeSessionId,
      null,
      'a branch that inherited one would offer to resume the conversation it came from',
    );

    const snapshot = await store.snapshot({ id: made.body.sessionId, ownerUserId: USER.id });
    assert.ok(
      !snapshot.usage.costUsd,
      `a branch opens having spent nothing, not ${snapshot.usage.costUsd}`,
    );
  });

  it('opens a conversation of its own, in the same place, on the same runtime', async function () {
    await record('source', conversation({ turns: 2, contextWindow: 200_000 }), 'Refactoring the parser');
    sessions.get('source').chatModelOverride = 'claude-opus-4-6';
    sessions.get('source').chatBypassPermissions = true;

    const made = await branch('source', 'turn-1');
    const branched = sessions.get(made.body.sessionId);

    assert.ok(branched, 'the branch is a session the app knows about');
    assert.notStrictEqual(made.body.sessionId, 'source');
    assert.strictEqual(branched.workingDir, '/projects/alpha');
    assert.strictEqual(branched.lastAgent, 'claude');
    assert.strictEqual(branched.surface, 'chat');
    assert.strictEqual(branched.chatModelOverride, 'claude-opus-4-6');
    assert.strictEqual(
      branched.sessionStartTime,
      null,
      'nothing is running in it yet — which is why the pin above matters (#135)',
    );
    assert.ok(/branch at turn 1/.test(branched.name), branched.name);
    assert.strictEqual(
      branched.chatBypassPermissions,
      undefined,
      'a standing permission belongs to the conversation that granted it',
    );
    assert.ok(saves > 0, 'and the new record is persisted');
  });

  it('allocates its append position when the finished branch is inserted', async function () {
    await record('source', conversation({ turns: 2, contextWindow: 200_000 }));
    sessions.get('source').tabOrder = 0;
    sessions.set('closed', Object.assign(chatRecord('closed'), { tabOpen: false, tabOrder: 99 }));

    const originalSetOpeningContext = store.setOpeningContext.bind(store);
    let openingStarted;
    const started = new Promise((resolve) => { openingStarted = resolve; });
    let finishOpening;
    const finished = new Promise((resolve) => { finishOpening = resolve; });
    store.setOpeningContext = async (ref, context) => {
      await originalSetOpeningContext(ref, context);
      openingStarted();
      await finished;
    };

    const branching = branch('source', 'turn-1');
    await started;
    // Another tab opens during the branch's durable-log work. Capturing the
    // position when createSessionRecord ran would now duplicate this ordinal.
    const newer = chatRecord('newer');
    newer.tabOrder = 1;
    sessions.set(newer.id, newer);
    finishOpening();

    const made = await branching;
    assert.strictEqual(made.status, 200, JSON.stringify(made.body));
    assert.strictEqual(sessions.get(made.body.sessionId).tabOrder, 2);
  });

  it('removes a partially written log when branch stat fails', async function () {
    await record('source', conversation({ turns: 2, contextWindow: 200_000 }));
    const originalStat = store.stat.bind(store);
    store.stat = async (ref) => {
      const stats = await originalStat(ref);
      if (ref.id !== 'source') throw new Error('injected branch stat failure');
      return stats;
    };

    const made = await branch('source', 'turn-1');

    assert.strictEqual(made.status, 500, JSON.stringify(made.body));
    assert.strictEqual(made.body.error, 'branch_failed');
    await assertFailedBranchWasRemoved();
  });

  it('removes the log and opening context when context persistence fails after writing', async function () {
    await record('source', conversation({ turns: 2, contextWindow: 200_000 }));
    const originalSetOpeningContext = store.setOpeningContext.bind(store);
    store.setOpeningContext = async (ref, context) => {
      await originalSetOpeningContext(ref, context);
      throw new Error('injected opening-context failure');
    };

    const made = await branch('source', 'turn-1');

    assert.strictEqual(made.status, 500, JSON.stringify(made.body));
    assert.strictEqual(made.body.error, 'branch_failed');
    await assertFailedBranchWasRemoved();
    assert.strictEqual(
      await store.openingContext({ id: transcriptDeletes[0], ownerUserId: USER.id }),
      null,
      'deleteChat also removed the context sidecar written before the failure',
    );
  });

  it('removes every prepared artifact when transcript creation fails', async function () {
    await record('source', conversation({ turns: 2, contextWindow: 200_000 }));
    transcriptFailure = new Error('injected transcript failure');

    const made = await branch('source', 'turn-1');

    assert.strictEqual(made.status, 500, JSON.stringify(made.body));
    assert.strictEqual(made.body.error, 'branch_failed');
    assert.strictEqual(
      saves,
      2,
      'a hidden recovery anchor is committed before cleanup and removed after cleanup succeeds',
    );
    await assertFailedBranchWasRemoved();
  });

  it('reports strict disposer failures with a recoverable branch id while running every disposer', async function () {
    await record('source', conversation({ turns: 2, contextWindow: 200_000 }));
    transcriptFailure = new Error('injected transcript failure');
    const disposed = [];
    const teardown = new SessionTeardownRegistry();
    teardown.register('chat-log', async (session) => {
      disposed.push(`chat:${session.id}`);
      throw new Error('injected chat cleanup failure');
    });
    teardown.register('attachments', async (session) => {
      disposed.push(`attachments:${session.id}`);
    });
    teardown.register('lease', async (session) => {
      assert.ok(
        transcriptDeletes.includes(session.id),
        'descriptor-backed transcript cleanup finishes before the directory lease disposer',
      );
      disposed.push(`lease:${session.id}`);
    });
    routeDeps.sessionTeardown = teardown;

    const made = await branch('source', 'turn-1');

    assert.strictEqual(made.status, 500, JSON.stringify(made.body));
    assert.strictEqual(made.body.error, 'branch_failed');
    assert.strictEqual(made.body.recoveryPending, true);
    assert.strictEqual(made.body.recoveryDurable, true);
    assert.ok(made.body.sessionId, 'the orphan namespace is returned for deterministic recovery');
    assert.deepStrictEqual(disposed, [
      `chat:${made.body.sessionId}`,
      `attachments:${made.body.sessionId}`,
      `lease:${made.body.sessionId}`,
    ], 'a failing disposer does not skip later cleanup owners');
    const recovered = sessions.get(made.body.sessionId);
    assert.ok(recovered, 'the remaining namespace retains an exact recovery record');
    assert.strictEqual(recovered.rollbackRecoveryPending, true);
    assert.strictEqual(recovered.tabOpen, false, 'a recovery anchor never becomes an account tab');
    assert.strictEqual(saves, 1, 'cleanup failure publishes its recovery authority durably');
    assert.ok(
      (await store.listSessions(USER.id)).includes(made.body.sessionId),
      'the failed chat cleanup remains addressable by the returned session id',
    );
  });

  it('durably restores recovery authority when cleanup fails after a confirmed compensating save', async function () {
    await record('source', conversation({ turns: 2, contextWindow: 200_000 }));
    // Refuse branch commit, then confirm the hidden recovery anchor before any
    // strict cleanup owner is allowed to mutate the workspace.
    saveResults.push(false, undefined);
    let attachmentCleanupAttempts = 0;
    let failAttachmentCleanup = true;
    const teardown = new SessionTeardownRegistry();
    teardown.register('chat-log', (session) => store.deleteChat(session));
    teardown.register('attachments', async () => {
      attachmentCleanupAttempts += 1;
      if (failAttachmentCleanup) throw new Error('injected attachment cleanup failure');
    });
    routeDeps.sessionTeardown = teardown;

    const made = await branch('source', 'turn-1');

    assert.strictEqual(made.status, 503, JSON.stringify(made.body));
    assert.strictEqual(made.body.error, 'branch_not_saved');
    assert.strictEqual(made.body.recoveryPending, true);
    assert.strictEqual(made.body.recoveryDurable, true);
    assert.ok(made.body.sessionId);
    assert.strictEqual(saves, 2, 'commit refusal is followed by a durable pre-cleanup anchor');
    assert.ok(sessions.has(made.body.sessionId), 'remaining quota is owned by a durable session record');
    assert.strictEqual(attachmentCleanupAttempts, 1);

    failAttachmentCleanup = false;
    const retried = await fetch(`${base}/api/sessions/${made.body.sessionId}`, { method: 'DELETE' });
    assert.strictEqual(retried.status, 200, await retried.text());
    assert.strictEqual(attachmentCleanupAttempts, 2, 'the returned id supports definitive cleanup retry');
    assert.strictEqual(sessions.has(made.body.sessionId), false);
  });

  it('cold-restores a durable recovery anchor and DELETE completes its cleanup', async function () {
    const scope = {
      workspaceRoot: workspaceDir,
      ownerKey: 'stable-branch-owner',
    };
    const sharedDataDir = path.join(storageDir, 'shared-session-metadata');
    let persistent = new SessionStore({ storageDir: sharedDataDir, scopedGlobalStore: true });
    try {
      const now = new Date().toISOString();
      persistent.database.raw.prepare(`
        INSERT INTO users (
          id, github_id, github_login, github_name, avatar_url, email,
          created_at, updated_at, last_login_at
        ) VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, ?)
      `).run(USER.id, 'cold-recovery-owner', USER.githubLogin, now, now, now);
      await persistent.loadSessions();
      const source = chatRecord('cold-recovery-source', 'Cold recovery', workspaceDir);
      source.storageScope = scope;
      sessions.set(source.id, source);
      await store.append(source, conversation({ turns: 1, contextWindow: 200_000 }));
      await store.stat(source);
      assert.strictEqual(await persistent.saveSessions(sessions), true);
      routeDeps.saveSessionsToDisk = () => persistent.saveSessions(sessions);

      let cleanupFails = true;
      const teardown = new SessionTeardownRegistry();
      teardown.register('chat-log', async (session) => {
        if (cleanupFails) throw new Error('injected cleanup failure before restart');
        await store.deleteChat(session);
      });
      teardown.register('attachments', (session) => attachmentStore.deleteSessionAttachments(session));
      routeDeps.sessionTeardown = teardown;
      transcriptFailure = new Error('injected prepare failure');

      const made = await branch(source.id, 'turn-1');
      assert.strictEqual(made.status, 500, JSON.stringify(made.body));
      assert.strictEqual(made.body.recoveryPending, true);
      assert.strictEqual(made.body.recoveryDurable, true);
      assert.ok(made.body.sessionId);
      persistent.database.close();

      persistent = new SessionStore({ storageDir: sharedDataDir, scopedGlobalStore: true });
      const restored = await persistent.loadSessions();
      const anchor = restored.get(made.body.sessionId);
      assert.ok(anchor, 'the recovery row is rediscovered from shared app SQLite');
      assert.strictEqual(anchor.rollbackRecoveryPending, true);
      assert.strictEqual(anchor.tabOpen, false);
      sessions.clear();
      for (const [id, session] of restored) sessions.set(id, session);
      routeDeps.saveSessionsToDisk = () => persistent.saveSessions(sessions);
      transcriptFailure = null;
      cleanupFails = false;

      const retried = await fetch(`${base}/api/sessions/${anchor.id}`, { method: 'DELETE' });
      assert.strictEqual(retried.status, 200, await retried.text());
      assert.strictEqual(sessions.has(anchor.id), false);
      persistent.database.close();

      persistent = new SessionStore({ storageDir: sharedDataDir, scopedGlobalStore: true });
      const afterRestart = await persistent.loadSessions();
      assert.strictEqual(afterRestart.has(anchor.id), false, 'the confirmed removal survives another boot');
      assert.strictEqual(afterRestart.has(source.id), true, 'cleanup never prunes the source conversation');
    } finally {
      try { persistent.database.close(); } catch { /* already closed */ }
    }
  });

  it('compensates a failed session save and removes all branch artifacts', async function () {
    await record('source', conversation({ turns: 2, contextWindow: 200_000 }));
    // The first result rejects the branch commit. The next two commit the
    // hidden pre-cleanup anchor and then its definitive removal.
    saveResults.push(false, undefined, undefined);

    const made = await branch('source', 'turn-1');

    assert.strictEqual(made.status, 503, JSON.stringify(made.body));
    assert.strictEqual(made.body.error, 'branch_not_saved');
    assert.strictEqual(saves, 3, 'cleanup is bracketed by a durable anchor and its removal');
    await assertFailedBranchWasRemoved();
  });

  it('preserves the branch record and artifacts when durable rollback remains ambiguous', async function () {
    const source = chatRecord('source-ambiguous-save', 'Files', workspaceDir);
    source.storageScope = {
      workspaceRoot: workspaceDir,
      ownerKey: 'stable-branch-owner',
    };
    sessions.set(source.id, source);
    const original = await attachmentStore.save(source, {
      filename: 'evidence.txt',
      declaredMime: 'text/plain',
      bytes: Buffer.from('preserve on ambiguous rollback'),
    });
    const events = conversation({ turns: 1, contextWindow: 200_000 });
    const userEnd = events.findIndex((event) => event.t === 'msg_end' && event.msgId === 'u1');
    events.splice(userEnd, 0, {
      t: 'block_start',
      msgId: 'u1',
      index: 1,
      block: {
        kind: 'attachment',
        url: `/api/sessions/${source.id}/chat-attachments/${original.storedName}`,
        name: original.name,
        mime: original.mime,
        size: original.bytes,
      },
    });
    events.forEach((event, index) => { event.seq = index + 1; event.ts = index + 1; });
    await store.append(source, events);
    await store.stat(source);

    let cloned;
    const originalClone = attachmentStore.cloneForBranch.bind(attachmentStore);
    attachmentStore.cloneForBranch = async (...args) => {
      cloned = await originalClone(...args);
      return cloned;
    };
    const durableIds = new Set([source.id]);
    let saveCalls = 0;
    routeDeps.saveSessionsToDisk = async () => {
      saveCalls += 1;
      if (saveCalls === 1) {
        // Model the exact ambiguous seam: SQLite committed the branch row, but
        // the coordinator could not prove/complete its wider save.
        for (const id of sessions.keys()) durableIds.add(id);
      }
      return false;
    };

    const made = await branch(source.id, 'turn-1');

    assert.strictEqual(made.status, 503, JSON.stringify(made.body));
    assert.strictEqual(made.body.recoveryPending, true);
    assert.strictEqual(made.body.recoveryDurable, false);
    assert.ok(made.body.sessionId);
    assert.strictEqual(saveCalls, 2, 'commit refusal is followed by one failed anchor save');
    assert.ok(durableIds.has(made.body.sessionId), 'the simulated database can still contain the row');
    const recovered = sessions.get(made.body.sessionId);
    assert.ok(recovered, 'the matching record is restored in memory');
    assert.strictEqual(recovered.rollbackRecoveryPending, true);
    assert.strictEqual(recovered.tabOpen, false);
    assert.ok(transcriptArtifacts.has(recovered.id), 'its transcript is preserved');
    assert.deepStrictEqual(transcriptDeletes, [], 'ambiguous rollback performs no teardown');
    assert.ok((await store.stat(recovered)).cursor > 0, 'its durable chat remains readable');
    const storedName = storedAttachmentNameFromUrl(cloned.url, recovered.id);
    const opened = await new AttachmentStore().openForDownload(recovered, storedName);
    assert.strictEqual((await streamBytes(opened.stream)).toString(), 'preserve on ambiguous rollback');

    const retried = await fetch(`${base}/api/sessions/${recovered.id}`, { method: 'DELETE' });
    assert.strictEqual(retried.status, 503);
    const retryBody = await retried.json();
    assert.strictEqual(retryBody.error, 'session_recovery_not_durable');
    assert.strictEqual(retryBody.recoveryDurable, false);
    assert.strictEqual(saveCalls, 3, 'DELETE performs one explicit anchor confirmation attempt');
    assert.deepStrictEqual(transcriptDeletes, [], 'a refused confirmation still performs no teardown');
    assert.ok(sessions.has(recovered.id));
  });

  it('returns the complete project namespace identity for a new branch', async function () {
    await record('source', conversation({ turns: 2, contextWindow: 200_000 }));
    const source = sessions.get('source');
    source.projectId = 'project-a';
    source.projectWorkingDirKind = 'container';
    source.workingDir = '/workspace';

    const made = await branch('source', 'turn-1');

    assert.strictEqual(made.status, 200);
    assert.strictEqual(made.body.workingDir, '/workspace');
    assert.strictEqual(made.body.projectId, 'project-a');
    assert.strictEqual(made.body.projectName, 'Alpha project');
    assert.strictEqual(made.body.projectWorkingDirKind, 'container');
    assert.strictEqual(projectEnsures.length, 0, 'branching metadata does not start a stopped project');
    assert.strictEqual(projectReleases.length, 0);
  });

  it('revalidates the exact project source after asynchronous no-start lifecycle admission', async function () {
    await record('source-project-admission', conversation({ turns: 1, contextWindow: 200_000 }));
    const source = sessions.get('source-project-admission');
    source.projectId = 'project-a';
    source.projectWorkingDirKind = 'host';
    source.workingDir = workspaceDir;
    source.storageScope = {
      workspaceRoot: workspaceDir,
      ownerKey: 'stable-branch-owner',
    };

    let admissionStarted;
    const atAdmission = new Promise((resolve) => { admissionStarted = resolve; });
    let finishAdmission;
    const admissionMayFinish = new Promise((resolve) => { finishAdmission = resolve; });
    routeDeps.projectsManager.withProjectWorkspace = async (ownerUserId, projectId, operation) => {
      assert.strictEqual(ownerUserId, USER.id);
      assert.strictEqual(projectId, 'project-a');
      admissionStarted();
      await admissionMayFinish;
      return operation(workspaceDir);
    };

    const branching = branch(source.id, 'turn-1');
    await atAdmission;
    const replacement = { ...source, retiring: true, connections: new Set() };
    sessions.set(source.id, replacement);
    finishAdmission();
    const made = await branching;

    assert.strictEqual(made.status, 409, JSON.stringify(made.body));
    assert.strictEqual(made.body.error, 'source_session_retiring');
    assert.strictEqual(sessions.get(source.id), replacement);
    assert.strictEqual(saves, 0, 'no branch artifact or row is attempted for a replaced source');
    assert.deepStrictEqual([...transcriptArtifacts], []);
    assert.strictEqual(projectEnsures.length, 0, 'branch storage never starts or admits a project runtime');
    assert.strictEqual(projectReleases.length, 0, 'no runtime lease exists to release');
  });

  it('holds the no-start lifecycle gate through commit so rebuild and deletion wait for the branch', async function () {
    const source = chatRecord('project-source-race', 'Project files', workspaceDir);
    source.projectId = 'project-a';
    source.projectWorkingDirKind = 'host';
    source.storageScope = {
      workspaceRoot: workspaceDir,
      ownerKey: 'stable-branch-owner',
    };
    sessions.set(source.id, source);
    const events = conversation({ turns: 1, contextWindow: 200_000 });
    const userEnd = events.findIndex((event) => event.t === 'msg_end' && event.msgId === 'u1');
    const storedName = '111111111111-proof.txt';
    events.splice(userEnd, 0, {
      t: 'block_start',
      msgId: 'u1',
      index: 1,
      block: {
        kind: 'attachment',
        url: `/api/sessions/${source.id}/chat-attachments/${storedName}`,
        name: 'proof.txt',
        mime: 'text/plain',
        size: 5,
      },
    });
    events.forEach((event, index) => { event.seq = index + 1; event.ts = index + 1; });
    await store.append(source, events);
    await store.stat(source);

    let cloneReached;
    const atClone = new Promise((resolve) => { cloneReached = resolve; });
    let finishClone;
    const cloneMayFinish = new Promise((resolve) => { finishClone = resolve; });
    attachmentStore.cloneForBranch = async (_source, target) => {
      cloneReached();
      await cloneMayFinish;
      return {
        url: `/api/sessions/${target.id}/chat-attachments/${storedName}`,
        name: 'proof.txt',
        mime: 'text/plain',
        size: 5,
        path: path.join(workspaceDir, '.cc-web', 'attachments', target.id, storedName),
      };
    };
    attachmentStore.deleteSessionAttachments = async () => {};

    let lifecycleTail = Promise.resolve();
    routeDeps.projectsManager.withProjectWorkspace = async (ownerUserId, projectId, operation) => {
      assert.strictEqual(ownerUserId, USER.id);
      assert.strictEqual(projectId, 'project-a');
      let releaseTurn;
      const turn = new Promise((resolve) => { releaseTurn = resolve; });
      const previous = lifecycleTail;
      lifecycleTail = previous.then(() => turn);
      await previous;
      try {
        return await operation(workspaceDir);
      } finally {
        releaseTurn();
      }
    };

    const branching = branch(source.id, 'turn-1');
    await atClone;
    assert.strictEqual(projectEnsures.length, 0, 'branching a stopped project never starts its runtime');

    let rebuildEntered = false;
    const rebuild = routeDeps.projectsManager.withProjectWorkspace(
      USER.id,
      'project-a',
      async () => { rebuildEntered = true; },
    );
    let retirementSettled = false;
    let retirementEntered = false;
    const retirement = routeDeps.projectsManager.withProjectWorkspace(
      USER.id,
      'project-a',
      async () => {
        retirementEntered = true;
        const ids = await retireProjectSessions(routeDeps, 'project-a');
        retirementSettled = true;
        return ids;
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(rebuildEntered, false, 'project rebuild waits outside the held lifecycle gate');
    assert.strictEqual(retirementEntered, false, 'project deletion waits outside the held lifecycle gate');
    assert.strictEqual(retirementSettled, false);
    assert.strictEqual(source.retiring, undefined, 'queued deletion cannot mutate the source mid-branch');

    finishClone();
    const made = await branching;
    assert.strictEqual(made.status, 200, JSON.stringify(made.body));
    await rebuild;
    assert.strictEqual(rebuildEntered, true);
    const retired = await retirement;

    assert.ok(retired.includes(source.id));
    assert.ok(retired.includes(made.body.sessionId), 'the post-drain rescan includes the new branch root');
    assert.deepStrictEqual([...sessions.keys()], []);
    assert.strictEqual(projectReleases.length, 0, 'branching never acquired a runtime lease');
  });

  it('rolls back a post-clone failure inside a non-reentrant project gate without reacquiring it', async function () {
    const source = chatRecord('project-source-rollback', 'Project rollback', workspaceDir);
    source.projectId = 'project-a';
    source.projectWorkingDirKind = 'container';
    source.storageScope = {
      workspaceRoot: workspaceDir,
      ownerKey: 'stable-branch-owner',
    };
    sessions.set(source.id, source);

    const hostAttachments = new AttachmentStore();
    const hostSource = {
      ...source,
      projectId: undefined,
      projectWorkingDirKind: undefined,
      workingDir: workspaceDir,
    };
    const original = await hostAttachments.save(hostSource, {
      filename: 'rollback.txt',
      declaredMime: 'text/plain',
      bytes: Buffer.from('rollback bytes'),
    });
    const events = conversation({ turns: 1, contextWindow: 200_000 });
    const userEnd = events.findIndex((event) => event.t === 'msg_end' && event.msgId === 'u1');
    events.splice(userEnd, 0, {
      t: 'block_start',
      msgId: 'u1',
      index: 1,
      block: {
        kind: 'attachment',
        url: `/api/sessions/${source.id}/chat-attachments/${original.storedName}`,
        name: original.name,
        mime: original.mime,
        size: original.bytes,
      },
    });
    events.forEach((event, index) => { event.seq = index + 1; event.ts = index + 1; });
    await store.append(source, events);
    await store.stat(source);

    let gateHeld = false;
    let gateEntries = 0;
    let nestedEntries = 0;
    routeDeps.projectsManager.withProjectWorkspace = async (ownerUserId, projectId, operation) => {
      assert.strictEqual(ownerUserId, USER.id);
      assert.strictEqual(projectId, 'project-a');
      if (gateHeld) {
        nestedEntries += 1;
        throw new Error('non-reentrant lifecycle gate');
      }
      gateHeld = true;
      gateEntries += 1;
      try {
        return await operation(workspaceDir);
      } finally {
        gateHeld = false;
      }
    };

    const projectAttachments = new ProjectAwareAttachmentStore(
      hostAttachments,
      routeDeps.projectsManager,
      async () => {},
    );
    routeDeps.attachmentStore = projectAttachments;
    let branchId = null;
    const originalClone = projectAttachments.cloneForBranchInProjectWorkspace.bind(projectAttachments);
    projectAttachments.cloneForBranchInProjectWorkspace = async (...args) => {
      branchId = args[1].id;
      return originalClone(...args);
    };
    const cleanupContexts = [];
    const teardown = new SessionTeardownRegistry();
    teardown.register('chat-log', (session) => store.deleteChat(session));
    teardown.register('chat-attachments', (session, context) => {
      cleanupContexts.push(context);
      return projectAttachments.deleteSessionAttachments(session, {
        projectLifecycleExclusive: context?.projectLifecycleExclusive,
      });
    });
    routeDeps.sessionTeardown = teardown;

    const originalAppend = store.append.bind(store);
    store.append = async (ref, branchEvents) => {
      await originalAppend(ref, branchEvents);
      if (ref.id !== source.id) throw new Error('injected append failure after project clone');
    };
    const admissionsBefore = projectEnsures.length;

    const made = await branch(source.id, 'turn-1');

    assert.strictEqual(made.status, 500, JSON.stringify(made.body));
    assert.strictEqual(made.body.error, 'branch_failed');
    assert.strictEqual(made.body.recoveryPending, undefined, 'complete rollback needs no recovery marker');
    assert.ok(branchId);
    assert.strictEqual(gateEntries, 1, 'one lifecycle gate covers clone, writes, and rollback');
    assert.strictEqual(nestedEntries, 0, 'rollback identifies the already-exclusive project context');
    assert.deepStrictEqual(cleanupContexts, [{ projectLifecycleExclusive: true }]);
    assert.strictEqual(projectEnsures.length, admissionsBefore, 'rollback does not start the project runtime');
    assert.strictEqual(
      fs.existsSync(path.join(
        workspaceDir,
        '.cc-web',
        'attachments',
        source.storageScope.ownerKey,
        branchId,
      )),
      false,
      'the cloned attachment namespace is removed before the gate is released',
    );
  });

  // The window the history above was just measured against is the source's
  // model, and a source running on the profile's model carries no override to
  // copy. Left blank the branch is a conversation that has never chatted, so
  // its launch would take the brancher's *standing* model (#135) — a different
  // model from the one the estimate was computed for.
  //
  // Restated: this asserted the pin landed on `chatModelOverride`, which the
  // adversarial review caught as two defects in one. An override is something
  // the *user* said, so the branch's picker would report a model nobody chose
  // as "chosen for this conversation" and offer a clear that wipes the account's
  // standing choice with it. And reading the profile is the wrong question
  // anyway — see the test below, where the source never ran on the profile.
  it('pins a branch of a profile-defaulted conversation to that profile’s model', async function () {
    activeProfile = { profileName: 'House', model: 'profile-model' };
    await record('source', conversation({ turns: 2, contextWindow: 200_000 }));

    const made = await branch('source', 'turn-1');
    const branched = sessions.get(made.body.sessionId);

    assert.strictEqual(branched.chatModelPinned, 'profile-model');
    assert.strictEqual(
      branched.chatModelOverride,
      undefined,
      'nobody chose this model, so the picker must not report it as a choice',
    );
  });

  // The half the profile lookup could never answer. A source launched on the
  // account's standing choice ran on *that*, not on the profile — and the
  // profile is what the old code copied, so the branch opened on a different
  // model from the one its carried history had just been measured against.
  it('pins a branch to the model its source actually ran, not to the profile', async function () {
    activeProfile = { profileName: 'House', model: 'profile-model' };
    await record('source', conversation({ turns: 2, contextWindow: 200_000 }));
    // What a launch leaves behind: this source opened on the account's standing
    // choice, which outranks the profile.
    sessions.get('source').chatModelPinned = 'claude-opus-4-6';

    const made = await branch('source', 'turn-1');

    assert.strictEqual(sessions.get(made.body.sessionId).chatModelPinned, 'claude-opus-4-6');
  });

  // A source that ran bare is an answer too, and one the profile must not be
  // allowed to overwrite: the branch inherits "no model flag at all".
  it('carries a source that launched with no model flag as exactly that', async function () {
    activeProfile = { profileName: 'House', model: 'profile-model' };
    await record('source', conversation({ turns: 2, contextWindow: 200_000 }));
    sessions.get('source').chatModelPinned = null;

    const made = await branch('source', 'turn-1');

    assert.strictEqual(sessions.get(made.body.sessionId).chatModelPinned, null);
  });

  it('leaves a branch unpinned when there is no profile either, so the runtime still decides', async function () {
    await record('source', conversation({ turns: 2, contextWindow: 200_000 }));

    const made = await branch('source', 'turn-1');
    const branched = sessions.get(made.body.sessionId);

    assert.strictEqual(branched.chatModelOverride, undefined);
    assert.strictEqual(branched.chatModelPinned, undefined);
  });

  // What the record holds is only half of it. A branch used to *always* ask,
  // whatever the source was doing and whatever the preference said, because
  // nothing consulted the preference at the launch either (#134). Proved here at
  // the launch rather than at the record, because that is where the mode is
  // decided and where the user meets it.
  it('opens in the mode the preference names, whichever the source was in', async function () {
    await record('source', conversation({ turns: 2 }), 'Refactoring the parser');
    sessions.get('source').chatBypassPermissions = true;

    const made = await branch('source', 'turn-1');
    const branched = sessions.get(made.body.sessionId);

    // The launch the browser sends for a branch: it names no mode at all, and
    // deliberately no resume either — see mount.tsx's openBranch.
    const asking = launcherFor(sessions, branched.id, false);
    await asking.processor.startChat('ws-1', 'claude', {}, branched.id);
    assert.strictEqual(
      asking.chatManager.calls.start[0].options.bypassPermissions,
      false,
      'the source conversation’s bypass must not travel with a branch',
    );

    branched.active = false;
    branched.chatBypassPermissions = undefined;
    const bypassing = launcherFor(sessions, branched.id, true);
    await bypassing.processor.startChat('ws-1', 'claude', {}, branched.id);
    assert.strictEqual(
      bypassing.chatManager.calls.start[0].options.bypassPermissions,
      true,
      'a branch is a conversation beginning, so the preference reaches it',
    );
  });

  it('closes a turn the source never finished, so the branch’s own first ask opens one', async function () {
    // The most natural branch there is: the agent is going the wrong way, so
    // you branch from the turn it is still working on. Carried open, that turn
    // stays open in the branch — and the rule the index and the reducer share
    // hands the branch's own first question to it, with no header, no row and
    // the source's question as its label.
    const events = conversation({ turns: 2, contextWindow: 200_000 });
    const unfinished = events.filter(
      (event) => !(event.t === 'turn_end' && event.turnId === 'turn-2'),
    );
    await record('source', unfinished);

    const made = await branch('source', 'turn-2');
    assert.strictEqual(made.status, 200, JSON.stringify(made.body));

    const carried = await eventsOf(made.body.sessionId);
    const ends = carried.filter((event) => event.t === 'turn_end' && event.turnId === 'turn-2');
    assert.strictEqual(ends.length, 1, 'the carried turn was left open');
    assert.ok(
      carried.indexOf(ends[0]) < carried.findIndex((event) => event.t === 'marker'),
      'and it has to close above the rule, or the rule is inside it',
    );
    assert.strictEqual(
      ends[0].usage,
      undefined,
      'nothing was measured about a turn this conversation did not run',
    );
  });

  it('carries the effort the source was running, not just its model', async function () {
    await record('source', conversation({ turns: 2, contextWindow: 200_000 }));
    sessions.get('source').chatEffortOverride = 'high';

    const made = await branch('source', 'turn-2');

    assert.strictEqual(
      sessions.get(made.body.sessionId).chatEffortOverride,
      'high',
      'the window the history was just measured against is that model at that level',
    );
  });

  it('refuses a turn that is not in this conversation', async function () {
    await record('source', conversation({ turns: 2, contextWindow: 200_000 }));

    const made = await branch('source', 'turn-9');
    assert.strictEqual(made.status, 404);
    assert.strictEqual(sessions.size, 1, 'nothing was created');
  });

  // ------------------------------------------------------- the size check

  it('refuses a history too large for the model’s window rather than trimming it', async function () {
    // A 4,000-token window leaves 2,000 for the history; four turns of padded
    // prose is several times that.
    await record('source', conversation({ turns: 4, contextWindow: 4_000, padding: 400 }));

    const made = await branch('source', 'turn-4');

    assert.strictEqual(made.status, 413, JSON.stringify(made.body));
    assert.strictEqual(made.body.error, 'context_too_large');
    assert.ok(/4,000-token window/.test(made.body.message), made.body.message);
    assert.ok(/earlier turn/.test(made.body.message), made.body.message);
    assert.strictEqual(sessions.size, 1, 'a refused branch creates nothing');
  });

  it('branches from an earlier turn that does fit, which is what the refusal asks for', async function () {
    await record('source', conversation({ turns: 4, contextWindow: 40_000, padding: 400 }));

    const made = await branch('source', 'turn-1');
    assert.strictEqual(made.status, 200, JSON.stringify(made.body));
    assert.strictEqual(made.body.sizeChecked, true);
    assert.strictEqual(made.body.contextWindow, 40_000);
  });

  it('says plainly when nobody reported a window, instead of measuring against a guess', async function () {
    await record('source', conversation({ turns: 3 }));

    const made = await branch('source', 'turn-3');

    assert.strictEqual(made.status, 200, JSON.stringify(made.body));
    assert.strictEqual(made.body.sizeChecked, false);
    assert.strictEqual(made.body.contextWindow, undefined);

    const events = await eventsOf(made.body.sessionId);
    const marker = events[events.length - 1];
    assert.ok(
      /size not checked/.test(marker.detail),
      `the transcript says so too, not just the reply: ${marker.detail}`,
    );
  });

  // --------------------------------------------- what the agent is handed

  it('hands the carried history to the agent with the first turn, and records only what the user typed', async function () {
    await record('source', conversation({ turns: 3, contextWindow: 200_000 }));
    const made = await branch('source', 'turn-2');
    const sessionId = made.body.sessionId;

    const sent = [];
    const session = new ChatSession(
      { id: sessionId, ownerUserId: USER.id },
      {
        store,
        socketDir: storageDir,
        hookScript: path.join(__dirname, '..', 'does-not-exist.js'),
        broadcast: () => {},
        resolveCommand: () => 'claude',
      },
    );
    session.adapter = {
      alive: true,
      async send(turn) {
        sent.push(turn);
      },
      async interrupt() {},
      respondPermission() {},
      async stop() {},
    };
    session.state = 'idle';
    // What `start()` would have set: numbering continues after the carried log.
    session.seq = (await store.stat({ id: sessionId, ownerUserId: USER.id })).cursor;

    await session.send({ text: 'now do the next bit' });

    assert.strictEqual(sent.length, 1);
    const delivered = sent[0].text;
    assert.ok(/question 1/.test(delivered), 'the agent is told what was asked before');
    assert.ok(/answer 2/.test(delivered), 'and what was answered, up to the branch point');
    assert.ok(!/question 3/.test(delivered), 'and nothing from after the branch point');
    assert.ok(
      /You were not in it/.test(delivered),
      'and that it was not there for any of it, so it cannot answer for work it never did',
    );
    assert.ok(!/REASONING-1/.test(delivered), 'reasoning is not carried');
    assert.ok(!/TOOL-OUTPUT-1/.test(delivered), 'nor is tool output');
    assert.ok(/ran step 1/.test(delivered), 'though the calls themselves are named');
    assert.ok(
      delivered.endsWith('now do the next bit'),
      'and the thing actually being asked comes last',
    );

    // What the transcript kept is the user's own message and nothing else: a
    // wall of quoted history standing in the conversation as their words would
    // be the same lie in the other direction.
    const events = await eventsOf(sessionId);
    const typed = events.filter(
      (event) => event.t === 'block_start' && event.block.kind === 'text' && /next bit/.test(event.block.text),
    );
    assert.strictEqual(typed.length, 1);
    assert.strictEqual(typed[0].block.text, 'now do the next bit');
    assert.ok(
      !events.some((event) => JSON.stringify(event).includes('You were not in it')),
      'the briefing is not written into the record as something anybody said',
    );

    // Once, not on every turn afterwards. Idle again first: a delivery leaves
    // the session thinking, and a second turn would otherwise take its place in
    // the queue instead of going out.
    session.state = 'idle';
    await session.send({ text: 'and now this' });
    assert.strictEqual(sent.length, 2);
    assert.strictEqual(sent[1].text, 'and now this');
    assert.strictEqual(
      await store.openingContext({ id: sessionId, ownerUserId: USER.id }),
      null,
      'the context is consumed by the turn that carried it',
    );

    // Drains the store's queue: recording a turn is fire-and-forget by design,
    // and a write still in flight when the temp directory goes fails loudly for
    // no reason anybody should have to read.
    await store.stat({ id: sessionId, ownerUserId: USER.id });
  });

  it('keeps the carried history across a restart, until it has been handed over', async function () {
    await record('source', conversation({ turns: 2, contextWindow: 200_000 }));
    const made = await branch('source', 'turn-1');
    const ref = { id: made.body.sessionId, ownerUserId: USER.id };

    // A second store over the same directory is what a server restart looks
    // like from here: nothing in memory, everything on disk.
    const restarted = new ChatStore({ storageDir });
    const context = await restarted.openingContext(ref);
    assert.ok(context && /question 1/.test(context), 'the branch is still waiting to be told');

    await restarted.clearOpeningContext(ref);
    assert.strictEqual(await restarted.openingContext(ref), null);
  });
});
