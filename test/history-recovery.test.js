const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { HistoryStore } = require('../dist/server/services/history-store.js');

const SESSION = { id: 'recupero', ownerUserId: 3 };

/**
 * The log and the index are two separate appends, so a crash or a failed write
 * can leave them disagreeing. Nothing at read time notices — offsets are taken
 * on trust — so the store has to reconcile them when it next opens the files.
 */
describe('HistoryStore recovery from a desynced index', function () {
  let dir;
  let base;

  beforeEach(async function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-recover-'));
    base = path.join(dir, 'history', '3', 'recupero');

    const store = new HistoryStore({ storageDir: dir });
    store.append(SESSION, ['AAA-0', 'AAA-1']);
    await store.stat(SESSION);
  });

  afterEach(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Bytes reached the log but the matching index entries never did. */
  function stripeLogOnly(lines) {
    fs.appendFileSync(`${base}.log`, lines.map((line) => `${line}\n`).join(''), 'utf8');
  }

  it('reaches lines the index never recorded', async function () {
    stripeLogOnly(['ORFANA-A', 'ORFANA-B']);

    const reopened = new HistoryStore({ storageDir: dir });
    const stats = await reopened.stat(SESSION);
    assert.strictEqual(stats.totalLines, 4, 'the orphaned lines should be indexed again');

    const page = await reopened.read(SESSION, 0, 10);
    assert.deepStrictEqual(page.lines, ['AAA-0', 'AAA-1', 'ORFANA-A', 'ORFANA-B']);
  });

  it('does not shadow orphaned lines with later appends', async function () {
    // This was the damaging part: the next append computed offsets from a
    // stale size, writing new data over the orphans' line numbers so that
    // both the new and the old lines were unreadable.
    stripeLogOnly(['ORFANA-A', 'ORFANA-B']);

    const reopened = new HistoryStore({ storageDir: dir });
    reopened.append(SESSION, ['NUOVA-0', 'NUOVA-1']);
    await reopened.stat(SESSION);

    const page = await reopened.read(SESSION, 0, 20);
    assert.deepStrictEqual(page.lines, [
      'AAA-0',
      'AAA-1',
      'ORFANA-A',
      'ORFANA-B',
      'NUOVA-0',
      'NUOVA-1',
    ]);
  });

  it('drops a record torn mid-write rather than serving half a line', async function () {
    fs.appendFileSync(`${base}.log`, 'COMPLETA\nTRONC', 'utf8');

    const reopened = new HistoryStore({ storageDir: dir });
    const page = await reopened.read(SESSION, 0, 10);
    assert.deepStrictEqual(page.lines, ['AAA-0', 'AAA-1', 'COMPLETA']);

    // And the store keeps working afterwards.
    reopened.append(SESSION, ['DOPO']);
    await reopened.stat(SESSION);
    const grown = await reopened.read(SESSION, 0, 10);
    assert.deepStrictEqual(grown.lines, ['AAA-0', 'AAA-1', 'COMPLETA', 'DOPO']);
  });

  it('rebuilds an index that was lost entirely', async function () {
    const header = fs.readFileSync(`${base}.idx`).subarray(0, 16);
    fs.writeFileSync(`${base}.idx`, header);

    const reopened = new HistoryStore({ storageDir: dir });
    const page = await reopened.read(SESSION, 0, 10);
    assert.deepStrictEqual(page.lines, ['AAA-0', 'AAA-1']);
  });

  it('resets an index that describes lines an empty log does not have', async function () {
    fs.writeFileSync(`${base}.log`, '');

    const reopened = new HistoryStore({ storageDir: dir });
    assert.deepStrictEqual(await reopened.stat(SESSION), { firstLine: 0, totalLines: 0 });

    reopened.append(SESSION, ['ricominciamo']);
    await reopened.stat(SESSION);
    const page = await reopened.read(SESSION, 0, 10);
    assert.deepStrictEqual(page.lines, ['ricominciamo']);
  });

  it('reads one line, not the whole log, when nothing is wrong', async function () {
    const store = new HistoryStore({ storageDir: dir });
    store.append(SESSION, Array.from({ length: 20000 }, (_, i) => `riga ${i}`));
    await store.stat(SESSION);

    const reopened = new HistoryStore({ storageDir: dir });
    const started = process.hrtime.bigint();
    const stats = await reopened.stat(SESSION);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;

    assert.strictEqual(stats.totalLines, 20002);
    assert.ok(ms < 40, `opening a healthy store should be immediate, took ${ms}ms`);
  });
});
