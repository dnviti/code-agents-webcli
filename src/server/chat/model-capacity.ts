/**
 * How big is this model's context window, when the agent running it won't say?
 *
 * Four of the six agents here report their own capacity and this is never
 * consulted for them — an agent's own figure always wins, and the gap between
 * the two is not academic: grok reports 512,000 tokens for `grok-build` while
 * the nearest catalogue entry says 256,000. Half. Which is also why the match
 * below is exact-id only.
 *
 * The two that say nothing — pi and kimi — turn out not to need a table
 * written here, because both are already talking to OpenRouter. pi reports
 * `provider: "openrouter"` with an OpenRouter model id; kimi's model ids are
 * literally `openrouter/moonshotai/kimi-k2.7-code`. So this asks the provider
 * those agents are using what its own models are, which is the difference
 * between a lookup and the hardcoded size table issue #82 rules out: nothing
 * in this file knows how big any particular model is, and a model that ships
 * tomorrow is answered without a release here.
 *
 * When the catalogue cannot be reached, or the model is not in it, this
 * returns null and the reading says capacity is unknown. A wrong ceiling is
 * worse than none — it invites someone to keep going up to a limit that is not
 * there.
 */

const CATALOGUE_URL = 'https://openrouter.ai/api/v1/models';
const REQUEST_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** A model catalogue changes on the order of days, not minutes. */
const TTL_MS = 6 * 60 * 60 * 1000;
/** After a failure, wait before hammering a provider that is down. */
const FAILURE_BACKOFF_MS = 5 * 60 * 1000;

/**
 * Set to turn the lookup off entirely.
 *
 * This is the one outbound request this feature makes, and it is made on a
 * user's behalf without them asking, so there is a way to say no. Nothing
 * about the conversation is sent either way — the whole catalogue is fetched
 * and matched locally, so the provider is never told which model is being
 * asked about — but an installation that talks to nothing but its own agents
 * should be able to stay that way. With it set, capacity is whatever the agent
 * reports and unknown otherwise.
 */
const DISABLE_ENV = 'CODE_AGENTS_WEBCLI_NO_MODEL_CATALOGUE';

export interface ModelCapacityOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  catalogueUrl?: string;
  /** Defaults to the environment; see `DISABLE_ENV`. */
  enabled?: boolean;
}

interface Catalogue {
  /** Model id -> context length in tokens. */
  windows: Map<string, number>;
  fetchedAt: number;
}

export class ModelCapacityLookup {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly url: string;
  private readonly enabled: boolean;
  private catalogue: Catalogue | null = null;
  private failedAt = 0;
  private inFlight: Promise<Catalogue | null> | null = null;

  constructor(options: ModelCapacityOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.now = options.now ?? (() => Date.now());
    this.url = options.catalogueUrl ?? CATALOGUE_URL;
    this.enabled = options.enabled ?? !truthy(process.env[DISABLE_ENV]);
  }

  /**
   * The window for this model in tokens, or null if nobody can say.
   *
   * `model` is whatever the agent called it. Never throws: a lookup failing is
   * an ordinary outcome here, not an error the conversation should carry.
   */
  async contextWindowFor(model: string | undefined): Promise<number | null> {
    if (!this.enabled) return null;
    const candidates = candidateIds(model);
    if (candidates.length === 0) return null;

    const catalogue = await this.load();
    if (!catalogue) return null;

    for (const id of candidates) {
      const window = catalogue.windows.get(id);
      if (window !== undefined) return window;
    }
    return null;
  }

  private async load(): Promise<Catalogue | null> {
    const now = this.now();
    if (this.catalogue && now - this.catalogue.fetchedAt < TTL_MS) {
      return this.catalogue;
    }
    // A stale catalogue still beats no answer while the provider is down, so
    // the backoff only suppresses the request, never the last good result.
    if (now - this.failedAt < FAILURE_BACKOFF_MS) {
      return this.catalogue;
    }
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.fetchCatalogue()
      .then((catalogue) => {
        if (catalogue) {
          this.catalogue = catalogue;
        } else {
          this.failedAt = this.now();
        }
        return this.catalogue;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private async fetchCatalogue(): Promise<Catalogue | null> {
    try {
      const res = await this.fetchImpl(this.url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: 'error',
      });
      if (!res.ok) return null;

      const body = await readCapped(res);
      if (body === null) return null;

      const parsed = JSON.parse(body) as unknown;
      const windows = readWindows(parsed);
      // An empty catalogue is a shape change, not an answer. Treating it as a
      // successful fetch would cache "nothing is known" for six hours.
      return windows.size > 0 ? { windows, fetchedAt: this.now() } : null;
    } catch {
      return null;
    }
  }
}

/** Any value but an explicit off, so `=1`, `=true` and a bare set all work. */
function truthy(value: string | undefined): boolean {
  if (!value) return false;
  const normalised = value.trim().toLowerCase();
  return normalised !== '' && normalised !== '0' && normalised !== 'false';
}

/**
 * Ids to try, most specific first.
 *
 * kimi prefixes the provider onto its own ids (`openrouter/moonshotai/...`),
 * and OpenRouter appends a variant to some (`:free`, `:thinking`) that does not
 * change the window. Nothing here invents a mapping between vendors: every
 * candidate is the reported name with a known prefix or suffix removed, so a
 * miss stays a miss rather than becoming a neighbouring model's number.
 */
function candidateIds(model: string | undefined): string[] {
  const name = (model ?? '').trim();
  if (!name) return [];

  const ids: string[] = [];
  const push = (id: string) => {
    if (id && !ids.includes(id)) ids.push(id);
  };

  push(name);
  if (name.startsWith('openrouter/')) push(name.slice('openrouter/'.length));

  for (const id of [...ids]) {
    const colon = id.lastIndexOf(':');
    // Only a variant suffix, never a bare word: `openai/gpt-5:free` has one,
    // `some-model:2024` might be part of the name, and both are handled the
    // same way — as a candidate that either matches exactly or does not.
    if (colon > 0) push(id.slice(0, colon));
  }
  return ids;
}

function readWindows(parsed: unknown): Map<string, number> {
  const windows = new Map<string, number>();
  const data = (parsed as { data?: unknown })?.data;
  if (!Array.isArray(data)) return windows;

  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as { id?: unknown; canonical_slug?: unknown; context_length?: unknown };
    const length = entry.context_length;
    if (typeof length !== 'number' || !Number.isFinite(length) || length <= 0) continue;

    if (typeof entry.id === 'string' && entry.id) windows.set(entry.id, length);
    // The canonical slug is the same model under the name its vendor uses, and
    // an agent may well report that one instead.
    if (typeof entry.canonical_slug === 'string' && entry.canonical_slug) {
      if (!windows.has(entry.canonical_slug)) windows.set(entry.canonical_slug, length);
    }
  }
  return windows;
}

async function readCapped(res: Response): Promise<string | null> {
  const body = res.body;
  if (!body) return null;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}
