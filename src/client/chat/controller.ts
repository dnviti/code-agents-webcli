import {
  ChatAttachment,
  ChatEvent,
  ChatSnapshot,
  ChatTurnIndexEntry,
  ChatUsage,
  QueuedTurn,
  NO_CHAT_CAPABILITIES,
} from '../../shared/chat-events.js';
import { ChatTranscript } from './transcript.js';

/**
 * One conversation's half of the socket.
 *
 * Sits where MessageHandler sits for the terminal: it owns the transcript,
 * applies what arrives, and is the only thing that speaks chat messages to the
 * server for its session. React never touches the socket — it subscribes to the
 * transcript and renders, which is the same split the rest of this client uses.
 *
 * Scoped to a single session id, fixed at construction. There used to be one
 * controller for the whole page, which meant a second chat tab hydrated the one
 * transcript with its own conversation and the first tab went blank while its
 * agent kept working. Sessions are addressed rather than swapped now; see
 * ChatRegistry.
 */

export interface ChatControllerOptions {
  send: (message: Record<string, unknown>) => void;
  /** Called when the surface should redraw for a reason outside the transcript. */
  onChange?: () => void;
}

/**
 * A conversation whose process is gone, and what can be done about it.
 *
 * The server restarting is the ordinary way to arrive here: chat sessions live
 * in memory, transcripts live on disk, so the conversation outlives the thing
 * that was having it.
 */
export interface ChatUnavailable {
  message: string;
  /** What to call the runtime in the offer, e.g. "Claude". */
  runtimeLabel: string;
  /** True when the agent can be given its own context back. */
  canResume: boolean;
}

/**
 * What actually happened when this browser last asked to change the model.
 *
 * Mirrors the server's own honesty about it: a typed model name is never
 * validated ahead of time, so this reports what was actually possible rather
 * than assuming the best case.
 */
export interface ModelSwitchResult {
  applied: 'live' | 'sent' | 'pending' | 'cleared';
  message: string;
}

/**
 * What actually happened when this browser last asked to change the effort level.
 *
 * One state more than the model has. A model name is free text and cannot be
 * judged before it is tried, but an effort level can: the control only offers
 * what the running runtime published, so a level that is not on that list did
 * not come from the control, and the server says `refused` and stores nothing
 * rather than carrying a bad value into every future launch.
 */
export interface EffortSwitchResult {
  applied: 'live' | 'sent' | 'pending' | 'cleared' | 'refused';
  message: string;
}

/**
 * How long a page request may go unanswered before the control comes back.
 *
 * Not a latency budget — a page is a positioned read of a local file and comes
 * back in milliseconds. It is the point past which the only explanation is that
 * no reply is coming, and leaving a spinner up for that forever is worse than
 * offering the button again.
 */
const PAGE_TIMEOUT_MS = 15000;

const PAGE_SIZE = 200;

export class ChatController {
  readonly transcript = new ChatTranscript(NO_CHAT_CAPABILITIES);

  private nextRequestId = 1;
  /** Request id of the page in flight, or null. */
  private pendingPage: string | null = null;
  /**
   * False once the server says the head of the log was trimmed, so the recorded
   * index cannot reach the conversation's own first turn.
   */
  private turnIndexComplete = true;
  private pageTimer: ReturnType<typeof setTimeout> | null = null;

  /** Set while the conversation is readable but has nothing running it. */
  private unavailable: ChatUnavailable | null = null;

  /**
   * The model override this conversation is carrying, independent of what the
   * runtime itself reports through the transcript.
   *
   * Null means "no override" — the surface then falls back to whatever the
   * transcript's own `model` says, which is the runtime's default or the
   * active profile. Kept here rather than folded into the transcript because
   * it is a fact about the *session record*, not something any adapter emits
   * as an event.
   */
  private modelOverride: string | null = null;
  /** What the server reported happened to the last model change requested. */
  private modelResult: ModelSwitchResult | null = null;

  /**
   * The effort level this conversation was told to run at, as the record holds it.
   *
   * Beside the transcript's own `effort` rather than inside it for the same
   * reason the model override is: the transcript carries what the *runtime*
   * reported, and this carries what the *record* says was chosen. They agree
   * almost always, and the interesting moment is the one where they do not —
   * a conversation whose process has died still has a chosen level, and nothing
   * is reporting it any more.
   */
  private effortOverride: string | null = null;
  /** What the server reported happened to the last effort change requested. */
  private effortResult: EffortSwitchResult | null = null;

