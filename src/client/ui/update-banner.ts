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
import {
  controllerFetch,
  getControllerSnapshot,
  subscribeController,
} from '../controller/transport';

const DISMISS_KEY = 'cc-web-update-dismissed';
/** Give the service this long to come back before saying so. */
const RESTART_POLL_LIMIT_MS = 90_000;
const RESTART_POLL_INTERVAL_MS = 2000;
const BROWSER_OWNER = Symbol('single-server-browser');

type UpdateOwner = string | typeof BROWSER_OWNER;

interface OwnedUpdateState {
  current: UpdateStatusResponse | null;
  logLines: string[];
  logOpen: boolean;
  refreshGeneration: number;
  restartPollStartedAt: number | null;
  /** Narration that has no equivalent UpdateStatusResponse, such as timeout. */
  overrideText: string | null;
}

const states = new Map<UpdateOwner, OwnedUpdateState>();
/** Set by setupUpdateBanner so the React handlers can reach the app. */
let bannerApp: App | null = null;
let unsubscribeController: (() => void) | null = null;
let lastSelectedOwner: UpdateOwner | null = null;

function newState(): OwnedUpdateState {
  return {
    current: null,
    logLines: [],
    logOpen: false,
    refreshGeneration: 0,
    restartPollStartedAt: null,
    overrideText: null,
  };
}

function stateFor(owner: UpdateOwner): OwnedUpdateState {
  const existing = states.get(owner);
  if (existing) return existing;
  const created = newState();
  states.set(owner, created);
  return created;
}

/** The visible surface owns either the selected controller target or one browser server. */
function selectedOwner(): UpdateOwner | null {
  const controller = getControllerSnapshot();
  if (!controller.enabled) return BROWSER_OWNER;
  return controller.selectedServerId === 'local' ? null : controller.selectedServerId;
}

/**
 * A controller WebSocket event is useful only when the gateway qualified it.
 * Silently assigning an unqualified background event to the selected server is
 * the exact cross-server mutation this module must prevent.
 */
function eventOwner(serverId?: string | null): UpdateOwner | null {
  const controller = getControllerSnapshot();
  if (!controller.enabled) return BROWSER_OWNER;
  if (!serverId || serverId === 'local'
    || !controller.targets.some((target) => target.id === serverId)) return null;
  return serverId;
}

function explicitServerId(owner: UpdateOwner): string | null {
  return owner === BROWSER_OWNER ? null : owner;
}

function isSelected(owner: UpdateOwner): boolean {
  return selectedOwner() === owner;
}

function targetName(owner: UpdateOwner): string | null {
  if (owner === BROWSER_OWNER) return null;
  return getControllerSnapshot().targets.find((target) => target.id === owner)?.name ?? null;
}

function ownerLabel(owner: UpdateOwner): string | null {
  if (owner === BROWSER_OWNER) return null;
  const name = targetName(owner) ?? 'Unknown server';
  return `Server · ${name}`;
}

function dismissalKey(owner: UpdateOwner): string {
  // Preserve the ordinary browser's established key. Controller dismissals are
  // per stable server id so matching release SHAs cannot hide one another.
  return owner === BROWSER_OWNER ? DISMISS_KEY : `${DISMISS_KEY}:${owner}`;
}

function dismissedSha(owner: UpdateOwner): string | null {
  try {
    return localStorage.getItem(dismissalKey(owner));
  } catch {
    return null;
  }
}

export function setupUpdateBanner(app: App): void {
  bannerApp = app;
  unsubscribeController?.();
  lastSelectedOwner = selectedOwner();
  unsubscribeController = subscribeController(() => {
    const owner = selectedOwner();
    const changed = owner !== lastSelectedOwner;
    lastSelectedOwner = owner;

    if (changed) shellStore.setState({ banner: null });

    if (owner === null) {
      shellStore.setState({ banner: null });
      return;
    }

    const state = states.get(owner);
    if (state?.current) {
      // Also redraw on a same-owner catalog publication: its friendly name may
      // have changed, but its status and actions still belong to the same id.
      render(owner);
      if (changed) void refreshOwner(app, owner);
      return;
    }

    shellStore.setState({ banner: null });
    void refreshOwner(app, owner);
  });

  const owner = selectedOwner();
  if (owner !== null) void refreshOwner(app, owner);
}

