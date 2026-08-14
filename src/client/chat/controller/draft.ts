import { ChatControllerConnection } from './connection.js';
import { ChatAttachment, ChatDraft } from '../../../shared/chat-events.js';
import { DRAFT_PUBLISH_MS, NO_DRAFT, DraftPayload, sameDraft } from './wire.js';

/**
 * The composer draft: value, listeners, publish rate-limiting, adoption.
 */
export abstract class ChatControllerDraft extends ChatControllerConnection {
  /** What this conversation's composer holds, as far as this browser knows. */
  get draftValue(): ChatDraft {
    return this.draft;
  }

  /**
   * Whether a join has said anything about the composer yet.
   *
   * What a surface mounting into an already-open conversation asks, because it
   * may have missed the answer: a tab switched away from and back keeps its
   * controller and its subscription, so the snapshot that carried the composer
   * arrived while nothing was rendering it.
   */
  get draftAnswer(): 'unheard' | 'held' | 'none' {
    if (!this.draftAnswered) return 'unheard';
    return this.draft.revision > 0 ? 'held' : 'none';
  }

  /**
   * Hear about composers that came from somewhere else.
   *
   * `null` means the server has no composer for this conversation at all, which
   * is a different statement from an empty one: it is what a server that has
   * restarted says, and the surface answers it by publishing whatever it kept in
   * session storage rather than by clearing itself.
   *
   * Its own subscription rather than a redraw through `onChange`, because a
   * composer being typed into on another screen must not re-render a
   * conversation four times a second — the transcript, the turn grouping and the
   * whole activity projection hang off that path.
   */
  subscribeDraft(listener: (draft: ChatDraft | null) => void): () => void {
    this.draftListeners.add(listener);
    return () => {
      this.draftListeners.delete(listener);
    };
  }

  /** Whether this server carries the composer between screens at all. */
  get draftSyncAvailable(): boolean {
    return this.draftSync;
  }

  /** Told by the registry once the server's feature list has arrived. */
  setDraftSync(enabled: boolean): void {
    this.draftSync = enabled;
  }

  /**
   * Say what is in this browser's composer.
   *
   * Rate-limited rather than debounced, and the difference is what typing feels
   * like on the screen that is only watching: the first keystroke after a pause
   * goes immediately, and everything within the interval after it is folded into
   * one frame carrying the latest text. A debounce would send nothing at all
   * until the typing stopped, which for a long paragraph is the entire time
   * somebody is watching it being written.
   */
  publishDraft(text: string, attachments: ChatAttachment[] = []): void {
    if (!this.draftSync) return;
    const payload: DraftPayload = { text, attachments };
    // Nothing changed — a caret moved, or this is the surface handing back a
    // draft that arrived from another screen a moment ago.
    if (sameDraft(payload, this.draftPublished)) {
      this.draftPending = null;
      return;
    }
    if (this.draftTimer) {
      this.draftPending = payload;
      return;
    }
    this.sendDraft(payload);
    this.draftTimer = setTimeout(() => this.releaseDraft(), DRAFT_PUBLISH_MS);
  }

  /**
   * Send whatever is waiting for the interval, now.
   *
   * For the moments where waiting a quarter of a second is a quarter of a second
   * too long: the field losing focus, and the page being hidden or closed. The
   * last thing typed before somebody picks up their phone is exactly the thing
   * they picked it up to finish.
   */
  flushDraft(): void {
    const pending = this.draftPending;
    this.draftPending = null;
    if (pending) this.sendDraft(pending);
  }

  private sendDraft(payload: DraftPayload): void {
    this.draftPublished = payload;
    this.send({ type: 'chat_draft', text: payload.text, attachments: payload.attachments });
  }

  private releaseDraft(): void {
    this.draftTimer = null;
    const pending = this.draftPending;
    this.draftPending = null;
    if (pending) this.publishDraft(pending.text, pending.attachments);
  }

  /**
   * Take the composer a join reported, or say that there was not one.
   *
   * The revision check is what makes a rejoin harmless: a snapshot answers with
   * whatever the server holds, which is routinely older than a broadcast this
   * browser has already applied.
   */
  protected adoptDraft(draft: ChatDraft | null): void {
    this.draftAnswered = true;
    if (!draft) {
      // Not "the composer is empty" — "nobody has told this server anything
      // about it". The surface decides what to do with that, and what it does is
      // offer up the copy it kept.
      //
      // The count goes back to nothing with it, and that is the part that is
      // easy to miss: a server that says it holds no composer is a server that
      // will number the next one from 1. A browser still holding 7 from before
      // the restart would then read the next seven edits as older than what it
      // has and drop every one of them — and it heals itself after a few
      // seconds of typing, which is exactly what would make it invisible.
      this.draft = NO_DRAFT;
      this.draftPublished = { text: '', attachments: [] };
      this.emitDraft(null);
      return;
    }
    // What the server holds is, by definition, what this browser has managed to
    // publish — whether or not it is newer than what the browser has. The two
    // come apart in one ordinary case and it is a case worth surviving: a frame
    // handed to a socket that was already closing is dropped without a word (see
    // WebSocketConnection.send), and the browser would otherwise spend the rest
    // of the conversation believing it had said something it never did, refusing
    // to repeat it because it matched what it thought it had sent.
    this.draftPublished = { text: draft.text, attachments: draft.attachments };
    if (draft.revision > this.draft.revision) {
      this.draft = draft;
      // Same reason as the broadcast path: the field this screen was about to
      // announce has just been overwritten by what arrived, so announcing it
      // now would replace the newer text everywhere except here.
      this.draftPending = null;
      this.emitDraft(draft);
      return;
    }
    // Nothing newer than what this browser already applied. Told anyway, as the
    // same "the server has nothing for you" the surface answers by offering
    // whatever it is holding — which after a reconnect is the repair for the
    // dropped frame above, and the rest of the time is a comparison that finds
    // the two already agree and says nothing.
    this.emitDraft(null);
  }

  protected emitDraft(draft: ChatDraft | null): void {
    for (const listener of this.draftListeners) listener(draft);
  }
}
