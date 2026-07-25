/**
 * Parsers for the two git outputs the workspace panel reads.
 *
 * Pure and shared so they can be tested without a repository, and so the shape
 * the browser renders is decided once. `git`'s porcelain formats are stable by
 * contract — that is what "porcelain" means — which is why they are parsed
 * rather than scraped from human-readable output that changes between versions.
 */

import type { DiffHunk, FileDiff } from './chat-events.js';

export type GitChangeKind = 'create' | 'update' | 'delete' | 'rename';

export interface GitChange {
  path: string;
  /** Set for renames and copies: where the file came from. */
  oldPath?: string;
  kind: GitChangeKind;
  /** The index (left) status letter, as git reports it. Space means unchanged. */
  index: string;
  /** The worktree (right) status letter. */
  worktree: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
}

export interface GitStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** True for a repository with no commits yet, where HEAD names nothing. */
  detached: boolean;
  changes: GitChange[];
}

const EMPTY_STATUS: GitStatus = {
  branch: null,
  upstream: null,
  ahead: 0,
  behind: 0,
  detached: false,
  changes: [],
};

/**
 * Map a two-letter porcelain code onto the four kinds the diff UI already
 * knows. Ordering matters: a file can be added in the index and deleted in the
 * worktree, and what the user needs to see is the deletion.
 */
function kindOf(index: string, worktree: string): GitChangeKind {
  if (index === 'R' || worktree === 'R') return 'rename';
  if (index === 'D' || worktree === 'D') return 'delete';
  if (index === 'A' || index === '?' || worktree === '?') return 'create';
  return 'update';
}

/**
 * Parse `git status --porcelain=v1 -z --branch`.
 *
 * NUL-separated rather than line-separated on purpose: a path may contain a
 * newline, and the line-based format answers that by quoting and C-escaping the
 * path, which would then have to be un-escaped correctly here. `-z` sidesteps
 * the whole problem by never quoting at all.
 */
export function parseGitStatus(raw: string): GitStatus {
  if (!raw) return { ...EMPTY_STATUS, changes: [] };

  // A trailing NUL leaves an empty final field that is not a record.
  const fields = raw.split('\0');
  if (fields.length > 0 && fields[fields.length - 1] === '') fields.pop();

  const status: GitStatus = { ...EMPTY_STATUS, changes: [] };

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field) continue;

    if (field.startsWith('## ')) {
      Object.assign(status, parseBranchHeader(field.slice(3)));
      continue;
    }

    if (field.length < 3) continue;
    const index = field[0];
    const worktree = field[1];
    const path = field.slice(3);

    const change: GitChange = {
      path,
      kind: kindOf(index, worktree),
      index,
      worktree,
      staged: index !== ' ' && index !== '?',
      unstaged: worktree !== ' ' && worktree !== '?',
      untracked: index === '?' || worktree === '?',
      // Both sides lettered, or either side U: git's own "unmerged" set.
      conflicted:
        index === 'U' ||
        worktree === 'U' ||
        (index === 'A' && worktree === 'A') ||
        (index === 'D' && worktree === 'D'),
    };

    // A rename or copy is two paths: the record above holds the new one and the
    // next field holds the old one. Consuming it here is what stops the source
    // path being read as a change of its own.
    if (index === 'R' || index === 'C' || worktree === 'R' || worktree === 'C') {
      const from = fields[i + 1];
      if (from !== undefined) {
        change.oldPath = from;
        i += 1;
      }
    }

    status.changes.push(change);
  }

  return status;
}

function parseBranchHeader(header: string): Partial<GitStatus> {
  // "## main...origin/main [ahead 1, behind 2]", or "## HEAD (no branch)", or
  // "## No commits yet on main".
  if (header.startsWith('HEAD (no branch)')) {
    return { branch: null, detached: true };
  }

  const noCommits = header.match(/^No commits yet on (.+)$/);
  if (noCommits) {
    return { branch: noCommits[1].trim(), detached: false };
  }

  const result: Partial<GitStatus> = { detached: false };

  const tracking = header.match(/\[(.+)\]\s*$/);
  if (tracking) {
    const ahead = tracking[1].match(/ahead (\d+)/);
    const behind = tracking[1].match(/behind (\d+)/);
    result.ahead = ahead ? Number(ahead[1]) : 0;
    result.behind = behind ? Number(behind[1]) : 0;
    header = header.slice(0, tracking.index).trim();
  }

  const split = header.indexOf('...');
  if (split >= 0) {
    result.branch = header.slice(0, split).trim();
    result.upstream = header.slice(split + 3).trim() || null;
  } else {
    result.branch = header.trim();
    result.upstream = null;
  }

  return result;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse a unified diff into the `FileDiff` shape the chat surface already
 * renders, so the workspace panel reuses `DiffView` rather than growing a
 * second, subtly different diff renderer beside it.
 *
 * Written against `git diff`'s output specifically: the `diff --git` header is
 * the record separator, and the `a/` `b/` prefixes are assumed because every
 * call site passes no `--no-prefix`. Paths come from the header rather than the
 * `---`/`+++` lines so a create or delete (where one side is `/dev/null`) still
 * names the file.
 */
export function parseUnifiedDiff(raw: string): FileDiff[] {
  if (!raw) return [];

  const lines = raw.split('\n');
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  let hunk: DiffHunk | null = null;

  const closeHunk = (): void => {
    if (current && hunk) current.hunks.push(hunk);
    hunk = null;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      closeHunk();
      current = startFile(line);
      if (current) files.push(current);
      continue;
    }

    if (!current) continue;

    if (hunk === null) {
      // Still in the header block for this file.
      if (line.startsWith('new file mode')) {
        current.kind = 'create';
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        current.kind = 'delete';
        continue;
      }
      if (line.startsWith('rename from ')) {
        current.kind = 'rename';
        current.oldPath = line.slice('rename from '.length);
        continue;
      }
      if (line.startsWith('rename to ')) {
        current.kind = 'rename';
        current.path = line.slice('rename to '.length);
        continue;
      }
      if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
        current.binary = true;
        continue;
      }
    }

    const header = HUNK_HEADER.exec(line);
    if (header) {
      closeHunk();
      hunk = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      continue;
    }

    if (hunk === null) continue;

    // "\ No newline at end of file" belongs to the hunk but is not a change;
    // it is kept so the body round-trips, and counted as neither side.
    if (line.startsWith('\\')) {
      hunk.lines.push(line);
      continue;
    }

    if (line.startsWith('+')) {
      current.added += 1;
    } else if (line.startsWith('-')) {
      current.removed += 1;
    } else if (line !== '' && !line.startsWith(' ')) {
      // Anything else at this point is the start of the next file's header in
      // a malformed stream; stop attributing it to this hunk.
      continue;
    }
    hunk.lines.push(line);
  }

  closeHunk();
  return files;
}

function startFile(header: string): FileDiff | null {
  // `diff --git a/<old> b/<new>`. Paths with spaces make this ambiguous in
  // general, which is why the `---`/`+++` lines exist — but git only omits the
  // prefixes when asked to, so splitting on " b/" once is exact for our calls.
  const body = header.slice('diff --git '.length);
  const split = body.indexOf(' b/');
  if (split < 0) return null;

  const oldPath = stripPrefix(body.slice(0, split));
  const newPath = stripPrefix(body.slice(split + 1));

  return {
    path: newPath || oldPath,
    kind: 'update',
    hunks: [],
    added: 0,
    removed: 0,
    ...(oldPath && newPath && oldPath !== newPath ? { oldPath } : {}),
  };
}

function stripPrefix(value: string): string {
  return value.replace(/^[ab]\//, '');
}
