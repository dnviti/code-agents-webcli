/**
 * The browser's half of branching a conversation at a turn.
 *
 * One POST, and everything that makes a branch a branch happens on the server:
 * the history is copied into a new conversation's log and left waiting as the
 * opening context of its first turn. What comes back is enough to open a tab on
 * it and launch the same agent in the same place.
 *
 * The refusal is as much the point as the success. A branch whose history will
 * not fit the model's window is turned down with the figures, because the one
 * thing this must never do is carry half a conversation and let the agent
 * answer as though it had all of it.
 */

export interface BranchedConversation {
  sessionId: string;
  name: string;
  workingDir: string;
  /** The agent the conversation it came from was running, or null if it never ran one. */
  runtime: string | null;
  /** Which turn of the original this was cut at, for what the user is told. */
  turnIndex: number;
  turns: number;
  estimatedTokens: number;
  contextWindow?: number;
  /**
   * False when the runtime never reported a window, so nothing could be
   * measured. Carried rather than inferred from a missing number: a reader has
   * to be able to tell a branch that fits from one nobody could size.
   */
  sizeChecked: boolean;
}

interface BranchFailure {
  error?: string;
  message?: string;
}

export async function branchConversation(
  sessionId: string,
  turnId: string,
): Promise<BranchedConversation> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/branch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ turnId }),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as BranchFailure;
    throw new Error(describeFailure(response.status, body));
  }

  return (await response.json()) as BranchedConversation;
}

/**
 * What went wrong, in words worth putting in front of someone.
 *
 * The server writes the too-large sentence itself, because only it knows the
 * three figures in it — and a message assembled here from a status code would
 * say "that did not work" for the one failure with an obvious next move.
 */
function describeFailure(status: number, body: BranchFailure): string {
  if (body.message) return body.message;
  switch (status) {
    case 401:
      return 'You have been signed out. Reload the page.';
    case 404:
      return 'That turn is no longer in this conversation.';
    case 501:
      return 'This server cannot branch conversations.';
    default:
      return `That branch could not be made (${status}).`;
  }
}
