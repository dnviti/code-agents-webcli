import { ClaudeChatAdapterBase } from './adapter-base.js';
import { EFFORT_TIMEOUT_MS } from './constants.js';
import { str } from './util.js';

/**
 * The `/effort` half of the Claude adapter chain: writing the command, giving
 * up on an answer that never comes, and consuming the `result` that finally
 * closes it. `setEffort` is the only place `pendingEffort` is ever set; the
 * suppression it installs is what the streaming handlers upstream look at.
 */
export abstract class ClaudeChatAdapterEffort extends ClaudeChatAdapterBase {
  /**
   * Change the reasoning level of a session that is already running.
   *
   * There is no control request for this, and that was not assumed — it was
   * probed. Every plausible spelling was written to the running CLI's stdin in
   * bidirectional stream-json mode (`set_effort`, `effort`,
   * `set_reasoning_effort`) and all three came back
   * `{"subtype":"error","error":"Unsupported control request subtype: set_effort"}`,
   * on the same socket where `set_model` and `set_permission_mode` answered
   * `{"subtype":"success"}`. So the road `interrupt()` takes is closed here.
   *
   * The road that is open is the slash command, sent down the ordinary *user*
   * channel. Claude advertises it — the `init` message's `slash_commands` array
   * contains `"effort"` alongside `"model"` — and writing the line below
   * produced an assistant message and then
   * `{"type":"result","subtype":"success","total_cost_usd":0,"num_turns":0,
   * "result":"Set effort level to xhigh (this session only): ..."}`. Zero
   * dollars and zero model round trips: the CLI answers it locally. That is what
   * makes spending a turn on a button press affordable at all.
   *
   * It is nonetheless a *turn*, and everything this app knows about a
   * conversation is derived from turn structure — where one begins, what it
   * cost, how many round trips it took. So two things follow, and they are the
   * whole of why this method is longer than a write:
   *
   * First, it refuses to interleave. A control turn written while the agent is
   * working would fold a message the user never typed into a turn they did,
   * taking its costs and its round-trip count with it. `pending` is the honest
   * answer there, and a throw is how the caller is told to give it.
   *
   * Second, everything the runtime says while it is in flight is dropped on the
   * floor — the echo of the command, the assistant turn answering it, the
   * streamed tokens of that answer (see the guards in `handleStatus`,
   * `handleStreamEvent`, `handleAssistantSnapshot` and `handleUserEcho`). The
   * user pressed a button; they did not type a command. A user message they did
   * not write, answered by an assistant message about a setting, is a lie in the
   * transcript and a phantom turn in the accounting — one that would sit in the
   * turn index with its own row and its own zero-cost bill.
   *
   * The promise resolves only on Claude's own confirmation, because the caller
   * reports `live` to the user on the strength of it.
   */
  async setEffort(effort: string): Promise<void> {
    if (this.activeTurnId !== null) {
      throw new Error(
        'claude is mid-turn, and a control turn sent now would be folded into it',
      );
    }
    if (!this.alive) {
      throw new Error('claude is not running, so there is no session to change the level of');
    }
    if (this.pendingEffort) {
      throw new Error('claude is already being asked to change effort level');
    }

    // The whole state goes up before the write, not after: `handleResult` runs
    // off a stdout `data` event and cannot land inside the synchronous body of
    // the executor below, but ordering it this way means there is no
    // arrangement of the event loop in which an answer arrives with nothing
    // here to receive it.
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const settled = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const timer = setTimeout(() => {
      this.abandonEffort(
        new Error(`claude did not confirm the effort level within ${EFFORT_TIMEOUT_MS}ms`),
      );
    }, EFFORT_TIMEOUT_MS);
    this.pendingEffort = { level: effort, resolve, reject, timer, settled };
    this.writeLine({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: `/effort ${effort}` }] },
    });
    return settled;
  }

  /**
   * The `result` that closes a `/effort` turn, consumed instead of reported.
   *
   * Everything below this line in `handleResult` is skipped deliberately, and
   * each omission is the point rather than an oversight. No `turn_end`, because
   * no turn began — the user's own last turn ended long before this one was
   * written, and `activeTurnId` is left exactly as it was found. No usage, and
   * above all no visit to `turnCost`: that method moves a watermark on every
   * reading, and letting a turn Claude itself billed at `total_cost_usd: 0` and
   * `num_turns: 0` through it would consume a reading the *next* real turn needs
   * to measure itself against.
   *
   * What is taken is the level, and it is taken from Claude's own sentence:
   * "Set effort level to xhigh (this session only): ...". Reading it back rather
   * than echoing the level asked for is the difference between reporting what
   * the runtime did and reporting what this app requested — and they are the
   * same only until the day the CLI normalises a level, or accepts an alias, or
   * quietly clamps one. The level asked for is the fallback for a build that
   * words its confirmation differently, which is a small guess on top of a
   * success the runtime did report, and nothing like a guess on top of silence.
   *
   * A failed result is not a level at all. It rejects, emits nothing, and the
   * caller says `pending` — the same as never having been answered, which is
   * what it amounts to.
   */
  protected consumeEffortResult(raw: Record<string, unknown>): void {
    const pending = this.pendingEffort;
    if (!pending) return;
    this.pendingEffort = null;
    clearTimeout(pending.timer);

    const text = str(raw.result) ?? '';
    // A refusal does not look like a failure, which is the trap this reads
    // around. Asked for a level it does not have, 2.1.220 answers
    // `{"is_error":false,"subtype":"success","result":"Invalid argument: ultra.
    // Valid options are: low, medium, high, xhigh, max, ultracode, auto"}` —
    // a *successful* result whose text is a rejection. Keying off `is_error`
    // alone reported that to the user as "Now thinking at ultra."
    //
    // So the confirmation sentence is the only thing that counts as one. There
    // is no falling back to the level that was asked for: the whole reason this
    // waits for an answer at all is to report what Claude did rather than what
    // this app requested, and a fallback would quietly undo that in exactly the
    // case where the two differ.
    const confirmed = /set effort level to (\w+)/i.exec(text)?.[1];
    if (raw.is_error === true || !confirmed) {
      pending.reject(new Error(text || `claude did not confirm the effort level ${pending.level}`));
      return;
    }

    this.emit({ t: 'effort', effort: confirmed });
    pending.resolve();
  }
}
