import { RuntimeProfile } from './runtime-profiles.js';

/**
 * Runtime profiles the app ships with.
 *
 * Seeded once, on the first install that has never stored a profile config, so
 * the Settings page opens with something to read and edit rather than an empty
 * list. **None of them is made active**: a fresh install still launches every
 * CLI exactly as it would from a shell, and a profile only takes effect when
 * someone picks it. That matters because profiles are server-wide — seeding an
 * active one would silently change how every user's agents start.
 *
 * They are ordinary profiles once seeded: editable, deletable, and never
 * rewritten by a later build. Deleting them all is remembered (see the seed
 * marker in RuntimeProfileStore), so they do not come back on the next restart.
 *
 * ## On the model names
 *
 * The rest of this feature is deliberately provider-agnostic — a model is an
 * opaque string the CLI interprets. A *default*, though, has to be concrete to
 * be worth anything, so these name real models on a real gateway, and say so in
 * their titles rather than pretending to be neutral. Model catalogues move
 * faster than releases do: treat these as starting points to edit, not as a
 * curated list this project maintains.
 */

/** Tier → model, the shape both tier-capable runtimes consume. */
interface Ladder {
  floor: string;
  mid: string;
  high: string;
  top: string;
}

/**
 * Cheapest ladder that still finishes real work: a fast reader on the floor, a
 * code-tuned mid, and one strong model doing both review tiers.
 */
const ECONOMY: Ladder = {
  floor: 'openrouter/minimax/minimax-m3',
  mid: 'openrouter/moonshotai/kimi-k2.7-code',
  high: 'openrouter/moonshotai/kimi-k3',
  top: 'openrouter/moonshotai/kimi-k3',
};

/**
 * Mixed-vendor ladder: a cheap model for the read-only pass, then frontier
 * models where judgment actually costs something to get wrong.
 */
const BALANCED: Ladder = {
  floor: 'openrouter/google/gemini-3.1-flash-lite',
  mid: 'openrouter/anthropic/claude-sonnet-5',
  high: 'openrouter/anthropic/claude-opus-5',
  top: 'openrouter/anthropic/claude-opus-5',
};

/**
 * Ids are fixed rather than generated: a later build that adds a default has to
 * be able to tell its own entries apart from the user's, and a stable id is
 * what makes that possible.
 */
function ladderProfile(runtime: string, key: string, name: string, tiers: Ladder): RuntimeProfile {
  return { id: `default-${runtime}-${key}`, name, runtime, tiers: { ...tiers } };
}

export const DEFAULT_PROFILES: RuntimeProfile[] = [
  // Tier ladders, for the two runtimes that can express tiers natively. Same
  // two ladders for both, so switching runtime does not mean re-deciding which
  // model does which job.
  ladderProfile('pi', 'economy', 'Economy ladder — OpenRouter', ECONOMY),
  ladderProfile('pi', 'balanced', 'Balanced ladder — OpenRouter', BALANCED),
  ladderProfile('omp', 'economy', 'Economy ladder — OpenRouter', ECONOMY),
  ladderProfile('omp', 'balanced', 'Balanced ladder — OpenRouter', BALANCED),

  // Claude Code has no tier concept, so the useful profile is a plain model
  // pin — the one setting worth flipping between runs.
  {
    id: 'default-claude-opus',
    name: 'Opus 5 — most capable',
    runtime: 'claude',
    model: 'claude-opus-5',
  },
  {
    id: 'default-claude-sonnet',
    name: 'Sonnet 5 — faster, cheaper',
    runtime: 'claude',
    model: 'claude-sonnet-5',
  },
];

/**
 * Bumping this does **not** re-seed: the marker records that seeding has
 * happened at all, so a user who deletes every default keeps them deleted. It
 * exists so a future migration can tell *which* set an install was seeded with.
 */
export const DEFAULT_PROFILES_VERSION = '1';
