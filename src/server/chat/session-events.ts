/*
 * ChatSessionEvents: event stream core: ingest/normalisation, state/context/spend accounting, per-job file accounting.
 * Part of the split ChatSession implementation chain in src/server/chat.
 */
import { ChatSessionLifecycle } from './session-lifecycle.js';
import * as path from 'path';
import { ChatEvent, ChatState, carriesTokens, carriesCost, ChatUsage } from '../../shared/chat-events.js';
import { mergeSlashCommands } from '../../shared/slash-commands.js';
import { enumeratesInstalledCommands } from './installed-commands.js';
import { AdapterEvent } from './adapter.js';
import { chatStoreAppendOutcome } from './store.js';
import { FinishedJob } from './usage-accounting.js';
import { projectNameFor, tokenTotal } from '../../shared/usage-records.js';
import { REPLAYABLE, DEAD_TOOL_STATUS, wasCutShort } from './session-constants.js';
export abstract class ChatSessionEvents extends ChatSessionLifecycle {
  protected async restorePendingQuestions(canResume: boolean): Promise<boolean> {
    // A few embedders (and older test doubles) implement the original
    // append/read/stat store contract but do not expose snapshots. Recovery is
    // optional for those stores; treating the missing method as an empty
    // snapshot keeps ordinary session startup backward-compatible.
    const snapshotFn = this.deps.store.snapshot;
    if (typeof snapshotFn !== 'function') return false;
    const snapshot = await snapshotFn.call(this.deps.store, this.ref);
    const continuations = snapshot.pendingQuestionContinuations || [];
    const answeredRequestIds = new Set(
      continuations.map((continuation) => continuation.request.requestId),
    );
    let restored = false;
    for (const request of snapshot.pendingQuestions || []) {
      // A committed answer/outbox wins over an older request frame in a
      // repaired or mixed-version log. It is no longer anybody's to answer.
      if (answeredRequestIds.has(request.requestId)) continue;
      if (
        canResume
        && request.origin === 'structured_handoff'
        && !this.questions.has(request.requestId)
      ) {
        this.questions.set(request.requestId, {
          kind: 'structured_handoff',
          request,
          phase: 'open',
        });
        restored = true;
        continue;
      }
      await this.ingest({
        t: 'question_resolved',
        requestId: request.requestId,
        toolId: request.toolId,
        optionIds: [],
        abandoned: true,
      }, true);
    }
    for (const continuation of continuations) {
      if (continuation.dispatching) {
        // There is no universal idempotency or history-query contract across
        // the supported runtimes. The previous process durably crossed its
        // pre-send boundary and may have handed this turn over before dying;
        // blindly replaying it is the one action known to be capable of
        // starting the continuation twice.
        await this.ingest({
          t: 'question_continuation',
          requestId: continuation.request.requestId,
          continuationId: continuation.continuationId,
          outcome: 'abandoned',
          reason: 'delivery may already have reached the runtime before restart; it was not retried',
        }, true);
        continue;
      }
      if (canResume) {
        this.questionContinuations.set(continuation.continuationId, continuation);
        continue;
      }
      await this.ingest({
        t: 'question_continuation',
        requestId: continuation.request.requestId,
        continuationId: continuation.continuationId,
        outcome: 'abandoned',
        reason: 'the runtime conversation could not be resumed',
      }, true);
    }
    return restored;
  }

  /**
   * Whether this event is a runtime reporting the run this session stopped.
   *
   * Claude reports an interrupted run the same way it reports one that broke:
   * `is_error`, subtype `error_during_execution`. So pressing stop — or
   * correcting the agent by sending ahead of it — put a red card in the
   * conversation reading "claude ended the turn as error_during_execution",
   * with a Retry button offering to run again the very thing the user had just
   * stopped. Nothing had gone wrong. The run ended because it was told to, and
   * the honest record of that is the `interrupted` marker and the turn's own
   * stop reason, both of which already say it in the user's terms.
   *
   * Asked of adapter events only — this is a filter on what a *runtime* says,
   * and it must not touch what this session writes about the interrupt itself,
   * which is written through `ingest` directly. Bounded twice over: by the same
   * window `staleTurnEndUntil` uses, and by the `turn_end` that closes it, so
   * at most one report is swallowed per interrupt and a failure that happens
   * afterwards is a failure again.
   *
   * A fatal error is never dropped. That is the process itself going away,
   * which is true whatever preceded it, and swallowing it would leave a dead
   * conversation looking live.
   */

