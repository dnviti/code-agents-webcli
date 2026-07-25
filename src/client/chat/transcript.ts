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

  constructor(capabilities: ChatCapabilities = NO_CHAT_CAPABILITIES) {
    this.state = createTranscript(capabilities);
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
   */
  prepend(messages: ChatMessage[], firstSeq: number): void {
    if (!messages.length) {
      this.state.firstSeq = firstSeq;
      return;
    }
    const known = new Set(this.state.messages.map((message) => message.id));
    const fresh = messages.filter((message) => !known.has(message.id));
    this.state.messages = [...fresh, ...this.state.messages];
    this.state.firstSeq = firstSeq;
    reindexTranscript(this.state);
    this.bumpAll();
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

  get lastError(): string | undefined {
    return this.state.lastError;
  }

  /** True when there is older history on the server than we hold. */
  get hasMore(): boolean {
    return this.state.firstSeq > 0;
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
