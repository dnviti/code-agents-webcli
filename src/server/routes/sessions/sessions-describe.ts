import { ConversationSummary } from '../../../shared/conversations.js';
import { ChatSessionRef } from '../../chat/store.js';
import { SessionRecord } from '../../types.js';
import { SessionRoutesDeps } from './sessions-common.js';
import { displayName, activityMs } from './sessions-shared.js';

/**
 * How many logs are read at once while describing a list.
 *
 * Unbounded `Promise.all` over four hundred conversations opens four hundred
 * logs, four hundred indexes and four hundred stats at the same instant, which
 * on a default 1024-descriptor limit is how a listing turns into EMFILE — and
 * EMFILE does not fail only this request, it fails whatever else the server was
 * doing. Sixteen at a time keeps the whole listing well inside a hundred
 * milliseconds without ever holding more than a few dozen handles.
 */
export const DESCRIBE_CONCURRENCY = 16;

/**
 * Describe a run of conversations, a few logs at a time.
 *
 * The bounded concurrency is the whole point — see DESCRIBE_CONCURRENCY. A failed
 * read of one log costs that row its opening line and nothing else: a
 * conversation that cannot be described is still a conversation, and dropping it
 * from the list would be the one outcome the user cannot diagnose.
 */
export async function describeAll(
  deps: SessionRoutesDeps,
  sessions: SessionRecord[],
): Promise<ConversationSummary[]> {
  const summaries: ConversationSummary[] = new Array(sessions.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const at = next++;
      if (at >= sessions.length) return;
      summaries[at] = await summarise(deps, sessions[at]);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(DESCRIBE_CONCURRENCY, sessions.length) }, worker),
  );
  return summaries;
}

/** One conversation, as every list of them describes it. */
export async function summarise(
  deps: SessionRoutesDeps,
  session: SessionRecord,
): Promise<ConversationSummary> {
  const store = deps.chatStore;
  const ref: ChatSessionRef = session;
  const unavailable = Boolean(
    session.persistenceUnavailable || session.rollbackRecoveryPending,
  );
  // `stat()` intentionally repairs a derived chat index. That is correct for
  // a healthy workspace archive, but an unavailable row must remain byte-for-
  // byte unchanged. `describe()` is a bounded read of the JSONL head and
  // does not publish, truncate or append any file, so the diagnostic row can
  // still retain its useful opening line.
  const [stats, description] = await Promise.all([
    unavailable ? null : store?.stat(ref).catch(() => null) ?? null,
    store?.describe(ref).catch(() => null) ?? null,
  ]);

  return {
    id: session.id,
    persistenceUnavailable: session.persistenceUnavailable,
    rollbackRecoveryPending: session.rollbackRecoveryPending === true,
    name: displayName(session),
    runtime: session.lastAgent,
    runtimeLabel: session.runtimeLabel,
    lastActivity: new Date(activityMs(session)).toISOString(),
    workingDir: session.workingDir,
    projectId: session.projectId || null,
    projectName: session.projectId
      ? deps.projectsManager?.getForUser(session.ownerUserId, session.projectId)?.name || null
      : null,
    workingDirKind: session.projectId
      ? session.projectWorkingDirKind ?? 'host'
      : 'host',
    // Keep an unavailable record in the conversation list even when we
    // deliberately refused the mutating stat/repair path above.
    events: stats?.cursor ?? (session.persistenceUnavailable ? 1 : 0),
    firstMessage: description?.firstMessage ?? null,
    // The record first, then the log: the record is authoritative and the head
    // scan is the backfill for conversations that predate it.
    canResume: !unavailable
      && Boolean(session.nativeChatSessionId || description?.nativeSessionId),
    // Reported so the row can say which approval mode picking it will put back.
    // A restored bypass is a standing permission, and one that arrives silently
    // is no better than one that is silently dropped.
    bypassPermissions: session.chatBypassPermissions === true,
    // A conversation that is already running is not one to resume; the list says
    // so rather than offering an action that would be refused.
    running: !unavailable && session.active === true,
  };
}
