// Update banner: shows whether a newer build exists, and applies it.

import type { App } from '../app';
import type {
  UpdateStatus,
  UpdateStatusResponse,
  WsUpdateDoneMessage,
} from '../types';
import { describeUpdate, INSTALL_COMMAND } from '../../shared/update';
import { shellStore } from '../shell/store';
import { showNotification } from './notifications';

const DISMISS_KEY = 'cc-web-update-dismissed';
/** Give the service this long to come back before saying so. */
const RESTART_POLL_LIMIT_MS = 90_000;
const RESTART_POLL_INTERVAL_MS = 2000;

let current: UpdateStatusResponse | null = null;
let logLines: string[] = [];
let logOpen = false;
let restartPollStartedAt: number | null = null;
/**
 * Set while the restart poll is narrating, and cleared by the next real render.
 *
 * The poll has something to say that no `UpdateStatusResponse` describes — the
 * server is not answering — so it overrides the derived text rather than trying
 * to encode "down" as a status.
 */
let overrideText: string | null = null;
/** Set by setupUpdateBanner so the React handlers can reach the app. */
let bannerApp: App | null = null;

function dismissedSha(): string | null {
  try {
    return localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

export function setupUpdateBanner(app: App): void {
  bannerApp = app;
  void refresh(app);
}

/** Wired to the banner's action button by the shell. */
export function onBannerAction(): void {
  if (bannerApp) void onAction(bannerApp);
}

export function onBannerToggleLog(): void {
  logOpen = !logOpen;
  render();
}

export function onBannerDismiss(): void {
  const sha = current?.status.remote.sha;
  try {
    // Keyed by commit, so a newer one brings the banner back.
    localStorage.setItem(DISMISS_KEY, sha ?? 'none');
  } catch {
    // Private browsing; the banner simply reappears on reload.
  }
  render();
}

export async function refresh(app: App): Promise<void> {
  try {
    const res = await app.authFetch('/api/update/status');
    if (!res.ok) {
      return;
    }
    current = (await res.json()) as UpdateStatusResponse;
    logLines = current.logTail ?? [];
    // A fresh status supersedes whatever the restart poll was narrating.
    overrideText = null;
    render();
  } catch {
    // The banner is never worth an error of its own.
  }
}

/** A pushed status only replaces the status half; mode and rights are per-user. */
export function applyUpdateStatus(status: UpdateStatus): void {
  if (!current) {
    return;
  }
  current = { ...current, status };
  render();
}

export function appendUpdateLog(line: string): void {
  logLines.push(line);
  if (logLines.length > 500) {
    logLines.shift();
  }
  if (current) {
    current = { ...current, running: true };
  }
  render();
}

export function onUpdateRestarting(): void {
  if (current) {
    current = { ...current, runnerState: 'restarting' };
  }
  render();
  startRestartPoll();
}

export function onUpdateDone(app: App, message: WsUpdateDoneMessage): void {
  if (current) {
    current = { ...current, running: false, runnerState: 'idle' };
  }
  showNotification(message.message, message.ok ? 'info' : 'error');
  render();
  if (!message.restarting) {
    void refresh(app);
  }
}

/**
 * Wait for the service to come back, then reload.
 *
 * Deliberately polls until a real response arrives rather than reloading on a
 * timer: during the restart window the server is down, and a reload then would
 * be served the old bundle out of the service worker cache.
 */
function startRestartPoll(): void {
  if (restartPollStartedAt !== null) {
    return;
  }
  restartPollStartedAt = Date.now();

  const tick = async (): Promise<void> => {
    const elapsed = Date.now() - (restartPollStartedAt ?? 0);
    if (elapsed > RESTART_POLL_LIMIT_MS) {
      restartPollStartedAt = null;
      setBannerText(
        'The service did not come back on its own. Check it with: '
        + 'systemctl --user status code-agents-webcli.service',
      );
      return;
    }

    try {
      // /api/ is not cached by the service worker, so this reaches the network.
      const res = await fetch('/api/health', { cache: 'no-store' });
      if (res.ok || res.status === 401) {
        await clearServiceWorkerCaches();
        window.location.reload();
        return;
      }
    } catch {
      // Still down.
    }
    setTimeout(() => void tick(), RESTART_POLL_INTERVAL_MS);
  };

  setTimeout(() => void tick(), RESTART_POLL_INTERVAL_MS);
}

/**
 * The bundle is served without a cache-busting name, so a stale service worker
 * cache would keep the old client running against the new server.
 */
async function clearServiceWorkerCaches(): Promise<void> {
  try {
    if (!('caches' in window)) {
      return;
    }
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
  } catch {
    // Best effort.
  }
}

function setBannerText(text: string): void {
  overrideText = text;
  render();
}

async function onAction(app: App): Promise<void> {
  if (!current) {
    return;
  }

  const view = describeUpdate(current);

  if (view.action === 'copy-command') {
    try {
      await navigator.clipboard.writeText(INSTALL_COMMAND);
      showNotification('Install command copied to the clipboard.');
    } catch {
      showNotification(INSTALL_COMMAND, 'error');
    }
    return;
  }

  if (view.action === 'retry') {
    setBannerText('Checking for updates…');
    try {
      const res = await app.authFetch('/api/update/check', { method: 'POST' });
      if (res.ok) {
        await refresh(app);
      }
    } catch {
      showNotification('Could not reach the server to check for updates.', 'error');
    }
    return;
  }

  if (view.action !== 'update') {
    return;
  }

  const sessions = current.activeSessions;
  const consequence =
    current.mode === 'systemd'
      ? `\n\nThe service will restart, which ends ${sessions} running agent session${
        sessions === 1 ? '' : 's'
      } — including other users'.`
      : '\n\nYou will need to stop and restart this process yourself afterwards.';

  if (!window.confirm(`Install the newer build?${consequence}`)) {
    return;
  }

  logLines = [];
  logOpen = true;
  current = { ...current, running: true };
  render();

  try {
    const res = await app.authFetch('/api/update/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmed: true }),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      current = { ...current, running: false };
      showNotification(`Update refused: ${body.error ?? res.status}`, 'error');
      render();
    }
  } catch {
    current = { ...current, running: false };
    showNotification('Could not start the update.', 'error');
    render();
  }
}

function render(): void {
  if (!current) {
    return;
  }

  const view = describeUpdate(current);
  const remoteSha = current.status.remote.sha ?? 'none';
  const hidden =
    !view.visible || (view.dismissible && dismissedSha() === remoteSha && !current.running);

  if (hidden) {
    shellStore.setState({ banner: null });
    return;
  }

  shellStore.setState({
    banner: {
      tone: view.tone,
      // The commit subject is whatever text landed on main and is not trusted;
      // the view renders it as a React child, never as markup.
      text: overrideText ?? view.text,
      actionLabel: view.action === null ? null : view.actionLabel ?? '',
      showLog: view.showLog,
      logOpen,
      dismissible: view.dismissible,
      log: logLines.join('\n'),
    },
  });
}
