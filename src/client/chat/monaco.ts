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

function loadStyles(): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`link[href="${STYLE_URL}"]`);
    if (existing) {
      resolve();
      return;
    }
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = STYLE_URL;
    link.onload = () => resolve();
    link.onerror = () => reject(new Error('could not load the editor stylesheet'));
    document.head.appendChild(link);
  });
}

function loadScript(): Promise<MonacoModule> {
  return new Promise((resolve, reject) => {
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
  const existing = window[GLOBAL];
  if (existing) return Promise.resolve(existing);
  if (loading) return loading;

  loading = Promise.all([loadStyles(), loadScript()])
    .then(([, mod]) => mod)
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
