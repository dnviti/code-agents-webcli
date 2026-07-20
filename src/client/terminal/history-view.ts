import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { createFrameScheduler, type FrameScheduler } from './scheduler';

/**
 * Pages through server-stored scrollback.
 *
 * xterm.js can only append to its buffer — there is no way to splice older
 * lines in above what it already holds — so unlimited upward scrolling cannot
 * be done by growing the live terminal. Instead this renders one screenful at a
 * time into a second, read-only terminal and fakes the scrollbar with a spacer
 * sized to the full line count. Memory and render cost stay flat no matter how
 * far back the session goes: the client never holds more than a few screens.
 */

export interface HistoryRange {
  firstLine: number;
  totalLines: number;
}

export interface HistoryViewOptions {
  container: HTMLElement;
  fontSize: number;
  fontFamily: string;
  theme: Record<string, string>;
  /** Resolves with the requested lines, or an empty array if unavailable. */
  fetchPage: (fromLine: number, count: number) => Promise<string[]>;
  onExit: () => void;
  onExport?: () => void;
}

/** Keep a few screens either side so small scrolls never hit the network. */
const CACHE_PAGES = 12;

export class HistoryView {
  private readonly options: HistoryViewOptions;
  private readonly root: HTMLElement;
  private readonly scroller: HTMLElement;
  private readonly spacer: HTMLElement;
  private readonly termHost: HTMLElement;
  private readonly status: HTMLElement;
  private readonly terminal: Terminal;
  private readonly fitAddon: FitAddon;

  private range: HistoryRange = { firstLine: 0, totalLines: 0 };
  private opened = false;
  private topLine = 0;
  private lineHeight = 17;
  private readonly renderScheduler: FrameScheduler = createFrameScheduler();
  private requestSeq = 0;
  private readonly cache = new Map<number, string[]>();

  constructor(options: HistoryViewOptions) {
    this.options = options;

    this.root = document.createElement('div');
    this.root.className = 'history-view';
    this.root.hidden = true;

    const bar = document.createElement('div');
    bar.className = 'history-view__bar';

    this.status = document.createElement('span');
    this.status.className = 'history-view__status';
    bar.appendChild(this.status);

    const actions = document.createElement('div');
    actions.className = 'history-view__actions';

    if (options.onExport) {
      const exportBtn = document.createElement('button');
      exportBtn.type = 'button';
      exportBtn.className = 'history-view__button';
      exportBtn.textContent = 'Scarica .md';
      exportBtn.addEventListener('click', () => options.onExport?.());
      actions.appendChild(exportBtn);
    }

    const exitBtn = document.createElement('button');
    exitBtn.type = 'button';
    exitBtn.className = 'history-view__button history-view__button--primary';
    exitBtn.textContent = 'Torna al presente';
    exitBtn.addEventListener('click', () => this.close());
    actions.appendChild(exitBtn);

    bar.appendChild(actions);

    const body = document.createElement('div');
    body.className = 'history-view__body';

    this.termHost = document.createElement('div');
    this.termHost.className = 'history-view__terminal';

    this.scroller = document.createElement('div');
    this.scroller.className = 'history-view__scroller';
    this.spacer = document.createElement('div');
    this.spacer.className = 'history-view__spacer';
    this.scroller.appendChild(this.spacer);

    body.appendChild(this.termHost);
    body.appendChild(this.scroller);
    this.root.appendChild(bar);
    this.root.appendChild(body);
    options.container.appendChild(this.root);

    this.terminal = new Terminal({
      fontSize: options.fontSize,
      fontFamily: options.fontFamily,
      theme: options.theme,
      // No scrollback: this terminal only ever shows the page it was handed.
      // Its scrolling is the spacer's, not xterm's.
      scrollback: 0,
      disableStdin: true,
      cursorStyle: 'bar',
      cursorBlink: false,
      convertEol: true,
    });
    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);

