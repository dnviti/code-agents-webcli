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
 */

export interface ChatSurfaceInfo {
  active: boolean;
  runtime?: string;
  runtimeLabel?: string;
  workingDir?: string;
  bypassPermissions?: boolean;
}

export function setChatSurface(app: App, info: ChatSurfaceInfo): void {
  const previous = shellStore.getSnapshot().chat;

  shellStore.setState({
    chat: {
      active: info.active,
      controller: info.active ? app.chat : null,
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
  setChatSurface(app, { active: current.active });
}

/**
 * Leaving a chat: drop the transcript and go back to the terminal surface.
 *
 * The transcript is reset rather than kept, because the next session to occupy
 * this shell may be a different conversation entirely and showing the previous
 * one while its snapshot loads is worse than showing nothing.
 */
export function clearChatSurface(app: App): void {
  app.chat.reset();
  shellStore.setState({
    chat: {
      active: false,
      controller: null,
      runtime: '',
      runtimeLabel: '',
      workingDir: '',
      bypassPermissions: false,
    },
  });
}
