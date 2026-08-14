import { SessionStoreSave } from './save.js';

/**
 * Concrete SQLite-backed session store. All behaviour lives on the abstract
 * partial chain (`SessionStoreBase` → coordinator → load → save); this leaf is
 * referenced by those ancestors only as a type so the coordinator can hold and
 * reconstruct full instances without a runtime import cycle.
 */
export class SessionStore extends SessionStoreSave {}

export default SessionStore;
