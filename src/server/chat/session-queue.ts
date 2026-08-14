/*
 * ChatSessionQueue: turn queue: send, enqueue, drain, retry, promote, clear, and delivery to the runtime.
 * Part of the split ChatSession implementation chain in src/server/chat.
 */
import { ChatSessionContinuations } from './session-continuations.js';
import * as path from 'path';
import * as crypto from 'crypto';
import { UserTurn, MAX_QUEUED_TURNS, QueuedTurn, planModeDirective } from '../../shared/chat-events.js';
import { isClearingCommand, isSlashCommand } from '../../shared/slash-commands.js';
import { builtInWorkflowInstructions } from './builtin-workflows.js';
import { ChatNotRunningError, QueueFullError } from './session-errors.js';
import { INTERRUPT_ACK_WINDOW_MS, QUEUE_READY_TIMEOUT_MS, QUEUE_READY_POLL_MS } from './session-constants.js';
import { PLAN_SAFE_SLASH_COMMANDS, questionToolDirective, questionFallbackDirective } from './session-question-helpers.js';
import { quoteTurn } from './session-quote.js';
export abstract class ChatSessionQueue extends ChatSessionContinuations {
  async send(turn: UserTurn): Promise<'accepted' | 'queued'> {
    // The WebSocket admission checks this too, but the queue may wait while a
    // different screen turns Plan mode on. Keep the final gate beside delivery
    // so a previously accepted workflow never contradicts that safety mode.
    if (turn.workflow && this.planMode) {
      throw new Error('Turn Plan mode off before starting a workflow that can create a GitHub issue.');
    }
    // A conversation being replaced has no adapter for a moment, and refusing
    // here is what put the "this chat is not running" recovery offer in front
    // of someone who had just cleared and started typing. It is starting, not
    // gone: the turn waits the way it would for any other busy session and
    // goes out when the new process reports idle.
    if (this.restarting) {
      this.enqueue(turn);
      return 'queued';
    }

    if (!this.adapter || !this.adapter.alive) {
      throw new ChatNotRunningError();
    }

    // Never queued. Clearing is not another thing to say to the agent, it is
    // the end of saying things to *this* agent — a `/clear` waiting behind the
    // answer it was meant to cut short would sit there for as long as that
    // answer ran, and anything queued behind it goes to a process that is
    // about to be replaced. Taking it now is also what makes the button and
    // the three spellings one behaviour rather than four.
    if (!turn.workflow && isClearingCommand(turn.text)) {
      await this.deliver(turn);
      return 'accepted';
    }

    // `adapterReady` matters here as much as in the drain: pressing Enter the
    // instant a turn ends puts a message through this path, not the queue's,
    // and the adapter is no readier for it (#89). Queued rather than refused —
    // the line is drained the moment it can be.
    const ready = this.adapterReady;
    if (this.state !== 'idle' || this.queue.length > 0 || !ready) {
      this.enqueue(turn);
      // Only this case needs a push. Everything else is waiting on an event
      // that is certain to come — the running turn's end — but a session that
      // is *already* idle has had its last event, and a turn parked here for
      // an adapter still letting go of the previous process would wait for a
      // drain that nothing was ever going to trigger.
      if (this.state === 'idle' && !ready) this.drainQueue();
      return 'queued';
    }

    try {
      await this.deliver(turn);
    } catch (error: unknown) {
      // Kept, not thrown back at a browser that has already cleared the box it
      // was typed in. A message that could not be handed over goes into the
      // line with the reason on it, exactly like one that failed on its way out
      // of the queue — same failure, same recovery, whichever path it took.
      const message = error instanceof Error ? error.message : String(error);
      this.failQueuedTurn(
        {
          id: `queued-${crypto.randomUUID()}`,
          text: turn.text,
          attachments: turn.attachments,
          workflow: turn.workflow,
          ts: Date.now(),
        },
        message,
      );
      return 'queued';
    }
    return 'accepted';
  }

