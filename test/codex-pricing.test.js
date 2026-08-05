/**
 * The codex cost-estimate arithmetic is the load-bearing claim of issue #182:
 * "a Codex turn with a known effective model and known token buckets produces
 * an API-equivalent USD estimate that exactly matches the official
 * uncached-input, cached-input, and output formula before display rounding."
 *
 * These tests pin that formula to exact numbers (no tolerance) and cover the
 * pure-function contract that the live, durable and backfill paths all share.
 */

const assert = require('assert');

const {
  estimateCodexCost,
  splitCodexTokens,
  lookupCodexRate,
  describeCodexEstimate,
  BUNDLED_OPENAI_LIST_PRICES,
} = require('../dist/shared/codex-pricing.js');

// A synthetic rate with round numbers so the arithmetic is easy to check by
// hand: $2/M uncached input, $0.5/M cached input, $6/M output.
const RATE = { inputPerM: 2, cachedInputPerM: 0.5, outputPerM: 6 };
const META = { pricingDate: '2026-08-05', source: 'openai-list' };

describe('splitCodexTokens', function () {
  it('treats cached input as a slice of input, not an addition to it', function () {
    // codex reports input that already includes its cached slice; pricing must
    // not double-count the cached portion.
    const split = splitCodexTokens({ inputTokens: 10_000, cacheReadTokens: 4_000, outputTokens: 2_000 });
    assert.deepStrictEqual(split, { uncachedInput: 6_000, cachedInput: 4_000, output: 2_000 });
  });

  it('returns null when nothing usable was reported', function () {
    assert.strictEqual(splitCodexTokens({}), null);
    assert.strictEqual(splitCodexTokens({ inputTokens: 0, outputTokens: 0 }), null);
  });

  it('defends against a cached slice larger than its input', function () {
    const split = splitCodexTokens({ inputTokens: 1_000, cacheReadTokens: 5_000, outputTokens: 10 });
    assert.strictEqual(split.uncachedInput, 0);
    assert.strictEqual(split.cachedInput, 1_000);
  });
});

describe('estimateCodexCost', function () {
  it('produces the exact official formula before rounding', function () {
    // 6,000 uncached in @$2/M = $0.012; 4,000 cached @$0.5/M = $0.002;
    // 2,000 out @$6/M = $0.012  ->  total $0.026
    const estimate = estimateCodexCost(
      { inputTokens: 10_000, cacheReadTokens: 4_000, outputTokens: 2_000 },
      'gpt-5-codex',
      RATE,
      META,
    );
    assert.ok(estimate);
    // Exact to floating-point precision — the formula, not an approximation.
    assert.ok(Math.abs(estimate.costUsd - 0.026) < 1e-12);
    assert.strictEqual(estimate.model, 'gpt-5-codex');
    assert.strictEqual(estimate.source, 'openai-list');
    assert.strictEqual(estimate.pricingDate, '2026-08-05');
  });

  it('prices no-cache input entirely as uncached', function () {
    const estimate = estimateCodexCost(
      { inputTokens: 1_000_000, outputTokens: 500_000 },
      'gpt-5-codex',
      RATE,
      META,
    );
    // 1M @$2/M = $2; 500k @$6/M = $3  ->  $5
    assert.strictEqual(estimate.costUsd, 5);
  });

  it('never double-charges reasoning: it is inside output', function () {
    // reasoningTokens are not passed in (they are part of output) — pricing a
    // turn that reports only output must bill output once.
    const estimate = estimateCodexCost(
      { outputTokens: 2_000 },
      'gpt-5-codex',
      RATE,
      META,
    );
    assert.strictEqual(estimate.costUsd, 2_000 * (6 / 1e6));
  });

  it('is price-unavailable (null) when the caller resolves no rate', function () {
    // The pure function trusts the caller to resolve a rate — this mirrors the
    // service, which looks an unknown model up, gets nothing, and so passes
    // null rather than guessing a neighbouring model's rate.
    const miss = lookupCodexRate('gpt-7-unknown', BUNDLED_OPENAI_LIST_PRICES);
    assert.strictEqual(miss, null);
    assert.strictEqual(estimateCodexCost(
      { inputTokens: 100, outputTokens: 100 },
      'gpt-7-unknown',
      miss,
      META,
    ), null);
  });

  it('returns null when no rate exists for the model', function () {
    assert.strictEqual(estimateCodexCost(
      { inputTokens: 100, outputTokens: 100 },
      'gpt-5-codex',
      null,
      META,
    ), null);
    assert.strictEqual(estimateCodexCost(
      { inputTokens: 100, outputTokens: 100 },
      undefined,
      RATE,
      META,
    ), null);
  });

  it('stamps stale and retrospective flags through', function () {
    const stale = estimateCodexCost(
      { inputTokens: 100, outputTokens: 100 },
      'gpt-5-codex',
      RATE,
      { ...META, stale: true, retrospective: true },
    );
    assert.strictEqual(stale.stale, true);
    assert.strictEqual(stale.retrospective, true);
  });

  it('retains the rounded-precisely figure for display elsewhere', function () {
    // A tiny cost must survive as a real number, not round away to 0.
    const estimate = estimateCodexCost(
      { inputTokens: 10, outputTokens: 20 },
      'gpt-5-codex',
      RATE,
      META,
    );
    assert.strictEqual(estimate.costUsd, 10 * (2 / 1e6) + 20 * (6 / 1e6));
  });
});

describe('lookupCodexRate', function () {
  it('matches the exact id', function () {
    const hit = lookupCodexRate('gpt-5-codex', BUNDLED_OPENAI_LIST_PRICES);
    assert.ok(hit);
    assert.strictEqual(hit.model, 'gpt-5-codex');
  });

  it('strips an effort suffix to reach the base entry', function () {
    const hit = lookupCodexRate('gpt-5.2-codex-high', BUNDLED_OPENAI_LIST_PRICES);
    assert.ok(hit);
    assert.strictEqual(hit.model, 'gpt-5.2-codex');
  });

  it('prefers an exact entry over a suffix-stripped one', function () {
    const hit = lookupCodexRate('gpt-5.6-codex-ultra', BUNDLED_OPENAI_LIST_PRICES);
    assert.ok(hit);
    assert.strictEqual(hit.model, 'gpt-5.6-codex-ultra');
  });

  it('returns null for an unknown model rather than guessing a neighbour', function () {
    assert.strictEqual(lookupCodexRate('gpt-99', BUNDLED_OPENAI_LIST_PRICES), null);
  });
});

describe('describeCodexEstimate', function () {
  it('names the model, the rates and the pricing date', function () {
    const estimate = estimateCodexCost(
      { inputTokens: 100, outputTokens: 50 },
      'gpt-5-codex',
      RATE,
      META,
    );
    const text = describeCodexEstimate(estimate);
    assert.match(text, /Estimated at OpenAI published list price/);
    assert.match(text, /priced 2026-08-05/);
    assert.match(text, /gpt-5-codex/);
    assert.match(text, /Not an actual bill/);
  });

  it('discloses a stale rate as last known', function () {
    const estimate = estimateCodexCost(
      { inputTokens: 100, outputTokens: 50 },
      'gpt-5-codex',
      RATE,
      { ...META, stale: true },
    );
    assert.match(describeCodexEstimate(estimate), /\(last known\)/);
  });
});
