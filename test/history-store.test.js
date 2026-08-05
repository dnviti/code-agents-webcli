const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { HistoryStore } = require('../dist/server/services/history-store.js');

const SESSION = { id: 'sess-1', ownerUserId: 7 };

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-history-'));
}

/** `append` is fire-and-forget; a read drains the same per-session queue. */
async function appendAndSettle(store, session, lines) {
  store.append(session, lines);
  await store.stat(session);
}

describe('HistoryStore', function () {
  let dir;
  let store;

  beforeEach(function () {
    dir = tempDir();
    store = new HistoryStore({ storageDir: dir });
  });

  afterEach(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('starts empty', async function () {
    assert.deepStrictEqual(await store.stat(SESSION), { firstLine: 0, totalLines: 0 });
    const page = await store.read(SESSION, 0, 10);
    assert.deepStrictEqual(page.lines, []);
  });

  it('reads back exactly what was appended', async function () {
    await appendAndSettle(store, SESSION, ['alfa', 'beta', 'gamma']);

    assert.deepStrictEqual(await store.stat(SESSION), { firstLine: 0, totalLines: 3 });
    const page = await store.read(SESSION, 0, 10);
    assert.deepStrictEqual(page.lines, ['alfa', 'beta', 'gamma']);
    assert.strictEqual(page.fromLine, 0);
  });

  it('serves an arbitrary window without scanning', async function () {
    const lines = Array.from({ length: 5000 }, (_, index) => `riga-${index}`);
    await appendAndSettle(store, SESSION, lines);

    const page = await store.read(SESSION, 3210, 40);
    assert.strictEqual(page.fromLine, 3210);
    assert.strictEqual(page.lines.length, 40);
    assert.strictEqual(page.lines[0], 'riga-3210');
    assert.strictEqual(page.lines[39], 'riga-3249');
  });

  it('serves the final window, which has no following index entry', async function () {
    await appendAndSettle(store, SESSION, ['uno', 'due', 'tre']);
    const page = await store.read(SESSION, 2, 10);
    assert.deepStrictEqual(page.lines, ['tre']);
  });

  it('preserves empty lines and multi-byte content', async function () {
    const lines = ['', 'società', '', '日本語テキスト', ''];
    await appendAndSettle(store, SESSION, lines);

    const page = await store.read(SESSION, 0, 10);
    assert.deepStrictEqual(page.lines, lines);
  });

  it('keeps ANSI styling byte-for-byte', async function () {
    const styled = '\x1b[0;1;38;5;208mattenzione\x1b[0m';
    await appendAndSettle(store, SESSION, [styled]);

    const page = await store.read(SESSION, 0, 1);
    assert.strictEqual(page.lines[0], styled);
  });

  it('caps how much one request can pull', async function () {
    const small = new HistoryStore({ storageDir: dir, maxPageLines: 25 });
    await appendAndSettle(small, SESSION, Array.from({ length: 200 }, (_, i) => `l${i}`));

    const page = await small.read(SESSION, 0, 10_000);
    assert.strictEqual(page.lines.length, 25);
  });

  it('trims the oldest lines and keeps line numbers absolute', async function () {
    const trimming = new HistoryStore({
      storageDir: dir,
      maxLines: 100,
      trimChunkLines: 40,
    });

    await appendAndSettle(
      trimming,
      SESSION,
      Array.from({ length: 150 }, (_, index) => `n${index}`),
    );

    const stats = await trimming.stat(SESSION);
    assert.strictEqual(stats.firstLine, 40, 'the oldest chunk should be gone');
    assert.strictEqual(stats.totalLines, 150, 'numbering must not restart after a trim');

    // Surviving lines keep their original absolute numbers.
    const page = await trimming.read(SESSION, 40, 3);
    assert.deepStrictEqual(page.lines, ['n40', 'n41', 'n42']);

    const newest = await trimming.read(SESSION, 147, 5);
    assert.deepStrictEqual(newest.lines, ['n147', 'n148', 'n149']);
  });

  it('clamps a request for lines that fell off the back', async function () {
    const trimming = new HistoryStore({
      storageDir: dir,
      maxLines: 100,
      trimChunkLines: 40,
    });
    await appendAndSettle(
      trimming,
      SESSION,
      Array.from({ length: 150 }, (_, index) => `n${index}`),
    );

    const page = await trimming.read(SESSION, 0, 5);
    assert.strictEqual(page.fromLine, 40, 'must clamp forward to the oldest kept line');
    assert.deepStrictEqual(page.lines, ['n40', 'n41', 'n42', 'n43', 'n44']);
  });

  it('survives a restart by reading the index back off disk', async function () {
    await appendAndSettle(store, SESSION, ['prima', 'seconda', 'terza']);

    const reopened = new HistoryStore({ storageDir: dir });
    assert.deepStrictEqual(await reopened.stat(SESSION), { firstLine: 0, totalLines: 3 });
    const page = await reopened.read(SESSION, 1, 2);
    assert.deepStrictEqual(page.lines, ['seconda', 'terza']);

    await appendAndSettle(reopened, SESSION, ['quarta']);
    const grown = await reopened.read(SESSION, 0, 10);
    assert.deepStrictEqual(grown.lines, ['prima', 'seconda', 'terza', 'quarta']);
  });

  it('keeps one user out of another user\'s files', async function () {
    await appendAndSettle(store, { id: 'shared-id', ownerUserId: 1 }, ['segreto']);
    await appendAndSettle(store, { id: 'shared-id', ownerUserId: 2 }, ['altro']);

    const first = await store.read({ id: 'shared-id', ownerUserId: 1 }, 0, 10);
    const second = await store.read({ id: 'shared-id', ownerUserId: 2 }, 0, 10);
    assert.deepStrictEqual(first.lines, ['segreto']);
    assert.deepStrictEqual(second.lines, ['altro']);
  });

  it('removes both files on delete', async function () {
    await appendAndSettle(store, SESSION, ['x']);
    const base = path.join(dir, 'history', '7', 'sess-1');
    assert.ok(fs.existsSync(`${base}.log`));

    await store.deleteHistory(SESSION);
    assert.ok(!fs.existsSync(`${base}.log`));
    assert.ok(!fs.existsSync(`${base}.idx`));
    assert.deepStrictEqual(await store.stat(SESSION), { firstLine: 0, totalLines: 0 });
  });

  it('does not interleave concurrent appends', async function () {
    for (let batch = 0; batch < 20; batch++) {
      store.append(SESSION, [`b${batch}-a`, `b${batch}-b`]);
    }
    await store.stat(SESSION);

    const page = await store.read(SESSION, 0, 100);
    assert.strictEqual(page.lines.length, 40);
    for (let batch = 0; batch < 20; batch++) {
      assert.strictEqual(page.lines[batch * 2], `b${batch}-a`);
      assert.strictEqual(page.lines[batch * 2 + 1], `b${batch}-b`);
    }
  });

  it('uses a workspace-local history file and keeps it readable after restart', async function () {
    const local = { id: 'local', ownerUserId: 7, storageRoot: dir, ownerKey: 'stable-owner' };
    await appendAndSettle(store, local, ['kept locally']);

    const base = path.join(dir, '.cc-web', 'sessions', 'stable-owner', 'local', 'history');
    assert.ok(fs.existsSync(`${base}.log`));
    assert.ok(!fs.existsSync(path.join(dir, 'history', '7', 'local.log')));

    const reopened = new HistoryStore({ storageDir: path.join(dir, 'old-storage') });
    assert.deepStrictEqual((await reopened.read(local, 0, 10)).lines, ['kept locally']);
  });
});
