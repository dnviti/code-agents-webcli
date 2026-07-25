/**
 * Keeping the browser's own shortcuts out of the surfaces that consume keys.
 *
 * A terminal and a code editor are the two places in a web app where the
 * browser's keyboard defaults are actively wrong. `Ctrl+R` is reverse history
 * search in every shell anyone uses, and reloading the page instead loses the
 * session's scrollback; `Ctrl+U` kills the line, and viewing the page source
 * does not; `Ctrl+P`, `Ctrl+E`, `Ctrl+B`, `Ctrl+O`, `Ctrl+J` are all readline
 * bindings before they are browser menus. Until this existed both happened at
 * once: the byte reached the shell *and* the browser did its thing.
 *
 * The guard is a single capture-phase listener that calls `preventDefault` and
 * nothing else. Deliberately not `stopPropagation` — the whole point is that
 * xterm and Monaco still receive the event and act on it. All this removes is
 * the browser's parallel interpretation.
 *
 * Scope is opt-in, by marking an element with `data-claims-shortcuts`. It is not
 * document-wide: in the chat composer, in a dialog, in a text field, the
 * browser's defaults are the right behaviour and taking them away would be the
 * bug rather than the fix.
 *
 * ## What is deliberately not claimed
 *
 * - **Ctrl+C / V / X / A / Z / Y.** For these the browser's default *is* the
 *   mechanism — a copy that is prevented is a copy that does not happen. The
 *   terminal's own clipboard handler already owns the chords it needs (see
 *   terminal/clipboard.ts) and this must not fight it.
 * - **F5 and Ctrl+Shift+R.** Reload has to stay reachable from the keyboard.
 *   Every other claimed chord has a real meaning in a shell or an editor; F5
 *   has none in either, so claiming it would cost the escape hatch and buy
 *   nothing. `Ctrl+R` is claimed because a shell genuinely wants it, and this
 *   pair is what keeps reload available anyway.
 * - **Ctrl+T, Ctrl+W, Ctrl+N, Ctrl+Shift+T/N/W, Ctrl+Tab, F12.** Not a choice:
 *   these are reserved by the browser and a page never sees them. Listing them
 *   here is the documentation that their absence is not an oversight.
 */

/**
 * Chords with a browser default that a terminal or an editor should win.
 *
 * Single letters, matched against `event.key` lowercased, and taken with Ctrl
 * (or Cmd on a Mac) and no other modifier.
 */
const CLAIMED_LETTERS = new Set([
  'b', // bookmarks bar        — readline: back one character
  'd', // bookmark this page   — Monaco: add selection to next match
  'e', // search from address  — readline: end of line
  'f', // browser find         — editor find
  'g', // find next            — editor go to line
  'h', // history              — editor replace
  'j', // downloads            — readline: newline
  'k', // search bar           — Monaco chord prefix
  'l', // address bar          — readline: clear screen
  'o', // open a file          — readline: operate-and-get-next
  'p', // print                — readline: previous history
  'r', // reload               — readline: reverse search
  's', // save page            — save the open file
  'u', // view source          — readline: kill line backwards
]);

/** Function keys with a browser default and no text of their own. */
const CLAIMED_KEYS = new Set(['f3', 'f6', 'f7']);

/** Modifier-key names, so a lone Ctrl press is never treated as a chord. */
const MODIFIER_KEYS = new Set(['control', 'shift', 'alt', 'meta', 'altgraph']);

/**
 * True on a platform where `metaKey` means Command rather than Super/Windows.
 *
 * The distinction matters: off a Mac, `metaKey` is the Super key, and treating
 * it as Ctrl would claim chords the window manager owns — the same trap the
 * terminal's clipboard chords are already careful about.
 */
function isApplePlatform(): boolean {
  try {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    const platform = nav.userAgentData?.platform || nav.platform || '';
    return /mac|iphone|ipad|ipod/i.test(platform);
  } catch {
    return false;
  }
}

export interface ShortcutMatchOptions {
  /** Overridable so the tests can exercise both platforms on one machine. */
  mac?: boolean;
}

/**
 * Whether this event is a browser shortcut an app surface should take.
 *
 * Exported so it can be tested directly: the interesting cases here are the
 * ones that must come back false — AltGr, Super, a bare letter — and driving
 * those through a real listener proves much less than asserting on them.
 */
export function isClaimedBrowserShortcut(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
  options: ShortcutMatchOptions = {},
): boolean {
  const key = String(event.key || '').toLowerCase();
  if (!key || MODIFIER_KEYS.has(key)) return false;

  const mac = options.mac ?? isApplePlatform();

  // Alt+Left / Alt+Right are Back and Forward, and are the one claimed chord
  // that is not Ctrl-based. Checked before the AltGr guard below, which is
  // about Ctrl+Alt specifically.
  if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
    return key === 'arrowleft' || key === 'arrowright';
  }

  // A bare function key.
  if (CLAIMED_KEYS.has(key)) {
    return !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
  }

  // AltGr reports as Ctrl+Alt on Windows and Linux layouts, so Ctrl+Alt+<key>
  // is somebody typing `@`, `#` or `[`, not reaching for a browser menu. Same
  // guard the terminal's clipboard chords carry.
  if (event.altKey) return false;

  // Cmd on a Mac, Ctrl everywhere else. Never Super, which is what `metaKey`
  // reports off a Mac.
  const primary = mac ? event.metaKey : event.ctrlKey;
  if (!primary) return false;
  if (mac ? event.ctrlKey : event.metaKey) return false;

  // Shift changes the meaning of every one of these — Ctrl+Shift+R is the
  // reload that has to stay reachable, and Ctrl+Shift+C is devtools.
  if (event.shiftKey) return false;

  return CLAIMED_LETTERS.has(key);
}

/** Marks a surface as one whose keys the browser must keep its hands off. */
export const CLAIM_ATTRIBUTE = 'data-claims-shortcuts';

/**
 * Install the guard, once, for the whole page.
 *
 * Capture phase, so it runs before xterm's and Monaco's own handlers and before
 * the browser has committed to its default. It still only ever calls
 * `preventDefault`, so both of them go on receiving the event.
 */
export function installBrowserShortcutGuard(
  root: Document = document,
  options: ShortcutMatchOptions = {},
): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as Element | null;
    if (!target || typeof target.closest !== 'function') return;
    if (!target.closest(`[${CLAIM_ATTRIBUTE}]`)) return;
    if (!isClaimedBrowserShortcut(event, options)) return;
    event.preventDefault();
  };

  root.addEventListener('keydown', onKeyDown, true);
  return () => root.removeEventListener('keydown', onKeyDown, true);
}
