import { ChatRole, ChatUsage } from '../../../../shared/chat-events.js';
import { acpModelUsage, num, record, str, turnUsage } from './convert.js';
import { AcpChatAdapterCore } from './state.js';
import { OpenMessage } from './types.js';

/**
 * Message assembly and turn lifecycle for the ACP adapter.
 *
 * `openMessage`/`appendChunk`/`closeBlock`/`closeMessage` build the message and
 * block stream from raw chunks; `acceptPrompt` and the `*Turn`/`*Prompt`
 * helpers reconcile the ACP v1 prompt RPC with the adapter's own send/turn
 * contract. A partial class so the outgoing and incoming partials and the final
 * concrete class can call into it.
 */
export abstract class AcpChatAdapterMessages extends AcpChatAdapterCore {
  protected openMessage(nativeId: string | undefined, role: ChatRole): OpenMessage {
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

  /**
   * Whether a chunk of this kind would land in a block that is already open.
   *
   * The same three conditions `openMessage` uses to decide it is continuing
   * rather than starting, plus the block kind — asked here so a whitespace-only
   * chunk can be told apart from one that would open something (#132).
   */
  protected continuesOpenBlock(
    kind: 'text' | 'thinking',
    role: ChatRole,
    nativeId: string | undefined,
  ): boolean {
    const current = this.current;
    return Boolean(
      current
      && current.role === role
      && (nativeId === undefined || current.nativeId === nativeId)
      && current.open?.kind === kind,
    );
  }

  protected appendChunk(
    kind: 'text' | 'thinking',
    role: ChatRole,
    nativeId: string | undefined,
    text: string,
  ): void {
    if (!text) return;
    // A blank reply is not a reply, and it must not be the thing that opens one
    // (#132). Oh My Pi sends a single space alongside the tool activity on
    // almost every step; recorded as content, it made each of those steps
    // "a step that said something" and gave it the bordered row #46 exists to
    // remove — a model name, a clock, a work counter, and nothing to read.
    //
    // Only refuses to *open*. A space arriving inside an already-open text
    // block is the space between two words, and dropping those glues the
    // sentence together: "Hello" + " " + "world" would be recorded as
    // "Helloworld". `thinking` is exempt in full — an empty reasoning block is
    // a real state that surface handles for itself (#120).
    if (kind === 'text' && !text.trim() && !this.continuesOpenBlock(kind, role, nativeId)) return;
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

  protected closeBlock(message: OpenMessage): void {
    if (!message.open) return;
    this.emit({ t: 'block_end', msgId: message.id, index: message.open.index });
    message.open = null;
  }

  protected closeMessage(stopReason?: string, usage?: ChatUsage): void {
    const message = this.current;
    if (!message) return;
    this.closeBlock(message);
    this.current = null;
    this.emit({ t: 'msg_end', msgId: message.id, stopReason, usage });
  }

  protected acceptPrompt(turnId: string | null): void {
    const pending = this.promptAcceptance;
    if (!turnId || !pending || pending.turnId !== turnId) return;
    this.promptAcceptance = null;
    pending.resolve();
  }

  protected acceptMatchingPromptEcho(chunk: string): void {
    const echo = this.promptEcho;
    if (
      !echo
      || !echo.valid
      || !this.promptRpcTurnId
      || echo.turnId !== this.promptRpcTurnId
      || !chunk
    ) return;
    const candidate = echo.received + chunk;
    if (!echo.expected.startsWith(candidate)) {
      echo.valid = false;
      return;
    }
    echo.received = candidate;
    if (candidate === echo.expected) this.acceptPrompt(echo.turnId);
  }

  protected rejectPrompt(turnId: string, error: unknown): boolean {
    const pending = this.promptAcceptance;
    if (!pending || pending.turnId !== turnId) return false;
    this.promptAcceptance = null;
    pending.reject(error instanceof Error ? error : new Error(String(error)));
    return true;
  }

  protected finishPromptRpc(turnId: string): void {
    if (this.promptRpcTurnId === turnId) {
      this.promptRpcTurnId = null;
      this.promptEcho = null;
    }
  }

  protected finishTurn(turnId: string, result: unknown): void {
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

  protected failTurn(turnId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.emit({ t: 'error', message: `${this.runtime}: ${message}` });
    this.closeMessage('error');
    this.emit({ t: 'turn_end', turnId, stopReason: 'error' });
    if (this.turnId === turnId) this.turnId = null;
  }
}