  /**
   * Whether the adapter would accept a turn right now.
   *
   * Adapters that do not answer are always ready, which is true of every one
   * driving a single long-lived process.
   */

  protected get adapterReady(): boolean {
    return this.adapter?.readyForTurn !== false;
  }


  protected enqueue(turn: UserTurn): void {
    if (this.queue.length >= MAX_QUEUED_TURNS) {
      throw new QueueFullError();
    }
    this.queue.push({
      id: `queued-${crypto.randomUUID()}`,
      text: turn.text,
      attachments: turn.attachments,
      workflow: turn.workflow,
      ts: Date.now(),
    });
    this.publishQueue();
  }

  /** Drop one waiting turn. False when it had already been sent or removed. */

  cancelQueued(id: string): boolean {
    const before = this.queue.length;
    this.queue = this.queue.filter((turn) => turn.id !== id);
    if (this.queue.length === before) return false;
    this.publishQueue();
    return true;
  }

  /**
   * Take one waiting turn out of the line and give it to the agent now.
   *
   * The queue is the right default — most of what you type while an agent works
   * is worth waiting its turn — but some of it is the reason you are typing at
   * all: the wrong file, the wrong database, a test that already exists. Those
   * are worth the interruption, and until this existed the only way to deliver
   * one was the stop button, which discards everything else that was waiting.
   *
   * So: whatever is in flight is cut short, the chosen turn is handed over —
   * or, when the runtime has not let go of the work yet, put back at the head
   * of the line so it is the next thing delivered — and **the rest of the queue
   * stays exactly as it was**, in order, behind it.
   *
   * False when the runtime was not handed the turn on this call — nothing to
   * promote (an unknown id: already delivered, already withdrawn, or a second
   * click on the same row), a session that is no longer running, a delivery
   * already under way, or a runtime that has not finished letting go of the
   * turn it was just told to abandon. Only the last of those leaves the message
   * on its way out, at the head of the line. Silent rather than loud either
   * way: every one of them is a race the user cannot lose in a way that
   * matters, and the queue broadcast that follows tells every browser what is
   * true now.
   */

