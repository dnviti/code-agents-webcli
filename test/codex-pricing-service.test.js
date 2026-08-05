/**
 * The codex pricing service: resolves a rate for a confirmed model, estimates,
 * and — the contract that distinguishes this from a static table — refreshes
 * from the official document, keeps the last known rate during an outage
 * (disclosed as stale), and persists so a restart does not lose official
 * prices.
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { AppDatabase } = require('../dist/server/services/database.js');
const {
  CodexPricing,
  parseOpenAiPricing,
  OPENAI_PRICING_URL,
} = require('../dist/server/services/codex-pricing.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-pricing-'));
}

function makeService(fetchImpl, { now } = {}) {
  const db = new AppDatabase({ dataDir: tmpDir() });
  return {
    db,
    pricing: new CodexPricing({
      database: db,
      fetchImpl: fetchImpl || (async () => {
        throw new Error('no fetch');
      }),
      now,
    }),
  };
}

// A realistic fixture for the official document, per-token prices (the shape
// the scale-normalisation path exists for).
const DOCUMENT = {
  'gpt-5.6-codex': { input: 0.0000005, output: 0.000004, cached_input: 0.00000005 },
  'gpt-5-codex': { input: 0.0000005, output: 0.000004, cached_input: 0.00000005 },
};

describe('parseOpenAiPricing', function () {
  it('reads a flat object map and scales per-token to per-million', function () {
    const rates = parseOpenAiPricing(DOCUMENT);
    assert.ok(rates);
    assert.deepStrictEqual(rates['gpt-5.6-codex'], {
      inputPerM: 0.5,
      outputPerM: 4,
      cachedInputPerM: 0.05,
    });
  });

  it('reads an array of rows', function () {
    const rates = parseOpenAiPricing(
      Object.entries(DOCUMENT).map(([id, pricing]) => ({ id, ...pricing })),
    );
    assert.ok(rates);
    assert.deepStrictEqual(rates['gpt-5-codex'].inputPerM, 0.5);
  });

  it('returns null for a document with nothing usable', function () {
    assert.strictEqual(parseOpenAiPricing(null), null);
    assert.strictEqual(parseOpenAiPricing({}), null);
    assert.strictEqual(parseOpenAiPricing({ 'gpt-5': { description: 'no prices' } }), null);
    assert.strictEqual(parseOpenAiPricing('nonsense'), null);
  });
});

describe('CodexPricing', function () {
  it('starts from the bundled snapshot before any refresh', function () {
    const { pricing } = makeService();
    const datum = pricing.lookup('gpt-5-codex');
    assert.ok(datum);
    assert.strictEqual(datum.source, 'bundled-snapshot');
    assert.ok(datum.rates.inputPerM > 0);
  });

  it('estimates through the shared formula once a rate resolves', function () {
    const { pricing } = makeService(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify(DOCUMENT),
    }));
    // 900k uncached @$0.5/M = 0.45; 100k cached @$0.05/M = 0.005;
    // 50k out @$4/M = 0.2  ->  $0.655
    const est = pricing.estimate(
      { inputTokens: 1_000_000, cacheReadTokens: 100_000, outputTokens: 50_000 },
      'gpt-5.6-codex',
    );
    assert.ok(est);
    assert.ok(Math.abs(est.costUsd - 0.655) < 1e-9);
    // Source/provenance are asserted in the refresh-persistence tests; this one
    // only proves the wired-through arithmetic.
    assert.strictEqual(Boolean(est.stale), false);
  });

  it('returns null for a model with no official price (price unavailable)', function () {
    const { pricing } = makeService();
    const est = pricing.estimate({ inputTokens: 100, outputTokens: 100 }, 'gpt-99-unknown');
    assert.strictEqual(est, null);
  });

  it('applies a refresh and persists so a second instance still has it', async function () {
    const { db, pricing } = makeService(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify(DOCUMENT),
    }), { now: () => new Date('2026-08-06T12:00:00Z') });

    const res = await pricing.refresh();
    assert.deepStrictEqual(res, { updated: 2 });

    // A fresh service over the same database must still resolve the official rate.
    const reopened = new CodexPricing({
      database: db,
      fetchImpl: async () => { throw new Error('offline'); },
      now: () => new Date('2026-08-07T12:00:00Z'),
    });
    const est = reopened.estimate(
      { inputTokens: 1_000_000, cacheReadTokens: 100_000, outputTokens: 50_000 },
      'gpt-5.6-codex',
    );
    assert.ok(est);
    assert.strictEqual(est.source, 'openai-list');
    assert.strictEqual(est.pricingDate, '2026-08-06');
    assert.strictEqual(Boolean(est.stale), false);
  });

  it('keeps the last known official rate (marked stale) when a refresh fails', async function () {
    let fail = false;
    const { db, pricing } = makeService(async () => {
      if (fail) throw new Error('network down');
      return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(DOCUMENT) };
    }, { now: () => new Date('2026-08-06T12:00:00Z') });

    await pricing.refresh();
    fail = true;
    const failed = await pricing.refresh();
    assert.ok((failed).failed === true);

    const est = pricing.estimate({ inputTokens: 1000, outputTokens: 500 }, 'gpt-5.6-codex');
    assert.ok(est);
    assert.strictEqual(est.source, 'openai-list');
    assert.strictEqual(est.stale, true);
    assert.strictEqual(est.pricingDate, '2026-08-06');
  });

  it('never sends anything but the pricing request (single GET, no payload)', async function () {
    const calls = [];
    const { pricing } = makeService(async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(DOCUMENT) };
    });
    await pricing.refresh();
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, OPENAI_PRICING_URL);
    assert.strictEqual(calls[0].init.body, undefined);
    // No credentials, no user/usage data in the request.
    assert.strictEqual(calls[0].init.headers?.authorization ?? undefined, undefined);
  });

  it('flags a retrospective estimate when asked', async function () {
    const { pricing } = makeService(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify(DOCUMENT),
    }), { now: () => new Date('2026-08-06T12:00:00Z') });
    await pricing.refresh();
    const est = pricing.estimate({ inputTokens: 1000, outputTokens: 500 }, 'gpt-5.6-codex', {
      retrospective: true,
    });
    assert.strictEqual(est.retrospective, true);
  });
});
