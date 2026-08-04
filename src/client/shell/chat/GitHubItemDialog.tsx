import * as React from 'react';
import { Badge } from '../../ui/relay/Badge.js';
import { Dialog } from '../../ui/relay/Dialog.js';
import { Icon } from '../../ui/relay/Icon.js';
import { IconButton } from '../../ui/relay/IconButton.js';
import { TOUCH_TARGET, usePhone } from '../../ui/touch.js';
import {
  fetchGitHubItem,
  relationLabel,
  repoFromUrl,
  reviewDecisionLabel,
  type GitHubItem,
  type GitHubRef,
  type GitHubRelation,
} from '../../chat/workspace-api.js';
import { Markdown } from './Markdown.js';

/**
 * An issue or pull request, read in the app.
 *
 * The panel used to hand these to `target="_blank"`, which on a self-hosted
 * install reached over a LAN means leaving the app — often on a phone, where
 * coming back means finding the tab again. It is also the wrong shape for what
 * the user is doing: they are reading an issue *against* the code the agent is
 * working on, and the two want to be on screen together.
 *
 * Not an iframe of github.com. GitHub refuses to be framed, and the page it
 * serves is a whole application to load beside this one. `gh` on the server is
 * already this panel's source and is already signed in, so the body and the
 * discussion come back as text this app renders with the same markdown
 * renderer the transcript uses.
 *
 * What surrounds the body is the half of an issue that is not prose: who it is
 * assigned to, which pull request closes it, what it is a part of, what it is
 * waiting on. Those are the questions people open an issue to answer, and each
 * one is a link that opens here rather than a number to go and look up.
 */

export interface GitHubItemDialogProps {
  sessionId: string;
  kind: 'issue' | 'pr';
  number: number;
  /** `owner/name` when this was reached from a reference into another repository. */
  repo?: string;
  /** Follow a reference. Without it, references are plain links to GitHub. */
  onOpen?(ref: GitHubRef): void;
  /** Go back to whatever was being read before this one. */
  onBack?(): void;
  onClose(): void;
}

export function GitHubItemDialog({
  sessionId,
  kind,
  number,
  repo,
  onOpen,
  onBack,
  onClose,
}: GitHubItemDialogProps): React.JSX.Element {
  const [item, setItem] = React.useState<GitHubItem | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  // The anchor beside Back is an `a`, so it cannot be an IconButton; it takes
  // the same floor by hand rather than being the one 17px target in the row.
  const touchable = usePhone() ? TOUCH_TARGET : 26;

  React.useEffect(() => {
    let cancelled = false;
    setItem(null);
    setError(null);

    fetchGitHubItem(sessionId, kind, number, repo)
      .then((result) => {
        if (!cancelled) setItem(result.item);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : 'That could not be read');
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, kind, number, repo]);

  const label = kind === 'pr' ? 'Pull request' : 'Issue';
  const comments = item?.comments || [];

  return (
    <Dialog
      open
      movable
      width="min(880px, 94vw)"
      titleText={item?.title || label}
      title={
        // `flex`, not `inline-flex`: an inline-level box inside the title's own
        // `white-space: nowrap` is laid out at max-content and is then chopped
        // by the clip with no ellipsis to say so (#114). The icon and the number
        // never shrink — they are two glyphs wide and they are what identifies
        // the thing — so the sentence is the part that gives way.
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ display: 'inline-flex', flexShrink: 0 }}>
            <Icon name={kind === 'pr' ? 'git-pull-request' : 'circle-dot'} size={14} />
          </span>
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--muted-foreground)', flexShrink: 0 }}>
            #{number}
          </span>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {item?.title || label}
          </span>
        </span>
      }
      headerActions={
        <>
          {/* Following a reference replaces what is on screen, so there has to
              be a way back to the thing it was followed from. */}
          {/* IconButton rather than a bare button: it takes the touch floor on
              a phone by itself, and the control immediately to its right is the
              one that leaves the app. */}
          {onBack ? (
            <IconButton size="sm" label="Back" onClick={onBack}>
              <Icon name="arrow-left" size={13} />
            </IconButton>
          ) : null}
          {item ? (
            // Still offered, because some things — reviewing, commenting, merging
            // — are GitHub's job and this is a reader.
            <a
              href={item.url}
              target="_blank"
              rel="noreferrer noopener"
              title="Open on GitHub"
              aria-label="Open on GitHub"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: touchable,
                height: touchable,
                color: 'var(--muted-foreground)',
              }}
            >
              <Icon name="external-link" size={13} />
            </a>
          ) : null}
        </>
      }
      onClose={onClose}
    >
      {error ? (
        <p role="alert" style={{ margin: 0, color: 'var(--destructive)', fontSize: 'var(--text-sm)' }}>
          {error}
        </p>
      ) : null}

      {!item && !error ? (
        <p style={{ margin: 0, color: 'var(--muted-foreground)', fontSize: 'var(--text-sm)' }}>
          Reading {label.toLowerCase()} #{number}…
        </p>
      ) : null}

      {item ? (
        <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
          <Meta item={item} kind={kind} />
          <People item={item} />
          <Links item={item} onOpen={onOpen} />

          {/* An issue with no body is normal — a title can be the whole thing —
              and saying so beats an empty pane that reads as a failed load. */}
          <Section author={item.author?.login} when={item.createdAt}>
            {item.body?.trim()
              ? <Markdown text={item.body} />
              : <Quiet>No description.</Quiet>}
          </Section>

          {comments.map((comment, index) => (
            <Section
              key={`${comment.author?.login || 'anon'}-${comment.createdAt || index}`}
              author={comment.author?.login}
              when={comment.createdAt}
            >
              <Markdown text={comment.body || ''} />
            </Section>
          ))}

          {comments.length === 0 ? <Quiet>No comments yet.</Quiet> : null}
        </div>
      ) : null}
    </Dialog>
  );
}

