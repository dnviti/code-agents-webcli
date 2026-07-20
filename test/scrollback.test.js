const assert = require('assert');
const { ScrollbackRecorder, serializeBufferLine } = require('../dist/server/services/scrollback.js');

// The recorder flushes from the emulator's write callback, so give the parser
// a turn before asserting.
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function makeRecorder(options = {}) {
  const lines = [];
  const gaps = [];
  const recorder = new ScrollbackRecorder({
    cols: 80,
    rows: 10,
    onLines: (batch) => lines.push(...batch),
    onGap: (dropped) => gaps.push(dropped),
    ...options,
  });
  return { recorder, lines, gaps };
}

describe('ScrollbackRecorder', function () {
  it('captures every line that scrolls off, in order', async function () {
    const { recorder, lines, gaps } = makeRecorder();
    for (let i = 0; i < 500; i++) {
      recorder.write(`riga ${i}\r\n`);
    }
    await settle();

    assert.deepStrictEqual(gaps, []);
    // 500 newlines leave the cursor on an empty 501st line, so 9 of the 10
    // rows on screen hold real text and everything above them is final.
    assert.strictEqual(lines.length, 491);
    assert.strictEqual(lines[0], 'riga 0');
    assert.strictEqual(lines[490], 'riga 490');
    recorder.dispose();
  });

  it('keeps counting correctly after the emulator evicts lines', async function () {
    // Emulator holds far fewer lines than we write, so eviction is guaranteed:
    // this is the case where a naive baseY-based counter silently loses history.
    const { recorder, lines, gaps } = makeRecorder({ emulatorScrollback: 20 });
    for (let i = 0; i < 400; i++) {
      recorder.write(`r${i}\r\n`);
      if (i % 7 === 0) {
        await settle();
      }
    }
    await settle();

    assert.deepStrictEqual(gaps, [], 'no line should have been dropped');
    assert.strictEqual(lines.length, 391);
    assert.ok(
      lines.every((line, index) => line === `r${index}`),
      'lines must stay in order with no duplicates or holes',
    );
    recorder.dispose();
  });

  it('reports a gap instead of silently corrupting when output outruns it', async function () {
    const { recorder, lines, gaps } = makeRecorder({ emulatorScrollback: 5 });
    let burst = '';
    for (let i = 0; i < 300; i++) {
      burst += `x${i}\r\n`;
    }
    recorder.write(burst);
    await settle();

    // The anchor marker is evicted along with the lines, so the count is not
    // recoverable — but the loss must still be reported, never swallowed.
    assert.ok(gaps.length > 0, 'a dropped-line gap should be reported');
    assert.ok(gaps.every((gap) => gap === null || gap > 0));
    // Whatever survived must still be contiguous and correctly ordered.
    const numbers = lines.map((line) => Number(line.slice(1)));
    for (let i = 1; i < numbers.length; i++) {
      assert.strictEqual(numbers[i], numbers[i - 1] + 1);
    }
    recorder.dispose();
  });

  it('preserves colour and attributes as self-contained ANSI', async function () {
    const { recorder, lines } = makeRecorder();
    recorder.write('\x1b[1;31mrosso grassetto\x1b[0m normale\r\n');
    for (let i = 0; i < 12; i++) {
      recorder.write(`pad ${i}\r\n`);
    }
    await settle();

    const first = lines[0];
    // Must start from a reset: the history viewer has seen no prior output.
    assert.ok(first.startsWith('\x1b[0;'), `expected a reset-prefixed line, got ${JSON.stringify(first)}`);
    assert.ok(first.includes('rosso grassetto'));
    assert.ok(/\x1b\[0;1;38;5;1m/.test(first), 'bold + red should survive');
    assert.ok(first.includes('normale'));
    recorder.dispose();
  });

  it('does not let a full-screen TUI leak into history', async function () {
    const { recorder, lines } = makeRecorder();
    recorder.write('prima della TUI\r\n');
    for (let i = 0; i < 12; i++) {
      recorder.write(`pad ${i}\r\n`);
    }
    await settle();
    const before = lines.length;

    recorder.write('\x1b[?1049h');
    for (let i = 0; i < 200; i++) {
      recorder.write(`redraw ${i}\r\n`);
    }
    await settle();
    recorder.write('\x1b[?1049l');
    await settle();

    assert.strictEqual(lines.length, before, 'alternate screen output must not be recorded');
    assert.ok(!lines.some((line) => line.includes('redraw')));
    recorder.dispose();
  });

  it('emits a wide character once, not twice', async function () {
    const { recorder, lines } = makeRecorder();
    recorder.write('日本語 ok\r\n');
    for (let i = 0; i < 12; i++) {
      recorder.write(`pad ${i}\r\n`);
    }
    await settle();

    assert.strictEqual(lines[0], '日本語 ok');
    recorder.dispose();
  });

  it('records what a program redrew, not every intermediate frame', async function () {
    // A spinner overwrites its own line; only the final state should survive.
    const { recorder, lines } = makeRecorder();
    for (const frame of ['|', '/', '-', '\\']) {
      recorder.write(`\rlavoro ${frame}`);
    }
    recorder.write('\rlavoro fatto\r\n');
    for (let i = 0; i < 12; i++) {
      recorder.write(`pad ${i}\r\n`);
    }
    await settle();

    assert.strictEqual(lines[0], 'lavoro fatto');
    recorder.dispose();
  });

  it('serializes a blank line as an empty string', function () {
    const fake = {
      length: 3,
      getCell: () => ({
        getChars: () => ' ',
        getWidth: () => 1,
        getFgColor: () => 0,
        getBgColor: () => 0,
        isFgRGB: () => false,
        isBgRGB: () => false,
        isFgPalette: () => false,
        isBgPalette: () => false,
        isFgDefault: () => true,
        isBgDefault: () => true,
        isBold: () => 0,
        isItalic: () => 0,
        isUnderline: () => 0,
        isDim: () => 0,
        isInverse: () => 0,
        isInvisible: () => 0,
        isStrikethrough: () => 0,
        isBlink: () => 0,
      }),
    };
    assert.strictEqual(serializeBufferLine(fake), '');
  });
});