/** Wired to the banner's action button by the shell. */
export function onBannerAction(serverId?: string): Promise<void> {
  const owner = serverId === undefined ? selectedOwner() : eventOwner(serverId);
  return bannerApp && owner !== null ? onAction(bannerApp, owner) : Promise.resolve();
}

export function onBannerToggleLog(serverId?: string): void {
  const owner = serverId === undefined ? selectedOwner() : eventOwner(serverId);
  if (owner === null) return;
  const state = states.get(owner);
  if (!state?.current) return;
  state.logOpen = !state.logOpen;
  render(owner);
}

export function onBannerDismiss(serverId?: string): void {
  const owner = serverId === undefined ? selectedOwner() : eventOwner(serverId);
  if (owner === null) return;
  const state = states.get(owner);
  const sha = state?.current?.status.remote.sha;
  try {
    // Keyed by both server and commit, so another server at the same SHA is
    // still independent and a newer SHA brings this server's banner back.
    localStorage.setItem(dismissalKey(owner), sha ?? 'none');
  } catch {
    // Private browsing; the banner simply reappears on reload.
  }
  render(owner);
}

export async function refresh(app: App, serverId?: string | null): Promise<void> {
  const owner = serverId === undefined ? selectedOwner() : eventOwner(serverId);
  if (owner === null) return;
  await refreshOwner(app, owner);
}

async function refreshOwner(app: App, owner: UpdateOwner): Promise<void> {
  const state = stateFor(owner);
  const generation = ++state.refreshGeneration;
  try {
    const res = await app.authFetch(
      '/api/update/status',
      {},
      explicitServerId(owner),
    );
    if (!res.ok) return;

    const current = (await res.json()) as UpdateStatusResponse;
    if (state.refreshGeneration !== generation) return;
    state.current = current;
    state.logLines = current.logTail ?? [];
    // A fresh status supersedes whatever this server's restart poll narrated.
    state.overrideText = null;
    render(owner);
  } catch {
    // The banner is never worth an error of its own.
  }
}

/** A pushed status only replaces the status half; mode and rights are per-user. */
export function applyUpdateStatus(status: UpdateStatus, serverId?: string | null): void {
  const owner = eventOwner(serverId);
  if (owner === null) return;
  const state = stateFor(owner);
  if (!state.current) {
    if (bannerApp) void refreshOwner(bannerApp, owner);
    return;
  }
  state.current = { ...state.current, status };
  render(owner);
}

export function appendUpdateLog(line: string, serverId?: string | null): void {
  const owner = eventOwner(serverId);
  if (owner === null) return;
  const state = stateFor(owner);
  state.logLines.push(line);
  if (state.logLines.length > 500) state.logLines.shift();
  if (!state.current) {
    if (bannerApp) void refreshOwner(bannerApp, owner);
    return;
  }
  state.current = { ...state.current, running: true };
  render(owner);
}

export function onUpdateRestarting(serverId?: string | null): void {
  const owner = eventOwner(serverId);
  if (owner === null) return;
  const state = stateFor(owner);
  if (state.current) {
    state.current = { ...state.current, runnerState: 'restarting' };
    render(owner);
  }
  startRestartPoll(owner);
}

export function onUpdateDone(
  app: App,
  message: WsUpdateDoneMessage,
  serverId?: string | null,
): void {
  const owner = eventOwner(serverId);
  if (owner === null) return;
  const state = states.get(owner);
  if (state?.current) {
    state.current = { ...state.current, running: false, runnerState: 'idle' };
  }
  const label = ownerLabel(owner);
  showNotification(label ? `${label}: ${message.message}` : message.message, message.ok ? 'info' : 'error');
  render(owner);
  if (!message.restarting) void refreshOwner(app, owner);
}

/**
 * Wait for one exact service to come back.
 *
 * In an ordinary browser the updated server also owns the client bundle, so a
 * successful poll clears the service-worker cache and reloads. In controller
 * mode the loopback gateway owns the bundle: a remote recovery refreshes only
 * that remote's status and must not reload work on another selected server.
 */
