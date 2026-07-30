import * as React from 'react';
import { Badge } from '../../ui/relay/Badge.js';
import { Icon } from '../../ui/relay/Icon.js';
import {
  fetchGitHub,
  reviewDecisionLabel,
  type GitHubActor,
  type GitHubIssue,
  type GitHubOverview,
  type GitHubPull,
  type GitHubRef,
} from '../../chat/workspace-api.js';
import { PanelBody, PanelHeader, PanelNote, useWorkspaceData } from './PanelShell.js';
import { GitHubItemDialog } from './GitHubItemDialog.js';

/**
 * Open pull requests and issues on this working directory's GitHub remote.
 *
 * Everything here comes from the `gh` CLI running on the server, so the panel
 * has exactly the access the person who set the server up has — no token in the
 * browser, no second credential to manage, and no reachability requirement
 * beyond the one `gh` already satisfies. When `gh` is missing or signed out the
 * panel says which of the two it is, because they need different fixes and an
 * empty list looks the same as a repository with no open work.
 */

export interface GitHubPanelProps {
  sessionId: string;
}

export function GitHubPanel({ sessionId }: GitHubPanelProps): React.JSX.Element {
  const [refreshing, setRefreshing] = React.useState(false);
  // The trail of things being read, most recent last. One dialog at a time —
  // a stack of windows over a 320px rail would be unusable — but following a
  // reference out of an issue has to be undoable, so what it was followed from
  // is kept rather than replaced.
  const [trail, setTrail] = React.useState<Array<{ kind: 'issue' | 'pr'; number: number; repo?: string }>>([]);
  const openItem = trail[trail.length - 1] || null;

  const open = React.useCallback((kind: 'issue' | 'pr', number: number, repo?: string) => {
    setTrail([{ kind, number, repo }]);
  }, []);

  const follow = React.useCallback((ref: GitHubRef) => {
    setTrail((seen) => [...seen, { kind: ref.kind, number: ref.number, repo: ref.repo }]);
  }, []);

  const { data, error, busy, reload } = useWorkspaceData<GitHubOverview>(
    () => fetchGitHub(sessionId, refreshing),
    [sessionId],
    Boolean(sessionId),
  );

  const refresh = React.useCallback(() => {
    // The server caches `gh` answers for half a minute; an explicit refresh is
    // the user saying they want to spend a round trip to skip that.
    setRefreshing(true);
    reload();
  }, [reload]);

  const prs = data?.prs ?? [];
  const issues = data?.issues ?? [];

  return (
    <>
      <PanelHeader
        title="GitHub"
        detail={data?.repo?.nameWithOwner || undefined}
        onRefresh={refresh}
        busy={busy}
      />
      <PanelBody>
        {error ? <PanelNote tone="destructive" icon="circle-alert">{error}</PanelNote> : null}
        {!error && !data && busy ? <PanelNote>Asking the GitHub CLI…</PanelNote> : null}
        {!error && data && !data.available ? (
          <PanelNote icon="git-branch">{data.reason || 'GitHub is not available here.'}</PanelNote>
        ) : null}

        {data?.available ? (
          <>
            <Section
              title="Pull requests"
              count={prs.length}
              empty="No open pull requests."
              error={data.prsError}
            >
              {prs.map((pr) => (
                <PullRow key={pr.number} pull={pr} onOpen={() => open('pr', pr.number)} />
              ))}
            </Section>
            <Section
              title="Issues"
              count={issues.length}
              empty="No open issues."
              error={data.issuesError}
            >
              {issues.map((issue) => (
                <IssueRow
                  key={issue.number}
                  issue={issue}
                  onOpen={() => open('issue', issue.number)}
                />
              ))}
            </Section>
          </>
        ) : null}
      </PanelBody>

      {openItem ? (
        <GitHubItemDialog
          sessionId={sessionId}
          kind={openItem.kind}
          number={openItem.number}
          repo={openItem.repo}
          onOpen={follow}
          onBack={trail.length > 1 ? () => setTrail((seen) => seen.slice(0, -1)) : undefined}
          onClose={() => setTrail([])}
        />
      ) : null}
    </>
  );
}

