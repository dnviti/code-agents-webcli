/**
 * Lazy loader for the Monaco chunk.
 *
 * The same shape as the Mermaid loader next door, with one addition: Monaco
 * ships styles as well as script, so this injects a stylesheet too and does not
 * resolve until *both* have arrived. Resolving on the script alone renders the
 * editor unstyled for a frame or two — every widget stacked in the top-left
 * corner — which reads as a broken editor rather than as a loading one.
 */

const BUNDLE_URL = '/monaco.bundle.js';
const STYLE_URL = '/monaco.bundle.css';
const GLOBAL = 'ClaudeCodeWebMonaco';

export type MonacoTheme = 'dark' | 'light';

export interface MonacoCreateOptions {
  value: string;
  path?: string;
  /** One-based line to put under the cursor when the editor opens. */
  initialLine?: number;
  readOnly?: boolean;
  theme: MonacoTheme;
  ariaLabel?: string;
  onChange?: (value: string) => void;
  onSave?: () => void;
}

export interface MonacoHandle {
  getValue(): string;
  setValue(next: string): void;
  setReadOnly(readOnly: boolean): void;
  setTheme(theme: MonacoTheme): void;
  revealLine(line: number): void;
  layout(): void;
  focus(): void;
  dispose(): void;
}

export interface MonacoModule {
  create(container: HTMLElement, options: MonacoCreateOptions): MonacoHandle;
}

declare global {
  interface Window {
    [GLOBAL]?: MonacoModule;
  }
}

let loading: Promise<MonacoModule> | null = null;

/**
 * Load the stylesheet, and mean it.
 *
 * This used to take `link[href="/monaco.bundle.css"]` existing as proof that
 * the stylesheet had applied. It is not: a link whose request failed stays in
 * the head looking exactly like one that succeeded. So a single failed CSS
 * fetch — a LAN blip, or the service restarting under an open page, both of
 * which this app treats as routine — poisoned every later open in that page.
 * The loader cleared its own cached promise so the script would be retried, the
 * script came back fine, and Monaco was created with none of its stylesheet:
 * `.view-line` fell back to `position: static`, so the reader saw Monaco's
 * line-recycling order instead of the file's, and `.inputarea` lost
 * `resize: none` and became a bare textarea drawn over the first line.
 *
 * The element is held here rather than looked up, so a failed one is discarded
 * and the next attempt starts a real request instead of inheriting a corpse.
 */
let styles: Promise<void> | null = null;

function loadStyles(): Promise<void> {
  if (styles) return styles;

  styles = new Promise<void>((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = STYLE_URL;
    link.onload = () => resolve();
    link.onerror = () => {
      // Removed, not left behind: this one will never carry any rules, and
      // leaving it is what made the failure permanent in the first place.
      link.remove();
      reject(new Error('could not load the editor stylesheet'));
    };
    document.head.appendChild(link);
  }).catch((error: unknown) => {
    styles = null;
    throw error;
  });

  return styles;
}

/**
 * Whether Monaco's own rules are actually in effect on this document.
 *
 * Asked of the layout engine rather than of the network, because those are
 * different questions and it is the second one this file kept getting wrong. A
 * stylesheet can be fetched and still not apply — served with the wrong type,
 * emptied by a proxy, or, as above, represented by a link that never carried
 * anything — and every one of those produces an editor that looks like it is
 * working and shows the file in an order it is not in.
 *
 * `.monaco-editor .view-line { position: absolute }` is the rule the whole
 * rendering rests on: Monaco positions every line by writing `top` on it, so
 * without it the lines stack in whatever order the recycler left them in. If
 * that one rule is live, the stylesheet is there.
 */
export function monacoStylesApplied(): boolean {
  try {
    const editor = document.createElement('div');
    editor.className = 'monaco-editor';
    // Kept out of the way and out of the accessibility tree, but *laid out* —
    // `display: none` would answer `static` whatever the stylesheet says.
    editor.setAttribute('aria-hidden', 'true');
    editor.style.cssText = 'position:absolute;top:-9999px;left:-9999px;width:1px;height:1px;overflow:hidden';
    const line = document.createElement('div');
    line.className = 'view-line';
    editor.appendChild(line);
    document.body.appendChild(editor);
    const applied = getComputedStyle(line).position === 'absolute';
    editor.remove();
    return applied;
  } catch {
    // No document to ask. Nothing renders here either, so this answer is never
    // the reason an editor is refused.
    return true;
  }
}

function loadScript(): Promise<MonacoModule> {
  return new Promise((resolve, reject) => {
    // Already here, from an attempt that got this far and then failed on the
    // stylesheet. Fetching four and a half megabytes again to be told the same
    // thing helps nobody.
    const already = window[GLOBAL];
    if (already) {
      resolve(already);
      return;
    }

    const script = document.createElement('script');
    script.src = BUNDLE_URL;
    script.async = true;
    script.onload = () => {
      const mod = window[GLOBAL];
      if (mod) resolve(mod);
      else reject(new Error('the editor bundle loaded but exposed nothing'));
    };
    script.onerror = () => reject(new Error('could not load the code editor'));
    document.head.appendChild(script);
  });
}

/**
 * Load the chunk, at most once per page.
 *
 * The promise is cached rather than a boolean flag, for the same reason the
 * Mermaid loader caches its own: two editors can open in the same tick, and a
 * flag would race and inject the script twice.
 */
export function loadMonaco(): Promise<MonacoModule> {
  // The script and the stylesheet fail independently, and the script is the one
  // that publishes the global — so a page that lost only the stylesheet has a
  // perfectly good `window.ClaudeCodeWebMonaco` and an editor that cannot
  // render. Both have to be there before this shortcut is taken.
  const existing = window[GLOBAL];
  if (existing && monacoStylesApplied()) return Promise.resolve(existing);
  if (loading) return loading;

  loading = Promise.all([loadStyles(), loadScript()])
    .then(([, mod]) => {
      // The last gate, and the one that answers the question this editor was
      // reported for: an editor that renders a file in the wrong order is worse
      // than no editor, because it looks like the file is what is broken. If
      // the rules are not live, this rejects and the caller falls back to the
      // app's own editor, which says so and is correct.
      if (!monacoStylesApplied()) {
        // Forgotten as well as refused, so the next open fetches the stylesheet
        // again rather than trusting the one that arrived and did nothing.
        styles = null;
        throw new Error('the editor stylesheet did not apply');
      }
      return mod;
    })
    .catch((error: unknown) => {
      // Let the next open try again: the usual cause is a transient fetch
      // failure, and poisoning the loader for the rest of the session would
      // mean one bad moment costs the editor permanently.
      loading = null;
      throw error;
    });

  return loading;
}

/** Which of the two themes the page is currently in. */
export function currentMonacoTheme(): MonacoTheme {
  try {
    return document.documentElement.classList.contains('light') ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}
