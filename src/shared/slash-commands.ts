/**
 * What the built-in slash commands do.
 *
 * Claude Code's `init` message lists the commands it accepts as bare names and
 * nothing else, so the picker had a column of `/clear`, `/compact`, `/model`
 * with no way to tell them apart. The ACP runtimes do send descriptions, and
 * those always win — this only fills the gap for a runtime that does not.
 *
 * Deliberately only the built-ins. A project command from `.claude/commands`
 * or a skill carries its own description in its own frontmatter, and inventing
 * one here from its name would be a guess presented as documentation.
 */

/** Command name (no slash) → one line saying what it does. */
const BUILT_IN: Record<string, string> = {
  clear: 'Start a new conversation, forgetting everything above',
  compact: 'Summarise the conversation so far to free up context',
  context: 'Show what is currently taking up the context window',
  cost: 'Show what this session has cost so far',
  doctor: 'Check this installation for problems',
  exit: 'End the session',
  export: 'Write the conversation out to a file',
  help: 'List the commands this runtime accepts',
  init: 'Write a CLAUDE.md describing this project',
  login: 'Sign in to a different account',
  logout: 'Sign out',
  memory: 'Edit the memory files this project loads',
  model: 'Switch which model answers',
  permissions: 'Review and change what tools may run',
  pr_comments: 'Read the review comments on the current pull request',
  release_notes: "Show what changed in this runtime's recent versions",
  resume: 'Reopen an earlier conversation',
  review: 'Review a pull request',
  status: 'Show the account, model and connection this session is using',
  terminal_setup: 'Install the key binding for a multi-line prompt',
  vim: 'Toggle vim key bindings in the prompt',
};

/**
 * Fill in a description for a command that arrived without one.
 *
 * Returns undefined rather than a placeholder: the picker leaves the column
 * empty for an unknown command, which reads as "no description" — where
 * something like "No description available" reads as a description, and a
 * column of them is worse than a column of nothing.
 */
export function describeSlashCommand(name: string): string | undefined {
  return BUILT_IN[String(name || '').trim().toLowerCase().replace(/^\//, '')];
}

/**
 * The built-ins, as a menu the picker can show before a runtime has said
 * anything about itself.
 *
 * Claude does not report `slash_commands` until it has processed a first
 * turn (see claude.ts), which used to mean a brand-new session showed no
 * command menu at all until one message had already been sent. This table is
 * this app's own knowledge of what a fresh Claude session accepts, not
 * something Claude told it — a project or plugin command still only appears
 * once the real `init` arrives and replaces this list outright.
 */
export function defaultSlashCommands(): { name: string; description: string }[] {
  return Object.entries(BUILT_IN).map(([name, description]) => ({ name, description }));
}

/**
 * One menu out of several lists, first mention of a name winning.
 *
 * Used only to assemble the stand-in menu a session shows before its runtime
 * has spoken: this app's knowledge of the built-ins, plus the skills and
 * project commands found installed. Both halves are fallback, so joining them
 * is not the merging the runtime's own list must never be subjected to — when
 * that arrives it replaces all of this outright.
 */
export function mergeSlashCommands(
  ...lists: ({ name: string; description?: string }[] | undefined)[]
): { name: string; description?: string }[] {
  const seen = new Set<string>();
  const merged: { name: string; description?: string }[] = [];
  for (const list of lists) {
    for (const command of list ?? []) {
      const name = String(command?.name ?? '').trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      merged.push(command);
    }
  }
  return merged;
}

/**
 * Commands that empty the conversation.
 *
 * The runtime clears its own context when it sees one of these; the transcript
 * has to follow, or the window goes on showing an hour of conversation the
 * agent can no longer see. Matched on the first word only, so `/clear` and
 * `/clear --force` are both caught and `/clearance-report` is not.
 */
const CLEARING = new Set(['clear', 'new', 'reset']);

export function isClearingCommand(text: string): boolean {
  const first = String(text || '').trim().split(/\s+/, 1)[0] ?? '';
  if (!first.startsWith('/')) return false;
  return CLEARING.has(first.slice(1).toLowerCase());
}

/**
 * Whether a message is a command rather than something to say to the model.
 *
 * The first word only, and a leading slash: everything a runtime treats as a
 * command arrives as ordinary turn text, so this is the only thing that tells
 * `/review` from a sentence beginning with a slash.
 */
export function isSlashCommand(text: string): boolean {
  const first = String(text || '').trim().split(/\s+/, 1)[0] ?? '';
  return first.length > 1 && first.startsWith('/');
}

/** Commands that summarise the conversation to reclaim context. */
export function isCompactingCommand(text: string): boolean {
  const first = String(text || '').trim().split(/\s+/, 1)[0] ?? '';
  return first.toLowerCase() === '/compact';
}