  constructor(
    readonly sessionId: string,
    private readonly options: ChatControllerOptions,
  ) {}

  /**
   * Every message type this class answers to, for whoever routes to it.
   *
   * Beside the switch it describes, because it is the same list twice and the
   * copy that lived elsewhere fell behind: `chat_turn_index`, `chat_turn_spend`
   * and `chat_model_result` were all added here and never added there, so the
   * registry dropped them before a controller ever saw them. That is not a
   * missing handler — the message goes to the terminal's handler, which has no
   * idea what a chat message is, and it is discarded in silence. What it cost:
   * a conversation numbered by the window instead of by the recording, and no
   * per-turn spend on screen at all.
   */
  static readonly MESSAGE_TYPES: ReadonlySet<string> = new Set([
    'chat_snapshot',
    'chat_started',
    'chat_event',
    'chat_queue',
    'chat_page',
    'chat_page_failed',
    'chat_unavailable',
    'chat_model_result',
    'chat_effort_result',
    'chat_turn_index',
    'chat_turn_index_failed',
    'chat_turn_spend',
  ]);

  get currentSessionId(): string {
    return this.sessionId;
  }

  /**
   * Apply a server message already known to belong to this session.
   *
   * Returns whether it belonged to the chat surface, so the terminal's own
   * handler can go on ignoring everything it does not recognise rather than
   * needing to know this exists.
   */
  handle(message: Record<string, unknown>): boolean {
    const type = String(message.type || '');

    switch (type) {
      case 'chat_snapshot': {
        const snapshot = message.snapshot as ChatSnapshot | undefined;
        if (!snapshot) return true;
        this.settlePage();
        this.transcript.hydrate(snapshot);
        // Asked for once per open. The list only grows at the end, and the end
        // is the part this browser is certain to be holding.
        this.requestTurnIndex();
        this.modelOverride =
          typeof message.modelOverride === 'string' ? message.modelOverride : null;
        this.effortOverride =
          typeof message.effortOverride === 'string' ? message.effortOverride : null;
        this.options.onChange?.();
        return true;
      }

      case 'chat_started': {
        // Whatever went wrong is over: something is running again.
        //
        // Both halves are needed. Clearing the stored reason alone left the
        // derived one — which reads `transcript.live` — reporting the same
        // thing a moment later, so the offer stayed on screen over a
        // conversation that was already running and only a page reload fixed
        // it. The transcript is where "is anything behind this" actually lives.
        this.unavailable = null;
        this.transcript.setLive(true);
        // The launch announces the mode it actually started in, which is not
        // necessarily the one this browser asked for: a relaunch names no mode
        // at all and the server restores the conversation's own. Taken from the
        // message rather than assumed, so the badge cannot claim a mode the
        // process is not running in.
        this.transcript.setBypassing(message.bypassPermissions === true);
        this.modelOverride =
          typeof message.modelOverride === 'string' ? message.modelOverride : null;
        this.effortOverride =
          typeof message.effortOverride === 'string' ? message.effortOverride : null;
        this.options.onChange?.();
        return true;
      }

      case 'chat_model_result': {
        const applied = (message.applied as ModelSwitchResult['applied']) || 'pending';
        // Only 'live'/'cleared' mean the session is actually running this model now.
        // 'sent'/'pending' are best-effort or deferred-to-next-launch — adopting the
        // label for those would claim a model is active when it is not yet, or may
        // never be without a relaunch.
        if (applied === 'live' || applied === 'cleared') {
          this.modelOverride = typeof message.model === 'string' ? message.model : null;
        }
        this.modelResult = {
          applied,
          message: String(message.message || ''),
        };
        this.options.onChange?.();
        return true;
      }

      case 'chat_effort_result': {
        const applied = (message.applied as EffortSwitchResult['applied']) || 'pending';
        // Same rule as the model, and the same reason: only 'live' and 'cleared'
        // mean the conversation is running at this level now. 'sent' is awaiting
        // the runtime's own word for it, 'pending' will not be true until a
        // relaunch that may never come, and 'refused' was never stored at all —
        // showing any of them on the chip would put a number on the screen that
        // nothing is actually running at.
        if (applied === 'live' || applied === 'cleared') {
          this.effortOverride = typeof message.effort === 'string' ? message.effort : null;
        }
        this.effortResult = {
          applied,
          message: String(message.message || ''),
        };
        this.options.onChange?.();
        return true;
      }

      case 'chat_unavailable': {
        // The conversation is intact and nothing is running it. Held rather
        // than shown as an error, because the useful response is a choice
        // between two ways forward, not an acknowledgement.
        this.unavailable = {
          message: String(message.message || 'this chat session is not running'),
          runtimeLabel: String(message.runtimeLabel || message.runtime || ''),
          canResume: message.canResume === true,
        };
        this.options.onChange?.();
        return true;
      }

      case 'chat_event': {
        const event = message.event as ChatEvent | undefined;
        if (event) this.transcript.apply(event);
        // `/clear` replaces the conversation in this tab, so the index of the
        // one it replaced is not an index of anything on screen. Dropped and
        // asked for again rather than patched: the server reads it from the
        // log, which is where the boundary is recorded.
        if (event && event.t === 'marker' && event.kind === 'cleared') {
          this.transcript.setRecordedTurns([]);
          this.requestTurnIndex();
        }
        return true;
      }

      case 'chat_turn_index': {
        const turns = message.turns as ChatTurnIndexEntry[] | undefined;
        // Onto the transcript, not held here: it has to travel on the version
        // counter the views subscribe to, or it lands after every memo that
        // would read it has already been computed (#86).
        this.transcript.setRecordedTurns(Array.isArray(turns) ? turns : []);
        this.turnIndexComplete = message.complete !== false;
        this.options.onChange?.();
        return true;
      }

      case 'chat_turn_spend': {
        // One turn's bill, the moment the accounting files it. Same figure the
        // index carries on open, so a turn's cost appears as it finishes rather
        // than the next time the conversation is opened.
        const turnId = typeof message.turnId === 'string' ? message.turnId : '';
        const usage = message.usage as ChatUsage | undefined;
        if (turnId && usage) this.transcript.setTurnSpend(turnId, usage);
        this.options.onChange?.();
        return true;
      }

      case 'chat_turn_index_failed': {
        // Nothing to recover: the index falls back to the turns this browser
        // holds, which is what it showed before there was a recorded one.
        return true;
      }

      case 'chat_page': {
        // Older events arriving from a scroll-back. They are all below the
        // cursor, so they are folded in as history rather than replayed —
        // the reducer would correctly refuse them as duplicates.
        const events = (message.events as ChatEvent[] | undefined) || [];
        const firstSeq = Number(message.firstSeq) || 0;
        const from = typeof message.from === 'number' ? message.from : undefined;
        const openTurnId = typeof message.openTurnId === 'string' ? message.openTurnId : null;
        this.absorbPage(events, firstSeq, from, openTurnId);
        this.settlePage();
        this.options.onChange?.();
        return true;
      }

      case 'chat_queue': {
        // Authoritative and whole, never a delta: the server is the only thing
        // that knows what is still waiting — a turn can leave the queue because
        // this browser cancelled it, because another one did, or because it
        // just started running — and reconciling three sources of removal
        // against a local copy is how the two fall out of step.
        const queued = message.queued as QueuedTurn[] | undefined;
        this.transcript.setQueued(Array.isArray(queued) ? queued : []);
        return true;
      }

      case 'chat_page_failed': {
        // The read threw server-side. The error itself is surfaced by the
        // shell's own error path; all this owes the user is the button back.
        this.settlePage();
        return true;
      }

      default:
        return false;
    }
  }

