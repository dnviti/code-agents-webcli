/**
 * Codex list-price catalogue: the durable, refreshable source an estimate is
 * priced against.
 *
 * Issue #182's contract is that prices come from OpenAI's *official* published
 * list price, refresh automatically within 24h of a published change, and fall
 * back to the last known official rate (date disclosed) when the source is
 * unreachable. This service owns that lifecycle:
 *
 *   - a bundled offline snapshot (`BUNDLED_OPENAI_LIST_PRICES`) is always the
 *     floor — every known codex model has a rate before the first refresh, and
 *     a model the refresh has never heard of can still be priced when it has a
 *     known public rate;
 *   - fetched rates are persisted to a `codex_prices` table so a restart keeps
 *     whatever the last successful refresh published;
 *   - a daily `refresh()` reads the official pricing document, keeps the last
 *     known official rate (marked stale) if that read fails, and never sends
 *     anything but the pricing request itself.
 *
 * The service resolves a *rate* for a model; the pure arithmetic lives in the
 * shared module so every consumer prices identically.
 */

import {
  BUNDLED_OPENAI_LIST_PRICES,
  CodexCostEstimate,
  CodexRateSource,
  CodexTokenInput,
  OpenAiModelRate,
  estimateCodexCost,
  lookupCodexRate,
} from '../../shared/codex-pricing.js';
import { AppDatabase } from './database.js';

/** The cadence the official source is re-read at. */
export const PRICING_REFRESH_MS = 24 * 60 * 60 * 1000;
/** A hostile or misbehaving pricing document must not exhaust memory. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * The official public pricing document this app refreshes from.
 *
 * The Azure-hosted mirror of OpenAI's API list prices that the wider ecosystem
 * reads as the machine-readable source of truth. Only this one request is ever
 * made — no conversation, usage, account, model-choice or user data leaves the
 * machine (acceptance: "A price refresh sends only the request needed to
 * retrieve the public pricing resource").
 */
export const OPENAI_PRICING_URL = 'https://models.azure.com/azure/openai/public/openaipricing';

/** The date the bundled snapshot was authored (used only for its entries). */
const BUNDLED_SNAPSHOT_DATE = '2026-08-05';

/** One resolvable rate plus the provenance to disclose alongside it. */
export interface CodexRateDatum {
  /** The confirmed model id this rate was resolved for. */
  model: string;
  rates: OpenAiModelRate;
  source: CodexRateSource;
  /** ISO date (YYYY-MM-DD) the rate is effective as of. */
  pricingDate: string;
  /** True when serving the last known official rate after a failed refresh. */
  stale: boolean;
}