  async sendQueuedNow(id: string): Promise<boolean> {
    if (!this.adapter?.alive || this.state === 'exited' || this.state === 'error') return false;
    // A drain in progress owns the runtime for the length of one `deliver`.
    // Cutting in here would interrupt a turn that has not finished starting.
    if (this.draining) return false;
    // A runtime that cannot be interrupted cannot be cut in front of either:
    // the interrupt would not end the turn, and the promoted message would
    // reach a process already working on another one — two turns at once, which
    // is the one thing the queue exists to prevent. Checked before the message
    // leaves the line, and here rather than only in the browser, because the
    // browser is not the only thing that can ask.
    const inFlight = this.state !== 'idle';
    if (inFlight && !this.adapter.capabilities.interrupt) return false;

    const index = this.queue.findIndex((turn) => turn.id === id);
    if (index < 0) return false;
    const [turn] = this.queue.splice(index, 1);
    this.publishQueue();

    // Held across the interrupt *and* the delivery, because going idle is what
    // releases the queue: `interrupt` ends in `setState('idle')`, `ingest` runs
    // `drainQueue` after every event, and without this the first message still
    // waiting would overtake the one the user actually chose.
    // Read before the interrupt, because the interrupt is what ends the runtime's
    // own run and ending it is what clears this. A promoted message delivered
    // into work that was running continues that work's turn; one promoted while
    // the session was idle has no work to join and starts its own (#86).
    const steering = inFlight ? this.turnInFlightId : null;

    this.draining = true;
    try {
      if (inFlight) {
        // Every runtime here answers an interrupt by ending its run, and that
        // acknowledgement is not this turn ending — the turn is about to carry
        // on with the correction. Said before the interrupt because the answer
        // to it can arrive during the await.
        this.staleTurnEndUntil = Date.now() + INTERRUPT_ACK_WINDOW_MS;
        await this.cancelTurnInFlight();
        // The record has to say the turn stopped because of this message, not
        // that the agent simply gave up. `marker` rather than an error: being
        // corrected mid-turn is not a failure, and it belongs to the
        // conversation rather than to the turn that was stopped.
        this.ingest({ t: 'marker', kind: 'interrupted', detail: quoteTurn(turn.text) });
      }

      // The gate `send` and the drain have had since #89, missing from the one
      // path that hands a turn over without ever having asked. On pi it is not
      // a race but the rule: `interrupt()` signals the child and returns, and
      // `readyForTurn` stays false until that child's `exit` — a macrotask
      // away, so nothing between here and the send could change the answer and
      // the send threw every single time, taking the promoted message with it
      // (#70). Parked at the head instead, the way `send` parks a turn the
      // adapter cannot take yet: the drain's poll hands it over the moment the
      // process lets go, milliseconds later.
      //
      // The interrupt stands. The work is already dead and the marker above
      // already quotes this message, so the one outcome that is not acceptable
      // here is the message going away with the turn it stopped.
      if (!this.adapterReady) {
        // And it arrives as its own turn rather than as a steer: the work it
        // was going to redirect is over by the time the runtime can take it, so
        // the `turn_end` that closes that work really does close it.
        this.staleTurnEndUntil = null;
        this.queue = [turn, ...this.queue];
        this.publishQueue();
        // Armed here rather than left to the drain, which returns before it
        // reaches this on a session that is not idle yet. Without it a child
        // that ignores the signal and never exits leaves the message sitting at
        // the head with no error on it — and a turn with no error is not one
        // the retry control will touch, so it would be kept and unreachable.
        this.waitForReady();
        return false;
      }

      await this.deliver(
        { text: turn.text, attachments: turn.attachments, workflow: turn.workflow },
        steering ?? undefined,
      );
      return true;
    } catch (error: unknown) {
      // Back in the line with the reason on it, exactly like a turn that failed
      // on its way out of the queue — same failure, same recovery. Writing the
      // error and stopping there lost the message outright: it had left the
      // queue before the interrupt, so nothing on screen still held what the
      // user had typed and there was nothing to retry (#70). The ack window
      // goes for the same reason it does above — nothing is going to carry on
      // the turn this stopped.
      this.staleTurnEndUntil = null;
      const message = error instanceof Error ? error.message : String(error);
      this.failQueuedTurn(turn, message, { putBack: true });
      return false;
    } finally {
      this.draining = false;
      // A delivery that threw leaves the state where it was, which may be idle
      // with messages still waiting — and nothing else would come along to
      // notice. Harmless in the ordinary case: the agent is working on the
      // promoted turn, so the guard inside returns immediately.
      this.drainQueue();
    }
  }

  /** Drop the whole line. Returns how many turns were discarded. */

  clearQueue(): number {
    this.stopWaitingForReady();
    const dropped = this.queue.length;
    if (!dropped) return 0;
    this.queue = [];
    this.publishQueue();
    return dropped;
  }

  /**
   * Try a turn that failed to be delivered again, now.
   *
   * The failure stopped the line (see `drainQueue`), so this both clears the
   * mark and restarts it. Unknown ids are a no-op rather than an error: the
   * click races the queue's own broadcast, and losing that race costs nothing.
   */

  retryQueued(id: string): boolean {
    const turn = this.queue.find((entry) => entry.id === id);
    if (!turn || !turn.error) return false;
    delete turn.error;
    // To the head, because it was already at the head when it failed and the
    // ones behind it were typed expecting it to have gone first.
    this.queue = [turn, ...this.queue.filter((entry) => entry.id !== id)];
    this.publishQueue();
    this.drainQueue();
    return true;
  }

  /**
   * Hand the runtime the next waiting turn, if it is free to take one.
   *
   * Called from `ingest`, which is to say after every event — so the guard
   * matters more than the trigger. `draining` closes the loop this would
   * otherwise be: delivering a turn ingests its own events, and each of those
   * would come straight back here.
   */

