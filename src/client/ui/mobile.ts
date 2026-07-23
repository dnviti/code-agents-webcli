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
