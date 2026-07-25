const assert = require('assert');
const { ScrollbackRecorder } = require('../dist/server/services/scrollback.js');

// The recorder flushes from the emulator's write callback, so give the parser
// a turn before asserting.
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function makeRecorder(options = {}) {
  const lines = [];
  const gaps = [];
  const recorder = new ScrollbackRecorder({
    cols: 80,
    rows: 5,
    onLines: (batch) => lines.push(...batch),
    onGap: (dropped) => gaps.push(dropped),
    ...options,
  });
  return { recorder, lines, gaps };
}

/**
 * An Ink-style render pass: pull the cursor back to the top of the screen,
 * erase everything below, and rewrite the entire frame. This is what agent
 * CLIs do on every state change — every keystroke, every spinner tick.
 */
function renderFrame(frameLines) {
  return `\x1b[4A\x1b[J${frameLines.join('\r\n')}\r\n`;
}

const duplicatesOf = (lines) => {
  const seen = new Set();
  const dupes = new Set();
  for (const line of lines) {
    if (line && seen.has(line)) {
      dupes.add(line);
    }
    seen.add(line);
  }
  return [...dupes];
};

describe('ScrollbackRecorder with repainting programs', function () {
  it('records one copy of a frame that is redrawn taller than the screen', async function () {
    const { recorder, lines, gaps } = makeRecorder();
    const frame = Array.from({ length: 12 }, (_, i) => `frame line ${i}`);

    // First render: plain output, the frame's top scrolls off once.
    recorder.write(`${frame.join('\r\n')}\r\n`);
    await settle();
    const afterFirst = lines.length;
    assert.ok(afterFirst > 0, 'the first frame should have scrolled partly into history');

    // Second render, one character changed near the bottom (on screen): the
    // whole frame is rewritten and its top scrolls off AGAIN. None of it is new.
    const changed = [...frame];
    changed[11] = 'frame line 11!';
    recorder.write(renderFrame(changed));
    await settle();

    assert.strictEqual(lines.length, afterFirst, 'the redraw must not add duplicate lines');
    assert.deepStrictEqual(gaps, []);
    recorder.dispose();
  });

  it('keeps the genuinely new lines a redraw scrolls off', async function () {
    const { recorder, lines } = makeRecorder();
    const frame = Array.from({ length: 12 }, (_, i) => `riga ${i}`);

    recorder.write(`${frame.join('\r\n')}\r\n`);
    await settle();
    const afterFirst = lines.length;

    // The frame grows by one line: the redraw scrolls the old top off again
    // plus the one line the growth pushed above the viewport. Everything else
    // of the new frame is still on screen and rightly not final yet.
    const grown = [...frame, 'riga 12'];
    recorder.write(renderFrame(grown));
    await settle();

    assert.strictEqual(lines.length, afterFirst + 1, 'only the newly final line is added');
    assert.strictEqual(lines[lines.length - 1], 'riga 8');
    assert.deepStrictEqual(duplicatesOf(lines), []);
    recorder.dispose();
  });

  it('collapses a whole conversation of keystroke redraws to a clean transcript', async function () {
    const { recorder, lines } = makeRecorder();
    const banner = Array.from({ length: 9 }, (_, i) => `banner ${i}`);

    // Every keystroke re-renders the whole frame: banner + the input line so
    // far. The frame is taller than the 5-row screen, so each render scrolls
    // the banner's top into history again.
    const typed = ['h', 'he', 'hel', 'hell', 'hello'];
    let first = true;
    for (const text of typed) {
      const frame = [...banner, `input: ${text}`];
      recorder.write(first ? `${frame.join('\r\n')}\r\n` : renderFrame(frame));
      first = false;
      await settle();
    }

    // Submitting turns the input into a static message; follow-up output
    // then pushes the frame down until the submitted line itself scrolls off.
    const submitted = [...banner, 'input: hello', 'answer: world'];
    recorder.write(renderFrame(submitted));
    await settle();
    for (let i = 0; i < 10; i++) {
      recorder.write(`follow up ${i}\r\n`);
    }
    await settle();

    const bannerLines = lines.filter((line) => line.startsWith('banner '));
    assert.strictEqual(
      new Set(bannerLines).size,
      bannerLines.length,
      `banner lines were duplicated: ${JSON.stringify(lines)}`,
    );
    assert.deepStrictEqual(
      lines.filter((line) => line.startsWith('input: ')),
      ['input: hello'],
      'only the final submitted line may be recorded, never one per keystroke',
    );
    recorder.dispose();
  });

  it('never collapses a genuine repeat in a plain output stream', async function () {
    const { recorder, lines, gaps } = makeRecorder();
    // No cursor-up, no erase: a program that honestly prints the same block
    // twice. Both copies are the faithful transcript and must survive.
    const block = 'alpha\r\nbeta\r\ngamma\r\n';
    recorder.write(block.repeat(30));
    await settle();

    assert.deepStrictEqual(gaps, []);
    const gammas = lines.filter((line) => line === 'gamma').length;
    assert.ok(gammas > 1, `genuine repeats must not be collapsed, got ${gammas} gamma lines`);
    // Order intact: every alpha is followed by beta then gamma.
    for (let i = 0; i + 2 < lines.length; i += 3) {
      assert.strictEqual(lines[i], 'alpha');
      assert.strictEqual(lines[i + 1], 'beta');
      assert.strictEqual(lines[i + 2], 'gamma');
    }
    recorder.dispose();
  });

  it('neutralizes ED 3: a program wiping its scrollback is neither a gap nor a loss', async function () {
    const { recorder, lines, gaps } = makeRecorder({ rows: 10 });
    for (let i = 0; i < 30; i++) {
      recorder.write(`before ${i}\r\n`);
    }
    await settle();
    const beforeErase = lines.length;
    assert.ok(beforeErase > 0);

    // The store is a transcript: a program erasing its own scrollback must
    // not delete recorded history, must not report a recording gap, and must
    // not disturb the line accounting for what follows.
    recorder.write('\x1b[3J');
    await settle();
    for (let i = 0; i < 12; i++) {
      recorder.write(`after ${i}\r\n`);
    }
    await settle();

    assert.deepStrictEqual(gaps, [], 'a program-requested erase is not a recording gap');
    assert.strictEqual(lines[0], 'before 0');
    assert.strictEqual(lines[beforeErase - 1], `before ${beforeErase - 1}`);
    assert.ok(lines.includes('after 0'), 'output after the erase keeps recording');
    assert.deepStrictEqual(duplicatesOf(lines), []);
    // Contiguous numbering: every recorded line is exactly one past the last.
    const afters = lines.filter((line) => line.startsWith('after '));
    for (let i = 1; i < afters.length; i++) {
      assert.strictEqual(afters[i], `after ${i}`);
    }
    recorder.dispose();
  });

  it('ignores an ED 3 issued while a full-screen program owns the alternate screen', async function () {
    const { recorder, lines, gaps } = makeRecorder({ rows: 10 });
    for (let i = 0; i < 25; i++) {
      recorder.write(`prima ${i}\r\n`);
    }
    await settle();
    const before = lines.length;

    // A TUI that clears scrollback on entry and exit: neither may disturb the
    // normal buffer's transcript or its accounting.
    recorder.write('\x1b[?1049h\x1b[3J');
    for (let i = 0; i < 30; i++) {
      recorder.write(`tui frame ${i}\r\n`);
    }
    recorder.write('\x1b[3J\x1b[?1049l');
    await settle();
    for (let i = 0; i < 15; i++) {
      recorder.write(`dopo ${i}\r\n`);
    }
    await settle();

    assert.deepStrictEqual(gaps, []);
    assert.ok(!lines.some((line) => line.includes('tui frame')), 'the TUI must not leak');
    assert.deepStrictEqual(duplicatesOf(lines), [], 'no re-emission across the ED 3');
    assert.strictEqual(lines[0], 'prima 0');
    assert.ok(lines.includes('prima 24'), 'the wipe did not erase recorded history');
    assert.ok(lines.includes('dopo 0'), 'recording continues after the TUI');
    assert.ok(lines.length > before, 'post-TUI output was recorded');
    recorder.dispose();
  });

  it('does not leak the redraw gate out of a write that was only an ED 3', async function () {
    const { recorder, lines, gaps } = makeRecorder({ rows: 5 });
    recorder.write('primo blocco\r\n');
    for (let i = 0; i < 8; i++) {
      recorder.write(`pad ${i}\r\n`);
    }
    await settle();

    // A write that contains nothing but the wipe: stripped to empty, it must
    // not arm the collapse gate for whatever flushes next.
    recorder.write('\x1b[3J');
    await settle();

    // A plain program genuinely prints the same line again — no repaint
    // sequences anywhere. Both copies must survive.
    recorder.write('primo blocco\r\n');
    for (let i = 0; i < 8; i++) {
      recorder.write(`coda ${i}\r\n`);
    }
    await settle();

    assert.deepStrictEqual(gaps, []);
    assert.strictEqual(
      lines.filter((line) => line === 'primo blocco').length,
      2,
      'a genuine repeat after an emptied write must not be collapsed',
    );
    recorder.dispose();
  });

  it('collapses splash re-renders even across chunked writes', async function () {
    const { recorder, lines } = makeRecorder();
    const frame = Array.from({ length: 10 }, (_, i) => `splash ${i}`);

    recorder.write(`${frame.join('\r\n')}\r\n`);
    await settle();
    const afterFirst = lines.length;

    // The same redraw arriving in two chunks — PTYs split large frames at
    // arbitrary byte boundaries, and the redraw signal rides the first chunk.
    const redraw = renderFrame(frame);
    recorder.write(redraw.slice(0, redraw.length >> 1));
    recorder.write(redraw.slice(redraw.length >> 1));
    await settle();

    assert.strictEqual(lines.length, afterFirst, 'a chunked redraw must still collapse');
    recorder.dispose();
  });
});