  /**
   * Fold an older page into the front of the transcript.
   *
   * Replays the page through a throwaway transcript first: a page is a slice of
   * the same event stream, and the only thing that knows how to turn events
   * into messages is the reducer. Rebuilding that logic here is how the two
   * halves of a paged conversation start disagreeing.
   */
  private absorbPage(
    events: ChatEvent[],
    firstSeq: number,
    from?: number,
    openTurnId?: string | null,
  ): void {
    if (!events.length) {
      this.transcript.prepend([], firstSeq, from);
      return;
    }

    const scratch = new ChatTranscript(this.transcript.capabilities);
    // A page starts wherever the scroll reached, which is routinely inside a
    // turn: without the turn the server says was open there, every paged-in
    // message is filed under the runtime's id and the history fills with rows
    // that have no prompt to name them.
    scratch.seedOpenTurn(openTurnId);
    scratch.applyAll(events);
    this.transcript.prepend(scratch.messages, firstSeq, from);
  }

  /**
   * The recovery offer to show, or null.
   *
   * Two ways in. The snapshot says so on arrival — a tab reopened after the
   * server restarted knows before the user types anything — and `chat_send`
   * says so when the first message finds nothing to send to, which covers the
   * process dying while the tab sat open.
   */
  get unavailableReason(): ChatUnavailable | null {
    if (this.unavailable) return this.unavailable;
    // `cursor`, not the message count: a conversation that was cleared has no
    // messages and every bit as much of a dead runtime behind it. Gating on
    // messages put that case straight back into the failure this exists to
    // replace — an idle-looking pane whose first message comes back as an
    // error. A session where chat has never started has a cursor of 0, which is
    // the case that must *not* be offered a resume.
    if (this.transcript.live || this.transcript.cursor <= 0) return null;
    // Empty label, not a guess: a snapshot does not carry one, and the pane
    // rendering this already knows what the runtime is called. "the agent"
    // written here would win over the real name and read as a downgrade.
    return {
      message: 'this chat session is not running',
      runtimeLabel: '',
      canResume: this.transcript.canResume,
    };
  }

