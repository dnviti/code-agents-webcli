/**
 * Client-side transcript: the shared reducer plus a subscription.
 *
 * The reducer itself lives in src/shared so the server folds events the same
 * way. This wraps it in the pattern the rest of this client already uses — an
 * imperative object that owns state, React subscribing to render it — rather
 * than putting a streaming conversation into React state, where an event per
 * token would mean an immutable rebuild of the whole transcript per token.
 *
 * Two subscription levels, because a streaming turn touches one message
 * thousands of times and the rest of the list not at all:
 *
 *   subscribe()         — anything changed; the list re-reads its message array
 *   subscribeMessage(i) — that one message changed; only that bubble re-renders
 *
 * Version counters rather than immutable snapshots: `useSyncExternalStore` only
 * needs a value that changes, and an integer is the cheapest one that cannot
 * lie about whether a mutation happened.
 */

import {
  AccountLimits,
  ChatCapabilities,
  ChatEvent,
  ChatMessage,
  ChatSnapshot,
  ChatState,
  ChatTurnIndexEntry,
  ChatUsage,
  PermissionRequest,
  PlanItem,
  QueuedTurn,
  QuestionRequest,
  NO_CHAT_CAPABILITIES,
  isSessionMintedMessageId,
} from '../../shared/chat-events.js';
import {
  TranscriptState,
  applyChatEvent,
  createTranscript,
  reindexTranscript,
} from '../../shared/chat-reducer.js';

type Listener = () => void;

/**
 * Drop a runtime's echo of the prompt once the page carrying this app's own copy
 * has arrived.
 *
 * The reducer already refuses these as they stream in (#129), on the same test:
 * only `ChatSession.deliver` ever writes a user message and it always mints
 * `user-<uuid>`, so a second user message in a turn that already holds this app's
 * own, under a name this app would not have minted, is the runtime repeating the
 * prompt back. That guard has to see both halves at once, and scrolling back is
 * exactly where they arrive apart: `absorbPage` folds every history page through
 * a scratch transcript of its own, so a page boundary landing in the handful of
 * events between the app's message and the echo hides each from the other and
 * both survive into the merge — two identical bubbles, side by side, in a turn
 * eleven pages back. This is the same rule at the one point where the pair is
 * finally whole.
 *
 * Only conversations recorded before the adapters stopped echoing carry a pair at
 * all, and nothing rewrites them: this decides what is drawn, each time one is
 * opened.
 */
function withoutRuntimeUserEchoes(messages: ChatMessage[]): ChatMessage[] {
  const ownTurns = new Set<string>();
  for (const message of messages) {
    if (message.role === 'user' && message.turnId && isSessionMintedMessageId(message.id)) {
      ownTurns.add(message.turnId);
    }
  }
  if (!ownTurns.size) return messages;
  return messages.filter(
    (message) =>
      message.role !== 'user'
      || isSessionMintedMessageId(message.id)
      || !ownTurns.has(message.turnId),
  );
}

export class ChatTranscript {
  private state: TranscriptState;
  private listeners = new Set<Listener>();
  private messageListeners = new Map<string, Set<Listener>>();

  /** Bumped on any change; the value React subscribes to. */
  private version = 0;
  private messageVersions = new Map<string, number>();

  /**
   * Bumped on *every* applied change, including the per-message ones.
   *
   * The two-tier split above exists so a streaming turn re-renders one bubble
   * rather than the whole list — and it works because a bubble is the only
   * thing that needs to see a token arrive. The trace rail broke that
   * assumption: it draws every tool call in the conversation, so it has to see
   * `block_start`, `block_delta` and `tool` patches, none of which reach
   * `subscribe`. Hanging the rail off `subscribe` meant a forty-second command
   * did not appear on the timeline until something unrelated happened to fire.
   *
   * A third tier rather than a coarser first one: this is the *live* tier, and
   * only the surfaces that are genuinely live subscribe to it. The chat root
   * stays on `subscribe`, so the header, the index and the composer are not
   * re-rendered per token.
   */
  private contentVersion = 0;
  private contentListeners = new Set<Listener>();

  /**
   * Lowest seq this client actually holds.
   *
   * Distinct from `state.firstSeq`, which is the lowest seq the *server* still
   * has. Older history exists exactly when the two differ, and conflating them
   * is what left "Load earlier messages" permanently on screen: seq numbering
   * starts at 1, so the old `firstSeq > 0` test was true for every session that
   * has ever existed, including one with a single message and nothing above it.
   */
  private oldest = 0;

  /** True while a page request is in flight, so the list can say so. */
  private loading = false;

