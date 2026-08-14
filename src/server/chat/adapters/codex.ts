/**
 * Codex adapter entry point.
 *
 * Originally a single 2,429-line file; this is now a thin re-export facade
 * over cohesive sibling modules in this directory. The public surface is
 * unchanged — the three adapter classes and the default `CodexChatAdapter`.
 *
 * The concrete app-server adapter lives in `codex-app-server.ts` on top of the
 * abstract notification/streaming partial in `codex-app-server-base.ts`; the
 * exec fallback and the router are `codex-exec.ts` and `codex-chat.ts`. The
 * pure helper functions split into leaf modules: `codex-utils`, `codex-diff`,
 * `codex-mapping`, `codex-subagent`, `codex-context`, `codex-launch`.
 */
export { CodexAppServerAdapter } from './codex/codex-app-server.js';
export { CodexExecAdapter } from './codex/codex-exec.js';
export { CodexChatAdapter } from './codex/codex-chat.js';
export { default } from './codex/codex-chat.js';


