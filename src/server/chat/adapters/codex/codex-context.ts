import type { ChatUsage } from '../../../../shared/chat-events.js';
import { num, record } from './codex-utils.js';

/**
 * How big codex says the window is, and how much of it the last request filled.
 *
 * Occupancy comes from `last` rather than `total` where codex offers both:
 * `total` is everything the turn spent across its round trips, which is a
 * larger number than anything that was ever in the window at one time and
 * would have the bar filling several times faster than the truth.
 */
export function contextReading(
  usage: Record<string, unknown>,
  total: Record<string, unknown>,
  model: string | undefined,
): ChatUsage {
  const window = num(usage.modelContextWindow);
  const last = record(usage.last) ?? total;
  const used = num(last.totalTokens);
  return {
    ...(window !== undefined
      ? {
          contextWindow: window,
          contextWindowSource: 'agent' as const,
          // `thread/tokenUsage/updated` says how big the window is and never
          // which model it belongs to, so the name comes from the thread this
          // adapter is holding. Unnamed, a mid-session model change makes the
          // session read codex's own ceiling as the previous model's.
          contextWindowModel: model,
        }
      : {}),
    ...(used !== undefined ? { contextUsed: used } : {}),
  };
}

