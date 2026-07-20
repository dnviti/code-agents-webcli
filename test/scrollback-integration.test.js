const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pty = require('node-pty');
const { ScrollbackRecorder } = require('../dist/server/services/scrollback.js');
const { HistoryStore } = require('../dist/server/services/history-store.js');

const SESSION = { id: 'integrazione', ownerUserId: 42 };

/**
 * End-to-end through the real pipeline: a real PTY writes real output, the
 * recorder rebuilds the scrollback from the byte stream, the store persists it,
 * and pages are read back. Unit tests feed the recorder synthetic strings; this
 * one exercises the chunking a kernel PTY actually produces.
 */
describe('scrollback integration (real PTY)', function () {
  this.timeout(30000);

  let dir;
  let store;

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-e2e-'));
    store = new HistoryStore({ storageDir: dir });
  });

  afterEach(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function runThroughPty(command, cols = 100, rows = 30) {
    return new Promise((resolve, reject) => {
      const gaps = [];
      const recorder = new ScrollbackRecorder({
        cols,
        rows,
        onLines: (lines) => store.append(SESSION, lines),
        onGap: (dropped) => gaps.push(dropped),
      });

      const term = pty.spawn('/bin/bash', ['-lc', command], {
        cols,
        rows,
        name: 'xterm-256color',
        env: { ...process.env, TERM: 'xterm-256color' },
      });

      term.onData((data) => recorder.write(data));
      term.onExit(() => {
        // Wait for the parser rather than for a timeout: on a loaded machine a
        // fixed delay leaves output still queued, and the counts come out short.
        void recorder.drain().then(() => {
          recorder.dispose();
          resolve({ gaps });
        });
      });

      setTimeout(() => reject(new Error('PTY timed out')), 25000);
    });
  }

  it('reconstructs a long output stream page by page', async function () {
    const { gaps } = await runThroughPty('for i in $(seq 1 4000); do echo "riga $i"; done');
    assert.deepStrictEqual(gaps, [], 'no history should have been dropped');

    // 4000 echoed lines, 30 rows on screen: everything above the last screen
    // is final, the rest is still live and arrives via the normal replay.
    const stats = await store.stat(SESSION);
    assert.strictEqual(stats.totalLines, 4000 - 30 + 1);

    // Walk the whole history in screen-sized pages, exactly as the client does.
    const seen = [];
    for (let cursor = stats.firstLine; cursor < stats.totalLines; ) {
      const page = await store.read(SESSION, cursor, 30);
      assert.ok(page.lines.length > 0, `empty page at ${cursor}`);
      assert.strictEqual(page.fromLine, cursor, 'pages must be contiguous');
      seen.push(...page.lines);
      cursor += page.lines.length;
    }

    const numbered = seen.filter((line) => /^riga \d+$/.test(line));
    assert.strictEqual(numbered.length, 3971);
    // Every line present exactly once, in order, with no gaps.
    numbered.forEach((line, index) => {
      assert.strictEqual(line, `riga ${index + 1}`);
    });
  });

  it('keeps colour through the whole pipeline', async function () {
    await runThroughPty(
      'printf "\\033[1;31mROSSO\\033[0m normale\\n"; for i in $(seq 1 60); do echo "pad $i"; done',
    );

    const stats = await store.stat(SESSION);
    const page = await store.read(SESSION, stats.firstLine, 5);
    const coloured = page.lines.find((line) => line.includes('ROSSO'));
    assert.ok(coloured, 'the coloured line should be stored');
    assert.ok(/\x1b\[[0-9;]*1;/.test(coloured), `bold should survive: ${JSON.stringify(coloured)}`);
    assert.ok(coloured.includes('normale'));
  });

  it('does not record a full-screen program\'s redraws', async function () {
    // Enter the alternate screen, paint, leave. Only the surrounding shell
    // output belongs in history.
    await runThroughPty(
      'echo "prima"; printf "\\033[?1049h"; for i in $(seq 1 300); do echo "schermo $i"; done; ' +
        'printf "\\033[?1049l"; echo "dopo"; for i in $(seq 1 60); do echo "pad $i"; done',
    );

    const stats = await store.stat(SESSION);
    const all = [];
    for (let cursor = stats.firstLine; cursor < stats.totalLines; ) {
      const page = await store.read(SESSION, cursor, 200);
      if (page.lines.length === 0) break;
      all.push(...page.lines);
      cursor += page.lines.length;
    }

    assert.ok(
      !all.some((line) => line.includes('schermo ')),
      'alternate-screen output must not reach history',
    );
    assert.ok(all.some((line) => line.includes('prima')));
    assert.ok(all.some((line) => line.includes('dopo')));
  });

  it('paging cost does not grow with session length', async function () {
    await runThroughPty('for i in $(seq 1 20000); do echo "voce $i"; done');
    const stats = await store.stat(SESSION);
    assert.ok(stats.totalLines > 15000, `expected a long session, got ${stats.totalLines}`);

    const timeOne = async (from) => {
      const started = process.hrtime.bigint();
      const page = await store.read(SESSION, from, 40);
      return { ms: Number(process.hrtime.bigint() - started) / 1e6, page };
    };

    const early = await timeOne(stats.firstLine + 10);
    const late = await timeOne(stats.totalLines - 60);

    assert.strictEqual(early.page.lines.length, 40);
    assert.strictEqual(late.page.lines.length, 40);
    // A scan-based implementation would make the deep read dramatically slower.
    assert.ok(
      late.ms < 50 && early.ms < 50,
      `reads should be immediate anywhere in history (early ${early.ms}ms, late ${late.ms}ms)`,
    );
  });
});
