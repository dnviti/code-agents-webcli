/**
 * What `gh` says about an issue or a pull request, reduced to what this app draws.
 *
 * The GitHub panel used to pass `gh`'s JSON straight to the browser, which was
 * fine while it asked for six fields. It now asks for the things a person
 * actually opens the panel to find out — who is on it, which pull request will
 * close it, what it is a part of — and those fields come back as GraphQL
 * connections wrapped in ids and repository objects, several kilobytes of them
 * per row. So they are normalised here instead: one small shape per item, with
 * every reference reduced to the same `GitHubRef`, and every empty field left
 * out entirely.
 *
 * Pure and shared, because these are also the types the browser holds, and
 * because a parser for a subprocess's JSON is exactly the kind of thing that
 * should be testable without a subprocess. Everything is defensive: `gh` is a
 * separate program on its own release cycle, its JSON is a contract this app
 * does not own, and a field that changes shape must cost a missing badge and
 * not a blank panel.
 */

/** Someone GitHub named: an author, an assignee, a requested reviewer. */
export interface GitHubActor {
  login: string;
  /** The display name, when the account has one. */
  name?: string;
}

export interface GitHubLabel {
  name: string;
  /** Six hex digits, no leading `#`, as GitHub reports it. */
  color?: string;
}

/**
 * How one item points at another, from the point of view of the item holding
 * the reference. `closes` and `closed-by` are the two ends of the same link:
 * a pull request *closes* an issue, and that issue is *closed by* it.
 */
export type GitHubRelation =
  | 'closes'
  | 'closed-by'
  | 'mentions'
  | 'parent'
  | 'child'
  | 'blocked-by'
  | 'blocks';

/** One issue or pull request, named from somewhere else. */
export interface GitHubRef {
  kind: 'issue' | 'pr';
  number: number;
  title?: string;
  url?: string;
  /** OPEN, CLOSED or MERGED. */
  state?: string;
  isDraft?: boolean;
  /**
   * `owner/name`, when it is known.
   *
   * Carried on every reference rather than only on foreign ones, because the
   * reader has to open these: a reference to `other/repo#5` opened against the
   * session's own repository is not a broken link, it is a different issue
   * numbered 5, which is worse.
   */
  repo?: string;
  relation?: GitHubRelation;
}

/** What CI says about a pull request, as one line rather than every job. */
export interface GitHubChecks {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  state: 'passing' | 'failing' | 'pending';
}

/** A submitted review: who, and what they decided. */
export interface GitHubReview {
  author?: GitHubActor;
  /** APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED. */
  state: string;
  submittedAt?: string;
}

export interface GitHubComment {
  author?: GitHubActor;
  body?: string;
  createdAt?: string;
}

/** The half of an issue and a pull request that is the same in both. */
export interface GitHubBase {
  number: number;
  title: string;
  url: string;
  state?: string;
  author?: GitHubActor;
  assignees?: GitHubActor[];
  labels?: GitHubLabel[];
  /** The milestone's title; the rest of the milestone is not drawn anywhere. */
  milestone?: string;
  createdAt?: string;
  updatedAt?: string;
  /**
   * Everything that points at this one, or that it points at, other than the
   * parent/child hierarchy — which has its own shape because it is drawn as
   * progress rather than as a list.
   */
  references?: GitHubRef[];
}

export interface GitHubIssue extends GitHubBase {
  /** COMPLETED or NOT_PLANNED on a closed issue; absent while it is open. */
  stateReason?: string;
  /** The repository's own issue type (Bug, Task, …) where one is configured. */
  issueType?: string;
  /** The issue this one is a sub-issue of. */
  parent?: GitHubRef;
  /** Sub-issues themselves. Only the detail view asks for them. */
  children?: GitHubRef[];
  /** How many sub-issues there are, and how many are closed. */
  childrenTotal?: number;
  childrenDone?: number;
  blockedBy?: GitHubRef[];
  blocking?: GitHubRef[];
}

