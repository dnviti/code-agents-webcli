const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { SessionStore } = require('../dist/server/services/session-store.js');
const { UsageStore } = require('../dist/server/services/usage-store.js');
const { ChatStore } = require('../dist/server/chat/store.js');
const { HistoryStore } = require('../dist/server/services/history-store.js');
const { TranscriptStore } = require('../dist/server/services/transcript-store.js');
const { PasteStore } = require('../dist/server/services/paste-store.js');
const { AttachmentStore } = require('../dist/server/services/attachment-store.js');
const {
  closeWorkspaceSessionDirectoryLeases,
} = require('../dist/server/services/workspace-session-storage.js');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function record(scope, id) {
  const now = new Date();
  return {
    id,
    ownerUserId: 41,
    name: 'Local host session',
    created: now,
    lastActivity: now,
    active: false,
    agent: null,
    lastAgent: null,
    runtimeLabel: null,
    terminalOptions: null,
    stopRequested: false,
    workingDir: scope.workspaceRoot,
    connections: new Set(),
    outputBuffer: [],
    sessionStartTime: null,
    sessionUsage: { requests: 1, inputTokens: 2, outputTokens: 3, cacheTokens: 0, totalCost: 0, models: {} },
    maxBufferSize: 1000,
    surface: 'chat',
    storageScope: scope,
    projectId: undefined,
    projectWorkingDirKind: undefined,
  };
}

function filesBelow(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else out.push(file);
    }
  };
  walk(root);
  return out;
}

function assertInstallationHasOnlyItsOwnDatabase(root) {
  assert.ok(
    filesBelow(root).every((file) => path.dirname(file) === root && path.basename(file).startsWith('app.sqlite')),
    'the installation directory must contain no scoped session artefact',
  );
}

function assertBelowWorkspaceArchive(workspace, candidate, label) {
  const archive = path.join(workspace, '.cc-web');
  const relative = path.relative(archive, path.resolve(candidate));
  assert.ok(
    relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    `${label} must be below workspace .cc-web: ${candidate}`,
  );
}

