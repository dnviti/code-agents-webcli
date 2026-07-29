import { TurnModelUsage } from '../../../shared/chat-events.js';

/**
 * Read a `modelUsage` map — which models actually ran, and what each cost.
 *
 * Two runtimes report this and both report it identically, which is why it
 * lives here rather than twice: claude puts it on the final `result` line and
 * grok on `end`, in each case keyed by model name with camelCase token fields.
 * Verified against live output from both binaries, not from documentation:
 *
 *   grok    {"grok-build": {"inputTokens":11814,"outputTokens":119,
 *                           "cacheReadInputTokens":4096,"modelCalls":1,
 *                           "costUSD":0.0128712}}
 *   claude  {"claude-opus-5[1m]": {"inputTokens":2,"outputTokens":4,
 *                                  "cacheReadInputTokens":15498,
 *                                  "cacheCreationInputTokens":14716,
 *                                  "costUSD":0.155019,
 *                                  "canonicalModel":"claude-opus-5", ...}}
 *
 * This is the only channel either of them has for the multi-model case: a
 * subagent on a different model, or a fallback after a failure, appears as a
 * second key here and nowhere else at all.
 *
 * `canonicalModel` wins where claude supplies it. The key it sits under is a
 * billing alias — `claude-opus-5[1m]` is the same model with a context-window
 * suffix — and the canonical name is what claude's own assistant messages
 * carry. Taking the key would file the spend under a name the conversation
 * never showed, which is precisely the disagreement between the two views this
 * is meant to end.
 *
 * Nothing is invented. A key with an unreadable value still counts as a model
 * that ran, because the runtime named it; it simply carries no figures.
 */
export function mapModelUsage(data: Record<string, unknown>): TurnModelUsage[] | undefined {
  const raw = data.modelUsage;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;

  const models: TurnModelUsage[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key) continue;
    const fields = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
    const num = (field: unknown): number | undefined => (typeof field === 'number' ? field : undefined);
    const canonical = typeof fields.canonicalModel === 'string' ? fields.canonicalModel.trim() : '';

    const entry: TurnModelUsage = { model: canonical || key };
    const calls = num(fields.modelCalls);
    if (calls !== undefined) entry.calls = calls;

    const usage = {
      inputTokens: num(fields.inputTokens),
      outputTokens: num(fields.outputTokens),
      cacheReadTokens: num(fields.cacheReadInputTokens),
      cacheWriteTokens: num(fields.cacheCreationInputTokens),
      costUsd: num(fields.costUSD),
    };
    // Only when something was actually measured. An empty usage object would
    // read downstream as "reported, and all zero" — the null-versus-zero rule
    // the whole spend record is built on.
    if (Object.values(usage).some((figure) => figure !== undefined)) entry.usage = usage;

    models.push(entry);
  }

  // An empty map is a runtime saying nothing, which must stay distinct from a
  // runtime saying "one model, no figures".
  return models.length > 0 ? models : undefined;
}