  /**
   * Turns typed ahead, as the server last reported them.
   *
   * Not reducer state: the queue is not something that happened, so it is not
   * in the event log, and every client is told about it directly instead. It
   * lives here anyway because this is the object the surface subscribes to,
   * and a second store for one array would mean a second subscription for
   * every component that needs both.
   */
  private queued: QueuedTurn[] = [];
  private recorded: ChatTurnIndexEntry[] | null = null;
  /** What each finished turn cost, by turn id. See `spendFor`. */
  private readonly spend = new Map<string, ChatUsage>();

  /**
   * What the server last said about the process behind this conversation.
   *
   * Dropped on hydrate until now, which is why a chat whose server had
   * restarted came back reading "Ready" with a working composer: the log
   * replays to `idle` on its own, and `live` was the only thing that knew the
   * process it describes no longer exists.
   */
  private alive = true;
  private resumeId: string | undefined;

  /**
   * Whether this conversation acts without asking.
   *
   * Held per conversation rather than once for the shell, which is what it used
   * to be: a browser watching several chats has one badge per pane, and a single
   * shared flag showed whichever chat launched most recently — so switching to a
   * manual conversation could leave "Approvals bypassed" on screen over it. It
   * belongs here because this is the object that is hydrated from the server's
   * snapshot, so the answer survives a reconnect the same way the transcript
   * does.
   */
  private bypass = false;

  constructor(capabilities: ChatCapabilities = NO_CHAT_CAPABILITIES) {
    this.state = createTranscript(capabilities);
  }

  /** False when the conversation is on screen but nothing is running it. */
  get live(): boolean {
    return this.alive;
  }

  /**
   * True when resuming would give the agent its context back.
   *
   * Distinguishes "continue this conversation" from "start over in this
   * folder", which is the difference the user is being asked to choose between.
   */
  get canResume(): boolean {
    return Boolean(this.resumeId);
  }

  /**
   * True when this conversation runs with tool approvals bypassed.
   *
   * The server is the only authority on it — the mode is recorded against the
   * conversation there — so this is only ever set from what the server said, and
   * never guessed from a launch the browser asked for.
   */
  get bypassing(): boolean {
    return this.bypass;
  }

  /**
   * Show the mode a list row already stated, until the server states it here.
   *
   * A display seed and nothing more: it is never sent back in a launch, and the
   * two authorities — `hydrate` from a snapshot and `setBypassing` from a
   * `chat_started` — overwrite it without consulting it. It exists because the
   * session list and the conversations dialog both know the mode before the
   * pane does, and a pane that opened claiming "asks first" over a conversation
   * the row had just labelled "approvals bypassed" was the wrong answer in the
   * dangerous direction (#134).
   */
  seedBypass(bypassing: boolean): void {
    this.setBypassing(bypassing);
  }

  /** Take the mode from a `chat_started`, which announces the launch's own. */
  setBypassing(bypassing: boolean): void {
    if (this.bypass === bypassing) return;
    this.bypass = bypassing;
    this.notify();
  }

  /** Replace everything with a server snapshot, e.g. on join or reconnect. */
  hydrate(snapshot: ChatSnapshot): void {
    this.state = createTranscript(snapshot.capabilities, {
      messages: snapshot.messages,
      state: snapshot.state,
      usage: snapshot.usage || {},
      plan: snapshot.plan || [],
      pendingPermissions: snapshot.pendingPermissions || [],
      pendingQuestions: snapshot.pendingQuestions || [],
      // What was picked, for the questions already answered (#113). Falling
      // back to what is already held rather than to nothing: a server that
      // predates this field must not take the marks off a card this browser
      // watched being answered a moment ago. Copied because the snapshot is
      // wire data and the reducer writes into this map in place.
      answeredQuestions: snapshot.answeredQuestions
        ? { ...snapshot.answeredQuestions }
        : { ...this.state.answeredQuestions },
      // Kept together with the picks: a snapshot that carries one carries the
      // other, and falling back separately would let a rejoin show a question
      // as answered by clicking when it was in fact answered in free text.
      answeredQuestionText: snapshot.answeredQuestions
        ? { ...(snapshot.answeredQuestionText || {}) }
        : { ...this.state.answeredQuestionText },
      // And which of them the agent had already stopped waiting for, kept on
      // the same terms: a snapshot that speaks about answers speaks about
      // these too, and an older server that says nothing leaves what is held.
      abandonedQuestions: snapshot.answeredQuestions
        ? { ...(snapshot.abandonedQuestions || {}) }
        : { ...this.state.abandonedQuestions },
      firstSeq: snapshot.firstSeq,
      cursor: snapshot.cursor,
      // The turn the server's replay was still inside. Live events arriving
      // after this join belong to it, and without it the first of them opens a
      // turn of its own named after nothing the user typed.
      currentTurnId: snapshot.currentTurnId ?? null,
      // The level the runtime reported, which `createTranscript` would otherwise
      // drop — leaving the control blank over a live session that is still
      // thinking at whatever it opened on.
      effort: snapshot.effort,
      // The provider's own account reading, which `createTranscript` would
      // otherwise drop — leaving a rejoined conversation saying its runtime had
      // never reported a rate-limit window when it had reported one an hour ago.
      limits: snapshot.limits,
    });
    // A server that does not report its replay floor gets `firstSeq`, which
    // reads as "nothing older" — no paging offered rather than paging that can
    // never finish.
    this.oldest = snapshot.replayFrom ?? snapshot.firstSeq;
    this.loading = false;
    this.alive = snapshot.live;
    this.resumeId = snapshot.nativeSessionId;
    // The snapshot is the answer for an offline conversation too: the server
    // reads the mode off the conversation's record, so a chat whose process died
    // still comes back saying which mode it is in rather than defaulting to the
    // one it is not.
    this.bypass = snapshot.bypassPermissions === true;
    this.queued = snapshot.queued ? [...snapshot.queued] : [];
    reindexTranscript(this.state);
    this.messageVersions.clear();
    this.bumpAll();
  }

