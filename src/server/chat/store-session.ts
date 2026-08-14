import fs from 'node:fs';
import path from 'node:path';
import { statSessionFile, unlinkSessionEntry } from '../services/safe-session-file.js';
import { CONTEXT_SUFFIX, ChatSessionRef, PLAN_SUFFIX, SESSION_ID_PATTERN } from './store-types.js';
import { ChatStoreContext } from './store-context.js';

export abstract class ChatStoreSession extends ChatStoreContext {
  /**
   * Everything before `seq` is gone: the log now begins there.
   *
   * What `/clear` means on disk. Emptying the window was never enough — the
   * events were still on the log, so a reload replayed the tail from before
   * the clear and the conversation the user had just ended came back, one
   * scrolled page at a time. Nothing downstream needed teaching about the
   * boundary, because everything downstream — the replay, the pages, the turn
   * index, the conversation's own description — is read from the log, and the
   * head is no longer there to be read.
   *
   * Irreversible, deliberately: "start a new conversation" is a promise about
   * what is left behind, not a view over it. What each turn cost is recorded
   * separately, in the usage store, and is not touched here.
   */
  async truncateBefore(session: ChatSessionRef, seq: number): Promise<void> {
    const base = this.basePath(session);
    await this.enqueue(base, async () => {
      const state = await this.loadState(base);
      await this.dropOldest(base, state, seq - state.firstSeq);
      // What the runtime said it could do belongs to the conversation that has
      // just been dropped, and this process would go on answering with it: the
      // cache is keyed on the log having grown, and a truncation leaves the
      // cursor where it was. A retention trim is the other caller of
      // `dropOldest` and does not want this — nothing about the runtime changed
      // there — so it is forgotten here rather than down inside the drop.
      state.capabilities = undefined;
      state.limits = undefined;
      state.capabilitySeq = 0;
      state.pendingQuestions = undefined;
      state.pendingQuestionSeq = 0;
      state.questionContinuations = undefined;
      state.questionContinuationSeq = 0;
      // The Plan document belongs to the discarded conversation. Keeping its
      // removal in this same per-session queue means an older in-flight save
      // cannot land after the truncation and resurrect it.
      await unlinkSessionEntry(`${base}${PLAN_SUFFIX}`);
    });
  }

  /**
   * Session ids a user has a chat log for, most recently active first.
   *
   * Ordered by mtime rather than left to the caller to sort: a bounded
   * search or listing that has to truncate should favour what the user is
   * actually likely to be looking for.
   */
  async listSessions(ownerUserId: number): Promise<string[]> {
    if (!Number.isSafeInteger(ownerUserId)) {
      throw new Error(`Refusing non-integer owner id for chat storage: ${ownerUserId}`);
    }

    const dir = path.join(this.storageDir, String(ownerUserId));
    let entries: string[];
    try {
      entries = await fs.promises.readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    const candidates = entries
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => name.slice(0, -'.jsonl'.length))
      .filter((id) => SESSION_ID_PATTERN.test(id) && id !== '.' && id !== '..');

    const withStats = await Promise.all(
      candidates.map(async (id) => {
        const stat = await statSessionFile(path.join(dir, `${id}.jsonl`)).catch(() => null);
        return { id, mtimeMs: stat?.mtimeMs ?? 0 };
      }),
    );

    withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return withStats.map((entry) => entry.id);
  }

  async deleteChat(session: ChatSessionRef): Promise<void> {
    const base = this.basePath(session);
    await this.enqueue(base, async () => {
      this.states.delete(base);
      this.descriptions.delete(base);
      await Promise.all(
        ['.jsonl', '.idx', '.jsonl.tmp', '.idx.tmp', CONTEXT_SUFFIX, PLAN_SUFFIX].map((suffix) =>
          suffix === PLAN_SUFFIX
            ? unlinkSessionEntry(`${base}${suffix}`)
            : unlinkSessionEntry(`${base}${suffix}`).catch(() => undefined),
        ),
      );
    });
    this.queues.delete(base);
    this.writeErrors.delete(base);
  }
}
