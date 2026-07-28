import {
  ChatCapabilities,
  ChatRole,
  ChatUsage,
  DiffHunk,
  FileDiff,
  ModelChoice,
  PermissionOption,
  PlanItem,
  SlashCommand,
  ToolBlock,
  ToolKind,
  ToolStatus,
  UserTurn,
  classifyTool,
  isAllowOption,
} from '../../../shared/chat-events.js';
import { ChatAdapterOptions, JsonRpcChatAdapter, permissionRequest } from '../adapter.js';

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

      this.emit({
        t: 'session',
        nativeSessionId: this.nativeSessionId || undefined,
        model: this.model,
        cwd: this.options.workingDir,
        capabilities: this.capabilities,
      });
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
    }
    this.readModelWindows(record(session.models));
    this.emitContextWindow();
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
   */
  private readModelWindows(models: Record<string, unknown>): void {
    for (const raw of list(models.availableModels)) {
      const model = record(raw);
      const id = str(model.modelId);
      const window = num(record(model._meta).totalContextTokens);
      if (id && window !== undefined && window > 0) this.modelWindows.set(id, window);
    }
    const current = str(models.currentModelId);
    if (current) this.model = current;
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
    this.emit({ t: 'usage', usage: { contextWindow: window, contextWindowSource: 'agent' } });
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
    await this.call('session/set_model', { sessionId: this.nativeSessionId, modelId: model });
    this.model = model;
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
    if (method !== 'session/update') return;
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
    const hadMessage = this.current !== null;

    this.closeMessage(stopReason, usage);
    this.emit({
      t: 'turn_end',
      turnId,
      stopReason,
      // Counted once. msg_end already folded it into the session total, so
      // repeating it here would double every number the UI shows.
      usage: hadMessage ? undefined : usage,
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
