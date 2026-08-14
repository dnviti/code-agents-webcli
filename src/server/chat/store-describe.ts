import { openSessionFileForRead } from '../services/safe-session-file.js';
import { ChatDescription, ChatSessionRef, HEAD_SCAN_CHUNK, HEAD_SCAN_LIMIT } from './store-types.js';
import { ChatStoreTurn } from './store-turn.js';

export abstract class ChatStoreDescribe extends ChatStoreTurn {
  /**
   * The runtime's own id for a conversation, read from the head of its log.
   *
   * Backfill for sessions recorded before the id was kept on the session row.
   * Bounded on purpose: a runtime names its conversation in the first thing it
   * says, so the answer is in the first few lines — and these logs reach tens
   * of megabytes, which is a size worth never reading to learn one field.
   *
   * Returns null for "not in the head", which the caller reads as "cannot be
   * resumed". That is the safe direction to be wrong in: it offers a fresh
   * start rather than a resume that would silently produce a stranger.
   */
  async nativeSessionId(session: ChatSessionRef): Promise<string | null> {
    return (await this.describe(session)).nativeSessionId;
  }

  /**
   * Enough about a conversation to list it: what it can be resumed as, and how
   * it opened.
   *
   * Both facts are in the first few lines, so one bounded read answers both.
   * The opening line is what makes a list of past conversations usable at all:
   * a column of "Session 25/07/2026, 21:35" tells a person nothing about which
   * one they were looking for, and the question they asked tells them
   * immediately.
   *
   * Queued like every other read of a log, and it has to be for two reasons that
   * only show up under load. `append` is fire-and-forget by contract, so an
   * unqueued read can land between "the session emitted the opening message" and
   * "the opening message is on disk" — and report the conversation as having no
   * opening at all. And a trim rewrites the head through a rename: it drops the
   * remembered description first, so an unqueued reader could slip in behind that
   * and re-remember the head that is about to be replaced.
   */
  async describe(session: ChatSessionRef): Promise<ChatDescription> {
    const base = this.basePath(session);
    return this.enqueue(base, () => this.describeNow(base));
  }

  protected async describeNow(base: string): Promise<ChatDescription> {
    const found: ChatDescription = { nativeSessionId: null, firstMessage: null };
    const cached = this.descriptions.get(base);
    if (cached) return cached;
    const handle = await openSessionFileForRead(`${base}.jsonl`).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!handle) return found;

    // The id of the message the *user* opened with, so a block belonging to the
    // agent's reply is never mistaken for the question.
    let firstUserMessage: string | null = null;
    let remainder = '';
    let offset = 0;

    const take = (line: string): void => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // A line this cannot parse is not a reason to abandon the read.
        return;
      }

      if (event.t === 'session' && typeof event.nativeSessionId === 'string') {
        found.nativeSessionId ??= event.nativeSessionId;
      }
      if (event.t === 'msg_start' && event.role === 'user' && !firstUserMessage) {
        firstUserMessage = String(event.id || '');
      }
      if (
        event.t === 'block_start'
        && firstUserMessage
        && event.msgId === firstUserMessage
        && !found.firstMessage
      ) {
        const block = event.block as { kind?: string; text?: unknown } | undefined;
        if (block?.kind === 'text' && typeof block.text === 'string' && block.text.trim()) {
          found.firstMessage = block.text.trim().slice(0, 300);
        }
      }
    };

    try {
      const buffer = Buffer.alloc(HEAD_SCAN_CHUNK);
      while (offset < HEAD_SCAN_LIMIT && !(found.nativeSessionId && found.firstMessage)) {
        const { bytesRead } = await handle.read(buffer, 0, HEAD_SCAN_CHUNK, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;

        const lines = (remainder + buffer.subarray(0, bytesRead).toString('utf8')).split('\n');
        // The last piece is whatever the chunk cut in half; it is carried into
        // the next read rather than parsed, because half an event is not one.
        remainder = lines.pop() ?? '';
        for (const line of lines) {
          if (line) take(line);
          if (found.nativeSessionId && found.firstMessage) break;
        }
      }

      // Kept only when nothing more could change the answer: either both facts
      // are in hand, or the scan reached its ceiling and a longer read is not
      // going to be attempted next time either. The remaining case — the whole
      // log was read and one of them is simply not in it yet — is a conversation
      // that has barely started, and the very next event may supply it.
      if ((found.nativeSessionId && found.firstMessage) || offset >= HEAD_SCAN_LIMIT) {
        this.descriptions.set(base, found);
      }

      return found;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

}
