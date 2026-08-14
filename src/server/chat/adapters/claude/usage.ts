import type { ChatUsage } from '../../../../shared/chat-events.js';
import { num, record } from './util.js';

export function mapUsage(raw: Record<string, unknown>): ChatUsage {
  return {
    inputTokens: num(raw.input_tokens),
    outputTokens: num(raw.output_tokens),
    cacheWriteTokens: num(raw.cache_creation_input_tokens),
    cacheReadTokens: num(raw.cache_read_input_tokens),
  };
}

/**
 * How big claude says the window is, and how much of it the last request filled.
 *
 * The capacity comes from claude's own `modelUsage` block, keyed by the model
 * as it ran — `claude-opus-5[1m]` reports 1,000,000 while the plain model does
 * not, so the bracketed suffix is load-bearing and the key is used verbatim
 * rather than canonicalised.
 *
 * Occupancy is the *last* iteration's figures, not the turn's totals. A turn
 * with four round trips reports four iterations, and adding their inputs
 * together describes work done rather than anything that was ever in the
 * window at one time — the last one is what actually sat there.
 */
export function contextReading(raw: Record<string, unknown>): ChatUsage {
  const reading: ChatUsage = {};

  const modelUsage = record(raw.model_usage) ?? record(raw.modelUsage);
  if (modelUsage) {
    for (const [model, value] of Object.entries(modelUsage)) {
      const window = num(record(value)?.contextWindow);
      if (window !== undefined && window > 0) {
        reading.contextWindow = window;
        reading.contextWindowSource = 'agent';
        // The key, verbatim, for the same reason the capacity above is read off
        // it: `claude-opus-5[1m]` is a different window from `claude-opus-5`,
        // and a ceiling that does not say which model it is about is one the
        // session cannot tell from the previous model's on the next switch.
        reading.contextWindowModel = model;
        break;
      }
    }
  }

  const usage = record(raw.usage);
  const iterations = Array.isArray(usage?.iterations) ? usage.iterations : [];
  const last = record(iterations[iterations.length - 1]) ?? usage;
  if (last) {
    const parts = [
      num(last.input_tokens),
      num(last.cache_read_input_tokens),
      num(last.cache_creation_input_tokens),
      num(last.output_tokens),
    ].filter((n): n is number => n !== undefined);
    if (parts.length > 0) {
      reading.contextUsed = parts.reduce((sum, n) => sum + n, 0);
    }
  }

  return reading;
}