function Quiet({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p style={{ margin: 0, color: 'var(--muted-foreground)', fontSize: 'var(--text-sm)' }}>
      {children}
    </p>
  );
}

/** The facts a reader checks first: who, what state, and how big. */
function Meta({ item, kind }: { item: GitHubItem; kind: 'issue' | 'pr' }): React.JSX.Element {
  const state = String(item.state || '').toUpperCase();
  const review = reviewDecisionLabel(item.reviewDecision);
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)' }}>
      <StateBadge state={state} isDraft={item.isDraft} stateReason={item.stateReason} />
      {item.author?.login ? <Quiet>{item.author.login}</Quiet> : null}
      {kind === 'pr' && item.headRefName ? (
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-2xs)',
            color: 'var(--muted-foreground)',
          }}
        >
          {item.headRefName} → {item.baseRefName}
        </span>
      ) : null}
      {kind === 'pr' && typeof item.changedFiles === 'number' ? (
        <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--muted-foreground)' }}>
          {item.changedFiles} files{' '}
          <span style={{ color: 'var(--ansi-green)' }}>+{item.additions ?? 0}</span>{' '}
          <span style={{ color: 'var(--destructive)' }}>−{item.deletions ?? 0}</span>
        </span>
      ) : null}
      {review ? (
        <Badge variant={item.reviewDecision === 'APPROVED' ? 'success' : 'warning'}>{review}</Badge>
      ) : null}
      {item.checks ? (
        <Badge
          variant={item.checks.state === 'failing' ? 'destructive' : item.checks.state === 'pending' ? 'warning' : 'success'}
        >
          {`checks ${item.checks.passed}/${item.checks.total}`}
        </Badge>
      ) : null}
      {item.issueType ? <Badge variant="neutral">{item.issueType}</Badge> : null}
      {item.milestone ? <Badge variant="neutral">{item.milestone}</Badge> : null}
      {(item.labels || []).map((tag) => (
        <Badge key={tag.name} variant="outline">{tag.name}</Badge>
      ))}
    </div>
  );
}

/** Open, closed, merged — and, for a closed issue, whether it was ever going to be done. */
function StateBadge({
  state,
  isDraft,
  stateReason,
}: {
  state: string;
  isDraft?: boolean;
  stateReason?: string;
}): React.JSX.Element {
  if (isDraft) return <Badge variant="neutral">Draft</Badge>;
  if (state === 'MERGED') return <Badge variant="solid">Merged</Badge>;
  if (state === 'OPEN') return <Badge variant="success">Open</Badge>;
  return (
    <Badge variant="outline">
      {stateReason === 'NOT_PLANNED' ? 'Closed as not planned' : 'Closed'}
    </Badge>
  );
}

/**
 * Who is on it.
 *
 * Assignees first because "is anyone doing this" is the question, and a row of
 * reviewers under a pull request nobody is assigned to answers it too.
 */