  protected isInterruptedRunReport(event: AdapterEvent): boolean {
    return (
      event.t === 'error'
      && event.fatal !== true
      && this.interruptedErrorUntil !== null
      && Date.now() <= this.interruptedErrorUntil
    );
  }

  /**
   * Whether this event is an adapter writing the user's turn a second time.
   *
   * Every ACP runtime and both codex modes used to echo the prompt back into
   * the transcript as a user message of their own, on top of the one `deliver`
   * had already written — one prompt, two identical bubbles in the same turn
   * (#129). The adapters no longer do it, and this is what stops it coming
   * back: only `deliver` knows what the user actually typed, because a branched
   * conversation hands the adapter the carried briefing glued in front of the
   * prompt, and only `deliver` knows whether the turn was a steer.
   *
   * Narrow on purpose. It fires only while this session has a turn in flight
   * that it has already written a user message for, and only for a message it
   * did not mint itself — so a runtime that legitimately reports something as
   * the user (a resumed conversation replaying its own history) is untouched.
   * Those arrive while `replaying` is true and are dropped above anyway.
   */

  protected isForeignUserEcho(event: AdapterEvent): boolean {
    if (event.t === 'msg_start') {
      if (
        event.role !== 'user'
        || this.turnInFlightId === null
        || this.ownUserMessageId === null
        || event.id === this.ownUserMessageId
      ) {
        return false;
      }
      this.droppedUserEchoes.add(event.id);
      return true;
    }
    // The blocks and the end of a message that was never opened. Left in, they
    // are events pointing at nothing, which every reader has to shrug off.
    if (event.t === 'block_start' || event.t === 'block_delta' || event.t === 'block_end') {
      return this.droppedUserEchoes.has(event.msgId);
    }
    if (event.t === 'msg_end') {
      return this.droppedUserEchoes.has(event.msgId);
    }
    return false;
  }

  /**
   * Capture a final markdown response when a runtime cannot load the submit tool.
   *
   * This is the universal Plan-mode fallback: tool-capable runtimes submit over
   * the callback channel, while a headless runtime can still return the plan as
   * its ordinary final answer. The transcript remains readable and the same
   * markdown is copied into the dedicated Plan control.
   */

