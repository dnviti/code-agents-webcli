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

  const SENTINEL = 'FINE-SENTINELLA';

  /**
   * Run a command and wait until its output has actually arrived.
   *
   * Waiting on the PTY's exit event is not enough: it can fire while output is
   * still in flight, so on a loaded machine the recorder simply never sees the
   * tail. The command echoes a sentinel last, and we wait for that to reach the
   * emulator's screen before reading anything.
   */
  function runThroughPty(command, cols = 100, rows = 30) {
    return new Promise((resolve, reject) => {
      const gaps = [];
      const recorder = new ScrollbackRecorder({
        cols,
        rows,
        onLines: (lines) => store.append(SESSION, lines),
        onGap: (dropped) => gaps.push(dropped),
      });

      // Deliberately not a login shell: `-l` sources the system and user
      // profiles, which on a CI image pull in version managers and can take
      // tens of seconds on the first invocation. Nothing here needs them.
      const term = pty.spawn('/bin/bash', ['-c', `${command}; echo "${SENTINEL}"`], {
        cols,
        rows,
        name: 'xterm-256color',
        env: { ...process.env, TERM: 'xterm-256color' },
      });

      let bytes = 0;
      let chunks = 0;
      let exitInfo = null;
      term.onData((data) => {
        bytes += data.length;
        chunks += 1;
        recorder.write(data);
      });
      term.onExit((e) => { exitInfo = e; });

      let settled = false;
      const finish = async (error) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(bail);
        await recorder.drain();
        const screen = recorder.snapshotScreen();
        recorder.dispose();
        try { term.kill(); } catch { /* already gone */ }
        if (error) reject(error);
        else resolve({ gaps, screen });
      };

      const poll = setInterval(() => {
        if (recorder.snapshotScreen().some((line) => line.includes(SENTINEL))) {
          void finish();
        }
      }, 20);

      const bail = setTimeout(() => {
        const screen = recorder.snapshotScreen();
        void finish(
          new Error(
            `the sentinel never arrived. chunks=${chunks} bytes=${bytes} ` +
              `exit=${JSON.stringify(exitInfo)} screenLines=${screen.length} ` +
              `lastScreen=${JSON.stringify(screen.slice(-3))} ` +
              `firstScreen=${JSON.stringify(screen.slice(0, 2))}`,
          ),
        );
      }, 25000);
    });
  }

  it('reconstructs a long output stream page by page', async function () {
    const { gaps } = await runThroughPty('for i in $(seq 1 4000); do echo "riga $i"; done');
    assert.deepStrictEqual(gaps, [], 'no history should have been dropped');

    // The sentinel proves every line was delivered, so the count is exact:
    // 4000 lines plus the sentinel, minus the screenful still live.
    const stats = await store.stat(SESSION);
    assert.strictEqual(stats.totalLines, 4001 - 30 + 1);

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
    assert.strictEqual(numbered.length, 3972);
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
