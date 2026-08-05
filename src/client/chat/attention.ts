/**
 * Which conversations need the user, and who gets told.
 *
 * Two mechanisms, because "tell me now" and "show me what is still true" are
 * different questions and one answer cannot serve both:
 *
 *   the notification  is edge-triggered, from the event that changed something.
 *                     It fires once, when the turn ends or the agent stops to
 *                     ask, and never again for the same fact.
 *   the tab's mark    is derived, from the conversation's current state. It
 *                     survives a reload, because a rejoining browser is handed
 *                     the state in its snapshot; and it clears itself when the
 *                     approval is answered, wherever it was answered from.
 *
 * Doing the mark from events instead would mean a browser that reloaded while
 * an agent sat waiting came back with nothing on the tab, which is precisely
 * the case the mark exists for. Doing the notification from state instead would
 * mean re-announcing that state on every reconnect.
 *
 * The events arrive here already filtered for replays: the hook is called from
 * the controller only when the transcript actually applied the event, so a
 * reconnect that redelivers a `turn_end` the browser has already seen announces
 * nothing.
 */

import type { App } from '../app';
import { alertForEvent, endsAlert, type ConversationAttention } from '../../shared/chat-alerts.js';
import type { ChatEvent } from '../../shared/chat-events.js';
import { shellStore } from '../shell/store';
import { clearAlert, raiseAlert } from '../ui/notify';
import { getControllerSnapshot, parseQualifiedSessionId } from '../controller/transport';

/**
 * One conversation event, on its way to the user's attention.
 *
 * Called for every event of every conversation this browser watches, including
 * the token deltas of a streaming answer, so it does as little as possible
 * before deciding there is nothing to do.
 */
export function noteChatEvent(app: App, sessionId: string, event: ChatEvent): void {
  const alert = alertForEvent(event);

  if (alert) {
    announce(app, sessionId, alert.kind, alert.detail, alert.subject);
  } else if (endsAlert(event)) {
    // The conversation is moving again, or somebody answered it — possibly on
    // another device. A notification still sitting in the tray is now a lie.
    //
    // Except a failure, when all that happened is the conversation going back
    // to work. A background workflow fails while its own turn is still running
    // — that is the ordinary shape — and the `state` event a second later used
    // to take the notification away again before anybody read it (#140). What
    // failed still failed; only somebody arriving clears that.
    clearAlert(sessionId, event.t === 'state' ? 'failed' : undefined);
  }

  syncConversationAttention(app, sessionId);
}

/**
 * Publish whether this conversation is blocked, for the surfaces that show it
 * without opening it.
 *
 * Read from the transcript rather than accumulated here: the transcript folds
 * the same reducer the server does, so this is the conversation's own answer
 * and not a second opinion that can drift from it.
 */
export function syncConversationAttention(app: App, sessionId: string): void {
  const tabs = app.sessionTabManager;
  if (!tabs) return;

  const state = app.chats.get(sessionId)?.transcript.chatState;
  const attention: ConversationAttention | null =
    state === 'awaiting_permission' ? 'approval'
      : state === 'awaiting_answer' ? 'question'
        : null;

  tabs.setAttention(sessionId, attention);
}

/**
 * The user is now in this conversation.
 *
 * Only the notification is dropped. The tab's mark is derived state and stays
 * exactly as true as it was — an approval that is still unanswered when the
 * user leaves again has to be visible again, which is the one thing the unread
 * dot could never do (it is cleared on switch and nothing re-raises it).
 */
export function noteConversationOpened(sessionId: string): void {
  clearAlert(sessionId);
}

/**
 * The conversation's tab is gone.
 *
 * Its events stop being delivered the moment the registry drops it, so nothing
 * that would have ended an outstanding alert can arrive any more — and a
 * conversation nobody is watching would go on being counted in the summary for
 * the rest of the session.
 */
export function noteConversationClosed(sessionId: string): void {
  clearAlert(sessionId);
}

/**
 * Drop the notification for the conversation on screen when the user comes
 * back to the window.
 *
 * Coming back by clicking the notification is already handled — that switches
 * tabs. This is the other way back: alt-tab, or unlocking the phone, onto the
 * conversation the notification was about. Leaving it in the tray would make
 * the user dismiss something they have already dealt with.
 */
export function watchAttention(app: App): void {
  if (typeof document === 'undefined' || !document.addEventListener) return;
  const onReturn = (): void => {
    if (document.visibilityState !== 'visible') return;
    const active = app.sessionTabManager?.activeTabId;
    if (active) clearAlert(active);
  };
  document.addEventListener('visibilitychange', onReturn);
  if (typeof window !== 'undefined') window.addEventListener?.('focus', onReturn);
}

function announce(
  app: App,
  sessionId: string,
  kind: 'finished' | 'failed' | 'approval' | 'question',
  detail: string | undefined,
  subject?: string,
): void {
  // A conversation with no tab cannot be opened by the notification, and
  // nothing will ever arrive to end it — its events stopped when the tab
  // closed. That is not hypothetical: closing a tab mid-turn leaves the
  // unsubscribe in flight, the `turn_end` that crosses it rebuilds a controller
  // with an empty transcript, and the alert it raised would sit in the summary,
  // named "Conversation", for the rest of the page's life.
  if (!app.sessionTabManager?.tabs.has(sessionId)) return;

  const settings = shellStore.getSnapshot().notifications;
  if (!settings.enabled || !settings[kind]) return;

  // The one conversation nobody needs to be told about is the one they are
  // looking at. Everything else — another tab, another window, another
  // application, a phone in a pocket — is somebody who cannot see it.
  if (watching(app, sessionId)) return;

  raiseAlert(
    {
      sessionId,
      kind,
      name: app.sessionTabManager?.conversationLabel(sessionId) ?? 'Conversation',
      detail,
      subject,
      serverName: (() => {
        const owner = parseQualifiedSessionId(sessionId)?.serverId;
        return owner
          ? getControllerSnapshot().targets.find((target) => target.id === owner)?.name
          : undefined;
      })(),
    },
    settings.details,
  );
}

/**
 * Whether the user is actually looking at this conversation right now.
 *
 * All three conditions are load-bearing, and the middle one is the reason the
 * terminal side of this app cannot notify a focused window at all: a page can
 * be `visible` and still be behind the window the user is typing in, which is
 * the ordinary case of "I went to do something else while it worked".
 * `hasFocus()` is what separates the two.
 */
function watching(app: App, sessionId: string): boolean {
  if (app.sessionTabManager?.activeTabId !== sessionId) return false;
  if (typeof document === 'undefined') return false;
  if (document.visibilityState !== 'visible') return false;
  return document.hasFocus ? document.hasFocus() : true;
}
