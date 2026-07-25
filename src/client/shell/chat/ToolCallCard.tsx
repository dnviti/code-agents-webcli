import * as React from 'react';
import { FileDiff, ToolBlock } from '../../../shared/chat-events.js';
import { Badge } from '../../ui/relay/Badge.js';
import { Icon } from '../../ui/relay/Icon.js';
import {
  COMMAND_KEYS,
  INPUT_CHARS,
  KIND_ICON,
  LINE_CHARS,
  OUTPUT_LINES,
  TOOL_STATUS,
  asRecord,
  clip,
  firstString,
  formatDuration,
  omit,
  stringify,
  summarize,
} from '../../chat/tool-meta.js';
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

export function ToolCallCard({
  block,
  defaultOpen,
  onApplyHunk,
  onRevertHunk,
}: ToolCallCardProps) {
  const [open, setOpen] = React.useState(Boolean(defaultOpen));
  const bodyId = React.useId();

  const status = TOOL_STATUS[block.status] || TOOL_STATUS.pending;
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
