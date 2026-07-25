import * as React from 'react';
import { FileDiff, ToolBlock, ToolKind, ToolStatus } from '../../../shared/chat-events.js';
import { Badge, BadgeVariant } from '../../ui/relay/Badge.js';
import { Icon } from '../../ui/relay/Icon.js';
import { CodeBlock } from './Markdown.js';
import { DiffView } from './DiffView.js';

/**
 * One tool call in the transcript: a single collapsed row that expands.
 *
 * A turn can contain dozens of these, so the closed state has to answer "what
 * did it do, to what, and did it work" in one line — status glyph, kind icon,
 * title, and the one argument that identifies the target. Everything else is
 * behind the disclosure, because a transcript where every tool call is expanded
 * is a transcript nobody scrolls.
 *
 * Status is carried by the glyph and by text, never by colour alone: `denied`
 * and `failed` are different outcomes and a user who cannot separate amber from
 * red still has to be able to tell them apart.
 */

export interface ToolCallCardProps {
  block: ToolBlock;
  defaultOpen?: boolean;
  onApplyHunk?: (diff: FileDiff, hunkIndex: number) => void;
  onRevertHunk?: (diff: FileDiff, hunkIndex: number) => void;
}

/** Output lines shown before the block clamps itself. */
const OUTPUT_LINES = 20;
/** Hard ceiling on one rendered line, so a minified bundle cannot become a row. */
const LINE_CHARS = 2000;
/** Hard ceiling on pretty-printed arguments. */
const INPUT_CHARS = 20000;

