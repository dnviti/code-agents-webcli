import {
  ChatCapabilities,
  ChatUsage,
  DiffHunk,
  FileDiff,
  PermissionOption,
  ToolKind,
  ToolStatus,
  TurnModelUsage,
  classifyTool,
} from '../../../../shared/chat-events.js';
import { mapModelUsage } from '../model-usage.js';

/** The only protocol version any of the three captured agents accepts. */
export const ACP_PROTOCOL_VERSION = 1;

/**
 * What ACP guarantees before an agent has said a word about itself.
 *
 * The optimistic half is safe: streaming chunks, thought chunks, tool calls,
 * plans, usage and permission requests are all in the protocol, so an agent
 * that never uses them simply never emits them and the UI stays quiet. The
 * pessimistic half — resume, fork, attachments — is corrected upward from the
 * handshake, because claiming them wrongly means shipping a button that fails.
 */
export const ACP_BASE_CAPABILITIES: ChatCapabilities = {
  streaming: true,
  thinking: true,
  toolCalls: true,
  diffs: true,
  permissions: true,
  interrupt: true,
  resume: false,
  // No capture shows a fork call, only that agents advertise the capability.
  // A guessed method name would fail at the moment the user needs it most, so
  // fork stays false and `fork()` is not implemented at all.
  fork: false,
  attachments: false,
  usage: true,
  cost: true,
  plan: true,
};

/**
 * ACP agents that report no tokens and no money, measured rather than assumed.
 *
 * `usage_update` is a vendor extension. omp, opencode and grok send spend on
 * one channel or another; kimi sends none of it — probed against kimi 0.29.1
 * over two prompts with zero `usage_update` notifications, prompt replies of
 * `{"stopReason":"end_turn"}` with no `usage` key, and no `_meta` on any
 * session/update. `test/fixtures/chat/acp-kimi-tools.jsonl` is one of those
 * turns, tool calls and all.
 *
 * Advertising `usage: true` for it was not a harmless optimism: the session
 * files `reportsUsage: capabilities.usage === true` into the permanent record,
 * so every kimi job went into the history as "this runtime reports usage" with
 * nothing in the columns — which the dashboard prints as "not reported", the
 * label reserved for an agent that *could* have spoken and did not.
 *
 * Named agents rather than a flag on the base set, because the honest default
 * for an ACP agent nobody has probed is still the optimistic one: the handshake
 * corrects it upward, and a turn that ends having said nothing corrects it
 * downward from evidence (see `noteSpend` in session.ts).
 */
export const NO_SPEND_REPORTING = new Set(['kimi']);

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** ACP tool statuses, plus the two we can reach without the agent's help. */
export function toolStatus(value: unknown): ToolStatus {
  switch (str(value)) {
    case 'in_progress':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
    case 'canceled':
      return 'canceled';
    default:
      return 'pending';
  }
}

/**
 * ACP's `kind` is already this app's vocabulary in all but three names, so it is
 * taken at face value and `classifyTool` is only the fallback — opencode omits
 * the kind on some updates, and an unknown value must still land somewhere.
 */
export function toolKindOf(kind: unknown, name: string): ToolKind {
  switch (str(kind)) {
    case 'read':
    case 'edit':
    case 'delete':
    case 'move':
    case 'search':
    case 'execute':
    case 'think':
    case 'fetch':
      return str(kind) as ToolKind;
    case 'switch_mode':
    case 'other':
      return 'other';
    default:
      return classifyTool(name);
  }
}

export function permissionKind(value: unknown, optionId: string): PermissionOption['kind'] {
  switch (str(value)) {
    case 'allow_once':
    case 'allow_always':
    case 'reject_once':
    case 'reject_always':
      return str(value) as PermissionOption['kind'];
    default:
      // The captured agents all send a kind; inferring from the id is the last
      // line of defence, and erring toward "reject" is the safe direction.
      return /allow|approve|accept|yes/i.test(optionId) ? 'allow_once' : 'reject_once';
  }
}

