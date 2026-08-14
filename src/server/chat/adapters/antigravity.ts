/**
 * Antigravity CLI (`agy`) driven headlessly: `--print --output-format stream-json`.
 *
 * Everything below was read off live captures against agy 1.1.8 on 2026-07-30,
 * not from a schema. The wire is line-delimited JSON with a three-value
 * envelope — `{"event":"init"|"step_update"|"result", <same name>: {…}}` — and a
 * turn looks like this end to end:
 *
 *   {"event":"init","conversation_id":"…","init":{"model":"…","cwd":"…",
 *     "tools":[…],"permission_mode":"request-review"}}
 *   {"event":"step_update","step_update":{"step_index":0,"state":"DONE","step_type":"user_input"}}
 *   {"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"agent_response",
 *     "usage":{"input_tokens":17533,"output_tokens":493,"thinking_tokens":435,
 *              "cache_read_tokens":0,"total_tokens":18026}}}
 *   {"event":"step_update","step_update":{"step_index":4,"state":"ACTIVE","step_type":"tool",
 *     "tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"cat notes.txt"}}}}
 *   {"event":"step_update","step_update":{"step_index":4,"state":"DONE","step_type":"tool",
 *     "duration_seconds":0.013,"tool_info":{…,"output":"line one\r\n…"}}}
 *   {"event":"result","result":{"conversation_id":"…","status":"SUCCESS","response":"…",
 *     "duration_seconds":11.4,"num_turns":1,"usage":{…}}}
 *
 * Four properties of that stream shape this adapter, and each is a measurement:
 *
 * 1. **One process per turn.** `--print` runs a single prompt and exits; there is
 *    no stdin channel to write a second turn into (stdin is closed, and unlike
 *    codex and pi agy does not block on an open one — but nothing reads it
 *    either). Multi-turn is `--conversation <id>`, which resumes agy's own
 *    stored conversation: a second invocation answered "what was the pwd output
 *    I asked about in my previous message?" correctly and carried on numbering
 *    its steps from where the first left off. So `start()` launches nothing and
 *    every `send()` spawns its own child — the same shape as the pi adapter.
 *
 * 2. **`text_delta` is a genuine delta.** An `agent_response` step arrives
 *    `ACTIVE` with the opening of the reply and `DONE` with the rest, and
 *    concatenating them reproduces `result.response` exactly. It is appended,
 *    never used as a replacement.
 *
 * 3. **Reasoning is counted, never shown.** Every `usage` carries
 *    `thinking_tokens` — 435, 359, 317 across one turn of gemini-3.1-pro-low —
 *    and no event anywhere carries a word of it. That is the case
 *    `ThinkingBlock.tokens` exists for, so the entry says how much was thought
 *    rather than opening onto an empty panel.
 *
 * 4. **It cannot stop and ask.** Headless, anything needing the `command`
 *    permission is refused on the spot and the run continues around it:
 *    `tool_info.error` reads `User denied permission to run command:\npwd` while
 *    stderr explains that "headless mode cannot prompt for" it. There is no
 *    approval channel to wire, so `capabilities.permissions` is false and each
 *    refusal is explained in the transcript instead — see `refusalText`.
 *
 * ## Layout
 *
 * The original single file outgrew one module and now lives as a thin facade
 * over a chain of partial classes plus leaf helper modules:
 *
 * - `antigravity/constants.ts` — the CLI's fixed vocabulary (timeouts, effort
 *   words, tool-kind overrides, path parameters).
 * - `antigravity/helpers.ts` — pure decoding helpers shared by the whole chain,
 *   including the exported `withAttachments`.
 * - `antigravity/usage.ts` — `result.usage` -> `ChatUsage`.
 * - `antigravity/session.ts` — `AntigravityBase`: state and the model/effort
 *   picker.
 * - `antigravity/turn.ts` — `AntigravityTurn`: the spawn-per-turn lifecycle.
 * - `antigravity/wire.ts` — `AntigravityWire`: reading and dispatching the wire.
 * - `antigravity/adapter.ts` — the concrete `AntigravityChatAdapter`.
 */
export { AntigravityChatAdapter } from './antigravity/adapter.js';
export { withAttachments } from './antigravity/helpers.js';
export { default } from './antigravity/adapter.js';
