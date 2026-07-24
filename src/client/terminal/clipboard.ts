// Copy and paste for a terminal.
//
// Three things make the browser's own copy useless here:
//
//   1. The WebGL renderer paints rows to a canvas, so there is no DOM text for
//      a native selection to take. `terminal.getSelection()` is the only source
//      of truth.
//   2. The attached agent (Claude Code and friends) turns on full mouse
//      tracking at startup, so a plain drag is reported to the program instead
//      of selecting. xterm only forces a *local* selection while Shift is held —
//      hence the discoverability hint elsewhere in the UI.
//   3. `Ctrl+C` is the interrupt the agent needs, so it must stay untouched.
//
// This module is deliberately UI- and xterm-agnostic: it takes the narrow
// terminal surface it needs and its clipboard/notify collaborators by injection.
// That keeps `Ctrl+Shift+C` from ever reaching the PTY as an ETX interrupt (the
// handler swallows the whole chord) and keeps the logic testable in Node without
// a real terminal or a DOM.

/** The slice of xterm's `Terminal` this module touches. */
export interface ClipboardTerminal {
  hasSelection(): boolean;
  getSelection(): string;
  clearSelection(): void;
  paste(data: string): void;
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
}

/**
 * Indirection over `navigator.clipboard`, so a fake can be injected in a test
 * and a missing Clipboard API (insecure context, old browser) is a value the
 * caller can branch on rather than a throw.
 */
export interface ClipboardIO {
  writeText(text: string): Promise<void>;
  readText(): Promise<string>;
}

export type Notify = (message: string, variant?: 'info' | 'error') => void;

/** Remembers whether the one-time selection hint has already been shown. */
export interface HintStore {
  seen(): boolean;
  markSeen(): void;
}

export interface ClipboardDeps {
  /**
   * `undefined` means "discover the browser clipboard"; `null` means "there is
   * none" (kept distinct so a test can force the no-clipboard path explicitly).
   */
  clipboard?: ClipboardIO | null;
  notify?: Notify;
  hintStore?: HintStore;
  /** Force the Apple-platform detection (Cmd-as-Ctrl). Defaults to detection. */
  mac?: boolean;
}

const noop: Notify = () => {};

/** The real clipboard, or `null` when the Clipboard API is unavailable. */
export function browserClipboard(): ClipboardIO | null {
  const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (!clip || typeof clip.writeText !== 'function' || typeof clip.readText !== 'function') {
    return null;
  }
  return {
    writeText: (text) => clip.writeText(text),
    readText: () => clip.readText(),
  };
}

/** Whether Cmd should count as the control modifier — Apple platforms only. */
function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }
  const source = `${navigator.platform || ''} ${navigator.userAgent || ''}`;
  return /Mac|iPhone|iPad|iPod/i.test(source);
}

function resolve(deps: ClipboardDeps): { clipboard: ClipboardIO | null; notify: Notify } {
  return {
    clipboard: deps.clipboard === undefined ? browserClipboard() : deps.clipboard,
    notify: deps.notify ?? noop,
  };
}

const HINT_SEEN_KEY = 'cc-web-selection-hint';

/** localStorage-backed hint memory that degrades to "always show" if storage is
 *  unavailable (private mode, quota). */
function localStorageHintStore(): HintStore {
  return {
    seen() {
      try {
        return localStorage.getItem(HINT_SEEN_KEY) === '1';
      } catch {
        return false;
      }
    },
    markSeen() {
      try {
        localStorage.setItem(HINT_SEEN_KEY, '1');
      } catch {
        // No persistence available; the hint may show again next load. Harmless.
      }
    },
  };
}

/** Copy the current selection, if any. Returns whether the chord was "ours". */
async function copySelection(
  terminal: ClipboardTerminal,
  clipboard: ClipboardIO | null,
  notify: Notify,
): Promise<void> {
  if (!terminal.hasSelection()) {
    return;
  }
  const text = terminal.getSelection();
  if (!text) {
    return;
  }
  if (!clipboard) {
    notify('Copying needs a secure (HTTPS) connection.', 'error');
    return;
  }
  try {
    await clipboard.writeText(text);
    notify('Copied to clipboard');
  } catch {
    // writeText rejects when the document is not focused or the browser blocks
    // it; a failed copy is worth saying, but never worth a throw.
    notify('The browser blocked the copy.', 'error');
  }
}