export function splitLines(text: string): string[] {
  const lines = text.split('\n');
  // A trailing newline is a terminator, not an empty final line; keeping it
  // would report every file as having one more line than it does.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Turn ACP's before/after texts into a FileDiff.
 *
 * Deliberately one hunk: ACP hands over whole file contents, and a real
 * line-level diff would mean a dependency this project does not take. Trimming
 * the common prefix and suffix keeps the hunk tight enough to read for the edits
 * agents actually make, and the result is still valid unified-diff syntax, so
 * nothing downstream has to know it was computed coarsely.
 */
export function buildFileDiff(path: string, oldText: string | undefined, newText: string | undefined): FileDiff {
  const before = oldText === undefined ? [] : splitLines(oldText);
  const after = newText === undefined ? [] : splitLines(newText);

  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const removed = before.slice(prefix, before.length - suffix);
  const added = after.slice(prefix, after.length - suffix);
  const hunks: DiffHunk[] =
    removed.length === 0 && added.length === 0
      ? []
      : [
          {
            oldStart: prefix + 1,
            oldLines: removed.length,
            newStart: prefix + 1,
            newLines: added.length,
            lines: [...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`)],
          },
        ];

  const kind: FileDiff['kind'] =
    oldText === undefined || oldText === null ? 'create' : newText === undefined ? 'delete' : 'update';

  return { path, kind, hunks, added: added.length, removed: removed.length };
}

/** Flatten one ACP ContentBlock to text; non-text blocks contribute nothing. */
export function contentText(block: Record<string, unknown>): string {
  if (str(block.type) === 'text') return str(block.text) || '';
  if (str(block.type) === 'resource') return str(record(block.resource).text) || '';
  return '';
}

export interface ToolPayload {
  output?: string;
  diffs?: FileDiff[];
}

/** Pull display output and file changes out of a tool call's `content[]`. */
export function extractToolContent(items: unknown[]): ToolPayload {
  const texts: string[] = [];
  const diffs: FileDiff[] = [];

  for (const raw of items) {
    const item = record(raw);
    const type = str(item.type);
    if (type === 'content') {
      const text = contentText(record(item.content));
      if (text) texts.push(text);
    } else if (type === 'diff') {
      const path = str(item.path);
      if (path) diffs.push(buildFileDiff(path, str(item.oldText), str(item.newText)));
    }
    // `terminal` content references a live terminal this adapter never created
    // (clientCapabilities.terminal is false), so there is nothing to show.
  }

  const payload: ToolPayload = {};
  if (texts.length) payload.output = texts.join('\n');
  if (diffs.length) payload.diffs = diffs;
  return payload;
}

/**
 * A tick is a ten-billionth of a dollar.
 *
 * Grok quotes a turn's cost only in these, on both of its entry points. The
 * ratio is not documented anywhere; it is read off a headless run that reported
 * `total_cost_usd: 0.02338` and `total_cost_usd_ticks: 233800000` for the same
 * turn. An integer count of tiny units is how you carry money without floating
 * point, so the app converts once, here, and stores dollars like everyone else.
 */
const USD_PER_TICK = 1e-10;

/**
 * ACP token counts, which spell three of the six fields differently.
 *
 * And which the agents then spell differently from each other: kimi and omp
 * report reasoning as `thoughtTokens`, grok as `reasoningTokens`. Both are read
 * because both were captured — neither is a guess at a name nobody has sent.
 */
export function turnUsage(raw: Record<string, unknown>): ChatUsage | undefined {
  const ticks = num(raw.costUsdTicks);
  const usage: ChatUsage = {
    inputTokens: num(raw.inputTokens),
    outputTokens: num(raw.outputTokens),
    totalTokens: num(raw.totalTokens),
    cacheReadTokens: num(raw.cachedReadTokens),
    cacheWriteTokens: num(raw.cachedWriteTokens),
    reasoningTokens: num(raw.thoughtTokens) ?? num(raw.reasoningTokens),
    // Spread in rather than assigned, because an explicit `costUsd: undefined`
    // is a different object from one without the key to everything that
    // compares these events — the log, the reducer's merge, and the tests.
    ...(ticks === undefined ? {} : { costUsd: ticks * USD_PER_TICK }),
  };
  const present = Object.values(usage).some((value) => value !== undefined);
  return present ? usage : undefined;
}

/**
 * Which models actually ran the turn, in the spelling ACP agents use for it.
 *
 * `mapModelUsage` reads the names claude and headless grok both publish —
 * `cacheReadInputTokens`, `costUSD`. Over ACP the same grok sends the same map
 * spelled the way it spells the turn's own totals, `cachedReadTokens` and money
 * as a count of ticks, so the entries are respelled on the way in rather than
 * teaching the shared reader a third vocabulary for one fact.
 *
 * The map is real and was being dropped whole. Off grok's `session/prompt`
 * reply, under `_meta.usage`:
 * `{"grok-build":{"inputTokens":65551,…,"modelCalls":4,"costUsdTicks":357174000}}`.
 * One key there because one model answered — but that `modelCalls` is the only
 * round-trip count grok reports at all, and a turn that delegated to a second
 * model would say so here and nowhere else.
 *
 * The tick cost passes straight through, unlike claude's, which has to be
 * rescaled: grok's `costUsdTicks` is the turn's own, and the entries sum to it
 * exactly, so a share of it would be the same number arrived at less honestly.
 */
export function acpModelUsage(usage: Record<string, unknown>): TurnModelUsage[] | undefined {
  const respelled: Record<string, unknown> = {};
  for (const [model, value] of Object.entries(record(usage.modelUsage))) {
    const fields = record(value);
    const ticks = num(fields.costUsdTicks);
    respelled[model] = {
      ...fields,
      // The agent's own spelling wins where it used it: this is a translation
      // for the agents that spell it the other way, not a correction.
      cacheReadInputTokens: num(fields.cacheReadInputTokens) ?? num(fields.cachedReadTokens),
      cacheCreationInputTokens:
        num(fields.cacheCreationInputTokens) ?? num(fields.cachedWriteTokens),
      ...(ticks === undefined ? {} : { costUSD: ticks * USD_PER_TICK }),
    };
  }
  return mapModelUsage({ modelUsage: respelled });
}
