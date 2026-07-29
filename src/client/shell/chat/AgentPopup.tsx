import * as React from 'react';
import { findToolBlock } from '../../../shared/agent-activity.js';
import type { AgentRun, AgentStep, ToolBlock } from '../../../shared/chat-events.js';
import type { ChatTranscript } from '../../chat/transcript.js';
import { KIND_ICON, TOOL_STATUS, compactCount, formatDuration, summarize } from '../../chat/tool-meta.js';
import { Badge } from '../../ui/relay/Badge.js';
import { Dialog } from '../../ui/relay/Dialog.js';
import { Icon } from '../../ui/relay/Icon.js';
import { STATUS_META } from './AgentsPanel.js';

/**
 * What a delegated agent is doing inside its own work.
 *
 * The agents list can only ever say "running" or "done" — the run's own steps
 * arrive out of band from the tool call that started it (see `AgentRun`), and
 * before this they were dropped on the floor. This is where they are shown:
 * the step it is on, the tools it reached for, what each one returned, and any
 * failure inside the run that the delegation's own status would hide.
 *
 * Shares the file editor's dialog chrome — movable, resizable, fill-the-window
 * — because a run worth watching is a run worth putting beside the
 * conversation, which is the same argument the file popup already won.
 */

export interface AgentPopupProps {
  open: boolean;
  transcript: ChatTranscript;
  /** Ignored while `open` is false, so closing never has to be a valid id. */
  toolId: string;
  onClose: () => void;
  isMobile?: boolean;
}

const TERMINAL = new Set(['completed', 'failed', 'denied', 'canceled']);

export function AgentPopup({
  open,
  transcript,
  toolId,
  onClose,
  isMobile = false,
}: AgentPopupProps): React.JSX.Element | null {
  // The live tier. A step lands as an `agent_step`, which patches a block in
  // place and never grows the message list, so the panel's own `subscribe`
  // tier never hears about it — this popup would freeze at whatever the run
  // had done the moment it was opened.
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

  const run: AgentRun | null = block?.agent ?? null;
  const running = block ? !TERMINAL.has(block.status) : false;

  const bodyRef = React.useRef<HTMLDivElement | null>(null);
  const stickToBottom = React.useRef(true);
  const stepCount = run?.steps.length ?? 0;

  React.useEffect(() => {
    const el = bodyRef.current;
    if (!el || !running || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [stepCount, run?.activity, running]);

  if (!open) return null;

  const meta = block ? STATUS_META[block.status] || STATUS_META.pending : null;
  const name = describeAgent(block);

  return (
    <Dialog
      open
      titleText={name}
      title={
        // As in the workflow popup: the name gives way, the status stays (#114).
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {name}
          </span>
          {meta ? (
            <span style={{ display: 'inline-flex', flexShrink: 0 }}>
              <Badge variant={meta.variant} dot={running}>
                {meta.label}
              </Badge>
            </span>
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
          // Once the user scrolls up to read an earlier step, a new one must
          // not yank the view back down mid-sentence.
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}
      >
        {!block ? (
          <Empty text="This agent is no longer in the conversation." />
        ) : (
          <>
            <Header run={run} block={block} running={running} />
            {run && run.steps.length > 0 ? (
              run.steps.map((step) => <Step key={step.id} step={step} />)
            ) : (
              <Empty
                text={
                  running
                    ? 'Waiting for this agent to report its first step…'
                    : 'This agent finished without reporting any steps of its own.'
                }
              />
            )}
            {block.output ? <Result text={block.output} failed={block.status === 'failed'} /> : null}
          </>
        )}
      </div>
    </Dialog>
  );
}

const ZERO = (): number => 0;

/** The delegation's own name: the sub-agent type, else its description. */
function describeAgent(block: ToolBlock | null): string {
  if (!block) return 'Agent';
  const input = block.input && typeof block.input === 'object' && !Array.isArray(block.input)
    ? (block.input as Record<string, unknown>)
    : null;
  const type = block.agent?.subagentType;
  const described = input
    ? ['subagent_type', 'agentType', 'description', 'name'].reduce<string>(
        (found, key) => found || (typeof input[key] === 'string' ? (input[key] as string) : ''),
        '',
      )
    : '';
  return described || type || block.title || block.name || 'Agent';
}

/**
 * What the agent is doing right now, and what it has cost so far.
 *
 * Kept above the steps rather than folded into them: the run reports its own
 * progress ("Reading hello.txt") separately from the calls it makes, and while
 * it is thinking between two tools that line is the only thing that moves.
 */
function Header({
  run,
  block,
  running,
}: {
  run: AgentRun | null;
  block: ToolBlock;
  running: boolean;
}): React.JSX.Element {
  const stats = [
    run?.toolUses !== undefined ? `${run.toolUses} tool${run.toolUses === 1 ? '' : 's'}` : '',
    run?.totalTokens ? `${compactCount(run.totalTokens)} tokens` : '',
    run?.durationMs ? formatDuration(run.durationMs) : '',
  ].filter(Boolean);

  // The run can fail on its own terms while every step it managed succeeded,
  // so its error is shown here rather than left to a badge on the row.
  const failure = run?.error || (block.status === 'failed' ? block.error : undefined);

  return (
    <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)' }}>
      {run?.activity ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontFamily: 'var(--font-sans)',
            fontSize: 'var(--text-sm)',
            color: 'var(--foreground)',
          }}
        >
          {running ? (
            <span style={{ color: 'var(--warning)', flex: '0 0 auto', display: 'inline-flex' }}>
              <Icon name="loader-circle" size={12} />
            </span>
          ) : null}
          <span style={{ wordBreak: 'break-word' }}>{run.activity}</span>
        </div>
      ) : null}
      {run?.prompt ? (
        <div
          style={{
            marginTop: run.activity ? 4 : 0,
            fontFamily: 'var(--font-sans)',
            fontSize: 'var(--text-xs)',
            lineHeight: 'var(--leading-snug)',
            color: 'var(--muted-foreground)',
            wordBreak: 'break-word',
          }}
        >
          {run.prompt}
        </div>
      ) : null}
      {stats.length > 0 ? (
        <div
          style={{
            marginTop: 6,
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-2xs)',
            color: 'var(--muted-foreground)',
          }}
        >
          {stats.join(' · ')}
        </div>
      ) : null}
      {failure ? <Failure text={failure} /> : null}
    </div>
  );
}

