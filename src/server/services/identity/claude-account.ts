import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AccountLimits, AccountLimitWindow } from '../../../shared/chat-events.js';

/**
 * Where a Claude account stands, read from the CLI's own configuration file.
 *
 * **The rule this file exists to keep.** This app reads a CLI's *config* file
 * and never a credentials file. `~/.claude.json` is configuration: it holds a
 * cached utilization percentage and a rate-limit tier, which is what a status
 * readout is for. `~/.claude/.credentials.json` and `~/.codex/auth.json` hold
 * access and refresh tokens, and nothing on a status panel is worth teaching
 * this server to open them — which is also why Codex's plan name comes from
 * `account/rateLimits/read` over the protocol rather than from the id_token
 * sitting next to its tokens on disk.
 *
 * Even inside the config file the read is narrow. `oauthAccount` carries an
 * email address, a display name, an organisation name and three uuids beside
 * the tier, and none of them are returned: the server runs as one OS user
 * signed in to one Claude account, while the browser may have several people
 * on it, so anything identifying would be telling one user who another one is.
 * Tier and percentages only.
 *
 * It is a fallback, not the source. What a running conversation reports on its
 * own `rate_limit_event` is a fact about *that* work on *that* account; this is
 * a cache the CLI happened to leave behind, and the panel labels it as such
 * with the time it was written.
 *
 * Everything here is best-effort against an undocumented private format —
 * `cachedUsageUtilization` is internal to Claude Code and can be renamed in any
 * release — so every field is optional and any surprise returns null rather
 * than a number.
 */

/**
 * How old a cached reading may be before it is dropped rather than shown.
 *
 * Five hours because that is the shortest window Claude meters on: past it, a
 * cached percentage describes a window that has since refilled. The copy on the
 * machine this was written against was 26.7 hours old, and "46% used" from
 * yesterday presented as today's figure is exactly the confidently-wrong
 * readout this replaced (#137).
 */
const STALE_AFTER_MS = 5 * 60 * 60 * 1000;

export interface CachedClaudeAccount extends AccountLimits {
  /** When the CLI wrote the reading, as ISO. Rendered, never omitted. */
  asOf: string;
}

function configPath(): string {
  // The same override the CLI itself honours, so a server pointed at a
  // non-default config directory reads the file that is actually in use.
  const dir = process.env.CLAUDE_CONFIG_DIR || os.homedir();
  return path.join(dir, '.claude.json');
}

/**
 * `default_claude_max_20x` is not a thing to show a person.
 *
 * Only the shape is touched — the words are Anthropic's own and are left
 * alone — because inventing a display name ("Max 20×") would be this app
 * deciding what someone's plan is called again.
 */
function tierName(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  return raw.replace(/^default_/, '').replace(/_/g, ' ');
}

export function readCachedClaudeAccount(now = Date.now()): CachedClaudeAccount | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath(), 'utf8')) as Record<string, unknown>;
  } catch {
    // Missing, unreadable or not JSON. All three mean the same thing here:
    // nobody has said, which the panel states in words.
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const cache = parsed.cachedUsageUtilization as Record<string, unknown> | undefined;
  const fetchedAtMs = Number(cache?.fetchedAtMs);
  if (!Number.isFinite(fetchedAtMs) || fetchedAtMs <= 0) return null;
  if (now - fetchedAtMs > STALE_AFTER_MS) return null;

  const oauth = parsed.oauthAccount as Record<string, unknown> | undefined;
  const planName = tierName(oauth?.organizationRateLimitTier) ?? tierName(oauth?.organizationType);

  const utilization = cache?.utilization as Record<string, unknown> | undefined;
  const windows: AccountLimitWindow[] = [];
  for (const [kind, value] of Object.entries(utilization || {})) {
    const entry = value as Record<string, unknown> | null;
    if (!entry || typeof entry !== 'object') continue;
    // `typeof`, not `Number()`. The file states `utilization: null` on blocks
    // it has no reading for — `extra_usage: {is_enabled: false, utilization:
    // null, …}` on the machine this was written against — and `Number(null)` is
    // `0`, which sails through every finite-and-in-range guard below and
    // arrives on screen as a 0% row with an empty meter. "Nobody said" rendered
    // as "nothing spent" is the one bug this whole file exists to remove, and a
    // coercion is not a reading (#137).
    if (typeof entry.utilization !== 'number') continue;
    // Stored as an integer percentage here, while the protocol event states a
    // fraction. The event's units are the ones the shared type means.
    const percent = entry.utilization;
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) continue;
    const resetsAt = typeof entry.resets_at === 'string' ? new Date(entry.resets_at) : null;
    // A window that has already refilled is not a reading, it is a leftover.
    // This is the guard that does the real work; the age ceiling above only
    // catches a file so old that even its reset times are meaningless.
    if (!resetsAt || Number.isNaN(resetsAt.getTime()) || resetsAt.getTime() <= now) continue;
    windows.push({ kind, utilization: percent / 100, resetsAt: resetsAt.toISOString() });
  }

  if (!planName && windows.length === 0) return null;

  return {
    ...(planName ? { planName } : {}),
    windows,
    asOf: new Date(fetchedAtMs).toISOString(),
  };
}
