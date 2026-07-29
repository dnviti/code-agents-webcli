/**
 * The preferences that belong to a person rather than to a browser.
 *
 * Deliberately tiny, and deliberately not where the theme or the font size
 * live: those describe the screen in front of you and are right to differ
 * between a desktop and a phone. What is here is a decision about how agents
 * behave, which the same person expects the same answer to wherever they signed
 * in from (#134).
 */
export interface UserPreferences {
  /**
   * Start new web chats with tool approvals bypassed.
   *
   * A preference, not a switch on a running conversation: it is read at the
   * moment a conversation begins and never afterwards. See `resolveApprovalMode`
   * for what "begins" means, which is the whole of the rule.
   */
  chatBypassPermissions: boolean;
}

/** What a user who has never opened Settings gets: approvals on. */
export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  chatBypassPermissions: false,
};

/**
 * Coerce whatever storage, or a request body, hands over into real preferences.
 *
 * Strict equality rather than truthiness, the same convention the browser's own
 * settings loader has always used: anything that is not literally `true` —
 * `'true'`, `1`, `'yes'`, a missing key, a corrupt row — leaves approvals on.
 * A standing permission is not something to infer from a value nobody wrote.
 */
export function normalizeUserPreferences(value: unknown): UserPreferences {
  const input = (value && typeof value === 'object' ? value : {}) as Partial<UserPreferences>;
  return { chatBypassPermissions: input.chatBypassPermissions === true };
}

export interface ApprovalModeInput {
  /**
   * Whether this launch *begins* a conversation, as opposed to continuing one.
   *
   * Decided by the route the launch arrived on and never by the record: a
   * launch of a conversation that has never run, a branch, a start-over and the
   * in-conversation `/clear` all begin one; only `resume: true` continues one.
   * Reading it off the record instead — "has this ever been granted anything?" —
   * is what made *Start a new chat* inherit the bypass of the conversation it
   * had just abandoned.
   */
  beginning: boolean;
  /**
   * What this conversation was last recorded as running in. `undefined` means
   * nothing was ever recorded, which is not the same fact as "recorded as
   * asking" — see SessionRecord.chatBypassPermissions.
   */
  granted?: boolean;
  /** The owner's standing preference, as stored on the server. */
  preference?: boolean;
  /** A narrowing the browser asked for on this occasion. Only `false` counts. */
  explicit?: boolean;
}

/**
 * The one rule, in one place, for whether a conversation runs without asking.
 *
 * A bypass is granted to a conversation once, at the moment that conversation
 * begins, and it is granted from the owner's preference. Continuing a
 * conversation replays that conversation's own grant and re-reads nothing — in
 * either direction, so a preference switched on afterwards cannot widen a
 * conversation that already chose to ask, and one switched off afterwards
 * cannot turn approvals back on halfway through a conversation the user
 * deliberately started without them.
 *
 * Every unknown lands on `false`. A missing preference, an unreadable record, a
 * continuation with nothing recorded: all of them ask. That direction is not
 * negotiable — this decides whether shell commands and file writes run
 * unattended — and it is why nothing here reads a value as anything but exactly
 * `true`.
 *
 * Shared by the server that enforces the rule and the browser that labels it,
 * so the two cannot drift into describing different behaviour.
 */
export function resolveApprovalMode(input: ApprovalModeInput): boolean {
  // A narrowing the user is standing in front of always wins, whatever else
  // says. Widening is never taken from the browser at all — see startChat.
  if (input.explicit === false) return false;
  if (input.beginning) return input.preference === true;
  return input.granted === true;
}