function Section({
  title,
  count,
  empty,
  error,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  /** What `gh` said when it refused, which is not the same as nothing being open. */
  error?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '10px 10px 4px',
          fontFamily: 'var(--font-sans)',
          fontSize: 'var(--text-2xs)',
          textTransform: 'uppercase',
          letterSpacing: 'var(--tracking-caps)',
          color: 'var(--muted-foreground)',
        }}
      >
        {title}
        <Badge variant="neutral">{count}</Badge>
      </div>
      {/* A list `gh` refused to produce is not an empty list, and the two are
          the same empty section on screen unless one of them says so. */}
      {error ? (
        <PanelNote tone="destructive" icon="circle-alert">
          {`This could not be listed: ${error}`}
        </PanelNote>
      ) : null}
      {!error && count === 0 ? <PanelNote>{empty}</PanelNote> : null}
      {count > 0 ? children : null}
    </section>
  );
}

function RowLink({
  onOpen,
  number,
  title,
  children,
}: {
  onOpen: () => void;
  number: number;
  title: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  const [hover, setHover] = React.useState(false);
  return (
    // A button, not a link: this opens a panel in the app rather than
    // navigating, and an anchor would promise a destination it does not go to
    // — including to the middle-click and "open in new tab" a link advertises.
    <button
      type="button"
      onClick={onOpen}
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 7,
        width: '100%',
        padding: '6px 10px',
        background: hover ? 'var(--accent)' : 'transparent',
        color: 'var(--foreground)',
        font: 'inherit',
        textAlign: 'left',
        border: 'none',
        borderBottom: '1px solid var(--border)',
        cursor: 'pointer',
      }}
    >
      <span
        style={{
          flex: '0 0 auto',
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--text-2xs)',
          color: 'var(--muted-foreground)',
          marginTop: 2,
        }}
      >
        #{number}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: 'block',
            fontSize: 'var(--text-sm)',
            lineHeight: 'var(--leading-snug)',
            wordBreak: 'break-word',
          }}
        >
          {title}
        </span>
        {children}
      </span>
    </button>
  );
}

function Meta({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 5,
        marginTop: 3,
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--text-2xs)',
        color: 'var(--muted-foreground)',
      }}
    >
      {children}
    </span>
  );
}

/**
 * One fact about a row, as an icon and a word.
 *
 * Every extra thing a row says competes for the same 320px, so each is one
 * glyph and one short string, and each carries a `title` — the icon says which
 * fact it is to someone who already knows the panel, and the hover says it to
 * everyone else.
 *
 * The same sentence is the `aria-label`, which is what a reader that cannot see
 * the icon gets instead: a row whose accessible name is "#134 … dnviti 1/2
 * #151" says nothing about which number is which, and a descendant's label is
 * used when the button's own name is computed from its contents.
 */
function Fact({
  icon,
  text,
  hint,
  tone,
}: {
  icon: string;
  text: string;
  hint: string;
  tone?: string;
}): React.JSX.Element {
  return (
    <span
      title={hint}
      aria-label={hint}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: tone || undefined }}
    >
      <Icon name={icon} size={10} />
      {text}
    </span>
  );
}

/** Logins, short enough for a rail: the first two, then how many more. */
function people(actors: GitHubActor[] | undefined): string {
  const logins = (actors || []).map((one) => one.login).filter(Boolean);
  if (logins.length <= 2) return logins.join(', ');
  return `${logins.slice(0, 2).join(', ')} +${logins.length - 2}`;
}

/** The numbers a set of references names, shortest first: `#12, #34 +2`. */
function numbers(refs: GitHubRef[]): string {
  const shown = refs.slice(0, 2).map((ref) => `#${ref.number}`).join(', ');
  return refs.length > 2 ? `${shown} +${refs.length - 2}` : shown;
}