describe('scoped host-session durable artifact locality', function () {
  let workspace;
  let installationData;
  let scope;
  let session;
  let store;

  beforeEach(function () {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-local-workspace-'));
    installationData = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-install-data-'));
    scope = { workspaceRoot: workspace, ownerKey: 'a'.repeat(64) };
    session = record(scope, 'host-local');
    store = new SessionStore({ dataDir: installationData, workspaceCoordinator: true });
  });

  afterEach(function () {
    try { store.closeWorkspaces(); } catch { /* an assertion may have closed it */ }
    closeWorkspaceSessionDirectoryLeases();
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(installationData, { recursive: true, force: true });
  });

  it('keeps session, chat, terminal, paste, attachment, and branch artifacts below workspace/.cc-web', async function () {
    assert.strictEqual(await store.saveSessions(new Map([[session.id, session]])), true);
    const localDatabase = path.join(workspace, '.cc-web', 'session-state.sqlite');
    assert.ok(fs.existsSync(localDatabase));
    assert.strictEqual(store.database.raw.prepare('SELECT COUNT(*) AS n FROM runtime_sessions').get().n, 0);

    const bound = store.openWorkspace(scope);
    assert.strictEqual(bound.database.raw.prepare('SELECT COUNT(*) AS n FROM runtime_sessions').get().n, 1);
    new UsageStore({ database: bound.database, ownerKey: scope.ownerKey }).record({
      sessionId: session.id, nativeSessionId: null, turnId: 'turn-1', userId: 41, userLogin: 'local',
      agent: 'codex', model: 'gpt', project: null, startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:01.000Z', durationMs: 1000, outcome: 'completed', modelTurns: 1,
      toolCalls: 0, inputTokens: 2, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0,
      reasoningTokens: 0, totalTokens: 5, costUsd: 0.01, reportsUsage: true, reportsCost: true, tools: [], models: [],
    });
    assert.strictEqual(bound.database.raw.prepare('SELECT COUNT(*) AS n FROM usage_jobs').get().n, 1);

    const chat = new ChatStore({ storageDir: installationData });
    chat.append(session, [{ t: 'state', seq: 1, ts: 1, state: 'idle' }]);
    await chat.stat(session);
    await chat.setOpeningContext(session, 'branch opening context');
    await chat.setPlanDocument(session, { markdown: '# Local plan', revision: 1, ts: 2 });

    const history = new HistoryStore({ storageDir: installationData });
    history.append(session, ['terminal line']);
    await history.stat(session);
    const transcript = new TranscriptStore({ storageDir: installationData });
    transcript.appendOutput(session, 'transcript bytes');
    await transcript.readTranscriptChunks(session);

    const pastes = new PasteStore({ storageDir: installationData, randomId: () => 'paste-local' });
    const pasted = await pastes.save(session, PNG);
    const attachments = new AttachmentStore({ randomId: () => 'abcdef012345' });
    const attachment = await attachments.save(session, {
      filename: 'note.txt', declaredMime: 'text/plain', bytes: Buffer.from('attachment bytes'),
    });
    const branch = record(scope, 'host-local-branch');
    const copied = await attachments.cloneForBranch(session, branch, {
      kind: 'attachment', url: `/api/sessions/${session.id}/chat-attachments/${attachment.storedName}`,
      name: attachment.name, mime: attachment.mime, size: attachment.bytes,
    });

    assertBelowWorkspaceArchive(workspace, pasted.absolutePath, 'pasted image');
    assertBelowWorkspaceArchive(workspace, attachment.absolutePath, 'attachment');
    assertBelowWorkspaceArchive(workspace, copied.path, 'branch attachment copy');

    const root = path.join(workspace, '.cc-web');
    const sessionDir = path.join(root, 'sessions', scope.ownerKey, session.id);
    for (const file of [
      localDatabase, `${path.join(sessionDir, 'chat')}.jsonl`, `${path.join(sessionDir, 'chat')}.idx`,
      `${path.join(sessionDir, 'chat')}.ctx`, `${path.join(sessionDir, 'chat')}.plan`,
      `${path.join(sessionDir, 'history')}.log`, `${path.join(sessionDir, 'history')}.idx`,
      path.join(sessionDir, 'transcript.md'), path.join(sessionDir, 'paste-manifest.json'), pasted.absolutePath,
      attachment.absolutePath, copied.path,
    ]) assert.ok(fs.existsSync(file), `durable artifact is local: ${file}`);
    assertInstallationHasOnlyItsOwnDatabase(installationData);

    await chat.deleteChat(session);
    await history.deleteHistory(session);
    await transcript.deleteTranscript(session);
    await pastes.deletePastes(session);
    await attachments.deleteSessionAttachments(session);
    await attachments.deleteSessionAttachments(branch);
    for (const file of [
      `${path.join(sessionDir, 'chat')}.jsonl`, `${path.join(sessionDir, 'chat')}.idx`,
      `${path.join(sessionDir, 'chat')}.ctx`, `${path.join(sessionDir, 'chat')}.plan`,
      `${path.join(sessionDir, 'history')}.log`, `${path.join(sessionDir, 'history')}.idx`,
      path.join(sessionDir, 'transcript.md'), path.join(sessionDir, 'paste-manifest.json'), pasted.absolutePath,
      attachment.absolutePath, copied.path,
    ]) assert.ok(!fs.existsSync(file), `cleanup removes local artifact: ${file}`);
  });

  it('does not fall back to installation persistence when opening a scoped workspace fails', async function () {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-local-outside-'));
    try {
      fs.symlinkSync(outside, path.join(workspace, '.cc-web'));
      assert.strictEqual(await store.saveSessions(new Map([[session.id, session]])), false);
      assert.strictEqual(store.database.raw.prepare('SELECT COUNT(*) AS n FROM runtime_sessions').get().n, 0);
      assertInstallationHasOnlyItsOwnDatabase(installationData);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects every scoped artifact writer without creating an installation fallback', async function () {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-local-outside-'));
    const failure = /workspace|unsafe|symlink|directory|component/i;
    try {
      fs.symlinkSync(outside, path.join(workspace, '.cc-web'));
      const chat = new ChatStore({ storageDir: installationData });
      const history = new HistoryStore({ storageDir: installationData });
      const transcript = new TranscriptStore({ storageDir: installationData });
      const pastes = new PasteStore({ storageDir: installationData, randomId: () => 'paste-rejected' });
      const attachments = new AttachmentStore({ randomId: () => 'abcdef012346' });
      const branch = record(scope, 'host-local-branch-rejected');
      const source = record({ workspaceRoot: outside, ownerKey: scope.ownerKey }, 'host-local-branch-source');

      await assert.rejects(
        chat.append(session, [{ t: 'state', seq: 1, ts: 1, state: 'idle' }]),
        failure,
      );
      history.append(session, ['must not persist']);
      await assert.rejects(history.flush(session), failure);
      assert.throws(() => transcript.appendOutput(session, 'must not persist'), failure);
      await assert.rejects(transcript.flush(session), failure);
      await assert.rejects(pastes.save(session, PNG), failure);
      await assert.rejects(attachments.save(session, {
        filename: 'must-not-persist.txt', declaredMime: 'text/plain', bytes: Buffer.from('must not persist'),
      }), failure);
      const sourceAttachment = await attachments.save(source, {
        filename: 'must-not-clone.txt', declaredMime: 'text/plain', bytes: Buffer.from('source bytes'),
      });
      await assert.rejects(attachments.cloneForBranch(source, branch, {
        kind: 'attachment',
        url: `/api/sessions/${source.id}/chat-attachments/${sourceAttachment.storedName}`,
        name: sourceAttachment.name, mime: sourceAttachment.mime, size: sourceAttachment.bytes,
      }), failure);
      assertInstallationHasOnlyItsOwnDatabase(installationData);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
