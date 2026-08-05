const assert = require('assert');
const { createHash } = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MAX_MIGRATION_MARKER_ARTIFACTS,
  WorkspaceSessionArtifactMigrator,
} = require('../dist/server/services/workspace-session-migrator.js');
const {
  closeWorkspaceSessionDirectoryLease,
  workspaceDescriptorRoot,
} = require('../dist/server/services/workspace-session-storage.js');

describe('WorkspaceSessionArtifactMigrator', function () {
  let root;
  let legacy;
  let workspace;
  let ref;

  const owner = '41';
  const sessionId = 'session-a';
  const ownerKey = 'owner-hash';

  const artifactPaths = () => ({
    chat_log: [`${path.join(legacy, owner, sessionId)}.jsonl`, 'chat.jsonl'],
    chat_index: [`${path.join(legacy, owner, sessionId)}.idx`, 'chat.idx'],
    chat_snapshot: [`${path.join(legacy, owner, sessionId)}.snapshot`, 'chat.snapshot'],
    chat_snapshot_json: [`${path.join(legacy, owner, sessionId)}.snapshot.json`, 'chat.snapshot.json'],
    chat_opening_context: [`${path.join(legacy, owner, sessionId)}.ctx`, 'chat.ctx'],
    chat_plan: [`${path.join(legacy, owner, sessionId)}.plan`, 'chat.plan'],
    transcript: [`${path.join(legacy, 'transcripts', owner, sessionId)}.md`, 'transcript.md'],
    history_log: [`${path.join(legacy, 'history', owner, sessionId)}.log`, 'history.log'],
    history_index: [`${path.join(legacy, 'history', owner, sessionId)}.idx`, 'history.idx'],
    paste_manifest: [`${path.join(legacy, 'pastes', owner, sessionId)}.json`, 'paste-manifest.json'],
  });

  const sessionDir = () => path.join(
    workspace,
    '.cc-web',
    'sessions',
    ownerKey,
    sessionId,
  );

  beforeEach(function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccweb-artifact-migrate-'));
    legacy = path.join(root, 'legacy');
    workspace = path.join(root, 'workspace');
    fs.mkdirSync(legacy);
    fs.mkdirSync(workspace);
    ref = {
      id: sessionId,
      ownerUserId: Number(owner),
      storageScope: { workspaceRoot: workspace, ownerKey },
    };
  });

  afterEach(function () {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeLegacy(artifact, contents) {
    const [source] = artifactPaths()[artifact];
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, contents);
    return source;
  }

  it('moves every supported legacy artifact byte-for-byte into the workspace session directory', async function () {
    const expected = new Map();
    let index = 0;
    for (const artifact of Object.keys(artifactPaths())) {
      const contents = artifact === 'paste_manifest'
        ? Buffer.from('{"version":1,"entries":[]}')
        : artifact.includes('index')
        ? Buffer.from([0, 255, index, 128, 10])
        : Buffer.from(`${artifact}\n${'x'.repeat(index + 1)}`);
      expected.set(artifact, contents);
      writeLegacy(artifact, contents);
      index += 1;
    }

    const result = await new WorkspaceSessionArtifactMigrator({
      legacyStorageDir: legacy,
    }).migrate(ref);

    assert.strictEqual(result.status, 'complete');
    assert.deepStrictEqual(result.artifacts.map((entry) => entry.state), Array(10).fill('migrated'));
    for (const entry of result.artifacts) {
      const [source, targetName] = artifactPaths()[entry.artifact];
      const target = path.join(sessionDir(), targetName);
      assert.deepStrictEqual(fs.readFileSync(target), expected.get(entry.artifact));
      assert.strictEqual(fs.existsSync(source), false, `${entry.artifact} source survived verification`);
      if (process.platform !== 'win32') {
        assert.strictEqual(fs.statSync(target).mode & 0o777, 0o600);
      }
      assert.strictEqual(entry.bytes, expected.get(entry.artifact).length);
      assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    }
    assert.deepStrictEqual(
      fs.readdirSync(sessionDir()).filter((name) => name.includes('.ccweb-migrate-')),
      [],
    );
  });

  it('is idempotent after a complete run and recognises verified targets', async function () {
    for (const artifact of Object.keys(artifactPaths())) {
      writeLegacy(
        artifact,
        artifact === 'paste_manifest'
          ? Buffer.from('{"version":1,"entries":[]}')
          : Buffer.from(`contents:${artifact}`),
      );
    }
    const migrator = new WorkspaceSessionArtifactMigrator({ legacyStorageDir: legacy });
    assert.strictEqual((await migrator.migrate(ref)).status, 'complete');

    const second = await migrator.migrate(ref);
    assert.strictEqual(second.status, 'complete');
    assert.deepStrictEqual(
      second.artifacts.map((entry) => entry.state),
      Array(10).fill('already_migrated'),
    );
  });

  it('retires a confirmed marker once and ignores later live artifact mutations', async function () {
    writeLegacy('chat_log', Buffer.from('{"seq":1}\n'));
    const migrator = new WorkspaceSessionArtifactMigrator({ legacyStorageDir: legacy });
    assert.strictEqual((await migrator.migrate(ref)).status, 'complete');

    const marker = path.join(sessionDir(), '.legacy-artifact-migration.v1.json');
    const target = path.join(sessionDir(), 'chat.jsonl');
    assert.strictEqual(fs.existsSync(marker), true);

    await migrator.confirm(ref);
    assert.strictEqual(fs.existsSync(marker), false, 'confirmation atomically retires its marker');

    fs.appendFileSync(target, '{"seq":2}\n');
    await migrator.confirm(ref);
    await new WorkspaceSessionArtifactMigrator({ legacyStorageDir: legacy }).confirm(ref);
    assert.strictEqual(
      fs.readFileSync(target, 'utf8'),
      '{"seq":1}\n{"seq":2}\n',
      'an idempotent confirm must not compare live bytes with stale migration fingerprints',
    );
  });

  it('resumes after publish by verifying the target before deleting the source', async function () {
    const contents = Buffer.from('published-but-not-cleaned-up');
    const source = writeLegacy('chat_log', contents);
    fs.mkdirSync(sessionDir(), { recursive: true });
    const target = path.join(sessionDir(), 'chat.jsonl');
    fs.writeFileSync(target, contents);

    const result = await new WorkspaceSessionArtifactMigrator({ legacyStorageDir: legacy }).migrate(ref);
    const chat = result.artifacts.find((entry) => entry.artifact === 'chat_log');
    assert.strictEqual(result.status, 'complete');
    assert.strictEqual(chat.state, 'migrated');
    assert.strictEqual(fs.existsSync(source), false);
    assert.deepStrictEqual(fs.readFileSync(target), contents);
  });

  it('fsyncs published names and every source, backup, and marker unlink across a power-loss retry', async function () {
    const contents = Buffer.from('durable across directory-entry power loss');
    const source = writeLegacy('chat_log', contents);
    const observed = [];
    let interrupted = false;
    const crashing = new WorkspaceSessionArtifactMigrator({
      legacyStorageDir: legacy,
      hooks: {
        afterDirectorySync(event) {
          observed.push(event);
          if (!interrupted && event.reason === 'source_unlink') {
            interrupted = true;
            throw new Error('simulated power loss after source directory fsync');
          }
        },
      },
    });

    const first = await crashing.migrate(ref);
    assert.strictEqual(interrupted, true);
    assert.strictEqual(first.status, 'blocked');
    assert.deepStrictEqual(fs.readFileSync(source), contents, 'rollback restores the durable source');
    assert.ok(observed.some((event) => event.reason === 'publish'));
    assert.ok(observed.some((event) => event.reason === 'marker_publish'));
    assert.ok(observed.some((event) => event.reason === 'source_unlink'));

    const resumedEvents = [];
    const resumed = new WorkspaceSessionArtifactMigrator({
      legacyStorageDir: legacy,
      hooks: {
        afterDirectorySync(event) { resumedEvents.push(event); },
      },
    });
    assert.strictEqual((await resumed.migrate(ref)).status, 'complete');
    await resumed.confirm(ref);
    const allEvents = [...observed, ...resumedEvents];
    for (const reason of [
      'publish',
      'quarantine_publish',
      'source_unlink',
      'backup_unlink',
      'marker_publish',
      'marker_unlink',
    ]) {
      assert.ok(
        allEvents.some((event) => event.reason === reason),
        `missing directory fsync for ${reason}`,
      );
    }
    const descriptorRoot = workspaceDescriptorRoot();
    if (descriptorRoot) {
      for (const reason of ['source_unlink', 'backup_unlink']) {
        assert.ok(
          allEvents.some((event) => (
            event.reason === reason
            && /^[0-9]+$/.test(path.relative(descriptorRoot, event.directory))
          )),
          `${reason} did not fsync its already-pinned directory descriptor`,
        );
      }
    }
    assert.strictEqual(fs.existsSync(source), false);
  });

  it('recovers the exact two-link temp state left by a crash during publication', async function () {
    const contents = Buffer.from('crash between link and unlink');
    const source = writeLegacy('chat_log', contents);
    const originalUnlink = fs.promises.unlink;
    const originalRm = fs.promises.rm;
    const isChatPublishTemp = (target) => (
      path.basename(String(target)).startsWith('.chat.jsonl.ccweb-migrate-')
      && path.basename(String(target)).endsWith('.tmp')
    );
    let injected = false;
    fs.promises.unlink = async function (target) {
      if (isChatPublishTemp(target)) {
        injected = true;
        const error = new Error('simulated process crash before unlink');
        error.code = 'EIO';
        throw error;
      }
      return originalUnlink.call(this, target);
    };
    fs.promises.rm = async function (target, options) {
      if (isChatPublishTemp(target)) {
        const error = new Error('simulated process exit skipped finally cleanup');
        error.code = 'EIO';
        throw error;
      }
      return originalRm.call(this, target, options);
    };

    const migrator = new WorkspaceSessionArtifactMigrator({ legacyStorageDir: legacy });
    let interrupted;
    try {
      interrupted = await migrator.migrate(ref);
    } finally {
      fs.promises.unlink = originalUnlink;
      fs.promises.rm = originalRm;
    }

    assert.strictEqual(injected, true);
    assert.strictEqual(interrupted.status, 'blocked');
    const target = path.join(sessionDir(), 'chat.jsonl');
    const crashTemps = fs.readdirSync(sessionDir()).filter(isChatPublishTemp);
    assert.strictEqual(crashTemps.length, 1);
    assert.strictEqual(fs.statSync(target).nlink, 2);
    assert.strictEqual(fs.statSync(path.join(sessionDir(), crashTemps[0])).ino, fs.statSync(target).ino);
    assert.deepStrictEqual(fs.readFileSync(source), contents);

    const resumed = await migrator.migrate(ref);
    assert.strictEqual(resumed.status, 'complete');
    assert.strictEqual(fs.existsSync(source), false);
    assert.strictEqual(fs.statSync(target).nlink, 1);
    assert.deepStrictEqual(fs.readFileSync(target), contents);
    assert.deepStrictEqual(fs.readdirSync(sessionDir()).filter(isChatPublishTemp), []);
  });

  it('keeps the source when a matching target has an unrecognised hard link', async function () {
    const contents = Buffer.from('same bytes do not make an arbitrary hard link safe');
    const source = writeLegacy('chat_log', contents);
    fs.mkdirSync(sessionDir(), { recursive: true });
    const outsideLink = path.join(root, 'outside-copy');
    const target = path.join(sessionDir(), 'chat.jsonl');
    fs.writeFileSync(outsideLink, contents);
    fs.linkSync(outsideLink, target);

    const result = await new WorkspaceSessionArtifactMigrator({ legacyStorageDir: legacy }).migrate(ref);
    assert.deepStrictEqual(
      result.artifacts.find((entry) => entry.artifact === 'chat_log'),
      { artifact: 'chat_log', state: 'blocked', reason: 'unsafe_target' },
    );
    assert.deepStrictEqual(fs.readFileSync(source), contents);
    assert.strictEqual(fs.statSync(target).nlink, 2);
    assert.strictEqual(fs.statSync(outsideLink).nlink, 2);
  });

  it('never cuts over a three-link target even when one sibling looks like a crash temp', async function () {
    const contents = Buffer.from('ambiguous target must remain blocked');
    const source = writeLegacy('chat_log', contents);
    fs.mkdirSync(sessionDir(), { recursive: true });
    const target = path.join(sessionDir(), 'chat.jsonl');
    const controlledTemp = path.join(
      sessionDir(),
      `.chat.jsonl.ccweb-migrate-${process.pid}-${'a'.repeat(16)}.tmp`,
    );
    const outsideLink = path.join(root, 'third-link');
    fs.writeFileSync(target, contents);
    fs.linkSync(target, controlledTemp);
    fs.linkSync(target, outsideLink);

    const result = await new WorkspaceSessionArtifactMigrator({ legacyStorageDir: legacy }).migrate(ref);
    assert.deepStrictEqual(
      result.artifacts.find((entry) => entry.artifact === 'chat_log'),
      { artifact: 'chat_log', state: 'blocked', reason: 'unsafe_target' },
    );
    assert.deepStrictEqual(fs.readFileSync(source), contents);
    assert.strictEqual(fs.statSync(target).nlink, 3);
    assert.strictEqual(fs.existsSync(controlledTemp), true);
    assert.strictEqual(fs.existsSync(outsideLink), true);
  });

  it('restores the source when a hard link appears during the final unlink window', async function () {
    const contents = Buffer.from('late hard-link race');
    const source = writeLegacy('chat_log', contents);
    const target = path.join(sessionDir(), 'chat.jsonl');
    const outsideLink = path.join(root, 'late-target-link');
    let injected = false;
    const migrator = new WorkspaceSessionArtifactMigrator({
      legacyStorageDir: legacy,
      hooks: {
        beforeLegacyUnlink(event) {
          if (!injected && event.artifact === 'chat_log' && event.kind === 'source') {
            injected = true;
            fs.linkSync(target, outsideLink);
          }
        },
      },
    });
    const first = await migrator.migrate(ref);

    assert.strictEqual(injected, true);
    assert.strictEqual(first.status, 'blocked');
    assert.deepStrictEqual(
      first.artifacts.find((entry) => entry.artifact === 'chat_log'),
      { artifact: 'chat_log', state: 'blocked', reason: 'unsafe_target' },
    );
    assert.deepStrictEqual(fs.readFileSync(source), contents);
    assert.strictEqual(fs.statSync(target).nlink, 2);

    fs.unlinkSync(outsideLink);
    const retry = await migrator.migrate(ref);
    assert.strictEqual(retry.status, 'complete');
    assert.strictEqual(fs.existsSync(source), false);
    assert.strictEqual(fs.statSync(target).nlink, 1);
  });

  it('reports partial without overwriting or deleting a conflicting target', async function () {
    const source = writeLegacy('chat_log', Buffer.from('legacy chat'));
    writeLegacy('transcript', Buffer.from('terminal transcript'));
    fs.mkdirSync(sessionDir(), { recursive: true });
    const target = path.join(sessionDir(), 'chat.jsonl');
    fs.writeFileSync(target, 'different workspace chat');

    const result = await new WorkspaceSessionArtifactMigrator({ legacyStorageDir: legacy }).migrate(ref);
    const chat = result.artifacts.find((entry) => entry.artifact === 'chat_log');
    const transcript = result.artifacts.find((entry) => entry.artifact === 'transcript');
    assert.strictEqual(result.status, 'partial');
    assert.deepStrictEqual(chat, {
      artifact: 'chat_log', state: 'blocked', reason: 'target_conflict',
    });
    assert.strictEqual(transcript.state, 'migrated');
    assert.strictEqual(
      fs.existsSync(artifactPaths().transcript[0]),
      true,
      'a later conflict must preserve sources whose targets were already copied',
    );
    assert.strictEqual(fs.readFileSync(source, 'utf8'), 'legacy chat');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'different workspace chat');
  });

  for (const conflictingArtifact of ['chat_index', 'history_index']) {
    it(`keeps the complete legacy set when ${conflictingArtifact} fails mid-preparation`, async function () {
      const expected = new Map();
      for (const artifact of Object.keys(artifactPaths())) {
        const contents = artifact === 'paste_manifest'
          ? Buffer.from('{"version":1,"entries":[]}')
          : Buffer.from(`legacy:${artifact}`);
        expected.set(artifact, contents);
        writeLegacy(artifact, contents);
      }
      fs.mkdirSync(sessionDir(), { recursive: true });
      const [, conflictTargetName] = artifactPaths()[conflictingArtifact];
      const conflictTarget = path.join(sessionDir(), conflictTargetName);
      fs.writeFileSync(conflictTarget, 'unrelated workspace data');

      const result = await new WorkspaceSessionArtifactMigrator({ legacyStorageDir: legacy }).migrate(ref);

      assert.strictEqual(result.status, 'partial');
      assert.deepStrictEqual(
        result.artifacts.find((entry) => entry.artifact === conflictingArtifact),
        { artifact: conflictingArtifact, state: 'blocked', reason: 'target_conflict' },
      );
      for (const [artifact, [source]] of Object.entries(artifactPaths())) {
        assert.deepStrictEqual(
          fs.readFileSync(source),
          expected.get(artifact),
          `${artifact} source was removed before the session-wide verification completed`,
        );
      }
      assert.strictEqual(fs.readFileSync(conflictTarget, 'utf8'), 'unrelated workspace data');
    });
  }

  it('rolls back source cleanup after an intermediate unlink failure and retries idempotently', async function () {
    const expected = new Map();
    for (const artifact of ['chat_log', 'chat_index', 'transcript']) {
      const contents = Buffer.from(`cleanup:${artifact}`);
      expected.set(artifact, contents);
      writeLegacy(artifact, contents);
    }
    let injected = false;
    const migrator = new WorkspaceSessionArtifactMigrator({
      legacyStorageDir: legacy,
      hooks: {
        beforeLegacyUnlink(event) {
          if (!injected && event.artifact === 'chat_index' && event.kind === 'source') {
            injected = true;
            const error = new Error('injected cleanup failure');
            error.code = 'EACCES';
            throw error;
          }
        },
      },
    });
    const first = await migrator.migrate(ref);

    assert.strictEqual(injected, true);
    assert.strictEqual(first.status, 'partial');
    assert.deepStrictEqual(
      first.artifacts.find((entry) => entry.artifact === 'chat_index'),
      { artifact: 'chat_index', state: 'blocked', reason: 'io_error' },
    );
    for (const [artifact, contents] of expected) {
      assert.deepStrictEqual(
        fs.readFileSync(artifactPaths()[artifact][0]),
        contents,
        `${artifact} was not restored after cleanup failed`,
      );
    }
    const verifiedMarker = JSON.parse(fs.readFileSync(
      path.join(sessionDir(), '.legacy-artifact-migration.v1.json'),
      'utf8',
    ));
    assert.strictEqual(verifiedMarker.phase, 'verified');

    // Recovery must not depend on the workspace remaining mounted. This is
    // the state a restart observes after an interrupted cleanup.
    fs.unlinkSync(artifactPaths().chat_log[0]);
    closeWorkspaceSessionDirectoryLease(ref);
    const savedWorkspaceStorage = path.join(workspace, '.cc-web-saved');
    const unavailableTarget = path.join(root, 'temporarily-unavailable-target');
    fs.renameSync(path.join(workspace, '.cc-web'), savedWorkspaceStorage);
    fs.mkdirSync(unavailableTarget);
    fs.symlinkSync(unavailableTarget, path.join(workspace, '.cc-web'));
    const unavailable = await migrator.migrate(ref);
    assert.strictEqual(unavailable.status, 'blocked');
    for (const [artifact, contents] of expected) {
      assert.deepStrictEqual(fs.readFileSync(artifactPaths()[artifact][0]), contents);
    }
    fs.unlinkSync(path.join(workspace, '.cc-web'));
    fs.renameSync(savedWorkspaceStorage, path.join(workspace, '.cc-web'));

    const second = await migrator.migrate(ref);
    assert.strictEqual(second.status, 'complete');
    const completeMarker = JSON.parse(fs.readFileSync(
      path.join(sessionDir(), '.legacy-artifact-migration.v1.json'),
      'utf8',
    ));
    assert.strictEqual(completeMarker.phase, 'complete');
    assert.strictEqual(completeMarker.ownerKey, ownerKey);
    for (const artifact of expected.keys()) {
      const [source] = artifactPaths()[artifact];
      assert.strictEqual(
        fs.existsSync(path.join(
          path.dirname(source),
          `.${path.basename(source)}.ccweb-session-migration.bak`,
        )),
        true,
        'rollback copy must survive until the SQLite cutover is confirmed',
      );
    }
    await migrator.confirm(ref);
    assert.strictEqual(
      fs.existsSync(path.join(sessionDir(), '.legacy-artifact-migration.v1.json')),
      false,
      'the completed marker must not survive its rollback-copy cleanup',
    );
    for (const artifact of expected.keys()) {
      const [source] = artifactPaths()[artifact];
      assert.strictEqual(fs.existsSync(source), false);
      assert.strictEqual(
        fs.existsSync(path.join(
          path.dirname(source),
          `.${path.basename(source)}.ccweb-session-migration.bak`,
        )),
        false,
      );
    }
  });

  it('preserves sources while the target is unavailable and completes on retry', async function () {
    const source = writeLegacy('chat_log', Buffer.from('retry after workspace recovery'));
    const outside = path.join(root, 'unavailable-target');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(workspace, '.cc-web'));
    const migrator = new WorkspaceSessionArtifactMigrator({ legacyStorageDir: legacy });

    const first = await migrator.migrate(ref);
    assert.strictEqual(first.status, 'blocked');
    assert.strictEqual(fs.readFileSync(source, 'utf8'), 'retry after workspace recovery');
    assert.deepStrictEqual(fs.readdirSync(outside), []);

    fs.unlinkSync(path.join(workspace, '.cc-web'));
    const second = await migrator.migrate(ref);
    assert.strictEqual(second.status, 'complete');
    assert.strictEqual(fs.existsSync(source), false);
    assert.strictEqual(
      fs.readFileSync(path.join(sessionDir(), 'chat.jsonl'), 'utf8'),
      'retry after workspace recovery',
    );
  });

  it('blocks a symlinked source and never reads or deletes its target', async function () {
    const outside = path.join(root, 'outside-secret');
    fs.writeFileSync(outside, 'do not migrate');
    const [source] = artifactPaths().chat_log;
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.symlinkSync(outside, source);

    const result = await new WorkspaceSessionArtifactMigrator({ legacyStorageDir: legacy }).migrate(ref);
    const chat = result.artifacts.find((entry) => entry.artifact === 'chat_log');
    assert.strictEqual(result.status, 'blocked');
    assert.deepStrictEqual(chat, {
      artifact: 'chat_log', state: 'blocked', reason: 'unsafe_source',
    });
    assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'do not migrate');
    assert.strictEqual(fs.existsSync(path.join(sessionDir(), 'chat.jsonl')), false);
  });

  it('rejects a legacy source with an unrelated hard link', async function () {
    const source = writeLegacy('chat_log', Buffer.from('hard-linked legacy source'));
    const sibling = path.join(root, 'legacy-source-hardlink');
    fs.linkSync(source, sibling);

    const result = await new WorkspaceSessionArtifactMigrator({ legacyStorageDir: legacy }).migrate(ref);
    assert.deepStrictEqual(
      result.artifacts.find((entry) => entry.artifact === 'chat_log'),
      { artifact: 'chat_log', state: 'blocked', reason: 'unsafe_source' },
    );
    assert.strictEqual(fs.statSync(source).nlink, 2);
    assert.deepStrictEqual(fs.readFileSync(sibling), Buffer.from('hard-linked legacy source'));
    assert.strictEqual(fs.existsSync(path.join(sessionDir(), 'chat.jsonl')), false);
  });

  it('blocks when a source gains a hard link in the final unlink window and retries safely', async function () {
    const contents = Buffer.from('hard link added after the source fingerprint');
    const source = writeLegacy('chat_log', contents);
    const sibling = path.join(root, 'late-legacy-source-hardlink');
    let injected = false;
    const originalRename = fs.promises.rename;
    fs.promises.rename = async function (from, to) {
      if (
        !injected
        && path.basename(String(from)) === `${sessionId}.jsonl`
        && path.basename(String(to)) === 'artifact'
      ) {
        injected = true;
        fs.linkSync(String(from), sibling);
      }
      return originalRename.call(this, from, to);
    };
    const migrator = new WorkspaceSessionArtifactMigrator({ legacyStorageDir: legacy });
    let first;
    try {
      first = await migrator.migrate(ref);
    } finally {
      fs.promises.rename = originalRename;
    }
    assert.strictEqual(injected, true);
    assert.strictEqual(first.status, 'blocked');
    assert.deepStrictEqual(fs.readFileSync(source), contents);
    assert.deepStrictEqual(fs.readFileSync(sibling), contents);
    assert.strictEqual(fs.statSync(source).nlink, 2);
    assert.strictEqual(
      fs.existsSync(path.join(sessionDir(), '.legacy-artifact-migration.v1.json')),
      true,
      'the verified marker must remain resumable after a rejected unlink',
    );

    fs.unlinkSync(sibling);
    const retry = await migrator.migrate(ref);
    assert.strictEqual(retry.status, 'complete');
    assert.strictEqual(fs.existsSync(source), false);
    await migrator.confirm(ref);
  });

  it('keeps descriptor-bound legacy backups away from a swapped parent during confirm', async function () {
    writeLegacy('chat_log', Buffer.from('pinned parent bytes'));
    const ownerDirectory = path.join(legacy, owner);
    const movedDirectory = path.join(legacy, `${owner}-moved`);
    const backupName = `.${sessionId}.jsonl.ccweb-session-migration.bak`;
    let swapped = false;
    const migrator = new WorkspaceSessionArtifactMigrator({
      legacyStorageDir: legacy,
      hooks: {
        beforeLegacyUnlink(event) {
          if (!swapped && event.artifact === 'chat_log' && event.kind === 'backup') {
            swapped = true;
            fs.renameSync(ownerDirectory, movedDirectory);
            fs.mkdirSync(ownerDirectory);
            fs.writeFileSync(path.join(ownerDirectory, backupName), 'attacker replacement');
          }
        },
      },
    });
    assert.strictEqual((await migrator.migrate(ref)).status, 'complete');

    await assert.rejects(migrator.confirm(ref), /changed while pinned/);

    assert.strictEqual(swapped, true);
    assert.strictEqual(
      fs.readFileSync(path.join(ownerDirectory, backupName), 'utf8'),
      'attacker replacement',
    );
    assert.strictEqual(fs.existsSync(path.join(movedDirectory, backupName)), true);
    assert.strictEqual(
      fs.existsSync(path.join(sessionDir(), '.legacy-artifact-migration.v1.json')),
      true,
    );
  });

  it('rejects a byte-identical backup replacement during confirm without deleting either file', async function () {
    const contents = Buffer.from('original backup inode must remain authoritative');
    writeLegacy('chat_log', contents);
    let injected = false;
    const backup = path.join(
      legacy,
      owner,
      `.${sessionId}.jsonl.ccweb-session-migration.bak`,
    );
    const displaced = path.join(legacy, owner, '.displaced-original-backup');
    const migrator = new WorkspaceSessionArtifactMigrator({ legacyStorageDir: legacy });
    assert.strictEqual((await migrator.migrate(ref)).status, 'complete');

    const originalRename = fs.promises.rename;
    fs.promises.rename = async function (from, to) {
      if (
        !injected
        && path.basename(String(from)) === path.basename(backup)
        && path.basename(String(to)) === 'artifact'
      ) {
        injected = true;
        fs.renameSync(String(from), displaced);
        fs.writeFileSync(String(from), contents);
      }
      return originalRename.call(this, from, to);
    };
    try {
      await assert.rejects(
        migrator.confirm(ref),
        /name changed during quarantine rename/,
      );
    } finally {
      fs.promises.rename = originalRename;
    }
    assert.strictEqual(injected, true);
    assert.deepStrictEqual(fs.readFileSync(backup), contents, 'replacement must not be unlinked');
    assert.deepStrictEqual(fs.readFileSync(displaced), contents, 'opened original must remain intact');
    const marker = path.join(sessionDir(), '.legacy-artifact-migration.v1.json');
    assert.strictEqual(fs.existsSync(marker), true);

    fs.unlinkSync(backup);
    fs.renameSync(displaced, backup);
    await migrator.confirm(ref);
    assert.strictEqual(fs.existsSync(backup), false);
    assert.strictEqual(fs.existsSync(marker), false);
  });

  it('recovers a durable backup quarantine in a new process pass before confirming', async function () {
    writeLegacy('chat_log', Buffer.from('cold quarantine recovery'));
    const initial = new WorkspaceSessionArtifactMigrator({ legacyStorageDir: legacy });
    assert.strictEqual((await initial.migrate(ref)).status, 'complete');

    let quarantineSyncs = 0;
    const crashing = new WorkspaceSessionArtifactMigrator({
      legacyStorageDir: legacy,
      hooks: {
        afterDirectorySync(event) {
          if (event.reason === 'quarantine_publish') {
            quarantineSyncs += 1;
            if (quarantineSyncs === 2) {
              throw new Error('simulated process loss after durable quarantine rename');
            }
          }
        },
      },
    });
    await assert.rejects(
      crashing.confirm(ref),
      /simulated process loss/,
    );

    const legacyOwner = path.join(legacy, owner);
    const quarantine = fs.readdirSync(legacyOwner).find(
      (name) => name.startsWith('.ccweb-retire-'),
    );
    assert.ok(quarantine, 'durable quarantine must survive the simulated crash');
    assert.deepStrictEqual(
      fs.readdirSync(path.join(legacyOwner, quarantine)),
      ['artifact'],
    );
    const marker = path.join(sessionDir(), '.legacy-artifact-migration.v1.json');
    assert.strictEqual(fs.existsSync(marker), true);

    const cold = new WorkspaceSessionArtifactMigrator({ legacyStorageDir: legacy });
    await cold.confirm(ref);
    assert.strictEqual(fs.existsSync(path.join(legacyOwner, quarantine)), false);
    assert.strictEqual(fs.existsSync(marker), false);
    assert.deepStrictEqual(
      fs.readFileSync(path.join(sessionDir(), 'chat.jsonl')),
      Buffer.from('cold quarantine recovery'),
    );
  });

  it('blocks a symlinked legacy parent component', async function () {
    const outside = path.join(root, 'outside-history');
    fs.mkdirSync(path.join(outside, owner), { recursive: true });
    fs.writeFileSync(path.join(outside, owner, `${sessionId}.log`), 'outside line\n');
    fs.symlinkSync(outside, path.join(legacy, 'history'));

    const result = await new WorkspaceSessionArtifactMigrator({ legacyStorageDir: legacy }).migrate(ref);
    const history = result.artifacts.find((entry) => entry.artifact === 'history_log');
    assert.deepStrictEqual(history, {
      artifact: 'history_log', state: 'blocked', reason: 'unsafe_source',
    });
    assert.strictEqual(fs.existsSync(path.join(sessionDir(), 'history.log')), false);
  });

  it('blocks an unsafe workspace .cc-web symlink without writing through it', async function () {
    const outside = path.join(root, 'outside-workspace');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(workspace, '.cc-web'));
    writeLegacy('chat_log', Buffer.from('legacy chat'));

    const result = await new WorkspaceSessionArtifactMigrator({ legacyStorageDir: legacy }).migrate(ref);
    assert.strictEqual(result.status, 'blocked');
    assert.ok(result.artifacts.every(
      (entry) => entry.state === 'blocked' && entry.reason === 'unsafe_workspace_storage',
    ));
    assert.deepStrictEqual(fs.readdirSync(outside), []);
  });

  it('blocks traversal-shaped identities before constructing source or target paths', async function () {
    const result = await new WorkspaceSessionArtifactMigrator({ legacyStorageDir: legacy }).migrate({
      ...ref,
      id: '../escape',
    });
    assert.strictEqual(result.status, 'blocked');
    assert.ok(result.artifacts.every(
      (entry) => entry.state === 'blocked' && entry.reason === 'unsafe_source',
    ));
    assert.strictEqual(fs.existsSync(path.join(root, 'escape.jsonl')), false);
  });

  it('moves flat, namespaced, and manifested binary files from a secondary project cwd into the canonical workspace', async function () {
    const secondary = path.join(workspace, 'checkout', 'packages', 'app');
    fs.mkdirSync(secondary, { recursive: true });
    ref.workingDir = secondary;
    ref.projectId = 'project-a';
    ref.projectWorkingDirKind = 'host';

    const flatName = '111111111111-flat.png';
    const numericName = '222222222222-numeric.pdf';
    const currentName = '333333333333-current.txt';
    const flatBytes = Buffer.from([0, 255, 1, 2, 3, 128]);
    const numericBytes = Buffer.from('numeric namespace attachment');
    const currentBytes = Buffer.from('already canonical attachment');
    const attachmentUrl = (name) => `/api/sessions/${sessionId}/chat-attachments/${name}`;

    const flatSource = path.join(secondary, '.cc-web', 'attachments', flatName);
    const numericSource = path.join(
      secondary,
      '.cc-web',
      'attachments',
      owner,
      sessionId,
      numericName,
    );
    const currentTarget = path.join(
      workspace,
      '.cc-web',
      'attachments',
      ownerKey,
      sessionId,
      currentName,
    );
    for (const [file, bytes] of [
      [flatSource, flatBytes],
      [numericSource, numericBytes],
      [currentTarget, currentBytes],
    ]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
    }

    writeLegacy('chat_log', Buffer.from([
      JSON.stringify({ url: attachmentUrl(flatName) }),
      JSON.stringify({ url: attachmentUrl(currentName) }),
      '',
    ].join('\n')));

    const pasteName = '2026-08-05T10-11-12-000Z-a1b2c3d4.png';
    const pasteBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1, 2, 3, 4]);
    const pasteRoot = path.join(secondary, '.cc-web', 'pasted');
    const pasteSource = path.join(pasteRoot, pasteName);
    fs.mkdirSync(pasteRoot, { recursive: true });
    fs.writeFileSync(pasteSource, pasteBytes);
    writeLegacy('paste_manifest', JSON.stringify({
      version: 1,
      entries: [{ path: pasteSource, root: pasteRoot, bytes: pasteBytes.length }],
    }));

    const migrator = new WorkspaceSessionArtifactMigrator({ legacyStorageDir: legacy });
    const result = await migrator.migrate(ref);
    assert.strictEqual(result.status, 'complete');
    assert.strictEqual(
      await migrator.hasPendingBinaryCleanup(ref),
      true,
      'lifecycle guard sees rollback authority before confirm',
    );
    assert.strictEqual(
      result.artifacts.filter((entry) => entry.artifact === 'attachment_file').length,
      3,
    );
    assert.strictEqual(
      result.artifacts.filter((entry) => entry.artifact === 'paste_file').length,
      1,
    );

    const canonicalAttachmentRoot = path.join(
      workspace,
      '.cc-web',
      'attachments',
      ownerKey,
      sessionId,
    );
    assert.deepStrictEqual(fs.readFileSync(path.join(canonicalAttachmentRoot, flatName)), flatBytes);
    assert.deepStrictEqual(fs.readFileSync(path.join(canonicalAttachmentRoot, numericName)), numericBytes);
    assert.deepStrictEqual(fs.readFileSync(path.join(canonicalAttachmentRoot, currentName)), currentBytes);
    assert.strictEqual(fs.existsSync(flatSource), false);
    assert.strictEqual(fs.existsSync(numericSource), false);
    assert.deepStrictEqual(fs.readFileSync(currentTarget), currentBytes);

    const canonicalPasteRoot = path.join(workspace, '.cc-web', 'pasted');
    const canonicalPaste = path.join(canonicalPasteRoot, pasteName);
    assert.deepStrictEqual(fs.readFileSync(canonicalPaste), pasteBytes);
    assert.strictEqual(fs.existsSync(pasteSource), false);
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(path.join(sessionDir(), 'paste-manifest.json'), 'utf8')),
      {
        version: 1,
        entries: [{ path: canonicalPaste, root: canonicalPasteRoot, bytes: pasteBytes.length }],
      },
    );

    // Rebuild/reclaim may discard the secondary checkout after the canonical
    // `.cc-web` has been preserved. Confirmation must use the verified target,
    // not require the old cwd to survive.
    closeWorkspaceSessionDirectoryLease(ref);
    fs.rmSync(path.join(workspace, 'checkout'), { recursive: true, force: true });
    await migrator.confirm(ref);
    assert.strictEqual(await migrator.hasPendingBinaryCleanup(ref), false);
    assert.deepStrictEqual(fs.readFileSync(path.join(canonicalAttachmentRoot, flatName)), flatBytes);
    assert.deepStrictEqual(fs.readFileSync(canonicalPaste), pasteBytes);
    assert.strictEqual(
      fs.existsSync(path.join(sessionDir(), '.legacy-artifact-migration.v1.json')),
      false,
    );
  });

  it('rejects a legacy attachment above 20 MiB before hashing or copying it', async function () {
    const name = 'aaaaaaaaaaaa-too-large.bin';
    const source = path.join(workspace, '.cc-web', 'attachments', name);
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, Buffer.alloc(0));
    fs.truncateSync(source, 20 * 1024 * 1024 + 1);
    ref.chatDraft = {
      attachments: [{ url: `/api/sessions/${sessionId}/chat-attachments/${name}` }],
    };

    const result = await new WorkspaceSessionArtifactMigrator({ legacyStorageDir: legacy }).migrate(ref);
    assert.strictEqual(result.status, 'blocked');
    assert.strictEqual(fs.statSync(source).size, 20 * 1024 * 1024 + 1);
    assert.strictEqual(
      fs.existsSync(path.join(
        workspace,
        '.cc-web',
        'attachments',
        ownerKey,
        sessionId,
        name,
      )),
      false,
    );
  });

  it('applies the 400 MiB attachment quota once per logical name across legacy layouts', async function () {
    const urls = [];
    const sources = [];
    const flat = path.join(workspace, '.cc-web', 'attachments');
    fs.mkdirSync(flat, { recursive: true });
    for (let index = 0; index < 21; index += 1) {
      const name = `${index.toString(16).padStart(12, '0')}-quota.bin`;
      const source = path.join(flat, name);
      fs.writeFileSync(source, Buffer.alloc(0));
      fs.truncateSync(source, 20 * 1024 * 1024);
      sources.push(source);
      urls.push({ url: `/api/sessions/${sessionId}/chat-attachments/${name}` });
    }
    ref.chatDraft = { attachments: urls };

    const result = await new WorkspaceSessionArtifactMigrator({ legacyStorageDir: legacy }).migrate(ref);
    assert.strictEqual(result.status, 'blocked');
    assert.ok(sources.every((source) => fs.statSync(source).size === 20 * 1024 * 1024));
    const targetRoot = path.join(
      workspace,
      '.cc-web',
      'attachments',
      ownerKey,
      sessionId,
    );
    assert.deepStrictEqual(fs.readdirSync(targetRoot), []);
  });

  it('counts cold-retired attachment sources toward the 400 MiB quota', async function () {
    const urls = [];
    const sources = [];
    const quarantines = [];
    const flat = path.join(workspace, '.cc-web', 'attachments');
    fs.mkdirSync(flat, { recursive: true });
    for (let index = 0; index < 21; index += 1) {
      const name = `${(index + 64).toString(16).padStart(12, '0')}-retired.bin`;
      const source = path.join(flat, name);
      fs.writeFileSync(source, Buffer.alloc(0));
      fs.truncateSync(source, 20 * 1024 * 1024);
      const digest = createHash('sha256').update(name).digest('hex').slice(0, 32);
      const quarantine = path.join(flat, `.ccweb-retire-${digest}`);
      fs.mkdirSync(quarantine, { mode: 0o700 });
      fs.renameSync(source, path.join(quarantine, 'artifact'));
      sources.push(source);
      quarantines.push(quarantine);
      urls.push({ url: `/api/sessions/${sessionId}/chat-attachments/${name}` });
    }
    ref.chatDraft = { attachments: urls };

    const result = await new WorkspaceSessionArtifactMigrator({ legacyStorageDir: legacy }).migrate(ref);
    assert.strictEqual(result.status, 'blocked');
    assert.ok(sources.every((source) => fs.statSync(source).size === 20 * 1024 * 1024));
    assert.ok(quarantines.every((quarantine) => !fs.existsSync(quarantine)));
  });

  it('never treats an escaped non-project child cwd as a legacy attachment root', async function () {
    const escaped = path.join(root, 'escaped-child-cwd');
    const name = 'abcdefabcdef-escaped.png';
    const outsideSource = path.join(escaped, '.cc-web', 'attachments', name);
    fs.mkdirSync(path.dirname(outsideSource), { recursive: true });
    fs.writeFileSync(outsideSource, 'outside attachment');
    ref.workingDir = escaped;
    ref.chatDraft = {
      attachments: [{ url: `/api/sessions/${sessionId}/chat-attachments/${name}` }],
    };

    const result = await new WorkspaceSessionArtifactMigrator({ legacyStorageDir: legacy }).migrate(ref);
    assert.strictEqual(result.status, 'blocked');
    assert.ok(result.artifacts.some((entry) => (
      entry.artifact === 'attachment_file'
      && entry.state === 'blocked'
      && entry.reason === 'source_changed'
    )));
    assert.strictEqual(fs.readFileSync(outsideSource, 'utf8'), 'outside attachment');
    assert.strictEqual(
      fs.existsSync(path.join(workspace, '.cc-web', 'attachments', ownerKey, sessionId, name)),
      false,
    );
  });

  it('keeps every binary source and manifest when the canonical destination conflicts', async function () {
    const secondary = path.join(workspace, 'secondary');
    fs.mkdirSync(secondary, { recursive: true });
    ref.workingDir = secondary;
    ref.projectId = 'project-a';
    ref.projectWorkingDirKind = 'host';

    const storedName = 'abcdefabcdef-conflict.bin';
    const source = path.join(secondary, '.cc-web', 'attachments', storedName);
    const target = path.join(
      workspace,
      '.cc-web',
      'attachments',
      ownerKey,
      sessionId,
      storedName,
    );
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(source, Buffer.from('legacy attachment bytes'));
    fs.writeFileSync(target, Buffer.from('unrelated canonical bytes'));
    writeLegacy('chat_log', JSON.stringify({
      url: `/api/sessions/${sessionId}/chat-attachments/${storedName}`,
    }));

    const pasteName = '2026-08-05T10-11-12-000Z-deadbeef.png';
    const pasteRoot = path.join(secondary, '.cc-web', 'pasted');
    const pasteSource = path.join(pasteRoot, pasteName);
    const pasteBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 9, 8, 7, 6]);
    fs.mkdirSync(pasteRoot, { recursive: true });
    fs.writeFileSync(pasteSource, pasteBytes);
    const manifestSource = writeLegacy('paste_manifest', JSON.stringify({
      version: 1,
      entries: [{ path: pasteSource, root: pasteRoot, bytes: pasteBytes.length }],
    }));

    const result = await new WorkspaceSessionArtifactMigrator({ legacyStorageDir: legacy }).migrate(ref);
    assert.strictEqual(result.status, 'partial');
    assert.ok(result.artifacts.some((entry) => (
      entry.artifact === 'attachment_file'
      && entry.state === 'blocked'
      && entry.reason === 'target_conflict'
    )));
    assert.strictEqual(fs.readFileSync(source, 'utf8'), 'legacy attachment bytes');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'unrelated canonical bytes');
    assert.deepStrictEqual(fs.readFileSync(pasteSource), pasteBytes);
    assert.strictEqual(fs.existsSync(manifestSource), true);
  });

  it('resumes confirmation after paste cleanup without losing the legacy manifest map', async function () {
    const secondary = path.join(workspace, 'secondary-confirm');
    const pasteRoot = path.join(secondary, '.cc-web', 'pasted');
    const pasteName = 'mid-confirm-resume.png';
    const pasteSource = path.join(pasteRoot, pasteName);
    const pasteBytes = Buffer.from('paste bytes survive confirm restart');
    fs.mkdirSync(pasteRoot, { recursive: true });
    fs.writeFileSync(pasteSource, pasteBytes);
    const manifestSource = writeLegacy('paste_manifest', JSON.stringify({
      version: 1,
      entries: [{ path: pasteSource, root: pasteRoot, bytes: pasteBytes.length }],
    }));
    ref.workingDir = secondary;
    ref.projectId = 'project-a';
    ref.projectWorkingDirKind = 'host';

    let interrupted = false;
    const crashing = new WorkspaceSessionArtifactMigrator({
      legacyStorageDir: legacy,
      hooks: {
        afterConfirmArtifact(event) {
          if (!interrupted && event.artifact === 'paste_file') {
            interrupted = true;
            throw new Error('simulated process exit midway through confirm');
          }
        },
      },
    });
    assert.strictEqual((await crashing.migrate(ref)).status, 'complete');
    await assert.rejects(crashing.confirm(ref), /midway through confirm/);
    assert.strictEqual(interrupted, true);
    assert.strictEqual(fs.existsSync(pasteSource), false);
    const manifestBackup = path.join(
      path.dirname(manifestSource),
      `.${path.basename(manifestSource)}.ccweb-session-migration.bak`,
    );
    assert.strictEqual(
      fs.existsSync(manifestBackup),
      true,
      'manifest rollback map remains until every paste is retired',
    );
    assert.strictEqual(
      fs.existsSync(path.join(sessionDir(), '.legacy-artifact-migration.v1.json')),
      true,
    );

    const resumed = new WorkspaceSessionArtifactMigrator({ legacyStorageDir: legacy });
    await resumed.confirm(ref);
    assert.strictEqual(
      fs.existsSync(path.join(sessionDir(), '.legacy-artifact-migration.v1.json')),
      false,
    );
    assert.strictEqual(fs.existsSync(manifestSource), false);
    assert.deepStrictEqual(
      fs.readFileSync(path.join(workspace, '.cc-web', 'pasted', pasteName)),
      pasteBytes,
    );
  });

  it('fails closed at the bounded attachment-reference count without deleting legacy data', async function () {
    const names = Array.from({ length: 501 }, (_, index) => (
      `${index.toString(16).padStart(12, '0')}-bounded-${index}.bin`
    ));
    const source = writeLegacy('chat_log', Buffer.from(names.map((name) => (
      `/api/sessions/${sessionId}/chat-attachments/${name}`
    )).join('\n')));

    const result = await new WorkspaceSessionArtifactMigrator({ legacyStorageDir: legacy }).migrate(ref);
    assert.strictEqual(result.status, 'blocked');
    assert.ok(result.artifacts.every((entry) => (
      entry.state === 'blocked' && entry.reason === 'unsafe_source'
    )));
    assert.strictEqual(fs.existsSync(source), true);
    assert.strictEqual(
      fs.existsSync(path.join(workspace, '.cc-web', 'attachments', ownerKey, sessionId)),
      false,
    );
  });

  it('rejects a manifest-derived symlink workspace and never reads or deletes its paste file', async function () {
    const outsideWorkspace = path.join(root, 'outside-paste-workspace');
    const outsidePasteRoot = path.join(outsideWorkspace, '.cc-web', 'pasted');
    const pasteName = '2026-08-05T10-11-12-000Z-feedface.png';
    const outsidePaste = path.join(outsidePasteRoot, pasteName);
    fs.mkdirSync(outsidePasteRoot, { recursive: true });
    fs.writeFileSync(outsidePaste, Buffer.from('outside bytes must remain untouched'));

    const symlinkWorkspace = path.join(root, 'manifest-workspace-link');
    fs.symlinkSync(outsideWorkspace, symlinkWorkspace);
    ref.workingDir = symlinkWorkspace;
    const manifestRoot = path.join(symlinkWorkspace, '.cc-web', 'pasted');
    const manifestPath = path.join(manifestRoot, pasteName);
    const manifestSource = writeLegacy('paste_manifest', JSON.stringify({
      version: 1,
      entries: [{
        path: manifestPath,
        root: manifestRoot,
        bytes: fs.statSync(outsidePaste).size,
      }],
    }));

    const result = await new WorkspaceSessionArtifactMigrator({ legacyStorageDir: legacy }).migrate(ref);
    assert.strictEqual(result.status, 'blocked');
    assert.ok(result.artifacts.every((entry) => entry.state === 'blocked'));
    assert.strictEqual(fs.readFileSync(outsidePaste, 'utf8'), 'outside bytes must remain untouched');
    assert.strictEqual(fs.existsSync(manifestSource), true);
    assert.strictEqual(fs.existsSync(path.join(workspace, '.cc-web', 'pasted', pasteName)), false);
  });

  it('does not treat a legacy manifest as authority over an unrelated real workspace', async function () {
    const unrelatedWorkspace = path.join(root, 'unrelated-real-workspace');
    const unrelatedPasteRoot = path.join(unrelatedWorkspace, '.cc-web', 'pasted');
    const pasteName = '2026-08-05T10-11-12-000Z-cafebabe.png';
    const sentinel = path.join(unrelatedPasteRoot, pasteName);
    fs.mkdirSync(unrelatedPasteRoot, { recursive: true });
    fs.writeFileSync(sentinel, Buffer.from('unrelated sentinel'));
    const manifestSource = writeLegacy('paste_manifest', JSON.stringify({
      version: 1,
      entries: [{
        path: sentinel,
        root: unrelatedPasteRoot,
        bytes: fs.statSync(sentinel).size,
      }],
    }));

    const result = await new WorkspaceSessionArtifactMigrator({ legacyStorageDir: legacy }).migrate(ref);
    assert.strictEqual(result.status, 'blocked');
    assert.strictEqual(fs.readFileSync(sentinel, 'utf8'), 'unrelated sentinel');
    assert.strictEqual(fs.existsSync(manifestSource), true);
    assert.strictEqual(fs.existsSync(path.join(workspace, '.cc-web', 'pasted', pasteName)), false);
  });

  it('round-trips a bounded migration marker larger than the historical 256 KiB cap', async function () {
    const pasteRoot = path.join(workspace, '.cc-web', 'pasted');
    fs.mkdirSync(pasteRoot, { recursive: true });
    const entries = [];
    for (let index = 0; index < 1400; index += 1) {
      const name = `2026-08-05T10-11-12-000Z-${index.toString(16).padStart(8, '0')}.png`;
      const file = path.join(pasteRoot, name);
      fs.writeFileSync(file, Buffer.from([index & 0xff]));
      entries.push({ path: file, root: pasteRoot, bytes: 1 });
    }
    writeLegacy('paste_manifest', JSON.stringify({ version: 1, entries }));

    const migrator = new WorkspaceSessionArtifactMigrator({ legacyStorageDir: legacy });
    const result = await migrator.migrate(ref);
    assert.strictEqual(result.status, 'complete');
    const marker = path.join(sessionDir(), '.legacy-artifact-migration.v1.json');
    assert.ok(fs.statSync(marker).size > 256 * 1024);
    assert.ok(fs.statSync(marker).size < 4 * 1024 * 1024);
    await migrator.confirm(ref);
    assert.strictEqual(fs.existsSync(marker), false);
    assert.strictEqual(fs.readFileSync(entries[1399].path)[0], 1399 & 0xff);
  });

  it('bounds a marker that grows after open without readFile allocation semantics', async function () {
    writeLegacy('chat_log', Buffer.from('bounded marker reader'));
    const migrator = new WorkspaceSessionArtifactMigrator({ legacyStorageDir: legacy });
    assert.strictEqual((await migrator.migrate(ref)).status, 'complete');
    const marker = path.join(sessionDir(), '.legacy-artifact-migration.v1.json');

    const originalOpen = fs.promises.open;
    let injected = false;
    fs.promises.open = async function (candidate, ...args) {
      const handle = await originalOpen.call(this, candidate, ...args);
      if (!injected && path.basename(String(candidate)) === '.legacy-artifact-migration.v1.json') {
        const originalRead = handle.read.bind(handle);
        handle.read = async function (...readArgs) {
          if (!injected) {
            injected = true;
            fs.appendFileSync(String(candidate), Buffer.alloc(4 * 1024 * 1024 + 1, 0x20));
          }
          return originalRead(...readArgs);
        };
      }
      return handle;
    };
    try {
      await assert.rejects(migrator.confirm(ref));
    } finally {
      fs.promises.open = originalOpen;
    }
    assert.strictEqual(injected, true);
    assert.strictEqual(fs.existsSync(marker), true, 'an oversized marker is never retired');
  });

  it('rejects a non-array marker artifact collection before deriving uniqueness state', async function () {
    writeLegacy('chat_log', Buffer.from('marker shape bound'));
    const migrator = new WorkspaceSessionArtifactMigrator({ legacyStorageDir: legacy });
    assert.strictEqual((await migrator.migrate(ref)).status, 'complete');
    const marker = path.join(sessionDir(), '.legacy-artifact-migration.v1.json');
    const parsed = JSON.parse(fs.readFileSync(marker, 'utf8'));
    parsed.artifacts = { length: MAX_MIGRATION_MARKER_ARTIFACTS + 1 };
    fs.writeFileSync(marker, JSON.stringify(parsed));

    await assert.rejects(migrator.confirm(ref), /Invalid legacy migration marker/);
    assert.strictEqual(fs.existsSync(marker), true);
  });

  it('never accepts a workspace marker owner id as legacy cleanup authority', async function () {
    const contents = Buffer.from('same bytes do not authorise another numeric owner');
    writeLegacy('chat_log', contents);
    const migrator = new WorkspaceSessionArtifactMigrator({ legacyStorageDir: legacy });
    assert.strictEqual((await migrator.migrate(ref)).status, 'complete');

    const victimOwner = '42';
    const victimSource = path.join(legacy, victimOwner, `${sessionId}.jsonl`);
    fs.mkdirSync(path.dirname(victimSource), { recursive: true });
    fs.writeFileSync(victimSource, contents);
    const marker = path.join(sessionDir(), '.legacy-artifact-migration.v1.json');
    const parsed = JSON.parse(fs.readFileSync(marker, 'utf8'));
    parsed.ownerUserId = Number(victimOwner);
    fs.writeFileSync(marker, JSON.stringify(parsed));

    await assert.rejects(migrator.confirm(ref), /Invalid legacy migration marker/);
    assert.deepStrictEqual(fs.readFileSync(victimSource), contents);
    assert.strictEqual(
      fs.existsSync(path.join(
        legacy,
        owner,
        `.${sessionId}.jsonl.ccweb-session-migration.bak`,
      )),
      true,
    );
    assert.strictEqual(fs.existsSync(marker), true);
  });

  it('writes and confirms the exact maximum multi-layout marker plan', async function () {
    this.timeout(180000);
    const secondary = path.join(workspace, 's');
    ref.workingDir = secondary;
    ref.projectId = 'project-a';
    ref.projectWorkingDirKind = 'host';
    fs.mkdirSync(secondary, { recursive: true });

    const attachmentDirectories = [
      path.join(workspace, '.cc-web', 'attachments'),
      path.join(workspace, '.cc-web', 'attachments', owner, sessionId),
      path.join(secondary, '.cc-web', 'attachments'),
      path.join(secondary, '.cc-web', 'attachments', owner, sessionId),
      path.join(secondary, '.cc-web', 'attachments', ownerKey, sessionId),
    ];
    for (const directory of attachmentDirectories) fs.mkdirSync(directory, { recursive: true });
    for (let index = 0; index < 500; index += 1) {
      const name = `${index.toString(16).padStart(12, '0')}-max.bin`;
      const bytes = Buffer.from([index & 0xff]);
      for (const directory of attachmentDirectories) {
        fs.writeFileSync(path.join(directory, name), bytes);
      }
    }

    const pasteRoot = path.join(secondary, '.cc-web', 'pasted');
    fs.mkdirSync(pasteRoot, { recursive: true });
    const entries = [];
    for (let index = 0; index < 4096; index += 1) {
      const name = index === 0
        ? `${'l'.repeat(236)}.png`
        : `p${index.toString(16).padStart(4, '0')}.png`;
      const file = path.join(pasteRoot, name);
      fs.writeFileSync(file, Buffer.from([index & 0xff]));
      entries.push({ path: file, root: pasteRoot, bytes: 1 });
    }
    writeLegacy('paste_manifest', JSON.stringify({ version: 1, entries }));

    const migrator = new WorkspaceSessionArtifactMigrator({ legacyStorageDir: legacy });
    const result = await migrator.migrate(ref);
    assert.strictEqual(result.status, 'complete');
    const markerPath = path.join(sessionDir(), '.legacy-artifact-migration.v1.json');
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    assert.strictEqual(marker.artifacts.length, MAX_MIGRATION_MARKER_ARTIFACTS);
    assert.ok(marker.artifacts.some((artifact) => (artifact.key || '').length > 256));

    await migrator.confirm(ref);
    assert.strictEqual(fs.existsSync(markerPath), false);
    assert.strictEqual(
      fs.readdirSync(path.join(workspace, '.cc-web', 'attachments', ownerKey, sessionId)).length,
      500,
    );
    assert.strictEqual(fs.readdirSync(path.join(workspace, '.cc-web', 'pasted')).length, 4096);
  });

  it('rejects paste manifests above the bounded entry count and keeps the manifest source', async function () {
    const pasteRoot = path.join(workspace, 'old-cwd', '.cc-web', 'pasted');
    const entries = Array.from({ length: 4097 }, (_, index) => {
      const name = `2026-08-05T10-11-12-000Z-${index.toString(16).padStart(8, '0')}.png`;
      return { path: path.join(pasteRoot, name), root: pasteRoot, bytes: 12 };
    });
    const source = writeLegacy('paste_manifest', JSON.stringify({ version: 1, entries }));

    const result = await new WorkspaceSessionArtifactMigrator({ legacyStorageDir: legacy }).migrate(ref);
    assert.strictEqual(result.status, 'blocked');
    assert.strictEqual(fs.existsSync(source), true);
  });

  it('rejects a paste above 10 MiB from manifest metadata before opening its source', async function () {
    const secondary = path.join(workspace, 'old-cwd');
    const pasteRoot = path.join(secondary, '.cc-web', 'pasted');
    const paste = path.join(pasteRoot, 'too-large.png');
    fs.mkdirSync(pasteRoot, { recursive: true });
    fs.writeFileSync(paste, 'legacy paste bytes');
    ref.workingDir = secondary;
    const manifest = writeLegacy('paste_manifest', JSON.stringify({
      version: 1,
      entries: [{
        path: paste,
        root: pasteRoot,
        bytes: 10 * 1024 * 1024 + 1,
      }],
    }));

    const result = await new WorkspaceSessionArtifactMigrator({ legacyStorageDir: legacy }).migrate(ref);
    assert.strictEqual(result.status, 'blocked');
    assert.strictEqual(fs.readFileSync(paste, 'utf8'), 'legacy paste bytes');
    assert.strictEqual(fs.existsSync(manifest), true);
    assert.strictEqual(fs.existsSync(path.join(workspace, '.cc-web', 'pasted', 'too-large.png')), false);
  });

  it('rejects paste manifests above the 200 MiB session quota without cutting legacy authority', async function () {
    const secondary = path.join(workspace, 'old-cwd');
    const pasteRoot = path.join(secondary, '.cc-web', 'pasted');
    fs.mkdirSync(pasteRoot, { recursive: true });
    ref.workingDir = secondary;
    const entries = [];
    for (let index = 0; index < 21; index += 1) {
      const paste = path.join(pasteRoot, `quota-${index.toString(16).padStart(2, '0')}.png`);
      fs.writeFileSync(paste, Buffer.from([index]));
      entries.push({ path: paste, root: pasteRoot, bytes: 10 * 1024 * 1024 });
    }
    const manifest = writeLegacy('paste_manifest', JSON.stringify({ version: 1, entries }));

    const result = await new WorkspaceSessionArtifactMigrator({ legacyStorageDir: legacy }).migrate(ref);
    assert.strictEqual(result.status, 'blocked');
    assert.strictEqual(fs.existsSync(manifest), true);
    assert.ok(entries.every((entry) => fs.existsSync(entry.path)));
    assert.strictEqual(fs.existsSync(path.join(workspace, '.cc-web', 'pasted')), false);
  });

  it('rejects a wrong-sized canonical paste when its legacy source is missing', async function () {
    const secondary = path.join(workspace, 'old-cwd');
    const pasteRoot = path.join(secondary, '.cc-web', 'pasted');
    const name = 'missing-source.png';
    const missingSource = path.join(pasteRoot, name);
    fs.mkdirSync(pasteRoot, { recursive: true });
    ref.workingDir = secondary;
    const canonical = path.join(workspace, '.cc-web', 'pasted', name);
    fs.mkdirSync(path.dirname(canonical), { recursive: true });
    fs.writeFileSync(canonical, 'wrong canonical size');
    const manifestContents = JSON.stringify({
      version: 1,
      entries: [{ path: missingSource, root: pasteRoot, bytes: 3 }],
    });
    const manifest = writeLegacy('paste_manifest', manifestContents);

    const result = await new WorkspaceSessionArtifactMigrator({ legacyStorageDir: legacy }).migrate(ref);
    assert.notStrictEqual(result.status, 'complete');
    const pasteEntry = result.artifacts.find((entry) => entry.artifact === 'paste_file');
    assert.ok(pasteEntry);
    assert.strictEqual(pasteEntry.state, 'blocked');
    assert.strictEqual(pasteEntry.reason, 'source_changed');
    assert.strictEqual(fs.readFileSync(manifest, 'utf8'), manifestContents);
    assert.strictEqual(fs.readFileSync(canonical, 'utf8'), 'wrong canonical size');
    assert.strictEqual(fs.existsSync(missingSource), false);
  });

  it('fails closed on a corrupt paste manifest and leaves secondary paste bytes authoritative', async function () {
    const secondary = path.join(workspace, 'old-cwd');
    const pasteRoot = path.join(secondary, '.cc-web', 'pasted');
    const paste = path.join(pasteRoot, 'unindexed.png');
    fs.mkdirSync(pasteRoot, { recursive: true });
    fs.writeFileSync(paste, 'unindexed legacy bytes');
    ref.workingDir = secondary;
    const manifest = writeLegacy('paste_manifest', '{ definitely not json');

    const result = await new WorkspaceSessionArtifactMigrator({ legacyStorageDir: legacy }).migrate(ref);
    assert.strictEqual(result.status, 'blocked');
    assert.strictEqual(fs.readFileSync(manifest, 'utf8'), '{ definitely not json');
    assert.strictEqual(fs.readFileSync(paste, 'utf8'), 'unindexed legacy bytes');
    assert.strictEqual(fs.existsSync(path.join(sessionDir(), 'paste-manifest.json')), false);
  });
});
