/**
 * The token fields this adapter maps. Cost is not one: it is cumulative.
 *
 * Spelled out rather than `keyof ChatUsage`, which stopped being a list of
 * token counts the moment that type grew a context reading — one of whose
 * fields is a word (`contextWindowSource`), and none of which is a quantity
 * this adds up.
 */
export type TokenField = 'inputTokens' | 'outputTokens' | 'cacheWriteTokens' | 'cacheReadTokens';