  protected drainQueue(): void {
    if (
      this.draining
      || this.fallbackResponses > 0
      || this.questions.size > 0
      || this.questionContinuations.size > 0
      || this.queue.length === 0
    ) return;

    // A dead session cannot work through its backlog, and leaving the turns
    // on screen forever would suggest it might.
    if (!this.adapter?.alive || this.state === 'exited' || this.state === 'error') {
      const dropped = this.clearQueue();
      this.ingest({
        t: 'error',
        message: `${dropped} queued message${dropped === 1 ? '' : 's'} could not be sent: the session is no longer running.`,
      });
      return;
    }

    if (this.state !== 'idle') return;

    // A turn that could not be delivered holds the line rather than being
    // skipped past. Everything behind it was typed on the assumption that it
    // had been asked, and asking those against an agent that never saw it is a
    // worse outcome than a queue that visibly stopped and said why (#89). The
    // user's two ways out — retry and remove — are both on the row itself.
    if (this.queue[0].error) return;

    // Before anything is shifted off the line and before a word of it reaches
    // the transcript: the one-shot adapters call a turn over from a line of
    // stdout while the process that ran it is still exiting, and `send` in that
    // window throws. It used to throw *after* `deliver` had already written the
    // user's message into the conversation and moved the state to `thinking`,
    // so the message sat there unanswered forever with the rest of the queue
    // stuck behind it. Asking first costs a tick or two of waiting (#89).
    if (!this.adapterReady) {
      this.waitForReady();
      return;
    }
    this.stopWaitingForReady();

    this.draining = true;
    const next = this.queue.shift()!;
    this.publishQueue();

    // `deliver` moves the state to `thinking` before it awaits anything, so by
    // the time this promise is pending the guard above already holds on its own.
    this.deliver({ text: next.text, attachments: next.attachments, workflow: next.workflow })
      .catch((error: unknown) => {
        // Silent when a clear is under way: the turn failed because the
        // process it was for is being replaced, which is what the user asked
        // for. See `restarting`.
        if (this.restarting) return;
        const message = error instanceof Error ? error.message : String(error);
        this.failQueuedTurn(next, message);
      })
      .finally(() => {
        this.draining = false;
        // One more look, because a delivery does not always leave an event
        // behind to trigger the next one. `/clear` is the case: it replaces the
        // process instead of running a turn, and every event that replacement
        // emits arrives while this drain still holds the guard — so whatever
        // was queued behind the clear waited on an event that had already been
        // and gone. Cheap and terminal: a session that is busy or a line that
        // is empty returns immediately, and each pass takes one turn off.
        this.drainQueue();
      });
  }

  /**
   * Poll until the adapter can take a turn, then drain.
   *
   * A poll rather than a fixed settling delay because the wait is a process
   * exiting, not a duration: any delay long enough to be safe would be long
   * enough to feel like throttling, and any delay short enough to feel instant
   * would still be a guess. In the measured case this fires once or twice.
   */

  protected waitForReady(): void {
    if (this.drainRetry) return;
    if (this.readySince === null) this.readySince = Date.now();

    if (Date.now() - this.readySince >= QUEUE_READY_TIMEOUT_MS) {
      const head = this.queue[0];
      this.readySince = null;
      if (head) {
        this.failQueuedTurn(
          head,
          `the ${this.runtime || 'agent'} process was still busy ${Math.round(QUEUE_READY_TIMEOUT_MS / 1000)}s after the last turn ended`,
          { putBack: false },
        );
      }
      return;
    }

    this.drainRetry = setTimeout(() => {
      this.drainRetry = null;
      this.drainQueue();
    }, QUEUE_READY_POLL_MS);
    // Nothing here should hold the process open: a session waiting on a child
    // that will never come back must not be the reason the server cannot exit.
    this.drainRetry.unref?.();
  }