const KIND_ICON: Record<ToolKind, string> = {
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

interface StatusStyle {
  icon: string;
  label: string;
  color: string;
  spin?: boolean;
  badge?: BadgeVariant;
}

const STATUS: Record<ToolStatus, StatusStyle> = {
  pending: { icon: 'loader-circle', label: 'Pending', color: 'var(--muted-foreground)', spin: true },
  running: { icon: 'loader-circle', label: 'Running', color: 'var(--info)', spin: true },
  completed: { icon: 'check', label: 'Completed', color: 'var(--success)' },
  failed: { icon: 'circle-x', label: 'Failed', color: 'var(--destructive)', badge: 'destructive' },
  denied: { icon: 'shield', label: 'Denied', color: 'var(--warning)', badge: 'warning' },
  canceled: { icon: 'x', label: 'Canceled', color: 'var(--muted-foreground)', badge: 'outline' },
};

export function ToolCallCard({
  block,
  defaultOpen,
  onApplyHunk,
  onRevertHunk,
}: ToolCallCardProps) {
  const [open, setOpen] = React.useState(Boolean(defaultOpen));
  const bodyId = React.useId();

  const status = STATUS[block.status] || STATUS.pending;
  const active = block.status === 'pending' || block.status === 'running';
  const summary = React.useMemo(() => summarize(block), [block]);
  const hasDiffs = Boolean(block.diffs && block.diffs.length);

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        background: 'var(--card)',
        margin: '0 0 8px',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={bodyId}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          minHeight: 34,
          padding: '4px 8px',
          background: 'transparent',
          border: 0,
          color: 'var(--foreground)',
          font: 'inherit',
          fontFamily: 'var(--font-sans)',
          fontSize: 'var(--text-sm)',
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            display: 'inline-flex',
            flex: '0 0 auto',
            color: status.color,
            animation: status.spin ? 'relay-spin 900ms linear infinite' : undefined,
          }}
        >
          <Icon name={status.icon} size={13} />
        </span>

        {/* The status word is what makes the glyph unambiguous; it is announced
            rather than drawn, and re-announced while the call is still open. */}
        <span style={srOnly} aria-live={active ? 'polite' : 'off'}>
          {status.label}
        </span>

        <Icon
          name={KIND_ICON[block.toolKind] || 'wrench'}
          size={13}
          style={{ color: 'var(--muted-foreground)' }}
        />

        <span
          style={{
            flex: '0 1 auto',
            minWidth: 0,
            fontWeight: 'var(--font-medium)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {block.title || block.name || 'tool'}
        </span>

        {summary ? (
          <span
            style={{
              flex: '1 1 auto',
              minWidth: 0,
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-xs)',
              color: 'var(--muted-foreground)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {summary}
          </span>
        ) : (
          <span style={{ flex: '1 1 auto' }} />
        )}

        {status.badge ? <Badge variant={status.badge}>{status.label.toLowerCase()}</Badge> : null}
        {hasDiffs ? (
          <Icon name="file-diff" size={12} style={{ color: 'var(--muted-foreground)' }} />
        ) : null}
        {block.durationMs !== undefined ? (
          <span
            style={{
              flex: '0 0 auto',
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-2xs)',
              color: 'var(--muted-foreground)',
            }}
          >
            {formatDuration(block.durationMs)}
          </span>
        ) : null}
        <Icon
          name={open ? 'chevron-down' : 'chevron-right'}
          size={13}
          style={{ color: 'var(--muted-foreground)' }}
        />
      </button>

      {open ? (
        <div id={bodyId} style={{ borderTop: '1px solid var(--border)', padding: '8px 8px 0' }}>
          {block.error ? (
            <Section label="error">
              <p
                style={{
                  margin: '0 0 10px',
                  padding: '6px 8px',
                  border: '1px solid color-mix(in oklab, var(--destructive) 38%, transparent)',
                  background: 'color-mix(in oklab, var(--destructive) 10%, transparent)',
                  color: 'var(--destructive)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 'var(--text-xs)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {block.error}
              </p>
            </Section>
          ) : null}

          <InputSection block={block} />

          {block.output ? (
            <Section label="output">
              <Output text={block.output} />
            </Section>
          ) : null}

          {hasDiffs ? (
            <Section label="changes">
              <div style={{ margin: '0 0 10px' }}>
                <DiffView
                  diffs={block.diffs as FileDiff[]}
                  onApplyHunk={onApplyHunk}
                  onRevertHunk={onRevertHunk}
                />
              </div>
            </Section>
          ) : null}

          {!block.error && !block.output && !hasDiffs && block.input === undefined && !block.inputPartial ? (
            <p
              style={{
                margin: '0 0 10px',
                fontSize: 'var(--text-xs)',
                color: 'var(--muted-foreground)',
              }}
            >
              Nothing reported for this call.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section>
      <h4
        style={{
          margin: '0 0 4px',
          fontSize: 'var(--text-2xs)',
          fontWeight: 'var(--font-medium)',
          textTransform: 'uppercase',
          letterSpacing: 'var(--tracking-caps)',
          color: 'var(--muted-foreground)',
        }}
      >
        {label}
      </h4>
      {children}
    </section>
  );
}

function InputSection({ block }: { block: ToolBlock }) {
  // Arguments stream in as JSON fragments that do not parse until the block
  // closes. Showing the fragment as an incomplete fence is honest and keeps the
  // shape of what is arriving, where a parse attempt would only ever throw.
  if (block.input === undefined && block.inputPartial !== undefined) {
    return (
      <Section label="arguments">
        <CodeBlock lang="json" text={clip(block.inputPartial, INPUT_CHARS)} complete={false} />
      </Section>
    );
  }

  if (block.input === undefined) return null;

  if (typeof block.input === 'string') {
    return (
      <Section label={block.toolKind === 'execute' ? 'command' : 'input'}>
        <CodeBlock
          lang={block.toolKind === 'execute' ? 'shell' : 'text'}
          text={clip(block.input, INPUT_CHARS)}
        />
      </Section>
    );
  }

  const record = asRecord(block.input);
  const command = block.toolKind === 'execute' && record ? firstString(record, COMMAND_KEYS) : null;
  const rest = command && record ? omit(record, COMMAND_KEYS) : record;
  const restText = rest && Object.keys(rest).length ? stringify(rest) : null;

  return (
    <>
      {command ? (
        <Section label="command">
          <CodeBlock lang="shell" text={clip(command, INPUT_CHARS)} />
        </Section>
      ) : null}
      {restText ? (
        <Section label={command ? 'arguments' : 'input'}>
          <CodeBlock lang="json" text={clip(restText, INPUT_CHARS)} />
        </Section>
      ) : null}
    </>
  );
}

function Output({ text }: { text: string }) {
  const [expanded, setExpanded] = React.useState(false);
  const lines = React.useMemo(() => text.split('\n'), [text]);
  const clamped = !expanded && lines.length > OUTPUT_LINES;
  const shown = clamped ? lines.slice(0, OUTPUT_LINES) : lines;
  const hidden = lines.length - shown.length;

  // Only the visible slice is ever joined into a string: a 10k-line test run
  // must cost a 20-line render, not a 10k-line one.
  const body = React.useMemo(
    () => shown.map((line) => clip(line, LINE_CHARS)).join('\n'),
    [shown.length, expanded, text],
  );

  return (
    <div
      style={{
        margin: '0 0 10px',
        border: '1px solid var(--border)',
        background: 'var(--terminal-bg)',
      }}
    >
      <pre
        style={{
          margin: 0,
          padding: '8px 10px',
          overflowX: 'auto',
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--text-xs)',
          lineHeight: 'var(--leading-terminal)',
          color: 'var(--terminal-fg)',
        }}
      >
        {body}
      </pre>
      {lines.length > OUTPUT_LINES ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 5,
            width: '100%',
            minHeight: 34,
            background: 'var(--card)',
            border: 0,
            borderTop: '1px solid var(--border)',
            color: 'var(--muted-foreground)',
            font: 'inherit',
            fontSize: 'var(--text-2xs)',
            letterSpacing: 'var(--tracking-wide)',
            cursor: 'pointer',
          }}
        >
          <Icon name="chevrons-up-down" size={11} />
          {clamped ? `Show ${hidden} more lines` : 'Show less'}
        </button>
      ) : null}
    </div>
  );
}

// --------------------------------------------------------------------------
// Target extraction.
//
// Every runtime names its arguments differently, so the closed row asks each
// kind for the field that identifies what it acted on and takes the first one
// present. An unmapped shape falls back to any string field, then to the
// locations the adapter reported — a row with no target at all is the last
// resort, not the first.
// --------------------------------------------------------------------------

const PATH_KEYS = ['file_path', 'filePath', 'path', 'file', 'filename', 'abs_path', 'target_file'];
const COMMAND_KEYS = ['command', 'cmd', 'script', 'shell_command', 'commandLine'];

const SUMMARY_KEYS: Record<ToolKind, string[]> = {
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

function summarize(block: ToolBlock): string {
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
function partialTarget(partial: string): string {
  const keys = [...COMMAND_KEYS, ...PATH_KEYS, 'url', 'pattern', 'query', 'description', 'prompt'];
  for (const key of keys) {
    const match = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(partial);
    if (match) return oneLine(match[1].replace(/\\(["\\/])/g, '$1'));
  }
  return 'receiving arguments…';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
    if (Array.isArray(value) && value.every((v) => typeof v === 'string') && value.length) {
      return value.join(' ');
    }
  }
  return '';
}

function omit(record: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!keys.includes(key)) out[key] = value;
  }
  return out;
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    // Arguments arrive as JSON, so a cycle should be impossible — but a card
    // that throws would take the whole transcript down with it.
    return String(value);
  }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Keep the tail of a path and the head of prose: both hold the meaning. */
function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  if (text.includes('/') && !text.includes(' ')) return `…${text.slice(text.length - max + 1)}`;
  return `${text.slice(0, max - 1)}…`;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

const srOnly: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
};
