/**
 * Entry point for the on-demand Monaco chunk.
 *
 * Built to dist/public/monaco.bundle.js as its own IIFE on
 * `window.ClaudeCodeWebMonaco`, exactly the way the Mermaid renderer is — and
 * for the same reason. Monaco is several megabytes; the file editor is a panel
 * most sessions never open, and a session that never opens it should not pay
 * for it. See the [monaco] step in scripts/build.js.
 *
 * Two things about what is imported:
 *
 *   - `editor.main`, which is the entry that carries the editor *contributions*
 *     — find and replace, folding, multi-cursor, the context menu, bracket
 *     matching, and the core editing commands. `editor.api` is 1.6 MB smaller
 *     and was tried first; it produces an editor that renders a file beautifully
 *     and cannot be typed into, because in 0.56 there is no `editor.all` and the
 *     contributions exist nowhere else. The smaller import is not a cheaper
 *     version of this one, it is a different product.
 *   - The language *services* are left switched off. `editor.main` exposes them
 *     as opt-in exports (`css`, `html`, `json`, `typescript`) and registers none
 *     of them, which is what this wants: Monaco's TypeScript service only ever
 *     sees the single open buffer, so it cannot resolve one import in this
 *     project and would underline most of every real source file in red. Its
 *     worker alone is 6.7 MB — spent making the editor confidently wrong.
 *     Syntax highlighting comes from the Monarch grammars, which `editor.main`
 *     does register, for about ninety languages.
 *
 * And no CDN. `MonacoEnvironment` points at a worker this build produced and
 * this server serves, because this app is routinely run on a LAN with no route
 * out, and an editor that only works with internet access is not one.
 *
 * The font is inlined as a data URI by the build rather than shipped beside the
 * CSS, so there is no second asset whose path has to survive the copy step.
 */

import * as monaco from 'monaco-editor/editor/editor.main';
// The icon font. `editor.main` registers the widgets that use codicons but does
// not import the stylesheet that gives those class names glyphs, so without
// these every icon Monaco draws — the folding arrows, the find widget's
// buttons, the context-menu chevrons — is a tofu box.
//
// Aliased in scripts/build.js rather than imported by package path: Monaco's
// `exports` map rewrites every subpath to `./esm/vs/*.js`, so a `.css` subpath
// resolves to a JavaScript file that does not exist. The alias is resolved
// there with `require.resolve`, which is the one place that knows where the
// package actually sits under hoisting.
import 'monaco-codicons/codicon.css';
import 'monaco-codicons/codicon-modifiers.css';

export type ThemeName = 'dark' | 'light';

export interface CreateOptions {
  value: string;
  /**
   * Path of the file being edited, used only to pick a language.
   *
   * Monaco resolves it from the URI's extension against its own registry, which
   * is why this is a path and not a language name: the app's own
   * `languageForFile` knows eleven grammars because that is what its
   * highlighter ships, and squeezing ninety through an eleven-entry table would
   * throw away most of what this chunk was added for.
   */
  path?: string;
  readOnly?: boolean;
  theme: ThemeName;
  ariaLabel?: string;
  onChange?: (value: string) => void;
  onSave?: () => void;
}

export interface MonacoHandle {
  getValue(): string;
  /** Replace the text without losing the cursor, if it really changed. */
  setValue(next: string): void;
  setReadOnly(readOnly: boolean): void;
  setTheme(theme: ThemeName): void;
  layout(): void;
  focus(): void;
  dispose(): void;
}

const DARK = 'cc-web-dark';
const LIGHT = 'cc-web-light';

let themesDefined = false;
let workerConfigured = false;
let servicesDisabled = false;

/**
 * Switch off the language *services*, which import themselves in.
 *
 * `editor.main` calls `languages.onLanguage('typescript', …)` at import time —
 * and the same for JavaScript, CSS, LESS, SCSS, HTML and JSON — so opening a
 * `.ts` file activated a service that immediately asked a worker for
 * `getSyntacticDiagnostics` and threw, because the only worker this build ships
 * is Monaco's plain editor worker. Every TypeScript file opened produced that
 * exception.
 *
 * The fix is not to ship the missing workers. That is 8.8 MB, and the largest
 * of them buys the wrong answer: Monaco's TypeScript service sees only the open
 * buffer, so it cannot resolve a single import in this project and would report
 * an error on most lines of most real files. This is a viewer and editor for a
 * file on a server, not an IDE, and a red squiggle under a correct import is
 * worse than no squiggle at all.
 *
 * `setModeConfiguration` with everything false unregisters the providers rather
 * than merely quietening them, so nothing is left to call a worker. Syntax
 * highlighting is untouched: that comes from the Monarch grammars in
 * `languages/definitions`, which are a different registration entirely.
 */
