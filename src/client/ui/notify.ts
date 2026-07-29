/**
 * System notifications for conversations that need the user.
 *
 * Distinct from `ui/notifications.ts`, which is the in-page toast stack: this
 * is the one that leaves the page. Everything here exists to satisfy two
 * constraints that pull against each other — reach somebody who is looking at
 * another window, another application or another tab, and never hand them a
 * pile of things to dismiss.
 *
 * The pile is dealt with by never showing more than one. Every alert this
 * module raises goes out under the same `tag`, so the browser replaces rather
 * than stacks, and when more than one conversation is outstanding the single
 * notification becomes a summary of them. Two conversations finishing while the
 * user is away is one notification, and so is one conversation finishing four
 * times.
 *
 * Delivery prefers the service worker's `showNotification` over the page's own
 * `new Notification`, because the page constructor throws outright on Android
 * Chrome — which is exactly the phone case the whole feature is for. The page
 * constructor stays as the fallback for a browser with no worker registered
 * (an untrusted certificate is enough to cause that; see `install-prompt.ts`).
 *
 * What this module does *not* do is decide when to alert. That is
 * `chat/attention.ts`, which knows what the events mean and what the user asked
 * to be told about.
 */

import type { ChatAlertKind } from '../../shared/chat-alerts.js';

/**
 * One tag for every conversation alert, on purpose.
 *
 * A tag per conversation would let three conversations produce three
 * notifications, which is the outcome this is here to prevent. The cost is that
 * the text has to carry which conversation it is, which it does.
 */
const TAG = 'cc-web-conversation';

/** What the service worker sends the page when a notification is acted on. */
export const OPEN_CONVERSATION_MESSAGE = 'cc-web-open-conversation';

/** The query parameter a cold-started window is opened with. */
const CONVERSATION_PARAM = 'conversation';

/**
 * How much of what happened a notification may quote.
 *
 * A notification is read on a lock screen, on a phone that is not the machine
 * the work is running on. Enough to decide whether it needs answering now, and
 * not the diff.
 */
const DETAIL_LIMIT = 96;

export type NotifyPermission = 'unsupported' | 'default' | 'granted' | 'denied';

export interface RaisedAlert {
  sessionId: string;
  kind: ChatAlertKind;
  /** What to call this conversation. Only used when `details` is on. */
  name: string;
  /** The command being approved, the question asked, the error. */
  detail?: string;
  /** What failed, when it was not the turn itself. See `ChatAlert.subject`. */
  subject?: string;
}

/** Alerts raised and not yet acted on, oldest first — `Map` keeps insertion order. */
const outstanding = new Map<string, RaisedAlert>();

/**
 * Whether the text may name the conversation and quote what happened.
 *
 * Held here rather than passed to `paint()` because a repaint can be triggered
 * by a clear as well as by a raise, and a summary that changed voice depending
 * on which of the two moved last would be worse than either.
 */
let quoteDetails = true;

/** The page-scoped notification currently on screen, when that is the path taken. */
let pageNotification: Notification | null = null;

/**
 * Guards the async gap in `paint()`.
 *
 * Asking the browser for its service-worker registration is a promise, and two
 * conversations finishing in the same tick both cross it. Without this the
 * older summary can land after the newer one and leave a stale count on screen.
 */
let generation = 0;

let openConversation: ((sessionId: string) => void) | null = null;

/**
 * A conversation the worker asked for before the app could open one.
 *
 * The worker finds any window and posts to it, including one that is still
 * fetching its session list — a notification survives a reload, so clicking one
 * during startup is ordinary rather than exotic. `postMessage` has no delivery
 * guarantee and no retry, so without this the click did nothing at all and the
 * notification it came from had already been closed.
 */
let pendingConversation: string | null = null;

export function isBlockingAlert(kind: ChatAlertKind): boolean {
  return kind === 'approval' || kind === 'question';
}

/**
 * What the browser will currently do with a notification.
 *
 * `unsupported` and `denied` are different problems with different advice — one
 * cannot be fixed from inside the page and the other cannot be fixed at all
 * once it has happened — so the settings dialog says which it is rather than
 * showing a button that would do nothing.
 */
export function notifyPermission(): NotifyPermission {
  if (typeof Notification === 'undefined') return 'unsupported';
  const permission = Notification.permission;
  return permission === 'granted' || permission === 'denied' ? permission : 'default';
}

/**
 * Ask for permission, from a user gesture.
 *
 * Deliberately not called at load. Firefox and Safari refuse a request that did
 * not come from a click and give the user no second chance, so a page that asks
 * on boot is a page whose notifications quietly never work on two of the three
 * engines. The settings dialog asks instead, when somebody switches this on.
 */
