import {
  ChatAttachment,
  ChatEvent,
  ChatSnapshot,
  NO_CHAT_CAPABILITIES,
} from '../../shared/chat-events.js';
import { ChatTranscript } from './transcript.js';

/**
 * The chat surface's half of the socket.
 *
 * Sits where MessageHandler sits for the terminal: it owns the transcript,
 * applies what arrives, and is the only thing that speaks chat messages to the
 * server. React never touches the socket — it subscribes to the transcript and
 * renders, which is the same split the rest of this client already uses.
 */

export interface ChatControllerOptions {
  send: (message: Record<string, unknown>) => void;
  /** Called when the surface should redraw for a reason outside the transcript. */
  onChange?: () => void;
}

export class ChatController {
  readonly transcript = new ChatTranscript(NO_CHAT_CAPABILITIES);

  private sessionId: string | null = null;
  private loadingMore = false;
  private nextRequestId = 1;

  constructor(private readonly options: ChatControllerOptions) {}

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Apply a server message.
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
        this.sessionId = String(message.sessionId || '') || null;
        this.transcript.hydrate(snapshot);
        this.options.onChange?.();
        return true;
      }

      case 'chat_started': {
        this.sessionId = String(message.sessionId || '') || null;
        this.options.onChange?.();
        return true;
      }

      case 'chat_event': {
        const event = message.event as ChatEvent | undefined;
        if (event) this.transcript.apply(event);
        return true;
      }

      case 'chat_page': {
        // Older events arriving from a scroll-back. They are all below the
        // cursor, so they are folded in as history rather than replayed —
        // the reducer would correctly refuse them as duplicates.
        const events = (message.events as ChatEvent[] | undefined) || [];
        const firstSeq = Number(message.firstSeq) || 0;
        this.absorbPage(events, firstSeq);
        this.loadingMore = false;
        this.options.onChange?.();
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
  private absorbPage(events: ChatEvent[], firstSeq: number): void {
    if (!events.length) {
      this.transcript.prepend([], firstSeq);
      return;
    }

    const scratch = new ChatTranscript(this.transcript.capabilities);
    scratch.applyAll(events);
    this.transcript.prepend(scratch.messages, firstSeq);
  }

  sendTurn(text: string, attachments: ChatAttachment[] = []): void {
    const trimmed = text.trim();
    if (!trimmed && !attachments.length) return;
    this.options.send({ type: 'chat_send', text: trimmed, attachments });
  }

  interrupt(): void {
    this.options.send({ type: 'chat_interrupt' });
  }

  respondPermission(requestId: string, optionId: string): void {
    this.options.send({ type: 'chat_permission_response', requestId, optionId });
  }

  /**
   * Ask for the page above what is held.
   *
   * Guarded rather than debounced: a scroll to the top fires repeatedly while
   * the momentum settles, and each one would otherwise fetch the same page.
   */
  loadMore(): void {
    if (this.loadingMore || !this.transcript.hasMore) return;
    this.loadingMore = true;
    const count = 200;
    const fromSeq = Math.max(0, this.transcript.firstSeq - count);
    this.options.send({
      type: 'chat_history_request',
      fromSeq,
      count,
      requestId: `chat-page-${this.nextRequestId++}`,
    });
  }

  get isLoadingMore(): boolean {
    return this.loadingMore;
  }

  /** Drop everything, e.g. when the tab moves to a different session. */
  reset(): void {
    this.sessionId = null;
    this.loadingMore = false;
    this.transcript.hydrate({
      sessionId: '',
      runtime: '',
      messages: [],
      state: 'starting',
      capabilities: NO_CHAT_CAPABILITIES,
      pendingPermissions: [],
      firstSeq: 0,
      cursor: 0,
      live: false,
      bypassPermissions: false,
    });
    this.options.onChange?.();
  }
}
