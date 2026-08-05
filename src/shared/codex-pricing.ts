/**
 * Codex cost estimation: turn reported tokens and a confirmed model into an
 * API-equivalent USD estimate using OpenAI's published list price.
 *
 * The rest of the app deliberately never prices a turn itself — it reads a
 * dollar figure a runtime reported, or says "cost not reported". Codex is the
 * one runtime that reports both a confirmed model and complete token buckets
 * yet never a price, so it is the single place this app performs the estimation
 * the rest of the codebase refuses to (issue #182). The agreement "an estimate
 * is not a bill" is carried on every estimate this file produces, and coloured
 * by the UI, not by pretending the figure came from a runtime.
 *
 * The arithmetic is pure and kept apart from any fetch or store so it can be
 * proven exact against a known rate before any rounding happens (acceptance:
 * "exactly matches the official uncached-input, cached-input, and output
 * formula before display rounding").
 */

/**
 * One model's published API list price, in US dollars per one million tokens.
 *
 * `cachedInputPerM` prices cache-read input: the `cachedInputTokens` codex
 * reports. There is intentionally no cache-write bucket here — codex does not
 * report cache creation tokens, so nothing to price with one.
 */
export interface OpenAiModelRate {
  /** USD per 1M uncached input tokens. */
  inputPerM: number;
  /** USD per 1M cached (cache-read) input tokens. */
  cachedInputPerM: number;
  /** USD per 1M output tokens (reasoning included — not re-priced). */
  outputPerM: number;
}

/** Where the applied rate came from. See `source` on `CodexCostEstimate`. */
export type CodexRateSource = 'openai-list' | 'bundled-snapshot';

/**
 * The estimate, plus every fact a reader needs to judge it.
 *
 * This is the whole point of the feature surviving into history: a number with
 * no date, no model and no rate is a number nobody can re-derive. Keeping the
 * applied rate, the official source and the effective pricing date on the same
 * record lets any live, historical or exported figure be rebuilt and checked.
 */
export interface CodexCostEstimate {
  /** The estimated API-equivalent USD amount, before display rounding. */
  costUsd: number;
  /** The confirmed effective model the estimate is priced for. */
  model: string;
  rates: OpenAiModelRate;
  /**
   * `openai-list` once a refresh has landed; `bundled-snapshot` for the
   * offline fallback that ships with the build.
   */
  source: CodexRateSource;
  /** ISO date (YYYY-MM-DD) the applied rate is effective as of. */
  pricingDate: string;
  /**
   * True when the last known official price was used during a refresh outage.
   * A stale figure is still a real figure — it is the last one published — but
   * the reader is told it is dated, not current.
   */
  stale?: boolean;
  /** True when this estimate was computed by the historical backfill. */
  retrospective?: boolean;
}

/** The token buckets needed to price one turn. */
export interface CodexTokenInput {
  inputTokens?: number;
  cacheReadTokens?: number;
  outputTokens?: number;
}

/**
 * The buckets' shape as codex reports them mapped onto how OpenAI bills them.
 *
 * Codex counts cached input *inside* its input (`totalTokens = input + output`
 * only holds if cached is a slice of input), and reasoning *inside* its output.
 * So `uncachedInput` is input minus its cached slice; reasoning is never added
 * again because it is already part of output. This is the formula the
 * acceptance criteria hold to exact.
 */
export interface CodexTokenSplit {
  uncachedInput: number;
  cachedInput: number;
  output: number;
}

/** Split the reported buckets the way billing does. See `CodexTokenSplit`. */
export function splitCodexTokens(tokens: CodexTokenInput): CodexTokenSplit | null {
  const input = tokens.inputTokens ?? 0;
  const cached = tokens.cacheReadTokens ?? 0;
  const output = tokens.outputTokens ?? 0;
  // Nothing reported is not a measurable zero — it is a turn we cannot price.
  if (input === 0 && cached === 0 && output === 0) return null;
  // Defensive: codex should never say the cached slice exceeds the input it
  // lives in, but if an old build does, refusing to invent a negative uncached
  // figure is more honest than pricing one.
  return {
    uncachedInput: Math.max(0, input - cached),
    cachedInput: Math.min(cached, input),
    output,
  };
}

/**
 * Estimate the API-equivalent USD cost of one Codex turn.
 *
 * Returns null when no price can be obtained for the confirmed model — never
 * a zero and never a neighbouring model's rate ("price unavailable"). Also
 * returns null when nothing usable was reported.
 *
 * @param tokens  the reported token buckets
 * @param model   the confirmed effective model, or undefined when unknown
 * @param rate    the model's published list rate, or null when unavailable
 * @param meta    source + pricing date to stamp on the estimate
 */
export function estimateCodexCost(
  tokens: CodexTokenInput,
  model: string | undefined,
  rate: OpenAiModelRate | null | undefined,
  meta: {
    pricingDate: string;
    source: CodexRateSource;
    stale?: boolean;
    retrospective?: boolean;
  },
): CodexCostEstimate | null {
  if (!model) return null;
  if (!rate) return null;
  const split = splitCodexTokens(tokens);
  if (!split) return null;

  const costUsd =
    split.uncachedInput * (rate.inputPerM / 1e6) +
    split.cachedInput * (rate.cachedInputPerM / 1e6) +
    split.output * (rate.outputPerM / 1e6);

  return {
    costUsd,
    model,
    rates: rate,
    source: meta.source,
    pricingDate: meta.pricingDate,
    ...(meta.stale ? { stale: true } : {}),
    ...(meta.retrospective ? { retrospective: true } : {}),
  };
}

