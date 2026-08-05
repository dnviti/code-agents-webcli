// Native package updates are deliberately separate from the HTTP server
// updater. This module is the renderer's small, defensive view of the Electron
// preload bridge: it cannot select a feed, a file, or a command.

import type { DesktopUpdateState, DesktopUpdatesBridge } from '../../shared/desktop-update';
import { shellStore, type DesktopUpdateView } from '../shell/store';

declare global {
  interface Window { desktopUpdates?: DesktopUpdatesBridge; }
}

let bridge: DesktopUpdatesBridge | null = null;
let unsubscribe: (() => void) | null = null;
let generation = 0;
let providerGeneration = -1;
let manuallyOpenedVersion: string | null = null;
let hydration: Promise<void> = Promise.resolve();

const PHASES = new Set<DesktopUpdateView['phase']>([
  'disabled', 'idle', 'checking', 'available', 'downloading', 'ready', 'installing', 'restarting',
  'up_to_date', 'error',
]);

function text(value: unknown, maximum = 500): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maximum) : null;
}

function toView(snapshot: unknown): DesktopUpdateView | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const raw = snapshot as Partial<DesktopUpdateState>;
  if (typeof raw.phase !== 'string' || !PHASES.has(raw.phase as DesktopUpdateView['phase'])) return null;
  const targetVersion = text(raw.targetVersion, 80);
  const phase = raw.phase as DesktopUpdateView['phase'];
  const busy = phase === 'downloading' || phase === 'ready'
    || phase === 'installing' || phase === 'restarting';
  const promptOpen = targetVersion !== null && (
    busy || raw.prompt === 'automatic' || manuallyOpenedVersion === targetVersion
  );
  const progress = raw.progress && typeof raw.progress.percent === 'number'
    ? raw.progress.percent : null;
  return {
    phase,
    provider: raw.provider === 'electron' || raw.provider === 'flatpak' ? raw.provider : null,
    currentVersion: text(raw.currentVersion, 80) ?? '',
    targetVersion,
    summary: text(raw.releaseNotes) ?? text(raw.releaseName, 200),
    releaseDate: text(raw.releaseDate, 80),
    progress: progress !== null && Number.isFinite(progress)
      ? Math.max(0, Math.min(100, progress)) : null,
    errorCode: text(raw.errorCode, 80),
    error: text(raw.errorMessage),
    retryable: raw.retryable === true,
    generation: typeof raw.generation === 'number' && Number.isSafeInteger(raw.generation)
      ? raw.generation : 0,
    promptOpen,
  };
}

function publish(snapshot: unknown, sourceGeneration: number): void {
  if (sourceGeneration !== generation) return;
  const view = toView(snapshot);
  if (view && view.generation < providerGeneration) return;
  if (view) providerGeneration = view.generation;
  shellStore.setState({ desktopUpdate: view });
}

/** Starts only in Electron: ordinary browsers never expose this bridge. */
export function setupDesktopUpdates(): void {
  unsubscribe?.();
  unsubscribe = null;
  bridge = window.desktopUpdates ?? null;
  const currentBridge = bridge;
  const mine = ++generation;
  providerGeneration = -1;
  manuallyOpenedVersion = null;
  if (!currentBridge) {
    shellStore.setState({ desktopUpdate: null });
    hydration = Promise.resolve();
    return;
  }

  // Subscribe before awaiting hydration. A late initial result must not replace
  // a newer pushed snapshot after a renderer reload.
  try {
    const stop = currentBridge.subscribe((snapshot) => publish(snapshot, mine));
    unsubscribe = typeof stop === 'function' ? stop : null;
  } catch {
    unsubscribe = null;
  }
  hydration = Promise.resolve()
    .then(() => currentBridge.getSnapshot())
    .then((snapshot) => publish(snapshot, mine))
    .catch(() => {
      // A failed hydration must not erase an event already delivered by the
      // subscription we deliberately installed first.
      if (mine === generation && providerGeneration < 0) publish(null, mine);
    });
}

/** Resolves once the preload snapshot race has settled for this page load. */
export function whenDesktopUpdatesHydrated(): Promise<void> {
  return hydration;
}

export function openDesktopUpdate(): void {
  const current = shellStore.getSnapshot().desktopUpdate;
  if (!current?.targetVersion) return;
  manuallyOpenedVersion = current.targetVersion;
  shellStore.setState({ desktopUpdate: { ...current, promptOpen: true } });
}

function expectedVersion(): string | null {
  const update = shellStore.getSnapshot().desktopUpdate;
  return update?.targetVersion ?? null;
}

function publishCommandError(version: string, sourceGeneration: number): void {
  if (sourceGeneration !== generation) return;
  const current = shellStore.getSnapshot().desktopUpdate;
  if (current?.targetVersion !== version) return;
  manuallyOpenedVersion = version;
  shellStore.setState({
    desktopUpdate: {
      ...current,
      phase: 'error',
      error: 'The desktop updater could not complete that request.',
      retryable: true,
      promptOpen: true,
    },
  });
}

export async function deferDesktopUpdate(): Promise<void> {
  const version = expectedVersion();
  const currentBridge = bridge;
  if (!currentBridge || !version) return;
  manuallyOpenedVersion = null;
  const mine = generation;
  try {
    const snapshot = await currentBridge.defer(version);
    publish(snapshot, mine);
    if (mine !== generation) return;
    const current = shellStore.getSnapshot().desktopUpdate;
    if (current?.targetVersion === version) shellStore.setState({ desktopUpdate: { ...current, promptOpen: false } });
  } catch {
    publishCommandError(version, mine);
  }
}

export async function installDesktopUpdate(): Promise<void> {
  const version = expectedVersion();
  const currentBridge = bridge;
  if (!currentBridge || !version) return;
  manuallyOpenedVersion = version;
  const mine = generation;
  try {
    publish(await currentBridge.install(version), mine);
  } catch {
    publishCommandError(version, mine);
  }
}

export async function retryDesktopUpdate(): Promise<void> {
  const version = expectedVersion();
  const currentBridge = bridge;
  if (!currentBridge || !version) return;
  manuallyOpenedVersion = version;
  const mine = generation;
  try {
    publish(await currentBridge.retry(version), mine);
  } catch {
    publishCommandError(version, mine);
  }
}
