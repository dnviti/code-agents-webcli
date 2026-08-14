import type { ChatUsage } from '../../../../shared/chat-events.js';
import { num } from './helpers.js';

/**
 * `result.usage` -> ChatUsage.
 *
 * Per turn, not per conversation: the figures are the sum of that invocation's
 * own steps and nothing earlier. Checked line by line against a captured turn —
 * 9888 + 123 + 2075 + 2212 + 2407 input tokens across five steps, and
 * `result.usage.input_tokens` of exactly 16705 — and again across a resumed
 * conversation, whose second invocation reported only what its own steps spent.
 * That is what makes it safe to attach to `turn_end`, where usage merges
 * additively.
 *
 * `thinking_tokens` maps to `reasoningTokens` and is deliberately not added to
 * the total: agy's own `total_tokens` is `input + output`, and its
 * `output_tokens` already contains the thinking (1438 output against 1111
 * thinking on the same turn), so counting it again would inflate every figure
 * downstream.
 */
export function translateUsage(usage: Record<string, unknown>): ChatUsage | undefined {
  const input = num(usage.input_tokens);
  const output = num(usage.output_tokens);
  const cacheRead = num(usage.cache_read_tokens);
  const reasoning = num(usage.thinking_tokens);
  const total = num(usage.total_tokens);
  if (
    input === undefined
    && output === undefined
    && cacheRead === undefined
    && reasoning === undefined
    && total === undefined
  ) {
    return undefined;
  }
  return {
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
    ...(total !== undefined ? { totalTokens: total } : {}),
  };
}
