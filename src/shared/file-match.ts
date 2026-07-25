/**
 * Ranking for the composer's `@` file picker.
 *
 * Shared rather than server-only so it can be tested without a repository on
 * disk, and so the browser can re-rank a cached list without another round trip.
 *
 * The rule that shapes everything below: **people type the filename**. Someone
 * reaching for `src/server/chat/session.ts` types `session`, not `srvchsess`,
 * so a hit on the basename has to beat a hit anywhere else in the path, and an
 * exact basename has to beat a partial one — otherwise typing `session` puts
 * `session.test.ts`, `session-store.ts` and `old/session.ts` above the file
 * that is literally called that.
 *
 * Subsequence matching is the fallback, not the default. It is what makes
 * `scs` find `src/client/shell` at all, but it matches almost everything if it
 * is allowed to compete on equal terms, so it scores below every literal hit.
 */

export interface FileMatch {
  /** Path relative to the working directory, in POSIX separators. */
  path: string;
  score: number;
}

/** Above every subsequence hit, so a literal match can never lose to a fuzzy one. */
const LITERAL_FLOOR = 1000;

/**
 * Score one path against a query. Higher is better; 0 means "no match".
 *
 * An empty query matches everything with an equal score, which is what makes
 * the picker useful the instant `@` is typed — before that it had nothing to
 * show until the user had guessed at a prefix.
 */
export function scoreFilePath(candidate: string, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;

  const full = candidate.toLowerCase();
  const cut = full.lastIndexOf('/');
  const base = cut >= 0 ? full.slice(cut + 1) : full;

  // Shorter paths win among equals: a query is a description of one file, and
  // the shallower candidate is nearly always the one being described.
  const brevity = Math.max(0, 200 - candidate.length);

  if (base === q) return LITERAL_FLOOR + 5000 + brevity;
  if (base.startsWith(q)) return LITERAL_FLOOR + 4000 + brevity;

  // A query with a separator in it is a path fragment, not a name: `chat/ses`
  // should find `src/server/chat/session.ts` and is not expected to appear in
  // any basename at all.
  if (q.includes('/') && full.includes(q)) return LITERAL_FLOOR + 3500 + brevity;

  if (base.includes(q)) return LITERAL_FLOOR + 3000 + brevity;
  if (full.includes(q)) return LITERAL_FLOOR + 2000 + brevity;

  // Subsequence, preferring the one that stays inside the basename.
  const inBase = subsequenceScore(base, q);
  if (inBase > 0) return inBase + 500 + brevity;
  const inFull = subsequenceScore(full, q);
  if (inFull > 0) return inFull + brevity;

  return 0;
}

/**
 * How well `query` threads through `text` as a subsequence, or 0.
 *
 * Contiguous runs and matches that start a segment score higher, so `scs`
 * prefers `src/client/shell` (three segment starts) over a path that merely
 * happens to contain those letters in that order.
 */
function subsequenceScore(text: string, query: string): number {
  let score = 0;
  let at = 0;
  let previous = -2;

  for (const character of query) {
    const found = text.indexOf(character, at);
    if (found === -1) return 0;

    if (found === previous + 1) score += 8;
    if (found === 0 || text[found - 1] === '/' || text[found - 1] === '-' || text[found - 1] === '_' || text[found - 1] === '.') {
      score += 6;
    }
    previous = found;
    at = found + 1;
  }

  return score + 1;
}

/** The best `limit` matches for a query, best first. */
export function rankFilePaths(paths: string[], query: string, limit = 40): FileMatch[] {
  const matches: FileMatch[] = [];
  for (const candidate of paths) {
    const score = scoreFilePath(candidate, query);
    if (score > 0) matches.push({ path: candidate, score });
  }

  matches.sort((a, b) => (b.score - a.score) || a.path.localeCompare(b.path));
  return matches.slice(0, limit);
}

/**
 * The `@token` the caret is sitting in, or null.
 *
 * Anchored to a word boundary so an email address and a decorator do not open a
 * file picker, and stopped at whitespace so the popup closes once the mention
 * is finished. Returns the span as well as the text, because inserting the
 * chosen path means replacing exactly what was typed.
 */
export function mentionAtCaret(
  text: string,
  caret: number,
): { start: number; end: number; query: string } | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf('@');
  if (at === -1) return null;

  // Only at the start of a word: `user@host` and `list@2` are not mentions.
  const before = at === 0 ? '' : upto[at - 1];
  if (before && !/\s|[([{<"']/.test(before)) return null;

  const query = upto.slice(at + 1);
  // Whitespace ends it. A path with a space in it cannot be completed this way,
  // which is the same bargain every editor's quick-open makes.
  if (/\s/.test(query)) return null;

  return { start: at, end: caret, query };
}
