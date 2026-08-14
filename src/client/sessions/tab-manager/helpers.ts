/** Browser key used by older builds for session metadata. */
export const ACTIVE_TAB_KEY = 'cc-web-active-tab';

export function forgetStoredActiveTab(): void {
  for (const store of storages()) {
    try {
      store.removeItem(ACTIVE_TAB_KEY);
    } catch {
      // Storage may be disabled. No new session metadata is written there.
    }
  }
}

export function recallActiveTab(): null {
  forgetStoredActiveTab();
  return null;
}

export function sameOrder(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/**
 * The browser-local close list written by builds before tab membership belonged
 * to the account.
 *
 * New builds normally read it only during startup migration. It also becomes
 * the temporary authority when a newly loaded client is still talking to a
 * server from before the account-level tab endpoint existed. That compatibility
 * mode ends as soon as a tab write reaches a server that supports the endpoint.
 */
export const LEGACY_CLOSED_TABS_KEY = 'cc-web-closed-conversations';

export function takeLegacyClosedTabs(): Set<string> {
  try {
    const raw = localStorage.getItem(LEGACY_CLOSED_TABS_KEY);
    localStorage.removeItem(LEGACY_CLOSED_TABS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

/** This window's memory first, then the browser-wide one. */
export function storages(): Storage[] {
  const found: Storage[] = [];
  try {
    if (typeof sessionStorage !== 'undefined') found.push(sessionStorage);
  } catch { /* blocked */ }
  try {
    if (typeof localStorage !== 'undefined') found.push(localStorage);
  } catch { /* blocked */ }
  return found;
}