async function pasteFromClipboard(
  terminal: ClipboardTerminal,
  clipboard: ClipboardIO | null,
  notify: Notify,
): Promise<void> {
  if (!clipboard) {
    notify('Pasting needs a secure (HTTPS) connection.', 'error');
    return;
  }
  try {
    const text = await clipboard.readText();
    if (text) {
      // Through xterm's paste path so it is bracketed exactly when the program
      // enabled DECSET 2004 — never executed line by line by a shell.
      terminal.paste(text);
    }
  } catch {
    // readText rejects when the permission prompt is denied or the document is
    // not focused. Degrade quietly rather than throwing.
    notify('The browser blocked the paste.', 'error');
  }
}

type ChordKind = 'copy' | 'paste' | null;

/**
 * Classify a key event against the copy/paste chords.
 *
 * `Ctrl+C` (no Shift) is deliberately *not* a copy chord: it stays the agent's
 * interrupt. Because xterm turns any `Ctrl`+letter into a control code and
 * ignores Shift while doing so, `Ctrl+Shift+C` would otherwise be sent as the
 * same ETX — which is exactly why every match here is swallowed.
 */
export function classifyChord(event: KeyboardEvent, mac: boolean = isApplePlatform()): ChordKind {
  // Cmd counts as the control modifier only on Apple platforms — everywhere else
  // `metaKey` is the Super/Windows key, whose chords must never paste into a live
  // agent. AltGr reports as ctrlKey+altKey, so exclude altKey too: otherwise an
  // undefined AltGr+letter combination (which leaves event.key as the base
  // letter) would misfire as a copy or paste.
  const mod = (event.ctrlKey || (mac && event.metaKey)) && !event.altKey;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

  // Copy: Ctrl/Cmd+Shift+C, or Ctrl+Insert (the fallback for browsers that bind
  // Ctrl+Shift+C to "inspect element").
  if ((mod && event.shiftKey && key === 'c') || (mod && !event.shiftKey && key === 'Insert')) {
    return 'copy';
  }

  // Paste: Ctrl/Cmd+Shift+V, or Shift+Insert.
  if ((mod && event.shiftKey && key === 'v') || (!mod && event.shiftKey && key === 'Insert')) {
    return 'paste';
  }

  return null;
}

/**
 * Build the handler for `terminal.attachCustomKeyEventHandler`.
 *
 * Returns `false` for any copy/paste chord so it is never forwarded to the PTY,
 * and `true` for everything else so `Ctrl+C`, `Ctrl+V` and ordinary typing are
 * untouched. The clipboard side effect fires once, on `keydown`.
 */
export function createClipboardKeyHandler(
  terminal: ClipboardTerminal,
  deps: ClipboardDeps = {},
): (event: KeyboardEvent) => boolean {
  const { clipboard, notify } = resolve(deps);
  const mac = deps.mac ?? isApplePlatform();

  return (event: KeyboardEvent): boolean => {
    const chord = classifyChord(event, mac);
    if (!chord) {
      return true;
    }

    // The handler fires for keydown, keypress and keyup; act once, but swallow
    // every phase of the chord so no stray key reaches the PTY.
    if (event.type !== 'keydown') {
      return false;
    }

    // Stops Chrome opening devtools on Ctrl+Shift+C, and stops the browser's own
    // Shift+Insert paste racing ours.
    event.preventDefault();
    event.stopPropagation();

    if (chord === 'copy') {
      void copySelection(terminal, clipboard, notify);
    } else {
      void pasteFromClipboard(terminal, clipboard, notify);
    }
    return false;
  };
}

/**
 * Build the `contextmenu` handler.
 *
 * With a selection: copy it, clear it, and suppress the browser menu. With no
 * selection: leave the native menu alone. On touch this is what a long-press
 * fires, which hands mobile a copy gesture for free.
 */
