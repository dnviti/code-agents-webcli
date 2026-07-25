/**
 * Lazy loader for the Mermaid chunk.
 *
 * The renderer lives in a separate bundle (see mermaid-entry.ts) that is only
 * fetched the first time a message contains a diagram. Everything here is about
 * doing that once, safely, and degrading to source text when it cannot be done
 * at all — a diagram that fails to load must leave the code fence readable, not
 * a blank space where an answer used to be.
 */

const BUNDLE_URL = '/mermaid.bundle.js';
const GLOBAL = 'ClaudeCodeWebMermaid';

export interface MermaidModule {
  render(id: string, code: string, theme: 'dark' | 'light'): Promise<{ svg: string }>;
  validate(code: string, theme: 'dark' | 'light'): Promise<boolean>;
}

declare global {
  interface Window {
    [GLOBAL]?: MermaidModule;
  }
}

let loading: Promise<MermaidModule> | null = null;

/**
 * Load the chunk, at most once per page.
 *
 * The promise is cached rather than a boolean flag: several diagrams typically
 * appear in one message and all of them ask at the same moment, so a flag would
 * race and inject the script more than once.
 */
export function loadMermaid(): Promise<MermaidModule> {
  const existing = window[GLOBAL];
  if (existing) return Promise.resolve(existing);
  if (loading) return loading;

  loading = new Promise<MermaidModule>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = BUNDLE_URL;
    script.async = true;

    script.onload = () => {
      const mod = window[GLOBAL];
      if (mod) {
        resolve(mod);
      } else {
        reject(new Error('mermaid bundle loaded but exposed nothing'));
      }
    };

    script.onerror = () => {
      // Let a later diagram try again: the usual cause is a transient fetch
      // failure, and permanently poisoning the loader would mean one bad
      // moment disables diagrams for the rest of the session.
      loading = null;
      reject(new Error('could not load the diagram renderer'));
    };

    document.head.appendChild(script);
  });

  return loading;
}

/** True when a fence language should be rendered as a diagram. */
export function isMermaidLanguage(lang: string | null | undefined): boolean {
  const key = String(lang || '').toLowerCase().trim();
  return key === 'mermaid';
}

let counter = 0;

/**
 * Mermaid needs a DOM id unique across the document.
 *
 * It appends a temporary element under that id while measuring, so a collision
 * between two diagrams rendering at once corrupts both.
 */
export function nextDiagramId(): string {
  counter += 1;
  return `cc-mermaid-${counter}`;
}
