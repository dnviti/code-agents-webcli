import {
  ChatCapabilities,
  ChatRole,
  ChatUsage,
  DiffHunk,
  EffortChoice,
  FileDiff,
  ModelChoice,
  PermissionOption,
  PlanItem,
  SlashCommand,
  ToolBlock,
  ToolKind,
  ToolStatus,
  TurnModelUsage,
  UserTurn,
  classifyTool,
  isAllowOption,
  rankedEfforts,
} from '../../../shared/chat-events.js';
import { ChatAdapterOptions, JsonRpcChatAdapter, permissionRequest } from '../adapter.js';
import { mapModelUsage } from './model-usage.js';

/**
 * Agent Client Protocol client.
 *
 * One adapter, three CLIs today (kimi, omp, opencode) and any future ACP agent
 * for nothing — which is why this one is written against the protocol rather
 * than against any of them. Where the three disagree the wire log decides:
 * everything below was checked against `.work/probes/raw/{omp,opencode,kimi}-acp.jsonl`.
 *
 * ACP inverts the usual direction of a CLI integration. The agent has no
 * filesystem of its own and no way to ask a human anything; it asks *us*, over
 * the same pipe, and blocks until we answer. So the request half of this class
 * is not an optional nicety — an adapter that only listens deadlocks the agent
 * on its first file read.
 */

/** The only protocol version any of the three captured agents accepts. */
const ACP_PROTOCOL_VERSION = 1;

/**
 * What ACP guarantees before an agent has said a word about itself.
 *
 * The optimistic half is safe: streaming chunks, thought chunks, tool calls,
 * plans, usage and permission requests are all in the protocol, so an agent
 * that never uses them simply never emits them and the UI stays quiet. The
 * pessimistic half — resume, fork, attachments — is corrected upward from the
 * handshake, because claiming them wrongly means shipping a button that fails.
 */