function PullRow({ pull, onOpen }: { pull: GitHubPull; onOpen: () => void }): React.JSX.Element {
  const assignees = pull.assignees || [];
  const closes = (pull.references || []).filter((ref) => ref.relation === 'closes');
  const review = reviewDecisionLabel(pull.reviewDecision);
  const checks = pull.checks;

  return (
    <RowLink onOpen={onOpen} number={pull.number} title={pull.title}>
      <Meta>
        {pull.isDraft ? <Badge variant="outline">draft</Badge> : null}
        {pull.author?.login ? <span title={`Opened by ${pull.author.login}`}>@{pull.author.login}</span> : null}
        {assignees.length ? (
          <Fact
            icon="user"
            text={people(assignees)}
            hint={`Assigned to ${assignees.map((one) => one.login).join(', ')}`}
          />
        ) : null}
        {pull.headRefName ? (
          <span title={pull.baseRefName ? `${pull.headRefName} → ${pull.baseRefName}` : pull.headRefName} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            <Icon name="git-branch" size={10} />
            {pull.headRefName}
          </span>
        ) : null}
        {closes.length ? (
          <Fact
            icon="circle-dot"
            text={numbers(closes)}
            hint={`Closes ${closes.map((ref) => `#${ref.number}`).join(', ')}`}
          />
        ) : null}
        {checks ? (
          <Fact
            icon={checks.state === 'failing' ? 'circle-x' : checks.state === 'pending' ? 'clock' : 'check'}
            text={`${checks.passed}/${checks.total}`}
            hint={`Checks: ${checks.passed} passed, ${checks.failed} failed, ${checks.pending} running`}
            tone={
              checks.state === 'failing'
                ? 'var(--destructive)'
                : checks.state === 'passing' ? 'var(--success)' : undefined
            }
          />
        ) : null}
        {review ? (
          <Badge variant={pull.reviewDecision === 'APPROVED' ? 'success' : 'warning'}>{review.toLowerCase()}</Badge>
        ) : null}
      </Meta>
    </RowLink>
  );
}

function IssueRow({ issue, onOpen }: { issue: GitHubIssue; onOpen: () => void }): React.JSX.Element {
  const labels = (issue.labels || []).map((label) => label.name).filter(Boolean) as string[];
  const assignees = issue.assignees || [];
  const pulls = (issue.references || []).filter((ref) => ref.kind === 'pr');
  // Only what is still in the way. GitHub keeps the dependency after the
  // blocker is closed — correctly, it is history — but a row that reads
  // "blocked" forever is how ready work gets skipped. An unknown state counts
  // as blocking, so a shape this does not recognise errs towards saying so.
  const blocked = (issue.blockedBy || []).filter(
    (ref) => (ref.state || 'OPEN').toUpperCase() === 'OPEN',
  );
  const children = issue.childrenTotal || 0;

  return (
    <RowLink onOpen={onOpen} number={issue.number} title={issue.title}>
      <Meta>
        {issue.author?.login ? <span title={`Opened by ${issue.author.login}`}>@{issue.author.login}</span> : null}
        {assignees.length ? (
          <Fact
            icon="user"
            text={people(assignees)}
            hint={`Assigned to ${assignees.map((one) => one.login).join(', ')}`}
          />
        ) : null}
        {issue.parent ? (
          <Fact
            icon="corner-up-left"
            text={`#${issue.parent.number}`}
            hint={`Part of #${issue.parent.number}${issue.parent.title ? ` — ${issue.parent.title}` : ''}`}
          />
        ) : null}
        {children > 0 ? (
          <Fact
            icon="list-todo"
            text={`${issue.childrenDone || 0}/${children}`}
            hint={`${issue.childrenDone || 0} of ${children} sub-issues done`}
            tone={(issue.childrenDone || 0) >= children ? 'var(--success)' : undefined}
          />
        ) : null}
        {pulls.length ? (
          <Fact
            icon="git-pull-request"
            text={numbers(pulls)}
            hint={`Pull requests: ${pulls.map((ref) => `#${ref.number}`).join(', ')}`}
          />
        ) : null}
        {blocked.length ? (
          <Fact
            icon="circle-alert"
            text={numbers(blocked)}
            hint={`Blocked by ${blocked.map((ref) => `#${ref.number}`).join(', ')}`}
            tone="var(--warning)"
          />
        ) : null}
        {labels.slice(0, 3).map((label) => (
          <Badge key={label} variant="outline">
            {label}
          </Badge>
        ))}
      </Meta>
    </RowLink>
  );
}
