/**
 * Which subagents and workflows a conversation has run, derived from its own
 * transcript.
 *
 * Deliberately derived rather than reported. No runtime this app launches
 * publishes a "here are my running agents" channel — what they all do publish
 * is the tool call that spawned one, with a status that moves from pending to
 * running to completed. That is the same fact, already in the event log, and
 * reading it there means the panel is correct for every runtime rather than for
 * whichever one grew a bespoke API.
 *
 * The cost of deriving is that this is only as good as the tool names, so the
 * matching is deliberately conservative: something has to look like a delegation
 * before it is called one.
 */

import type {
  AgentRun,
  ChatMessage,
  ToolBlock,
  ToolStatus,
  WorkflowAgent,
  WorkflowPhase,
} from './chat-events.js';

/** One heading and the lines under it, as best a workflow's log can be read. */
export interface WorkflowLogSection {
  /** Null for whatever the workflow printed before its first heading. */
  title: string | null;
  lines: string[];
}

export type AgentActivityKind = 'agent' | 'workflow';

export interface AgentActivity {
  /** The tool call this came from; stable across updates to the same call. */
  toolId: string;
  kind: AgentActivityKind;
  /** The runtime's own tool name, e.g. "Agent", "Task", "Workflow". */
  tool: string;
  /** Subagent type or workflow name, when the arguments carry one. */
  name: string | null;
  /** One line describing what it was asked to do. */
  description: string | null;
  status: ToolStatus;
  /** When the call was announced, from the message that opened it. */
  startedAt: number;
  durationMs?: number;
  /** True while the call has not reported a terminal status. */
  running: boolean;
  /**
   * How many agents this holds, and how many are still going.
   *
   * Only a workflow that has reported its structure has these. Left undefined
   * rather than zeroed for everything else, so the list can tell "a workflow
   * with no agents left running" apart from "a sub-agent, which contains
   * nothing by definition" — a row reading `0 running` for a plain delegation
   * would be a count of something that was never there.
   */
  agentCount?: number;
  agentsRunning?: number;
  /**
   * How many of them failed.
   *
   * Kept apart from the row's own `status`, and deliberately: agents inside a
   * workflow fail routinely and by design — `parallel()` resolves a thrown
   * agent to `null` rather than rejecting, and a script that probes for
   * failures expects some — so the run's own verdict owns the badge and this
   * says what happened underneath it (#140). The same separation the transcript
   * already makes between a step that failed and the run that survived it.
   */
  agentsFailed?: number;
  /** Why it ended, when it ended badly and said why. */
  error?: string;
}

/** One phase of a workflow, with the agents the run put inside it. */
export interface WorkflowPhaseView {
  /** Null for agents the run started outside any phase. */
  phase: WorkflowPhase | null;
  agents: WorkflowAgent[];
  /**
   * Derived from the agents, because the runtime reports a phase once and
   * never says how it ended. A phase with nothing in it has not started.
   *
   * `failed` is for a phase where *every* agent failed, which is the one
   * reading of "this phase did not work" that cannot be argued with. A phase
   * that lost two of eight is `finished` and carries the count instead — the
   * same rule the run itself is judged by (#140).
   */
  state: 'waiting' | 'running' | 'finished' | 'failed';
  failed: number;
}

/** A workflow run, grouped and counted for display. */
export interface WorkflowSummary {
  phases: WorkflowPhaseView[];
  total: number;
  queued: number;
  running: number;
  done: number;
  failed: number;
  /** The phase the run is working in now, or null between and after them. */
  current: WorkflowPhaseView | null;
  /** True when the run has reported no phases and no agents. */
  empty: boolean;
}

const WORKFLOW_PATTERN = /workflow/i;

/**
 * Whether this call launched a workflow run.
 *
 * Exported so the reducer can find the runs left in flight when the app stops
 * being able to observe them (#116). Two ways of knowing, and either is
 * enough: the tool's name, and the run having reported phases of its own.
 */
export function isWorkflowLaunch(name: string, hasWorkflowRun: boolean): boolean {
  return hasWorkflowRun || WORKFLOW_PATTERN.test(String(name || '').trim());
}
/**
 * `Agent` and `Task` are the two names the CLIs in this app use for "run a
 * subagent". Anchored rather than substring-matched: `TaskList`, `TodoWrite`
 * and `MultiEdit` all contain one of these words and none of them delegates
 * anything.
 */
