import * as React from 'react';
import { Badge } from '../../ui/relay/Badge.js';
import { Dialog } from '../../ui/relay/Dialog.js';
import { Icon } from '../../ui/relay/Icon.js';
import { fetchGitHubItem, type GitHubItem } from '../../chat/workspace-api.js';
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
 */

export interface GitHubItemDialogProps {
  sessionId: string;
  kind: 'issue' | 'pr';
  number: number;
  onClose(): void;
}

export function GitHubItemDialog({
  sessionId,
  kind,
  number,
  onClose,
}: GitHubItemDialogProps): React.JSX.Element {
  const [item, setItem] = React.useState<GitHubItem | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setItem(null);
    setError(null);

    fetchGitHubItem(sessionId, kind, number)
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
  }, [sessionId, kind, number]);

  const label = kind === 'pr' ? 'Pull request' : 'Issue';
  const comments = item?.comments || [];

  return (
    <Dialog
      open
      movable
      width="min(880px, 94vw)"
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <Icon name={kind === 'pr' ? 'git-pull-request' : 'circle-dot'} size={14} />
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--muted-foreground)' }}>
            #{number}
          </span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {item?.title || label}
          </span>
        </span>
      }
      headerActions={
        item ? (
          // Still offered, because some things — reviewing, commenting, merging
          // — are GitHub's job and this is a reader.
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer noopener"
            title="Open on GitHub"
            aria-label="Open on GitHub"
            style={{ display: 'inline-flex', color: 'var(--muted-foreground)', padding: 2 }}
          >
            <Icon name="external-link" size={13} />
          </a>
        ) : null
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
  const open = String(item.state || '').toUpperCase() === 'OPEN';
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)' }}>
      <Badge variant={item.isDraft ? 'neutral' : open ? 'success' : 'outline'}>
        {item.isDraft ? 'Draft' : open ? 'Open' : 'Closed'}
      </Badge>
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
      {(item.labels || []).map((tag) => (
        <Badge key={tag.name} variant="outline">{tag.name}</Badge>
      ))}
    </div>
  );
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
