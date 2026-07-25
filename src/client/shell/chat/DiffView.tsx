import * as React from 'react';
import { DiffHunk, FileDiff } from '../../../shared/chat-events.js';
import { Badge, BadgeVariant } from '../../ui/relay/Badge.js';
import { Button } from '../../ui/relay/Button.js';
import { Icon } from '../../ui/relay/Icon.js';

/**
 * Unified-diff rendering for the file changes a tool call reports.
 *
 * The colouring reuses the ANSI tokens rather than introducing diff-specific
 * ones, for the same reason highlight.ts does: they already flip with the theme
 * and already track the terminal palette, so a diff in a chat bubble and a diff
 * printed by `git` in the terminal beside it cannot drift apart.
 *
 * Colour is never the only signal. Every row carries its unified-diff marker as
 * real text in the DOM, so the change reads identically to a screen reader, to
 * a user with a colour vision deficiency, and to anyone who copies the rows out.
 *
 * Rows are rendered one element per line rather than as a single highlighted
 * <pre>, because per-hunk apply/revert needs a hunk to be an addressable region
 * and line numbers need a column of their own.
 */

export interface DiffViewProps {
  diffs: FileDiff[];
  onApplyHunk?: (diff: FileDiff, hunkIndex: number) => void;
  onRevertHunk?: (diff: FileDiff, hunkIndex: number) => void;
  /** Start every file closed — used where the diff is context, not the subject. */
  collapsedByDefault?: boolean;
}

/** Lines shown per file before the body clamps itself. */
const CLAMP_LINES = 40;

const KIND_VARIANT: Record<FileDiff['kind'], BadgeVariant> = {
  create: 'success',
  update: 'neutral',
  delete: 'destructive',
  rename: 'outline',
};

export function DiffView({
  diffs,
  onApplyHunk,
  onRevertHunk,
  collapsedByDefault,
}: DiffViewProps) {
  if (!diffs || diffs.length === 0) return null;
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {diffs.map((diff, i) => (
        <FileCard
          key={`${diff.path}:${i}`}
          diff={diff}
          onApplyHunk={onApplyHunk}
          onRevertHunk={onRevertHunk}
          collapsedByDefault={Boolean(collapsedByDefault)}
        />
      ))}
    </div>
  );
}

