import * as React from 'react';
import {
  findToolBlock,
  parseWorkflowLog,
  summarizeWorkflow,
  type WorkflowLogSection,
  type WorkflowPhaseView,
  type WorkflowSummary,
} from '../../../shared/agent-activity.js';
import type {
  AgentRun,
  AgentStep,
  ToolBlock,
  WorkflowAgent,
} from '../../../shared/chat-events.js';
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
import { PHONE_TEXT, usePhone } from '../../ui/touch.js';
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
 * The phases and the agents inside them are issue #117, and they are the run's
 * own report of itself: `task_progress.workflow_progress`, now forwarded by the
 * adapter and recorded in test/fixtures/chat/claude-workflow.jsonl. Before it,
 * the popup showed the one line the run last narrated — which can only ever
 * describe one agent, so a run with eight in flight showed seven of them as
 * nothing at all.
 *
 * What is *not* read from is `block.status`. The Workflow tool returns the
 * moment the run is launched (#116), so a workflow whose agents are still
 * working has a completed tool call sitting over them. Every state below is
 * derived from the agents' own reports instead, which means this view stays
 * right whichever way that is eventually fixed.
 *
 * `run.steps` is still rendered, but only for a run that reports no structure
 * at all: nothing has been observed producing steps for a workflow, and it is
 * the shape a runtime other than Claude would most plausibly arrive in.
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
  const workflow = React.useMemo(
    () => summarizeWorkflow(run),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [run, version],
  );
  // Only for a run that reported no structure of its own. See the note above.
  const steps = workflow.empty ? run?.steps ?? [] : [];

  /**
   * Which phases are folded shut, and which agents are opened out.
   *
   * Both are what the reader has chosen, not what the run is doing — so a
   * phase finishing does not shut it under someone reading it, and an agent
   * whose detail is open goes on updating in place. Everything starts as the
   * run itself presents it: phases open, agents on one line each.
   */
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<number | null>>(EMPTY);
  const [opened, setOpened] = React.useState<ReadonlySet<number>>(EMPTY);

  const bodyRef = React.useRef<HTMLDivElement | null>(null);
  const stickToBottom = React.useRef(true);

  React.useEffect(() => {
    const el = bodyRef.current;
    if (!el || !running || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [block?.output, steps.length, workflow.total, run?.activity, running]);

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
    // The run's own name, ahead of the tool's: a call carrying an inline
    // `{script}` — which is what an ordinary run looks like — names the
    // workflow nowhere in its arguments, and every one of them was "Workflow".
    || run?.workflowName
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
  const reported =
    !!run?.activity || !workflow.empty || steps.length > 0 || sections.length > 0;

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
            {workflow.empty ? null : <Progress summary={workflow} />}
            {workflow.phases.map((view, index) => (
              <PhaseSection
                key={view.phase ? view.phase.index : 'loose'}
                view={view}
                position={index + 1}
                collapsed={collapsed.has(view.phase ? view.phase.index : null)}
                onToggle={() =>
                  setCollapsed(toggle(collapsed, view.phase ? view.phase.index : null))
                }
                opened={opened}
                onOpenAgent={(agentIndex) => setOpened(toggle(opened, agentIndex))}
              />
            ))}
            {steps.map((step) => (
              <Phase key={step.id} phase={step} live={running} />
            ))}
            {sections.length > 0 ? (
              <>
                {/* Captioned only when the live view is above it. On its own the
                    log is the whole body, and a label over the only thing there
                    is says nothing the popup's own title has not. */}
                {run?.activity || !workflow.empty || steps.length > 0 ? (
                  <Caption
                    text={
                      // "Failed with" only when the log *is* the failure, which
                      // is the shape a workflow refused outright arrives in:
                      // the tool call errors and its output is the message. A
                      // run that failed after it launched has a log holding the
                      // launch acknowledgement and its reason reported
                      // separately, above — captioning that "Failed with" would
                      // point at the wrong text (#140).
                      block.status === 'failed' && !run?.error ? 'Failed with' : 'Final output'
                    }
                  />
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

const EMPTY: ReadonlySet<never> = new Set();

/**
 * The two type sizes this view is written at, phone or not.
 *
 * The desktop scale bottoms out at 10px, which is a caption size for a screen
 * held at desk distance and unreadable at arm's length — so a phone gets the
 * scale ui/touch.ts states for one, rather than a media query these inline
 * styles could never be reached by.
 */
function typeScale(phone: boolean): { meta: string | number; body: string | number } {
  return phone
    ? { meta: PHONE_TEXT.meta, body: PHONE_TEXT.body }
    : { meta: 'var(--text-2xs)', body: 'var(--text-xs)' };
}

/** A new set with `value` flipped, so React sees a changed reference. */
function toggle<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set(set);
  if (!next.delete(value)) next.add(value);
  return next;
}

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
  const phone = usePhone();
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
            fontSize: typeScale(phone).body,
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
            fontSize: typeScale(phone).meta,
            color: 'var(--muted-foreground)',
          }}
        >
          {stats.join(' · ')}
        </div>
      ) : null}
      {failure ? <Failure text={failure} phone={phone} /> : null}
    </div>
  );
}

