/**
 * What "the conversations I have" is made of, on the wire.
 *
 * Shared rather than declared on each side because the two halves answer one
 * question between them: the server decides what a conversation *is* and in what
 * order projects come, and the browser decides what a typed query narrows it to.
 * Two copies of that shape is two lists that agree until one of them is edited.
 *
 * The narrowing lives here too, for the same reason. "Matches on what was asked,
 * the conversation's name, and the folder it lives in" is a rule, not a
 * rendering detail, and a test can assert it without standing up a React tree.
 */

/** One conversation, as a list of them describes it. */
export interface ConversationSummary {
  id: string;
  /** The label the user chose, or the one the session was created with. */
  name: string;
  /**
   * How the conversation opened — the first thing that was asked.
   *
   * The row's title, and the whole reason a list of past conversations is worth
   * showing: "che file ho caricato?" identifies one instantly where "Session
   * 25/07/2026, 21:35" identifies nothing. Null for a conversation whose opening
   * message is no longer in the retained head of its log.
   */
  firstMessage: string | null;
  /** The runtime it was last running, e.g. `claude`. */
  runtime: string | null;
  /** That runtime's own label, e.g. `Claude Sonnet 4.6`. */
  runtimeLabel: string | null;
  lastActivity: string;
  workingDir: string;
  /**
   * The real project boundary, when this conversation belongs to one.
   *
   * Two project containers may both call their checkout `/workspace`; the raw
   * path is therefore never enough to identify, group, or authorise them.
   */
  projectId?: string | null;
  projectName?: string | null;
  /** Namespace of workingDir. Absent is the legacy host namespace. */
  workingDirKind?: 'host' | 'container';
  /** How many events its log holds; zero means nothing was ever said. */
  events: number;
  /**
   * Whether the agent can be handed its own context back.
   *
   * False means opening it brings the transcript back with an agent that is
   * meeting it for the first time. Said in the row rather than discovered
   * afterwards, because those are very different things to walk into.
   */
  canResume: boolean;
  /** A process is running it right now, so opening it is a join, not a resume. */
  running: boolean;
  /**
   * The approval mode it will come back in.
   *
   * A bypass is a standing permission, and one that returns without saying so is
   * as bad as one that is silently dropped.
   */
  bypassPermissions: boolean;
}

/** The conversations belonging to one project folder, most recent first. */
export interface ConversationProject {
  /** Stable grouping identity; unlike dir, this includes project and namespace. */
  key?: string;
  /** The project boundary, or null for legacy folder-based conversations. */
  projectId?: string | null;
  /** Namespace of dir; absent is the legacy host namespace. */
  workingDirKind?: 'host' | 'container';
  /** The absolute working directory within the namespace named above. */
  dir: string;
  /** Its leaf, which is what the group is called on screen. */
  name: string;
  /** The most recent activity in the group, which is what orders the groups. */
  lastActivity: string;
  conversations: ConversationSummary[];
}

export interface ConversationList {
  projects: ConversationProject[];
  /** How many conversations the groups hold between them. */
  total: number;
  /**
   * True when the user has more conversations than this answer describes.
   *
   * Stated rather than left implicit: a list that silently stops at a ceiling
   * reads as "this is everything", which is the one thing it must not do when
   * the question being asked is "where did that conversation go".
   */
  truncated: boolean;
}

/** Trailing-slash tolerant leaf of a path, in either separator style. */
export function projectName(dir: string): string {
  const trimmed = String(dir || '').replace(/[/\\]+$/, '');
  if (!trimmed) return dir || '/';
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return cut >= 0 ? trimmed.slice(cut + 1) || trimmed : trimmed;
}

/**
 * What to call a conversation in a list of them.
 *
 * The opening message first, because that is what somebody is scanning for. The
 * name is the fallback, not the label: for a conversation nobody renamed it is
 * "Session 25/07/2026, 21:35", which is exactly the row this list exists to stop
 * showing.
 */
export function conversationLabel(conversation: ConversationSummary): string {
  const asked = (conversation.firstMessage || '').trim();
  return asked || conversation.name || 'Conversation';
}

/**
 * Whether a typed query keeps this conversation.
 *
 * Three fields, and each is something a person actually remembers about a
 * conversation they are trying to find: what they asked, what they called it,
 * and where it was. Case-insensitive substring, deliberately — this finds a
 * conversation, not a line inside one, so there is nothing here worth a
 * ranking function.
 */
export function matchesConversation(conversation: ConversationSummary, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    conversation.firstMessage || '',
    conversation.name || '',
    conversation.workingDir || '',
    conversation.projectName || '',
    conversation.runtimeLabel || '',
  ]
    .join('\n')
    .toLowerCase();
  return haystack.includes(needle);
}

/**
 * The list a query leaves.
 *
 * A group with no match drops out entirely rather than surviving as an empty
 * heading, which is what keeps a search across a dozen projects reading as a
 * short list instead of a page of folder names.
 */
export function filterConversations(
  projects: ConversationProject[],
  query: string,
): ConversationProject[] {
  if (!query.trim()) return projects;
  const kept: ConversationProject[] = [];
  for (const project of projects) {
    const conversations = project.conversations.filter((entry) =>
      matchesConversation(entry, query),
    );
    if (conversations.length > 0) kept.push({ ...project, conversations });
  }
  return kept;
}

/** How many conversations a list of groups holds. */
export function countConversations(projects: ConversationProject[]): number {
  return projects.reduce((total, project) => total + project.conversations.length, 0);
}

/**
 * The same list with one conversation gone.
 *
 * What a delete leaves, worked out here rather than by re-reading the whole list
 * from the server: the answer is known exactly, and a refetch would make the row
 * the user just deleted flicker back for as long as the round trip takes.
 *
 * A project whose last conversation goes leaves with it, because a group is made
 * of the conversations in it — an empty folder heading is precisely what this
 * list is not.
 */
export function withoutConversation(list: ConversationList, id: string): ConversationList {
  const projects: ConversationProject[] = [];
  let removed = 0;
  for (const project of list.projects) {
    const conversations = project.conversations.filter((entry) => entry.id !== id);
    removed += project.conversations.length - conversations.length;
    if (conversations.length > 0) projects.push({ ...project, conversations });
  }
  return { ...list, projects, total: Math.max(0, list.total - removed) };
}
