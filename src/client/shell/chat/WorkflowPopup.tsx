import * as React from 'react';
import {
  findToolBlock,
  parseWorkflowLog,
  type WorkflowLogSection,
} from '../../../shared/agent-activity.js';
import type { ToolBlock } from '../../../shared/chat-events.js';
import type { ChatTranscript } from '../../chat/transcript.js';
import { Badge } from '../../ui/relay/Badge.js';
import { Dialog } from '../../ui/relay/Dialog.js';
import { STATUS_META } from './AgentsPanel.js';

/**
 * A workflow, open for watching and for review afterward.
 *
 * Reuses the file editor's dialog rather than a bespoke popup: a workflow run
 * is another thing worth putting beside the conversation and coming back to,
 * so it gets the same movable, resizable, fill-the-window chrome for free.
 *
 * There is no structured progress channel behind this — a workflow tool call
 * streams a growing string of output the same way any other tool call does.
 * `parseWorkflowLog` reads whatever heading style the run narrates in; a
 * workflow that prints nothing recognisable still shows as one plain log
 * rather than an empty panel.
 */

export interface WorkflowPopupProps {
  open: boolean;
  transcript: ChatTranscript;
  /** Ignored while `open` is false, so closing never has to be a valid id. */
  toolId: string;
  onClose: () => void;
  isMobile?: boolean;
}

const TERMINAL = new Set(['completed', 'failed', 'denied', 'canceled']);

export function WorkflowPopup({
  open,
  transcript,
  toolId,
  onClose,
  isMobile = false,
}: WorkflowPopupProps): React.JSX.Element | null {
  // The live tier: a running workflow's output grows by `tool` patches, which
  // never reach `subscribe` (see transcript.ts). Missing that would freeze
  // this popup at whatever the log held the moment it was opened.
  const version = React.useSyncExternalStore(
    transcript.subscribeContent,
    transcript.getContentVersion,
    ZERO,
  );

  const block: ToolBlock | null = React.useMemo(
    () => (open ? findToolBlock(transcript.messages, toolId) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [transcript, toolId, open, version],
  );

  const running = block ? !TERMINAL.has(block.status) : false;
  const sections = React.useMemo(() => parseWorkflowLog(block?.output), [block?.output]);

  const bodyRef = React.useRef<HTMLDivElement | null>(null);
  const stickToBottom = React.useRef(true);

  React.useEffect(() => {
    const el = bodyRef.current;
    if (!el || !running || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [block?.output, running]);

  if (!open) return null;

  const input =
    block && block.input && typeof block.input === 'object' && !Array.isArray(block.input)
      ? (block.input as Record<string, unknown>)
      : null;
  const name =
    (input && typeof input.name === 'string' && input.name) ||
    (input && typeof input.workflow === 'string' && input.workflow) ||
    block?.title ||
    block?.name ||
    'Workflow';
  const meta = block ? STATUS_META[block.status] || STATUS_META.pending : null;

  return (
    <Dialog
      open
      title={
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>{name}</span>
          {meta ? (
            <Badge variant={meta.variant} dot={running}>
              {meta.label}
            </Badge>
          ) : null}
        </span>
      }
      onClose={onClose}
      movable
      placement={isMobile ? 'bottom' : 'center'}
      height={isMobile ? undefined : 'min(78dvh, 860px)'}
      bodyFill
      width={720}
    >
      <div
        ref={bodyRef}
        onScroll={(event) => {
          const el = event.currentTarget;
          // Once the user scrolls away from the bottom, new output stops
          // yanking the view back down — the same courtesy a terminal gives.
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'auto' }}
      >
        {!block ? (
          <Empty text="This workflow is no longer in the conversation." />
        ) : sections.length === 0 ? (
          <Empty text={running ? 'Waiting for the first stage to report in…' : 'This workflow left no output.'} />
        ) : (
          sections.map((section, index) => <Section key={index} section={section} />)
        )}
      </div>
    </Dialog>
  );
}

const ZERO = (): number => 0;

function Section({ section }: { section: WorkflowLogSection }): React.JSX.Element {
  return (
    <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)' }}>
      {section.title ? (
        <div
          style={{
            fontFamily: 'var(--font-sans)',
            fontSize: 'var(--text-xs)',
            fontWeight: 'var(--font-semibold)' as React.CSSProperties['fontWeight'],
            color: 'var(--foreground)',
            marginBottom: section.lines.length > 0 ? 6 : 0,
          }}
        >
          {section.title}
        </div>
      ) : null}
      {section.lines.length > 0 ? (
        <pre
          style={{
            margin: 0,
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-xs)',
            lineHeight: 'var(--leading-normal)',
            color: 'var(--muted-foreground)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {section.lines.join('\n')}
        </pre>
      ) : null}
    </div>
  );
}

function Empty({ text }: { text: string }): React.JSX.Element {
  return (
    <div
      style={{
        padding: '24px 16px',
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--text-sm)',
        color: 'var(--muted-foreground)',
        textAlign: 'center',
      }}
    >
      {text}
    </div>
  );
}