const AGENT_PATTERN = /^(agent|task|subagent|dispatch_agent|run_agent)$/i;

/**
 * The statuses that mean a call is over.
 *
 * Exported because the adapters need the same answer: a workflow's launching
 * call is settled by the run's own report, and "is this report a terminal one"
 * has to be the same question there as it is here (#116).
 */
export const TERMINAL_TOOL: ReadonlySet<ToolStatus> = new Set<ToolStatus>([
  'completed',
  'failed',
  'denied',
  'canceled',
  // Over, whatever happened to it. A call nothing will ever report on again is
  // not still working, so it leaves the running group and the count (#139).
  'unknown',
]);

const TERMINAL = TERMINAL_TOOL;

function classify(name: string): AgentActivityKind | null {
  const trimmed = String(name || '').trim();
  if (!trimmed) return null;
  if (WORKFLOW_PATTERN.test(trimmed)) return 'workflow';
  if (AGENT_PATTERN.test(trimmed)) return 'agent';
  return null;
}

function readInput(block: ToolBlock): Record<string, unknown> | null {
  const input = block.input;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return null;
}

function firstString(
  input: Record<string, unknown> | null,
  keys: string[],
): string | null {
  if (!input) return null;
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/** One line, from whichever field the runtime happened to put it in. */
function describe(block: ToolBlock, input: Record<string, unknown> | null): string | null {
  const text =
    firstString(input, ['description', 'prompt', 'task', 'instructions', 'query']) ??
    block.title ??
    null;
  if (!text) return null;
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 140 ? `${oneLine.slice(0, 137)}...` : oneLine;
}

/**
 * Every delegation in the transcript, oldest first.
 *
 * A tool call appears once however many times it was patched: the reducer
 * mutates the block in place, so walking the messages sees the current state of
 * each call rather than a history of its updates.
 */
export function collectAgentActivity(messages: ChatMessage[]): AgentActivity[] {
  const activity: AgentActivity[] = [];
  const seen = new Set<string>();

  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.kind !== 'tool') continue;

      const kind = classify(block.name);
      if (!kind) continue;
      if (seen.has(block.toolId)) continue;
      seen.add(block.toolId);

      const input = readInput(block);
      const inside = block.agent?.workflow;
      activity.push({
        toolId: block.toolId,
        kind,
        tool: block.name,
        name:
          firstString(input, ['subagent_type', 'agent_type', 'name', 'workflow', 'agentType'])
          // The run's own name, for the ordinary case where the call carries an
          // inline script and no name at all.
          ?? block.agent?.workflowName
          ?? null,
        description: describe(block, input),
        status: block.status,
        startedAt: message.ts,
        // The run's own elapsed time when it reports one. A workflow's
        // launching call has no duration of its own — it returned in seconds —
        // so the row showed nothing while its popup counted up through nine
        // minutes, which is two answers to one question (#116).
        durationMs: block.agent?.durationMs ?? block.durationMs,
        running: !TERMINAL.has(block.status),
        agentCount: inside ? inside.agents.length : undefined,
        agentsRunning: inside
          ? inside.agents.filter((agent) => !SETTLED.has(agent.state)).length
          : undefined,
        agentsFailed: inside
          ? inside.agents.filter((agent) => agent.state === 'failed').length
          : undefined,
        // The run's own word ahead of the block's: for a workflow the block
        // holds whichever of the two the reducer wrote last, and the run is the
        // one that knows why it stopped.
        error: block.agent?.error ?? block.error,
      });
    }
  }

  return activity;
}

/** How many are still going, for the panel's badge. */
export function countRunning(activity: AgentActivity[]): number {
  return activity.reduce((total, entry) => total + (entry.running ? 1 : 0), 0);
}

const SETTLED: ReadonlySet<string> = new Set(['done', 'failed']);