export async function requestNotifyPermission(): Promise<NotifyPermission> {
  if (typeof Notification === 'undefined') return 'unsupported';
  try {
    const result = await Notification.requestPermission();
    return result === 'granted' || result === 'denied' ? result : 'default';
  } catch {
    // Some browsers reject rather than resolve when the call is not allowed.
    return notifyPermission();
  }
}

/** Where a click on a notification takes the user. Wired once, by `App`. */
export function setConversationOpener(handler: (sessionId: string) => void): void {
  openConversation = handler;
  if (!pendingConversation) return;
  const waiting = pendingConversation;
  pendingConversation = null;
  handler(waiting);
}

/**
 * Raise (or replace) the alert for one conversation.
 *
 * Replacing rather than appending is what makes a conversation that finishes,
 * is asked something, and finishes again produce one notification saying the
 * latest thing rather than three saying all of them.
 */
export function raiseAlert(alert: RaisedAlert, details: boolean): void {
  quoteDetails = details;
  // With one exception: a bare "finished" never replaces a failure.
  //
  // A workflow that fails while its conversation is still working is followed
  // by that turn ending normally, seconds later — so the notification saying
  // something broke was replaced by one saying the conversation was done, which
  // is true and is not the thing the user needed to hear (#140). The reverse
  // still replaces: a failure after a finish is news.
  const standing = outstanding.get(alert.sessionId);
  if (standing?.kind === 'failed' && alert.kind === 'finished') return;
  // Deleted first so a re-raise moves to the back of the queue: the summary
  // names the conversation that has waited longest, and "longest" should mean
  // since it last had something to say.
  outstanding.delete(alert.sessionId);
  outstanding.set(alert.sessionId, alert);
  void paint();
}

/**
 * The user has dealt with this conversation, or it no longer needs them.
 *
 * `keep` spares one kind. Only the conversation going back to work uses it, and
 * only for `failed`: an approval that started running again was plainly
 * answered, but a workflow that broke is not un-broken by the agent carrying on
 * afterwards — which it does, seconds later, in the ordinary case (#140).
 */
export function clearAlert(sessionId: string, keep?: ChatAlertKind): void {
  if (keep && outstanding.get(sessionId)?.kind === keep) return;
  if (!outstanding.delete(sessionId)) return;
  void paint();
}

/** Everything outstanding, for the tests and for a sign-out. */
export function clearAllAlerts(): void {
  if (outstanding.size === 0) return;
  outstanding.clear();
  void paint();
}

export function outstandingAlerts(): RaisedAlert[] {
  return [...outstanding.values()];
}

async function paint(): Promise<void> {
  const mine = ++generation;
  const list = [...outstanding.values()];

  setBadge(list.length);

  if (list.length === 0) {
    await dismiss();
    return;
  }

  if (notifyPermission() !== 'granted') return;

  const { title, body } = compose(list, quoteDetails);
  // The oldest outstanding conversation is the one a click opens: with several
  // waiting, the one that has been blocked longest is the one costing time.
  const target = list[0].sessionId;

  const options: NotificationOptions & { renotify?: boolean } = {
    body,
    tag: TAG,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-48.png',
    // With one shared tag, every alert after the first is a replacement — and a
    // silent replacement is a notification the user never learns about.
    renotify: true,
    data: { sessionId: target },
  };

  const registration = await workerRegistration();
  if (generation !== mine) return;

  if (registration) {
    try {
      await registration.showNotification(title, options);
      return;
    } catch {
      // Fall through: a registration can exist and still refuse, notably while
      // a new worker is taking over.
    }
  }

  try {
    pageNotification?.close();
    const notification = new Notification(title, options);
    notification.onclick = () => {
      try {
        window.focus();
      } catch {
        // A window that cannot focus itself can still switch tabs.
      }
      openConversation?.(target);
      notification.close();
    };
    pageNotification = notification;
  } catch {
    // Android Chrome throws "Illegal constructor" here. There is nothing left
    // to try — the marks inside the app are what the user has, which is why
    // they are not conditional on any of this having worked.
  }
}

async function dismiss(): Promise<void> {
  pageNotification?.close();
  pageNotification = null;
  const registration = await workerRegistration();
  if (!registration) return;
  try {
    const shown = await registration.getNotifications({ tag: TAG });
    for (const notification of shown) notification.close();
  } catch {
    // Not supported everywhere; the tag still keeps the count at one.
  }
}

