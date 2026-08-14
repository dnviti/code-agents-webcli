import type { TokenField } from './types.js';

/**
 * The `apiKeySource` values that mean a key the *user* put there.
 *
 * These two, and only these two, are a statement that the work is billed to an
 * API key: an environment variable the user exported, and a helper command the
 * user configured. Every other source the CLI can name is something else, and
 * is reported as `unknown` rather than folded in here — see `handleInit`.
 */
export const CONFIGURED_KEY_SOURCES: Record<string, true> = {
  ANTHROPIC_API_KEY: true,
  apiKeyHelper: true,
};

/**
 * How long a `/effort` turn may go unanswered before it is given up on.
 *
 * Generous by an order of magnitude, on purpose. The CLI answers this one in
 * milliseconds because no model is involved — `total_cost_usd: 0`,
 * `num_turns: 0`, handled locally — so anything approaching eight seconds is not
 * a slow answer but a CLI that never understood the question, and every one of
 * those seconds is spent with this adapter deaf to its own runtime (see the
 * suppression `setEffort` describes). Long enough that a machine under load
 * never trips it; short enough that a session which does is usable again well
 * before anybody reaches for the reload button.
 */
export const EFFORT_TIMEOUT_MS = 8000;

/**
 * How much of a runtime's reason a line in the conversation may carry.
 */
export const REASON_LIMIT = 300;

/**
 * The token fields this adapter maps. Cost is not one: it is cumulative.
 */
export const TOKEN_FIELDS: TokenField[] = [
  'inputTokens',
  'outputTokens',
  'cacheWriteTokens',
  'cacheReadTokens',
];
