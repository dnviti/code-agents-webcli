const assert = require('assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { TranscriptStore } = require('../dist/server/services/transcript-store.js');

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
});
