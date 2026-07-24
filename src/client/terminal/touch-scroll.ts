// Deliberate touch scrolling for the live terminal.
//
// xterm 6 ships no touch handling of its own: on a phone the only thing that
// moved the buffer was the browser's incidental native scroll of
// `.xterm-viewport`, which is exactly the unreliability issue #21 names. This
// module owns the gesture instead — the viewport and screen are
// `touch-action: none` (see components/terminal.css), so no native scroll,
// page bounce or pull-to-refresh can race the code below.
//
// The gesture is deliberately conservative to start: a drag only becomes a
// scroll once it is clearly vertical, so a tap that lands on a link or a tap
// that focuses the terminal is never eaten.

import type { Terminal } from '@xterm/xterm';

export interface TouchScrollOptions {
  terminal: Terminal;
  /**
   * Fires when the user keeps dragging down while already parked at the top
   * of the live buffer — the same hand-off to server-paged history the wheel
   * path performs in the controller.
   */
  onReachedTop(): void;
}

/** Pixels of clearly-vertical travel before a drag is claimed as a scroll. */
const SCROLL_THRESHOLD_PX = 8;
/** A drag must be this much more vertical than horizontal to be a scroll. */
const VERTICAL_DOMINANCE = 1.2;

export function attachTouchScroll(
  container: HTMLElement,
  { terminal, onReachedTop }: TouchScrollOptions,
): () => void {
  let tracking = false;
  let scrolling = false;
  let startX = 0;
  let startY = 0;
  let lastY = 0;
  // scrollLines() takes whole lines; carrying the remainder is what makes a
  // slow drag move one line at a time instead of jumping or stalling.
  let pendingPx = 0;

  const lineHeightPx = (): number => {
    // clientHeight / rows is the true rendered cell height — fontSize *
    // lineHeight only approximates it once xterm rounds to whole pixels.
    if (terminal.rows > 0 && container.clientHeight > 0) {
      return container.clientHeight / terminal.rows;
    }
    return (terminal.options.fontSize ?? 14) * (terminal.options.lineHeight ?? 1);
  };

  const reset = (): void => {
    tracking = false;
    scrolling = false;
    pendingPx = 0;
  };

  const onTouchStart = (event: TouchEvent): void => {
    if (event.touches.length !== 1) {
      // A second finger mid-scroll ends the gesture rather than mixing two
      // coordinate streams into the accumulator.
      reset();
      return;
    }
    tracking = true;
    scrolling = false;
    pendingPx = 0;
    startX = event.touches[0].clientX;
    startY = event.touches[0].clientY;
    lastY = startY;
  };

  const onTouchMove = (event: TouchEvent): void => {
    if (!tracking || event.touches.length !== 1) {
      reset();
      return;
    }

    const touch = event.touches[0];

    if (!scrolling) {
      const dx = Math.abs(touch.clientX - startX);
      const dy = Math.abs(touch.clientY - startY);
      if (dy < SCROLL_THRESHOLD_PX) return;
      if (dx * VERTICAL_DOMINANCE > dy) {
        // A horizontal drag is a selection/wipe gesture, not ours.
        reset();
        return;
      }
      scrolling = true;
    }

    // From here on the gesture is ours: no native viewport scroll, no page
    // bounce, no pull-to-refresh.
    event.preventDefault();

    const delta = lastY - touch.clientY;
    lastY = touch.clientY;

    const buffer = terminal.buffer.active;
    if (delta < 0 && buffer.viewportY === 0 && buffer.baseY > 0) {
      // Finger dragging down while parked at the top: the user wants older
      // output than the live buffer holds. The handler is idempotent (the
      // history view opens once), matching the controller's wheel path.
      onReachedTop();
      return;
    }

    pendingPx += delta;
    const lines = Math.trunc(pendingPx / lineHeightPx());
    if (lines !== 0) {
      // scrollLines goes through xterm's own scroll accounting — assigning
      // viewport scrollTop directly is what desyncs renderer and buffer.
      terminal.scrollLines(lines);
      pendingPx -= lines * lineHeightPx();
    }
  };

  const onTouchEnd = (): void => {
    reset();
  };

  container.addEventListener('touchstart', onTouchStart, { passive: true });
  container.addEventListener('touchmove', onTouchMove, { passive: false });
  container.addEventListener('touchend', onTouchEnd, { passive: true });
  container.addEventListener('touchcancel', onTouchEnd, { passive: true });

  return () => {
    container.removeEventListener('touchstart', onTouchStart);
    container.removeEventListener('touchmove', onTouchMove);
    container.removeEventListener('touchend', onTouchEnd);
    container.removeEventListener('touchcancel', onTouchEnd);
  };
}
