/**
 * Runtime profiles: per-runtime launch configuration the user edits in Settings.
 *
 * Deliberately provider-agnostic. Nothing here knows about OpenRouter,
 * Anthropic, or any vendor: a model is an opaque string the user types and the
 * runtime interprets. The app's job is to carry it to the right CLI, not to
 * validate it against a catalogue that would go stale the week it shipped.
 *
 * One profile carries all three configuration mechanisms, because they are
 * three answers to the same question and users think of them together:
 *
 *   - `model` / `args` — launch flags, passed on the command line.
 *   - `env`            — environment variables, injected at spawn.
 *   - `tiers`          — abstract capability tiers, written through to the
 *                        runtime's own config format (see tier-writer).
 *
 * Every field is optional: a profile that only sets `env` is valid, and so is
 * one that only names tiers.
 */

/**
 * Capability tiers, cheapest first.
 *
 * These name a *role*, not a vendor or a size — "the cheapest model that can
 * still pass this step" rather than "the 8B one". Runtimes that support
 * delegation map them onto their own vocabulary.
 */
export const MODEL_TIERS = ['floor', 'mid', 'high', 'top'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export interface RuntimeProfile {
  id: string;
  name: string;
  /** Runtime this profile applies to (an AgentKind). */
  runtime: string;
  /** Free-text model identifier, passed via the runtime's model flag. */
  model?: string;
  /** Extra CLI arguments, appended after the bridge's own. */
  args?: string[];
  /** Environment variables injected into the spawned process. */
  env?: Record<string, string>;
  /** Abstract tiers, written through to the runtime's native config. */
  tiers?: Partial<Record<ModelTier, string>>;
}

export interface RuntimeProfilesConfig {
  profiles: RuntimeProfile[];
  /** runtime kind -> profile id currently active for it. */
  active: Record<string, string>;
}

export const EMPTY_PROFILES: RuntimeProfilesConfig = { profiles: [], active: {} };

/** Caps. Generous enough for real use, small enough that the row cannot become a payload. */
export const LIMITS = {
  profiles: 50,
  nameLength: 60,
  modelLength: 200,
  args: 32,
  argLength: 400,
  envVars: 32,
  envKeyLength: 100,
  envValueLength: 2000,
} as const;

/**
 * Environment variables that are never accepted from a profile.
 *
 * These change which code the child process loads rather than how the agent
 * behaves, so a value here turns "configure my model" into "run my binary".
 * Settings are app-wide while sessions are per-user, so on a multi-user install
 * one person's profile would otherwise reach into everyone else's PTY.
 */
const BLOCKED_ENV = new Set([
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'NODE_OPTIONS',
  'BASH_ENV',
  'ENV',
  'IFS',
  'PATH',
  'SHELL',
  'PYTHONSTARTUP',
  'PERL5OPT',
]);

/** POSIX-ish name rule. Rejects `=`, spaces and anything that is not a plain identifier. */
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isBlockedEnvKey(key: string): boolean {
  return BLOCKED_ENV.has(key.toUpperCase());
}

function cleanString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  // Control characters would be interpreted by the PTY rather than the CLI.
  const trimmed = value.replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

function cleanArgs(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const args: string[] = [];
  for (const entry of value) {
    const arg = cleanString(entry, LIMITS.argLength);
    if (arg) args.push(arg);
    if (args.length >= LIMITS.args) break;
  }
  return args.length ? args : undefined;
}

function cleanEnv(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const env: Record<string, string> = {};
  let count = 0;
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (count >= LIMITS.envVars) break;
    const key = typeof rawKey === 'string' ? rawKey.trim() : '';
    if (!ENV_KEY.test(key) || key.length > LIMITS.envKeyLength) continue;
    if (isBlockedEnvKey(key)) continue;
    const val = typeof rawValue === 'string'
      ? rawValue.replace(/[\u0000-\u001F\u007F]/g, '').slice(0, LIMITS.envValueLength)
      : '';
    // An empty value is meaningful (it unsets meaning for many CLIs), so unlike
    // the other fields it is kept rather than dropped.
    env[key] = val;
    count++;
  }
  return count ? env : undefined;
}

function cleanTiers(value: unknown): Partial<Record<ModelTier, string>> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const tiers: Partial<Record<ModelTier, string>> = {};
  let count = 0;
  for (const tier of MODEL_TIERS) {
    const model = cleanString((value as Record<string, unknown>)[tier], LIMITS.modelLength);
    if (model) {
      tiers[tier] = model;
      count++;
    }
  }
  return count ? tiers : undefined;
}

/** A profile id we generated, or one that is safe to use as a filename fragment. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Normalize whatever arrived over the wire into a config we are willing to
 * spawn from. Invalid entries are dropped rather than rejected wholesale, so a
 * single bad row cannot make the whole Settings page unsaveable.
 */
export function normalizeProfilesConfig(input: unknown): RuntimeProfilesConfig {
  if (!input || typeof input !== 'object') return { ...EMPTY_PROFILES };
  const raw = input as Partial<RuntimeProfilesConfig>;

  const profiles: RuntimeProfile[] = [];
  const seen = new Set<string>();

  if (Array.isArray(raw.profiles)) {
    for (const entry of raw.profiles) {
      if (profiles.length >= LIMITS.profiles) break;
      if (!entry || typeof entry !== 'object') continue;
      const candidate = entry as Partial<RuntimeProfile>;

      const id = typeof candidate.id === 'string' && ID.test(candidate.id) ? candidate.id : null;
      const name = cleanString(candidate.name, LIMITS.nameLength);
      const runtime = cleanString(candidate.runtime, 40);
      if (!id || !name || !runtime || seen.has(id)) continue;
      seen.add(id);

      const profile: RuntimeProfile = { id, name, runtime };
      const model = cleanString(candidate.model, LIMITS.modelLength);
      if (model) profile.model = model;
      const args = cleanArgs(candidate.args);
      if (args) profile.args = args;
      const env = cleanEnv(candidate.env);
      if (env) profile.env = env;
      const tiers = cleanTiers(candidate.tiers);
      if (tiers) profile.tiers = tiers;

      profiles.push(profile);
    }
  }

  const active: Record<string, string> = {};
  if (raw.active && typeof raw.active === 'object' && !Array.isArray(raw.active)) {
    for (const [runtime, profileId] of Object.entries(raw.active as Record<string, unknown>)) {
      const kind = cleanString(runtime, 40);
      if (!kind || typeof profileId !== 'string') continue;
      // A dangling id would silently apply nothing; drop it so the UI shows the
      // truth rather than a selection that does not exist.
      const profile = profiles.find((p) => p.id === profileId);
      if (profile && profile.runtime === kind) active[kind] = profileId;
    }
  }

  return { profiles, active };
}

/** The profile currently active for a runtime, or null. */
export function resolveActiveProfile(
  config: RuntimeProfilesConfig,
  runtime: string,
): RuntimeProfile | null {
  const id = config.active[runtime];
  if (!id) return null;
  return config.profiles.find((p) => p.id === id) ?? null;
}

/** Profiles defined for a runtime, in declaration order. */
export function profilesForRuntime(
  config: RuntimeProfilesConfig,
  runtime: string,
): RuntimeProfile[] {
  return config.profiles.filter((p) => p.runtime === runtime);
}
