/**
 * Entry point for the on-demand Mermaid chunk.
 *
 * Built to dist/public/mermaid.bundle.js as its own IIFE, exposed on
 * `window.ClaudeCodeWebMermaid`. It is a separate bundle rather than part of
 * app.bundle.js because Mermaid outweighs the entire rest of the client and is
 * only needed once a message actually contains a diagram — see the [mermaid]
 * step in scripts/build.js.
 */

import mermaid from 'mermaid';

let initializedTheme: string | null = null;

/**
 * Configure Mermaid for the current theme.
 *
 * `securityLevel: 'strict'` is not optional here. Diagram source is model
 * output, i.e. untrusted text, and strict mode is what makes Mermaid sanitise
 * the SVG it generates and refuse the click/script directives its own syntax
 * otherwise allows. Loosening this would hand any agent that can write a fence
 * a way to put script into the page.
 */
function configure(theme: 'dark' | 'light'): void {
  if (initializedTheme === theme) return;
  initializedTheme = theme;

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: theme === 'dark' ? 'dark' : 'default',
    darkMode: theme === 'dark',
    fontFamily: 'var(--font-sans), system-ui, sans-serif',
    themeVariables: {
      // Read from the live custom properties so a diagram sits in the same
      // palette as the message around it instead of importing Mermaid's own.
      background: readVar('--card') || undefined,
      primaryColor: readVar('--secondary') || undefined,
      primaryTextColor: readVar('--foreground') || undefined,
      primaryBorderColor: readVar('--border') || undefined,
      lineColor: readVar('--muted-foreground') || undefined,
      textColor: readVar('--foreground') || undefined,
      mainBkg: readVar('--secondary') || undefined,
    },
  });
}

function readVar(name: string): string {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  } catch {
    return '';
  }
}

export interface MermaidRenderResult {
  svg: string;
}

/**
 * Render one diagram.
 *
 * Rejects on invalid syntax, which is the common case while a fence is still
 * streaming in — the caller shows the source until it parses.
 */
export async function render(
  id: string,
  code: string,
  theme: 'dark' | 'light',
): Promise<MermaidRenderResult> {
  configure(theme);
  const { svg } = await mermaid.render(id, code);
  return { svg };
}

/** Whether the source parses, without committing to a full render. */
export async function validate(code: string, theme: 'dark' | 'light'): Promise<boolean> {
  configure(theme);
  try {
    await mermaid.parse(code);
    return true;
  } catch {
    return false;
  }
}
