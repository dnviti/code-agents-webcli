import { Terminal } from '@xterm/headless';
import type { IBufferCell, IBufferLine, IMarker } from '@xterm/headless';

/**
 * Rebuilds the terminal scrollback server-side.
 *
 * The raw PTY stream cannot be paginated directly: a slice taken from the
 * middle of it starts inside an escape sequence and carries none of the cursor
 * or colour state that produced it, so it renders as garbage. To page through
 * history we need *finalised lines*, which means running the same terminal
 * emulator the browser runs — @xterm/headless, pinned to the client's major
 * version so a line looks identical on both sides.
 *
 * Only lines that have scrolled off the screen are emitted: those can no longer
 * be repainted by the program, so they are safe to freeze. The alternate screen
 * buffer is isolated by the emulator, so full-screen TUIs never leak into
 * history.
 */

const DEFAULT_EMULATOR_SCROLLBACK = 5000;

export interface ScrollbackRecorderOptions {
  cols?: number;
  rows?: number;
  /**
   * How many scrolled-off lines the emulator may hold between flushes. Lines
   * are flushed on every write, so this only needs to absorb the largest single
   * burst; beyond it the emulator drops the oldest lines and we record a gap.
   */
  emulatorScrollback?: number;
  onLines: (lines: string[]) => void;
  /** `null` when lines were lost but the count could not be determined. */
  onGap?: (droppedLines: number | null) => void;
}

export class ScrollbackRecorder {
  private readonly terminal: Terminal;
  private readonly onLines: (lines: string[]) => void;
  private readonly onGap: (droppedLines: number | null) => void;

  /** Absolute number of lines already handed to `onLines`. */
  private persisted = 0;
  /** Absolute index of buffer line 0. */
  private absoluteBase = 0;
  private marker: IMarker | undefined;
  private markerAbsolute = 0;
  private flushScheduled = false;
  private disposed = false;

  constructor(options: ScrollbackRecorderOptions) {
    this.onLines = options.onLines;
    this.onGap = options.onGap ?? (() => {});
    this.terminal = new Terminal({
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      scrollback: options.emulatorScrollback ?? DEFAULT_EMULATOR_SCROLLBACK,
      allowProposedApi: true,
    });

    // Anchor before any output arrives, so the very first flush can already
    // tell "nothing was evicted" apart from "the anchor is gone".
    this.anchorMarker();
  }

  write(data: string): void {
    if (this.disposed || !data) {
      return;
    }

    // The parser runs asynchronously, so the buffer is only settled once the
    // write callback fires. Coalesce: one flush covers every write that landed
    // before it ran.
    this.terminal.write(data, () => {
      if (this.flushScheduled || this.disposed) {
        return;
      }
      this.flushScheduled = true;
      queueMicrotask(() => {
        this.flushScheduled = false;
        this.flush();
      });
    });
  }

  /**
   * A row-count change moves lines across the screen/scrollback boundary in
   * both directions: shrinking pushes visible lines down into scrollback,
   * growing pulls stored lines back up onto the screen.
   *
   * Freeze what is final, resize, then let the marker report where the buffer
   * now starts. Re-deriving the anchor from the new `baseY` instead — as this
   * did — declares everything above the new viewport already persisted, which
   * silently drops exactly the lines that just moved down (and re-emits the
   * ones that moved up).
   */
  resize(cols: number, rows: number): void {
    if (this.disposed || cols <= 0 || rows <= 0) {
      return;
    }

    if (cols === this.terminal.cols && rows === this.terminal.rows) {
      return;
    }

    this.flush();
    this.terminal.resize(cols, rows);
    this.flush();
  }

  /**
   * Wait for the emulator to finish parsing everything written so far, then
   * flush.
   *
   * `flush()` alone only sees what the parser has already applied — writes are
   * asynchronous — so calling it at shutdown or when a run ends can miss the
   * tail of the output entirely. An empty write is enough to get a callback
   * behind the queued data.
   */
  drain(): Promise<void> {
    return new Promise((resolve) => {
      if (this.disposed) {
        resolve();
        return;
      }
      this.terminal.write('', () => {
        this.flush();
        resolve();
      });
    });
  }

