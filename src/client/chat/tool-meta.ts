/**
 * What a tool call looks like, in one place.
 *
 * Lifted out of ToolCallCard when the trace moved to the rail. The same call is
 * now drawn twice — as a row on the activity timeline and as the expanded card
 * underneath it — and a target string that two files each work out for
 * themselves is a target string that will eventually disagree with itself.
 *
 * Pure and DOM-free on purpose: the timeline projection (activity.ts) and the
 * turn summaries (turns.ts) both import from here, and both are unit-tested
 * without React.
 */

import { ToolBlock, ToolKind, ToolStatus } from '../../shared/chat-events.js';

/** Glyph per coarse tool category. `other` is always acceptable. */
export const KIND_ICON: Record<ToolKind, string> = {
  read: 'file-text',
  edit: 'pencil',
  delete: 'trash-2',
  move: 'arrow-right',
  search: 'search',
  execute: 'terminal',
  think: 'brain',
  fetch: 'download',
  task: 'cpu',
  todo: 'list-todo',
  other: 'wrench',
};

export interface StatusStyle {
  icon: string;
  label: string;
  color: string;
  spin?: boolean;
  /** Badge variant, when the outcome is worth a word as well as a glyph. */
  badge?: 'destructive' | 'warning' | 'outline';
}

/**
 * Status is carried by glyph *and* word, never by colour alone.
 *
 * `denied` and `failed` are different outcomes — "you refused this" against
 * "this broke" — and someone who cannot separate amber from red still has to be
 * able to tell them apart.
 */
export const TOOL_STATUS: Record<ToolStatus, StatusStyle> = {
  pending: { icon: 'loader-circle', label: 'Pending', color: 'var(--muted-foreground)', spin: true },
  running: { icon: 'loader-circle', label: 'Running', color: 'var(--info)', spin: true },
  completed: { icon: 'check', label: 'Completed', color: 'var(--success)' },
  failed: { icon: 'circle-x', label: 'Failed', color: 'var(--destructive)', badge: 'destructive' },
  denied: { icon: 'shield', label: 'Denied', color: 'var(--warning)', badge: 'warning' },
  canceled: { icon: 'x', label: 'Canceled', color: 'var(--muted-foreground)', badge: 'outline' },
};

/** Output lines shown before a block clamps itself. */
export const OUTPUT_LINES = 20;
/** Hard ceiling on one rendered line, so a minified bundle cannot become a row. */
export const LINE_CHARS = 2000;
/** Hard ceiling on pretty-printed arguments. */
export const INPUT_CHARS = 20000;

// --------------------------------------------------------------------------
// Target extraction.
//
// Every runtime names its arguments differently, so the closed row asks each
// kind for the field that identifies what it acted on and takes the first one
// present. An unmapped shape falls back to any string field, then to the
// locations the adapter reported — a row with no target at all is the last
// resort, not the first.
// --------------------------------------------------------------------------

export const PATH_KEYS = [
  'file_path',
  'filePath',
  'path',
  'file',
  'filename',
  'abs_path',
  'target_file',
];

export const COMMAND_KEYS = ['command', 'cmd', 'script', 'shell_command', 'commandLine'];

export const SUMMARY_KEYS: Record<ToolKind, string[]> = {
  read: PATH_KEYS,
  edit: PATH_KEYS,
  delete: PATH_KEYS,
  move: ['destination', 'dest', 'new_path', 'newPath', ...PATH_KEYS],
  search: ['pattern', 'query', 'q', 'regex', 'glob', 'search', ...PATH_KEYS],
  execute: COMMAND_KEYS,
  think: ['thought', 'text', 'reasoning'],
  fetch: ['url', 'uri', 'href', 'link'],
  task: ['description', 'prompt', 'task', 'subagent_type'],
  todo: ['todos', 'items', 'plan'],
  other: [...PATH_KEYS, ...COMMAND_KEYS, 'url', 'query', 'description'],
};

export function summarize(block: ToolBlock): string {
  const direct = summarizeInput(block);
  if (direct) return shorten(direct, 140);
  const location = block.locations && block.locations[0];
  return location ? shorten(location, 140) : '';
}

function summarizeInput(block: ToolBlock): string {
  if (block.input === undefined) {
    return block.inputPartial === undefined ? '' : partialTarget(block.inputPartial);
  }
  if (typeof block.input === 'string') return oneLine(block.input);

  const record = asRecord(block.input);
  if (!record) return '';

  if (block.toolKind === 'move') {
    const from = firstString(record, ['source', 'src', 'old_path', 'oldPath', 'from', ...PATH_KEYS]);
    const to = firstString(record, ['destination', 'dest', 'new_path', 'newPath', 'to']);
    if (from && to) return `${from} → ${to}`;
  }

  if (block.toolKind === 'todo') {
    const list = record.todos || record.items || record.plan;
    if (Array.isArray(list)) return `${list.length} item${list.length === 1 ? '' : 's'}`;
  }

  const preferred = firstString(record, SUMMARY_KEYS[block.toolKind] || []);
  if (preferred) return oneLine(preferred);

  // Nothing recognised: any string argument still says more than the tool name.
  for (const value of Object.values(record)) {
    if (typeof value === 'string' && value.trim()) return oneLine(value);
  }
  return '';
}

/**
 * Pull a target out of half-arrived JSON.
 *
 * Matches a completed `"key": "value"` pair textually rather than parsing,
 * because the fragment is by definition not valid JSON yet. When even that is
 * not there the row says the arguments are still arriving, which is true and is
 * what the user needs to know.
 */
export function partialTarget(partial: string): string {
  const keys = [...COMMAND_KEYS, ...PATH_KEYS, 'url', 'pattern', 'query', 'description', 'prompt'];
  for (const key of keys) {
    const match = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(partial);
    if (match) return oneLine(match[1].replace(/\\(["\\/])/g, '$1'));
  }
  return 'receiving arguments…';
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function firstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
    if (Array.isArray(value) && value.every((v) => typeof v === 'string') && value.length) {
      return value.join(' ');
    }
  }
  return '';
}

export function omit(record: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!keys.includes(key)) out[key] = value;
  }
  return out;
}

export function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    // Arguments arrive as JSON, so a cycle should be impossible — but a card
    // that throws would take the whole transcript down with it.
    return String(value);
  }
}

export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Keep the tail of a path and the head of prose: both hold the meaning. */
export function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  if (text.includes('/') && !text.includes(' ')) return `…${text.slice(text.length - max + 1)}`;
  return `${text.slice(0, max - 1)}…`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/** Short form for token counts, which routinely run to six figures. */
export function compactCount(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

/** `+12 −4` for a set of diffs, or '' when there are none. */
export function diffTally(diffs: { added: number; removed: number }[] | undefined): string {
  if (!diffs || !diffs.length) return '';
  let added = 0;
  let removed = 0;
  for (const diff of diffs) {
    added += diff.added || 0;
    removed += diff.removed || 0;
  }
  if (!added && !removed) return '';
  // U+2212 rather than a hyphen: it lines up with the plus at the same width.
  return `+${added} −${removed}`;
}