  protected ingest(event: AdapterEvent, durable = false, durableWriteAttempts = 1): void | Promise<void> {
    if (!durable && this.durableEventBuffer) {
      this.durableEventBuffer.push(event);
      return;
    }
    // Dropped before the sequence number is spent, so a resumed conversation
    // does not leave a hole in its own numbering for events that were never
    // written. See `replaying`.
    if (this.replaying && REPLAYABLE.has(event.t)) {
      return;
    }

    if (this.isForeignUserEcho(event)) {
      return;
    }

    if (!this.flushingFallbackText && this.interceptFallbackQuestionText(event)) {
      return;
    }

    // Every durable question transition reserves one sequence number until its
    // canonical JSONL outcome is known. Adapter callbacks are synchronous and
    // can arrive while the append promise is pending; letting them stamp the
    // following seq made a failed durable write impossible to retry without a
    // gap. Hold those raw events and replay them after commit/known rollback.
    const deferred = durable ? [] as AdapterEvent[] : null;
    if (durable) {
      if (this.durableEventBuffer) {
        return Promise.reject(new Error('another durable chat event is still being persisted'));
      }
      this.durableEventBuffer = deferred;
    }

    this.seq += 1;
    const stamped = {
      ...event,
      seq: this.seq,
      ts: (event as { ts?: number }).ts ?? Date.now(),
    } as ChatEvent;

    if (stamped.t === 'turn_end') {
      // Decide whether this is the acknowledgement of an interrupted half-turn
      // before any Plan fallback consumes it. A stale ending is not evidence
      // that the corrected planning turn failed to submit a document.
      this.interruptedErrorUntil = null;
      const acknowledging =
        this.staleTurnEndUntil !== null
        && Date.now() <= this.staleTurnEndUntil
        && this.turnInFlightId !== null;
      if (acknowledging) {
        this.staleTurnEndUntil = null;
        stamped.stale = true;
      } else {
        this.staleTurnEndUntil = null;
        this.turnInFlightId = null;
        this.ownUserMessageId = null;
        this.droppedUserEchoes.clear();
      }
    }

    const fallbackPlan = this.capturePlanResponse(stamped);
    const stopReason = stamped.t === 'turn_end' ? (stamped.stopReason || '').toLowerCase() : '';
    const missingPlan = stamped.t === 'turn_end'
      && !stamped.stale
      && this.planMode
      && !this.planSubmittedThisTurn
      && !fallbackPlan
      && !/(interrupt|abort|cancel|blocked)/.test(stopReason);
    if (fallbackPlan) this.fallbackResponses += 1;

    // What is installed on disk is not the runtime's to forget — unless the
    // runtime is one that lists it itself.
    //
    // A runtime that reports its own command list replaces whatever was there,
    // which is right for the runtimes that report everything they accept — and
    // wrong for the one that does not. Grok on ACP announces seven built-ins
    // (`compact`, `context`, ...) and nothing about the skills and project
    // commands sitting in `.grok/skills`, so a wholesale replacement dropped
    // every one of them from the menu the moment the handshake finished (#73).
    // Claude names every skill and plugin command it accepts, so putting the
    // scan back on top of that could only add names Claude has no command for
    // — picking one sent it as prose and nothing ran (#71). Which of the two a
    // runtime is, is knowledge about the runtime and is kept with the rest of
    // it, in `installed-commands.ts`.
    //
    // Merged on the event itself for the same reason the `questions` flag above
    // is: this list is read from the log by the browser and by any snapshot
    // replayed later, so a merge applied only to the local copy would be a menu
    // that differs between the server and every client reading it.
    if (this.installedCommands.length > 0 && !enumeratesInstalledCommands(this.runtime)) {
      // A missing property means the runtime said nothing, not that it
      // positively reported an empty catalogue. Seed the session event too;
      // otherwise a wrapper that announces fresh capabilities can erase the
      // stand-in merely by omitting `commands`.
      if (stamped.t === 'session') {
        stamped.capabilities = {
          ...stamped.capabilities,
          commands: mergeSlashCommands(stamped.capabilities.commands, this.installedCommands),
        };
      }
      if (stamped.t === 'capabilities' && stamped.capabilities.commands) {
        stamped.capabilities = {
          ...stamped.capabilities,
          commands: mergeSlashCommands(stamped.capabilities.commands, this.installedCommands),
        };
      }
    }

    if (stamped.t === 'session') {
      // Patched on the event itself, not just on the copy kept here. Every
      // reader of this log — this session, the browser's reducer, a snapshot
      // replayed tomorrow — takes `session.capabilities` as a wholesale
      // replacement, so a flag re-applied only locally would be true on the
      // server and false in every browser. Whether the model can ask a question
      // is a fact about what this session wired up; the runtime introducing
      // itself knows nothing about it and must not be able to unset it.
      if ((this.questionToolEnabled || this.questionFallbackEnabled) && !stamped.capabilities.questions) {
        stamped.capabilities = { ...stamped.capabilities, questions: true };
      }
      if (this.planEnabled && !stamped.capabilities.planMode) {
        stamped.capabilities = { ...stamped.capabilities, planMode: true };
      }
      if (stamped.nativeSessionId) {
        this.nativeSessionId = stamped.nativeSessionId;
        this.deps.onLifecycle?.(this.ref.id, { nativeSessionId: stamped.nativeSessionId });
      }
      // Kept, not just forwarded. This is where a runtime reports what it can
      // actually do — including the slash commands it accepts — and `start()`
      // overwrites this field with the adapter's *static* capabilities once it
      // returns. Without this the command list survived only until the browser
      // rejoined, at which point the snapshot handed back a capability set that
      // had never heard of it.
      this.capabilities = stamped.capabilities;
    }
    if (stamped.t === 'state') {
      this.state = stamped.state;
      // The record carries `active` for the whole app; leaving it true after
      // the process died is what made a relaunch in the same session come back
      // as "A process is already running in this session" — a lie the user
      // could only escape by making a new tab.
      if (stamped.state === 'exited') {
        if (this.adapterStarting) {
          this.adapterExitedWhileStarting = true;
        } else {
          this.deps.onLifecycle?.(this.ref.id, {
            exited: true,
            restarting: this.restarting,
          });
        }
      }
      if (stamped.state === 'exited' || stamped.state === 'error') {
        // A blocked tool promise belongs to the process that just died. A
        // structured handoff can survive only when this runtime published a
        // native conversation id and a resume capability; otherwise keeping
        // its card would offer an answer no future process can receive.
        const resumable = Boolean(
          this.nativeSessionId
          && (this.capabilities?.resume === true || this.adapter?.capabilities.resume === true),
        );
        queueMicrotask(() => {
          if (resumable) {
            this.abandonToolQuestions('the agent stopped waiting for an answer');
          } else {
            this.abandonQuestionsAfterUnresumableExit();
          }
        });
      }
    }
    if (
      stamped.t === 'turn_end'
      && !stamped.stale
      && this.state !== 'error'
      && this.state !== 'exited'
    ) {
      // Mirrors the reducer, which does exactly this. Not emitted as a `state`
      // event: the log already carries turn_end, and every reader of that log
      // reaches the same conclusion from it. Emitting a second event would put
      // the same fact in twice.
      this.state = 'idle';
    }
    // `stale` is the interrupt acknowledgement a steer produces, and it closes
    // no turn — the reducer excludes it from turn accounting for the same
    // reason. Ending an escalation on one cancels a grant the user has paid for
    // while the redirected turn is still running.
    if (stamped.t === 'turn_end' && !stamped.stale && this.escalation) {
      if (this.escalation.startsNextTurn) {
        // This is the turn the grant was *not* for. The promised one starts now.
        this.escalation = { ...this.escalation, startsNextTurn: false };
      } else {
        // The task that prompted the move up is over. Not awaited: `ingest` is
        // synchronous for every one of its callers, and the switch back is a
        // request to a runtime that may take its time answering. The marker it
        // emits arrives after this event, which is the order it happened in.
        void this.endEscalation();
      }
    }
    if (stamped.t === 'capabilities' && this.capabilities) {
      this.capabilities = { ...this.capabilities, ...stamped.capabilities };
    }
    if (stamped.t === 'limits') {
      // Held for the same reason `capabilities` is: the snapshot replays only a
      // window of the log, and a rate-limit window announced at the top of a
      // long conversation would fall off the back of it. This is a latest
      // value, not an append, so keeping it here costs one object.
      this.limits = stamped.limits;
    }
    // A question tool call opening is the only chance to learn its id: by the
    // time the MCP server relays the question itself, the arguments are all it
    // knows. `block_start` carries the name, `tool` patches carry only the id,
    // so this is the one event that can make the pairing.
    if (stamped.t === 'block_start' && stamped.block.kind === 'tool') {
      this.noteAskCall(stamped.block.toolId, stamped.block.name, stamped.block.input);
    }
    // Claude streams its arguments in as JSON fragments, so a question tool call
    // is announced before anything says what it asks. The parsed input lands
    // later as a patch, which is the first point the text is knowable.
    if (stamped.t === 'tool' && stamped.patch.input !== undefined) {
      this.noteAskCall(stamped.toolId, stamped.patch.name, stamped.patch.input);
    }
    // The call that asked has ended without an answer, so the question ends too.
    // This is the whole of the fix for a card that outlived its own tool call by
    // ten minutes (#174): an agent whose MCP client gives up on the call says so
    // right here, in a patch carrying the very id the question was filed under,
    // and until now nothing read it. A click after this point could never have
    // reached the model — the runtime has already dropped the request — so the
    // card stops offering one.
    //
    // Deferred rather than resolved on the spot, for the reason `noteSpend`
    // spells out below: `ingest` is running, and a second `ingest` from inside
    // it would number and broadcast the resolution *ahead* of the patch that
    // caused it. A microtask is the smallest wait that puts it after.
    if (stamped.t === 'tool' && DEAD_TOOL_STATUS.has(stamped.patch.status as string)) {
      const dead = stamped.toolId;
      if (this.questionsFor(dead).length > 0) {
        queueMicrotask(() => this.abandonQuestionsFor(dead));
      }
    }
    if (stamped.t === 'turn_end') {
      this.askCalls = [];
    }
    if (stamped.t === 'question') {
      const existing = this.questions.get(stamped.request.requestId);
      if (existing) {
        // Same merge-don't-replace rule the approval path learned the hard way:
        // `askQuestion` records the resolver before it emits this event, and
        // overwriting the entry here would throw away the only thing that can
        // unblock the waiting tool call.
        this.questions.set(stamped.request.requestId, { ...existing, request: stamped.request });
      }
    }
    // Durability-sensitive lifecycle transitions own this map in their FIFO.
    // Deleting here, before append resolves, made a failed write lose the only
    // object that could roll the card back to answerable.
    if (stamped.t === 'question_resolved' && !durable) {
      this.questions.delete(stamped.requestId);
    }
    if (stamped.t === 'permission') {
      // Merged, never replaced. `askUser` records the resolver *before* it
      // emits this event, and a plain `set` here threw that resolver away —
      // so answering in the browser found nothing to resolve, fell through to
      // the adapter (a no-op for Claude, which has no permission channel), and
      // the hook waited on a reply that was never written. Every approval in a
      // Claude chat hung the turn: the tool never ran, and the UI kept its
      // stop button and its "Working" indicator forever.
      const existing = this.pending.get(stamped.request.requestId);
      this.pending.set(stamped.request.requestId, {
        request: stamped.request,
        resolve: existing?.resolve,
      });
    }
    if (stamped.t === 'permission_resolved') {
      this.pending.delete(stamped.requestId);
    }
    this.noteContext(stamped);
    this.noteSpend(stamped);

    let persistence: Promise<void> | null = null;
    const appendOnce = (): void | Promise<void> => this.deps.store.append(this.ref, [stamped]);
    try {
      if (durable && durableWriteAttempts > 1) {
        persistence = (async () => {
          let lastError: unknown;
          for (let attempt = 0; attempt < durableWriteAttempts; attempt += 1) {
            try {
              await appendOnce();
              return;
            } catch (error: unknown) {
              lastError = error;
            }
          }
          throw lastError;
        })();
      } else {
        const appended = appendOnce();
        if (appended && typeof (appended as Promise<void>).then === 'function') {
          persistence = Promise.resolve(appended);
        }
      }
    } catch (error: unknown) {
      if (durable) {
        const outcome = chatStoreAppendOutcome(error);
        if (outcome === 'not_committed' && this.seq === stamped.seq) {
          this.seq -= 1;
        }
        if (outcome === 'not_committed' && deferred) {
          if (this.durableEventBuffer === deferred) this.durableEventBuffer = null;
          for (const held of deferred) this.ingest(held);
        }
        return Promise.reject(error);
      }
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`chat ${this.ref.id}: could not persist an event: ${message}`);
    }

