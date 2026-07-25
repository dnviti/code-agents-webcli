/**
 * Keeping a scroller pinned to its bottom edge.
 *
 * "Am I at the bottom" is sampled from live geometry every time, never held in
 * React state: state is a render behind the layout it claims to describe, and
 * the one moment that matters is the frame in which the content grew.
 *
 * Two independent things move the bottom of a transcript, and watching only the
 * first is the classic defect on this surface:
 *
 *   1. the content grows — a streamed answer, a web font swapping in, an image
 *      decoding;
 *   2. the viewport shrinks — the terminal split opening, the window resizing,
 *      the on-screen keyboard arriving.
 *
 * A formerly-pinned scroller that only watches (1) ends up short by exactly the
 * height the viewport lost, so both the content wrapper and the scroller box are
 * observed, through the same rule.
 *
 * DOM-only and framework-free: React owns when to attach, this owns what to do.
 */

export interface StickHandle {
  attachScroller(el: HTMLElement | null): void;
  attachContent(el: HTMLElement | null): void;
  /** Scroll to the bottom, if stuck — or unconditionally when forced. */
  pin(force?: boolean): void;
  /** Live geometry, not a cached flag. */
  isStuck(): boolean;
  /** Re-sample from the current scroll position, e.g. from an onScroll handler. */
  sample(): void;
  dispose(): void;
}

/** How close to the bottom edge still counts as being at it, in px. */
export const BOTTOM_SLACK = 24;

export function createStick(slackPx: number = BOTTOM_SLACK): StickHandle {
  let scroller: HTMLElement | null = null;
  let content: HTMLElement | null = null;
  let stuck = true;
  let observer: ResizeObserver | null = null;
  let disposed = false;

  const atBottom = (el: HTMLElement): boolean =>
    el.scrollHeight - el.scrollTop - el.clientHeight <= slackPx;

  const sample = (): void => {
    if (!scroller) return;
    stuck = atBottom(scroller);
  };

  const pin = (force?: boolean): void => {
    const el = scroller;
    if (!el) return;
    if (!force && !stuck) return;
    stuck = true;
    el.scrollTop = el.scrollHeight;
  };

  const onScroll = (): void => sample();
  const onResize = (): void => pin();
  const onLoad = (): void => pin();

  const observe = (el: HTMLElement | null): void => {
    if (!el || typeof ResizeObserver === 'undefined') return;
    if (!observer) observer = new ResizeObserver(() => pin());
    observer.observe(el);
  };

  const unobserve = (el: HTMLElement | null): void => {
    if (!el || !observer) return;
    observer.unobserve(el);
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('resize', onResize);
  }

  return {
    attachScroller(el: HTMLElement | null): void {
      if (disposed || scroller === el) return;
      if (scroller) {
        scroller.removeEventListener('scroll', onScroll);
        scroller.removeEventListener('load', onLoad, true);
        unobserve(scroller);
      }
      scroller = el;
      if (!el) return;
      el.addEventListener('scroll', onScroll, { passive: true });
      observe(el);
      pin(true);
      // Late async layout, both halves. A web font swapping in after first
      // paint reflows the whole transcript; an image finishing its decode does
      // the same locally, and an attached screenshot is exactly the case — it
      // lands under the newest turn and pushes it off the bottom.
      if (typeof document !== 'undefined' && document.fonts?.ready) {
        document.fonts.ready.then(() => pin()).catch(() => {
          /* No web font is not a reason to lose the scroll position. */
        });
      }
      // Capture: `load` does not bubble from an <img>, so a listener on the
      // scroller only ever sees it on the way down.
      el.addEventListener('load', onLoad, true);
    },

    attachContent(el: HTMLElement | null): void {
      if (disposed || content === el) return;
      if (content) unobserve(content);
      content = el;
      observe(el);
    },

    pin,
    sample,

    isStuck(): boolean {
      return scroller ? atBottom(scroller) : stuck;
    },

    dispose(): void {
      disposed = true;
      if (typeof window !== 'undefined') window.removeEventListener('resize', onResize);
      if (scroller) {
        scroller.removeEventListener('scroll', onScroll);
        scroller.removeEventListener('load', onLoad, true);
      }
      observer?.disconnect();
      observer = null;
      scroller = null;
      content = null;
    },
  };
}
