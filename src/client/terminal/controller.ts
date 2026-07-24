import { Terminal, type IDisposable, type ITerminalOptions } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { createFrameScheduler } from './scheduler';
import { attachClipboard } from './clipboard';
import { attachTouchScroll } from './touch-scroll';
import { showNotification } from '../ui/notifications';

export interface TerminalController {
  terminal: Terminal;
  fitAddon: FitAddon;
  fit(): void;
  refresh(): void;
  restoreViewport(): void;
  open(container: HTMLElement): void;
  dispose(): void;
  /** Queue output for the next frame instead of parsing every socket chunk on its own. */
  write(data: string): void;
  /** True when the viewport is pinned to the newest line. */
  isAtBottom(): boolean;
  /** Fires when the user scrolls to the very top of the live buffer. */
  onReachedTop(handler: () => void): IDisposable;
  /** Which renderer actually took over, for diagnostics. */
  readonly rendererKind: () => 'webgl' | 'dom';
}

interface CreateTerminalControllerOptions {
  fontSize?: number;
  fontFamily?: string;
  theme?: ITerminalOptions['theme'];
  scrollback?: number;
}

/**
 * The live terminal only holds the recent tail. Everything older is paged in
 * from the server on demand, so a bigger buffer here would only add reflow cost
 * (xterm reflows the whole scrollback on every resize) without adding reach.
 */
export const LIVE_SCROLLBACK_LINES = 2000;

export const DEFAULT_THEME: NonNullable<ITerminalOptions['theme']> = {
  background: '#0d1117',
  foreground: '#f0f6fc',
  cursor: '#58a6ff',
  cursorAccent: '#0d1117',
  selectionBackground: 'rgba(88, 166, 255, 0.3)',
  selectionInactiveBackground: 'rgba(88, 166, 255, 0.18)',
  black: '#484f58',
  red: '#ff7b72',
  green: '#7ee787',
  yellow: '#ffa657',
  blue: '#79c0ff',
  magenta: '#d2a8ff',
  cyan: '#a5f3fc',
  white: '#b1bac4',
  brightBlack: '#6e7681',
  brightRed: '#ffa198',
  brightGreen: '#56d364',
  brightYellow: '#ffdf5d',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#a5f3fc',
  brightWhite: '#f0f6fc',
};

