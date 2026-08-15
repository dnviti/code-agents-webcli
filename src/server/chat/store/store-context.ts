import fs from 'node:fs';
import path from 'node:path';
import {
  ensureWorkspaceSessionDirectory,
  workspaceSessionFileParentLease,
} from '../../services/workspace/session/workspace-session-storage.js';
import {
  openSessionFileForRead,
  replaceSessionFile,
  unlinkSessionEntry,
} from '../../services/workspace/artifacts/safe-session-file.js';
import { PlanDocument } from '../../../shared/chat-events.js';
import { CONTEXT_SUFFIX, ChatSessionRef, PLAN_SUFFIX } from './store-types.js';
import { ChatStoreDescribe } from './store-describe.js';

export abstract class ChatStoreContext extends ChatStoreDescribe {
  /**
   * Keep the context a conversation is to open with, beside its log.
   *
   * On disk rather than in memory because the promise it carries outlives this
   * process: a branch is created, the browser opens its tab, and the first
   * message may not be typed for an hour. Held only until that message goes —
   * see `clearOpeningContext` — so a conversation that has started is a
   * conversation with nothing left here.
   */
  async setOpeningContext(session: ChatSessionRef, context: string): Promise<void> {
    const base = this.basePath(session);
    await ensureWorkspaceSessionDirectory(session);
    if (!workspaceSessionFileParentLease(`${base}${CONTEXT_SUFFIX}`)) {
      await fs.promises.mkdir(path.dirname(base), { recursive: true });
    }
    await replaceSessionFile(`${base}${CONTEXT_SUFFIX}`, context, 'utf8');
  }

  /** The context this conversation opens with, or null once it has been used. */
  async openingContext(session: ChatSessionRef): Promise<string | null> {
    try {
      const handle = await openSessionFileForRead(`${this.basePath(session)}${CONTEXT_SUFFIX}`);
      try {
        const text = await handle.readFile('utf8');
        return text || null;
      } finally {
        await handle.close();
      }
    } catch (error) {
      // The ordinary case by a wide margin: every conversation that was not
      // branched has nothing here, and that is not a failure to report.
      if ((error as NodeJS.ErrnoException).code === 'UNSAFE_WORKSPACE_SESSION_FILE') throw error;
      return null;
    }
  }

  /** It has been handed over; there is no second first turn. */
  async clearOpeningContext(session: ChatSessionRef): Promise<void> {
    await unlinkSessionEntry(`${this.basePath(session)}${CONTEXT_SUFFIX}`)
      .catch(() => undefined);
  }

  /** Atomically replace the latest plan document. */
  async setPlanDocument(session: ChatSessionRef, plan: PlanDocument): Promise<void> {
    const base = this.basePath(session);
    await this.enqueue(base, async () => {
      await ensureWorkspaceSessionDirectory(session);
      const target = `${base}${PLAN_SUFFIX}`;
      if (!workspaceSessionFileParentLease(target)) {
        await fs.promises.mkdir(path.dirname(base), { recursive: true });
      }
      await replaceSessionFile(target, JSON.stringify(plan), 'utf8');
    });
  }

  async planDocument(session: ChatSessionRef): Promise<PlanDocument | null> {
    const base = this.basePath(session);
    return this.enqueue(base, async () => {
      try {
        const handle = await openSessionFileForRead(`${base}${PLAN_SUFFIX}`);
        const raw = await handle.readFile('utf8').finally(() => handle.close());
        const value = JSON.parse(raw) as Partial<PlanDocument>;
        if (typeof value.markdown !== 'string' || value.markdown.length === 0) return null;
        if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1) return null;
        return {
          markdown: value.markdown,
          revision: Number(value.revision),
          ts: typeof value.ts === 'number' && Number.isFinite(value.ts) ? value.ts : 0,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'UNSAFE_WORKSPACE_SESSION_FILE') throw error;
        return null;
      }
    });
  }

  async clearPlanDocument(session: ChatSessionRef): Promise<void> {
    const base = this.basePath(session);
    await this.enqueue(base, () => unlinkSessionEntry(`${base}${PLAN_SUFFIX}`));
  }

}
