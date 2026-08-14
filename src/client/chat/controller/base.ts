import {
  ChatDraft,
  ChatEvent,
  ChatModelDefault,
  ChatModelOrigin,
  NO_CHAT_CAPABILITIES,
  PlanDocument,
} from '../../../shared/chat-events.js';
import {
  ChatControllerOptions,
  ChatUnavailable,
  EffortSwitchResult,
  ModelSwitchResult,
  PendingBuiltInWorkflow,
  PendingQuestionAnswer,
  PlanActionFeedback,
  SeekOutcome,
} from './types.js';
import { DRAFT_PUBLISH_MS, NO_DRAFT, PAGE_SIZE, PAGE_TIMEOUT_MS, SEEK_PAGE_SIZE, DraftPayload } from './wire.js';
import { ChatTranscript } from '../transcript.js';

/**
 * Transport, every field a controller carries, and the paging/seek machinery.
 */
export abstract class ChatControllerBase {
  abstract readonly sessionId: string;
  protected abstract readonly options: ChatControllerOptions;

  readonly transcript = new ChatTranscript(NO_CHAT_CAPABILITIES);

  protected nextRequestId = 1;

  /** Request id of the page in flight, or null. */
  protected pendingPage: string | null = null;

  /**
   * False once the server says the head of the log was trimmed, so the recorded
   * index cannot reach the conversation's own first turn.
   */
  protected turnIndexComplete = true;

  protected pageTimer: ReturnType<typeof setTimeout> | null = null;

  /** The message an explicit jump is still paging back towards, or null. */
  protected seeking: string | null = null;

  /**
   * Which jump is the current one.
   *
   * A seek walks the log a page at a time and every step is a round trip, so
   * there is always a window in which the user changes their mind — picks
   * another entry, jumps to the latest, or leaves the conversation. Bumping
   * this abandons whatever is in flight without cancelling the page it is
   * waiting on, which is already on its way and still worth folding in.
   */
  protected seekGeneration = 0;

  /** Set while the conversation is readable but has nothing running it. */
  protected unavailable: ChatUnavailable | null = null;

  /** False while the owning server transport is unavailable. History stays readable. */
  protected transportConnected = true;

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
  protected modelOverride: string | null = null;

  /**
   * Where the model a *new* conversation on this runtime would come from.
   *
   * A statement about the default rather than about this conversation, which is
   * why it sits beside the override instead of replacing it: the two are shown
   * together, and "chosen here" versus "your standing choice" versus "the
   * profile's" is the whole question the picker could not answer before (#135).
   *
   * Null when the server said nothing — an older one, or one built without the
   * user-settings store. The surface then reads exactly as it did before this
   * existed, rather than asserting a source it was never told.
   */
  protected modelDefault: ChatModelDefault | null = null;

  /**
   * The model this conversation is fixed to, as its record holds it.
   *
   * A statement about *this* conversation, unlike the default above, and the
   * reason the two cannot be collapsed: on claude the runtime never reports a
   * model at all, so a chip with nothing else to show once fell back to the
   * default — and a default the conversation was never launched on is a name it
   * is not running (#135).
   *
   * Null both for "the runtime was given no flag" and for a server that said
   * nothing, and the chip treats them the same way: it names no model. The
   * distinction only matters on the server, where the launch is resolved.
   */
  protected modelPinned: string | null = null;

  /** Where the model this conversation is on came from, or null when unsaid. */
  protected modelOrigin: ChatModelOrigin | null = null;

  /** Why the ladder was not applied, when it was not. */
  protected ladderError: string | null = null;

  /** What the server reported happened to the last model change requested. */
  protected modelResult: ModelSwitchResult | null = null;

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
  protected effortOverride: string | null = null;

  /** What the server reported happened to the last effort change requested. */
  protected effortResult: EffortSwitchResult | null = null;

  /** Conversation-scoped plan state, never inferred from transcript todo items. */
  protected planMode = false;

  protected planDocument: PlanDocument | null = null;

  protected planResult: PlanActionFeedback | null = null;