  /** Emit every line that has scrolled off the screen since the last call. */
  flush(): void {
    if (this.disposed) {
      return;
    }

    // Always account against the normal buffer: history is its story alone.
    // Reading `buffer.active` instead meant that while a full-screen program
    // owned the alternate screen — which has its own baseY of 0 — the anchor
    // collapsed and already-stored lines were re-emitted. Skipping the flush
    // entirely in that state was no better: output produced just before the
    // program took the screen was then never harvested at all.
    const buffer = this.terminal.buffer.normal;
    const normalIsActive = this.terminal.buffer.active.type === 'normal';

    let start: number;

    if (this.marker && !this.marker.isDisposed) {
      // A live marker tells us how far the buffer has been trimmed: its `line`
      // shifts down by one for every evicted line, so the absolute index of
      // buffer line 0 falls straight out of it. This is public API; the trim
      // event that would give the same answer is not.
      this.absoluteBase = this.markerAbsolute - this.marker.line;
      start = this.persisted - this.absoluteBase;

      if (start < 0) {
        // Trimming outran us: those lines are gone and we know exactly how many.
        this.onGap(-start);
        this.persisted = this.absoluteBase;
        start = 0;
      }
    } else {
      // The anchor itself was evicted, so the eviction count is unknowable —
      // `absoluteBase` is stale and would make `start` look valid, quietly
      // dropping history instead of reporting it. Renumber from what is left
      // and admit the size of the hole is unknown.
      this.onGap(null);
      this.absoluteBase = this.persisted;
      start = 0;
    }

    // `persisted` must never move backwards. When the terminal grows taller,
    // lines that had already scrolled into history come back onto the screen
    // and `baseY` drops; letting that lower the counter makes the next flush
    // append them a second time, so the log physically contains duplicates.
    const target = this.absoluteBase + buffer.baseY;

    const lines: string[] = [];
    if (target > this.persisted) {
      for (let index = start; index < buffer.baseY; index++) {
        const line = buffer.getLine(index);
        if (line) {
          lines.push(serializeBufferLine(line));
        }
      }
      this.persisted = target;
    }

    // registerMarker() attaches to whichever buffer is active, so re-anchoring
    // during a full-screen program would put the anchor in the alternate
    // buffer. The normal buffer is frozen meanwhile, so the existing anchor
    // stays valid.
    if (normalIsActive) {
      this.anchorMarker();
    }

    if (lines.length > 0) {
      this.onLines(lines);
    }
  }

  /**
   * The rows still on screen, which by definition have not scrolled into
   * history yet. Exports need them or the file stops one screen short of the
   * end.
   *
   * Read from the normal buffer even while a full-screen program owns the
   * alternate one: history is the normal buffer's story, and splicing a TUI
   * frame onto the end of it would not follow from the text above.
   */
  snapshotScreen(): string[] {
    if (this.disposed) {
      return [];
    }

    const buffer = this.terminal.buffer.normal;
    const lines: string[] = [];
    for (let index = buffer.baseY; index < buffer.baseY + this.terminal.rows; index++) {
      const line = buffer.getLine(index);
      if (line) {
        lines.push(serializeBufferLine(line));
      }
    }

    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    return lines;
  }

  private anchorMarker(): void {
    const buffer = this.terminal.buffer.normal;
    this.marker?.dispose();
    this.marker = this.terminal.registerMarker(0);
    this.markerAbsolute = this.absoluteBase + buffer.baseY + buffer.cursorY;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.marker?.dispose();
    this.marker = undefined;
    this.terminal.dispose();
  }
}

interface CellStyle {
  fg: number;
  bg: number;
  fgMode: number;
  bgMode: number;
  flags: number;
}

const FLAG_BOLD = 1;
const FLAG_ITALIC = 2;
const FLAG_UNDERLINE = 4;
const FLAG_DIM = 8;
const FLAG_INVERSE = 16;
const FLAG_INVISIBLE = 32;
const FLAG_STRIKE = 64;
const FLAG_BLINK = 128;

