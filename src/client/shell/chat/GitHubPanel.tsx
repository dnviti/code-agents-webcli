import * as React from 'react';
import { Badge } from '../../ui/relay/Badge.js';
import { Icon } from '../../ui/relay/Icon.js';
import {
  fetchGitHub,
  type GitHubIssue,
  type GitHubOverview,
  type GitHubPull,
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
  // Which issue or pull request is being read, or null. One at a time: this is
  // a reader, and a stack of them over a 320px rail would be unusable.
  const [openItem, setOpenItem] = React.useState<{ kind: 'issue' | 'pr'; number: number } | null>(
    null,
  );

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
            >
              {prs.map((pr) => (
                <PullRow key={pr.number} pull={pr} onOpen={() => setOpenItem({ kind: 'pr', number: pr.number })} />
              ))}
            </Section>
            <Section title="Issues" count={issues.length} empty="No open issues.">
              {issues.map((issue) => (
                <IssueRow
                  key={issue.number}
                  issue={issue}
                  onOpen={() => setOpenItem({ kind: 'issue', number: issue.number })}
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
          onClose={() => setOpenItem(null)}
        />
      ) : null}
    </>
  );
}

function Section({
  title,
  count,
  empty,
  children,
}: {
  title: string;
  count: number;
  empty: string;
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
      {count === 0 ? <PanelNote>{empty}</PanelNote> : children}
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

function PullRow({ pull, onOpen }: { pull: GitHubPull; onOpen: () => void }): React.JSX.Element {
  return (
    <RowLink onOpen={onOpen} number={pull.number} title={pull.title}>
      <Meta>
        {pull.isDraft ? <Badge variant="outline">draft</Badge> : null}
        {pull.author?.login ? <span>@{pull.author.login}</span> : null}
        {pull.headRefName ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            <Icon name="git-branch" size={10} />
            {pull.headRefName}
          </span>
        ) : null}
      </Meta>
    </RowLink>
  );
}

function IssueRow({ issue, onOpen }: { issue: GitHubIssue; onOpen: () => void }): React.JSX.Element {
  const labels = (issue.labels || []).map((label) => label.name).filter(Boolean) as string[];
  return (
    <RowLink onOpen={onOpen} number={issue.number} title={issue.title}>
      <Meta>
        {issue.author?.login ? <span>@{issue.author.login}</span> : null}
        {labels.slice(0, 3).map((label) => (
          <Badge key={label} variant="outline">
            {label}
          </Badge>
        ))}
      </Meta>
    </RowLink>
  );
}
