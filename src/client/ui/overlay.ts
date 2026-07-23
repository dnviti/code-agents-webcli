// Overlay management: loading spinner, start prompt, error display
//
// The overlay is rendered by `OverlayHost` now. These three functions keep
// their names and signatures — the connection, session and message-handler code
// calls them from about twenty places — and set store state instead of toggling
// `display` on three sibling divs.

import { shellStore, type OverlayView } from '../shell/store';

/**
 * The legacy content ids, kept as accepted input.
 *
 * Every existing call site passes one of these strings. Translating here rather
 * than rewriting them all means the overlay's contract with the session code is
 * unchanged, and an unrecognised id fails loudly instead of silently showing
 * nothing.
 */
const VIEWS: Record<string, OverlayView> = {
  loadingSpinner: 'loading',
  startPrompt: 'start',
  errorMessage: 'error',
  loading: 'loading',
  start: 'start',
  error: 'error',
};

/**
 * Show one overlay view.
 *
 * `message` replaces the loading view's default line. The runtime-start paths
 * use it to say *which* runtime is starting and on what terms ("Starting Claude
 * (skipping permissions)…"). That text used to be written straight into the
 * spinner's `<p>`; passing it here keeps it, and keeps it out of the DOM.
 */
export function showOverlay(contentId: string, message?: string): void {
  const view = VIEWS[contentId];
  if (!view) {
    console.error(`showOverlay: unknown view "${contentId}"`);
    return;
  }
  shellStore.setState({ overlay: view, overlayMessage: message ?? '' });
}

export function hideOverlay(): void {
  shellStore.setState({ overlay: null, overlayMessage: '' });
}

export function showError(message: string): void {
  shellStore.setState({ overlay: 'error', errorText: message });
}

/**
 * Whether an overlay is currently up.
 *
 * The reconnect path only re-shows the spinner when the overlay is already
 * covering the terminal, so that a background reconnect does not interrupt
 * someone reading their output. It used to ask the DOM
 * (`#overlay.style.display !== 'none'`); with the markup gone that lookup
 * returned null and the check silently became "never".
 */
export function isOverlayVisible(): boolean {
  return shellStore.getSnapshot().overlay !== null;
}
