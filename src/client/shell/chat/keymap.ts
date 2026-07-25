/**
 * The chat surface's keyboard map.
 *
 * One listener, registered by the chat root, so there is a single place that
 * decides what a key means on this surface — and a single place that knows when
 * it means nothing at all.
 *
 * Two exemptions matter more than the shortcuts themselves:
 *
 *   - **the terminal split.** Escape inside a pty is a byte the shell wants; if
 *     this stole it, `vi` would be unusable in a pane the user opened precisely
 *     so they could use it.
 *   - **dialogs and text fields.** ⌘F over a file editor is that editor's find,
 *     and a shortcut that fires from inside a modal acts on a surface the user
 *     cannot currently see.
 */

export type ChatCommand =
  | 'toggle-terminal'
  | 'interrupt'
  | 'search'
  | 'previous-turn'
  | 'next-turn'
  | 'toggle-rail'
  | 'jump-latest';

export interface KeymapContext {
  /** True while focus is inside the terminal pane. */
  terminalFocused: boolean;
  /** True while a modal dialog owns the screen. */
  dialogOpen: boolean;
  /** True while focus is in a textarea, an input, or a contenteditable. */
  textEntry: boolean;
  /**
   * True while the composer's slash/@ picker is open.
   *
   * Escape belongs to the picker then — dismissing a completion list is what
   * the user meant, not stopping the agent.
   */
  pickerOpen?: boolean;
  /**
   * Running on a Mac.
   *
   * It decides which modifier is the *application* one. On macOS Ctrl+B, Ctrl+F
   * and Ctrl+A are caret motions in every text field, so a ctrl chord typed
   * into the composer belongs to the composer; the Command key is the app's.
   * Everywhere else it is the other way round.
   */
  mac?: boolean;
}

/**
 * Which command a keystroke means here, or null.
 *
 * Pure and DOM-free so the whole table is testable without a browser; the
 * caller supplies the two facts about the surface that change the answer.
 */
export function chatCommandFor(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
  context: KeymapContext,
): ChatCommand | null {
  if (context.dialogOpen) return null;

  const mod = event.metaKey || event.ctrlKey;

  // Ctrl+` reaches the terminal too: it is the way *out* of the pane, and a
  // shortcut you can only use when you are not already there is a trap.
  if (event.key === '`' && mod && !event.altKey) return 'toggle-terminal';

  if (context.terminalFocused) return null;

  // Escape stops the turn from anywhere on the surface — including the
  // composer, which is where focus sits by default and therefore where you are
  // standing when you decide to stop it. The two exemptions are the terminal
  // (handled above) and an open picker, whose dismiss this is.
  if (event.key === 'Escape' && !mod) return context.pickerOpen ? null : 'interrupt';
  if (!mod) return null;

  // AltGr is reported as ctrl+alt on Windows and Linux, so a chord that only
  // checked ctrl would fire on ordinary typing in those layouts.
  if (event.altKey && event.ctrlKey && !event.metaKey) return null;

  if (context.textEntry) {
    // The arrows are caret motions with a modifier on every platform —
    // start/end of the draft — so they always belong to the field.
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') return null;
    // And on a Mac a ctrl chord is a caret motion too. The letters below are
    // the app's only when the app's modifier was the one held.
    if (context.mac ? !event.metaKey : !event.ctrlKey) return null;
  }

  switch (event.key.toLowerCase()) {
    case 'f':
      return 'search';
    case 'b':
      return 'toggle-rail';
    case 'j':
      return 'jump-latest';
    case 'arrowup':
      return 'previous-turn';
    case 'arrowdown':
      return 'next-turn';
    default:
      return null;
  }
}

/** True when the event landed in something that takes typed text. */
export function isTextEntry(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || !element.tagName) return false;
  const tag = element.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || element.isContentEditable === true;
}