export function createTerminalController(
  options: CreateTerminalControllerOptions = {},
): TerminalController {
  const terminal = new Terminal({
    fontSize: options.fontSize ?? 14,
    fontFamily: options.fontFamily ?? 'JetBrains Mono, Fira Code, Monaco, Consolas, monospace',
    theme: options.theme ?? DEFAULT_THEME,
    allowTransparency: false,
    cursorBlink: true,
    cursorStyle: 'block',
    cursorInactiveStyle: 'outline',
    customGlyphs: true,
    drawBoldTextInBrightColors: true,
    fastScrollSensitivity: 5,
    minimumContrastRatio: 1,
    rightClickSelectsWord: false,
    scrollback: options.scrollback ?? LIVE_SCROLLBACK_LINES,
    scrollOnUserInput: true,
    smoothScrollDuration: 0,
  });

  const fitAddon = new FitAddon();
  const webLinksAddon = new WebLinksAddon();
  const disposables: IDisposable[] = [];

  let container: HTMLElement | null = null;
  let resizeObserver: ResizeObserver | null = null;
  const fitScheduler = createFrameScheduler();
  const writeScheduler = createFrameScheduler();
  let pending: string[] = [];
  let renderer: 'webgl' | 'dom' = 'dom';
  let webglAddon: WebglAddon | null = null;
  let detachClipboard: (() => void) | null = null;
  let detachTouchScroll: (() => void) | null = null;
  let lastCols = 0;
  let lastRows = 0;
  const topHandlers = new Set<() => void>();

  terminal.loadAddon(fitAddon);
  terminal.loadAddon(webLinksAddon);

  const isAtBottom = (): boolean => {
    const buffer = terminal.buffer.active;
    return buffer.viewportY >= buffer.baseY;
  };

  const refresh = (): void => {
    if (terminal.rows > 0) {
      terminal.refresh(0, terminal.rows - 1);
    }
  };

  /**
   * Resize to the container, then re-pin to the bottom if that is where we
   * already were.
   *
   * Everything here goes through xterm's own scroll API. An earlier version
   * assigned `.xterm-viewport.scrollTop` directly and also called
   * `scrollToBottom()`, which left xterm's internal `viewportY` disagreeing
   * with the DOM: rows then render at the wrong offsets (text appears to
   * interleave) and the scroll clamps against a stale `scrollHeight`, so the
   * bottom becomes unreachable. Both were reported symptoms.
   */
  const syncViewport = (): void => {
    if (!container || !container.isConnected) {
      return;
    }

    if (container.clientWidth === 0 || container.clientHeight === 0) {
      return;
    }

    const stickToBottom = isAtBottom();

    fitAddon.fit();

    // Reflow is the expensive part of a resize, so skip the follow-up work
    // entirely when the geometry did not actually change.
    const changed = terminal.cols !== lastCols || terminal.rows !== lastRows;
    lastCols = terminal.cols;
    lastRows = terminal.rows;

    if (stickToBottom) {
      terminal.scrollToBottom();
    }

    if (changed) {
      refresh();
    }
  };

  const fit = (): void => {
    fitScheduler.schedule(syncViewport);
  };

  /**
   * Layout can still be settling when this is called (fonts loading, mobile
   * keyboard animating, a tab becoming visible), so re-check on the next frame
   * rather than firing a burst of timers that each pay for a full reflow.
   */
  const restoreViewport = (): void => {
    syncViewport();
    fit();
  };

  const write = (data: string): void => {
    if (!data) {
      return;
    }

    pending.push(data);

    writeScheduler.schedule(() => {
      if (pending.length === 0) {
        return;
      }
      const batch = pending.length === 1 ? pending[0] : pending.join('');
      pending = [];
      terminal.write(batch);
    });
  };

  const atTopWithHistory = (): boolean => {
    const buffer = terminal.buffer.active;
    return buffer.viewportY === 0 && buffer.baseY > 0;
  };

  const notifyTop = (): void => {
    topHandlers.forEach((handler) => handler());
  };

  /**
   * Scrolling up while already parked at the top produces no scroll event —
   * there is nowhere left to go — so the wheel itself has to be the signal.
   * Without this, the most natural gesture for "show me more" did nothing.
   */
  const onWheel = (event: WheelEvent): void => {
    if (event.deltaY < 0 && atTopWithHistory()) {
      notifyTop();
    }
  };

  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') {
      restoreViewport();
    }
  };

  const enableWebgl = (): void => {
    // The DOM renderer repaints a full screen of <span>s per frame, which is
    // what made long sessions crawl. WebGL is optional: some GPUs, blocklisted
    // drivers and headless browsers have no context to give us.
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => {
        addon.dispose();
        webglAddon = null;
        renderer = 'dom';
      });
      terminal.loadAddon(addon);
      webglAddon = addon;
      renderer = 'webgl';
    } catch {
      renderer = 'dom';
    }
  };

  const open = (target: HTMLElement): void => {
    container = target;
    terminal.open(target);

    // Must come after open(): the addon needs the canvas the terminal creates.
    enableWebgl();

    // Copy/paste for this terminal and its container. Wired here so the main
    // terminal and both split panes get it without duplication.
    detachClipboard = attachClipboard(terminal, target, { notify: showNotification });

    // Touch scrolling is owned by JS, not the browser: xterm 6 has no touch
    // handling, and the viewport's incidental native scroll was the unreliable
    // path issue #21 names. Attached for every terminal, main and split alike.
    detachTouchScroll = attachTouchScroll(target, { terminal, onReachedTop: notifyTop });

    lastCols = terminal.cols;
    lastRows = terminal.rows;

    disposables.push(
      terminal.onScroll(() => {
        if (atTopWithHistory()) {
          notifyTop();
        }
      }),
    );

    resizeObserver = new ResizeObserver(() => fit());
    resizeObserver.observe(target);

    target.addEventListener('wheel', onWheel, { passive: true });
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pageshow', restoreViewport);
    window.visualViewport?.addEventListener('resize', fit);

    void document.fonts.ready
      .then(() => restoreViewport())
      .catch(() => {
        // Font loading is best-effort only.
      });

    restoreViewport();
  };

  const dispose = (): void => {
    fitScheduler.cancel();
    writeScheduler.cancel();
    pending = [];
    topHandlers.clear();

    resizeObserver?.disconnect();
    container?.removeEventListener('wheel', onWheel);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('pageshow', restoreViewport);
    window.visualViewport?.removeEventListener('resize', fit);

    detachClipboard?.();
    detachClipboard = null;
    detachTouchScroll?.();
    detachTouchScroll = null;

    disposables.forEach((disposable) => disposable.dispose());
    webglAddon?.dispose();
    terminal.dispose();
  };

  return {
    terminal,
    fitAddon,
    fit,
    refresh,
    restoreViewport,
    open,
    dispose,
    write,
    isAtBottom,
    onReachedTop: (handler: () => void): IDisposable => {
      topHandlers.add(handler);
      return { dispose: () => topHandlers.delete(handler) };
    },
    rendererKind: () => renderer,
  };
}