function People({ item }: { item: GitHubItem }): React.JSX.Element | null {
  const assignees = item.assignees || [];
  const reviewers = item.reviewers || [];
  const reviews = item.reviews || [];
  if (!assignees.length && !reviewers.length && !reviews.length) return null;

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-3)' }}>
      {assignees.length ? (
        <Who icon="user" label="Assigned to" people={assignees.map((one) => one.login)} />
      ) : (
        <Who icon="user" label="Assigned to" people={[]} empty="nobody" />
      )}
      {reviewers.length ? (
        <Who icon="eye" label="Review from" people={reviewers.map((one) => one.login)} />
      ) : null}
      {reviews.length ? (
        <Who
          icon="check"
          label="Reviewed"
          people={reviews.map((one) => `${one.author?.login || 'someone'} ${verdict(one.state)}`)}
        />
      ) : null}
    </div>
  );
}

function verdict(state: string): string {
  switch (state.toUpperCase()) {
    case 'APPROVED': return 'approved';
    case 'CHANGES_REQUESTED': return 'asked for changes';
    case 'DISMISSED': return 'dismissed';
    default: return 'commented';
  }
}

function Who({
  icon,
  label,
  people,
  empty,
}: {
  icon: string;
  label: string;
  people: string[];
  empty?: string;
}): React.JSX.Element {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 'var(--text-2xs)',
        color: 'var(--muted-foreground)',
      }}
    >
      <Icon name={icon} size={11} />
      <span>{label}</span>
      <span style={{ color: people.length ? 'var(--foreground)' : 'var(--muted-foreground)' }}>
        {people.length ? people.join(', ') : empty}
      </span>
    </span>
  );
}

/** The order relationships are read in: what it belongs to, then what it needs. */
const RELATION_ORDER: GitHubRelation[] = ['parent', 'child', 'closed-by', 'closes', 'blocked-by', 'blocks', 'mentions'];

/**
 * Everything this issue or pull request is attached to.
 *
 * Grouped by what the relationship is rather than listed as one pile of
 * numbers: "closed by #165" and "mentioned by #164" are different facts, and a
 * reader deciding whether an issue is already handled needs to tell them apart.
 */
function Links({
  item,
  onOpen,
}: {
  item: GitHubItem;
  onOpen?: (ref: GitHubRef) => void;
}): React.JSX.Element | null {
  const groups = new Map<GitHubRelation, GitHubRef[]>();
  const add = (relation: GitHubRelation, refs: GitHubRef[]): void => {
    if (refs.length) groups.set(relation, [...(groups.get(relation) || []), ...refs]);
  };

  if (item.parent) add('parent', [item.parent]);
  add('child', item.children || []);
  add('blocked-by', item.blockedBy || []);
  add('blocks', item.blocking || []);
  for (const ref of item.references || []) {
    add(ref.relation || 'mentions', [ref]);
  }

  // A sub-issue count with no sub-issues listed still says something: the
  // summary is all the list view asks for, and "3 of 5 done" is the fact.
  const children = item.childrenTotal || 0;
  if (!groups.size && !children) return null;

  const home = repoFromUrl(item.url);
  const row = (ref: GitHubRef): React.JSX.Element => (
    <LinkRow
      key={`${ref.kind}-${ref.repo || ''}-${ref.number}`}
      refer={ref}
      foreign={Boolean(ref.repo && home && ref.repo !== home)}
      onOpen={onOpen}
    />
  );

  return (
    <div
      style={{
        display: 'grid',
        gap: 6,
        padding: '8px 10px',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        background: 'var(--card)',
      }}
    >
      {/* The bar carries the "Sub-issues" label for the children beneath it, so
          the group below is drawn without repeating it. */}
      {children > 0 ? (
        <>
          <Progress done={item.childrenDone || 0} total={children} />
          {(groups.get('child') || []).length ? (
            <span style={{ display: 'grid', gap: 2, paddingLeft: 84, minWidth: 0 }}>
              {(groups.get('child') || []).map(row)}
            </span>
          ) : null}
        </>
      ) : null}

      {RELATION_ORDER.filter((relation) => groups.has(relation))
        .filter((relation) => !(relation === 'child' && children > 0))
        .map((relation) => (
          <div key={relation} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 6 }}>
            <span
              style={{
                flex: '0 0 auto',
                minWidth: 78,
                fontSize: 'var(--text-2xs)',
                color: 'var(--muted-foreground)',
              }}
            >
              {relationLabel(relation)}
            </span>
            <span style={{ display: 'grid', gap: 2, flex: 1, minWidth: 0 }}>
              {(groups.get(relation) || []).map(row)}
            </span>
          </div>
        ))}
    </div>
  );
}