  /**
   * Put a runtime back on this conversation.
   *
   * `resume` is the whole choice: with it the agent is handed its own session
   * back and knows what is on screen; without it the transcript stays as a
   * record and the agent starts fresh. Either way it is this session, in this
   * tab — a new one would leave the conversation behind.
   *
   * Deliberately says nothing about the approval mode. The server has the
   * conversation's own recorded against it and restores that, which is both the
   * right answer and the safe one: a relaunch that carried a mode would be a
   * browser asking for a standing permission, and this browser's copy of it is
   * exactly the thing that used to be wrong after a restart.
   */
  relaunch(agentKind: string, options: { resume: boolean }): void {
    this.unavailable = null;
    this.options.onChange?.();
    this.options.send({
      type: 'start_chat',
      agentKind,
      sessionId: this.sessionId,
      options: { resume: options.resume },
    });
  }

  sendTurn(text: string, attachments: ChatAttachment[] = []): void {
    const trimmed = text.trim();
    if (!trimmed && !attachments.length) return;
    this.send({ type: 'chat_send', text: trimmed, attachments });
  }

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

  /**
   * Answer a multiple-choice question the model asked.
   *
   * `skipped` is explicit rather than inferred from an empty list: "I picked
   * none of these" and "I do not want to answer" reach the model as different
   * sentences, and the agent is blocked either way until one of them arrives.
   */
  answerQuestion(requestId: string, optionIds: string[], skipped = false): void {
    this.send({ type: 'chat_question_answer', requestId, optionIds, skipped });
  }

  respondPermission(requestId: string, optionId: string): void {
    this.send({ type: 'chat_permission_response', requestId, optionId });
  }

  /** The model override in force for this conversation, or null if there is none. */
  get modelOverrideValue(): string | null {
    return this.modelOverride;
  }

  /** What happened the last time this browser asked to change the model. */
  get modelFeedback(): ModelSwitchResult | null {
    return this.modelResult;
  }

  /**
   * Ask the server to switch this conversation's model, or clear the override
   * with an empty string.
   *
   * Never validated here: the composer sends whatever was typed, and the
   * server's reply — live, sent, or saved-for-next-time — is what actually
   * tells the user what happened.
   */
  setModel(model: string): void {
    this.send({ type: 'chat_set_model', model });
  }

  /** The effort level chosen for this conversation, or null if none was. */
  get effortOverrideValue(): string | null {
    return this.effortOverride;
  }

  /** What happened the last time this browser asked to change the effort level. */
  get effortFeedback(): EffortSwitchResult | null {
    return this.effortResult;
  }

  /**
   * Ask the server to change how hard this conversation thinks, or clear the
   * choice with an empty string.
   *
   * Unlike the model, the server does check this one against what the runtime
   * published — but the check belongs there and not here, because only the
   * server can see the live session's capabilities, and a browser holding a
   * stale menu is exactly the case the check exists for.
   */
  setEffort(effort: string): void {
    this.send({ type: 'chat_set_effort', effort });
  }

  /** Tell the server this browser wants this conversation's live events. */
  subscribe(): void {
    this.send({ type: 'chat_subscribe' });
  }

  unsubscribe(): void {
    this.send({ type: 'chat_unsubscribe' });
  }