/**
 * How far the run has got, in one line.
 *
 * Only the counts that are not zero, so a run with nothing failing does not
 * carry a "0 failed" that a reader has to look at twice before believing.
 */
function Progress({ summary }: { summary: WorkflowSummary }): React.JSX.Element {
  const type = typeScale(usePhone());
  const parts = [
    summary.running > 0 ? `${summary.running} running` : '',
    summary.queued > 0 ? `${summary.queued} queued` : '',
    summary.done > 0 ? `${summary.done} done` : '',
    summary.failed > 0 ? `${summary.failed} failed` : '',
  ].filter(Boolean);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
        padding: '8px 16px',
        borderBottom: '1px solid var(--border)',
        fontFamily: 'var(--font-mono)',
        fontSize: type.meta,
        color: 'var(--muted-foreground)',
      }}
    >
      <span style={{ color: summary.failed > 0 ? 'var(--destructive)' : undefined }}>
        {parts.length > 0 ? parts.join(' · ') : 'no agents yet'}
        {summary.total > 0 ? ` of ${summary.total}` : ''}
      </span>
      {summary.current?.phase ? (
        <Badge variant="warning" dot>
          {summary.current.phase.title}
        </Badge>
      ) : null}
    </div>
  );
}

const PHASE_STATE: Record<
  WorkflowPhaseView['state'],
  { label: string; variant: 'outline' | 'warning' | 'success' | 'destructive'; color: string }
> = {
  waiting: { label: 'not started', variant: 'outline', color: 'var(--muted-foreground)' },
  running: { label: 'running', variant: 'warning', color: 'var(--warning)' },
  finished: { label: 'finished', variant: 'success', color: 'var(--success)' },
  // A phase nothing came out of. Green "finished" over a row of red agents was
  // the popup contradicting itself one level down from #140's own complaint.
  failed: { label: 'failed', variant: 'destructive', color: 'var(--destructive)' },
};

/**
 * One phase, and the agents the run started inside it.
 *
 * Open by default, all of them. A run large enough for that to be a wall is
 * also a run whose reader cannot know in advance which phase they want, and a
 * heading that has to be clicked before it says anything is the thing this
 * issue was raised about. Collapsing is one click per phase, and what the
 * reader collapses stays collapsed.
 */
function PhaseSection({
  view,
  position,
  collapsed,
  opened,
  onToggle,
  onOpenAgent,
}: {
  view: WorkflowPhaseView;
  position: number;
  collapsed: boolean;
  opened: ReadonlySet<number>;
  onToggle: () => void;
  onOpenAgent: (index: number) => void;
}): React.JSX.Element {
  const type = typeScale(usePhone());
  const state = PHASE_STATE[view.state];
  const title = view.phase ? view.phase.title : 'Outside any phase';

  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onToggle();
          }
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          // Wrapped rather than sized for a phone, because there is no media
          // query to reach these styles from (see ui/touch.ts): a heading with
          // a title, two badges and a count has to survive 390px on its own.
          flexWrap: 'wrap',
          padding: '8px 16px',
          cursor: 'pointer',
          background: 'var(--muted)',
        }}
      >
        <span style={{ flex: '0 0 auto', display: 'inline-flex', color: state.color }}>
          <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={13} />
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: type.meta,
            color: 'var(--muted-foreground)',
          }}
        >
          {position}
        </span>
        <span
          style={{
            flex: '1 1 40%',
            minWidth: 0,
            fontFamily: 'var(--font-sans)',
            fontSize: type.body,
            fontWeight: 'var(--font-semibold)' as React.CSSProperties['fontWeight'],
            color: 'var(--foreground)',
            wordBreak: 'break-word',
          }}
        >
          {title}
        </span>
        {view.failed > 0 ? (
          <Badge variant="destructive">
            {view.failed} failed
          </Badge>
        ) : null}
        <Badge variant={state.variant} dot={view.state === 'running'}>
          {state.label}
        </Badge>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: type.meta,
            color: 'var(--muted-foreground)',
          }}
        >
          {view.agents.length === 1 ? '1 agent' : `${view.agents.length} agents`}
        </span>
      </div>
      {collapsed
        ? null
        : view.agents.map((agent) => (
            <AgentRow
              key={agent.index}
              agent={agent}
              open={opened.has(agent.index)}
              onToggle={() => onOpenAgent(agent.index)}
            />
          ))}
    </div>
  );
}