function disableLanguageServices(): void {
  if (servicesDisabled) return;
  servicesDisabled = true;

  const off = {
    completionItems: false,
    hovers: false,
    documentSymbols: false,
    definitions: false,
    references: false,
    documentHighlights: false,
    rename: false,
    colors: false,
    foldingRanges: false,
    diagnostics: false,
    selectionRanges: false,
    documentFormattingEdits: false,
    documentRangeFormattingEdits: false,
    signatureHelp: false,
    onTypeFormattingEdits: false,
    codeActions: false,
    inlayHints: false,
    tokens: false,
    links: false,
    documentRangeSemanticTokens: false,
    documentSemanticTokens: false,
  };

  // Every one is optional at runtime: which of them a given Monaco build
  // exposes is a property of that build, and a missing one must not take the
  // editor down on its way to being switched off.
  const bundle = monaco as unknown as Record<string, Record<string, unknown> | undefined>;
  for (const feature of ['typescript', 'css', 'html', 'json']) {
    const group = bundle[feature];
    if (!group) continue;
    for (const value of Object.values(group)) {
      const defaults = value as { setModeConfiguration?: (config: unknown) => void } | null;
      try {
        defaults?.setModeConfiguration?.(off);
      } catch {
        // A defaults object that refuses the shape is one that was never going
        // to call a worker on our behalf either.
      }
    }
  }
}

/**
 * Where Monaco's own worker comes from.
 *
 * Set once, before any editor exists, and pointed at a same-origin file this
 * build emitted. Monaco falls back to running its worker code on the main
 * thread if this throws, so a missing worker degrades to a slower editor rather
 * than to no editor — but it is emitted by the same build step as this chunk,
 * so it is there.
 */
function configureWorker(): void {
  if (workerConfigured) return;
  workerConfigured = true;
  (self as unknown as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
    getWorker(): Worker {
      return new Worker('/monaco-editor.worker.js');
    },
  };
}

/** A CSS custom property off the live document, or '' when it is not set. */
function readVar(name: string): string {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  } catch {
    return '';
  }
}

/**
 * A hex colour Monaco will accept, or a stated fallback.
 *
 * Monaco's theme parser takes `#rgb`, `#rrggbb` and `#rrggbbaa` and nothing
 * else — no `rgb()`, no `color-mix()`, no custom property. The tokens this app
 * defines are all hex today, but a themeable app is exactly where that stops
 * being true, and Monaco answers a colour it cannot parse by throwing during
 * `defineTheme`, which would take the whole editor down rather than one colour.
 */
function colour(name: string, fallback: string): string {
  const value = readVar(name);
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value) ? value : fallback;
}

/**
 * Define both themes from the live palette.
 *
 * Re-run on every theme change, not once. The colours below are read out of the
 * document's own custom properties, and those are what the light/dark switch
 * rewrites — so defining both themes a single time captured whichever palette
 * happened to be live at that moment and gave the *other* one the wrong
 * colours. Switching to light produced a light chrome full of dark-theme
 * token colours.
 *
 * The token roles are mapped onto the same ANSI variables the chat's own
 * highlighter uses (see ROLE_COLOR_VAR in chat/highlight.ts), so a file opened
 * in this editor is colored like the same file quoted in the conversation and
 * like the terminal behind it. Three highlighters that disagree about what a
 * string looks like is worse than any one of their palettes.
 */
function defineThemes(): void {
  const rules = (): monaco.editor.ITokenThemeRule[] => [
    { token: '', foreground: colour('--terminal-fg', '#d4d4d4') },
    { token: 'comment', foreground: colour('--ansi-bright-black', '#525252'), fontStyle: 'italic' },
    { token: 'keyword', foreground: colour('--ansi-magenta', '#c084fc') },
    { token: 'string', foreground: colour('--ansi-green', '#4ade80') },
    { token: 'number', foreground: colour('--ansi-yellow', '#facc15') },
    { token: 'regexp', foreground: colour('--ansi-green', '#4ade80') },
    { token: 'type', foreground: colour('--ansi-cyan', '#22d3ee') },
    { token: 'type.identifier', foreground: colour('--ansi-cyan', '#22d3ee') },
    { token: 'delimiter', foreground: colour('--terminal-dim', '#737373') },
    { token: 'operator', foreground: colour('--ansi-bright-magenta', '#d8b4fe') },
    { token: 'tag', foreground: colour('--ansi-magenta', '#c084fc') },
    { token: 'attribute.name', foreground: colour('--ansi-cyan', '#22d3ee') },
    { token: 'attribute.value', foreground: colour('--ansi-green', '#4ade80') },
    { token: 'variable', foreground: colour('--terminal-fg', '#d4d4d4') },
    { token: 'function', foreground: colour('--ansi-blue', '#60a5fa') },
    { token: 'metatag', foreground: colour('--ansi-bright-blue', '#93c5fd') },
    { token: 'key', foreground: colour('--ansi-cyan', '#22d3ee') },
  ];

  const chrome = (): monaco.editor.IColors => ({
    'editor.background': colour('--terminal-bg', '#0a0a0a'),
    'editor.foreground': colour('--terminal-fg', '#d4d4d4'),
    'editorCursor.foreground': colour('--terminal-cursor', '#fafafa'),
    'editorLineNumber.foreground': colour('--muted-foreground', '#737373'),
    'editorLineNumber.activeForeground': colour('--foreground', '#fafafa'),
    'editorGutter.background': colour('--terminal-bg', '#0a0a0a'),
    'editorIndentGuide.background1': colour('--border', '#262626'),
    'editorWhitespace.foreground': colour('--border', '#262626'),
    'editorWidget.background': colour('--popover', '#141414'),
    'editorWidget.border': colour('--border', '#262626'),
    'input.background': colour('--input', '#1f1f1f'),
    'input.foreground': colour('--foreground', '#fafafa'),
    'focusBorder': colour('--ring', '#d4d4d4'),
  });

  monaco.editor.defineTheme(DARK, { base: 'vs-dark', inherit: true, rules: rules(), colors: chrome() });
  monaco.editor.defineTheme(LIGHT, { base: 'vs', inherit: true, rules: rules(), colors: chrome() });
  themesDefined = true;
}