/**
 * A workflow run, grouped into its phases and counted.
 *
 * Every declared phase appears, in the run's own order, whether or not it has
 * started anything — the point of the list is to show what the run is going to
 * do as much as what it has done. Agents keep the order the run started them
 * in, which is the order the reader watched them appear.
 *
 * An agent whose phase is not among the reported ones still gets a row: a
 * `phase()` called from inside a stage names itself on the agent before the
 * phase list catches up, and dropping it would hide a working agent because
 * its heading was late.
 */
export function summarizeWorkflow(run: AgentRun | null | undefined): WorkflowSummary {
  const phases = run?.workflow?.phases ?? [];
  const agents = run?.workflow?.agents ?? [];

  const groups = new Map<number | null, WorkflowPhaseView>();
  const order: (number | null)[] = [];
  const group = (key: number | null, phase: WorkflowPhase | null): WorkflowPhaseView => {
    let found = groups.get(key);
    if (!found) {
      found = { phase, agents: [], state: 'waiting', failed: 0 };
      groups.set(key, found);
      order.push(key);
    }
    // A phase reported after one of its agents fills in the heading that agent
    // could only guess at from `phaseTitle`.
    if (phase && !found.phase) found.phase = phase;
    return found;
  };

  for (const phase of phases) group(phase.index, phase);
  for (const agent of agents) {
    const key = agent.phaseIndex ?? null;
    const view = group(
      key,
      key === null
        ? null
        : { index: key, title: agent.phaseTitle || `Phase ${key}` },
    );
    view.agents.push(agent);
  }

  const counts = { queued: 0, running: 0, done: 0, failed: 0 };
  for (const view of groups.values()) {
    let live = false;
    for (const agent of view.agents) {
      counts[agent.state] += 1;
      if (agent.state === 'failed') view.failed += 1;
      if (!SETTLED.has(agent.state)) live = true;
    }
    view.state = live
      ? 'running'
      : view.agents.length === 0
        ? 'waiting'
        : view.failed === view.agents.length
          ? 'failed'
          : 'finished';
  }

  const ordered = order.map((key) => groups.get(key) as WorkflowPhaseView);
  return {
    phases: ordered,
    total: agents.length,
    ...counts,
    // The last one working, not the first: a pipeline keeps an earlier phase
    // open while a later one starts, and the run is further along than the
    // earliest thing still in flight.
    current: [...ordered].reverse().find((view) => view.state === 'running') ?? null,
    empty: phases.length === 0 && agents.length === 0,
  };
}

/**
 * The live block behind a delegation, by its tool id.
 *
 * The reducer mutates a tool block in place as patches arrive (see the note
 * above `collectAgentActivity`), so the first match found is never stale —
 * there is only ever one object for a given `toolId`, and this is it.
 */
export function findToolBlock(messages: ChatMessage[], toolId: string): ToolBlock | null {
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.kind === 'tool' && block.toolId === toolId) return block;
    }
  }
  return null;
}

/**
 * Lines that look like a heading, in whatever narrator style a workflow
 * script happens to use: a leading tree-drawing glyph, or the word "phase"
 * or "stage" spelled out.
 */
const HEADING = /^\s*(?:[▸▶►→•·#]+\s+|(?:phase|stage)\s*:?\s+)(.+)$/i;

/**
 * A workflow's streamed output, split into the sections its own headings
 * mark — or, failing that, one section holding the whole log.
 *
 * This is about the log and only the log. It used to say there was no
 * structured channel at all, which was the belief behind a popup that said
 * "waiting for the first stage" for a whole run: the runtime does report while
 * it works, on the same task channel a delegation uses (#45). What arrives
 * there is what the run is doing now; the log is what it narrated. This is a
 * best effort at the phase structure inside that narration, and it degrades to
 * a flat log rather than guessing at structure that is not there.
 */
export function parseWorkflowLog(output: string | undefined): WorkflowLogSection[] {
  const sections: WorkflowLogSection[] = [];
  let current: WorkflowLogSection = { title: null, lines: [] };

  for (const raw of (output || '').split('\n')) {
    const line = raw.trimEnd();
    const heading = HEADING.exec(line);
    if (heading) {
      if (current.title !== null || current.lines.length > 0) sections.push(current);
      current = { title: heading[1].trim(), lines: [] };
    } else if (line.trim()) {
      current.lines.push(line);
    }
  }
  if (current.title !== null || current.lines.length > 0) sections.push(current);
  return sections;
}
