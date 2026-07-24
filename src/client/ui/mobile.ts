// Mobile-specific behaviour: detection, scroll containment, mode switching
//
// The drawer, the two floating buttons and the sessions modal are gone; the
// bottom bar (`MobileBar`), the more sheet (`MoreSheet`) and the session list
// (`SessionsDialog`) replaced them. What stays here is the part that is not
// chrome: deciding whether this is a touch device, keeping the page from
// bouncing under the terminal, and the escape/mode keystrokes the bar sends.

import type { App } from '../app';
import { shellStore } from '../shell/store';

export function detectMobile(): boolean {
  const hasTouchScreen =
    'ontouchstart' in window ||
    navigator.maxTouchPoints > 0;

  const mobileUserAgent =
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

  const smallViewport = window.innerWidth <= 1024;

  return hasTouchScreen && (mobileUserAgent || smallViewport);
}

/**
 * Keep the shell's idea of "mobile" current.
 *
 * Half of `detectMobile()` is a viewport width, so the answer changes when a
 * tablet is rotated or a touch laptop's window is resized. It used to be read
 * once at boot and only decided whether to add two floating buttons; it now
 * decides between the bottom bar and the status bar, so a stale answer means
 * rotating a tablet into portrait leaves it with no session controls at all.
 *
 * The CSS that used to handle this with a media query is gone — this is where
 * that responsiveness lives now.
 */
export function watchViewport(app: App): void {
  window.addEventListener('resize', () => {
    const isMobile = detectMobile();
    if (isMobile === app.isMobile) return;
    app.isMobile = isMobile;
    shellStore.setState({ isMobile });
  });
}