/** How much of a parent issue is done, as the bar GitHub draws for it. */
function Progress({ done, total }: { done: number; total: number }): React.JSX.Element {
  const share = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--muted-foreground)', minWidth: 78 }}>
        Sub-issues
      </span>
      <span
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-label={`${done} of ${total} sub-issues done`}
        style={{
          flex: 1,
          height: 6,
          minWidth: 40,
          borderRadius: 999,
          background: 'var(--secondary)',
          overflow: 'hidden',
        }}
      >
        <span
          style={{
            display: 'block',
            width: `${Math.round(share * 100)}%`,
            height: '100%',
            background: 'var(--success)',
          }}
        />
      </span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--muted-foreground)' }}>
        {done}/{total}
      </span>
    </div>
  );
}

/**
 * One reference, opened here when it can be and on GitHub when it cannot.
 *
 * A button when the panel offered somewhere to open it, an anchor otherwise —
 * rather than a button that does nothing, which is the shape a disabled link
 * takes and is indistinguishable from a broken one.
 */
function LinkRow({
  refer,
  foreign,
  onOpen,
}: {
  refer: GitHubRef;
  /** In another repository, where the number alone would name the wrong thing. */
  foreign: boolean;
  onOpen?: (ref: GitHubRef) => void;
}): React.JSX.Element {
  const state = String(refer.state || '').toUpperCase();
  const done = state === 'CLOSED' || state === 'MERGED';
  const body = (
    <>
      <span style={{ display: 'inline-flex', flexShrink: 0, color: tone(state, refer.isDraft) }}>
        <Icon name={refer.kind === 'pr' ? 'git-pull-request' : 'circle-dot'} size={11} />
      </span>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          color: 'var(--muted-foreground)',
          // `#151` is two glyphs and never gives way; `owner/some-long-name#151`
          // is unbounded and would push the row out of a phone-width panel.
          flexShrink: foreign ? 1 : 0,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {foreign ? `${refer.repo}#${refer.number}` : `#${refer.number}`}
      </span>
      <span
        style={{
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          textDecoration: done && refer.kind === 'issue' ? 'line-through' : undefined,
        }}
      >
        {refer.title || ''}
      </span>
    </>
  );

  const style: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    minWidth: 0,
    padding: 0,
    background: 'transparent',
    border: 'none',
    font: 'inherit',
    fontSize: 'var(--text-2xs)',
    color: 'var(--foreground)',
    textAlign: 'left',
    textDecoration: 'none',
    cursor: 'pointer',
  };

  const title = `${refer.repo ? `${refer.repo} ` : ''}#${refer.number}${refer.title ? ` — ${refer.title}` : ''}`;

  return onOpen ? (
    <button type="button" style={style} title={title} onClick={() => onOpen(refer)}>
      {body}
    </button>
  ) : (
    <a style={style} title={title} href={refer.url} target="_blank" rel="noreferrer noopener">
      {body}
    </a>
  );
}

/** The colour GitHub gives a state, so a closed reference reads as closed. */
function tone(state: string, isDraft?: boolean): string {
  if (isDraft) return 'var(--muted-foreground)';
  if (state === 'MERGED') return 'var(--primary)';
  if (state === 'CLOSED') return 'var(--muted-foreground)';
  if (state === 'OPEN') return 'var(--success)';
  return 'var(--muted-foreground)';
}

function Section({
  author,
  when,
  children,
}: {
  author?: string;
  when?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <article
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        background: 'var(--card)',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 10px',
          borderBottom: '1px solid var(--border)',
          fontSize: 'var(--text-2xs)',
          color: 'var(--muted-foreground)',
        }}
      >
        <Icon name="user" size={11} />
        {author || 'unknown'}
        {when ? <span style={{ marginLeft: 'auto' }}>{formatWhen(when)}</span> : null}
      </header>
      <div style={{ padding: '8px 10px', minWidth: 0, overflowX: 'auto' }}>{children}</div>
    </article>
  );
}

/** A date a person can read, in their own locale, or the raw string. */
function formatWhen(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString();
}