function startRestartPoll(owner: UpdateOwner): void {
  const state = stateFor(owner);
  if (state.restartPollStartedAt !== null) return;
  state.restartPollStartedAt = Date.now();

  const tick = async (): Promise<void> => {
    const elapsed = Date.now() - (state.restartPollStartedAt ?? 0);
    if (elapsed > RESTART_POLL_LIMIT_MS) {
      state.restartPollStartedAt = null;
      setBannerText(
        owner,
        'The service did not come back on its own. Check it with: '
        + 'systemctl --user status code-agents-webcli.service',
      );
      return;
    }

    try {
      // /api/ is not cached by the service worker, so this reaches the network.
      const res = await controllerFetch(
        '/api/health',
        { cache: 'no-store' },
        explicitServerId(owner),
      );
      if (res.ok || res.status === 401) {
        state.restartPollStartedAt = null;
        if (owner === BROWSER_OWNER) {
          await clearServiceWorkerCaches();
          window.location.reload();
        } else if (bannerApp) {
          await refreshOwner(bannerApp, owner);
        }
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
 * cache would keep an ordinary browser running old code against a new server.
 */
async function clearServiceWorkerCaches(): Promise<void> {
  try {
    if (!('caches' in window)) return;
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
  } catch {
    // Best effort.
  }
}

function setBannerText(owner: UpdateOwner, text: string): void {
  stateFor(owner).overrideText = text;
  render(owner);
}

async function onAction(app: App, owner: UpdateOwner): Promise<void> {
  const state = states.get(owner);
  if (!state?.current) return;

  const current = state.current;
  const view = describeUpdate(current);
  const serverId = explicitServerId(owner);
  const label = ownerLabel(owner);

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
    setBannerText(owner, 'Checking for updates…');
    try {
      const res = await app.authFetch('/api/update/check', { method: 'POST' }, serverId);
      if (res.ok) await refreshOwner(app, owner);
    } catch {
      showNotification(
        label ? `Could not reach ${label.toLowerCase()} to check for updates.`
          : 'Could not reach the server to check for updates.',
        'error',
      );
    }
    return;
  }

  if (view.action !== 'update') return;

  const sessions = current.activeSessions;
  const consequence =
    current.mode === 'systemd'
      ? `\n\nThe service will restart, which ends ${sessions} running agent session${
        sessions === 1 ? '' : 's'
      } — including other users'.`
      : '\n\nYou will need to stop and restart this process yourself afterwards.';
  const target = label ? ` on ${label.replace(/^Server · /, '')}` : '';

  if (!window.confirm(`Install the newer build${target}?${consequence}`)) return;

  state.logLines = [];
  state.logOpen = true;
  state.current = { ...current, running: true };
  render(owner);

  try {
    const res = await app.authFetch('/api/update/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmed: true }),
    }, serverId);

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      state.current = { ...state.current, running: false };
      showNotification(
        `${label ? `${label}: ` : ''}Update refused: ${body.error ?? res.status}`,
        'error',
      );
      render(owner);
    }
  } catch {
    state.current = { ...state.current, running: false };
    showNotification(`${label ? `${label}: ` : ''}Could not start the update.`, 'error');
    render(owner);
  }
}

function render(owner: UpdateOwner): void {
  const state = states.get(owner);
  const current = state?.current;
  // A background server may update its state and log, but only the currently
  // selected owner paints the server channel. Native package updates have a
  // separate Electron bridge and never pass through this commit-based banner.
  if (!isSelected(owner)) return;
  if (!state || !current) {
    shellStore.setState({ banner: null });
    return;
  }

  const view = describeUpdate(current);
  const remoteSha = current.status.remote.sha ?? 'none';
  const hidden =
    !view.visible || (view.dismissible && dismissedSha(owner) === remoteSha && !current.running);

  if (hidden) {
    shellStore.setState({ banner: null });
    return;
  }

  let text = state.overrideText ?? view.text;
  if (owner !== BROWSER_OWNER) {
    const name = targetName(owner) ?? 'Unknown server';
    text = `Server update · ${name}: ${text}`;
  }

  shellStore.setState({
    banner: {
      ownerId: owner === BROWSER_OWNER ? null : owner,
      tone: view.tone,
      // The commit subject is whatever text landed on main and is not trusted;
      // the view renders it as a React child, never as markup.
      text,
      actionLabel: view.action === null ? null : view.actionLabel ?? '',
      showLog: view.showLog,
      logOpen: state.logOpen,
      dismissible: view.dismissible,
      log: state.logLines.join('\n'),
    },
  });
}
