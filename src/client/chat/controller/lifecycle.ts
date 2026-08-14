import { ChatControllerHandle } from './handle.js';
import { NO_CHAT_CAPABILITIES } from '../../../shared/chat-events.js';

/**
 * Simple senders and teardown: subscribe, interrupt, queue controls, dispose, reset.
 */
export abstract class ChatControllerLifecycle extends ChatControllerHandle {
  interrupt(): void {
    this.send({ type: 'chat_interrupt' });
  }

  /**
   * Withdraw a turn that has not run yet.
   *
   * Nothing is removed locally: the server answers with the whole queue, and
   * guessing at the outcome first would make the chip flicker back when the
   * turn had already started.
   */
  cancelQueued(queuedId: string): void {
    this.send({ type: 'chat_queue_cancel', queuedId });
  }

  /**
   * Send a waiting turn now, cutting short whatever is running.
   *
   * Nothing optimistic here either, and for a stronger reason than above: the
   * server decides whether this turn is still promotable at all, and a chip
   * removed locally on a click that arrived too late would leave the browser
   * showing a queue the session does not have.
   */
  sendQueuedNow(queuedId: string): void {
    this.send({ type: 'chat_queue_send_now', queuedId });
  }

  /**
   * Try a turn that could not be delivered again.
   *
   * Same rule as cancelling: the server owns the queue and answers with all of
   * it, so nothing is guessed at here.
   */
  retryQueued(queuedId: string): void {
    this.send({ type: 'chat_queue_retry', queuedId });
  }

  /** Tell the server this browser wants this conversation's live events. */
  subscribe(): void {
    this.send({ type: 'chat_subscribe' });
  }

  unsubscribe(): void {
    this.send({ type: 'chat_unsubscribe' });
  }

  /**
   * Show the mode a list row already knew, before this pane has heard anything.
   *
   * Display only — see ChatTranscript.seedBypass. Never echoed back in a
   * launch: the browser does not assert approval modes, it reports them.
   */
  seedBypass(bypassing: boolean): void {
    this.transcript.seedBypass(bypassing);
    this.options.onChange?.();
  }

  /** Release timers, e.g. when the session's tab is closed. */
  dispose(): void {
    this.cancelSeek();
    this.settlePage();
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.draftTimer = null;
    this.draftPending = null;
    this.draftListeners.clear();
    for (const pending of this.workflowRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('The conversation closed before the guided workflow was started.'));
    }
    this.workflowRequests.clear();
    this.connectionLost(false);
  }

  /**
   * Drop everything, e.g. when the session is being restarted.
   *
   * Nothing in the client calls this today — the registry drops a closed tab
   * through `drop()` -> `dispose()`, and a restart in place keeps the pane. It
   * is kept correct rather than deleted because it is the one entry point that
   * would wipe a live pane, but nothing here is load-bearing for any user-facing
   * guarantee: what a restarted conversation shows is decided by the mode its
   * opening `approvals` marker carries (see `chat_event` above), not by this.
   */
  reset(): void {
    this.cancelSeek();
    this.settlePage();
    // Not a claim either way: the next snapshot or chat_started carries the
    // record's real override, and showing a stale one in the meantime would
    // be worse than showing nothing.
    this.modelOverride = null;
    // The pin goes with it, and for the same reason: the record's own answer is
    // on its way, and a conversation being relaunched may well come back on a
    // different model — naming the old one in the meantime would be the exact
    // claim this field exists to stop the chip making.
    this.modelPinned = null;
    // The default deliberately survives: it is a fact about the account and the
    // runtime, not about the conversation being restarted, and the picker would
    // otherwise lose the only sentence that explains what the restart will open
    // on until the next join answered.
    this.modelResult = null;
    // And the effort level with it, for the same reason: the record's own value
    // is on its way and a stale one on the chip in the meantime would claim the
    // conversation is thinking at a level nothing has confirmed.
    this.effortOverride = null;
    this.effortResult = null;
    // Likewise the trimmed-history flag: it describes a log this controller is
    // no longer pointed at.
    this.turnIndexComplete = true;
    // `hydrate` clears the queue from the (absent) snapshot field, so the line
    // does not survive into a session that never accepted it.
    this.transcript.hydrate({
      sessionId: this.sessionId,
      runtime: '',
      messages: [],
      state: 'starting',
      capabilities: NO_CHAT_CAPABILITIES,
      pendingPermissions: [],
      pendingQuestions: [],
      firstSeq: 0,
      replayFrom: 0,
      cursor: 0,
      live: false,
      // Carried across the wipe rather than asserted as manual. The next
      // snapshot or `chat_started` still has the last word, but until it lands
      // the honest answer is the one the server last stated — and dropping a
      // known bypass to "asks first" for that interval is the one direction of
      // wrongness that matters, a user relaxing because the badge says the
      // agent will stop and ask (#134).
      bypassPermissions: this.transcript.bypassing,
    });
    this.options.onChange?.();
  }
}