export interface CodexPricingOptions {
  database: AppDatabase;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/**
 * Parse the official pricing document into a per-model rate table.
 *
 * `openaipricing`'s exact shape has drifted between builds; rather than bet on
 * one, this reads the field names every variant has shipped with and validates
 * magnitudes. A value below $0.01 is treated as per-token (OpenAI's own API
 * pricing is quoted per token in places) and scaled to per-million; otherwise
 * it is taken as per-million directly. Documents that parse to nothing yield
 * null so the caller keeps the last known official rate rather than recording
 * a fiction.
 */
export function parseOpenAiPricing(json: unknown): Record<string, OpenAiModelRate> | null {
  const items: Array<Record<string, unknown>> = [];
  if (Array.isArray(json)) {
    for (const row of json) {
      if (row && typeof row === 'object') items.push(row as Record<string, unknown>);
    }
  } else if (json && typeof json === 'object') {
    // A flat map `{ "<model>": { input, output, cached_input } }` and a set of
    // named model objects both appear in the wild; flatten both.
    for (const [key, value] of Object.entries(json)) {
      if (value && typeof value === 'object') {
        items.push({ id: key, ...(value as Record<string, unknown>) });
      }
    }
  }
  if (items.length === 0) return null;

  const out: Record<string, OpenAiModelRate> = {};
  for (const row of items) {
    const id = firstString(row, ['id', 'model', 'name']);
    if (!id) continue;

    const input = firstNumber(row, ['input', 'input_tokens', 'input_price', 'prompt', 'inputPerM', 'prompt_tokens']);
    const output = firstNumber(row, ['output', 'output_tokens', 'output_price', 'completion', 'outputPerM', 'completion_tokens']);
    const cached = firstNumber(row, ['cached_input', 'cachedInput', 'cached_input_tokens', 'cached', 'cached_input_per_million']);
    if (input === undefined || output === undefined) continue;

    // Normalise units: per-token (tiny) vs per-million (billed), then round so
    // a scaled value stays a clean number for comparison and persistence.
    const scale = (value: number): number => {
      const perM = value < 0.01 && value > 0 ? value * 1e6 : value;
      return Math.round(perM * 1e6) / 1e6;
    };
    const rate: OpenAiModelRate = {
      inputPerM: scale(input),
      outputPerM: scale(output),
      cachedInputPerM: cached === undefined ? rate0(scale(input)) : scale(cached),
    };
    if (rate.inputPerM <= 0 || rate.outputPerM <= 0) continue;
    out[id] = rate;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function rate0(v: number): number {
  // A reasonable default cached price when the document omits it: OpenAI bills
  // cached input at a discount off uncached; 20% is the low end of the common
  // range and better than refusing to price cached input at all.
  return Math.round(v * 0.2 * 1000) / 1000;
}

function firstString(row: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = row[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

function firstNumber(row: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const v = row[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

interface PriceRow {
  model: string;
  input_per_m: number;
  cached_input_per_m: number;
  output_per_m: number;
  source: string;
  pricing_date: string;
  fetched_at: string;
}

export class CodexPricing {
  private readonly database: AppDatabase;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  /** In-memory view of the catalogue: bundled overlaid with what was fetched. */
  private catalogue: Record<string, CodexRateDatum> = {};
  /**
   * When the most recent refresh failed. While set, an openai-list rate served
   * is the last known official one and is disclosed as stale.
   */
  private refreshFailureAt: string | null = null;

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: CodexPricingOptions) {
    this.database = options.database;
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
    this.now = options.now ?? (() => new Date());
    this.load();
  }

  /** Rebuild the in-memory catalogue from the bundled snapshot + database. */
  private load(): void {
    const merged: Record<string, CodexRateDatum> = {};
    for (const [model, rates] of Object.entries(BUNDLED_OPENAI_LIST_PRICES)) {
      merged[model] = {
        model,
        rates,
        source: 'bundled-snapshot',
        pricingDate: BUNDLED_SNAPSHOT_DATE,
        stale: false,
      };
    }
    const rows = (() => {
      try {
        return this.database.raw
          .prepare(`
            SELECT model, input_per_m, cached_input_per_m, output_per_m,
                   source, pricing_date, fetched_at
            FROM codex_prices ORDER BY fetched_at DESC
          `)
          .all() as unknown as PriceRow[];
      } catch {
        return [];
      }
    })();
    for (const row of rows) {
      merged[row.model] = {
        model: row.model,
        rates: {
          inputPerM: row.input_per_m,
          cachedInputPerM: row.cached_input_per_m,
          outputPerM: row.output_per_m,
        },
        source: row.source === 'openai-list' ? 'openai-list' : 'bundled-snapshot',
        pricingDate: row.pricing_date,
        stale: false,
      };
    }
    this.catalogue = merged;
  }

  /**
   * Resolve the published rate for a confirmed model, or null (price
   * unavailable) when no official price has ever been obtained for it.
   */
  lookup(model: string | undefined): CodexRateDatum | null {
    if (!model) return null;
    const rateTable: Record<string, OpenAiModelRate> = {};
    for (const [key, datum] of Object.entries(this.catalogue)) {
      rateTable[key] = datum.rates;
    }
    const hit = lookupCodexRate(model, rateTable);
    if (!hit) return null;
    const datum = this.catalogue[hit.model];
    if (!datum) return null;
    // A fetched official rate served while a refresh is failing is the last
    // known one; say so. The bundled snapshot is never "stale" — its age is
    // disclosed by its source label already.
    const stale = datum.source === 'openai-list' && this.refreshFailureAt !== null;
    return { ...datum, rates: hit.rates, stale };
  }

  /**
   * Estimate the API-equivalent USD cost of one codex turn, or null when no
   * price is available for the confirmed model ("price unavailable").
   */
  estimate(
    tokens: CodexTokenInput,
    model: string | undefined,
    opts: { retrospective?: boolean } = {},
  ): CodexCostEstimate | null {
    const datum = this.lookup(model);
    if (!datum) return null;
    return estimateCodexCost(
      tokens,
      model,
      datum.rates,
      {
        pricingDate: datum.pricingDate,
        source: datum.source,
        stale: datum.stale,
        ...(opts.retrospective ? { retrospective: true } : {}),
      },
    );
  }

  /**
   * Fetch and apply the official pricing document.
   *
   * On success, fetched rates are persisted and drive future estimates. On any
   * failure the last known official rate stays in service, marked stale, and
   * `refresh` returns `{ failed: true }` rather than throwing — an outage is
   * disclosed, not silent.
   */
  async refresh(): Promise<{ updated: number } | { failed: true; reason: string }> {
    const now = this.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let body: string;
      try {
        const res = await this.fetchImpl(OPENAI_PRICING_URL, {
          signal: controller.signal,
          headers: { accept: 'application/json' },
        });
        const declared = Number(res.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
          throw new Error('pricing document larger than the allowed maximum');
        }
        const text = await res.text();
        if (text.length > MAX_RESPONSE_BYTES) {
          throw new Error('pricing document larger than the allowed maximum');
        }
        if (!res.ok) throw new Error(`pricing endpoint responded ${res.status}`);
        body = text;
      } finally {
        clearTimeout(timeout);
      }

      const parsed = parseOpenAiPricing(JSON.parse(body));
      if (!parsed || Object.keys(parsed).length === 0) {
        throw new Error('pricing document contained no usable rates');
      }

      const todayIso = nowISO(now);
      const fetchedAt = now.toISOString();
      const upsert = this.database.raw.prepare(`
        INSERT INTO codex_prices
          (model, input_per_m, cached_input_per_m, output_per_m, source, pricing_date, fetched_at)
        VALUES (?, ?, ?, ?, 'openai-list', ?, ?)
        ON CONFLICT(model) DO UPDATE SET
          input_per_m = excluded.input_per_m,
          cached_input_per_m = excluded.cached_input_per_m,
          output_per_m = excluded.output_per_m,
          source = 'openai-list',
          pricing_date = excluded.pricing_date,
          fetched_at = excluded.fetched_at
      `);
      const write = this.database.raw.transaction(() => {
        for (const [model, rates] of Object.entries(parsed)) {
          if (!model || rates.inputPerM <= 0 || rates.outputPerM <= 0) continue;
          upsert.run(model, rates.inputPerM, rates.cachedInputPerM, rates.outputPerM, todayIso, fetchedAt);
          this.catalogue[model] = {
            model,
            rates,
            source: 'openai-list',
            pricingDate: todayIso,
            stale: false,
          };
        }
      });
      write();
      this.refreshFailureAt = null;
      return { updated: Object.keys(parsed).length };
    } catch (error) {
      // Keep the last known official rate in service, disclosed as stale.
      this.refreshFailureAt = nowISO(now);
      const reason = error instanceof Error ? error.message : String(error);
      return { failed: true, reason };
    }
  }

  /**
   * Start the daily refresh as a background, non-blocking interval.
   *
   * Uses `.unref()` like the server's other long-lived timers so it never keeps
   * the process alive on its own. `refresh()` is run immediately once so a
   * freshly-installed build picks up official prices without waiting a day.
   */
  start(): void {
    if (this.timer) return;
    void this.refresh().catch(() => undefined);
    this.timer = setInterval(() => {
      void this.refresh().catch(() => undefined);
    }, PRICING_REFRESH_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** For diagnostics and tests: the number of resolvable rates in memory. */
  size(): number {
    return Object.keys(this.catalogue).length;
  }
}

function nowISO(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
