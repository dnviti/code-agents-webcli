/**
 * Claude adapter entry point.
 *
 * Originally a single 1,746-line file; this is now a thin re-export facade
 * over cohesive sibling modules in this directory. The public surface is
 * unchanged — the `ClaudeChatAdapter` class and its default export.
 *
 * The implementation lives in a linear inheritance chain of abstract partials —
 * `adapter-base` (fields plus launch/session/capabilities), `adapter-effort`
 * (`/effort` control turns), `adapter-accounting` (cost and usage), and
 * `adapter-messages` (wire-protocol decoding) — ending in the tiny concrete
 * `ClaudeChatAdapter` in `adapter.ts`. Pure helpers split into leaf modules:
 * `types`, `constants`, `util`, `usage`.
 */
export { ClaudeChatAdapter } from './claude/adapter.js';
export { default } from './claude/adapter.js';