function FileCard({
  diff,
  onApplyHunk,
  onRevertHunk,
  collapsedByDefault,
}: {
  diff: FileDiff;
  onApplyHunk?: (diff: FileDiff, hunkIndex: number) => void;
  onRevertHunk?: (diff: FileDiff, hunkIndex: number) => void;
  collapsedByDefault: boolean;
}) {
  const [open, setOpen] = React.useState(!collapsedByDefault);
  const [showAll, setShowAll] = React.useState(false);
  const bodyId = React.useId();

  const groups = React.useMemo(
    () => (diff.hunks || []).map((hunk) => ({ hunk, rows: hunkRows(hunk) })),
    [diff.hunks],
  );
  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  const clamped = !showAll && total > CLAMP_LINES;

  // Budget is spent across hunks in order, so a clamped file still shows whole
  // leading hunks rather than an arbitrary slice of the last one.
  let budget = clamped ? CLAMP_LINES : Infinity;
  const visible = groups.map((group) => {
    const take = Math.min(group.rows.length, budget);
    budget -= take;
    return { ...group, rows: group.rows.slice(0, take) };
  });

  return (
    <div style={{ border: '1px solid var(--border)', background: 'var(--card)' }}>
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
          borderBottom: open ? '1px solid var(--border)' : 0,
          color: 'var(--foreground)',
          font: 'inherit',
          fontSize: 'var(--text-sm)',
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} />
        <Badge variant={KIND_VARIANT[diff.kind] || 'neutral'}>{diff.kind}</Badge>
        <PathLabel diff={diff} />
        {diff.binary ? <Badge variant="outline">binary</Badge> : <Counts diff={diff} />}
      </button>

      {open ? (
        <div id={bodyId}>
          {diff.binary ? (
            <p
              style={{
                margin: 0,
                padding: '10px 12px',
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--text-xs)',
                color: 'var(--muted-foreground)',
              }}
            >
              binary file — no textual diff to show
            </p>
          ) : total === 0 ? (
            <p
              style={{
                margin: 0,
                padding: '10px 12px',
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--text-xs)',
                color: 'var(--muted-foreground)',
              }}
            >
              no line changes reported
            </p>
          ) : (
            <>
              {visible.map((group, i) => (
                <Hunk
                  key={i}
                  diff={diff}
                  hunk={group.hunk}
                  index={i}
                  rows={group.rows}
                  truncated={group.rows.length < groups[i].rows.length}
                  onApplyHunk={onApplyHunk}
                  onRevertHunk={onRevertHunk}
                />
              ))}
              {clamped ? (
                <MoreButton onClick={() => setShowAll(true)}>
                  Show all {total} lines
                </MoreButton>
              ) : total > CLAMP_LINES ? (
                <MoreButton onClick={() => setShowAll(false)}>Show less</MoreButton>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function PathLabel({ diff }: { diff: FileDiff }) {
  const common: React.CSSProperties = {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-xs)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  };

  if (diff.kind === 'rename' && diff.oldPath) {
    return (
      <span
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          overflow: 'hidden',
        }}
      >
        <span style={{ ...common, color: 'var(--muted-foreground)', flex: '0 1 auto' }}>
          {diff.oldPath}
        </span>
        <Icon name="arrow-right" size={11} style={{ color: 'var(--muted-foreground)' }} />
        <span style={{ ...common, flex: '1 1 auto' }}>{diff.path}</span>
      </span>
    );
  }

  return <span style={{ ...common, flex: 1, minWidth: 0 }}>{diff.path}</span>;
}

function Counts({ diff }: { diff: FileDiff }) {
  return (
    <span
      style={{
        display: 'flex',
        gap: 6,
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--text-2xs)',
        flex: '0 0 auto',
      }}
    >
      <span style={{ color: 'var(--ansi-green)' }}>+{diff.added || 0}</span>
      <span style={{ color: 'var(--ansi-red)' }}>-{diff.removed || 0}</span>
    </span>
  );
}

interface Row {
  marker: string;
  text: string;
  oldNo: number | null;
  newNo: number | null;
  meta: boolean;
}

/** Walk a hunk body, assigning each side's line numbers as the markers allow. */
function hunkRows(hunk: DiffHunk): Row[] {
  let oldNo = hunk.oldStart || 1;
  let newNo = hunk.newStart || 1;
  return (hunk.lines || []).map((raw) => {
    const line = String(raw ?? '');
    const marker = line.slice(0, 1);
    const text = line.slice(1);

    // "\ No newline at end of file" belongs to neither side and numbers nothing.
    if (marker === '\\') {
      return { marker: '\\', text, oldNo: null, newNo: null, meta: true };
    }
    if (marker === '+') {
      return { marker: '+', text, oldNo: null, newNo: newNo++, meta: false };
    }
    if (marker === '-') {
      return { marker: '-', text, oldNo: oldNo++, newNo: null, meta: false };
    }
    return { marker: ' ', text: marker === ' ' ? text : line, oldNo: oldNo++, newNo: newNo++, meta: false };
  });
}

function Hunk({
  diff,
  hunk,
  index,
  rows,
  truncated,
  onApplyHunk,
  onRevertHunk,
}: {
  diff: FileDiff;
  hunk: DiffHunk;
  index: number;
  rows: Row[];
  truncated: boolean;
  onApplyHunk?: (diff: FileDiff, hunkIndex: number) => void;
  onRevertHunk?: (diff: FileDiff, hunkIndex: number) => void;
}) {
  const range = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
  return (
    <div style={{ borderTop: index === 0 ? 0 : '1px solid var(--border)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          padding: '2px 8px',
          background: 'var(--muted)',
        }}
      >
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-2xs)',
            color: 'var(--ansi-bright-blue)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {range}
        </span>
        {onApplyHunk ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onApplyHunk(diff, index)}
            aria-label={`Apply hunk ${index + 1} of ${diff.path}`}
            iconLeft={<Icon name="check" size={11} />}
            style={{ height: 34 }}
          >
            apply
          </Button>
        ) : null}
        {onRevertHunk ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onRevertHunk(diff, index)}
            aria-label={`Revert hunk ${index + 1} of ${diff.path}`}
            iconLeft={<Icon name="corner-up-left" size={11} />}
            style={{ height: 34 }}
          >
            revert
          </Button>
        ) : null}
      </div>

      {/* The rows scroll sideways inside the hunk; the transcript column never
          widens to fit a long line of source. */}
      <div style={{ overflowX: 'auto' }}>
        <div
          style={{
            minWidth: 'max-content',
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-xs)',
            lineHeight: 'var(--leading-terminal)',
            background: 'var(--terminal-bg)',
          }}
        >
          {rows.map((row, i) => (
            <DiffRow key={i} row={row} />
          ))}
          {truncated ? (
            <div
              style={{
                padding: '0 8px',
                color: 'var(--terminal-dim)',
                fontSize: 'var(--text-2xs)',
              }}
            >
              …
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function DiffRow({ row }: { row: Row }) {
  const added = row.marker === '+';
  const removed = row.marker === '-';
  const background = added
    ? 'color-mix(in oklab, var(--ansi-green) 15%, var(--terminal-bg))'
    : removed
      ? 'color-mix(in oklab, var(--ansi-red) 15%, var(--terminal-bg))'
      : 'transparent';

  return (
    <div style={{ display: 'flex', background, whiteSpace: 'pre' }}>
      <span style={gutter}>{row.oldNo ?? ''}</span>
      <span style={gutter}>{row.newNo ?? ''}</span>
      <span
        style={{
          flex: '0 0 auto',
          width: 14,
          textAlign: 'center',
          color: added
            ? 'var(--ansi-green)'
            : removed
              ? 'var(--ansi-red)'
              : 'var(--terminal-dim)',
        }}
      >
        {row.marker}
      </span>
      <span
        style={{
          flex: '1 1 auto',
          paddingRight: 8,
          color: row.meta ? 'var(--terminal-dim)' : 'var(--terminal-fg)',
        }}
      >
        {row.text}
      </span>
    </div>
  );
}

const gutter: React.CSSProperties = {
  flex: '0 0 auto',
  width: 38,
  paddingRight: 6,
  textAlign: 'right',
  color: 'var(--terminal-dim)',
  userSelect: 'none',
};

function MoreButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
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
      {children}
    </button>
  );
}