export function createContextMenuHandler(
  terminal: ClipboardTerminal,
  deps: ClipboardDeps = {},
): (event: MouseEvent) => void {
  const { clipboard, notify } = resolve(deps);

  return (event: MouseEvent): void => {
    if (!terminal.hasSelection()) {
      return;
    }
    event.preventDefault();

    const text = terminal.getSelection();
    if (!text) {
      return;
    }
    if (!clipboard) {
      notify('Copying needs a secure (HTTPS) connection.', 'error');
      return;
    }
    void clipboard
      .writeText(text)
      .then(() => {
        // Clear only once the copy has landed, so a blocked or unavailable write
        // leaves the selection intact to retry — matching the keyboard path.
        terminal.clearSelection();
        notify('Copied to clipboard');
      })
      .catch(() => notify('The browser blocked the copy.', 'error'));
  };
}

/** How far the pointer must move before a mousedown counts as a drag, not a click. */
const DRAG_THRESHOLD_PX = 6;

/**
 * Whether a finished drag should trigger the "hold Shift to select" hint.
 *
 * The confusing case is precisely: the user dragged (not just clicked), did not
 * hold Shift, and got no selection — which is what happens when the agent's
 * mouse tracking swallowed the drag. A Shift-drag makes a selection, so
 * `hasSelection` is true and there is nothing to explain.
 */
export function shouldHintSelection(params: {
  moved: boolean;
  shiftKey: boolean;
  hasSelection: boolean;
  alreadySeen: boolean;
}): boolean {
  return params.moved && !params.shiftKey && !params.hasSelection && !params.alreadySeen;
}

/**
 * Wire copy/paste onto a terminal and its container. Returns a detach function.
 *
 * Called from `createTerminalController()` so the main terminal and both split
 * panes get it without duplication.
 */
export function attachClipboard(
  terminal: ClipboardTerminal,
  element: HTMLElement,
  deps: ClipboardDeps = {},
): () => void {
  terminal.attachCustomKeyEventHandler(createClipboardKeyHandler(terminal, deps));

  const onContextMenu = createContextMenuHandler(terminal, deps);
  element.addEventListener('contextmenu', onContextMenu);

  const detachHint = attachSelectionHint(terminal, element, deps);

  return () => {
    element.removeEventListener('contextmenu', onContextMenu);
    detachHint();
    // Reset xterm's handler so a disposed terminal's closure is not retained.
    terminal.attachCustomKeyEventHandler(() => true);
  };
}

/**
 * Show a one-time hint the first time a plain drag is swallowed by the agent's
 * mouse tracking, so "right-click to copy" is not left with nothing to copy and
 * looking broken. Purely observational — it never calls preventDefault, so it
 * cannot disturb xterm's own selection or the program's mouse reporting.
 */
function attachSelectionHint(
  terminal: ClipboardTerminal,
  element: HTMLElement,
  deps: ClipboardDeps,
): () => void {
  const notify = deps.notify ?? noop;
  const hintStore = deps.hintStore ?? localStorageHintStore();

  let startX = 0;
  let startY = 0;
  let shiftAtStart = false;
  let moved = false;
  let dragging = false;

  const onMouseMove = (event: MouseEvent): void => {
    if (Math.abs(event.clientX - startX) > DRAG_THRESHOLD_PX
      || Math.abs(event.clientY - startY) > DRAG_THRESHOLD_PX) {
      moved = true;
    }
  };

  const onMouseUp = (): void => {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    if (!dragging) {
      return;
    }
    dragging = false;

    if (shouldHintSelection({
      moved,
      shiftKey: shiftAtStart,
      hasSelection: terminal.hasSelection(),
      alreadySeen: hintStore.seen(),
    })) {
      hintStore.markSeen();
      notify('Tip: hold Shift and drag to select text while an agent is running.');
    }
  };

  const onMouseDown = (event: MouseEvent): void => {
    // Primary button only; a right-click is the contextmenu copy path.
    if (event.button !== 0) {
      return;
    }
    startX = event.clientX;
    startY = event.clientY;
    shiftAtStart = event.shiftKey;
    moved = false;
    dragging = true;
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  element.addEventListener('mousedown', onMouseDown);

  return () => {
    element.removeEventListener('mousedown', onMouseDown);
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  };
}