    this.scroller.addEventListener('scroll', () => this.onScroll(), { passive: true });
    this.root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        this.close();
      }
    });
  }

  setRange(range: HistoryRange): void {
    this.range = range;
  }

  get isOpen(): boolean {
    return this.opened;
  }

  /** `anchorLine` is the newest line to show; the page ends there. */
  open(anchorLine: number): void {
    if (this.opened || this.range.totalLines <= this.range.firstLine) {
      return;
    }

    this.opened = true;
    this.root.hidden = false;

    if (!this.terminal.element) {
      this.terminal.open(this.termHost);
    }

    this.fitAddon.fit();
    this.measureLineHeight();
    this.resizeSpacer();

    const top = Math.max(this.range.firstLine, anchorLine - this.terminal.rows);
    this.scroller.scrollTop = this.scrollTopForLine(top);
    this.topLine = top;
    void this.render();
    this.root.focus();
  }

  close(): void {
    if (!this.opened) {
      return;
    }
    this.opened = false;
    this.root.hidden = true;
    this.cache.clear();
    this.options.onExit();
  }

  fit(): void {
    if (!this.opened) {
      return;
    }
    this.fitAddon.fit();
    this.measureLineHeight();
    this.resizeSpacer();
    void this.render();
  }

  dispose(): void {
    this.renderScheduler.cancel();
    this.terminal.dispose();
    this.root.remove();
  }

  private measureLineHeight(): void {
    const rows = this.terminal.element?.querySelector('.xterm-rows') as HTMLElement | null;
    const measured = rows && this.terminal.rows > 0 ? rows.clientHeight / this.terminal.rows : 0;
    if (measured > 1) {
      this.lineHeight = measured;
    }
  }

  private resizeSpacer(): void {
    const lines = Math.max(0, this.range.totalLines - this.range.firstLine);
    this.spacer.style.height = `${Math.max(1, lines * this.lineHeight)}px`;
  }

  /** Highest line that can sit at the top of the screen. */
  private get maxTopLine(): number {
    return Math.max(this.range.firstLine, this.range.totalLines - this.terminal.rows);
  }

  private get maxScroll(): number {
    return Math.max(0, this.spacer.clientHeight - this.scroller.clientHeight);
  }

  private scrollTopForLine(line: number): number {
    const span = this.maxTopLine - this.range.firstLine;
    if (span <= 0) {
      return 0;
    }
    return ((line - this.range.firstLine) / span) * this.maxScroll;
  }

  /**
   * Map scroll position onto line numbers by ratio rather than by pixels.
   *
   * Dividing scrollTop by the line height mixes two coordinate systems: the
   * scroller's height is the whole element, while the terminal only paints
   * `rows * lineHeight` of it. The leftover made the last few lines
   * unreachable, so the bottom — and with it the exit back to the live
   * terminal — could never be reached.
   */
  private onScroll(): void {
    const span = this.maxTopLine - this.range.firstLine;
    const maxScroll = this.maxScroll;
    const ratio = maxScroll > 0 ? Math.min(1, this.scroller.scrollTop / maxScroll) : 1;
    const next = this.range.firstLine + Math.round(ratio * span);

    // Scrolling past the newest stored line means the user wants to be back in
    // the live terminal, which is where those lines actually are.
    if (ratio >= 1) {
      this.close();
      return;
    }

    if (next === this.topLine) {
      return;
    }
    this.topLine = next;
    this.renderScheduler.schedule(() => {
      void this.render();
    });
  }

  private async render(): Promise<void> {
    const rows = Math.max(1, this.terminal.rows);
    const from = this.topLine;

    const cached = this.cache.get(from);
    if (cached) {
      this.paint(cached, from, rows);
      return;
    }

    // A slow reply for a page the user has already scrolled past must not
    // overwrite the page they are looking at now.
    const seq = ++this.requestSeq;
    const lines = await this.options.fetchPage(from, rows);
    if (seq !== this.requestSeq || !this.opened) {
      return;
    }

    if (this.cache.size > CACHE_PAGES) {
      this.cache.clear();
    }
    this.cache.set(from, lines);
    this.paint(lines, from, rows);
  }

  private paint(lines: string[], from: number, rows: number): void {
    const page = lines.slice(0, rows);
    while (page.length < rows) {
      page.push('');
    }

    // Home + erase, then exactly one screen. `convertEol` turns the joins into
    // real line breaks, and with no scrollback nothing can spill off the top.
    this.terminal.write(`\x1b[H\x1b[2J${page.join('\n')}`);

    const shown = Math.min(from + rows, this.range.totalLines);
    this.status.textContent =
      `Cronologia — righe ${from + 1}–${shown} di ${this.range.totalLines}` +
      (this.range.firstLine > 0 ? ` (le prime ${this.range.firstLine} non sono più conservate)` : '');
  }
}

export default HistoryView;
