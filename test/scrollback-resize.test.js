const assert = require('assert');
const { ScrollbackRecorder } = require('../dist/server/services/scrollback.js');

const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

/**
 * Resizing is the case where the line accounting is easiest to get wrong: a
 * row-count change moves lines between the screen and the scrollback, and an
 * emulator-relative counter cannot tell that apart from new output.
 */
describe('ScrollbackRecorder across resizes', function () {
  async function exercise({ startRows, endRows, cols = 80, alt = false }) {
    const lines = [];
    const gaps = [];
    const recorder = new ScrollbackRecorder({
      cols,
      rows: startRows,
      onLines: (batch) => lines.push(...batch),
      onGap: (dropped) => gaps.push(dropped),
    });

    for (let i = 0; i < 40; i++) {
      recorder.write(`a${i}\r\n`);
    }
    await settle();

    if (alt) {
      recorder.write('\x1b[?1049h');
      await settle();
    }

    recorder.resize(cols, endRows);
    await settle();

    if (alt) {
      recorder.write('\x1b[?1049l');
      await settle();
    }

    for (let i = 0; i < 40; i++) {
      recorder.write(`b${i}\r\n`);
    }
    await settle();
    recorder.flush();
    recorder.dispose();

    const duplicated = lines.length - new Set(lines).size;
    const written = [];
    for (let i = 0; i < 40; i++) written.push(`a${i}`);
    for (let i = 0; i < 40; i++) written.push(`b${i}`);
    // Lines still on screen at the end are legitimately not in history yet.
    const onScreen = new Set(written.slice(-endRows));
    const lost = written.filter((line) => !lines.includes(line) && !onScreen.has(line));

    return { lines, gaps, duplicated, lost };
  }

  const shrinks = [
    { startRows: 24, endRows: 20 },
    { startRows: 24, endRows: 12 },
    { startRows: 30, endRows: 10 },
    { startRows: 50, endRows: 6 },
  ];

  shrinks.forEach(({ startRows, endRows }) => {
    it(`loses nothing when rows shrink ${startRows}->${endRows}`, async function () {
      const { lost, gaps } = await exercise({ startRows, endRows });
      assert.deepStrictEqual(lost, [], `lines disappeared from history: ${lost.join(',')}`);
      assert.deepStrictEqual(gaps, [], 'no gap should be reported for an ordinary resize');
    });
  });

  const grows = [
    { startRows: 10, endRows: 24 },
    { startRows: 10, endRows: 40 },
    { startRows: 6, endRows: 50 },
  ];

  grows.forEach(({ startRows, endRows }) => {
    it(`duplicates nothing when rows grow ${startRows}->${endRows}`, async function () {
      const { duplicated, lines } = await exercise({ startRows, endRows });
      assert.strictEqual(duplicated, 0, `history physically contains repeats: ${lines.length} lines`);
    });
  });

  it('keeps a column-only resize clean', async function () {
    const { lost, duplicated } = await exercise({ startRows: 24, endRows: 24, cols: 100 });
    assert.deepStrictEqual(lost, []);
    assert.strictEqual(duplicated, 0);
  });

  it('survives a resize while a full-screen program owns the screen', async function () {
    // Claude Code's own UI uses the alternate screen, so "resize the browser
    // while it is running" goes straight through here.
    const { lost, duplicated, gaps } = await exercise({
      startRows: 10,
      endRows: 30,
      cols: 80,
      alt: true,
    });
    assert.strictEqual(duplicated, 0, 'the alternate buffer must not re-emit normal scrollback');
    assert.deepStrictEqual(gaps, [], 'no history was actually dropped, so none should be reported');
    assert.deepStrictEqual(lost, []);
  });

  it('does not lose the tail when a session ends on the alternate screen', async function () {
    const lines = [];
    const recorder = new ScrollbackRecorder({
      cols: 80,
      rows: 10,
      onLines: (batch) => lines.push(...batch),
    });

    // Same chunk: the flush callback fires with the alternate screen already
    // active, so a flush that reads the *active* buffer sees nothing to do.
    let payload = '';
    for (let i = 0; i < 30; i++) payload += `coda ${i}\r\n`;
    payload += '\x1b[?1049h';
    recorder.write(payload);
    await settle();

    recorder.flush();
    const captured = [...lines];
    const snapshot = recorder.snapshotScreen();
    recorder.dispose();

    const recovered = new Set([...captured, ...snapshot]);
    const missing = [];
    for (let i = 0; i < 30; i++) {
      if (!recovered.has(`coda ${i}`)) missing.push(`coda ${i}`);
    }
    assert.deepStrictEqual(missing, [], 'output before the TUI started must survive');
  });
});
