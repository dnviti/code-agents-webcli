import { MAX_QUEUED_TURNS } from '../../shared/chat-events.js';

export class ChatNotRunningError extends Error {
  constructor() {
    super('this chat session is not running');
    this.name = 'ChatNotRunningError';
  }
}

/**
 * The approval mode of a conversation, in one phrase, for the line drawn at the
 * top of it.
 *
 * A runtime with no approval channel is named rather than glossed over. pi's
 * chat adapter publishes `permissions: false` — no approval channel exists in
 * its CLI — so its tools run unattended whichever mode the rule computed, and
 * printing "you are asked before each tool call" over one of its conversations
 * would be this app claiming a boundary that is not there.
 */
export function approvalNoticeDetail(bypassing: boolean, canAsk: boolean): string {
  if (bypassing) return 'bypassed — tools run without asking';
  if (!canAsk) return 'this runtime cannot ask — tools run without asking';
  return 'on — you are asked before each tool call';
}

/** Thrown by `send` when the line is already as long as it may get. */
export class QueueFullError extends Error {
  constructor() {
    super(`there are already ${MAX_QUEUED_TURNS} messages waiting; let some run first`);
    this.name = 'QueueFullError';
  }
}

// These change only the live conversation's configuration. Every other
// runtime command is opaque to this server and may execute a skill or mutate
// the workspace, so it is refused while Plan mode's no-implementation promise
// is in force. /clear, /new and /reset are handled as lifecycle commands before