  /**
   * Prepend an older page fetched by scrolling back.
   *
   * Deliberately not run through the reducer: those events are all below the
   * cursor and the reducer would correctly refuse them as replays. History
   * paging is a different operation from live application.
   *
   * `from` is where the page actually started once the server clamped it, and
   * it is applied whether or not the page produced any messages: a page can
   * legitimately be empty (its events opened messages that closed in a page we
   * already hold), and not moving the floor for that case is what turned a
   * finished request into a spinner nobody could clear.
   */
  prepend(
    messages: ChatMessage[],
    firstSeq: number,
    from?: number,
    answers?: Record<string, string[]>,
    answerText?: Record<string, string>,
    abandoned?: Record<string, true>,
  ): void {
    this.state.firstSeq = firstSeq;
    if (from !== undefined) {
      this.oldest = Math.max(firstSeq, Math.min(this.oldest || from, from));
    }

    // A question far enough back that it arrives by scrolling brings its answer
    // with it (#113). The page is replayed through a scratch transcript that
    // folds `question_resolved` correctly; without this, that answer was
    // computed and then thrown away with the scratch. What is already held
    // wins: these are keyed by tool call, so a collision is the same answer,
    // and the live map is the newer knowledge.
    if (answers) {
      this.state.answeredQuestions = { ...answers, ...this.state.answeredQuestions };
    }
    if (answerText) {
      this.state.answeredQuestionText = { ...answerText, ...this.state.answeredQuestionText };
    }
    if (abandoned) {
      this.state.abandonedQuestions = { ...abandoned, ...this.state.abandonedQuestions };
    }

    if (!messages.length) {
      this.notify();
      return;
    }

    const known = new Set(this.state.messages.map((message) => message.id));
    const fresh = messages.filter((message) => !known.has(message.id));
    this.state.messages = withoutRuntimeUserEchoes([...fresh, ...this.state.messages]);
    reindexTranscript(this.state);
    this.bumpAll();
  }

  /**
   * Start this transcript inside a turn that opened before its first event.
   *
   * For the scratch transcript a page is replayed through: the slice begins
   * wherever the browser scrolled back to, which is routinely the middle of a
   * turn, and the server says which one so the messages are filed under the
   * turn the conversation recorded rather than the runtime's name for it.
   */
  seedOpenTurn(turnId: string | null | undefined): void {
    this.state.currentTurnId = turnId ?? null;
  }

  get loadingMore(): boolean {
    return this.loading;
  }

  setLoadingMore(value: boolean): void {
    if (this.loading === value) return;
    this.loading = value;
    this.notify();
  }

  /** Turns waiting their turn, oldest first. */
  get queuedTurns(): QueuedTurn[] {
    return this.queued;
  }

  /** Replace the line with what the server just said it is. */
  setQueued(turns: QueuedTurn[]): void {
    this.queued = turns;
    this.notify();
  }

  /**
   * Every turn of this conversation as recorded, or null until the server says.
   *
   * Held here rather than on the controller so it travels on the version
   * counter every surface already subscribes to. It arrives once, well after
   * the snapshot, and a view memoised on the transcript's version would
   * otherwise never recompute for it — the index went on showing the one turn
   * the browser happened to hold, which is the defect it exists to fix (#86).
   *
   * Null is not an empty list: it means nobody has answered yet, or the server
   * is older than this page, and the turn strip falls back to numbering what it
   * holds. An empty list is a conversation with no turns in it.
   */
  get recordedTurns(): ChatTurnIndexEntry[] | null {
    return this.recorded;
  }

