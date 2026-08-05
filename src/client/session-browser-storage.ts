/**
 * Retire browser-profile copies of workspace/session data written by old builds.
 *
 * Electron persists Web Storage below userData. New code keeps these values in
 * `.cc-web`; this cleanup runs before the app is constructed so even drafts for
 * conversations that are never reopened are removed from an upgraded profile.
 */
export function purgeLegacySessionBrowserState(): void {
  try {
    const remove: string[] = [];
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      if (
        key === 'cc-web-active-tab'
        || key === 'cc-web-chat-terminals'
        || key?.startsWith('cc-web-chat-draft:')
      ) remove.push(key);
    }
    for (const key of remove) sessionStorage.removeItem(key);
  } catch {
    // Storage can be disabled; the application still makes no new writes.
  }

  try {
    localStorage.removeItem('cc-web-active-tab');
    localStorage.removeItem('cc-web-closed-conversations');
    const sessionMaintenanceKeys: string[] = [];
    const maintenancePrefix = 'cc-agent-maintenance-operation:';
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      // Both historical forms contain a session/target id and an in-flight
      // operation id. Neither is a presentation preference, so neither may
      // survive in Chromium's installation-level profile.
      if (key?.startsWith(maintenancePrefix)) sessionMaintenanceKeys.push(key);
    }
    for (const key of sessionMaintenanceKeys) localStorage.removeItem(key);

    // Preserve the one device preference in the old split blob while stripping
    // session assignments and focus metadata from it.
    const raw = localStorage.getItem('cc-web-splits');
    if (!raw) return;
    const parsed = JSON.parse(raw) as { dividerPosition?: unknown } | null;
    if (parsed && typeof parsed.dividerPosition === 'number' && Number.isFinite(parsed.dividerPosition)) {
      localStorage.setItem('cc-web-splits', JSON.stringify({
        dividerPosition: parsed.dividerPosition,
      }));
    } else {
      localStorage.removeItem('cc-web-splits');
    }
  } catch {
    try { localStorage.removeItem('cc-web-splits'); } catch { /* blocked */ }
  }
}
