import * as React from 'react';

import { Button } from '../../ui/relay/Button';
import { Dialog } from '../../ui/relay/Dialog';

export interface PlanDialogProps {
  open: boolean;
  /** Raw plan text captured from the terminal. Untrusted. */
  content: string;
  serverName?: string;
  disabled?: boolean;
  onAccept(): void;
  onReject(): void;
  onClose(): void;
}

const headingStyle: React.CSSProperties = {
  margin: '14px 0 6px',
  fontFamily: 'var(--font-sans)',
  fontWeight: 'var(--font-semibold)' as React.CSSProperties['fontWeight'],
  color: 'var(--foreground)',
  lineHeight: 'var(--leading-tight)',
};

const paragraphStyle: React.CSSProperties = {
  margin: '0 0 8px',
  // The plan arrives as terminal output, so its own wrapping carries meaning
  // (indented steps, aligned columns). pre-wrap keeps the breaks without
  // turning every newline into an element.
  whiteSpace: 'pre-wrap',
  lineHeight: 'var(--leading-normal)',
  color: 'var(--foreground)',
};

const bulletStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  margin: '0 0 4px',
  lineHeight: 'var(--leading-normal)',
  color: 'var(--foreground)',
};

const codeStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--text-sm)',
  background: 'var(--secondary)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  padding: '1px 4px',
};

/**
 * Inline markers, in one pass. Every capture becomes a React element with the
 * matched text as a *child*, so nothing the agent printed can ever be parsed as
 * markup — which is exactly what the escape-then-innerHTML code this replaces
 * could not guarantee.
 */
function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const pattern = /\*\*([^*]+)\*\*|\*([^*\n]+)\*|`([^`]+)`/g;
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  let match = pattern.exec(text);

  while (match !== null) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    const key = `${keyPrefix}-i${match.index}`;
    if (match[1] !== undefined) {
      nodes.push(
        <strong key={key} style={{ fontWeight: 'var(--font-semibold)' as React.CSSProperties['fontWeight'] }}>
          {match[1]}
        </strong>,
      );
    } else if (match[2] !== undefined) {
      nodes.push(<em key={key}>{match[2]}</em>);
    } else {
      nodes.push(
        <code key={key} style={codeStyle}>
          {match[3]}
        </code>,
      );
    }
    cursor = match.index + match[0].length;
    match = pattern.exec(text);
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

/** Blocks, in one pass over the lines. Anything unrecognised is prose. */
function renderPlan(content: string): React.ReactNode[] {
  const blocks: React.ReactNode[] = [];
  const pending: string[] = [];
  const lines = content.split('\n');

  const flush = (index: number): void => {
    const text = pending.join('\n');
    pending.length = 0;
    if (!text.trim()) return;
    blocks.push(
      <p key={`p${index}`} style={paragraphStyle}>
        {renderInline(text, `p${index}`)}
      </p>,
    );
  };

  lines.forEach((line, index) => {
    if (line.startsWith('### ')) {
      flush(index);
      blocks.push(
        <h3 key={`h${index}`} style={{ ...headingStyle, fontSize: 'var(--text-ui)' }}>
          {renderInline(line.slice(4), `h${index}`)}
        </h3>,
      );
    } else if (line.startsWith('## ')) {
      flush(index);
      blocks.push(
        <h2 key={`h${index}`} style={{ ...headingStyle, fontSize: 'var(--text-body)' }}>
          {renderInline(line.slice(3), `h${index}`)}
        </h2>,
      );
    } else if (line.startsWith('- ')) {
      flush(index);
      blocks.push(
        <div key={`b${index}`} style={bulletStyle}>
          <span aria-hidden="true" style={{ color: 'var(--muted-foreground)' }}>
            •
          </span>
          <span>{renderInline(line.slice(2), `b${index}`)}</span>
        </div>,
      );
    } else {
      pending.push(line);
    }
  });

  flush(lines.length);
  return blocks;
}

export function PlanDialog({
  open,
  content,
  serverName,
  disabled = false,
  onAccept,
  onReject,
  onClose,
}: PlanDialogProps): React.JSX.Element | null {
  if (!open) return null;

  return (
    <Dialog
      open={open}
      title="Plan"
      onClose={onClose}
      width={640}
      footer={
        <>
          <Button variant="destructive" disabled={disabled} onClick={onReject}>
            Reject plan
          </Button>
          <Button variant="primary" disabled={disabled} onClick={onAccept}>
            Accept plan
          </Button>
        </>
      }
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          marginBottom: 12,
          fontSize: 'var(--text-sm)',
          color: 'var(--muted-foreground)',
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: 'var(--radius-full)',
            background: 'var(--ansi-green)',
            flex: '0 0 auto',
          }}
        />
        {serverName ? `Plan mode active · Server: ${serverName}` : 'Plan mode active'}
      </div>
      {disabled ? (
        <p role="alert" style={{ margin: '0 0 12px', color: 'var(--destructive)' }}>
          This server is unavailable. Reconnect it before accepting or rejecting this plan.
        </p>
      ) : null}
      <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>{renderPlan(content)}</div>
    </Dialog>
  );
}
