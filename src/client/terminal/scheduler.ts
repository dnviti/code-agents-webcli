/**
 * Runs a callback on the next animation frame, with a timer as a safety net.
 *
 * `requestAnimationFrame` is not guaranteed to fire: browsers starve it in
 * background tabs, and some embedded webviews and headless environments never
 * run it at all even while reporting the page as visible. Anything queued
 * behind a bare rAF — terminal output, a pending repaint — would simply never
 * be flushed there. Whichever of the two fires first wins and cancels the other.
 */
export interface FrameScheduler {
  schedule(task: () => void): void;
  cancel(): void;
}

const FALLBACK_DELAY_MS = 100;

export function createFrameScheduler(fallbackDelayMs = FALLBACK_DELAY_MS): FrameScheduler {
  let frame: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = (): void => {
    if (frame !== null) {
      // Guarded because a host can have one half of the pair and not the other:
      // the timer above is the whole reason this module exists, and it fires
      // exactly where rAF was never going to. Crashing in the cleanup of a
      // fallback that just did its job would be the worst place to be strict.
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
      frame = null;
    }
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    schedule(task: () => void): void {
      // Already pending: coalesce rather than queueing a second run.
      if (frame !== null || timer !== null) {
        return;
      }

      const run = (): void => {
        cancel();
        task();
      };

      frame = requestAnimationFrame(run);
      timer = setTimeout(run, fallbackDelayMs);
    },
    cancel,
  };
}