export interface GitHubPull extends GitHubBase {
  isDraft?: boolean;
  headRefName?: string;
  baseRefName?: string;
  /** APPROVED, CHANGES_REQUESTED or REVIEW_REQUIRED; empty means nobody has been asked. */
  reviewDecision?: string;
  /** Who has been asked to review and has not yet. */
  reviewers?: GitHubActor[];
  /** Who has reviewed, and what they said. */
  reviews?: GitHubReview[];
  checks?: GitHubChecks;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
}

/** One issue or pull request read in full, body and discussion included. */
export type GitHubItem = GitHubIssue & GitHubPull & {
  kind: 'issue' | 'pr';
  body?: string;
  comments?: GitHubComment[];
};

export interface GitHubOverview {
  available: boolean;
  reason?: string;
  repo?: { nameWithOwner?: string; url?: string } | null;
  prs?: GitHubPull[];
  issues?: GitHubIssue[];
  /**
   * Why a list is missing, when it is missing because `gh` refused rather than
   * because there is nothing open.
   *
   * They are different facts and they look identical on screen: an empty list
   * under "Issues 0" reads as a quiet repository, which is exactly what someone
   * whose `gh` is too old to answer would conclude.
   */
  prsError?: string;
  issuesError?: string;
}

// --------------------------------------------------------------------- json

type Json = Record<string, unknown>;

