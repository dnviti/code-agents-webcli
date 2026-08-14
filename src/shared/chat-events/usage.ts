import type { CodexCostEstimate } from '../codex-pricing.js';
/**
 * Token and cost accounting for a message, turn or session.
 *
 * Every field is optional because runtimes report wildly different subsets —
 * some give cost, some only totals, some nothing at all. The UI shows what it
 * has and stays silent about the rest rather than rendering confident zeroes.
 */
export interface ChatUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  /**
   * Whether anybody has reported tokens for this conversation at all.
   *
   * The same spoken-absence trick `contextWindowSource: 'unknown'` plays below,
   * and it exists for the same reason: an omitted field means "no news" all
   * through this merge, so a runtime that will never report anything and a
   * conversation whose first turn has not finished yet are otherwise the same
   * empty object. The UI has to stay silent about the second, and kimi — which
   * sends no `usage_update`, no usage on its prompt reply, and no `_meta`
   * anywhere — is the whole of the first.
   *
   * `none` is a measurement, not a guess: the session states it only after a
   * turn has actually completed with the runtime having done work in it. `agent`
   * is set by any report that carries a figure, which is what stops an earlier
   * `none` from standing over money that has since arrived. Absent still means
   * nobody has said, which is every conversation for its first few seconds.
   *
   * Deliberately *not* derived from `capabilities.usage === false`: that is also
   * the state of every transcript before its handshake lands, so a label driven
   * off it would print "not reported" on every chat against every agent.
   */
  usageSource?: SpendSource;
  /** The same, for money. Codex reports tokens and prices nothing. */
  costSource?: SpendSource;
  /**
   * The full provenance of a codex cost estimate, present only when this app
   * computed the cost figure (issue #182): effective model, applied rate,
   * source and pricing date. Absent for a figure a runtime reported directly.
   */
  costEstimate?: CodexCostEstimate;
  /** Context window size, when known, so the UI can show how full it is. */
  contextWindow?: number;
  /** Context currently occupied, when the runtime reports it directly. */
  contextUsed?: number;
  /**
   * Who said the window is that big.
   *
   * `agent` — the runtime reported it about the model it is running.
   * `provider` — the agent said nothing, so the model's provider was asked.
   * `unknown` — nobody could, and the reading has no ceiling in it.
   *
   * The first two are kept because they are not equally authoritative and the
   * difference is measurable: grok reports 512,000 tokens for `grok-build`,
   * while the nearest entry in a provider catalogue says 256,000. Half. An
   * agent's own figure always wins, and this field is what lets a reader see
   * which one they got.
   *
   * The third exists because a ceiling sometimes has to come *down*. Switch to
   * a model neither the agent nor the catalogue can size and the previous
   * model's figure would otherwise stand there being read as this one's — the
   * bar, the percentage, the "N left" warning, all describing a conversation
   * the user has left. Leaving `contextWindow` out cannot say that: every merge
   * here reads an absent number as "this report is silent about it", which is
   * exactly what keeps a streaming patch from blanking the figures beside it.
   * So the retraction is spoken, and `mergeUsage` is the one place that acts on
   * it.
   *
   * Absent alongside a `contextWindow` should not happen; absent alongside no
   * `contextWindow` is the ordinary "nobody has said yet" case, which the UI
   * states in words rather than drawing a bar against a guess.
   */
  contextWindowSource?: ContextWindowSource;
  /**
   * Which model the window above is about.
   *
   * An agent states its ceiling for the model it is running, and that statement
   * reaches the session *before* the first message that names the model — a
   * switch is confirmed on its own channel and the naming message belongs to
   * the next turn. Unattributed, the session reads the new model's figure as
   * the old one's, then asks a catalogue about an id no catalogue has heard of
   * and takes the agent's own answer down as unknown.
   *
   * Absent means nobody said, which is the ordinary case: a runtime whose model
   * cannot change mid-conversation has nothing to disambiguate.
   */
  contextWindowModel?: string;
}

/**
 * What one model did during a turn, as the runtime itself reported it.
 *
 * The distinction this exists to keep is between the model that was *asked
 * for* and the model that *ran*. A requested model is a fact about this app; a
 * reported one is a fact about the work, and only the second belongs in a spend
 * record. Nothing here is ever filled in from `options.model`.
 *
 * A list rather than a field because a turn can legitimately involve more than
 * one: a subagent runs on a different model, a runtime falls back after a
 * failure. Claude and grok both report exactly this, keyed by model, and
 * folding it back into one name would be the misattribution the whole record
 * exists to avoid.
 *
 * `calls` is the runtime's own count of round trips to that model — grok's
 * `modelCalls`. It is the only per-model measure of effort any of them give;
 * tool calls are never attributed to a model by anybody, so they are not
 * attributed here either.
 */
export interface TurnModelUsage {
  model: string;
  calls?: number;
  usage?: ChatUsage;
}

export type ContextWindowSource = 'agent' | 'provider' | 'unknown';

/**
 * Who gave a spend figure, or that nobody will.
 *
 * `agent` is a figure the runtime reported. `estimated` is a figure this app
 * computed for codex from the reported tokens and a published list price
 * (issue #182) — real money-shaped but never a bill, and labelled as such
 * wherever it is shown. `none` means nobody priced the turn.
 *
 * There is no `provider` here on purpose: nothing outside the runtime can say
 * what a turn cost, and until codex this app bought no price list to guess
 * with.
 */
export type SpendSource = 'agent' | 'estimated' | 'none';

/**
 * One rate-limit window, exactly as the provider stated it.
 *
 * Every field but `kind` is optional because the providers are miserly and
 * inconsistent about this: four of the five recorded Claude `rate_limit_event`
 * lines carry a reset time and a status and no percentage at all, and the fifth
 * carries a percentage only because a threshold had been crossed. A window with
 * no `utilization` is the ordinary case, and the surface draws no bar for it —
 * a meter defaulting to 0% would be the same invented figure this replaced.
 */