  /** Admission promises for popup submissions, keyed by their wire request id. */
  protected workflowRequests = new Map<string, PendingBuiltInWorkflow>();

  /** Answer frames awaiting the server's correlated acknowledgement. */
  protected questionAnswers = new Map<string, PendingQuestionAnswer>();

  /** False on a real socket until its handshake advertises the protocol. */
  protected declare builtInWorkflows: boolean;

  /**
   * The composer, as the server last numbered it.
   *
   * Revision 0 is "nothing has ever been said about this conversation's
   * composer", which is what a fresh controller holds and what a server too old
   * to carry drafts leaves it at.
   */
  protected draft: ChatDraft = NO_DRAFT;

  /**
   * What this browser last put on the wire.
   *
   * Kept so the same text is not announced twice — a caret moving through a
   * draft calls the surface's change handler without changing a character — and,
   * more importantly, so a draft *arriving* from elsewhere is not immediately
   * announced back as though this screen had typed it.
   */
  protected draftPublished: DraftPayload = { text: '', attachments: [] };

  /** The newest local edit still waiting for the interval to come round. */
  protected draftPending: DraftPayload | null = null;

  protected draftTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Whether the server on the other end carries composers at all.
   *
   * Off until the handshake says otherwise, for the same reason multi-session
   * is: this server answers an unknown message with a visible error, so a page
   * newer than the server it is talking to would put an error toast on screen
   * per keystroke. See ChatRegistry.setFeatures.
   */
  protected draftSync = false;

  protected draftListeners = new Set<(draft: ChatDraft | null) => void>();

  /**
   * Whether a join has answered the question "what is in this composer" at all.
   *
   * Apart from `draft.revision === 0`, which cannot tell "the server says
   * nothing has been typed" from "this browser has not asked yet" — and a
   * surface that confuses the two publishes its own stale copy over a newer one
   * that is still in flight, then ignores the answer for being older than the
   * revision its own publish just created.
   */
  protected draftAnswered = false;

  protected pageWaiters: Array<(settled: boolean) => void> = [];

  get currentSessionId(): string {
    return this.sessionId;
  }

  /**
   * Fold an older page into the front of the transcript.
   *
   * Replays the page through a throwaway transcript first: a page is a slice of
   * the same event stream, and the only thing that knows how to turn events
   * into messages is the reducer. Rebuilding that logic here is how the two
   * halves of a paged conversation start disagreeing.
   */
  protected absorbPage(
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
    // The scratch folded any `question_resolved` in this page correctly; hand
    // those over too, or a question scrolled in from history comes back with
    // every option unticked (#113).
    this.transcript.prepend(
      scratch.messages,
      firstSeq,
      from,
      scratch.answeredQuestions,
      scratch.answeredQuestionText,
      scratch.abandonedQuestions,
      scratch.questionHistory,
    );
  }

  /**
   * Ask for the page above what is held.
   *
   * Guarded rather than debounced: a scroll to the top fires repeatedly while
   * the momentum settles, and each one would otherwise fetch the same page.
   */
  loadMore(): void {
    this.requestPage(PAGE_SIZE);
  }

