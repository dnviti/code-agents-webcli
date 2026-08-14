import {
  PermissionOption,
  PlanItem,
  SlashCommand,
  ToolBlock,
  isAllowOption,
} from '../../../../shared/chat-events.js';
import { permissionRequest } from '../../adapter.js';
import {
  contentText,
  extractToolContent,
  list,
  num,
  permissionKind,
  record,
  str,
  toolKindOf,
  toolStatus,
} from './convert.js';
import { AcpChatAdapterOutgoing } from './outgoing.js';

/**
 * The incoming half of the ACP adapter, and the concrete class its users get.
 *
 * `handleServerRequest`/`handleNotification` route what the agent sends us to
 * the per-kind handlers — tools, permissions, file reads and writes, commands,
 * usage, plans. This partial completes the chain started by `AcpChatAdapterCore`
 * and left open by the outgoing and message-assembly partials.
 */
export class AcpChatAdapter extends AcpChatAdapterOutgoing {
  // ------------------------------------------------------------- incoming

  protected handleServerRequest(
    id: number | string,
    method: string,
    params: Record<string, unknown>,
  ): void {
    // A request made while a prompt is outstanding (permission, filesystem,
    // or a newer request kind) can only happen after the agent accepted that
    // prompt. Resolve before handling it, since handling may itself await the
    // browser or filesystem for an arbitrary amount of time.
    this.acceptPrompt(this.turnId);
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
    const sameSession = str(params.sessionId) === this.nativeSessionId;
    if (kind === 'user_message_chunk' && sameSession) {
      this.acceptMatchingPromptEcho(contentText(record(update.content)));
    }
    const updateToolId = kind === 'tool_call_update' ? str(update.toolCallId) : '';
    const newUpdateOnlyTool = Boolean(
      sameSession
      && this.promptRpcTurnId
      && updateToolId
      && !this.knownToolIds.has(updateToolId)
      && (
        str(record(params._meta).promptId)
        || update.rawInput !== undefined
        || str(update.title)
        || str(update.kind)
      ),
    );
    // ACP also sends session-level updates outside turns (commands, context
    // usage, mode/config changes). Only activity that could have been caused
    // by this prompt proves it was accepted; a delayed handshake/menu update
    // must not turn a later RPC rejection into a false success.
    if (
      kind === 'agent_message_chunk'
      || kind === 'agent_thought_chunk'
      || kind === 'tool_call'
      || kind === 'plan'
      || newUpdateOnlyTool
    ) {
      this.acceptPrompt(this.turnId);
    }

    switch (kind) {
      case 'agent_message_chunk':
        this.appendChunk('text', 'assistant', str(update.messageId), contentText(record(update.content)));
        return;
      case 'agent_thought_chunk':
        this.appendChunk('thinking', 'assistant', str(update.messageId), contentText(record(update.content)));
        return;
      case 'user_message_chunk':
        // Some agents replay history here; Grok also echoes the live prompt as
        // its first current-turn event. Only the exact correlation above is an
        // acceptance acknowledgement.
        this.appendChunk('text', 'user', str(update.messageId), contentText(record(update.content)));
        return;
      case 'tool_call':
        this.handleToolCall(update);
        return;
      case 'tool_call_update':
        if (updateToolId) this.knownToolIds.add(updateToolId);
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
  protected handleModelChanged(update: Record<string, unknown>): void {
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

  protected handleCommands(update: Record<string, unknown>): void {
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

  protected handleUsage(update: Record<string, unknown>): void {
    const cost = record(update.cost);
    // Only USD has a place in the model; another currency reported as dollars
    // would be a worse answer than no number at all.
    const costUsd = str(cost.currency) === 'USD' ? num(cost.amount) : undefined;
    this.emit({
      t: 'usage',
      usage: {
        ...(num(update.size) !== undefined
          ? {
              contextWindow: num(update.size),
              contextWindowSource: 'agent' as const,
              // Named, exactly as `emitContextWindow` names it and for the same
              // reason: an unattributed ceiling belongs to no model, so the next
              // message that says which model is running reads as a switch away
              // from one the agent never claimed — and the session takes omp's
              // own figure down and goes asking a catalogue for a worse one.
              contextWindowModel: this.model,
            }
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

  protected handlePlan(update: Record<string, unknown>): void {
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

  protected handleToolCall(update: Record<string, unknown>): void {
    const toolId = str(update.toolCallId);
    if (!toolId) return;
    this.knownToolIds.add(toolId);

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
  protected handleToolCallUpdate(update: Record<string, unknown>): void {
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

  protected locations(value: unknown): string[] | undefined {
    const paths: string[] = [];
    for (const raw of list(value)) {
      const path = str(record(raw).path);
      if (path) paths.push(path);
    }
    return paths.length ? paths : undefined;
  }

  /** Last resort for output: agents that only fill `rawOutput`. */
  protected rawOutputText(value: unknown): string | undefined {
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

  protected handlePermissionRequest(id: number | string, params: Record<string, unknown>): void {
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

  protected async handleReadFile(id: number | string, params: Record<string, unknown>): Promise<void> {
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
      this.reportRefusal('read', path, message);
    }
  }

  protected async handleWriteFile(id: number | string, params: Record<string, unknown>): Promise<void> {
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
      this.reportRefusal('write', path, message);
    }
  }

  /**
   * Tell the conversation a file operation was refused — once per turn.
   *
   * The agent is always told, every time: `respondError` has already run by the
   * time this is called, and an unanswered request is an agent that never takes
   * another step. This is only about how many times the person watching has to
   * read the same sentence.
   */
  protected reportRefusal(kind: 'read' | 'write', filePath: string, message: string): void {
    const key = `${kind}:${filePath}:${message}`;
    if (this.refusedThisTurn.has(key)) return;
    this.refusedThisTurn.add(key);
    this.emit({ t: 'error', message: `${this.runtime}: could not ${kind} ${filePath} — ${message}` });
  }
}