function Step({ step }: { step: AgentStep }): React.JSX.Element {
  const status = TOOL_STATUS[step.status] || TOOL_STATUS.pending;
  // `summarize` reads a ToolBlock; a step carries the same fields it looks at,
  // so the step list describes a call exactly the way the trace does.
  const detail = summarize({ kind: 'tool', toolId: step.id, ...step } as ToolBlock);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 7,
        padding: '7px 16px',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <span style={{ flex: '0 0 auto', marginTop: 2, color: status.color }}>
        <Icon name={KIND_ICON[step.toolKind] || 'wrench'} size={13} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-xs)',
              fontWeight: 'var(--font-semibold)' as React.CSSProperties['fontWeight'],
              color: 'var(--foreground)',
            }}
          >
            {step.name}
          </span>
          {status.badge ? <Badge variant={status.badge}>{status.label}</Badge> : null}
        </div>
        {detail ? (
          <div
            style={{
              marginTop: 2,
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-xs)',
              lineHeight: 'var(--leading-snug)',
              color: 'var(--muted-foreground)',
              wordBreak: 'break-word',
            }}
          >
            {detail}
          </div>
        ) : null}
        {step.error ? <Failure text={step.error} /> : null}
      </div>
    </div>
  );
}

/**
 * A failure, spelled out.
 *
 * The whole complaint behind this view is that a failure inside an agent's own
 * work showed up as a generic badge, so the message itself is rendered rather
 * than a colour and a word.
 */
function Failure({ text }: { text: string }): React.JSX.Element {
  return (
    <pre
      style={{
        margin: '6px 0 0',
        padding: '6px 8px',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--destructive-soft, rgba(220, 38, 38, 0.10))',
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--text-2xs)',
        lineHeight: 'var(--leading-normal)',
        color: 'var(--destructive)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {text}
    </pre>
  );
}

function Result({ text, failed }: { text: string; failed: boolean }): React.JSX.Element {
  return (
    <div style={{ padding: '10px 16px' }}>
      <div
        style={{
          fontFamily: 'var(--font-sans)',
          fontSize: 'var(--text-2xs)',
          textTransform: 'uppercase',
          letterSpacing: 'var(--tracking-caps)',
          color: 'var(--muted-foreground)',
          marginBottom: 4,
        }}
      >
        {failed ? 'Failed with' : 'Reported back'}
      </div>
      <pre
        style={{
          margin: 0,
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--text-xs)',
          lineHeight: 'var(--leading-normal)',
          color: failed ? 'var(--destructive)' : 'var(--muted-foreground)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {text}
      </pre>
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
