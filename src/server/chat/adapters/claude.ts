import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { BaseChatAdapter } from '../adapter.js';
import {
  ChatAttachment,
  ChatBlock,
  ChatCapabilities,
  ChatUsage,
  UserTurn,
  classifyTool,
} from '../../../shared/chat-events.js';

/**
 * Anthropic streaming-JSON adapter (`claude -p --output-format stream-json`).
 *
 * The protocol runs two tracks that this adapter has to reconcile into one
 * transcript: `stream_event` carries the live token-by-token deltas (the
 * source of everything the UI animates), while `assistant`/`user` carry
 * complete snapshots that arrive slightly after the stream events they
 * describe. Snapshots are used only to patch what streaming already built
 * (tool input, tool results) — treating them as new messages would double
 * every turn.
 *
 * A `turnId` is minted once per `send()` and reused for every assistant
 * message that follows, because Claude's own agentic loop can round-trip
 * through the model more than once (tool call, then a second response) for
 * a single user prompt, and all of that belongs to one turn from the UI's
 * point of view. It is retired when `result` arrives.
 */
export class ClaudeChatAdapter extends BaseChatAdapter {
  readonly runtime = 'claude';

  readonly capabilities: ChatCapabilities = {
    streaming: true,
    thinking: true,
    toolCalls: true,
    // Claude reports edits as free-form tool input, not a structured diff;
    // deriving one is a later phase's job.
    diffs: false,
    // The MCP permission bridge that would make an allow/deny button do
    // something has not landed yet.
    permissions: false,
    interrupt: true,
    resume: true,
    fork: false,
    attachments: true,
    usage: true,
    cost: true,
    plan: false,
  };

  /** Session id we generated for a fresh launch, before init echoes it back. */
  private freshSessionId?: string;
  private nativeSessionId?: string;
  private activeTurnId: string | null = null;
  /** Id of the assistant message currently streaming, or null between turns. */
  private currentMsgId: string | null = null;
  /** Captured from message_delta, applied when message_stop closes the message. */
  private pendingStopReason?: string;
  private pendingUsage?: ChatUsage;
  /** Indices of open tool_use blocks in the current message, cleared per message. */
  private readonly openToolIndices = new Set<number>();

  protected buildArgs(): string[] {
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
    ];

    if (this.options.resumeSessionId) {
      args.push('--resume', this.options.resumeSessionId);
    } else {
      // Generated here rather than reusing options.sessionId: that id is
      // this app's own session identifier, and --session-id rejects
      // anything that is not a UUID.
      this.freshSessionId = randomUUID();
      args.push('--session-id', this.freshSessionId);
    }

    if (this.options.bypassPermissions) {
      args.push('--dangerously-skip-permissions');
    }
    if (this.options.model) {
      args.push('--model', this.options.model);
    }
    if (this.options.extraArgs) {
      args.push(...this.options.extraArgs);
    }

