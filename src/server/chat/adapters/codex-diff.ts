import type { DiffHunk, FileDiff } from '../../../shared/chat-events.js';
import { str, record } from './codex-utils.js';

// --------------------------------------------------------------- diffs

/**
 * Parse a unified diff body into hunks.
 *
 * Only the `@@ ... @@` header and the lines between headers are meaningful;
 * `--- a/x` / `+++ b/x` file headers (when present) sit before the first
 * header and are skipped because `current` is still null at that point.
 */
function parseUnifiedDiff(text: string): { hunks: DiffHunk[]; added: number; removed: number } {
  const hunks: DiffHunk[] = [];
  let added = 0;
  let removed = 0;
  let current: DiffHunk | null = null;
  const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

  for (const line of text.split('\n')) {
    const match = header.exec(line);
    if (match) {
      current = {
        oldStart: Number(match[1]),
        oldLines: match[2] !== undefined ? Number(match[2]) : 1,
        newStart: Number(match[3]),
        newLines: match[4] !== undefined ? Number(match[4]) : 1,
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    current.lines.push(line);
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }

  return { hunks, added, removed };
}

/** A whole file rendered as one hunk, for approvals where codex sends raw content instead of a diff. */
function wholeFileHunk(content: string, sign: '+' | '-'): DiffHunk {
  const lines = content.length ? content.split('\n') : [];
  // The file's own trailing newline is a terminator, not an extra line.
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const body = lines.map((line) => `${sign}${line}`);
  return sign === '+'
    ? { oldStart: 0, oldLines: 0, newStart: 1, newLines: body.length, lines: body }
    : { oldStart: 1, oldLines: body.length, newStart: 0, newLines: 0, lines: body };
}

/**
 * `ApplyPatchApprovalParams.fileChanges[path]` -> FileDiff.
 *
 * This is the *approval-time* shape (`FileChange`), distinct from the
 * *item* shape below (`FileUpdateChange`): `add`/`delete` here carry whole
 * file content, not a diff, because the user is being asked to approve a
 * patch that has not run yet.
 */
export function fileChangeToFileDiff(path: string, change: Record<string, unknown>): FileDiff {
  const type = str(change.type);
  if (type === 'add') {
    const hunk = wholeFileHunk(str(change.content) || '', '+');
    return { path, kind: 'create', hunks: [hunk], added: hunk.lines.length, removed: 0 };
  }
  if (type === 'delete') {
    const hunk = wholeFileHunk(str(change.content) || '', '-');
    return { path, kind: 'delete', hunks: [hunk], added: 0, removed: hunk.lines.length };
  }
  const movePath = str(change.move_path);
  const { hunks, added, removed } = parseUnifiedDiff(str(change.unified_diff) || '');
  return {
    path: movePath || path,
    oldPath: movePath ? path : undefined,
    kind: movePath ? 'rename' : 'update',
    hunks,
    added,
    removed,
  };
}

/**
 * A `fileChange` item's own `changes[]` -> FileDiff.
 *
 * Unlike the approval shape above, every `FileUpdateChange` (add, delete or
 * update) carries a `diff` string, so one parse path covers all three kinds.
 */
export function fileUpdateChangeToFileDiff(change: Record<string, unknown>): FileDiff {
  const path = str(change.path) || '';
  const kind = record(change.kind);
  const kindType = str(kind.type);
  const movePath = kindType === 'update' ? str(kind.move_path) || '' : '';
  const { hunks, added, removed } = parseUnifiedDiff(str(change.diff) || '');
  return {
    path: movePath || path,
    oldPath: movePath ? path : undefined,
    kind: kindType === 'add' ? 'create' : kindType === 'delete' ? 'delete' : movePath ? 'rename' : 'update',
    hunks,
    added,
    removed,
  };
}

export function fileChangeTitle(changes: unknown[]): string {
  if (changes.length === 1) return str(record(changes[0]).path) || 'a file';
  return `${changes.length} files`;
}