const AGENT_STATE: Record<
  WorkflowAgent['state'],
  { label: string; variant: 'outline' | 'warning' | 'success' | 'destructive'; color: string; icon: string }
> = {
  queued: { label: 'queued', variant: 'outline', color: 'var(--muted-foreground)', icon: 'circle' },
  running: { label: 'running', variant: 'warning', color: 'var(--warning)', icon: 'loader-circle' },
  done: { label: 'done', variant: 'success', color: 'var(--success)', icon: 'check' },
  failed: { label: 'failed', variant: 'destructive', color: 'var(--destructive)', icon: 'circle-x' },
};

/**
 * One agent inside a phase: what it is called, how it is doing, and what it is
 * doing right now — with the rest a click away.
 *
 * The failure is on the closed row rather than only inside it, because "a
 * failed agent is visible without having to open it" is the whole of one of
 * this issue's acceptance criteria, and a red badge alone says that something
 * went wrong without saying what.
 */
function AgentRow({
  agent,
  open,
  onToggle,
}: {
  agent: WorkflowAgent;
  open: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const type = typeScale(usePhone());
  const state = AGENT_STATE[agent.state] || AGENT_STATE.running;
  // Dropped once the detail is out, which says all of this and more: a failed
  // agent would otherwise print its error twice, six lines apart.
  const activity = open ? '' : currentActivity(agent);

  return (
    <div style={{ borderTop: '1px solid var(--border)' }}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onToggle();
          }
        }}
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 7,
          padding: '7px 16px 7px 30px',
          cursor: 'pointer',
        }}
      >
        <span
          style={{
            flex: '0 0 auto',
            marginTop: 2,
            color: state.color,
            animation:
              agent.state === 'running'
                ? 'relay-pulse 1.4s var(--ease-standard) infinite'
                : undefined,
          }}
        >
          <Icon name={state.icon} size={13} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: type.body,
                fontWeight: 'var(--font-semibold)' as React.CSSProperties['fontWeight'],
                color: 'var(--foreground)',
                wordBreak: 'break-word',
              }}
            >
              {agent.label}
            </span>
            <Badge variant={state.variant} dot={agent.state === 'running'}>
              {state.label}
            </Badge>
            {agent.cached ? <Badge variant="outline">cached</Badge> : null}
            {agent.blocked ? <Badge variant="destructive">blocked</Badge> : null}
            {agent.attempt !== undefined && agent.attempt > 1 ? (
              <Badge variant="outline">try {agent.attempt}</Badge>
            ) : null}
          </div>
          {activity ? (
            <div
              style={{
                marginTop: 2,
                fontFamily: 'var(--font-mono)',
                fontSize: type.body,
                lineHeight: 'var(--leading-snug)',
                color: agent.state === 'failed' ? 'var(--destructive)' : 'var(--muted-foreground)',
                wordBreak: 'break-word',
              }}
            >
              {activity}
            </div>
          ) : null}
        </div>
      </div>
      {open ? <AgentDetail agent={agent} /> : null}
    </div>
  );
}

/**
 * The line under an agent's name: what it is doing, in the run's own words.
 *
 * In the order the reader needs it. A failure is what matters about a failed
 * agent whatever it was doing when it broke; the tool in its hand is what
 * matters about a working one; and a finished agent is described by what it
 * came back with. Only an agent that has done none of those falls back to the
 * task it was given.
 */
function currentActivity(agent: WorkflowAgent): string {
  if (agent.error) return firstLine(agent.error);
  if (agent.state !== 'done' && agent.lastTool) {
    return agent.lastToolDetail
      ? `${agent.lastTool} · ${firstLine(agent.lastToolDetail)}`
      : agent.lastTool;
  }
  if (agent.result) return firstLine(agent.result);
  return firstLine(agent.prompt || '');
}

