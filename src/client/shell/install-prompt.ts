// PWA install prompt.
//
// This used to be an inline <script> in index.html that appended a fixed-
// position button with a hand-written `style.cssText` — the one control in the
// app that ignored the design system entirely, and that covered the bottom-right
// corner of the terminal until it was dismissed. The event is captured here
// instead and offered from the More sheet, Settings and the command palette.

import { showNotification } from '../ui/notifications';
import { shellStore, type InstallState } from './store';

/**
 * `BeforeInstallPromptEvent` is Chromium-only and not in lib.dom, so the two
 * members actually used are declared rather than pulling in a shim.
 */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: InstallPromptEvent | null = null;

/**
 * Is this window already the installed app?
 *
 * `display-mode: standalone` covers every browser that honours the manifest.
 * `navigator.standalone` is the iOS-only flag for a page opened from the home
 * screen, which is the one case that matters most here — iOS never fires
 * `beforeinstallprompt`, so without this an installed iOS app would still be
 * told it could be installed.
 */
export function isInstalled(
  targetWindow: Pick<Window, 'matchMedia'> = window,
  targetNavigator: { standalone?: boolean } = navigator as { standalone?: boolean },
): boolean {
  try {
    if (targetWindow.matchMedia('(display-mode: window-controls-overlay)').matches) return true;
    if (targetWindow.matchMedia('(display-mode: standalone)').matches) return true;
    if (targetWindow.matchMedia('(display-mode: minimal-ui)').matches) return true;
  } catch {
    // matchMedia is missing only in very old engines; fall through.
  }
  return targetNavigator.standalone === true;
}

/**
 * iOS has no install API at all: the user has to go through the share sheet.
 * Detected so the UI can say what to do instead of offering a button that
 * cannot work. Excludes Chrome/Firefox on iOS, which cannot install either.
 */
function isIos(): boolean {
  const ua = navigator.userAgent;
  const iosDevice = /iPad|iPhone|iPod/.test(ua);
  // iPadOS 13+ reports as a Mac; the touch points give it away.
  const iPadOs = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  return iosDevice || iPadOs;
}

/**
 * Can this origin install at all?
 *
 * A service worker is refused outside a secure context, and without one no
 * browser fires `beforeinstallprompt`. This app is very often reached at
 * http://192.168.x.x:32352 from a second machine, which is exactly that case —
 * so this is checked before blaming the browser, which is not at fault and
 * cannot be swapped for one that fixes it.
 */
function isSecureOrigin(): boolean {
  // isSecureContext already treats localhost and 127.0.0.1 as trustworthy.
  return window.isSecureContext !== false;
}

/**
 * The same deployment as seen from the machine it runs on, which is a secure
 * context and therefore installable. Quoted in the advice rather than left as
 * "use localhost", so the port is not something the reader has to remember.
 */
export function localUrl(): string {
  const port = window.location.port ? `:${window.location.port}` : '';
  return `https://localhost${port}`;
}

/** Where this server offers the CA a device has to trust once. */
export function caUrl(): string {
  return `${window.location.origin}/ca.crt`;
}

/**
 * Set once the service worker has been given long enough to become ready and
 * has not. Only meaningful on a secure origin.
 */
let workerBlocked = false;

/** How long to let registration settle before calling it refused. */
const WORKER_GRACE_MS = 8000;

function resolveState(): InstallState {
  if (isInstalled()) return 'installed';
  // A held prompt outranks everything below: if the browser handed one over,
  // the criteria are met by definition.
  if (deferred) return 'available';
  if (!isSecureOrigin()) return 'insecure';
  if (workerBlocked) return 'blocked';
  if (isIos()) return 'ios';
  return 'unsupported';
}

/**
 * Wait for the service worker, and remember if it never arrives.
 *
 * This deployment signs its certificate with a CA generated on the server, so
 * every browser has to trust that CA once. Until it does, clicking past the
 * warning gives a page that looks completely normal: https in the address bar,
 * `isSecureContext` true, everything rendering — and a service worker the
 * browser silently refuses to register, because it treats an origin with
 * certificate errors as ineligible. Installing is then impossible for a reason
 * nothing on the page mentions.
 *
 * `navigator.serviceWorker.ready` is the signal, but it never rejects: on
 * failure it simply never settles, so the only way to read it is to stop
 * waiting.
 */
async function watchServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) {
    workerBlocked = true;
    publish();
    return;
  }

  const ready = navigator.serviceWorker.ready.then(() => true);
  const gaveUp = new Promise<boolean>((resolve) => {
    setTimeout(() => resolve(false), WORKER_GRACE_MS);
  });

  workerBlocked = !(await Promise.race([ready, gaveUp]));
  publish();
}

function publish(): void {
  shellStore.setState({ install: resolveState() });
}

export function setupInstallPrompt(): void {
  window.addEventListener('beforeinstallprompt', (event) => {
    // Without this the browser shows its own mini-infobar and the deferred
    // prompt is never usable.
    event.preventDefault();
    deferred = event as InstallPromptEvent;
    publish();
  });

  window.addEventListener('appinstalled', () => {
    deferred = null;
    publish();
  });

  // A window can be *launched* installed, in which case beforeinstallprompt
  // never fires and nothing above would ever run.
  publish();

  // Deliberately not awaited: this resolves seconds later and only sharpens the
  // reason shown in Settings.
  void watchServiceWorker();
}

/**
 * The single entry point the UI calls.
 *
 * On a browser that hands over a prompt this installs. On iOS there is no API
 * to call, so the only useful thing is to say where the control actually lives
 * — a button that silently did nothing would be worse than no button, which is
 * the reason this indirection exists at all.
 */
export async function installHint(): Promise<void> {
  const { install } = shellStore.getSnapshot();

  if (install === 'available') {
    await promptInstall();
    return;
  }

  if (install === 'ios') {
    showNotification('Open the browser share menu, then "Add to Home Screen".');
    return;
  }

  if (install === 'installed') {
    showNotification('The app is already installed.');
    return;
  }

  if (install === 'blocked') {
    showNotification(
      `This browser does not trust the server's certificate yet. Install ${caUrl()} `
      + 'and restart the browser.',
      'error',
    );
    return;
  }

  if (install === 'insecure') {
    showNotification(
      `Installing needs a secure origin. Open ${localUrl()} on this machine, or serve the app over HTTPS.`,
      'error',
    );
    return;
  }

  showNotification('This browser is not offering an install for this app.', 'error');
}

/**
 * Show the browser's install dialog.
 *
 * The event is single-use: whatever the user chooses, it cannot be prompted
 * again, so the entry point is withdrawn either way rather than left in place
 * as a control that does nothing on a second press.
 */
export async function promptInstall(): Promise<void> {
  const event = deferred;
  if (!event) return;

  deferred = null;

  try {
    await event.prompt();
    await event.userChoice;
  } catch {
    // A prompt refused by the browser is not worth an error of its own.
  } finally {
    // `appinstalled` covers acceptance, but a dismissal fires nothing at all,
    // and the entry must still go — the prompt cannot be reused.
    publish();
  }
}