/**
 * A model for this file, reusing one Monaco already holds.
 *
 * `createModel` with a URI that is already registered throws, and models are
 * global to the page rather than owned by an editor — so opening the same file
 * a second time (close the dialog, click the same row again) would have thrown
 * instead of opening. Reusing it also keeps that file's undo history across a
 * close and reopen, which is the behaviour anyone would expect anyway.
 */
function modelFor(value: string, path?: string): monaco.editor.ITextModel {
  if (!path) return monaco.editor.createModel(value);

  // A path, not a URL: `Uri.file` escapes it, so a filename with a space or a
  // `#` in it cannot be read as a fragment and lose half the name.
  const uri = monaco.Uri.file(path);
  const existing = monaco.editor.getModel(uri);
  if (existing) {
    if (existing.getValue() !== value) existing.setValue(value);
    return existing;
  }
  return monaco.editor.createModel(value, undefined, uri);
}

export function create(container: HTMLElement, options: CreateOptions): MonacoHandle {
  configureWorker();
  disableLanguageServices();
  if (!themesDefined) defineThemes();

  const model = modelFor(options.value, options.path);

  const editor = monaco.editor.create(container, {
    model,
    theme: options.theme === 'light' ? LIGHT : DARK,
    readOnly: Boolean(options.readOnly),
    // The dialog resizes with the window and with its own content, and Monaco
    // does not otherwise notice; `automaticLayout` puts a ResizeObserver on the
    // container, which is the same thing the caller would have to do by hand.
    automaticLayout: true,
    fontFamily: readVar('--font-mono') || 'monospace',
    fontSize: 12,
    lineHeight: 1.5,
    minimap: { enabled: true, renderCharacters: false },
    scrollBeyondLastLine: false,
    renderWhitespace: 'selection',
    tabSize: 2,
    insertSpaces: true,
    // Off, and deliberately: this editor has no project context — no
    // resolution, no type information, nothing but the open buffer — so any
    // suggestion it made would be a guess drawn from words already on screen.
    quickSuggestions: false,
    wordBasedSuggestions: 'off',
    parameterHints: { enabled: false },
    suggestOnTriggerCharacters: false,
    ariaLabel: options.ariaLabel,
    // The whole point of a modal editor is the file; a horizontal scrollbar is
    // a better answer than reflowing someone's source.
    wordWrap: 'off',
    scrollbar: { alwaysConsumeMouseWheel: false },
    // Monaco silently drops syntax colouring on a file it considers large, and
    // "large" is much smaller than it sounds — the point of this editor is
    // reading code, and uncoloured code is the thing it was opened to avoid.
    // The optimisation exists to protect an editor that also runs folding,
    // linting and language services on the same buffer; this one has all of
    // those switched off already, so tokenising is nearly all it does.
    largeFileOptimizations: false,
    // Long lines are tokenised too. The default stops at 20,000 characters,
    // which is a minified bundle or a data URI — exactly the lines someone
    // opens a file to look at, left as an unbroken grey wall.
    maxTokenizationLineLength: 200_000,
  });

  let disposed = false;
  const subscriptions = [
    editor.onDidChangeModelContent(() => {
      if (!disposed) options.onChange?.(editor.getValue());
    }),
  ];

  // Monaco swallows Ctrl/Cmd+S itself, so the browser's "save page" never
  // appears — but nothing is listening either until this is added.
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => options.onSave?.());

  return {
    getValue: () => editor.getValue(),
    setValue: (next) => {
      // Guarded: `setValue` resets the cursor, the selection and the scroll
      // position, and the caller echoes every keystroke back through props.
      if (editor.getValue() !== next) editor.setValue(next);
    },
    setReadOnly: (readOnly) => editor.updateOptions({ readOnly }),
    setTheme: (theme) => {
      // Redefined first: the palette has already changed by the time this is
      // called, and the theme's colours are read from it.
      defineThemes();
      monaco.editor.setTheme(theme === 'light' ? LIGHT : DARK);
    },
    layout: () => editor.layout(),
    focus: () => editor.focus(),
    dispose: () => {
      disposed = true;
      for (const subscription of subscriptions) subscription.dispose();
      // The editor only, never the model: the model is keyed by file path and
      // is deliberately kept so reopening the file keeps its undo history.
      // Disposing it here would also break a second editor on the same file.
      editor.dispose();
    },
  };
}
