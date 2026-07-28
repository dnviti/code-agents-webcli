import * as React from 'react';
import {
  findToolBlock,
  parseWorkflowLog,
  type WorkflowLogSection,
} from '../../../shared/agent-activity.js';
import type { AgentRun, AgentStep, ToolBlock } from '../../../shared/chat-events.js';
import type { ChatTranscript } from '../../chat/transcript.js';
import {
  KIND_ICON,
  TOOL_STATUS,
  compactCount,
  formatDuration,
  summarize,
} from '../../chat/tool-meta.js';
import { Badge } from '../../ui/relay/Badge.js';
import { Dialog } from '../../ui/relay/Dialog.js';
import { Icon } from '../../ui/relay/Icon.js';
import { STATUS_META } from './AgentsPanel.js';

/**
 * A workflow, open for watching and for review afterward.
 *
 * Reuses the file editor's dialog rather than a bespoke popup: a workflow run
 * is another thing worth putting beside the conversation and coming back to,
 * so it gets the same movable, resizable, fill-the-window chrome for free.
 *
 * Two sources feed it, and the difference between them is the whole of issue
 * #45. `output` is written once, by the tool_result that ends the run, so a
 * popup reading only that said "waiting for the first stage" for every minute
 * of a run that takes tens of them, and then showed the entire log at once.
 * The runtime does report while it works — `task_started`/`task_progress`
 * tagged `local_workflow`, which the adapter already folds into `block.agent`,
 * the same channel `AgentPopup` has always read for delegations. What is drawn
 * from there is what that channel is known to carry: the stage the run names
 * for itself, the tool it last reached for, and what it has spent. The log
 * still lands underneath when it finally arrives, because a finished run is a
 * thing people come back to read.
 *
 * The per-phase list below is drawn from `run.steps`, and nothing has been
 * observed producing them for a workflow: `agent_step` comes from the
 * delegated-task path, and the phase structure a workflow reports travels on
 * `task_progress.workflow_progress`, which the adapter does not forward. So
 * that list is what this popup would show if they arrived, not something a
 * user sees today — it is left in place rather than shipped as a fixture
 * nobody has captured. Wiring it needs a real run recorded first.
 *
 * `parseWorkflowLog` reads whatever heading style the log narrates in; a
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
  // The live tier: a running workflow's output grows by `tool` patches and its
  // phases by `agent_progress`, neither of which ever reaches `subscribe` (see
  // transcript.ts). Missing that would freeze this popup at whatever the run
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
  const sections = React.useMemo(() => parseWorkflowLog(block?.output), [block?.output]);
  const phases = run?.steps ?? [];

  const bodyRef = React.useRef<HTMLDivElement | null>(null);
  const stickToBottom = React.useRef(true);

  React.useEffect(() => {
    const el = bodyRef.current;
    if (!el || !running || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [block?.output, phases.length, run?.activity, running]);

  if (!open) return null;

  const input =
    block && block.input && typeof block.input === 'object' && !Array.isArray(block.input)
      ? (block.input as Record<string, unknown>)
      : null;
  // Not `script`, though the tool accepts one: that argument is the workflow's
  // whole source, so treating it as a path titles the dialog with whatever the
  // last slash in the script body happened to precede.
  const scriptPath = pathLike(field(input, ['scriptPath', 'script_path']));
  const name =
    field(input, ['name', 'workflow'])
    || block?.title
    || stem(scriptPath)
    || block?.name
    || 'Workflow';
  const meta = block ? STATUS_META[block.status] || STATUS_META.pending : null;
  // The path, never `run.prompt`. For a workflow that prompt is the script
  // itself — nine thousand characters of it in an ordinary run — and this line
  // is one line under the title.
  const source = scriptPath;

  // Whether the run has said anything at all, which is not the same as whether
  // there is anything to draw: the path and the token counts are chrome the
  // popup can show for a run that has yet to report a word, and counting them
  // would retire the honest empty state for every Claude workflow there is.
  const reported = !!run?.activity || phases.length > 0 || sections.length > 0;

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
        ) : (
          <>
            <Header run={run} block={block} running={running} source={source} />
            {phases.map((phase) => (
              <Phase key={phase.id} phase={phase} live={running} />
            ))}
            {sections.length > 0 ? (
              <>
                {/* Captioned only when the live view is above it. On its own the
                    log is the whole body, and a label over the only thing there
                    is says nothing the popup's own title has not. */}
                {run?.activity || phases.length > 0 ? (
                  <Caption text={block.status === 'failed' ? 'Failed with' : 'Final output'} />
                ) : null}
                {sections.map((section, index) => (
                  <Section key={index} section={section} />
                ))}
              </>
            ) : null}
            {reported ? null : (
              <Empty
                text={
                  running
                    ? 'Waiting for the first stage to report in…'
                    : 'This workflow left no output.'
                }
              />
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

const ZERO = (): number => 0;

function field(input: Record<string, unknown> | null, keys: string[]): string {
  if (!input) return '';
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/**
 * Only a value that could be a path.
 *
 * The same tool accepts an inline `script`, and one of these keys arriving with
 * a script body in it would put the tail of some line of JavaScript in the
 * title bar. A path has no newlines, no spaces and an extension.
 */
function pathLike(value: string): string {
  if (!value || /[\n\s]/.test(value)) return '';
  return /\.[A-Za-z0-9]+$/.test(value) ? value : '';
}

/**
 * A workflow's name when all the call carries is where its script lives.
 *
 * A run named in the call — `{name: 'review-changes'}`, or a title the runtime
 * supplied — is titled by that. This is for the other shape: `{scriptPath}` and
 * nothing else, where a title that only knew how to read `name` fell all the
 * way through to the tool's own and the dialog was called "Workflow". The
 * file's own stem is the name whoever wrote the workflow chose for it.
 */
function stem(path: string): string {
  const base = path.split(/[\\/]/).pop() || '';
  return base.replace(/\.[^./\\]+$/, '');
}

/**
 * What the workflow is doing now, where it came from, and what it has cost.
 *
 * The activity line outlives the run deliberately — it is the last stage the
 * workflow named, and after a ten-minute run that is worth keeping — but the
 * spinner beside it does not. A pulsing "still working" over a completed
 * result is the same lie in miniature that this whole popup was reported for.
 */
function Header({
  run,
  block,
  running,
  source,
}: {
  run: AgentRun | null;
  block: ToolBlock;
  running: boolean;
  source: string;
}): React.JSX.Element | null {
  const stats = [
    run?.toolUses !== undefined ? `${run.toolUses} tool${run.toolUses === 1 ? '' : 's'}` : '',
    run?.totalTokens ? `${compactCount(run.totalTokens)} tokens` : '',
    run?.durationMs ? formatDuration(run.durationMs) : '',
  ].filter(Boolean);

  // The workflow can fail on its own terms while every phase it ran succeeded,
  // so its error is spelled out here rather than left to a badge on the row —
  // unless it is the log all over again, which is what the runtime sends when
  // the failure *is* the output, and printing it twice reads as two failures.
  const reportedFailure = run?.error || (block.status === 'failed' ? block.error : undefined);
  const failure = reportedFailure === block.output ? undefined : reportedFailure;

  if (!run?.activity && !source && stats.length === 0 && !failure) return null;

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
      {source ? (
        <div
          style={{
            marginTop: run?.activity ? 4 : 0,
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-xs)',
            lineHeight: 'var(--leading-snug)',
            color: 'var(--muted-foreground)',
            wordBreak: 'break-word',
          }}
        >
          {source}
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

/**
 * One phase of the run, drawn the way `AgentPopup` draws a delegation's step.
 *
 * Copied rather than shared on purpose: the two popups are the same idea seen
 * from two angles, and a workflow phase that looked like a different kind of
 * object from a sub-agent step would be read as one. What differs is the
 * settling below, which only a run with an ending needs.
 */
function Phase({ phase, live }: { phase: AgentStep; live: boolean }): React.JSX.Element {
  const status = TOOL_STATUS[phase.status] || TOOL_STATUS.pending;
  // A phase is opened by one event and closed by another, and a run can end —
  // cancelled, failed, or simply finished — with that second half never sent.
  // Left in its own colour the phase goes on reading as in-flight underneath a
  // result that is plainly final.
  const stalled = !live && !TERMINAL.has(phase.status);
  // `summarize` reads a ToolBlock; a phase carries the same fields it looks at,
  // so a phase describes what it touched exactly the way the trace does.
  const detail = summarize({ kind: 'tool', toolId: phase.id, ...phase } as ToolBlock);

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
      <span
        style={{
          flex: '0 0 auto',
          marginTop: 2,
          color: stalled ? 'var(--muted-foreground)' : status.color,
        }}
      >
        <Icon name={KIND_ICON[phase.toolKind] || 'wrench'} size={13} />
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
            {phase.name}
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
        {phase.error ? <Failure text={phase.error} /> : null}
      </div>
    </div>
  );
}

function Caption({ text }: { text: string }): React.JSX.Element {
  return (
    <div
      style={{
        padding: '10px 16px 0',
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--text-2xs)',
        textTransform: 'uppercase',
        letterSpacing: 'var(--tracking-caps)',
        color: 'var(--muted-foreground)',
      }}
    >
      {text}
    </div>
  );
}

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

/** A failure, spelled out, rather than reduced to a colour and a word. */
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
