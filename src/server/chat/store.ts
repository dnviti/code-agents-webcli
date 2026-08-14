/**
 * Append-only store of a chat session's normalized event log.
 *
 * This file is a thin facade that re-exports the full public surface of the
 * store. The implementation lives in sibling modules:
 *   store-types.ts    - types, constants, error class, and internal helpers
 *   store-core.ts     - base class: state, constructor, low-level I/O
 *   store-append.ts   - append/flush/retention writes
 *   store-read.ts     - stat/read/snapshot reads
 *   store-turn.ts     - turn index and cuts
 *   store-describe.ts - conversation description reads
 *   store-context.ts  - opening context and plan document
 *   store-session.ts  - truncate/list/delete
 *   store-class.ts    - final composed ChatStore
 */
export type {
  ChatStoreOptions,
  ChatStats,
  ChatPage,
  PersistedTurn,
  ChatTurnIndex,
  TurnCut,
  ChatSnapshotOptions,
  ChatSessionRef,
  ChatDescription,
  ChatStoreLike,
  ChatStoreAppendOutcome,
} from './store/store-types.js';
export { ChatStoreAppendError, chatStoreAppendOutcome } from './store/store-types.js';
export { ChatStore, default } from './store/store-class.js';