function readStyle(cell: IBufferCell): CellStyle {
  let flags = 0;
  if (cell.isBold()) flags |= FLAG_BOLD;
  if (cell.isItalic()) flags |= FLAG_ITALIC;
  if (cell.isUnderline()) flags |= FLAG_UNDERLINE;
  if (cell.isDim()) flags |= FLAG_DIM;
  if (cell.isInverse()) flags |= FLAG_INVERSE;
  if (cell.isInvisible()) flags |= FLAG_INVISIBLE;
  if (cell.isStrikethrough()) flags |= FLAG_STRIKE;
  if (cell.isBlink()) flags |= FLAG_BLINK;

  const fgMode = cell.isFgRGB() ? 2 : cell.isFgPalette() ? 1 : 0;
  const bgMode = cell.isBgRGB() ? 2 : cell.isBgPalette() ? 1 : 0;

  return {
    // In default mode xterm reports -1, not 0. Normalising here keeps the
    // comparison against DEFAULT_STYLE honest; without it every single line
    // opened with a redundant reset.
    fg: fgMode === 0 ? -1 : cell.getFgColor(),
    bg: bgMode === 0 ? -1 : cell.getBgColor(),
    fgMode,
    bgMode,
    flags,
  };
}

function sameStyle(a: CellStyle, b: CellStyle): boolean {
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    a.fgMode === b.fgMode &&
    a.bgMode === b.bgMode &&
    a.flags === b.flags
  );
}

const DEFAULT_STYLE: CellStyle = { fg: -1, bg: -1, fgMode: 0, bgMode: 0, flags: 0 };

function styleToSgr(style: CellStyle): string {
  const codes: number[] = [0];

  if (style.flags & FLAG_BOLD) codes.push(1);
  if (style.flags & FLAG_DIM) codes.push(2);
  if (style.flags & FLAG_ITALIC) codes.push(3);
  if (style.flags & FLAG_UNDERLINE) codes.push(4);
  if (style.flags & FLAG_BLINK) codes.push(5);
  if (style.flags & FLAG_INVERSE) codes.push(7);
  if (style.flags & FLAG_INVISIBLE) codes.push(8);
  if (style.flags & FLAG_STRIKE) codes.push(9);

  if (style.fgMode === 1) {
    codes.push(38, 5, style.fg & 0xff);
  } else if (style.fgMode === 2) {
    codes.push(38, 2, (style.fg >> 16) & 0xff, (style.fg >> 8) & 0xff, style.fg & 0xff);
  }

  if (style.bgMode === 1) {
    codes.push(48, 5, style.bg & 0xff);
  } else if (style.bgMode === 2) {
    codes.push(48, 2, (style.bg >> 16) & 0xff, (style.bg >> 8) & 0xff, style.bg & 0xff);
  }

  return `\x1b[${codes.join(';')}m`;
}

/**
 * Render one buffer line as a self-contained ANSI string.
 *
 * Self-contained matters: history pages are written to a terminal that has seen
 * none of the preceding output, so each line has to re-establish its own colours
 * and start from a reset.
 */
export function serializeBufferLine(line: IBufferLine): string {
  // Find the last cell that carries anything worth keeping, so we do not store
  // a full width of padding for every short line.
  let end = -1;
  for (let index = line.length - 1; index >= 0; index--) {
    const cell = line.getCell(index);
    if (!cell) {
      continue;
    }
    const chars = cell.getChars();
    // A cell is worth keeping if it holds a glyph or paints a background.
    // Checking `getBgColor() !== 0` instead would match every default cell,
    // since default reads back as -1, and pad every line to the full width.
    if ((chars !== '' && chars !== ' ') || !cell.isBgDefault()) {
      end = index;
      break;
    }
  }

  if (end < 0) {
    return '';
  }

  let out = '';
  let current = DEFAULT_STYLE;

  for (let index = 0; index <= end; index++) {
    const cell = line.getCell(index);
    if (!cell) {
      continue;
    }

    // Wide characters occupy their own cell plus a zero-width placeholder that
    // must not be emitted, or the text doubles up.
    if (cell.getWidth() === 0) {
      continue;
    }

    const style = readStyle(cell);
    if (!sameStyle(style, current)) {
      out += styleToSgr(style);
      current = style;
    }

    const chars = cell.getChars();
    out += chars === '' ? ' ' : chars;
  }

  if (!sameStyle(current, DEFAULT_STYLE)) {
    out += '\x1b[0m';
  }

  // A stored line is one record in a newline-delimited log, so it must not
  // contain newlines itself. Buffer lines never do; strip defensively anyway.
  return out.replace(/[\r\n]/g, '');
}

export default ScrollbackRecorder;
