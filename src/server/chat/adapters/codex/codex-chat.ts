/**
 * The adapter callers actually construct: tries app-server, falls back to
 * `exec --json`. See the original class comment below.
 */
import { CodexAppServerAdapter } from './codex-app-server.js';
import { CodexExecAdapter } from './codex-exec.js';
import { NO_CHAT_CAPABILITIES } from '../../../../shared/chat-events.js';
import type { ChatCapabilities, UserTurn } from '../../../../shared/chat-events.js';
import type { AdapterEvent, ChatAdapter, ChatAdapterOptions } from '../../adapter.js';
import { initialCodexCommands } from './codex-launch.js';

export class CodexChatAdapter implements ChatAdapter {
  readonly runtime = 'codex';
  private delegate: ChatAdapter | null = null;
  private sink: (event: AdapterEvent) => void = () => {};
  private readonly undecidedCapabilities: ChatCapabilities;

  constructor(private readonly options: ChatAdapterOptions) {
    // `ChatSession` augments this before `start()`. Returning the shared
    // NO_CHAT_CAPABILITIES singleton used to mutate global state and then lose
    // the commands when a concrete delegate was selected. Both delegates seed
    // the same list independently; this object only covers the undecided gap.
    this.undecidedCapabilities = {
      ...NO_CHAT_CAPABILITIES,
      // The two delegates disagree about streaming, interruption, resume and
      // most other features. Both do report tool calls and structured file
      // changes through the shared `itemToBlock` mapper, so these are safe to
      // state before the router has selected one.
      toolCalls: true,
      diffs: true,
      commands: initialCodexCommands(options),
    };
  }

  get capabilities(): ChatCapabilities {
    return this.delegate?.capabilities ?? this.undecidedCapabilities;
  }

  get alive(): boolean {
    return this.delegate?.alive ?? false;
  }

  /**
   * Forwarded, or the readiness gate is dead for codex.
   *
   * Only the exec fallback answers this — it spawns a child per turn, and a
   * turn sent while the previous child is still exiting is refused. Left off
   * this facade, `ChatSession` read "ready" unconditionally for codex, so the
   * session wrote the user's message into the conversation and moved to
   * thinking before the send that was going to throw (#89).
   */
  get readyForTurn(): boolean {
    return this.delegate?.readyForTurn !== false;
  }

  async start(): Promise<void> {
    const buffered: AdapterEvent[] = [];
    this.sink = (event) => buffered.push(event);
    const probeOptions: ChatAdapterOptions = { ...this.options, emit: (event) => this.sink(event) };

    const primary = new CodexAppServerAdapter(probeOptions);
    // Own the probe before it can materialize a child. If start or the
    // verified teardown below fails, callers must still be able to reach the
    // exact adapter whose process may remain alive through this facade.
    this.delegate = primary;
    try {
      await primary.start();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`codex: app-server handshake failed, falling back to exec --json: ${message}`);
      // Do not start a fallback beside a probe whose container process could
      // not be verified gone. `stop()` carries that proof for both host and
      // container launches.
      await primary.stop();
      this.sink = this.options.emit; // discard the buffered probe noise; nothing is replayed
      const fallback = new CodexExecAdapter(this.options);
      // The primary is proven gone at this point. Transfer ownership before
      // fallback start for the same reason the probe is installed early: a
      // failed start must remain stoppable through the router.
      this.delegate = fallback;
      await fallback.start();
      return;
    }

    this.sink = this.options.emit;
    for (const event of buffered) this.options.emit(event);
  }

  async send(turn: UserTurn): Promise<void> {
    if (!this.delegate) throw new Error('codex adapter not started');
    return this.delegate.send(turn);
  }

  async interrupt(): Promise<void> {
    await this.delegate?.interrupt();
  }

  respondPermission(requestId: string, optionId: string): void {
    this.delegate?.respondPermission(requestId, optionId);
  }

  /**
   * Handed straight to whichever adapter is actually running.
   *
   * This is not ceremony: callers reach codex through this class and nothing
   * else, so a router that did not forward would leave `setEffort` implemented
   * on an object nobody holds, and the control would report "this runtime
   * cannot change level" about a runtime that plainly can.
   *
   * The rejection is the honest half. `setEffort` is optional on the interface
   * and its absence is how a runtime says it has no such knob — but a router
   * cannot make a method vanish when the delegate it happens to have chosen
   * lacks one, and `exec --json` lacks one for a good reason: it spawns a
   * process per turn with the prompt in argv and has no live session to change
   * anything on. So a fallback session rejects rather than resolving on a
   * promise it cannot keep. Nothing reaches this in practice — the effort menu
   * is published by the app-server adapter alone, so an exec session offers no
   * levels to pick from — which is precisely why it must not resolve if it ever
   * does.
   */
  async setEffort(effort: string): Promise<void> {
    const delegate = this.delegate;
    if (!delegate?.setEffort) {
      throw new Error('codex: this session cannot change reasoning effort without a relaunch');
    }
    await delegate.setEffort(effort);
  }

  async stop(): Promise<void> {
    await this.delegate?.stop();
  }
}


export default CodexChatAdapter;