/** Title and body for whatever is outstanding, at the chosen level of detail. */
export function compose(
  list: RaisedAlert[],
  details: boolean,
): { title: string; body: string } {
  if (list.length > 1) {
    const waiting = list.filter((alert) => isBlockingAlert(alert.kind));
    const title = waiting.length
      ? `${list.length} conversations need you`
      : `${list.length} conversations finished`;
    return { title, body: details ? list.map((alert) => alert.name).join(', ') : '' };
  }

  const [alert] = list;
  if (!details) {
    // The bare version. Which conversation it is survives the click, so nothing
    // actionable is lost by not putting it on a lock screen.
    return {
      title: isBlockingAlert(alert.kind) ? 'A conversation needs you' : 'A conversation finished',
      body: '',
    };
  }

  return { title: alert.name, body: describe(alert) };
}

function describe(alert: RaisedAlert): string {
  const detail = shorten(alert.detail);
  switch (alert.kind) {
    case 'approval':
      return detail ? `Waiting for approval — ${detail}` : 'Waiting for approval.';
    case 'question':
      return detail ? `Asked you: ${detail}` : 'Asked you a question.';
    case 'failed': {
      // Named where the thing that failed is not the turn: a background
      // workflow's turn ended cleanly and some time ago, and telling somebody
      // "the turn failed" would send them looking at the wrong thing (#140).
      const what = alert.subject ? `${alert.subject} failed` : 'The turn failed';
      return detail ? `${what} — ${detail}` : `${what}.`;
    }
    default:
      return 'Finished, and ready for what is next.';
  }
}

function shorten(detail: string | undefined): string {
  if (!detail) return '';
  // Newlines make a notification body run to several lines for no gain; a
  // command with its arguments on separate lines is still one command.
  const flat = detail.replace(/\s+/g, ' ').trim();
  if (flat.length <= DETAIL_LIMIT) return flat;
  return `${flat.slice(0, DETAIL_LIMIT - 1).trimEnd()}…`;
}

/**
 * The installed app's own badge, where there is one.
 *
 * The one signal that survives with notifications refused *and* the window
 * closed: an icon in the launcher with a number on it. Guarded because it is
 * absent everywhere except installed PWAs on desktop Chrome and Safari.
 */
function setBadge(count: number): void {
  const nav = typeof navigator === 'undefined'
    ? null
    : (navigator as Navigator & {
      setAppBadge?: (count?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    });
  if (!nav) return;
  try {
    if (count > 0) void nav.setAppBadge?.(count)?.catch(() => {});
    else void nav.clearAppBadge?.()?.catch(() => {});
  } catch {
    // Not supported, or refused. Neither is worth a line in the console.
  }
}

async function workerRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    // `ready` never settles when nothing is registered — an insecure origin, or
    // a certificate the browser does not trust — so this asks the question that
    // has an answer either way.
    const registration = await navigator.serviceWorker.getRegistration();
    return registration ?? null;
  } catch {
    return null;
  }
}

/**
 * Listen for a notification the service worker handled on our behalf.
 *
 * A notification shown by the worker is clicked in the worker, which may not
 * even have a page at the time. Its handler focuses an existing window and
 * posts the conversation id here; only a window can switch tabs.
 */
export function startNotifyRouting(): void {
  // The launcher badge is app-scoped and outlives the page that set it, while
  // `outstanding` starts empty on every load — so a window opened tomorrow
  // morning inherits last night's count and nothing here would ever paint over
  // it. Reconciled first, and above the worker check, because badging does not
  // need a worker.
  setBadge(outstanding.size);

  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: string; sessionId?: string } | undefined;
    if (!data || data.type !== OPEN_CONVERSATION_MESSAGE) return;
    if (!data.sessionId) return;
    if (openConversation) openConversation(data.sessionId);
    else pendingConversation = data.sessionId;
  });
}

/**
 * The conversation a cold start was asked to open, once.
 *
 * When there was no window to focus, the worker opens one at
 * `/?conversation=<id>`. The parameter is removed as it is read so a reload —
 * or the browser restoring the tab tomorrow — does not drag the user back to a
 * conversation they have long since left.
 */
export function takeRequestedConversation(): string | null {
  // A click the worker delivered before anything could act on it comes first:
  // it is a second old, where the URL parameter is whatever this window was
  // opened with.
  if (pendingConversation) {
    const waiting = pendingConversation;
    pendingConversation = null;
    return waiting;
  }

  if (typeof window === 'undefined' || !window.location) return null;
  try {
    const url = new URL(window.location.href);
    const requested = url.searchParams.get(CONVERSATION_PARAM);
    if (!requested) return null;
    url.searchParams.delete(CONVERSATION_PARAM);
    window.history?.replaceState?.(null, '', `${url.pathname}${url.search}${url.hash}`);
    return requested;
  } catch {
    return null;
  }
}
