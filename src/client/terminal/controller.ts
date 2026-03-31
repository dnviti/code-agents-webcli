import { Terminal, type IDisposable, type ITerminalOptions } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';

export interface TerminalController {
  terminal: Terminal;
  fitAddon: FitAddon;
  fit(): void;
  refresh(): void;
  restoreViewport(): void;
  open(container: HTMLElement): void;
  dispose(): void;
}

interface CreateTerminalControllerOptions {
  fontSize?: number;
  fontFamily?: string;
  theme?: ITerminalOptions['theme'];
}

const DEFAULT_THEME: NonNullable<ITerminalOptions['theme']> = {
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
    scrollback: 20000,
    scrollOnUserInput: true,
    smoothScrollDuration: 0,
  });

  const fitAddon = new FitAddon();
  const webLinksAddon = new WebLinksAddon();
  const disposables: IDisposable[] = [];

  let container: HTMLElement | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let fitFrame: number | null = null;
  let restoreFrame: number | null = null;
  let restoreTimeouts: number[] = [];
  let viewport: HTMLElement | null = null;
  let viewportScrollHandler: (() => void) | null = null;
  let touchScrollLastY: number | null = null;
  let lastViewportScrollTop = 0;
  let lastViewportWasAtBottom = true;

  terminal.loadAddon(fitAddon);
  terminal.loadAddon(webLinksAddon);

  const getViewport = (): HTMLElement | null => {
    if (!container) {
      return null;
    }

    return container.querySelector('.xterm-viewport') as HTMLElement | null;
  };

  const rememberViewportState = (): void => {
    if (!viewport) {
      return;
    }

    lastViewportScrollTop = viewport.scrollTop;
    const distanceFromBottom =
      viewport.scrollHeight - (viewport.scrollTop + viewport.clientHeight);
    lastViewportWasAtBottom = distanceFromBottom <= 24;
  };

  const trackViewport = (): void => {
    const nextViewport = getViewport();
    if (!nextViewport) {
      return;
    }

    if (nextViewport !== viewport) {
      if (viewport && viewportScrollHandler) {
        viewport.removeEventListener('scroll', viewportScrollHandler);
      }

      viewport = nextViewport;
      viewportScrollHandler = rememberViewportState;
      viewport.addEventListener('scroll', viewportScrollHandler, { passive: true });
    }

    rememberViewportState();
  };

  const refresh = (): void => {
    if (terminal.rows > 0) {
      terminal.refresh(0, terminal.rows - 1);
    }
  };

  const syncViewport = (): void => {
    if (!container || !container.isConnected) {
      return;
    }

    if (container.clientWidth === 0 || container.clientHeight === 0) {
      return;
    }

    trackViewport();

    const previousScrollTop = viewport?.scrollTop ?? lastViewportScrollTop;
    fitAddon.fit();
    refresh();
    trackViewport();

    if (!viewport) {
      return;
    }

    if (lastViewportWasAtBottom) {
      terminal.scrollToBottom();
    } else {
      const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      viewport.scrollTop = Math.min(previousScrollTop, maxScrollTop);
    }

    lastViewportScrollTop = viewport.scrollTop;
  };

  const clearRestoreTimers = (): void => {
    restoreTimeouts.forEach((timeoutId) => window.clearTimeout(timeoutId));
    restoreTimeouts = [];
  };

  const fit = (): void => {
    if (fitFrame !== null) {
      cancelAnimationFrame(fitFrame);
    }

    fitFrame = requestAnimationFrame(() => {
      fitFrame = null;
      syncViewport();
    });
  };

  const restoreViewport = (): void => {
    if (fitFrame !== null) {
      cancelAnimationFrame(fitFrame);
      fitFrame = null;
    }

    if (restoreFrame !== null) {
      cancelAnimationFrame(restoreFrame);
    }
    clearRestoreTimers();

    syncViewport();

    restoreFrame = requestAnimationFrame(() => {
      restoreFrame = null;
      syncViewport();
    });

    [32, 96, 180].forEach((delay) => {
      restoreTimeouts.push(window.setTimeout(syncViewport, delay));
    });
  };

  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') {
      restoreViewport();
    } else {
      trackViewport();
    }
  };

  const onViewportResize = (): void => {
    restoreViewport();
  };

  const onWindowFocus = (): void => {
    restoreViewport();
  };

  const onPageShow = (): void => {
    restoreViewport();
  };

  const onTouchStart = (event: TouchEvent): void => {
    if (event.touches.length !== 1) {
      touchScrollLastY = null;
      return;
    }

    trackViewport();
    touchScrollLastY = event.touches[0].clientY;
  };

  const onTouchMove = (event: TouchEvent): void => {
    if (event.touches.length !== 1 || touchScrollLastY === null) {
      return;
    }

    trackViewport();
    if (!viewport) {
      touchScrollLastY = event.touches[0].clientY;
      return;
    }

    const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    if (maxScrollTop <= 0) {
      touchScrollLastY = event.touches[0].clientY;
      return;
    }

    const currentY = event.touches[0].clientY;
    const deltaY = currentY - touchScrollLastY;
    touchScrollLastY = currentY;

    if (deltaY === 0) {
      return;
    }

    viewport.scrollTop = Math.max(0, Math.min(maxScrollTop, viewport.scrollTop - deltaY));
    rememberViewportState();
    event.preventDefault();
  };

  const resetTouchScroll = (): void => {
    touchScrollLastY = null;
  };

  const open = (target: HTMLElement): void => {
    container = target;
    terminal.open(target);
    trackViewport();

    resizeObserver = new ResizeObserver(() => fit());
    resizeObserver.observe(target);

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', onWindowFocus);
    window.addEventListener('pageshow', onPageShow);
    window.visualViewport?.addEventListener('resize', onViewportResize);
    target.addEventListener('touchstart', onTouchStart, { passive: true });
    target.addEventListener('touchmove', onTouchMove, { passive: false });
    target.addEventListener('touchend', resetTouchScroll);
    target.addEventListener('touchcancel', resetTouchScroll);

    void document.fonts.ready
      .then(() => restoreViewport())
      .catch(() => {
        // Font loading is best-effort only.
      });

    restoreViewport();
  };

  const dispose = (): void => {
    if (fitFrame !== null) {
      cancelAnimationFrame(fitFrame);
      fitFrame = null;
    }

    if (restoreFrame !== null) {
      cancelAnimationFrame(restoreFrame);
      restoreFrame = null;
    }

    clearRestoreTimers();

    resizeObserver?.disconnect();
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('focus', onWindowFocus);
    window.removeEventListener('pageshow', onPageShow);
    window.visualViewport?.removeEventListener('resize', onViewportResize);
    container?.removeEventListener('touchstart', onTouchStart);
    container?.removeEventListener('touchmove', onTouchMove);
    container?.removeEventListener('touchend', resetTouchScroll);
    container?.removeEventListener('touchcancel', resetTouchScroll);
    if (viewport && viewportScrollHandler) {
      viewport.removeEventListener('scroll', viewportScrollHandler);
    }

    disposables.forEach((disposable) => disposable.dispose());
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
  };
}