export interface AccountLimitWindow {
  /** The provider's own name for it: `five_hour`, `seven_day`, `primary`. */
  kind: string;
  /** How long the window runs, when the provider says. Codex does; Claude does not. */
  durationMinutes?: number;
  /** 0..1 of the window spent. Absent means nobody said, not zero. */
  utilization?: number;
  /** When the window refills, as ISO. */
  resetsAt?: string;
  /** The provider's own word for the state: `allowed`, `allowed_warning`. */
  status?: string;
  /**
   * How fast the window is filling, in fraction per hour.
   *
   * Only ever from two readings of the *same* window — same kind, same reset
   * time — taken during this conversation. One reading is a level, not a rate,
   * and a "time left" drawn from a level is a guess dressed as a measurement.
   * Absent means fewer than two readings so far, which the surface says in
   * words rather than leaving blank.
   */
  utilizationPerHour?: number;
}

/**
 * What the provider said about the account behind this conversation.
 *
 * Only ever populated from something a runtime actually reported on its own
 * channel. Nothing here is inferred from a plan flag, a lookup table or a
 * transcript file, which is what this replaced (#137): every figure that used
 * to appear in the status panel was a build-time constant.
 *
 * `windows` is empty rather than absent when a runtime has spoken but has no
 * window to report — that is a different thing from never having spoken, and
 * the surface tells them apart.
 */
export interface AccountLimits {
  /** The plan as the provider named it. Codex reports `planType`; Claude does not. */
  planName?: string;
  /**
   * How this work is being billed, when the runtime said.
   *
   * `unknown` is load-bearing: half the recorded Claude handshakes carry no
   * `apiKeySource` at all, and reading that absence as "subscription" would be
   * a claim about someone's billing that nobody made.
   */
  billing?: 'subscription' | 'api-key' | 'unknown';
  windows: AccountLimitWindow[];
}

/**
 * The token fields that mean "this cost something", for the silence test.
 *
 * `contextUsed` is not one of them. It answers how full the window is, which
 * the context reading already states in its own words; a runtime that reports
 * occupancy and no spend has genuinely reported no spend.
 */
const SPEND_TOKEN_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
  'totalTokens',
] as const;

/** Whether a reading carries any token count at all. */
export function carriesTokens(usage: ChatUsage | undefined): boolean {
  return usage !== undefined && SPEND_TOKEN_FIELDS.some((field) => usage[field] !== undefined);
}

/** And whether it carries money. */
export function carriesCost(usage: ChatUsage | undefined): boolean {
  return usage?.costUsd !== undefined;
}

/** Sum two usage records, tolerating the many fields runtimes omit. */
export function mergeUsage(base: ChatUsage | undefined, next: ChatUsage | undefined): ChatUsage {
  const a = base || {};
  const b = next || {};
  const add = (x?: number, y?: number): number | undefined => {
    if (x === undefined && y === undefined) return undefined;
    return (x || 0) + (y || 0);
  };
  // The one report that takes a figure away instead of contributing one: the
  // conversation moved to a model nobody can size, and the ceiling that is up
  // belongs to the model it left. Said out loud precisely because `??` below
  // would otherwise keep the old number — an omitted field means "no news"
  // everywhere else here, and has to go on meaning that.
  const retracted = b.contextWindowSource === 'unknown';
  const merged: ChatUsage = {
    inputTokens: add(a.inputTokens, b.inputTokens),
    outputTokens: add(a.outputTokens, b.outputTokens),
    cacheReadTokens: add(a.cacheReadTokens, b.cacheReadTokens),
    cacheWriteTokens: add(a.cacheWriteTokens, b.cacheWriteTokens),
    reasoningTokens: add(a.reasoningTokens, b.reasoningTokens),
    totalTokens: add(a.totalTokens, b.totalTokens),
    costUsd: add(a.costUsd, b.costUsd),
    // Not additive: these describe the window, not consumption within it.
    contextWindow: retracted ? undefined : (b.contextWindow ?? a.contextWindow),
    contextUsed: b.contextUsed ?? a.contextUsed,
    // Travels with the window it describes rather than being picked
    // independently, or a later turn that only refreshed the occupancy would
    // leave an older window labelled with the newer one's provenance.
    contextWindowSource:
      retracted || b.contextWindow !== undefined ? b.contextWindowSource : a.contextWindowSource,
    contextWindowModel:
      retracted || b.contextWindow !== undefined ? b.contextWindowModel : a.contextWindowModel,
  };
  // Not additive either, and read off the sum rather than off `b`: a reading
  // that has figures in it answers the question by having them, so a `none`
  // stated on a turn that spent nothing cannot go on standing over money that
  // arrived afterwards. Otherwise the last thing anybody said carries, which is
  // how a spoken silence survives the turns that follow it.
  merged.usageSource = carriesTokens(merged) ? 'agent' : (b.usageSource ?? a.usageSource);
  // An estimate is genuinely reported money (shaped) and so survives the sum,
  // but its source label is the point of it and must not be flattened to the
  // generic 'agent' — an estimated figure that silently becomes an agent figure
  // is the exact honesty this field exists to protect.
  merged.costSource = carriesCost(merged)
    ? b.costEstimate !== undefined || a.costEstimate !== undefined
      ? 'estimated'
      : 'agent'
    : (b.costSource ?? a.costSource);
  // Not additive — it is the provenance of the latest estimate, like the
  // window fields above, and a later turn that only refreshed the figure keeps
  // the newer estimate's metadata.
  merged.costEstimate = b.costEstimate ?? a.costEstimate;
  return merged;
}

