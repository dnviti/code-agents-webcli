/**
 * Thin re-export facade for `SessionStore`.
 *
 * Implementation lives in ./session-store/ (types, helpers, and the session
 * store class split across an inheritance chain). This module preserves the
 * original public export surface.
 */
export { SessionStore, SessionStore as default } from './session-store/session-store.js';
export type { SessionMetadata, SessionStoreOptions } from './session-store/types.js';
