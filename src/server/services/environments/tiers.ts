/**
 * How big a user's environment is, and who decides.
 *
 * An administrator defines the catalog — the sizes this installation is willing
 * to hand out — and each user picks one of them, or picks `auto` and lets their
 * own load pick for them. Nothing here talks to an engine: the catalog is data
 * and the scaling decision is a pure function of the samples, so both can be
 * tested without a cluster and reasoned about without a stopwatch.
 */

import { parseSize } from './engine.js';
import { EnvironmentTier } from './types.js';

export type { EnvironmentTier };

/** The id that means "let the load decide", rather than naming a tier. */
export const AUTO_TIER = 'auto';

/**
 * A catalog that fits a single ordinary machine.
 *
 * Deliberately modest: these are the defaults on an installation whose
 * administrator has not thought about sizes yet, and handing out four cores by
 * default on a laptop would be worse than making them ask.
 */
export const DEFAULT_TIERS: EnvironmentTier[] = [
  { id: 'small', label: 'Small', cpus: '1', memory: '1g' },
  { id: 'medium', label: 'Medium', cpus: '2', memory: '2g' },
  { id: 'large', label: 'Large', cpus: '4', memory: '4g' },
];

/**
 * `small=1,1g;medium=2,2g` → a catalog.
 *
 * Order is the order written, and it is meaningful: `auto` steps along it, so
 * the administrator's sequence is the ladder. An entry that cannot be parsed is
 * dropped with a warning rather than failing startup — an unusable environment
 * catalog should not be the reason a server will not boot.
 */
export function parseTiers(raw: string): EnvironmentTier[] {
  const tiers: EnvironmentTier[] = [];

  for (const entry of raw.split(';').map((part) => part.trim()).filter(Boolean)) {
    const match = /^([A-Za-z0-9-]+)\s*=\s*([^,]+)\s*,\s*(.+)$/.exec(entry);
    if (!match) {
      console.warn(`Ignoring unreadable environment tier "${entry}" (expected "id=cpus,memory")`);
      continue;
    }
    const [, id, cpus, memory] = match;
    if (id === AUTO_TIER) {
      console.warn(`Ignoring environment tier "${id}": that name is reserved for automatic sizing`);
      continue;
    }
    tiers.push({
      id,
      label: id.charAt(0).toUpperCase() + id.slice(1),
      cpus: cpus.trim(),
      memory: memory.trim(),
    });
  }

  return tiers;
}

export function findTier(tiers: EnvironmentTier[], id: string | null): EnvironmentTier | null {
  if (!id) return null;
  return tiers.find((tier) => tier.id === id) || null;
}

/**
 * The tier an environment should actually be built at.
 *
 * `auto` is not a size, so it resolves to whichever size the scaler last
 * settled on — or, for a user who has never run anything, the default.
 */
export function resolveTier(
  tiers: EnvironmentTier[],
  chosen: string | null,
  defaultId: string,
  autoCurrent?: string | null,
): EnvironmentTier | null {
  if (!tiers.length) {
    return null;
  }
  if (chosen && chosen !== AUTO_TIER) {
    return findTier(tiers, chosen) || findTier(tiers, defaultId) || tiers[0];
  }
  if (chosen === AUTO_TIER) {
    return findTier(tiers, autoCurrent || null)
      || findTier(tiers, defaultId)
      || tiers[0];
  }
  return findTier(tiers, defaultId) || tiers[0];
}

export interface ResourceSample {
  cpuCores: number;
  memoryBytes: number;
}

/** What the scaler remembers between samples for one user. */
export interface AutoState {
  /** Consecutive samples at or above the high watermark. */
  hot: number;
  /** Consecutive samples at or below the low watermark. */
  cold: number;
  /** When this user's tier last moved, so a change is given time to matter. */
  lastChangeAt: number;
}

export const INITIAL_AUTO_STATE: AutoState = { hot: 0, cold: 0, lastChangeAt: 0 };

export interface AutoPolicy {
  /** Fraction of the tier's limit that counts as "busy". */
  highWatermark: number;
  /** Fraction below which it counts as "idle enough to shrink". */
  lowWatermark: number;
  /** Consecutive busy samples before stepping up. */
  hotSamples: number;
  /** Consecutive quiet samples before stepping down. Longer, deliberately. */
  coldSamples: number;
  /** How long after a change before another one may happen. */
  cooldownMs: number;
}

export const DEFAULT_AUTO_POLICY: AutoPolicy = {
  highWatermark: 0.85,
  lowWatermark: 0.3,
  // Up fast, down slow: being one tier too small is felt by the user on every
  // keystroke, while being one tier too large costs the operator some headroom
  // for a few minutes. The asymmetry is the point.
  hotSamples: 3,
  coldSamples: 10,
  cooldownMs: 5 * 60_000,
};

export interface AutoDecision {
  /** The tier to move to, or null to stay put. */
  next: EnvironmentTier | null;
  state: AutoState;
  /** Why, in words, for the log and for the user's own environment panel. */
  reason: string | null;
}

/**
 * Whether this user's environment should change size.
 *
 * Pure, and deliberately dull: two counters, two thresholds and a cooldown.
 * Anything cleverer here would be a controller nobody can predict, and an
 * environment that resizes for reasons its owner cannot see is worse than one
 * that is occasionally a size too small.
 */
export function decideAutoTier(input: {
  tiers: EnvironmentTier[];
  current: EnvironmentTier;
  sample: ResourceSample | null;
  state: AutoState;
  now: number;
  policy?: AutoPolicy;
}): AutoDecision {
  const policy = input.policy || DEFAULT_AUTO_POLICY;
  const { tiers, current, sample, now } = input;

  // No reading is not a quiet reading. A cluster without metrics-server, or a
  // container the engine will not report on, must leave the tier alone rather
  // than look like an idle one and be shrunk out from under its owner.
  if (!sample) {
    return { next: null, state: input.state, reason: null };
  }

  const cpuLimit = Number.parseFloat(current.cpus);
  const memoryLimit = parseSize(current.memory);
  const cpuLoad = Number.isFinite(cpuLimit) && cpuLimit > 0 ? sample.cpuCores / cpuLimit : 0;
  const memoryLoad = memoryLimit ? sample.memoryBytes / memoryLimit : 0;
  const load = Math.max(cpuLoad, memoryLoad);

  const hot = load >= policy.highWatermark ? input.state.hot + 1 : 0;
  const cold = load <= policy.lowWatermark ? input.state.cold + 1 : 0;
  const state: AutoState = { hot, cold, lastChangeAt: input.state.lastChangeAt };

  const index = tiers.findIndex((tier) => tier.id === current.id);
  if (index < 0) {
    return { next: null, state, reason: null };
  }

  if (now - state.lastChangeAt < policy.cooldownMs) {
    return { next: null, state, reason: null };
  }

  if (hot >= policy.hotSamples && index < tiers.length - 1) {
    const next = tiers[index + 1];
    return {
      next,
      state: { hot: 0, cold: 0, lastChangeAt: now },
      reason: `${Math.round(load * 100)}% of ${current.label} for ${hot} samples`,
    };
  }

  if (cold >= policy.coldSamples && index > 0) {
    const next = tiers[index - 1];
    return {
      next,
      state: { hot: 0, cold: 0, lastChangeAt: now },
      reason: `${Math.round(load * 100)}% of ${current.label} for ${cold} samples`,
    };
  }

  return { next: null, state, reason: null };
}
