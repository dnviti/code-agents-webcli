/**
 * The reasoning-effort level to open a new conversation at, per runtime.
 *
 * Two things remember an effort level and they answer different questions. The
 * server record (`chatEffortOverride`) knows what *this* conversation is running
 * at, and has to, because a rejoin after a reload finds a live process whose
 * level nothing on the page would otherwise know. This file knows what to open
 * the *next* conversation at, which is a fact about the person rather than about
 * any conversation, and so belongs in their browser.
 *
 * Keyed by runtime because the ladders are not comparable. `xhigh` means
 * something to claude and pi and nothing at all to kimi, whose whole ladder is
 * `off` and `on`; carrying one runtime's choice across to another would have to
 * either invent a translation or silently drop to a neighbour, and both are
 * worse than remembering each separately. Somebody who runs claude at `max` and
 * kimi at `on` gets both back, which is what they chose.
 *
 * Shaped like `view-settings.ts` on purpose — same six steps, same rule that
 * storage is never trusted — because it is the same kind of thing and the next
 * person to read one should recognise the other.
 */

/** Runtime id -> the level last chosen for it, spelled as that runtime spells it. */
export type EffortPreferences = Record<string, string>;

const STORAGE_KEY = 'cc-web-chat-effort';

/**
 * The longest a level is allowed to be, and what it may contain.
 *
 * The same shape the server enforces before it will store one, restated here so
 * a hand-edited or downgraded storage entry cannot put a value into the picker
 * that the server would then refuse — which would read as a control that does
 * nothing rather than as the bad data it is.
 */
const LEVEL = /^[a-z][a-z0-9_-]{0,31}$/;

/** How many runtimes are worth remembering. Six exist; the cap is only a bound. */
const MAX_ENTRIES = 32;

/**
 * Coerce whatever is in storage into something safe to hand the picker.
 *
 * Storage is not a trusted input: it survives downgrades, hand edits, and a
 * half-written value from a tab that crashed mid-write. Anything that is not a
 * plain object of short lower-case tokens is dropped entry by entry rather than
 * wholesale, so one bad key cannot cost somebody the other five.
 */
export function normalizeEffortPreferences(raw: unknown): EffortPreferences {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: EffortPreferences = {};
  for (const [runtime, level] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_ENTRIES) break;
    if (!LEVEL.test(runtime)) continue;
    if (typeof level !== 'string' || !LEVEL.test(level)) continue;
    out[runtime] = level;
  }
  return out;
}

export function loadEffortPreferences(): EffortPreferences {
  try {
    return normalizeEffortPreferences(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'));
  } catch {
    // Unparseable storage reads as "nothing remembered", which is the state
    // every browser starts in and never worse than what it replaces.
    return {};
  }
}

/**
 * Remember a level for one runtime and answer with the whole updated set.
 *
 * Returns the normalised value rather than the input, so a caller that publishes
 * what it stored can never hold a preference that would not survive a reload.
 * A storage failure — quota, private browsing — is swallowed on purpose: the
 * choice still applies to the conversation it was made in, it simply will not be
 * there next time, and refusing the change would help nobody.
 */
export function rememberEffort(runtime: string, level: string | null): EffortPreferences {
  const next = loadEffortPreferences();
  if (level) next[runtime] = level;
  else delete next[runtime];
  const normalized = normalizeEffortPreferences(next);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // See above.
  }
  return normalized;
}
