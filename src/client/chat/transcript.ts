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
  ChatCapabilities,
  ChatEvent,
  ChatMessage,
  ChatSnapshot,
  ChatState,
  ChatUsage,
  PermissionRequest,
  PlanItem,
  QueuedTurn,
  NO_CHAT_CAPABILITIES,
} from '../../shared/chat-events.js';
import {
  TranscriptState,
  applyChatEvent,
  createTranscript,
  reindexTranscript,
} from '../../shared/chat-reducer.js';

type Listener = () => void;

export class ChatTranscript {
  private state: TranscriptState;
  private listeners = new Set<Listener>();
  private messageListeners = new Map<string, Set<Listener>>();

  /** Bumped on any change; the value React subscribes to. */
  private version = 0;
  private messageVersions = new Map<string, number>();

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

  /** Replace everything with a server snapshot, e.g. on join or reconnect. */
  hydrate(snapshot: ChatSnapshot): void {
    this.state = createTranscript(snapshot.capabilities, {
      messages: snapshot.messages,
      state: snapshot.state,
      usage: snapshot.usage || {},
      plan: snapshot.plan || [],
      pendingPermissions: snapshot.pendingPermissions || [],
      firstSeq: snapshot.firstSeq,
      cursor: snapshot.cursor,
    });
    // A server that does not report its replay floor gets `firstSeq`, which
    // reads as "nothing older" — no paging offered rather than paging that can
    // never finish.
    this.oldest = snapshot.replayFrom ?? snapshot.firstSeq;
    this.loading = false;
    this.alive = snapshot.live;
    this.resumeId = snapshot.nativeSessionId;
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
  prepend(messages: ChatMessage[], firstSeq: number, from?: number): void {
    this.state.firstSeq = firstSeq;
    if (from !== undefined) {
      this.oldest = Math.max(firstSeq, Math.min(this.oldest || from, from));
    }

    if (!messages.length) {
      this.notify();
      return;
    }

    const known = new Set(this.state.messages.map((message) => message.id));
    const fresh = messages.filter((message) => !known.has(message.id));
    this.state.messages = [...fresh, ...this.state.messages];
    reindexTranscript(this.state);
    this.bumpAll();
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

  apply(event: ChatEvent): void {
    const change = applyChatEvent(this.state, event);
    if (!change.applied) return;

    this.version++;

    if (change.messageIndex !== null && !change.structural && !change.meta) {
      // The common case by a very long way: one token into one message.
      const message = this.state.messages[change.messageIndex];
      if (message) {
        this.bumpMessage(message.id);
        return;
      }
    }

    this.bumpAll();
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
  }

  /** Something session-level moved; the list re-reads, bubbles do not. */
  private notify(): void {
    this.version++;
    for (const listener of this.listeners) listener();
  }

  private bumpAll(): void {
    this.version++;
    for (const listener of this.listeners) listener();
    for (const [id, listeners] of this.messageListeners) {
      this.messageVersions.set(id, (this.messageVersions.get(id) || 0) + 1);
      for (const listener of listeners) listener();
    }
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
