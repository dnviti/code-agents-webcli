import {
  DEFAULT_PROFILES,
  DEFAULT_PROFILES_VERSION,
} from '../../../../shared/default-profiles.js';
import {
  EMPTY_PROFILES,
  RuntimeProfile,
  RuntimeProfilesConfig,
  normalizeProfilesConfig,
  resolveActiveProfile,
} from '../../../../shared/runtime-profiles.js';

const SETTINGS_KEY = 'runtime_profiles';

/**
 * Records that the shipped defaults have been seeded — once, ever.
 *
 * Kept separate from the config itself so "the user deleted every profile" and
 * "this install has never been seeded" stay distinguishable. Without it,
 * clearing the list would hand the defaults straight back on the next restart.
 */
const SEED_KEY = 'runtime_profiles.seeded';

export interface ProfileStoreDatabase {
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
}


/**
 * Persistence for runtime profiles, on top of the app_settings key/value table.
 *
 * Stored as one JSON blob rather than a table: the whole config is read on every
 * session start and written whole by the Settings dialog, so there is no query
 * a relational shape would serve. Everything is re-normalized on read, which
 * means a row written by an older build (or edited by hand) can never hand
 * unvalidated values to spawn.
 */
export class RuntimeProfileStore {
  private database: ProfileStoreDatabase;
  private cache: RuntimeProfilesConfig | null = null;

  constructor(deps: { database: ProfileStoreDatabase }) {
    this.database = deps.database;
  }

  get(): RuntimeProfilesConfig {
    if (this.cache) return this.cache;

    const raw = this.database.getSetting(SETTINGS_KEY);
    if (!raw) {
      // Nothing stored. Either this install has never been seeded — in which
      // case it gets the shipped defaults — or it was seeded and has since been
      // emptied, which is a choice to respect rather than undo.
      this.cache = this.database.getSetting(SEED_KEY)
        ? { ...EMPTY_PROFILES }
        : this.seedDefaults();
      return this.cache;
    }

    try {
      this.cache = normalizeProfilesConfig(JSON.parse(raw));
    } catch {
      // A corrupt row must not take the server down on boot; an empty config is
      // the safe reading, and the next save overwrites it. Deliberately not
      // re-seeded: replacing a config we failed to read with different content
      // would look like the app silently threw the user's profiles away.
      console.warn('runtime profiles: stored value is not valid JSON, ignoring');
      this.cache = { ...EMPTY_PROFILES };
    }
    return this.cache;
  }

  /**
   * Write the shipped defaults, once.
   *
   * Normalized through the same validator as anything that arrives over the
   * wire — a default with a malformed field is dropped rather than trusted for
   * being ours, and the tests assert none of them are.
   *
   * `active` stays empty on purpose: profiles are server-wide, so a seeded
   * *active* profile would change how every user's agents launch on an install
   * where nobody asked for it. They are offered, not applied.
   */
  private seedDefaults(): RuntimeProfilesConfig {
    const config = normalizeProfilesConfig({ profiles: DEFAULT_PROFILES, active: {} });
    this.database.setSetting(SETTINGS_KEY, JSON.stringify(config));
    this.database.setSetting(SEED_KEY, DEFAULT_PROFILES_VERSION);
    return config;
  }

  save(input: unknown): RuntimeProfilesConfig {
    const config = normalizeProfilesConfig(input);
    this.database.setSetting(SETTINGS_KEY, JSON.stringify(config));
    // Someone has edited the list, so this install owns it now — the defaults
    // must not arrive later just because the stored row went missing.
    this.database.setSetting(SEED_KEY, DEFAULT_PROFILES_VERSION);
    this.cache = config;
    return config;
  }

  /** The profile that should apply to a new session of this runtime, if any. */
  activeFor(runtime: string): RuntimeProfile | null {
    return resolveActiveProfile(this.get(), runtime);
  }
}