  /**
   * The page request itself, at whatever size the caller is reading for.
   *
   * Scrolling asks for a screenful; a jump to a named turn asks for as much as
   * the server will read at once, because there the pages are a journey rather
   * than the thing being read. See `SEEK_PAGE_SIZE`.
   */
  private requestPage(size: number): void {
    if (this.transcript.loadingMore || !this.transcript.hasMore) return;

    const fromSeq = Math.max(this.transcript.firstSeq, this.transcript.oldestSeq - size);
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
      count: size,
      requestId,
    });
  }

  /** Whether the recorded index reaches the conversation's first turn. */
  get recordedTurnsComplete(): boolean {
    return this.turnIndexComplete;
  }

  protected requestTurnIndex(): void {
    this.send({
      type: 'chat_turn_index_request',
      requestId: `chat-turns-${this.nextRequestId++}`,
    });
  }

  /**
   * Page back until a message is held, however far back it is.
   *
   * The index lists the whole conversation, so selecting an entry from before
   * what is loaded has to fetch it rather than quietly do nothing — which is
   * what "selecting an older one should take the user there" means (#86).
   *
   * **No page ceiling.** There used to be one, twenty pages of two hundred
   * events, and in the conversations an index exists for that ceiling was the
   * ordinary case rather than the guard: a click four thousand events above the
   * window ran out of pages, resolved false, and left a highlighted row over a
   * transcript that had not moved. Clicking again walked another four thousand
   * and eventually landed, with nothing on screen to say that was what was
   * happening. The reason a ceiling exists at all — that ordinary scrolling
   * must not be able to walk a whole log into a browser — is about scrolling,
   * and scrolling still asks for one page at a time through `loadMore`. This is
   * an address the user typed, and it arrives.
   *
   * What replaces the ceiling as the guard against a loop that cannot end is
   * progress: a page that does not lower the paging floor has fetched nothing,
   * which is what a failed read and a server that has clamped the request both
   * look like from here, and there is no point asking the same question again.
   *
   * One page at a time, awaited, so the surface keeps painting between them and
   * the user can leave at any point — see `cancelSeek`.
   */
  async seekTo(messageId: string): Promise<SeekOutcome> {
    const mine = ++this.seekGeneration;
    this.seeking = messageId;
    this.options.onChange?.();
    try {
      let floor = this.transcript.oldestSeq;
      for (;;) {
        if (this.seekGeneration !== mine) return 'abandoned';
        if (this.transcript.messages.some((message) => message.id === messageId)) return 'arrived';
        if (!this.transcript.hasMore) return 'exhausted';
        const settled = await this.nextPage(SEEK_PAGE_SIZE);
        // Checked again on this side of the await, not only at the top: a
        // rejoin, a disposal or a tab switch all land during a page, and
        // reading the outcome off what the page did would announce "that turn
        // is no longer in this conversation" for a jump the user simply left.
        if (this.seekGeneration !== mine) return 'abandoned';
        // A read that failed or timed out says nothing about whether the turn
        // is there — only that this attempt did not reach it. Kept apart from
        // the log genuinely ending, because the two want different words.
        if (!settled) return 'unreachable';
        if (this.transcript.oldestSeq >= floor) return 'unreachable';
        floor = this.transcript.oldestSeq;
      }
    } finally {
      // Only if this is still the jump in flight: a later one owns the flag now
      // and clearing it here would take its indicator down with it.
      if (this.seekGeneration === mine) {
        this.seeking = null;
        this.options.onChange?.();
      }
    }
  }

  /**
   * Stop going backwards.
   *
   * For everything that means "I am done with where I was going": jumping to
   * the latest turn, sending a message, closing the conversation. The pages
   * already asked for still arrive and are still folded in — they are history
   * this browser now holds — but nothing scrolls and nothing is announced.
   */
  cancelSeek(): void {
    if (this.seeking === null) return;
    this.seekGeneration += 1;
    this.seeking = null;
    this.options.onChange?.();
  }

  /** The message a jump is being fetched for, so a surface can say it is working. */
  get seekingMessageId(): string | null {
    return this.seeking;
  }

  /**
   * One page, resolved when its reply lands or its timeout fires.
   *
   * A page already in flight is joined rather than refused. Scrolling to the
   * top of a short transcript fetches one on its own, so a click on the index
   * arriving in that window would otherwise give up on the first step and go
   * nowhere — which looks exactly like the index not being wired up at all.
   */
  private nextPage(size = PAGE_SIZE): Promise<boolean> {
    if (!this.transcript.loadingMore && !this.transcript.hasMore) return Promise.resolve(false);
    return new Promise((resolve) => {
      this.pageWaiters.push(resolve);
      if (!this.transcript.loadingMore) this.requestPage(size);
    });
  }

  get isLoadingMore(): boolean {
    return this.transcript.loadingMore;
  }

  /** A page request is over, however it ended. */
  protected settlePage(): void {
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
  protected send(message: Record<string, unknown>): boolean | void {
    if (!this.transportConnected) return false;
    return this.options.send({ ...message, sessionId: this.sessionId });
  }
}