    const publish = (): void => {
      this.deps.broadcast(this.ref.id, { type: 'chat_event', sessionId: this.ref.id, event: stamped });

      if (fallbackPlan) {
        queueMicrotask(() => {
          void this.handleFallbackResponse(fallbackPlan)
            .catch((error: unknown) => {
              const detail = error instanceof Error ? error.message : String(error);
              this.ingest({ t: 'error', message: `The response could not be handled: ${detail}` });
            })
            .finally(() => {
              this.fallbackResponses = Math.max(0, this.fallbackResponses - 1);
              this.drainQueue();
            });
        });
      } else if (missingPlan) {
        queueMicrotask(() => {
          if (!this.planMode || this.planSubmittedThisTurn) return;
          this.ingest({
            t: 'error',
            message: 'The planning turn ended without a reviewable plan. Plan mode is still on; send another planning message to retry.',
          });
        });
      }

      // After the log and the socket, and wrapped: accounting is a bystander to
      // this conversation and must never be able to stop one. A dropped record is
      // a hole in a report; a throw here would be a chat that stops mid-turn.
      try {
        this.accountant?.observe(stamped);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`chat ${this.ref.id}: could not account for an event: ${message}`);
      }

      // Last, and only after the event is on the wire: this is where a turn that
      // ended hands the runtime to whatever was typed while it ran. Doing it here
      // rather than on a timer means the line advances the instant the state
      // says it may, and the events of the next turn are numbered after the ones
      // that closed the last.
      this.drainQueue();
    };

    const releaseDurableBarrier = (safe: boolean): void => {
      if (!durable || !deferred || !safe) return;
      if (this.durableEventBuffer === deferred) this.durableEventBuffer = null;
      for (const held of deferred) this.ingest(held);
    };

    if (durable && persistence) {
      return persistence.catch((error: unknown) => {
        // ChatStore rejects only when the canonical JSONL batch did not commit.
        // Question transitions admit no later lifecycle event ahead of this
        // barrier, so reclaim the sequence number when it is still the tip and
        // let a retry remain contiguous after torn bytes are repaired.
        const outcome = chatStoreAppendOutcome(error);
        if (outcome === 'not_committed' && this.seq === stamped.seq) {
          this.seq -= 1;
        }
        // Unknown means the record may already own this seq. Keep the barrier
        // and buffered events quarantined for cold-store reconciliation.
        releaseDurableBarrier(outcome === 'not_committed');
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`chat ${this.ref.id}: could not durably persist an event: ${message}`);
        throw error;
      }).then(() => {
        try {
          publish();
        } finally {
          releaseDurableBarrier(true);
        }
      });
    }
    if (!durable && persistence) void persistence.catch(() => undefined);
    publish();
    releaseDurableBarrier(true);
    return durable ? Promise.resolve() : undefined;
  }


  protected setState(state: ChatState): void {
    if (this.state === state) return;
    this.ingest({ t: 'state', state });
  }

  /**
   * Keep the context reading pointed at the model that is actually running.
   *
   * Two jobs. The first is noticing when the model changes: a conversation
   * that switches from a million-token model to a two-hundred-thousand one and
   * keeps the old ceiling would show a bar that is comfortably under a quarter
   * full while the real window is nearly gone. Everything learned about the
   * old model is dropped on the switch rather than adjusted.
   *
   * The second is filling the gap for the agents that publish no capacity at
   * all, by asking the provider whose model they named. That is a network call,
   * so it happens once per model and never blocks the conversation: the answer
   * arrives as an ordinary `usage` event whenever it arrives, and if it never
   * does, the reading says capacity is unknown and means it — including when it
   * had been saying something else a moment earlier.
   */

  protected noteContext(event: ChatEvent): void {
    if (event.t === 'session' || event.t === 'msg_start') {
      const model = event.model;
      if (model && model !== this.contextModel) {
        // Only a *change* discards what is known. Learning the model for the
        // first time must not: an ACP agent announces its window during the
        // handshake and names the model a beat later, and treating that as a
        // switch would throw away the agent's own figure and go asking a
        // catalogue for a worse one.
        //
        // Nor does a change the agent has already answered. It states the new
        // model's ceiling the moment the switch is accepted, which is before
        // any message names that model, so this event is the *second* thing to
        // arrive about it. Discarding here would send us asking a catalogue
        // about an id it has never heard of — grok's are internal — and take
        // down a figure grok had just published.
        if (this.contextModel !== undefined && this.agentWindowModel !== model) {
          this.contextWindowFromAgent = false;
          this.capacityAskedFor = undefined;
        }
        this.contextModel = model;
      }
    }

    if (event.t === 'usage') {
      if (event.usage.contextWindow !== undefined) {
        // Only an agent's own figure closes the question. A window this session
        // resolved itself must not mark the agent as having answered, or a
        // later switch back to a model the agent *does* describe would never
        // re-ask.
        if (event.usage.contextWindowSource !== 'provider') {
          this.contextWindowFromAgent = true;
          this.agentWindowModel = event.usage.contextWindowModel;
        }
        this.contextWindowStated = true;
      } else if (event.usage.contextWindowSource === 'unknown') {
        this.contextWindowStated = false;
        this.agentWindowModel = undefined;
      }
    }

    if (this.contextWindowFromAgent || !this.contextModel) return;
    if (this.capacityAskedFor === this.contextModel) return;

    const model = this.contextModel;
    this.capacityAskedFor = model;
    // A lookup that answers null and no lookup at all are the same answer about
    // this model; a lookup that *threw* is not an answer and is kept apart
    // below. All of them travel the same deferred path: this runs inside
    // `ingest`, so emitting from here and now would number an event after the
    // one being handled and put it on the wire ahead of it.
    const asked: Promise<number | null | undefined> = this.deps.capacity
      ? this.deps.capacity.contextWindowFor(model).catch(() => undefined)
      : Promise.resolve(null);
    void asked
      .then((window) => {
        // The conversation may have moved on to another model while this was
        // in flight, and a stale ceiling is the exact failure this guards.
        if (this.contextModel !== model || this.contextWindowFromAgent) return;
        if (window === undefined) {
          // Not reachable is not an answer. Retracting on it would let one bad
          // moment on the network leave a knowable model reading "size unknown"
          // for the rest of the conversation, because nothing re-asks once a
          // model has been asked about. Forget having asked instead.
          if (this.capacityAskedFor === model) this.capacityAskedFor = undefined;
          return;
        }
        if (window === null) {
          // Nobody can size this one — not the agent, and not the catalogue.
          // What is on screen is the model the conversation left, so it comes
          // down rather than being left there to be read as this model's.
          this.retractContextWindow();
          return;
        }
        this.ingest({
          t: 'usage',
          usage: { contextWindow: window, contextWindowSource: 'provider' },
        });
      })
      .catch(() => {
        // Accounting for capacity is a bystander to the conversation, like the
        // accountant above: there is nothing here a person could act on.
      });
  }

  /**
   * Take the ceiling down, and say so.
   *
   * A `usage` report with a source and no window, because leaving the number
   * out is how every other report says "I am not talking about that field" —
   * the rule that keeps a streaming patch from blanking the figures beside it.
   * Only sent when there is something to retract: a conversation whose window
   * was never established already reads as unknown, and an event saying so
   * again would be a log entry that changes nothing.
   */

  protected retractContextWindow(): void {
    if (!this.contextWindowStated) return;
    this.ingest({ t: 'usage', usage: { contextWindowSource: 'unknown' } });
  }

  /**
   * Say, once, that this runtime reports no tokens and/or no money.
   *
   * Every surface that shows spend had exactly two things to draw: a figure, or
   * nothing. Nothing is what a conversation looks like in its first second, so
   * the header stayed blank for kimi — which reports no `usage_update`, no
   * usage on its prompt reply and no `_meta` at all — and a user could not tell
   * that from a session that simply had not spent anything yet.
   *
   * The statement is a measurement and is made where the measurement finishes:
   * a turn in which the runtime actually did something *ran to its own end*,
   * and nothing on any channel carried a count or a price. Done once per
   * conversation, because the log is a record of what changed.
   *
   * "Ran to its own end" is doing real work there, and it is why the two gates
   * below exist. Three kinds of `turn_end` are not a turn finishing: the
   * acknowledgement of an interrupt sent to steer (`stale`, which the comment
   * on the field calls "not a turn ending" — the turn is still running on the
   * correction), a stop-button cancel, and an ending the adapter wrote because
   * the runtime errored or went away. In all three the runtime was cut off
   * before the moment it would have priced the turn, so its silence is about
   * the interruption and not about the runtime. Concluding from one of them
   * told a user that Claude reports neither tokens nor cost because they had
   * pressed stop, and the statement outlives the turn: it is folded into the
   * transcript, carried through `/clear` and re-read on every rejoin, so it
   * stands until some later turn happens to report a figure. Skipping is free
   * by comparison — the next turn that does finish states it.
   *
   * Written onto the `turn_end` that proves it rather than ingested as its own
   * event. `ingest` is what calls this, so a second `ingest` from in here would
   * number and broadcast the new event *ahead* of the turn_end that caused it —
   * the same re-entrancy the capacity lookup above defers a promise to avoid.
   * Patching the event in hand needs no ordering at all, and it lands on the
   * one event a reader would look at to ask the question.
   */

  protected noteSpend(event: ChatEvent): void {
    if (event.t === 'msg_start' && event.role !== 'user') this.turnDidWork = true;
    if (event.t === 'block_start' && event.block.kind === 'tool') this.turnDidWork = true;

    if (event.t === 'usage' || event.t === 'msg_end' || event.t === 'turn_end') {
      if (carriesTokens(event.usage)) this.spokeTokens = true;
      if (carriesCost(event.usage)) this.spokeCost = true;
    }

    if (event.t !== 'turn_end') return;
    // Before the reset, deliberately: the turn this acknowledges is still
    // running, so the work it has already done still belongs to the ending
    // that is yet to come.
    if (event.stale) return;
    const worked = this.turnDidWork;
    this.turnDidWork = false;
    if (!worked) return;
    if (wasCutShort(event.stopReason)) return;

    const silence: ChatUsage = {};
    if (!this.spokeTokens && !this.statedTokenSilence) {
      this.statedTokenSilence = true;
      silence.usageSource = 'none';
    }
    if (!this.spokeCost && !this.statedCostSilence) {
      this.statedCostSilence = true;
      silence.costSource = 'none';
    }
    if (silence.usageSource === undefined && silence.costSource === undefined) return;
    event.usage = { ...event.usage, ...silence };
  }

  /**
   * File a finished job.
   *
   * Note what is *not* here: nothing the user typed, nothing the agent said,
   * no tool arguments. The record is measurements and identifiers, which is
   * what lets it be kept forever under rules the transcript could never meet.
   *
   * A figure the runtime never reported stays null rather than becoming zero —
   * the capability flags recorded alongside are what let a reader tell "this
   * agent cannot report cost" from "this job cost nothing".
   */

  protected fileJob(job: FinishedJob): void {
    const usage = this.deps.usage;
    if (!usage) return;
    const numeric = (value: number | undefined): number | null =>
      typeof value === 'number' && Number.isFinite(value) ? value : null;

    // issue #182: codex never prices a turn itself, so this app prices the
    // turn's *incremental* usage against the confirmed model at OpenAI list
    // price. The accountant already reduced the cumulative usage event to this
    // turn's portion; stamping the estimate here keeps the durable record and
    // the live per-turn figure founded on the same number. Null/absent when no
    // price is obtainable for the model — the client then shows price
    // unavailable rather than a guessed figure.
    let costEstimate;
    if (this.runtime === 'codex' && this.deps.codexPricing) {
      costEstimate = this.deps.codexPricing.estimate(
        {
          inputTokens: numeric(job.usage.inputTokens) ?? undefined,
          cacheReadTokens: numeric(job.usage.cacheReadTokens) ?? undefined,
          outputTokens: numeric(job.usage.outputTokens) ?? undefined,
        },
        job.model ?? undefined,
      );
      if (costEstimate) {
        job.usage.costUsd = costEstimate.costUsd;
        job.usage.costSource = 'estimated';
        job.usage.costEstimate = costEstimate;
      }
    }

    try {
      usage.record({
        sessionId: this.ref.id,
        nativeSessionId: job.nativeSessionId ?? this.nativeSessionId,
        turnId: job.turnId,
        userId: this.ref.ownerUserId,
        userLogin: usage.loginFor(this.ref.ownerUserId),
        agent: this.runtime,
        model: job.model,
        // Read now, from the folder this session is pointed at now. A session
        // that is re-pointed mid-flight leaves the work it already did filed
        // under the project it actually ran in — the alternative, resolving it
        // when the dashboard asks, would rewrite last month's figures every
        // time somebody moved a folder.
        project: projectNameFor(this.cwd),
        startedAt: new Date(job.startedAt).toISOString(),
        endedAt: new Date(job.endedAt).toISOString(),
        durationMs: job.durationMs,
        outcome: job.outcome,
        modelTurns: job.modelTurns,
        toolCalls: job.toolCalls,
        inputTokens: numeric(job.usage.inputTokens),
        outputTokens: numeric(job.usage.outputTokens),
        cacheReadTokens: numeric(job.usage.cacheReadTokens),
        cacheWriteTokens: numeric(job.usage.cacheWriteTokens),
        reasoningTokens: numeric(job.usage.reasoningTokens),
        // Derived when the runtime gave no total of its own, from the parts it
        // did give — see `tokenTotal`. The alternative, filing the runtime's
        // total or nothing, is what made the history say "not reported" for
        // every job Claude ever ran while the same job's tokens were on screen
        // the whole time it ran (#80). The parts are still filed beside it
        // unchanged, so nothing here invents a figure: it adds one up.
        totalTokens: numeric(tokenTotal(job.usage) ?? undefined),
        costUsd: numeric(job.usage.costUsd),
        costEstimate,
        reportsUsage: this.capabilities?.usage === true,
        reportsCost: this.capabilities?.cost === true,
        tools: job.tools,
        models: job.models.map((split) => ({
          model: split.model,
          calls: numeric(split.calls),
          inputTokens: numeric(split.usage?.inputTokens),
          outputTokens: numeric(split.usage?.outputTokens),
          cacheReadTokens: numeric(split.usage?.cacheReadTokens),
          cacheWriteTokens: numeric(split.usage?.cacheWriteTokens),
          costUsd: numeric(split.usage?.costUsd),
        })),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`chat ${this.ref.id}: could not record usage for a job: ${message}`);
      return;
    }

    // Said out loud as well as filed, so the figure beside the turn appears the
    // moment the turn ends rather than the next time the conversation is
    // opened. It is the filed figure, not a second reading of the events: a
    // browser cannot work out what a turn cost on the runtimes that report a
    // running total, and two answers to "what did this cost" is the disagreement
    // #86 exists to remove.
    this.deps.broadcast(this.ref.id, {
      type: 'chat_turn_spend',
      sessionId: this.ref.id,
      turnId: job.turnId,
      usage: job.usage,
    });
  }

  // -------------------------------------------------------------- the queue

  /** Everything still waiting, oldest first. A copy; callers cannot reorder it. */
}