  protected stopWaitingForReady(): void {
    if (this.drainRetry) {
      clearTimeout(this.drainRetry);
      this.drainRetry = null;
    }
    this.readySince = null;
  }

  /**
   * Put a turn that could not be delivered back, with the reason on it.
   *
   * Kept rather than dropped, and kept *with its text*, so it is recoverable
   * without retyping — the queue exists to be trusted while nobody is
   * watching, and a queue that discards work silently is worse than none.
   *
   * `putBack` is false when the turn never left the line in the first place.
   */

  protected failQueuedTurn(turn: QueuedTurn, reason: string, { putBack = true } = {}): void {
    const marked: QueuedTurn = { ...turn, error: reason, attempts: (turn.attempts ?? 0) + 1 };
    if (putBack) {
      this.queue = [marked, ...this.queue];
    } else {
      this.queue = this.queue.map((entry) => (entry.id === turn.id ? marked : entry));
    }
    this.publishQueue();
    this.ingest({ t: 'error', message: `could not send a queued message: ${reason}` });
    // Only the delivery failed, so a session left saying "working" would be
    // claiming a turn that never started — and would never drain again, since
    // a drain needs an idle session.
    if (this.state === 'thinking' || this.state === 'running') {
      this.setState('idle');
    }
  }


  protected publishQueue(): void {
    this.deps.broadcast(this.ref.id, {
      type: 'chat_queue',
      sessionId: this.ref.id,
      queued: this.queuedTurns,
    });
  }

  /**
   * Hand one turn to the runtime, recording the user's own message first.
   *
   * @param continuesTurnId The turn this message is being delivered *into*, when
   *   it is a steer — see `sendQueuedNow`. Sharing that turn's id is what makes
   *   the transcript group the two together and the accounting file them as one
   *   turn, which is the definition #86 settled: steering the current work is
   *   part of that work, not a new request. What made that come apart was not
   *   the id but the runtime's acknowledgement of the interrupt arriving as a
   *   `turn_end` — see `staleTurnEndUntil`, which is what keeps the turn open
   *   across it.
   */

