import type { App } from '../app.js';
import { shellStore } from '../shell/store.js';

/**
 * Keeps the shell's view of the chat surface in step with the app.
 *
 * The surface a session runs on is decided by the server and arrives on
 * `session_joined` (for a session being re-entered) or `chat_started` (for one
 * just launched). Both funnel through here so there is a single place that
 * decides whether the shell shows a terminal or a conversation — two places
 * would eventually disagree, and the failure mode is a blank pane.
 *
 * What this does *not* do any more is tear a conversation down. Switching tabs
 * only changes which controller the shell is pointed at; every other one keeps
 * its transcript and its live subscription, which is what makes a background
 * chat still be there when the user comes back to it.
 */

export interface ChatSurfaceInfo {
  active: boolean;
  /** Which conversation the shell should show. Required when `active`. */
  sessionId?: string;
  runtime?: string;
  runtimeLabel?: string;
  workingDir?: string;
  bypassPermissions?: boolean;
}

export function setChatSurface(app: App, info: ChatSurfaceInfo): void {
  const previous = shellStore.getSnapshot().chat;
  const sessionId = info.sessionId ?? previous.sessionId;

  const controller = info.active && sessionId ? app.chats.ensure(sessionId) : null;

  shellStore.setState({
    chat: {
      active: info.active && Boolean(controller),
      sessionId: sessionId || '',
      controller,
      runtime: info.runtime ?? previous.runtime,
      runtimeLabel: info.runtimeLabel ?? previous.runtimeLabel,
      workingDir: info.workingDir ?? previous.workingDir,
      bypassPermissions: info.bypassPermissions ?? previous.bypassPermissions,
    },
  });
}

/** Re-publish the current surface, e.g. after the controller changed something. */
export function syncChatSurface(app: App): void {
  const current = shellStore.getSnapshot().chat;
  setChatSurface(app, { active: current.active, sessionId: current.sessionId });
}

/**
 * Show the terminal instead.
 *
 * The conversations themselves are left alone — this is a change of what is on
 * screen, not a decision that anything has ended.
 */
export function clearChatSurface(): void {
  shellStore.setState({
    chat: {
      active: false,
      sessionId: '',
      controller: null,
      runtime: '',
      runtimeLabel: '',
      workingDir: '',
      bypassPermissions: false,
    },
  });
}