function firstLine(text: string): string {
  const line = text.split('\n').find((entry) => entry.trim()) ?? '';
  const trimmed = line.trim();
  return trimmed.length > 160 ? `${trimmed.slice(0, 157)}…` : trimmed;
}

/**
 * One agent, opened out: its task, its spend, and how it ended.
 *
 * Deliberately not its transcript — streaming every agent's messages into this
 * view is one of the issue's stated non-goals, and eight of them at once is a
 * conversation nobody can read. What the run reports about an agent is what is
 * here, in full rather than clipped to a line.
 */
function AgentDetail({ agent }: { agent: WorkflowAgent }): React.JSX.Element {
  const phone = usePhone();
  const type = typeScale(phone);
  const spend = [
    agent.toolCalls !== undefined ? `${agent.toolCalls} tool${agent.toolCalls === 1 ? '' : 's'}` : '',
    agent.tokens ? `${compactCount(agent.tokens)} tokens` : '',
    agent.durationMs ? formatDuration(agent.durationMs) : '',
  ].filter(Boolean);

  const facts = [
    agent.model ? `model ${agent.model}` : '',
    agent.fallbackModel ? `answered on ${agent.fallbackModel}` : '',
    agent.agentType ? `type ${agent.agentType}` : '',
    agent.isolation ? `in a ${agent.isolation}` : '',
    agent.lastTool ? `last tool ${agent.lastTool}` : '',
    agent.lastAttemptReason ? `retried after ${agent.lastAttemptReason}` : '',
  ].filter(Boolean);

  return (
    <div style={{ padding: '0 16px 10px 30px' }}>
      {agent.prompt ? (
        <>
          <Label text="Asked to" phone={phone} />
          <Block text={agent.prompt} phone={phone} />
        </>
      ) : null}
      {facts.length > 0 || spend.length > 0 ? (
        <div
          style={{
            marginTop: 8,
            fontFamily: 'var(--font-mono)',
            fontSize: type.meta,
            lineHeight: 'var(--leading-snug)',
            color: 'var(--muted-foreground)',
            wordBreak: 'break-word',
          }}
        >
          {[...facts, ...spend].join(' · ')}
        </div>
      ) : null}
      {agent.error ? (
        <>
          <Label text="Failed with" phone={phone} />
          <Failure text={agent.error} phone={phone} />
        </>
      ) : null}
      {agent.result ? (
        <>
          <Label text="Reported back" phone={phone} />
          <Block text={agent.result} phone={phone} />
        </>
      ) : null}
      {!agent.error && !agent.result && agent.state !== 'done' ? (
        <div
          style={{
            marginTop: 8,
            fontFamily: 'var(--font-sans)',
            fontSize: type.body,
            color: 'var(--muted-foreground)',
          }}
        >
          {agent.state === 'queued' ? 'Waiting to start.' : 'Still working.'}
        </div>
      ) : null}
    </div>
  );
}

/** A caption inside an already-inset block, where `Caption`'s padding is not. */
function Label({ text, phone }: { text: string; phone: boolean }): React.JSX.Element {
  return (
    <div
      style={{
        marginTop: 8,
        fontFamily: 'var(--font-sans)',
        fontSize: typeScale(phone).meta,
        textTransform: 'uppercase',
        letterSpacing: 'var(--tracking-caps)',
        color: 'var(--muted-foreground)',
      }}
    >
      {text}
    </div>
  );
}

function Block({ text, phone }: { text: string; phone: boolean }): React.JSX.Element {
  return (
    <pre
      style={{
        margin: '4px 0 0',
        fontFamily: 'var(--font-mono)',
        fontSize: typeScale(phone).body,
        lineHeight: 'var(--leading-normal)',
        color: 'var(--muted-foreground)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {text}
    </pre>
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
        fontSize: typeScale(usePhone()).meta,
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
  const type = typeScale(usePhone());
  return (
    <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)' }}>
      {section.title ? (
        <div
          style={{
            fontFamily: 'var(--font-sans)',
            fontSize: type.body,
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
            fontSize: type.body,
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
function Failure({ text, phone = false }: { text: string; phone?: boolean }): React.JSX.Element {
  return (
    <pre
      style={{
        margin: '6px 0 0',
        padding: '6px 8px',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--destructive-soft, rgba(220, 38, 38, 0.10))',
        fontFamily: 'var(--font-mono)',
        fontSize: typeScale(phone).meta,
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