  protected async deliver(turn: UserTurn, continuesTurnId?: string): Promise<void> {
    if (!this.adapter || !this.adapter.alive) {
      throw new ChatNotRunningError();
    }
    if (turn.workflow && this.planMode) {
      throw new Error('Turn Plan mode off before starting a workflow that can create a GitHub issue.');
    }

    this.planSubmittedThisTurn = false;
    this.planResponseBlocks.clear();
    this.fallbackTextBlocks.clear();
    this.planResponseCandidate = '';

    // Before the first ingest, not after: the user's own message goes through
    // the same gate, and clearing this late would swallow the very turn that
    // ends the replay.
    this.replaying = false;

    // The user's own turn is recorded here rather than left to each adapter:
    // it is the same in every protocol, and a transcript missing what the user
    // asked is useless for resuming, exporting or searching.
    const messageId = `user-${crypto.randomUUID()}`;
    const turnId = continuesTurnId ?? `turn-${crypto.randomUUID()}`;
    this.turnInFlightId = turnId;
    // Set before the ingest, because the gate that recognises an adapter's copy
    // of this message compares against it — see `isForeignUserEcho`.
    this.ownUserMessageId = messageId;
    this.droppedUserEchoes.clear();
    this.ingest({
      t: 'msg_start',
      id: messageId,
      role: 'user',
      turnId,
      ...(turn.workflow ? { workflow: turn.workflow } : {}),
      ...(continuesTurnId ? { steer: true as const } : {}),
    });
    this.ingest({
      t: 'block_start',
      msgId: messageId,
      index: 0,
      block: { kind: 'text', text: turn.text },
    });
    for (const [offset, attachment] of (turn.attachments || []).entries()) {
      this.ingest({
        t: 'block_start',
        msgId: messageId,
        index: offset + 1,
        block: {
          kind: 'attachment',
          mime: attachment.mime,
          url: attachment.url,
          name: attachment.name,
          size: attachment.size,
        },
      });
    }
    this.ingest({ t: 'msg_end', msgId: messageId });

    // `/clear` and `/new` promise a conversation the agent has never seen
    // before, not one that only looks that way. Forwarding the text to the
    // still-alive process would just add "/clear" to its own context — the
    // process would still remember everything said before it. A real reset
    // means a new process with no resume id, the same thing a manual "start
    // fresh" relaunch already does.
    if (!turn.workflow && isClearingCommand(turn.text)) {
      await this.restart();
      return;
    }

    this.setState('thinking');

    // A branched conversation opens with the history it was cut from, and this
    // is the only place it can reach the agent: it rides *with* the first thing
    // the user says rather than as a turn of its own, so the transcript above
    // holds the user's own words and nothing else. What the runtime receives and
    // what the record shows are deliberately different here, and that difference
    // is the whole point — see chat/branch.ts.
    //
    // Read after the state has moved, never before: `retryQueued` relies on
    // `deliver` reaching `thinking` before it awaits anything, and a disk read
    // in front of that would open a window where a second turn saw an idle
    // session and overtook this one.
    //
    // Never in front of a command. Everything except `/clear` and `/new`
    // reaches the runtime as ordinary turn text, so a briefing glued to
    // `/review` is not a command any more — it runs as prose, and the history
    // is spent on a turn that was never going to read it. It waits for
    // something the model is actually being asked.
    // Bundled workflows are ordinary user requests even when their first
    // character happens to be `/`; never let a runtime reinterpret them as a
    // native command or let command-only paths omit their guidance.
    const command = !turn.workflow && isSlashCommand(turn.text);
    if (command && this.planMode) {
      const name = turn.text.trim().split(/\s+/, 1)[0]!.toLowerCase();
      if (!PLAN_SAFE_SLASH_COMMANDS.has(name)) {
        const blockedTurnId = this.turnInFlightId;
        this.ingest({
          t: 'error',
          message: `${name} was not run because Plan mode only allows planning. Turn Plan mode off before running runtime commands.`,
        });
        if (blockedTurnId) {
          this.ingest({ t: 'turn_end', turnId: blockedTurnId, stopReason: 'blocked' });
        }
        return;
      }
    }
    const carried = command ? null : await this.openingContext();
    const planInstruction = !command && this.planMode
      ? planModeDirective(Boolean(await this.planDocument()))
      : null;
    const questionInstruction = !command
      ? this.questionToolEnabled
        ? questionToolDirective()
        : this.questionFallbackEnabled
          ? questionFallbackDirective()
          : null
      : null;
    const workflowInstruction = turn.workflow
      ? [
          `[BEGIN APP-OWNED ${turn.workflow.toUpperCase()} WORKFLOW]`,
          builtInWorkflowInstructions(turn.workflow),
          `[END APP-OWNED ${turn.workflow.toUpperCase()} WORKFLOW]`,
        ].join('\n')
      : null;
    const runtimeUserRequest = turn.workflow
      ? `[BEGIN USER REQUEST]\n${turn.text}\n[END USER REQUEST]`
      : turn.text;
    const runtimeText = [questionInstruction, workflowInstruction, planInstruction, carried, runtimeUserRequest]
      .filter(Boolean)
      .join('\n\n');
    await this.adapter.send(runtimeText === turn.text ? turn : { ...turn, text: runtimeText });

    // Only once it has actually gone. A delivery that threw is put back in the
    // line and tried again, and the retry has to carry what this attempt never
    // handed over. Awaited rather than left to finish on its own: the send has
    // already succeeded, so the cost is nothing, and a process that exits in
    // that gap would come back and hand a whole conversation's history to some
    // later, unrelated turn.
    if (carried) {
      this.carried = null;
      await this.deps.store.clearOpeningContext?.(this.ref);
    }
  }

  /** The branch history still waiting to be handed over, or null. */
}
