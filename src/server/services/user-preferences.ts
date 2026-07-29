import {
  DEFAULT_USER_PREFERENCES,
  UserPreferences,
  normalizeUserPreferences,
} from '../../shared/user-preferences.js';

/**
 * The key each user's preferences hang off, under the per-user namespace
 * `getUserSetting` already applies (`user:<id>:<key>`).
 *
 * One JSON blob rather than a column per preference, for the same reason
 * runtime profiles are stored that way: the value is read whole on every chat
 * launch and written whole by the Settings dialog, so there is no query a
 * relational shape would serve.
 */
const SETTINGS_KEY = 'preferences';

export interface UserPreferenceDatabase {
  getUserSetting(userId: number, key: string): string | null;
  setUserSetting(userId: number, key: string, value: string): void;
}

/**
 * Where a person's preferences live, so they hold on their second device.
 *
 * On `app_settings` rather than a table of its own, keyed through the existing
 * per-user namespace. That leaves a deleted account's row behind, which is
 * harmless here and worth saying why: `users.id` is AUTOINCREMENT and is never
 * rewritten, so an id is never handed out twice — an orphaned row can never
 * become somebody else's standing permission. It is dead weight, not a grant.
 */
export class UserPreferenceStore {
  private readonly cache = new Map<number, UserPreferences>();

  constructor(private readonly deps: { database: UserPreferenceDatabase }) {}

  /**
   * This user's preferences, or the safe default.
   *
   * Never throws. It is called synchronously on the chat launch path, and a row
   * somebody hand-edited into invalid JSON must not be able to fail a launch —
   * nor to grant one anything, which is why the fallback is the default rather
   * than a partial parse.
   */
  get(userId: number): UserPreferences {
    const cached = this.cache.get(userId);
    if (cached) return cached;

    const raw = this.deps.database.getUserSetting(userId, SETTINGS_KEY);
    let value = { ...DEFAULT_USER_PREFERENCES };
    if (raw) {
      try {
        value = normalizeUserPreferences(JSON.parse(raw));
      } catch (error: unknown) {
        console.warn(
          `Ignoring unreadable preferences for user ${userId}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    this.cache.set(userId, value);
    return value;
  }

  /** Store, and hand back exactly what was stored so a dialog can reflect it. */
  set(userId: number, value: unknown): UserPreferences {
    const normalized = normalizeUserPreferences(value);
    this.deps.database.setUserSetting(userId, SETTINGS_KEY, JSON.stringify(normalized));
    // Before returning, not lazily: `/clear` resolves the mode again at restart
    // time, which can be seconds after this write, and a cache still holding the
    // old answer would restart the conversation in the mode the user just left.
    this.cache.set(userId, normalized);
    return normalized;
  }
}
