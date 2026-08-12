const assert = require('assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { TranscriptStore } = require('../dist/server/services/transcript-store.js');
const safeSessionFiles = require('../dist/server/services/safe-session-file.js');

describe('TranscriptStore', function() {
  let tempDir;
  let transcriptStore;
  let session;

  beforeEach(async function() {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'code-agents-webcli-transcript-'));
    transcriptStore = new TranscriptStore({ storageDir: tempDir, replayChunkSize: 8 });
    session = {
      id: 'session-1',
      ownerUserId: 42,
    };
  });

  afterEach(async function() {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('creates a dedicated markdown transcript and appends output', async function() {
    const transcriptPath = await transcriptStore.ensureTranscript(session);

    assert.strictEqual(path.extname(transcriptPath), '.md');

    transcriptStore.appendOutput(session, 'hello ');
    transcriptStore.appendOutput(session, 'world');

    await transcriptStore.readTranscriptChunks(session);
    const contents = await fs.readFile(transcriptPath, 'utf8');
    assert.strictEqual(contents, 'hello world');
  });

  it('returns transcript contents in replay chunks', async function() {
    transcriptStore.appendOutput(session, 'abcdefghijk');

    const chunks = await transcriptStore.readTranscriptChunks(session);
    assert.deepStrictEqual(chunks, ['abcdefgh', 'ijk']);
  });

  it('deletes a session transcript', async function() {
    const transcriptPath = await transcriptStore.ensureTranscript(session);
    transcriptStore.appendOutput(session, 'persist me');

    await transcriptStore.deleteTranscript(session);

    const exists = await fs.access(transcriptPath).then(() => true).catch(() => false);
    assert.strictEqual(exists, false);
  });

  it('keeps a failed append visible to lifecycle flush until a later write succeeds', async function() {
    const transcriptPath = await transcriptStore.ensureTranscript(session);
    const originalAppendFile = safeSessionFiles.appendSessionFile;
    let injected = false;
    safeSessionFiles.appendSessionFile = async function(file, ...args) {
      if (!injected && String(file) === transcriptPath) {
        injected = true;
        throw new Error('injected transcript append failure');
      }
      return originalAppendFile(file, ...args);
    };

    try {
      transcriptStore.appendOutput(session, 'lost');
      await assert.rejects(
        () => transcriptStore.flush(session),
        /injected transcript append failure/,
      );
    } finally {
      safeSessionFiles.appendSessionFile = originalAppendFile;
    }

    assert.strictEqual(injected, true);
    transcriptStore.appendOutput(session, 'kept');
    await assert.doesNotReject(() => transcriptStore.flush(session));
    assert.strictEqual(await fs.readFile(transcriptPath, 'utf8'), 'kept');
  });

  it('refuses a workspace root reached through a symlink', async function() {
    const target = path.join(tempDir, 'real-workspace');
    const link = path.join(tempDir, 'workspace-link');
    await fs.mkdir(target);
    await fs.symlink(target, link);

    await assert.rejects(
      () => transcriptStore.ensureTranscript({ ...session, storageRoot: link, ownerKey: 'owner' }),
      /symlink/i,
    );
    assert.ok(!(await fs.readdir(target)).includes('.cc-web'));
  });

  it('leaves an existing nested workspace .gitignore unchanged', async function() {
    const custom = '# mine\n!keep\n';
    const container = path.join(tempDir, '.cc-web');
    await fs.mkdir(container);
    await fs.writeFile(path.join(container, '.gitignore'), custom);
    const local = { ...session, storageRoot: tempDir, ownerKey: 'owner' };

    const transcriptPath = await transcriptStore.ensureTranscript(local);
    assert.strictEqual(transcriptPath, path.join(container, 'sessions', 'owner', session.id, 'transcript.md'));
    assert.strictEqual(await fs.readFile(path.join(container, '.gitignore'), 'utf8'), custom);
  });
});