const ACP_BASE_CAPABILITIES: ChatCapabilities = {
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

export interface AcpChatAdapterOptions extends ChatAdapterOptions {
  /** Which CLI this instance drives. Labels errors; never changes behaviour. */
  runtime?: string;
  /** Argv that puts the CLI into ACP mode. All three spell it `acp`. */
  acpArgs?: string[];
}

/**
 * A message being assembled.
 *
 * `nativeId` is the agent's own messageId, carried on every chunk. Two chunks
 * with different ids are two different messages even inside one turn — omp
 * closes its thinking message and opens a fresh one for the answer — so this is
 * tracked rather than assuming one assistant message per prompt.
 */
interface OpenMessage {
  id: string;
  nativeId: string | null;
  role: ChatRole;
  nextIndex: number;
  /** The text/thinking block currently accepting deltas, if any. */
  open: { kind: 'text' | 'thinking'; index: number } | null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** ACP tool statuses, plus the two we can reach without the agent's help. */
function toolStatus(value: unknown): ToolStatus {
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
function toolKindOf(kind: unknown, name: string): ToolKind {
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

function permissionKind(value: unknown, optionId: string): PermissionOption['kind'] {
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

function splitLines(text: string): string[] {
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
function buildFileDiff(path: string, oldText: string | undefined, newText: string | undefined): FileDiff {
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
function contentText(block: Record<string, unknown>): string {
  if (str(block.type) === 'text') return str(block.text) || '';
  if (str(block.type) === 'resource') return str(record(block.resource).text) || '';
  return '';
}

interface ToolPayload {
  output?: string;
  diffs?: FileDiff[];
}

/** Pull display output and file changes out of a tool call's `content[]`. */
function extractToolContent(items: unknown[]): ToolPayload {
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
function turnUsage(raw: Record<string, unknown>): ChatUsage | undefined {
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
function acpModelUsage(usage: Record<string, unknown>): TurnModelUsage[] | undefined {
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

export class AcpChatAdapter extends JsonRpcChatAdapter {
  readonly runtime: string;
  capabilities: ChatCapabilities = { ...ACP_BASE_CAPABILITIES };

  private readonly acpArgs: string[];
  private nativeSessionId: string | null = null;
  private model?: string;
  /** Model value -> the window the agent published for it, where it did. */
  private readonly modelWindows = new Map<string, number>();
  /** The last window announced, so a re-read does not re-emit the same figure. */
  private reportedWindow?: number;
  /** The last occupancy announced, for the same reason and on the same rule. */
  private reportedUsed?: number;
  /**
   * The id of the config option that carries this agent's thinking level.
   *
   * The option's own `id`, never the literal `thinking`, because this is what
   * goes back as `configId` on `session/set_config_option` — and an agent that
   * names its option something else would be unsettable from a hardcoded
   * string. Null means the agent published no `thought_level` category at all,
   * which is grok's case and the reason there is a second road below.
   */
  private effortOptionId: string | null = null;
  /** The `model` config option's own id, where the agent published one. */
  private modelOptionId: string | null = null;
  /** Model value -> the effort ladder that model's `_meta` published, where it did. */
  private readonly modelEfforts = new Map<string, EffortChoice[]>();
  /** Model value -> the level that model's `_meta` said it was running at. */
  private readonly modelEffortLevels = new Map<string, string>();
  /** The level the agent said it is on. Never one this app merely asked for. */
  private effort: string | null = null;
  /** The last level announced, so a re-read does not re-emit the same one. */
  private reportedEffort?: string | null;
  private turnId: string | null = null;
  private turnStartedAt = 0;
  private current: OpenMessage | null = null;
  private counter = 0;
  /** Options offered with a pending approval, so a reply can be validated. */
  private readonly permissionOptions = new Map<string, PermissionOption[]>();
  private loadSupported = false;

  constructor(options: AcpChatAdapterOptions) {
    super(options);
    this.runtime = options.runtime || 'acp';
    this.acpArgs = options.acpArgs || ['acp'];
  }

  protected buildArgs(): string[] {
    return [...this.acpArgs, ...(this.options.extraArgs || [])];
  }

  // ---------------------------------------------------------------- handshake

  protected async handshake(): Promise<void> {
    try {
      const init = record(
        await this.call('initialize', {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: {
            // Advertised from what the caller actually gave us. Claiming a
            // filesystem we cannot serve buys an agent that reads empty files.
            fs: {
              readTextFile: Boolean(this.options.readFile),
              writeTextFile: Boolean(this.options.writeFile),
            },
            terminal: false,
          },
        }),
      );
      this.applyInitialize(init);

      const session = await this.openSession(init);
      this.applySessionConfig(record(session));
      // Before the `session` event rather than after it, which is where the
      // remembered effort goes: this event is what names the model the
      // conversation is running on, and naming the one we are one round trip
      // away from replacing would be a false start every relaunch. It also puts
      // the switch ahead of the effort ladder, which on kimi and grok alike
      // belongs to the model rather than to the session.
      await this.applyLaunchModel();

      this.emit({
        t: 'session',
        nativeSessionId: this.nativeSessionId || undefined,
        model: this.model,
        cwd: this.options.workingDir,
        capabilities: this.capabilities,
      });
      // What the agent itself said it is thinking at, before this app has asked
      // it for anything. Emitted even when the answer is null, because null is
      // the true answer for an agent with no ladder and the chip has to be told
      // to stay empty rather than keep whatever the last runtime left on it.
      this.emitEffort();
      // Awaited, unlike the codex adapter's `loadModelList`: a level applied
      // after the session reports idle is a level the conversation's first turn
      // did not run at. It costs one round trip, and it cannot fail the
      // handshake — `applyLaunchEffort` swallows the rejection into an error
      // event and lets the conversation open at whatever level the agent is
      // already on.
      await this.applyLaunchEffort();
      this.emit({ t: 'state', state: 'idle' });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({ t: 'error', message: `${this.runtime} handshake failed: ${message}`, fatal: true });
      this.emit({ t: 'state', state: 'error' });
      throw error instanceof Error ? error : new Error(message);
    }
  }

  /**
   * The MCP servers this client offers the agent.
   *
   * Only ever the question server, and only when the session wired one up. ACP
   * spells a server's environment as a list of name/value pairs rather than an
   * object, which is the one place its shape differs from every other config
   * this app writes.
   *
   * Verified against omp: the entry is accepted on `session/new`, the tool
   * appears to the model, and calling it reaches this app's socket. Note the
   * agent renames it on the way through — omp reports the call as
   * `mcp__ccweb_ask_user_question`, with a single underscore — which is why
   * nothing downstream matches on an exact tool name.
   */
  private mcpServers(): Array<Record<string, unknown>> {
    const server = this.options.askMcpServer;
    if (!server) return [];
    return [
      {
        name: server.name,
        command: server.command,
        args: server.args,
        env: Object.entries(server.env).map(([name, value]) => ({ name, value })),
      },
    ];
  }

  private applyInitialize(init: Record<string, unknown>): void {
    const agent = record(init.agentCapabilities);
    const prompt = record(agent.promptCapabilities);

    this.loadSupported = agent.loadSession === true;
    this.capabilities.attachments = prompt.image === true || prompt.embeddedContext === true;
    // `loadSession` alone, because `session/load` is the call `openSession`
    // actually makes. This used to also require `sessionCapabilities.resume`;
    // kimi, omp and opencode all publish that key so the gate never bit, and
    // then grok arrived publishing `loadSession: true` with an empty
    // `sessionCapabilities` — and loads a session perfectly well. Gating a
    // capability on a key that is not the one being used advertises the
    // opposite of the truth in the one place the app promises not to.
    this.capabilities.resume = this.loadSupported;
  }

  /**
   * Resume when we were asked to and the agent can, otherwise start fresh.
   *
   * A failed load falls back rather than aborting: the user asked for this
   * conversation, and a new session with a visible warning is a better outcome
   * than a runtime that refuses to launch because its history moved.
   */
  private async openSession(init: Record<string, unknown>): Promise<unknown> {
    const resumeId = this.options.resumeSessionId;
    if (resumeId && this.loadSupported) {
      try {
        const loaded = await this.call('session/load', {
          sessionId: resumeId,
          cwd: this.options.workingDir,
          mcpServers: this.mcpServers(),
        });
        this.nativeSessionId = resumeId;
        return loaded;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.emit({ t: 'error', message: `${this.runtime}: could not resume session: ${message}` });
      }
    }

    try {
      const created = record(
        await this.call('session/new', {
          cwd: this.options.workingDir,
          mcpServers: this.mcpServers(),
        }),
      );
      this.nativeSessionId = str(created.sessionId) || null;
      return created;
    } catch (error: unknown) {
      // An unauthenticated agent refuses here and nowhere else, and the fix is
      // a login in a terminal — so name the method it offered instead of
      // surfacing a bare RPC error.
      const methods = list(init.authMethods)
        .map((method) => str(record(method).name) || str(record(method).id))
        .filter(Boolean);
      if (methods.length) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message} — this agent needs authentication (${methods.join(', ')})`);
      }
      throw error;
    }
  }

  /**
   * `session/new` answers with the agent's config surface, not just an id.
   *
   * The model select is the only place any of these agents publishes what it can
   * run, so it is the source for `capabilities.models` and for the model the
   * session reports. Nothing here *sets* a model: no capture shows the call that
   * would, and `setModel` is left unimplemented rather than guessed.
   *
   * Two spellings, both captured live. kimi, omp and opencode answer with a
   * `configOptions` list holding a `model` option; grok answers with a `models`
   * object of its own. Reading both is not a guess at a third — an agent that
   * sends neither simply publishes no list, which is what claude does and what
   * the picker already handles.
   */
  private applySessionConfig(session: Record<string, unknown>): void {
    this.applyModelState(record(session.models));

    for (const raw of list(session.configOptions)) {
      const option = record(raw);
      if (str(option.category) !== 'model' && str(option.id) !== 'model') continue;

      const models: ModelChoice[] = [];
      for (const rawChoice of list(option.options)) {
        const choice = record(rawChoice);
        const value = str(choice.value);
        if (!value) continue;
        models.push({ value, name: str(choice.name) || value, description: str(choice.description) });
      }
      if (models.length) this.capabilities.models = models;
      this.model = str(option.currentValue) || undefined;
      // Kept for `setModel`, which needs it back as `configId`. See there for
      // why the config-option road is preferred over `session/set_model`.
      this.modelOptionId = str(option.id) || 'model';
    }
    this.applyEffortOptions(list(session.configOptions));
    this.readModelWindows(record(session.models));
    // After both spellings of the model have been read, because grok's ladder
    // belongs to a model rather than to the session and picking the wrong
    // model's would publish levels the agent will refuse.
    this.applyModelEffort();
    this.emitContextWindow();
  }

  /**
   * The thinking level, where the agent publishes it as an ACP config option.
   *
   * Alongside the `model` and `mode` categories `applySessionConfig` already
   * walks there is a `thought_level` one, and it is where kimi and omp both put
   * this. Read off `session/new` live this session — kimi answers
   * `{"type":"select","id":"thinking","name":"Thinking","category":"thought_level",
   * "currentValue":"on","options":[{"value":"off"...},{"value":"on"...}]}` and
   * omp the same shape with five levels, `off`, `auto`, `low`, `high`, `max`,
   * where `auto` carries the description "Auto-detect per prompt (low–xhigh)".
   *
   * Matched on the category first and the id second, mirroring the two-way
   * match on the model option directly above: the category is what the protocol
   * names, the id is only what these two agents happen to call theirs.
   *
   * Both publish their options cheapest-first, which is the order
   * `rankedEfforts` wants, so the list is ranked as it arrives. That puts omp's
   * `auto` in the middle of its ladder, which is where a level that picks per
   * prompt honestly belongs.
   *
   * `currentValue` is the agent describing itself, and is the only thing this
   * adapter will emit an `effort` event on the strength of. The option's id is
   * kept for the setter, which wants it back as `configId`.
   */
  private applyEffortOptions(options: unknown[]): void {
    for (const raw of options) {
      const option = record(raw);
      if (str(option.category) !== 'thought_level' && str(option.id) !== 'thinking') continue;
      const id = str(option.id);
      if (!id) continue;

      const levels: Array<{ value: string; name?: string; description?: string }> = [];
      for (const rawChoice of list(option.options)) {
        const choice = record(rawChoice);
        const value = str(choice.value);
        if (!value) continue;
        levels.push({ value, name: str(choice.name) || value, description: str(choice.description) });
      }
      if (levels.length) this.capabilities.efforts = rankedEfforts(levels);
      this.effortOptionId = id;
      this.effort = str(option.currentValue) ?? null;
    }
  }

  /**
   * Model windows, where the agent publishes them next to the model list.
   *
   * Grok does, in the `models` block of its `session/new` reply — every entry
   * carries `_meta.totalContextTokens`. That is the most authoritative source
   * there is for a window, because it is the agent describing the model it
   * will actually run: grok reports 512,000 for `grok-build` where the nearest
   * provider-catalogue entry says 256,000. Half.
   *
   * Parsed from a real capture (`.work/probes/raw/ctx-grok.jsonl`), not from a
   * schema anyone imagined. It reads nothing on the agents wired up here
   * today, which all publish their models through `configOptions` and none of
   * them a window — it starts answering the moment grok moves onto ACP (#73).
   *
   * The same `_meta` is also where grok keeps its thinking ladder, so this walk
   * collects that too rather than making a second pass over the same list. The
   * two facts arrive together because they are the same kind of fact: what this
   * particular model, as this particular agent will run it, can do.
   */
  private readModelWindows(models: Record<string, unknown>): void {
    for (const raw of list(models.availableModels)) {
      const model = record(raw);
      const id = str(model.modelId);
      const meta = record(model._meta);
      const window = num(meta.totalContextTokens);
      if (id && window !== undefined && window > 0) this.modelWindows.set(id, window);
      if (id) this.readModelEffort(id, meta);
    }
    const current = str(models.currentModelId);
    if (current) this.model = current;
  }

  /**
   * One model's thinking ladder, as grok publishes it on the model itself.
   *
   * `grok agent --no-leader stdio` (0.2.x, probed live) publishes no
   * `thought_level` config option at all. What it publishes instead is, on each
   * entry of `models.availableModels`, a `_meta` carrying
   * `supportsReasoningEffort: true`, the level that model is currently on as
   * `reasoningEffort`, and the ladder as
   * `reasoningEfforts: [{id,value,label,description,default}]`.
   *
   * That list arrives **ceiling-first** — `high`, `medium`, `low` — and
   * `rankedEfforts` ranks a list cheapest-first, so it is reversed before
   * ranking. Ranked as published, grok's cheapest level would be painted as its
   * most expensive one, which is the one thing the rank exists to get right.
   * Copied before reversing because `reverse()` is in-place and the array
   * belongs to the parsed message, not to us.
   *
   * A model with no `supportsReasoningEffort` gets no entry, and that is not an
   * omission: grok's default model `grok-build` genuinely has no such knob, so a
   * session that opens on it publishes no ladder and the control says so.
   */
  private readModelEffort(id: string, meta: Record<string, unknown>): void {
    if (meta.supportsReasoningEffort !== true) return;

    const levels: Array<{ value: string; name?: string; description?: string }> = [];
    for (const raw of list(meta.reasoningEfforts).slice().reverse()) {
      const level = record(raw);
      // `value` and `id` are the same string on every entry captured; reading
      // both means an entry that carries only one of them is still usable.
      const value = str(level.value) || str(level.id);
      if (!value) continue;
      levels.push({ value, name: str(level.label) || value, description: str(level.description) });
    }
    if (levels.length) this.modelEfforts.set(id, rankedEfforts(levels));
    const current = str(meta.reasoningEffort);
    if (current) this.modelEffortLevels.set(id, current);
  }

  /**
   * Publish the current model's ladder, for the agents that hang it there.
   *
   * Only the current model's, because only the current model's can be set:
   * grok's setter is `session/set_model`, which carries the level for the model
   * it names. Switching model therefore switches ladder, and switching to a
   * model that cannot think harder takes the ladder away entirely — which is
   * why this clears rather than leaves the previous model's levels standing.
   *
   * Returns whether the published ladder changed, so a mid-session model change
   * can tell the browser and a handshake — which is about to send the whole
   * capability set with the `session` event anyway — does not have to.
   */
  private applyModelEffort(): boolean {
    // A config option wins where the agent published one: it is the protocol's
    // own place for this, and no captured agent publishes both.
    if (this.effortOptionId) return false;

    const previous = this.capabilities.efforts;
    const efforts = this.model ? this.modelEfforts.get(this.model) : undefined;
    if (efforts) {
      this.capabilities.efforts = efforts;
      this.effort = (this.model ? this.modelEffortLevels.get(this.model) : undefined) ?? null;
    } else {
      delete this.capabilities.efforts;
      this.effort = null;
    }
    return this.capabilities.efforts !== previous;
  }

  /**
   * Announce the level the agent said it is running at.
   *
   * Deduplicated against the last one announced, exactly as the context window
   * is and for the same reason: re-reading a config surface is not news, and
   * the transcript is a durable record of what changed rather than of what was
   * checked. The first call always announces, null included.
   */
  private emitEffort(): void {
    if (this.effort === this.reportedEffort) return;
    this.reportedEffort = this.effort;
    this.emit({ t: 'effort', effort: this.effort });
  }

  /**
   * Tell the session the ladder itself changed under it.
   *
   * Sent as an empty list rather than left out when there is no ladder any
   * more: a `capabilities` event is merged field by field, so omitting the key
   * would leave the previous model's levels on offer for a model that will
   * refuse every one of them.
   */
  private publishEfforts(): void {
    this.emit({ t: 'capabilities', capabilities: { efforts: this.capabilities.efforts || [] } });
  }

  /**
   * Tell the session how big the current model's window is, if the agent said.
   *
   * Sent as its own `usage` event because it arrives at handshake time, long
   * before any turn has spent anything — waiting to attach it to a turn's
   * figures would leave the first conversation without a reading at all.
   */
  private emitContextWindow(): void {
    const window = this.model ? this.modelWindows.get(this.model) : undefined;
    if (window === undefined || window === this.reportedWindow) return;
    this.reportedWindow = window;
    // Named, because this arrives ahead of anything that says which model is
    // running now: a switch is confirmed on its own channel and the next
    // message to carry a model belongs to the turn after it. Unnamed, the
    // session files grok-4.5's 500,000 against grok-build and then retracts it.
    this.emit({
      t: 'usage',
      usage: { contextWindow: window, contextWindowSource: 'agent', contextWindowModel: this.model },
    });
  }

  /**
   * Tell the session how much of that window is occupied right now.
   *
   * ACP's own channel for this is `usage_update.used`, which omp and opencode
   * send and grok does not send once — so a grok conversation had a 512,000
   * ceiling, no reading against it, and no 80% warning it could ever reach.
   *
   * What grok sends instead is `totalTokens` in the `_meta` of every
   * `session/update`, and it is the right figure rather than a near one: across
   * the captured turn it moves 1038 → 8363 → 16,381 → 16,641 → 16,812 while
   * that turn's four requests *totalled* 65,943 tokens. It is the last
   * request's own occupancy, which is the definition this product measures
   * against; filing the turn's total here would have drawn a bar four times too
   * full and been worse than the blank it replaced.
   *
   * Deduplicated like the window above, because grok repeats the same figure on
   * every chunk of a streamed answer and a durable log should record what
   * changed rather than how often it was mentioned.
   */
  private emitContextUsed(used: number | undefined): void {
    if (used === undefined || used === this.reportedUsed) return;
    this.reportedUsed = used;
    this.emit({ t: 'usage', usage: { contextUsed: used } });
  }

  /**
   * Grok's model state: `{ currentModelId, availableModels: [{ modelId, ... }] }`.
   *
   * Captured from `session/new` and `session/load`; the same object also arrives
   * unprompted on `_x.ai/models/update`, which this client ignores because a
   * model list is not worth an extension-specific code path when the handshake
   * already carries it.
   */
  private applyModelState(state: Record<string, unknown>): void {
    const models: ModelChoice[] = [];
    for (const raw of list(state.availableModels)) {
      const choice = record(raw);
      const value = str(choice.modelId);
      if (!value) continue;
      models.push({ value, name: str(choice.name) || value, description: str(choice.description) });
    }
    if (models.length) this.capabilities.models = models;
    const current = str(state.currentModelId);
    if (current) this.model = current;
  }

  // ------------------------------------------------------------- outgoing

  async send(turn: UserTurn): Promise<void> {
    if (!this.nativeSessionId) {
      this.emit({ t: 'error', message: `${this.runtime}: no ACP session, so the turn was not sent` });
      return;
    }

    const turnId = `${this.runtime}-turn-${++this.counter}`;
    this.turnId = turnId;
    this.turnStartedAt = Date.now();
    this.emitUserMessage(turn, turnId);

    const prompt: unknown[] = [{ type: 'text', text: turn.text }];
    for (const attachment of turn.attachments || []) {
      // A resource_link, not embedded bytes: the file is already on the same
      // disk the agent runs on, and re-encoding it through this process would
      // put megabytes of base64 through a pipe carrying a live transcript.
      if (attachment.path) {
        prompt.push({
          type: 'resource_link',
          uri: `file://${attachment.path}`,
          name: attachment.name,
          mimeType: attachment.mime,
        });
      }
    }

    this.emit({ t: 'state', state: 'thinking' });
    this.call('session/prompt', { sessionId: this.nativeSessionId, prompt })
      .then((result) => this.finishTurn(turnId, result))
      .catch((error: unknown) => this.failTurn(turnId, error));
  }

  /**
   * The user's own turn, written into the transcript by the adapter.
   *
   * The log is the only record of a conversation once the process is gone, and
   * a log holding only the agent's half is not a conversation.
   */
  private emitUserMessage(turn: UserTurn, turnId: string): void {
    this.closeMessage();
    const id = `${this.runtime}-user-${++this.counter}`;
    this.emit({ t: 'msg_start', id, role: 'user', turnId });
    let index = 0;
    this.emit({ t: 'block_start', msgId: id, index, block: { kind: 'text', text: turn.text } });
    for (const attachment of turn.attachments || []) {
      index += 1;
      this.emit({
        t: 'block_start',
        msgId: id,
        index,
        block: { kind: 'image', mime: attachment.mime, url: attachment.url, alt: attachment.name },
      });
    }
    this.emit({ t: 'msg_end', msgId: id });
  }

  /**
   * Switch the model this session runs on, where the agent accepts it.
   *
   * `session/set_model` is the ACP method for this, and grok answers it —
   * probed against 0.2.112, which replied `{"model":{"Ok":"grok-4.5"}}` and
   * followed with a `models/update` naming the new one. An agent that does not
   * implement it answers `-32601` and this rejects, which is what the caller
   * already treats as "could not switch live": it falls back to the runtime's
   * own `/model` command, or to remembering the choice for the next launch.
   *
   * That fallback is why this is worth having rather than dangerous. Grok's
   * headless mode could rewrite `--model` for the next turn, and moving it onto
   * ACP would otherwise have taken a working model switch away — quietly, since
   * the picker would have gone on offering the list grok publishes.
   */
  async setModel(model: string): Promise<void> {
    if (!this.nativeSessionId) {
      throw new Error(`${this.runtime}: no session to set a model on`);
    }
    // Down the config-option road where the agent published one, because that is
    // the only road that brings the rest of the session's configuration back.
    //
    // Probed against kimi this session, switching from `kimi-k2.7-code` to
    // `~openai/gpt-mini-latest`. `session/set_model` succeeds and answers `{}` —
    // nothing about the new model at all. `session/set_config_option` with the
    // *model* option answers with the whole `configOptions` list rebuilt, and
    // the thinking ladder in it has genuinely changed: `off`/`on` before,
    // `off`/`low`/`medium`/`high`/`xhigh` after, with `currentValue` moved from
    // `on` to `high`.
    //
    // That difference is not cosmetic. Taking the `set_model` road left the chip
    // offering `on` — which the new model refuses by name — and hiding the three
    // levels it had just gained, until the conversation was relaunched.
    if (this.modelOptionId) {
      const reply = record(
        await this.call('session/set_config_option', {
          sessionId: this.nativeSessionId,
          configId: this.modelOptionId,
          value: model,
        }),
      );
      this.model = model;
      this.applySessionConfig(reply);
      this.publishEfforts();
      this.emitEffort();
      return;
    }

    await this.call('session/set_model', { sessionId: this.nativeSessionId, modelId: model });
    this.model = model;
    // The ladder belongs to the model on grok, so a model switch can hand the
    // session a different set of levels or none at all. Grok also confirms the
    // switch with a notification that says the same thing, and the second pass
    // through here is a no-op — both `applyModelEffort` and `emitEffort` only
    // speak when something actually moved.
    if (this.applyModelEffort()) this.publishEfforts();
    this.emitEffort();
    // So does the window: grok publishes one per model, and `grok-4.5` is
    // 500,000 where `grok-build` is 512,000. The config-option road gets this
    // for free because it re-reads the whole session; this road has to say it,
    // or the meter goes on measuring against the model that was left behind.
    this.emitContextWindow();
  }

  /**
   * Change how hard this agent thinks, down whichever road it published.
   *
   * Two roads, because the agents this adapter serves genuinely have two, and
   * both were probed live against the installed CLIs this session.
   *
   * kimi and omp put the level in a `thought_level` config option, and the
   * setter is `session/set_config_option` with `{ sessionId, configId, value }`.
   * It is `configId` and not `optionId`: the wrong spelling came back from kimi
   * as `-32602 Invalid params` with
   * `{"configId":{"_errors":["Invalid input: expected string, received undefined"]}}`,
   * which is about as unambiguous as a protocol gets. Every other name for the
   * method itself — `session/set_config`, `session/select_config_option`,
   * `session/set_option`, `session/setConfigOption` — answered `-32601`.
   * The reply is the whole `configOptions` list again with `currentValue`
   * already moved, so it is fed back through the same parser the handshake uses
   * rather than assuming we got the level we asked for; kimi's ladder depends on
   * the model, so a menu that changed shape is picked up in the same pass.
   *
   * grok has no such option and no `session/set_reasoning_effort` either
   * (`-32601`), and ignores `--reasoning-effort` on the `agent stdio` path —
   * launching with `low`, `medium`, `high` and a bogus value all left the level
   * it reported at `high`, because that flag belongs to headless mode. What does
   * move it is `session/set_model` carrying `_meta.reasoningEffort`, and only
   * that: `reasoningEffort` at the top level, `effort`, `reasoningEffortId` and
   * a `modelId` of `grok-4.5:low` all either errored or left the level where it
   * was.
   *
   * A rejection is left to propagate. The caller reports a failed change as
   * pending-with-reason and shows the message, and these agents write a good
   * one — kimi refuses with `Unknown thinking effort for model
   * "openrouter/moonshotai/kimi-k2.7-code": bogus_xyz` and omp with `Unknown ACP
   * thinking level: bogus_xyz`, each naming the level it would not take.
   */
  async setEffort(effort: string): Promise<void> {
    if (!this.nativeSessionId) {
      throw new Error(`${this.runtime}: no session to set a reasoning effort on`);
    }

    if (this.effortOptionId) {
      const updated = record(
        await this.call('session/set_config_option', {
          sessionId: this.nativeSessionId,
          configId: this.effortOptionId,
          value: effort,
        }),
      );
      this.applyEffortOptions(list(updated.configOptions));
      // Published unconditionally rather than on a comparison: the reply is a
      // freshly built list every time, and one capability event per level the
      // user chose is a great deal cheaper than a menu that quietly went stale.
      this.publishEfforts();
      this.emitEffort();
      return;
    }

    if (this.model && this.modelEfforts.has(this.model)) {
      // Resolving here means grok accepted the call — its reply is only
      // `{"_meta":{"model":{"Ok":"grok-4.5"}}}`. What actually moves the chip is
      // the `_x.ai/session_notification` that follows, carrying
      // `reasoning_effort`, and `handleModelChanged` emits the event off that.
      // Resolving on the acceptance is still honest: grok validates the level on
      // this call, so a level it will not run rejects here rather than being
      // silently dropped on the floor.
      await this.call('session/set_model', {
        sessionId: this.nativeSessionId,
        modelId: this.model,
        _meta: { reasoningEffort: effort },
      });
      return;
    }

    throw new Error(
      `${this.runtime} published no reasoning-effort levels${
        this.model ? ` for ${this.model}` : ''
      }, so its thinking cannot be changed from here`,
    );
  }

  /**
   * Put a launched-with model into effect, once there is a session to set it on.
   *
   * ACP has no launch flag for this either. `session/new` takes a cwd and a
   * list of MCP servers and nothing else, and the `--model` flag the bridges
   * pass belongs to these CLIs' interactive modes — nobody has watched
   * `grok agent stdio` or `kimi acp` read one, and a flag an agent refuses at
   * spawn takes the whole conversation down, which is precisely what a
   * remembered preference must never do. So the choice is applied immediately
   * afterwards, down exactly the road `setModel` takes.
   *
   * Without this the choice survived right up to the next process start and
   * then silently did not. `/clear` restarts the process in place and replays
   * the options the session was started with; so does relaunching after the
   * server restarted, or from the unavailable banner. Every turn after one of
   * those was answered and billed on the profile's model while the composer
   * went on asserting the chosen one, because the chip renders the override
   * ahead of the reported model and the per-turn "also ran" hint that would
   * have exposed it is suppressed while an override exists.
   *
   * Best-effort in the same sense as the level below: a model this agent will
   * not take must not stop the conversation opening, and it is a live
   * possibility — a model remembered from another runtime's picker is a name
   * this one has never heard of. The failure is worth a line in the transcript
   * because it is the one thing the picker cannot show by itself.
   */
  private async applyLaunchModel(): Promise<void> {
    const wanted = this.options.model;
    if (!wanted || wanted === this.model) return;
    try {
      await this.setModel(wanted);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({
        t: 'error',
        message: `${this.runtime}: could not start on model "${wanted}": ${message}`,
      });
    }
  }

  /**
   * Put a launched-with level into effect, once there is a session to put it on.
   *
   * ACP has no launch flag for this. `session/new` takes a cwd and a list of MCP
   * servers and nothing else, and the level lives in a config option — or, on
   * grok, on a model — that does not exist until the session does. So a
   * remembered choice is applied immediately afterwards, down exactly the road
   * `setEffort` takes, and the agent confirms it exactly as it would confirm a
   * change made mid-conversation.
   *
   * Best-effort in the sense the codex adapter's `loadModelList` is: a level
   * this agent will not take must not stop the conversation opening. It is a
   * live possibility rather than a theoretical one, because kimi's ladder
   * depends on the model — a level remembered under one model is refused under
   * another. Unlike a missing model list this is worth a line in the transcript,
   * since the user asked for this level and would otherwise watch the chip
   * silently disagree with the picker.
   */
  private async applyLaunchEffort(): Promise<void> {
    const wanted = this.options.effort;
    if (!wanted || wanted === this.effort) return;
    try {
      await this.setEffort(wanted);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({
        t: 'error',
        message: `${this.runtime}: could not start at reasoning effort "${wanted}": ${message}`,
      });
    }
  }

  async interrupt(): Promise<void> {
    if (!this.nativeSessionId) return;
    // A notification, not a call: the acknowledgement is the pending
    // `session/prompt` resolving with a cancelled stop reason, which the normal
    // turn-completion path already handles.
    this.notify('session/cancel', { sessionId: this.nativeSessionId });
  }

  respondPermission(requestId: string, optionId: string): void {
    const id = this.permissionWaiters.get(requestId);
    if (id === undefined) return;
    const options = this.permissionOptions.get(requestId) || [];
    this.permissionWaiters.delete(requestId);
    this.permissionOptions.delete(requestId);

    const chosen = options.find((option) => option.optionId === optionId);
    if (!chosen) {
      // An id the agent never offered cannot be selected, but the request still
      // has to be answered or the turn hangs on it forever.
      this.respond(id, { outcome: { outcome: 'cancelled' } });
      this.emit({ t: 'permission_resolved', requestId, optionId, allowed: false });
      return;
    }

    this.respond(id, { outcome: { outcome: 'selected', optionId } });
    this.emit({ t: 'permission_resolved', requestId, optionId, allowed: isAllowOption(chosen) });
  }

  // ------------------------------------------------------------- incoming

  protected handleServerRequest(
    id: number | string,
    method: string,
    params: Record<string, unknown>,
  ): void {
    switch (method) {
      case 'session/request_permission':
        this.handlePermissionRequest(id, params);
        return;
      case 'fs/read_text_file':
        void this.handleReadFile(id, params);
        return;
      case 'fs/write_text_file':
        void this.handleWriteFile(id, params);
        return;
      default:
        // Answering with an error is not optional: an unanswered request is an
        // agent that never takes another step.
        this.respondError(id, -32601, `${method} is not supported by this client`);
    }
  }

  protected handleNotification(method: string, params: Record<string, unknown>): void {
    if (method === '_x.ai/session_notification') {
      // Grok's own notification channel, which it runs *alongside* the standard
      // `session/update` one rather than instead of it. Only the one update kind
      // anybody has watched arrive on it is read here: routing the whole channel
      // into the switch below would mean any update grok chose to send down both
      // pipes got counted twice, and doubling a message chunk is a worse failure
      // than ignoring an extension nobody has captured.
      const extension = record(params.update);
      if (str(extension.sessionUpdate) === 'model_changed') this.handleModelChanged(extension);
      return;
    }
    if (method !== 'session/update') return;
    // Ahead of the switch, because the reading rides on the envelope rather
    // than on any one kind of update: the first one to carry it in the captured
    // session is an `available_commands_update` at handshake time, whose own
    // payload says nothing about usage, and it is the only reason the meter has
    // a figure before the first prompt. Only grok fills this `_meta` at all —
    // and not on every update it sends, which is why a missing reading is
    // skipped rather than read as zero. Across the
    // 1,386 updates captured from omp, opencode and kimi not one carries the
    // key — so it can never compete with their `usage_update`.
    this.emitContextUsed(num(record(params._meta).totalTokens));
    const update = record(params.update);
    const kind = str(update.sessionUpdate);

    switch (kind) {
      case 'agent_message_chunk':
        this.appendChunk('text', 'assistant', str(update.messageId), contentText(record(update.content)));
        return;
      case 'agent_thought_chunk':
        this.appendChunk('thinking', 'assistant', str(update.messageId), contentText(record(update.content)));
        return;
      case 'user_message_chunk':
        // Only seen on a replayed session; our own turns are emitted by send().
        this.appendChunk('text', 'user', str(update.messageId), contentText(record(update.content)));
        return;
      case 'tool_call':
        this.handleToolCall(update);
        return;
      case 'tool_call_update':
        this.handleToolCallUpdate(update);
        return;
      case 'available_commands_update':
        this.handleCommands(update);
        return;
      case 'usage_update':
        this.handleUsage(update);
        return;
      case 'plan':
        this.handlePlan(update);
        return;
      default:
        // session_info_update, current_mode_update and anything a newer agent
        // invents carry nothing the event model names. Ignoring them is the
        // whole point of a normalised vocabulary.
        return;
    }
  }

  /**
   * Grok saying which model, and at which thinking level, it is now running.
   *
   * The confirmation half of `setEffort`'s second road, probed live:
   * `session/set_model` with `{"modelId":"grok-4.5","_meta":{"reasoningEffort":"low"}}`
   * replies `{"_meta":{"model":{"Ok":"grok-4.5"}}}` and then sends
   * `_x.ai/session_notification` with
   * `{"sessionUpdate":"model_changed","model_id":"grok-4.5","reasoning_effort":"low"}`.
   * The reply says the call was accepted; this says what grok is actually doing,
   * which is the only thing worth putting on the chip.
   *
   * Snake_case here, camelCase in the `session/new` reply that named the same
   * two things — the same agent, in the same session. Both spellings are read
   * because a wrong guess would be indistinguishable from grok never answering,
   * and neither is invented: each was seen on the wire.
   */
  private handleModelChanged(update: Record<string, unknown>): void {
    const modelId = str(update.model_id) || str(update.modelId);
    if (modelId && modelId !== this.model) {
      this.model = modelId;
      // A different model can mean a different ladder, or no ladder — grok's
      // default `grok-build` has none at all.
      if (this.applyModelEffort()) this.publishEfforts();
    }

    const effort = str(update.reasoning_effort) || str(update.reasoningEffort);
    if (effort) {
      // Remembered against the model as well as reported, so that a later
      // switch away and back does not resurrect the level from the handshake
      // snapshot after the agent has told us it moved on.
      if (this.model) this.modelEffortLevels.set(this.model, effort);
      this.effort = effort;
    }
    this.emitEffort();
  }

  private handleCommands(update: Record<string, unknown>): void {
    const commands: SlashCommand[] = [];
    for (const raw of list(update.availableCommands)) {
      const command = record(raw);
      const name = str(command.name);
      if (!name) continue;
      commands.push({
        name,
        description: str(command.description),
        hint: str(record(command.input).hint),
      });
    }
    this.capabilities.commands = commands;
    this.emit({ t: 'capabilities', capabilities: { commands } });
  }

  private handleUsage(update: Record<string, unknown>): void {
    const cost = record(update.cost);
    // Only USD has a place in the model; another currency reported as dollars
    // would be a worse answer than no number at all.
    const costUsd = str(cost.currency) === 'USD' ? num(cost.amount) : undefined;
    this.emit({
      t: 'usage',
      usage: {
        ...(num(update.size) !== undefined
          ? { contextWindow: num(update.size), contextWindowSource: 'agent' as const }
          : {}),
        contextUsed: num(update.used),
        // Omitted rather than sent as `undefined`. A running total's fields
        // replace what came before, and the server-side accountant sees the
        // key before the JSON hop drops it — so a context report carrying no
        // money used to erase the money already reported.
        ...(costUsd !== undefined ? { costUsd } : {}),
      },
    });
  }

  private handlePlan(update: Record<string, unknown>): void {
    const items: PlanItem[] = [];
    for (const raw of list(update.entries)) {
      const entry = record(raw);
      const text = str(entry.content) || str(entry.title);
      if (!text) continue;
      const status = str(entry.status);
      items.push({
        text,
        status: status === 'in_progress' || status === 'completed' ? status : 'pending',
        priority: str(entry.priority),
      });
    }
    this.emit({ t: 'plan', items });
  }

  private handleToolCall(update: Record<string, unknown>): void {
    const toolId = str(update.toolCallId);
    if (!toolId) return;

    // ACP has no separate tool name: the title is what the agent calls it, and
    // opencode's titles ("read") are exactly that. The id is the last resort.
    const name = str(update.title) || toolId;
    const message = this.openMessage(undefined, 'assistant');
    this.closeBlock(message);

    const payload = extractToolContent(list(update.content));
    const index = message.nextIndex++;
    const block: ToolBlock = {
      kind: 'tool',
      toolId,
      name,
      title: str(update.title),
      toolKind: toolKindOf(update.kind, name),
      status: toolStatus(update.status),
      input: update.rawInput,
      locations: this.locations(update.locations),
      ...payload,
    };
    this.emit({ t: 'block_start', msgId: message.id, index, block });
    this.emit({ t: 'state', state: 'running' });
  }

  /**
   * Patch an already-open tool block.
   *
   * Sent as a `tool` event rather than a block delta because the call is
   * routinely finished after its message has closed — omp answers a file read
   * two messages later — and only `toolId` can still find it by then.
   */
  private handleToolCallUpdate(update: Record<string, unknown>): void {
    const toolId = str(update.toolCallId);
    if (!toolId) return;

    const patch: Partial<ToolBlock> = { ...extractToolContent(list(update.content)) };
    const status = update.status;
    if (status !== undefined) patch.status = toolStatus(status);
    const title = str(update.title);
    if (title) {
      patch.title = title;
      patch.toolKind = toolKindOf(update.kind, title);
    }
    if (update.rawInput !== undefined) patch.input = update.rawInput;
    const locations = this.locations(update.locations);
    if (locations) patch.locations = locations;
    if (patch.output === undefined && update.rawOutput !== undefined) {
      patch.output = this.rawOutputText(update.rawOutput);
    }
    if (patch.status === 'failed' && patch.error === undefined) {
      patch.error = patch.output || 'the tool call failed';
    }

    this.emit({ t: 'tool', toolId, patch });
  }

  private locations(value: unknown): string[] | undefined {
    const paths: string[] = [];
    for (const raw of list(value)) {
      const path = str(record(raw).path);
      if (path) paths.push(path);
    }
    return paths.length ? paths : undefined;
  }

  /** Last resort for output: agents that only fill `rawOutput`. */
  private rawOutputText(value: unknown): string | undefined {
    if (typeof value === 'string') return value;
    const output = str(record(value).output);
    if (output) return output;
    try {
      return JSON.stringify(value);
    } catch {
      // Circular or otherwise unserialisable; the tool card survives without it.
      return undefined;
    }
  }

  private handlePermissionRequest(id: number | string, params: Record<string, unknown>): void {
    const toolCall = record(params.toolCall);
    const options: PermissionOption[] = [];
    for (const raw of list(params.options)) {
      const option = record(raw);
      const optionId = str(option.optionId);
      if (!optionId) continue;
      options.push({
        optionId,
        name: str(option.name) || optionId,
        kind: permissionKind(option.kind, optionId),
      });
    }

    if (!options.length) {
      // Nothing can be chosen, so nothing can be answered — except a
      // cancellation, which at least lets the agent move on.
      this.respond(id, { outcome: { outcome: 'cancelled' } });
      this.emit({
        t: 'error',
        message: `${this.runtime}: an approval arrived with no options and was cancelled`,
      });
      return;
    }

    const requestId = `${this.runtime}-perm-${++this.counter}`;
    const title = str(toolCall.title) || 'Permission required';
    const request = permissionRequest({
      requestId,
      toolId: str(toolCall.toolCallId),
      title,
      toolKind: toolKindOf(toolCall.kind, title),
      input: toolCall.rawInput,
      diffs: extractToolContent(list(toolCall.content)).diffs,
      options,
    });

    if (this.options.bypassPermissions) {
      const allow = options.find((option) => isAllowOption(option));
      if (!allow) {
        this.respond(id, { outcome: { outcome: 'cancelled' } });
        return;
      }
      this.respond(id, { outcome: { outcome: 'selected', optionId: allow.optionId } });
      // No `permission` event: with the bypass on there is nothing to decide,
      // and the tool block already records what ran and with what arguments.
      this.emit({
        t: 'permission_resolved',
        requestId,
        optionId: allow.optionId,
        allowed: true,
        automatic: true,
      });
      return;
    }

    this.permissionOptions.set(requestId, options);
    this.permissionWaiters.set(requestId, id);
    this.emit({ t: 'permission', request });
    this.emit({ t: 'state', state: 'awaiting_permission' });
  }

  private async handleReadFile(id: number | string, params: Record<string, unknown>): Promise<void> {
    const path = str(params.path);
    const read = this.options.readFile;
    if (!read || !path) {
      this.respondError(id, -32602, 'this client cannot read files');
      return;
    }

    try {
      const contents = await read(path);
      const line = num(params.line);
      const limit = num(params.limit);
      // The agent may ask for a window rather than the file; honouring it here
      // saves sending a whole file back through the pipe to be thrown away.
      const content =
        line === undefined && limit === undefined
          ? contents
          : contents
              .split('\n')
              .slice(line === undefined ? 0 : Math.max(0, line - 1))
              .slice(0, limit === undefined ? undefined : Math.max(0, limit))
              .join('\n');
      this.respond(id, { content });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.respondError(id, -32603, message);
      this.emit({ t: 'error', message: `${this.runtime}: could not read ${path}: ${message}` });
    }
  }

  private async handleWriteFile(id: number | string, params: Record<string, unknown>): Promise<void> {
    const path = str(params.path);
    const write = this.options.writeFile;
    if (!write || !path) {
      this.respondError(id, -32602, 'this client cannot write files');
      return;
    }

    try {
      await write(path, str(params.content) || '');
      this.respond(id, {});
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.respondError(id, -32603, message);
      this.emit({ t: 'error', message: `${this.runtime}: could not write ${path}: ${message}` });
    }
  }

  // -------------------------------------------------------- message assembly

  private openMessage(nativeId: string | undefined, role: ChatRole): OpenMessage {
    const current = this.current;
    // A tool call carries no messageId; it belongs to whatever is open.
    const continues =
      current && current.role === role && (nativeId === undefined || current.nativeId === nativeId);
    if (current && continues) return current;
    if (current) this.closeMessage();

    const turnId = this.turnId || (this.turnId = `${this.runtime}-turn-${++this.counter}`);
    const id = nativeId || `${this.runtime}-msg-${++this.counter}`;
    const message: OpenMessage = { id, nativeId: nativeId ?? null, role, nextIndex: 0, open: null };
    this.current = message;
    this.emit({ t: 'msg_start', id, role, turnId, model: this.model });
    return message;
  }

  private appendChunk(
    kind: 'text' | 'thinking',
    role: ChatRole,
    nativeId: string | undefined,
    text: string,
  ): void {
    if (!text) return;
    const message = this.openMessage(nativeId, role);
    if (message.open && message.open.kind === kind) {
      this.emit({ t: 'block_delta', msgId: message.id, index: message.open.index, text });
      return;
    }

    this.closeBlock(message);
    const index = message.nextIndex++;
    this.emit({
      t: 'block_start',
      msgId: message.id,
      index,
      block: kind === 'thinking' ? { kind: 'thinking', text } : { kind: 'text', text },
    });
    message.open = { kind, index };
  }

  private closeBlock(message: OpenMessage): void {
    if (!message.open) return;
    this.emit({ t: 'block_end', msgId: message.id, index: message.open.index });
    message.open = null;
  }

  private closeMessage(stopReason?: string, usage?: ChatUsage): void {
    const message = this.current;
    if (!message) return;
    this.closeBlock(message);
    this.current = null;
    this.emit({ t: 'msg_end', msgId: message.id, stopReason, usage });
  }

  private finishTurn(turnId: string, result: unknown): void {
    const payload = record(result);
    const stopReason = str(payload.stopReason);
    // Two places, because the agents put it in two places. kimi and omp answer
    // `session/prompt` with a `usage` field; grok answers with `_meta.usage`,
    // which is where ACP tells an agent to put anything the spec does not name.
    // Reading only the first spelling filed every grok turn as free.
    const meta = record(payload._meta);
    const usage = turnUsage(record(payload.usage)) ?? turnUsage(record(meta.usage));
    const models = acpModelUsage(record(payload.usage)) ?? acpModelUsage(record(meta.usage));
    const hadMessage = this.current !== null;

    // The scalars beside `_meta.usage` are not the turn's, they are the last
    // request's — 16,616 in and 21 out against a turn total of 65,551 and 392 —
    // so the one figure taken from them is the occupancy, which is the only
    // thing the last request on its own is the right measure of. Emitted before
    // the turn closes so it lands inside the job it belongs to.
    this.emitContextUsed(num(meta.totalTokens));

    this.closeMessage(stopReason, usage);
    this.emit({
      t: 'turn_end',
      turnId,
      stopReason,
      // Counted once. msg_end already folded it into the session total, so
      // repeating it here would double every number the UI shows.
      usage: hadMessage ? undefined : usage,
      // Not subject to that rule: nothing else in the stream carries the split,
      // and it is a breakdown of the turn rather than an addition to it.
      // Grok also announces the same map on a `turn_completed` notification a
      // beat before this reply — byte-identical, checked against the capture —
      // and reading both would file every grok turn's round trips twice.
      ...(models ? { models } : {}),
      durationMs: this.turnStartedAt ? Date.now() - this.turnStartedAt : undefined,
    });
    if (this.turnId === turnId) this.turnId = null;
  }

  private failTurn(turnId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.emit({ t: 'error', message: `${this.runtime}: ${message}` });
    this.closeMessage('error');
    this.emit({ t: 'turn_end', turnId, stopReason: 'error' });
    if (this.turnId === turnId) this.turnId = null;
  }
}