  /**
   * Ask for the page above what is held.
   *
   * Guarded rather than debounced: a scroll to the top fires repeatedly while
   * the momentum settles, and each one would otherwise fetch the same page.
   */
  loadMore(): void {
    if (this.transcript.loadingMore || !this.transcript.hasMore) return;

    const fromSeq = Math.max(
      this.transcript.firstSeq,
      this.transcript.oldestSeq - PAGE_SIZE,
    );
    const requestId = `chat-page-${this.nextRequestId++}`;
    this.pendingPage = requestId;
    this.transcript.setLoadingMore(true);

    this.pageTimer = setTimeout(() => {
      this.pageTimer = null;
      this.settlePage();
    }, PAGE_TIMEOUT_MS);

    this.send({
      type: 'chat_history_request',
      fromSeq,
      count: PAGE_SIZE,
      requestId,
    });
  }

  /** Whether the recorded index reaches the conversation's first turn. */
  get recordedTurnsComplete(): boolean {
    return this.turnIndexComplete;
  }

  private requestTurnIndex(): void {
    this.send({
      type: 'chat_turn_index_request',
      requestId: `chat-turns-${this.nextRequestId++}`,
    });
  }

  /**
   * Page back until a turn is held, or until there is no more history.
   *
   * The index lists the whole conversation, so selecting an entry from before
   * what is loaded has to fetch it rather than quietly do nothing — which is
   * what "selecting an older one should take the user there" means (#86).
   *
   * Bounded by `hasMore` and by a page ceiling, because the alternative is a
   * loop that reads a whole conversation into a browser to answer a click. A
   * request that runs out of pages resolves false and the caller leaves the
   * selection where it was.
   */
  async loadUntilLoaded(messageId: string, maxPages = 20): Promise<boolean> {
    for (let page = 0; page < maxPages; page++) {
      if (this.transcript.messages.some((message) => message.id === messageId)) return true;
      if (!this.transcript.hasMore) return false;
      // One page at a time, awaited: `loadMore` is guarded against overlapping
      // requests, so firing them in parallel would fetch one page and drop the
      // rest on the floor.
      const settled = await this.nextPage();
      if (!settled) return false;
    }
    return this.transcript.messages.some((message) => message.id === messageId);
  }

  /**
   * One page, resolved when its reply lands or its timeout fires.
   *
   * A page already in flight is joined rather than refused. Scrolling to the
   * top of a short transcript fetches one on its own, so a click on the index
   * arriving in that window would otherwise give up on the first step and go
   * nowhere — which looks exactly like the index not being wired up at all.
   */
  private nextPage(): Promise<boolean> {
    if (!this.transcript.loadingMore && !this.transcript.hasMore) return Promise.resolve(false);
    return new Promise((resolve) => {
      this.pageWaiters.push(resolve);
      if (!this.transcript.loadingMore) this.loadMore();
    });
  }

  private pageWaiters: Array<(settled: boolean) => void> = [];

  get isLoadingMore(): boolean {
    return this.transcript.loadingMore;
  }

  /** A page request is over, however it ended. */
  private settlePage(): void {
    if (this.pageTimer !== null) {
      clearTimeout(this.pageTimer);
      this.pageTimer = null;
    }
    this.pendingPage = null;
    this.transcript.setLoadingMore(false);
    const waiters = this.pageWaiters;
    this.pageWaiters = [];
    for (const resolve of waiters) resolve(true);
  }

  /** Every outgoing message names its session; a browser drives several. */
  private send(message: Record<string, unknown>): void {
    this.options.send({ ...message, sessionId: this.sessionId });
  }

  /** Release timers, e.g. when the session's tab is closed. */
  dispose(): void {
    this.settlePage();
  }

  /** Drop everything, e.g. when the session is being restarted. */
  reset(): void {
    this.settlePage();
    // Not a claim either way: the next snapshot or chat_started carries the
    // record's real override, and showing a stale one in the meantime would
    // be worse than showing nothing.
    this.modelOverride = null;
    this.modelResult = null;
    // And the effort level with it, for the same reason: the record's own value
    // is on its way and a stale one on the chip in the meantime would claim the
    // conversation is thinking at a level nothing has confirmed.
    this.effortOverride = null;
    this.effortResult = null;
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
      // Not a claim about the session: this is a wipe, and the next snapshot or
      // `chat_started` carries the real mode. Manual is the direction to be
      // wrong in for the moment in between.
      bypassPermissions: false,
    });
    this.options.onChange?.();
  }
}