    return args;
  }

  async send(turn: UserTurn): Promise<void> {
    this.activeTurnId = randomUUID();
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: turn.text }];
    for (const attachment of turn.attachments ?? []) {
      content.push(this.attachmentBlock(attachment));
    }
    this.writeLine({ type: 'user', message: { role: 'user', content } });
  }

  private attachmentBlock(attachment: ChatAttachment): Record<string, unknown> {
    if (attachment.mime.startsWith('image/') && attachment.path) {
      try {
        const data = readFileSync(attachment.path).toString('base64');
        return { type: 'image', source: { type: 'base64', media_type: attachment.mime, data } };
      } catch {
        // Fall through to the text reference below: a moved or unreadable
        // path must not stop the rest of the turn from reaching the runtime.
      }
    }
    // Non-image attachments, and images we could not read ourselves: point
    // Claude at the file so its own Read tool can pull it in, rather than
    // guessing at a document content-block shape nothing here confirms.
    const where = attachment.path || attachment.url;
    return { type: 'text', text: `[attached file: ${attachment.name} at ${where}]` };
  }

  async interrupt(): Promise<void> {
    // Verified against the installed CLI's own bundle, not just --help
    // (which only documents flags, never the stdin wire protocol): the
    // compiled client sends exactly this shape for its own stop button.
    this.writeLine({
      type: 'control_request',
      request_id: randomUUID(),
      request: { subtype: 'interrupt' },
    });
  }

  respondPermission(_requestId: string, _optionId: string): void {
    // capabilities.permissions is false, so the UI has no button that calls
    // this yet; kept as a no-op until the MCP permission bridge lands.
  }

  protected handleMessage(message: unknown): void {
    const raw = record(message);
    if (!raw) return;

    switch (str(raw.type)) {
      case 'system':
        this.handleSystem(raw);
        return;
      case 'stream_event':
        this.handleStreamEvent(raw);
        return;
      case 'assistant':
        this.handleAssistantSnapshot(raw);
        return;
      case 'user':
        this.handleUserEcho(raw);
        return;
      case 'result':
        this.handleResult(raw);
        return;
      case 'rate_limit_event':
        // Quota telemetry with nothing in the chat model to hold it; treating
        // it as an error would alarm the user over something that has not
        // actually failed.
        return;
      default:
        return;
    }
  }

  private handleSystem(raw: Record<string, unknown>): void {
    const subtype = str(raw.subtype);
    if (subtype === 'init') {
      this.handleInit(raw);
      return;
    }
    if (subtype === 'status') {
      this.handleStatus(raw);
      return;
    }
    // hook_started / hook_response / anything else is session-internal
    // plumbing a transcript viewer has no use for.
  }

  private handleInit(raw: Record<string, unknown>): void {
    const sessionId = str(raw.session_id) ?? this.freshSessionId ?? this.options.resumeSessionId;
    this.nativeSessionId = sessionId;

    const slashCommands = Array.isArray(raw.slash_commands) ? (raw.slash_commands as unknown[]) : [];
    const commands = slashCommands
      .map((name) => (typeof name === 'string' ? { name } : null))
      .filter((c): c is { name: string } => c !== null);

    this.emit({
      t: 'session',
      nativeSessionId: sessionId,
      model: str(raw.model),
      cwd: str(raw.cwd),
      capabilities: commands.length > 0 ? { ...this.capabilities, commands } : this.capabilities,
    });
    // Nothing is running yet; the first `system/status: requesting` (sent
    // once a prompt actually lands) is what moves this on to `thinking`.
    this.emit({ t: 'state', state: 'idle' });
  }

  private handleStatus(raw: Record<string, unknown>): void {
    const status = str(raw.status);
    if (status === 'requesting') {
      this.emit({ t: 'state', state: 'thinking' });
      return;
    }
    // Other status strings are not documented by --help and are not
    // exercised by the recorded traffic; skipping is safer than guessing a
    // ChatState for them.
  }

  private handleStreamEvent(raw: Record<string, unknown>): void {
    const event = record(raw.event);
    if (!event) return;

    switch (str(event.type)) {
      case 'message_start':
        this.handleMessageStart(event);
        return;
      case 'content_block_start':
        this.handleContentBlockStart(event);
        return;
      case 'content_block_delta':
        this.handleContentBlockDelta(event);
        return;
      case 'content_block_stop':
        this.handleContentBlockStop(event);
        return;
      case 'message_delta':
        this.handleMessageDelta(event);
        return;
      case 'message_stop':
        this.handleMessageStop();
        return;
      default:
        // `ping` and any future event type need no translation.
        return;
    }
  }

  private handleMessageStart(event: Record<string, unknown>): void {
    const message = record(event.message);
    this.currentMsgId = (message && str(message.id)) || randomUUID();
    this.openToolIndices.clear();

    if (!this.activeTurnId) {
      // A message_start with no turn in flight means send() was never
      // called for it -- better to invent a turnId than to drop the message.
      this.activeTurnId = randomUUID();
    }

    this.emit({
      t: 'msg_start',
      id: this.currentMsgId,
      role: 'assistant',
      turnId: this.activeTurnId,
      model: message ? str(message.model) : undefined,
    });
  }

  private handleContentBlockStart(event: Record<string, unknown>): void {
    if (!this.currentMsgId) return;
    const index = num(event.index);
    const contentBlock = record(event.content_block);
    if (index === undefined || !contentBlock) return;

    let block: ChatBlock;
    const kind = str(contentBlock.type);
    if (kind === 'text') {
      block = { kind: 'text', text: str(contentBlock.text) ?? '' };
    } else if (kind === 'thinking') {
      block = { kind: 'thinking', text: str(contentBlock.thinking) ?? '', signature: str(contentBlock.signature) };
    } else if (kind === 'tool_use') {
      const toolId = str(contentBlock.id);
      if (!toolId) return; // no way to route later patches without one
      const name = str(contentBlock.name) ?? 'tool';
      this.openToolIndices.add(index);
      block = {
        kind: 'tool',
        toolId,
        name,
        toolKind: classifyTool(name),
        status: 'pending',
        // `input` stays unset: Claude streams it as input_json_delta
        // fragments that only parse once the block closes, and
        // content_block.input here is just the {} snapshot at announce time.
        // Setting it now would make the reducer skip the real parse later.
      };
    } else {
      // Anthropic has added block types before without documenting them
      // anywhere --help reaches; render as empty text so later deltas
      // addressed to this index still land somewhere instead of vanishing.
      block = { kind: 'text', text: '' };
    }

    this.emit({ t: 'block_start', msgId: this.currentMsgId, index, block });
  }

  private handleContentBlockDelta(event: Record<string, unknown>): void {
    if (!this.currentMsgId) return;
    const index = num(event.index);
    const delta = record(event.delta);
    if (index === undefined || !delta) return;

    switch (str(delta.type)) {
      case 'text_delta':
        this.emit({ t: 'block_delta', msgId: this.currentMsgId, index, text: str(delta.text) ?? '' });
        return;
      case 'thinking_delta':
        this.emit({ t: 'block_delta', msgId: this.currentMsgId, index, text: str(delta.thinking) ?? '' });
        return;
      case 'input_json_delta':
        this.emit({ t: 'block_delta', msgId: this.currentMsgId, index, json: str(delta.partial_json) ?? '' });
        return;
      default:
        // signature_delta and anything else carries no renderable content.
        return;
    }
  }

  private handleContentBlockStop(event: Record<string, unknown>): void {
    if (!this.currentMsgId) return;
    const index = num(event.index);
    if (index === undefined) return;

    // A tool_use block closing means its arguments finished streaming and
    // the call is about to run, not that the runtime is done with it -- the
    // result lands later, out of band, as a `user` tool_result message.
    const wasTool = this.openToolIndices.delete(index);
    this.emit({
      t: 'block_end',
      msgId: this.currentMsgId,
      index,
      ...(wasTool ? { block: { status: 'running' } } : {}),
    });
  }

  private handleMessageDelta(event: Record<string, unknown>): void {
    const delta = record(event.delta);
    this.pendingStopReason = delta ? str(delta.stop_reason) : undefined;
    const usageRaw = record(event.usage);
    this.pendingUsage = usageRaw ? mapUsage(usageRaw) : undefined;
  }

  private handleMessageStop(): void {
    if (!this.currentMsgId) return;
    this.emit({
      t: 'msg_end',
      msgId: this.currentMsgId,
      stopReason: this.pendingStopReason,
      usage: this.pendingUsage,
    });
    this.currentMsgId = null;
    this.pendingStopReason = undefined;
    this.pendingUsage = undefined;
    this.openToolIndices.clear();
  }

  /**
   * The complete message, arriving just after the stream events that built
   * it. Used only to reconcile tool input in case reassembling the streamed
   * fragments ever disagrees with what Claude actually sent (a fragment
   * boundary landing inside a multi-byte escape, say) -- never to create a
   * second copy of the message.
   */
  private handleAssistantSnapshot(raw: Record<string, unknown>): void {
    const message = record(raw.message);
    const content = message && Array.isArray(message.content) ? (message.content as unknown[]) : [];
    for (const entry of content) {
      const block = record(entry);
      if (!block || str(block.type) !== 'tool_use') continue;
      const toolId = str(block.id);
      if (!toolId) continue;
      // This snapshot arrives before content_block_stop (verified against
      // the fixture), so the reducer's own inputPartial cleanup -- which
      // only runs when `input` is still unset at block_end -- never fires.
      // Clearing it here too avoids leaving a stale fragment string sitting
      // next to the now-correct parsed input.
      this.emit({ t: 'tool', toolId, patch: { input: block.input, inputPartial: undefined } });
    }
  }

  /** A `user` message here is Claude echoing tool results, never a human turn. */
  private handleUserEcho(raw: Record<string, unknown>): void {
    const message = record(raw.message);
    const content = message && Array.isArray(message.content) ? (message.content as unknown[]) : [];
    for (const entry of content) {
      const block = record(entry);
      if (!block || str(block.type) !== 'tool_result') continue;
      const toolId = str(block.tool_use_id);
      if (!toolId) continue;

      const failed = block.is_error === true;
      const output = toolResultText(block.content);
      this.emit({
        t: 'tool',
        toolId,
        patch: failed ? { status: 'failed', output, error: output } : { status: 'completed', output },
      });
    }
  }

  private handleResult(raw: Record<string, unknown>): void {
    const subtype = str(raw.subtype);
    const isError = raw.is_error === true;

    const usageRaw = record(raw.usage);
    const costUsd = num(raw.total_cost_usd);
    const usage: ChatUsage | undefined =
      usageRaw || costUsd !== undefined
        ? { ...(usageRaw ? mapUsage(usageRaw) : {}), ...(costUsd !== undefined ? { costUsd } : {}) }
        : undefined;

    const sessionId = str(raw.session_id);
    if (sessionId) this.nativeSessionId = sessionId;

    if (isError) {
      // turn_end has no field for "why" -- surface the failure as its own
      // event so it actually lands in the transcript, the same path a
      // mid-stream error already takes.
      this.emit({
        t: 'error',
        message: str(raw.result) || `claude ended the turn as ${subtype ?? 'an error'}`,
      });
    }

    // num_turns (the internal round-trip count for this turn) has nowhere
    // to go: turn_end carries stopReason/usage/durationMs only. Dropped
    // rather than misfiled into one of those.
    this.emit({
      t: 'turn_end',
      turnId: this.activeTurnId ?? randomUUID(),
      stopReason: str(raw.stop_reason) ?? subtype,
      usage,
      durationMs: num(raw.duration_ms),
    });
    this.activeTurnId = null;
    this.currentMsgId = null;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function mapUsage(raw: Record<string, unknown>): ChatUsage {
  return {
    inputTokens: num(raw.input_tokens),
    outputTokens: num(raw.output_tokens),
    cacheWriteTokens: num(raw.cache_creation_input_tokens),
    cacheReadTokens: num(raw.cache_read_input_tokens),
  };
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const p = record(part);
        return p ? str(p.text) ?? '' : '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

export default ClaudeChatAdapter;
