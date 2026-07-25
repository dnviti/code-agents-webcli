/**
 * The Monaco stylesheets, as the bundler sees them.
 *
 * `monaco-codicons/*` is not a package — it is an alias defined in
 * scripts/build.js pointing into monaco-editor, because that package's
 * `exports` map rewrites every subpath to `./esm/vs/*.js` and so cannot serve a
 * stylesheet by name. esbuild resolves the alias and emits the CSS beside the
 * chunk; TypeScript has no idea about any of that and needs to be told the
 * imports exist.
 *
 * Declared as side-effect imports only. Nothing reads a value from a
 * stylesheet, and giving these a type would invite someone to try.
 */

declare module 'monaco-codicons/codicon.css';
declare module 'monaco-codicons/codicon-modifiers.css';

/**
 * Monaco's contribution entry point, typed as its API.
 *
 * `editor.main.js` is the build that carries the editor contributions — find,
 * folding, the context menu, the core editing commands — and it ships no `.d.ts`
 * of its own; only `editor.api` does. It re-exports that API verbatim (see the
 * `export { … } from './editor.api.js'` at the end of the file), so this says
 * so rather than leaving the whole editor typed as `any`.
 */
declare module 'monaco-editor/editor/editor.main' {
  export * from 'monaco-editor/editor/editor.api';
}