  /**
   * What a turn that has ended cost, as the accounting filed it.
   *
   * Held beside the recorded index rather than inside it because it arrives
   * from two directions: with the index when a conversation is opened, and one
   * turn at a time as they finish. Both are the same figure from the same
   * place — see `spendByTurn` — so a turn ending is a correction to this map
   * and never a second opinion.
   */
  get turnSpend(): ReadonlyMap<string, ChatUsage> {
    return this.spend;
  }

  /** One turn's recorded spend, as the session files it. */
  setTurnSpend(turnId: string, usage: ChatUsage): void {
    this.spend.set(turnId, usage);
    this.notify();
  }

  setRecordedTurns(turns: ChatTurnIndexEntry[]): void {
    this.recorded = turns;
    for (const turn of turns) {
      // A turn still running has no filed figure yet, and must not be given an
      // empty one — the surfaces read "nothing recorded" off its absence.
      if (turn.usage) this.spend.set(turn.turnId, turn.usage);
    }
    this.notify();
  }

  /**
   * A process appeared behind this conversation, or went away.
   *
   * Only a snapshot carried this before, which meant a session relaunched into
   * a transcript the browser already had stayed marked dead until the page was
   * reloaded — the recovery offer sat over a conversation that was running
   * again, and nothing on screen changed when the user acted on it.
   */
  setLive(value: boolean, resumeId?: string): void {
    if (resumeId) this.resumeId = resumeId;
    if (this.alive === value) return;
    this.alive = value;
    this.notify();
  }

  /**
   * Fold in what a launch announced about the runtime behind this conversation.
   *
   * A merge, exactly as a `capabilities` event is one, and for a reason that
   * only shows up on a relaunch: what a process can say about itself at the
   * moment it starts is less than the conversation already knows — claude
   * publishes its slash commands in the `init` of its first turn — so replacing
   * the set wholesale would empty the picker at the moment the runtime came
   * back.
   */
  setCapabilities(capabilities: Partial<ChatCapabilities>): void {
    this.state.capabilities = { ...this.state.capabilities, ...capabilities };
    this.notify();
  }

  /**
   * Fold one event in, and say whether it was new.
   *
   * The answer is the reducer's own: an event at or below the cursor is a
   * replay and changes nothing. Returned rather than kept private because it is
   * the only honest edge in this client — a reconnect redelivers the tail of
   * the log, and a caller that wants to act *once* per thing that happened has
   * no other way to tell the difference.
   */
  apply(event: ChatEvent): boolean {
    const change = applyChatEvent(this.state, event);
    if (!change.applied) return false;

    this.version++;

    if (change.messageIndex !== null && !change.structural && !change.meta) {
      // The common case by a very long way: one token into one message.
      const message = this.state.messages[change.messageIndex];
      if (message) {
        this.bumpMessage(message.id);
        return true;
      }
    }

    this.bumpAll();
    return true;
  }

  applyAll(events: ChatEvent[]): void {
    for (const event of events) this.apply(event);
  }

  private bumpMessage(id: string): void {
    this.messageVersions.set(id, (this.messageVersions.get(id) || 0) + 1);
    const listeners = this.messageListeners.get(id);
    if (listeners) {
      for (const listener of listeners) listener();
    }
    this.bumpContent();
  }

  private bumpContent(): void {
    this.contentVersion++;
    for (const listener of this.contentListeners) listener();
  }

  /** Something session-level moved; the list re-reads, bubbles do not. */
  private notify(): void {
    this.version++;
    for (const listener of this.listeners) listener();
    this.bumpContent();
  }

