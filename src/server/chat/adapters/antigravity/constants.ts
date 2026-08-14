import type { ToolKind } from '../../../../shared/chat-events.js';

/**
 * How long a single `--print` run is allowed to take.
 *
 * agy's own default is `5m0s`, which is a sensible ceiling for a scripted
 * one-shot and the wrong one for a conversation: a turn that reads a repository
 * and edits a dozen files runs past it, and the user would see the turn cut off
 * with no explanation anybody could act on. A day is effectively "no ceiling",
 * and the ceiling that matters is the one the user holds — `interrupt()` kills
 * the child, and it is offered because this runtime has nothing subtler.
 *
 * Verified to parse: `--print-timeout 24h` reached model validation, which only
 * runs after the flags are read.
 */
export const PRINT_TIMEOUT = '24h';

/**
 * agy's own effort words, and the only three it will accept.
 *
 * Not transcribed from `--help` alone — confirmed by handing it a word it does
 * not have: `--effort banana` answered `invalid --effort "banana" (valid: low,
 * medium, high)`. That is agy enumerating its own vocabulary while refusing one,
 * which is the same evidence the pi adapter's ladder rests on.
 */
export const EFFORT_LEVELS = ['low', 'medium', 'high'] as const;

export const EFFORT_DESCRIPTIONS: Record<string, string> = {
  low: 'The least thinking agy offers.',
  medium: 'The middle of the three.',
  high: 'The most agy will spend on thinking.',
};

/**
 * agy's file-mutating tools, whose names the shared classifier reads as `other`.
 *
 * `write_to_file` and `notebook_edit` already land on `edit` through the generic
 * patterns; these three do not — "replace_file_content" contains none of the
 * words that classifier looks for. A fact about this CLI's tool vocabulary, so
 * it is stated here rather than by widening a pattern every other runtime
 * shares.
 */
export const TOOL_KIND_OVERRIDES: Record<string, ToolKind> = {
  replace_file_content: 'edit',
  multi_replace_file_content: 'edit',
  sed_file: 'edit',
};

/**
 * The parameter each tool names its target file with, so a card can say what
 * was touched and the "files changed" affordance has something to point at.
 *
 * Only the keys observed on the wire, and only where the parameter really is a
 * path: `run_command` reports `CommandLine`, which is not one.
 */
export const PATH_PARAMETERS = ['TargetFile', 'AbsolutePath', 'DirectoryPath', 'FilePath', 'Path'];