function obj(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * The members of a list, however `gh` chose to wrap it.
 *
 * Some fields come back as a plain array (`assignees`, `labels`) and some as the
 * GraphQL connection they are underneath (`subIssues`, `blockedBy`, which are
 * `{nodes, totalCount}`). A caller that has to remember which is which for each
 * field will eventually get one wrong, and the failure is a silently empty
 * section rather than an error.
 */
function nodes(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const connection = obj(value);
  if (connection && Array.isArray(connection.nodes)) return connection.nodes;
  return [];
}

/** A connection's own count, which can exceed the page of nodes it returned. */
function totalOf(value: unknown): number | undefined {
  const connection = obj(value);
  return connection ? num(connection.totalCount) : undefined;
}

/** Drop every key that carries nothing, so the wire shape stays small. */
function compact<T extends object>(record: T): T {
  const out: Json = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out as T;
}

// -------------------------------------------------------------------- parts

export function actorOf(value: unknown): GitHubActor | undefined {
  const source = obj(value);
  if (!source) return undefined;
  // A requested reviewer can be a team rather than a person, and a team has a
  // slug where a user has a login. Both are the handle you would type.
  const login = str(source.login) || str(source.slug) || str(source.name);
  if (!login) return undefined;
  const name = str(source.name);
  return compact({ login, name: name === login ? undefined : name });
}

export function actorsOf(value: unknown): GitHubActor[] {
  const seen = new Set<string>();
  const out: GitHubActor[] = [];
  for (const entry of nodes(value)) {
    // `reviewRequests` nests the account one level down; everything else is the
    // account itself.
    const source = obj(entry);
    const actor = actorOf(source?.requestedReviewer ?? entry);
    if (!actor || seen.has(actor.login)) continue;
    seen.add(actor.login);
    out.push(actor);
  }
  return out;
}

export function labelsOf(value: unknown): GitHubLabel[] {
  const out: GitHubLabel[] = [];
  for (const entry of nodes(value)) {
    const source = obj(entry);
    const name = str(source?.name);
    if (name) out.push(compact({ name, color: str(source?.color) }));
  }
  return out;
}

/** `owner/name`, from either shape `gh` reports a repository in. */
export function repoOf(value: unknown): string | undefined {
  const source = obj(value);
  if (!source) return undefined;
  const full = str(source.nameWithOwner);
  if (full) return full;
  const name = str(source.name);
  const owner = str(obj(source.owner)?.login);
  return name && owner ? `${owner}/${name}` : undefined;
}

/**
 * `owner/name` out of an issue or pull request URL.
 *
 * The only source that is always there. `gh view` is not asked for a
 * `repository` field — it is the repository the command ran against, so asking
 * would be a field per item to be told what is already known — but "is this
 * reference one of ours" still has to be answerable, and the URL answers it.
 */
export function repoFromUrl(url: string | undefined): string | undefined {
  const match = /github\.[^/]+\/([^/]+)\/([^/]+)\/(?:issues|pull)\//.exec(url || '');
  return match ? `${match[1]}/${match[2]}` : undefined;
}

/**
 * Which of the two a URL names.
 *
 * The fields that link issues to pull requests do not all say what they linked
 * to — `closedByPullRequestsReferences` returns numbers and URLs and no type at
 * all — and `/pull/` against `/issues/` is the one thing every one of them
 * carries.
 */
export function kindFromUrl(url: string | undefined): 'issue' | 'pr' | undefined {
  if (!url) return undefined;
  if (url.includes('/pull/')) return 'pr';
  if (url.includes('/issues/')) return 'issue';
  return undefined;
}

export function refOf(
  value: unknown,
  relation?: GitHubRelation,
  fallbackKind: 'issue' | 'pr' = 'issue',
): GitHubRef | undefined {
  const source = obj(value);
  if (!source) return undefined;
  const number = num(source.number);
  if (!number || number <= 0) return undefined;

  const url = str(source.url);
  const typename = str(source.__typename);
  const kind = typename === 'PullRequest'
    ? 'pr'
    : typename === 'Issue'
      ? 'issue'
      : kindFromUrl(url) || fallbackKind;

  return compact({
    kind,
    number,
    title: str(source.title),
    url,
    state: str(source.state)?.toUpperCase(),
    isDraft: typeof source.isDraft === 'boolean' ? source.isDraft : undefined,
    repo: repoOf(source.repository),
    relation,
  }) as GitHubRef;
}

export function refsOf(
  value: unknown,
  relation?: GitHubRelation,
  fallbackKind: 'issue' | 'pr' = 'issue',
): GitHubRef[] {
  const out: GitHubRef[] = [];
  for (const entry of nodes(value)) {
    const ref = refOf(entry, relation, fallbackKind);
    if (ref) out.push(ref);
  }
  return out;
}

/**
 * One list of references out of several, each of which knows a different half.
 *
 * `closedByPullRequestsReferences` knows the relationship and not the title;
 * the timeline knows the title and the state and calls everything a mention.
 * Merging them by identity — and letting a real relationship win over "mentions"
 * — is what turns two thin lists into one row a person can read.
 */
export function mergeReferences(...groups: Array<GitHubRef[] | undefined>): GitHubRef[] {
  const byKey = new Map<string, GitHubRef>();
  for (const group of groups) {
    for (const ref of group || []) {
      const key = `${ref.kind}:${ref.repo || ''}:${ref.number}`;
      const seen = byKey.get(key);
      if (!seen) {
        byKey.set(key, { ...ref });
        continue;
      }
      if (!seen.title && ref.title) seen.title = ref.title;
      if (!seen.state && ref.state) seen.state = ref.state;
      if (!seen.url && ref.url) seen.url = ref.url;
      if (!seen.repo && ref.repo) seen.repo = ref.repo;
      if (seen.isDraft === undefined && ref.isDraft !== undefined) seen.isDraft = ref.isDraft;
      if ((!seen.relation || seen.relation === 'mentions') && ref.relation) seen.relation = ref.relation;
    }
  }
  return [...byKey.values()].sort((a, b) => a.number - b.number);
}

/**
 * The cross-references on an item's timeline, from `gh api graphql`.
 *
 * The linked-pull-request fields only cover the ones written with a closing
 * keyword. A pull request that says "part of #163" is not linked by GitHub in
 * that sense at all, and it is still the pull request the person is looking
 * for, so the timeline is read as well and the two are merged.
 */
export function crossReferencesOf(value: unknown): GitHubRef[] {
  const data = obj(obj(value)?.data);
  const subject = obj(obj(data?.repository)?.issueOrPullRequest);
  const out: GitHubRef[] = [];
  for (const entry of nodes(obj(subject?.timelineItems))) {
    const event = obj(entry);
    if (!event) continue;
    const ref = refOf(event.source, 'mentions', 'pr');
    if (!ref) continue;
    // `willCloseTarget` is GitHub's own answer to "does merging this close the
    // thing we are looking at", which is the one relationship worth promoting
    // out of a mention.
    if (event.willCloseTarget === true && ref.kind === 'pr') ref.relation = 'closed-by';
    out.push(ref);
  }
  return out;
}

/** CI as one line: how many jobs, and whether the answer is yes, no or not yet. */
export function checksOf(value: unknown): GitHubChecks | undefined {
  let passed = 0;
  let failed = 0;
  let pending = 0;
  let total = 0;

  for (const entry of nodes(value)) {
    const run = obj(entry);
    if (!run) continue;
    total += 1;
    // A check run reports `status` then `conclusion`; a commit status only ever
    // reports `state`. Both end up in the same three buckets.
    const status = str(run.status)?.toUpperCase();
    const conclusion = (str(run.conclusion) || str(run.state))?.toUpperCase();
    if (status && status !== 'COMPLETED' && !conclusion) {
      pending += 1;
    } else if (conclusion === 'SUCCESS' || conclusion === 'NEUTRAL' || conclusion === 'SKIPPED') {
      passed += 1;
    } else if (conclusion === 'PENDING' || conclusion === 'EXPECTED' || !conclusion) {
      pending += 1;
    } else {
      // FAILURE, TIMED_OUT, CANCELLED, ACTION_REQUIRED, ERROR, STARTUP_FAILURE.
      failed += 1;
    }
  }

  if (total === 0) return undefined;
  return {
    total,
    passed,
    failed,
    pending,
    state: failed > 0 ? 'failing' : pending > 0 ? 'pending' : 'passing',
  };
}

function reviewsOf(value: unknown): GitHubReview[] {
  const out: GitHubReview[] = [];
  for (const entry of nodes(value)) {
    const source = obj(entry);
    const state = str(source?.state)?.toUpperCase();
    if (!state) continue;
    out.push(compact({ author: actorOf(source?.author), state, submittedAt: str(source?.submittedAt) }));
  }
  return out;
}

function commentsOf(value: unknown): GitHubComment[] {
  const out: GitHubComment[] = [];
  for (const entry of nodes(value)) {
    const source = obj(entry);
    if (!source) continue;
    out.push(compact({
      author: actorOf(source.author),
      body: str(source.body),
      createdAt: str(source.createdAt),
    }));
  }
  return out;
}

function baseOf(source: Json): GitHubBase | null {
  const number = num(source.number);
  if (!number || number <= 0) return null;
  return compact({
    number,
    title: str(source.title) || '',
    url: str(source.url) || '',
    state: str(source.state)?.toUpperCase(),
    author: actorOf(source.author),
    assignees: actorsOf(source.assignees),
    labels: labelsOf(source.labels),
    milestone: str(obj(source.milestone)?.title),
    createdAt: str(source.createdAt),
    updatedAt: str(source.updatedAt),
  }) as GitHubBase;
}

// ------------------------------------------------------------------- items

export function normalizeIssue(value: unknown): GitHubIssue | null {
  const source = obj(value);
  if (!source) return null;
  const base = baseOf(source);
  if (!base) return null;

  const children = refsOf(source.subIssues, 'child', 'issue');
  const summary = obj(source.subIssuesSummary);
  const childrenTotal = num(summary?.total) ?? totalOf(source.subIssues) ?? children.length;

  return compact({
    ...base,
    stateReason: str(source.stateReason)?.toUpperCase(),
    issueType: str(obj(source.issueType)?.name) || str(source.issueType),
    parent: refOf(source.parent, 'parent', 'issue'),
    children,
    childrenTotal: childrenTotal || undefined,
    // Only meaningful beside a total: "0 done" on an issue with no sub-issues
    // is a fact about nothing, and it would draw an empty progress bar.
    childrenDone: childrenTotal
      // Without the summary, the closed children are the ones counted done.
      ? num(summary?.completed) ?? children.filter((one) => one.state === 'CLOSED').length
      : undefined,
    blockedBy: refsOf(source.blockedBy, 'blocked-by', 'issue'),
    blocking: refsOf(source.blocking, 'blocks', 'issue'),
    // The pull requests that would close this issue, which is the question the
    // panel is most often open to answer.
    references: refsOf(source.closedByPullRequestsReferences, 'closed-by', 'pr'),
  }) as GitHubIssue;
}

export function normalizePull(value: unknown): GitHubPull | null {
  const source = obj(value);
  if (!source) return null;
  const base = baseOf(source);
  if (!base) return null;

  return compact({
    ...base,
    isDraft: typeof source.isDraft === 'boolean' ? source.isDraft : undefined,
    headRefName: str(source.headRefName),
    baseRefName: str(source.baseRefName),
    // `gh` reports "no review has been asked for" as an empty string.
    reviewDecision: str(source.reviewDecision)?.toUpperCase(),
    reviewers: actorsOf(source.reviewRequests),
    reviews: reviewsOf(source.latestReviews),
    checks: checksOf(source.statusCheckRollup),
    additions: num(source.additions),
    deletions: num(source.deletions),
    changedFiles: num(source.changedFiles),
    references: refsOf(source.closingIssuesReferences, 'closes', 'issue'),
  }) as GitHubPull;
}

/**
 * One item read in full: the summary, the body, the discussion, and every
 * reference both fields and timeline know about, minus the item itself.
 */
export function normalizeItem(
  kind: 'issue' | 'pr',
  value: unknown,
  crossReferences?: GitHubRef[],
): GitHubItem | null {
  const source = obj(value);
  if (!source) return null;
  const item = kind === 'pr' ? normalizePull(source) : normalizeIssue(source);
  if (!item) return null;

  const repo = repoOf(source.repository) || repoFromUrl(item.url);
  // Whatever a structured field already accounts for. A parent that mentions
  // its child — which is how most people write a parent — appears on the child's
  // timeline too, and "Part of #100" followed by "Mentioned by #100" is the one
  // thing this section exists to stop. Dropped rather than merged: parent,
  // sub-issues and blockers all arrive with their own title and state.
  const hierarchy = kind === 'issue' ? (item as GitHubIssue) : null;
  const claimed = new Set(
    [hierarchy?.parent, ...(hierarchy?.children || []), ...(hierarchy?.blockedBy || []), ...(hierarchy?.blocking || [])]
      .filter((one): one is GitHubRef => Boolean(one))
      // Keyed without the repository: `parent` and `subIssues` carry one and
      // `blockedBy` does not, so a repo-keyed comparison would miss half of them.
      .map((one) => `${one.kind}:${one.number}`),
  );

  const references = mergeReferences(item.references, crossReferences).filter((ref) => {
    // Only ever within this repository: `other/project#163` is a different
    // thing that happens to have been given the same number, and neither the
    // self-check nor the claimed-elsewhere check may swallow it.
    const ours = !ref.repo || !repo || ref.repo === repo;
    if (!ours) return true;
    // An item's own timeline names the item itself when a comment on it was
    // edited; a row saying "#163 mentions #163" is noise at best.
    if (ref.number === item.number && ref.kind === kind) return false;
    return !claimed.has(`${ref.kind}:${ref.number}`);
  });

  return compact({ ...item, kind, body: str(source.body), comments: commentsOf(source.comments), references }) as GitHubItem;
}

// ------------------------------------------------------------------ labels

/** What a review decision is called in a sentence. */
export function reviewDecisionLabel(decision: string | undefined): string | undefined {
  switch ((decision || '').toUpperCase()) {
    case 'APPROVED': return 'Approved';
    case 'CHANGES_REQUESTED': return 'Changes requested';
    case 'REVIEW_REQUIRED': return 'Review required';
    default: return undefined;
  }
}

/** What a relationship is called above a list of references. */
export function relationLabel(relation: GitHubRelation | undefined): string {
  switch (relation) {
    case 'closes': return 'Closes';
    case 'closed-by': return 'Closed by';
    case 'parent': return 'Part of';
    case 'child': return 'Sub-issues';
    case 'blocked-by': return 'Blocked by';
    case 'blocks': return 'Blocks';
    default: return 'Mentioned by';
  }
}