  private bumpAll(): void {
    this.version++;
    for (const listener of this.listeners) listener();
    for (const [id, listeners] of this.messageListeners) {
      this.messageVersions.set(id, (this.messageVersions.get(id) || 0) + 1);
      for (const listener of listeners) listener();
    }
    this.bumpContent();
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  subscribeMessage = (id: string, listener: Listener): (() => void) => {
    let set = this.messageListeners.get(id);
    if (!set) {
      set = new Set();
      this.messageListeners.set(id, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.messageListeners.delete(id);
    };
  };

  /**
   * Anything at all changed, including one token of one message.
   *
   * For surfaces that redraw the *contents* of the conversation rather than its
   * shape — the trace timeline and the working ribbon. Everything else should
   * use `subscribe`, which is quiet during a streaming turn.
   */
  subscribeContent = (listener: Listener): (() => void) => {
    this.contentListeners.add(listener);
    return () => {
      this.contentListeners.delete(listener);
    };
  };

  getContentVersion = (): number => this.contentVersion;

  getVersion = (): number => this.version;

  getMessageVersion = (id: string): number => this.messageVersions.get(id) || 0;

  get messages(): ChatMessage[] {
    return this.state.messages;
  }

  message(id: string): ChatMessage | undefined {
    const at = this.state.index[id];
    return at === undefined ? undefined : this.state.messages[at];
  }

  get chatState(): ChatState {
    return this.state.state;
  }

  get capabilities(): ChatCapabilities {
    return this.state.capabilities;
  }

  get usage(): ChatUsage {
    return this.state.usage;
  }

  get plan(): PlanItem[] {
    return this.state.plan;
  }

  get pendingPermissions(): PermissionRequest[] {
    return this.state.pendingPermissions;
  }

  /** Questions the model asked that nobody has answered yet. */
  get pendingQuestions(): QuestionRequest[] {
    return this.state.pendingQuestions;
  }

  /**
   * The question waiting on the given tool call, if that call is the one asking.
   *
   * How a card drawn from a tool block finds out it is still live: the block is
   * in the transcript either way, and this is the difference between a set of
   * buttons and a record of what was already decided.
   */
  questionFor(toolId: string): QuestionRequest | undefined {
    return this.state.pendingQuestions.find((pending) => pending.toolId === toolId);
  }

  /** Which options were picked for the question that call asked, once answered. */
  answerFor(toolId: string): string[] | undefined {
    return this.state.answeredQuestions[toolId];
  }

  /** What was typed for that question, when it was answered in the user's own words. */
  answerTextFor(toolId: string): string | undefined {
    return this.state.answeredQuestionText[toolId];
  }

  /** Whether the agent had stopped waiting by the time that question ended. */
  abandonedFor(toolId: string): boolean {
    return this.state.abandonedQuestions[toolId] === true;
  }

  /**
   * Every answer this transcript holds, keyed the way the reducer keys them.
   *
   * Read off a scratch transcript when a page of history is folded in, so the
   * answers it computed reach the real one rather than being dropped with it.
   */
  get answeredQuestions(): Record<string, string[]> {
    return this.state.answeredQuestions;
  }

  /** The same, for the answers that were typed rather than picked. */
  get answeredQuestionText(): Record<string, string> {
    return this.state.answeredQuestionText;
  }

  /** The same, for the questions nobody was given the chance to answer. */
  get abandonedQuestions(): Record<string, true> {
    return this.state.abandonedQuestions;
  }

  get cursor(): number {
    return this.state.cursor;
  }

  get firstSeq(): number {
    return this.state.firstSeq;
  }

  /** Lowest seq held here; where the next page request starts counting back from. */
  get oldestSeq(): number {
    return this.oldest;
  }

  /**
   * The model the runtime reported for this conversation.
   *
   * From the `session` event, so it is what the process was started with rather
   * than the first entry of whatever list it happens to advertise.
   */
  get model(): string | undefined {
    return this.state.model;
  }

  /**
   * Every model the last turn was billed to, when the runtime broke it down.
   *
   * One entry — the usual case — says nothing `model` does not already say.
   * More than one is the fact the header has to carry: the turn did not run on
   * one model, and a single name would be a claim about work that was split.
   */
  get turnModels(): string[] | undefined {
    return this.state.turnModels;
  }

  /**
   * The reasoning-effort level the runtime last reported running at.
   *
   * Undefined until a runtime says, which is the state most conversations spend
   * their life in: an agent left on its own default reports nothing, and
   * inventing a level for it would put a number on a decision nobody made.
   */
  get effort(): string | undefined {
    return this.state.effort;
  }

  /**
   * Where the provider last said this account stands, or undefined.
   *
   * Undefined is the ordinary case and means "no runtime has said anything
   * about an account", not "nothing is left". The status panel is careful about
   * the difference.
   */
  get limits(): AccountLimits | undefined {
    return this.state.limits;
  }

  get lastError(): string | undefined {
    return this.state.lastError;
  }

  /** True when the server still holds events older than the ones we were given. */
  get hasMore(): boolean {
    return this.oldest > this.state.firstSeq;
  }

  /** True while the agent is doing something, so the composer can say so. */
  get busy(): boolean {
    return (
      this.state.state === 'thinking' ||
      this.state.state === 'running' ||
      this.state.state === 'starting'
    );
  }
}
