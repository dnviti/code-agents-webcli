import { shellStore } from './store';

export interface WindowControlsOverlayState {
  visible: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TitlebarAreaRect { x: number; y: number; width: number; height: number; }
interface GeometryEvent extends Event { titlebarAreaRect?: TitlebarAreaRect; }

export interface WindowControlsOverlayApi {
  visible: boolean;
  getTitlebarAreaRect(): TitlebarAreaRect;
  addEventListener(type: 'geometrychange', listener: (event: GeometryEvent) => void): void;
  removeEventListener(type: 'geometrychange', listener: (event: GeometryEvent) => void): void;
}

const HIDDEN: WindowControlsOverlayState = { visible: false, x: 0, y: 0, width: 0, height: 0 };

function metric(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function readWindowControlsOverlay(
  overlay: WindowControlsOverlayApi | null,
  reportedRect?: TitlebarAreaRect,
): WindowControlsOverlayState {
  if (!overlay || overlay.visible !== true) return HIDDEN;
  let rect: TitlebarAreaRect;
  try { rect = reportedRect ?? overlay.getTitlebarAreaRect(); } catch { return HIDDEN; }
  const next = {
    visible: true,
    x: metric(rect.x), y: metric(rect.y),
    width: metric(rect.width), height: metric(rect.height),
  };
  // A visible overlay without a usable safe rectangle is a partial/broken
  // implementation. Treat it as unsupported so ordinary chrome never becomes
  // draggable or leaves a blank title-bar gap.
  return next.width > 0 && next.height > 0 ? next : HIDDEN;
}

export function watchWindowControlsOverlay(
  overlay: WindowControlsOverlayApi | null,
  publish: (state: WindowControlsOverlayState) => void,
): () => void {
  if (!overlay) { publish(HIDDEN); return () => {}; }
  const sync = (event?: GeometryEvent): void => {
    publish(readWindowControlsOverlay(overlay, event?.titlebarAreaRect));
  };
  try { overlay.addEventListener('geometrychange', sync); } catch {
    publish(HIDDEN);
    return () => {};
  }
  sync();
  return () => {
    try { overlay.removeEventListener('geometrychange', sync); } catch { /* page teardown */ }
  };
}

export function publishWindowControlsOverlayToDocument(
  state: WindowControlsOverlayState,
  root: HTMLElement = document.documentElement,
): void {
  root.dataset.windowControlsOverlay = state.visible ? 'visible' : 'hidden';
  root.style.setProperty('--window-controls-x', `${state.x}px`);
  root.style.setProperty('--window-controls-y', `${state.y}px`);
  root.style.setProperty('--window-controls-width', `${state.width}px`);
  root.style.setProperty('--window-controls-height', `${state.height}px`);
  root.style.setProperty('--window-controls-bottom', `${state.y + state.height}px`);
}

function browserOverlay(): WindowControlsOverlayApi | null {
  const candidate = (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlayApi })
    .windowControlsOverlay;
  if (!candidate
    || typeof candidate.getTitlebarAreaRect !== 'function'
    || typeof candidate.addEventListener !== 'function'
    || typeof candidate.removeEventListener !== 'function') return null;
  return candidate;
}

export function setupWindowControlsOverlay(): () => void {
  return watchWindowControlsOverlay(browserOverlay(), (windowControlsOverlay) => {
    publishWindowControlsOverlayToDocument(windowControlsOverlay);
    shellStore.setState({ windowControlsOverlay });
  });
}