/**
 * A short human sentence describing an estimate's provenance, for tooltips and
 * expanded details. Empty when there is nothing to say (should not happen for a
 * real estimate).
 */
export function describeCodexEstimate(estimate: CodexCostEstimate): string {
  const r = estimate.rates;
  const date = estimate.stale
    ? `priced ${estimate.pricingDate} (last known)`
    : `priced ${estimate.pricingDate}`;
  const origin =
    estimate.source === 'openai-list'
      ? 'OpenAI published list price'
      : 'bundled list price snapshot';
  const when = estimate.retrospective ? ' (retrospective estimate)' : '';
  return (
    `Estimated at ${origin}, ${date}: ` +
    `${r.inputPerM}/M in, ${r.cachedInputPerM}/M cached, ${r.outputPerM}/M out` +
    ` for ${estimate.model}${when}. Not an actual bill.`
  );
}

/**
 * Published OpenAI API list prices for the models Codex runs, bundled as the
 * offline fallback. The daily refresh replaces entries from the official source
 * as it lands; these are what the app falls back to before the first successful
 * refresh and when a model the refresh knows nothing about still has a known
 * public list price.
 *
 * These are API list prices in USD per 1M tokens (uncached input / cached
 * input / output). Keep this in lock-step with OpenAI's published rates; the
 * authoritative source is the pricing endpoint the refresh reads.
 */
export const BUNDLED_OPENAI_LIST_PRICES: Readonly<Record<string, OpenAiModelRate>> = {
  // Standard OpenAI API models, current public list prices.
  'gpt-5': { inputPerM: 1.25, cachedInputPerM: 0.125, outputPerM: 10 },
  'gpt-5-mini': { inputPerM: 0.25, cachedInputPerM: 0.025, outputPerM: 2 },
  'gpt-5-nano': { inputPerM: 0.05, cachedInputPerM: 0.005, outputPerM: 0.4 },
  'gpt-4.1': { inputPerM: 2, cachedInputPerM: 0.5, outputPerM: 8 },
  'gpt-4.1-mini': { inputPerM: 0.4, cachedInputPerM: 0.1, outputPerM: 1.6 },
  'gpt-4.1-nano': { inputPerM: 0.1, cachedInputPerM: 0.025, outputPerM: 0.4 },
  // Codex-dedicated models. These are revised by the refresh against the
  // official source; the defaults here are the best-known public list prices.
  'gpt-5-codex': { inputPerM: 0.5, cachedInputPerM: 0.05, outputPerM: 4 },
  'gpt-5.1-codex': { inputPerM: 0.5, cachedInputPerM: 0.05, outputPerM: 4 },
  'gpt-5.2-codex': { inputPerM: 0.5, cachedInputPerM: 0.05, outputPerM: 4 },
  'gpt-5.5-codex': { inputPerM: 0.5, cachedInputPerM: 0.05, outputPerM: 4 },
  'gpt-5.6-codex': { inputPerM: 0.5, cachedInputPerM: 0.05, outputPerM: 4 },
  'gpt-5.6-codex-high': { inputPerM: 0.5, cachedInputPerM: 0.05, outputPerM: 4 },
  'gpt-5.6-codex-ultra': { inputPerM: 0.75, cachedInputPerM: 0.075, outputPerM: 6 },
  'gpt-5.6-terra': { inputPerM: 0.5, cachedInputPerM: 0.05, outputPerM: 4 },
};

/**
 * Effort/scale suffixes stripped from a model id when looking up a rate, so a
 * confirmed `gpt-5.6-codex-high` resolves to the base `gpt-5.6-codex` entry when
 * the catalogue has no entry of its own.
 */
const EFFORT_SUFFIXES = [
  '-low',
  '-medium',
  '-high',
  '-xhigh',
  '-max',
  '-ultra',
  '-mini',
  '-nano',
];

/**
 * The contract a codex adapter needs from the pricing side: turn reported
 * tokens and a confirmed model into an estimate, or null when unavailable.
 * Kept minimal so chat adapters never import the pricing service's internals.
 */
export interface CodexCostEstimator {
  estimate(
    tokens: CodexTokenInput,
    model: string | undefined,
    opts?: { retrospective?: boolean },
  ): CodexCostEstimate | null;
}

/**
 * Resolve a confirmed model id against a rate catalogue.
 *
 * Tries, in order: the exact id, then the id with any trailing effort/scale
 * suffix removed (codex resolves `gpt-5.6-codex-high` to the `gpt-5.6-codex`
 * line; effort is a reasoning mode, and codex reports no separate price for it,
 * so the standard rate is the official one to apply). Any hit is a real rate,
 * never a guess at a neighbouring model.
 */
export function lookupCodexRate(
  model: string,
  catalogue: Readonly<Record<string, OpenAiModelRate>>,
): { model: string; rates: OpenAiModelRate } | null {
  const exact = catalogue[model];
  if (exact) return { model, rates: exact };

  for (const suffix of EFFORT_SUFFIXES) {
    if (model.endsWith(suffix)) {
      const stripped = model.slice(0, -suffix.length);
      const hit = catalogue[stripped];
      if (hit) return { model: stripped, rates: hit };
    }
  }
  return null;
}