export function disablePullToRefresh(): void {
  let lastY = 0;

  const findScrollableAncestor = (target: EventTarget | null): HTMLElement | null => {
    let node = target instanceof HTMLElement ? target : null;

    while (node && node !== document.body) {
      const styles = window.getComputedStyle(node);
      const overflowY = styles.overflowY;
      const canScroll =
        (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay')
        && node.scrollHeight > node.clientHeight;

      if (canScroll) {
        return node;
      }

      node = node.parentElement;
    }

    return null;
  };

  document.addEventListener(
    'touchstart',
    (e: TouchEvent) => {
      lastY = e.touches[0].clientY;
    },
    { passive: false },
  );

  document.addEventListener(
    'touchmove',
    (e: TouchEvent) => {
      if (e.defaultPrevented) {
        lastY = e.touches[0].clientY;
        return;
      }

      const y = e.touches[0].clientY;
      const isPullingDown = y > lastY;
      const scrollableAncestor = findScrollableAncestor(e.target);

      if (scrollableAncestor) {
        const maxScrollTop = Math.max(0, scrollableAncestor.scrollHeight - scrollableAncestor.clientHeight);
        const canUseScrollableAncestor = isPullingDown
          ? scrollableAncestor.scrollTop > 0
          : scrollableAncestor.scrollTop < maxScrollTop;

        if (canUseScrollableAncestor) {
          lastY = y;
          return;
        }
      }

      const scrollTop =
        window.pageYOffset ||
        document.documentElement.scrollTop ||
        document.body.scrollTop ||
        0;

      if (scrollTop === 0 && isPullingDown) {
        e.preventDefault();
      }

      lastY = y;
    },
    { passive: false },
  );
}

export function sendEscape(app: App): void {
  if (app.socket && app.socket.readyState === WebSocket.OPEN) {
    app.send({ type: 'input', data: '\x1b' });
  }
}

// ---------------------------------------------------------------------------
// On-screen terminal keys (issue #21)
//
// A phone's keyboard has no Escape, arrows, Ctrl or Tab. The key strip sends
// those straight to the socket, bypassing xterm's own key handling entirely —
// which is also why the on-screen keyboard never pops up for them.
// ---------------------------------------------------------------------------

/** The keys the mobile strip can send, named rather than wired to bytes. */
export type MobileKey = 'esc' | 'tab' | 'up' | 'down' | 'left' | 'right';

/**
 * One-shot Ctrl latch.
 *
 * The latch cannot be implemented by intercepting `keydown`: Android keyboards
 * type through IME composition, which never produces a usable key event. What
 * every input method does produce is xterm's `onData`, so the transform lives
 * there — see `withCtrlLatch` and its call site in terminal/setup.ts.
 */
export function toggleCtrlLatch(): void {
  shellStore.setState({ ctrlLatched: !shellStore.getSnapshot().ctrlLatched });
}

/**
 * The control character a key becomes under Ctrl, or null when the key has no
 * standard Ctrl mapping (digits, punctuation). Letters are the case that
 * matters — Ctrl+C, Ctrl+D, Ctrl+Z, Ctrl+R are what agents ask for.
 */
export function controlCodeFor(ch: string): string | null {
  if (ch.length !== 1) return null;
  if (ch >= 'a' && ch <= 'z') return String.fromCharCode(ch.charCodeAt(0) - 96);
  if (ch >= 'A' && ch <= 'Z') return String.fromCharCode(ch.charCodeAt(0) - 64);
  switch (ch) {
    case ' ': return '\x00';
    case '[': return '\x1b';
    case '\\': return '\x1c';
    case ']': return '\x1d';
    case '^': return '\x1e';
    case '_': return '\x1f';
    default: return null;
  }
}

/**
 * Apply and consume the Ctrl latch against the next chunk of terminal input.
 *
 * One-shot semantics: any input disengages the latch, whether or not it could
 * be mapped. A single character maps to its control code; anything longer is a
 * paste, which Ctrl must never mangle, so it passes through untouched.
 */
export function withCtrlLatch(data: string): string {
  if (!shellStore.getSnapshot().ctrlLatched) return data;
  shellStore.setState({ ctrlLatched: false });
  const mapped = controlCodeFor(data);
  return mapped ?? data;
}

const CURSOR_KEYS: Record<'up' | 'down' | 'left' | 'right', string> = {
  up: 'A',
  down: 'B',
  right: 'C',
  left: 'D',
};

/**
 * Send one strip key to the active session.
 *
 * Cursor keys follow the terminal's application-cursor-keys mode: a full-
 * screen app that switched the mode on expects SS3 (\x1bOA) and ignores or
 * misreads CSI (\x1b[A), and readline-style prompts expect the reverse. A
 * latched Ctrl turns the arrow into its modified form (CSI 1;5X) — word jumps
 * in prompts that bind them.
 */
export function sendMobileKey(app: App, key: MobileKey): void {
  if (!app.socket || app.socket.readyState !== WebSocket.OPEN) return;

  const ctrl = shellStore.getSnapshot().ctrlLatched;
  let data: string;

  switch (key) {
    case 'esc':
      data = '\x1b';
      break;
    case 'tab':
      // Ctrl+Tab has no encoding in a terminal; the latch is still consumed
      // below so it cannot leak into the next real character.
      data = '\t';
      break;
    default: {
      const letter = CURSOR_KEYS[key];
      if (ctrl) {
        data = `\x1b[1;5${letter}`;
      } else if (app.terminal?.modes.applicationCursorKeysMode) {
        data = `\x1bO${letter}`;
      } else {
        data = `\x1b[${letter}`;
      }
    }
  }

  if (ctrl) shellStore.setState({ ctrlLatched: false });
  app.send({ type: 'input', data });
}

export function switchMode(app: App): void {
  const modes = ['chat', 'code', 'plan'] as const;
  const currentIndex = modes.indexOf(app.currentMode as (typeof modes)[number]);
  const nextIndex = (currentIndex + 1) % modes.length;
  app.currentMode = modes[nextIndex];

  if (app.socket && app.socket.readyState === WebSocket.OPEN) {
    app.send({ type: 'input', data: '\x1b[Z' });
  }
}

export function showMobileSessionsModal(app: App): void {
  shellStore.patchSlice('dialogs', { sessions: true });
  void loadMobileSessions(app);
}

export function hideMobileSessionsModal(): void {
  shellStore.patchSlice('dialogs', { sessions: false });
}

export async function loadMobileSessions(app: App): Promise<void> {
  try {
    const response = await app.authFetch('/api/sessions/list');
    if (!response.ok) throw new Error('Failed to load sessions');

    const data = await response.json();
    app.claudeSessions = data.sessions;
    shellStore.setState({ sessionList: data.sessions });
  } catch (error) {
    console.error('Failed to load sessions:', error);
  }
}
