import * as React from 'react';
import type { FileDiff } from '../../../shared/chat-events.js';
import type { GitChange } from '../../../shared/git-status.js';
import { Badge, type BadgeVariant } from '../../ui/relay/Badge.js';
import { Icon } from '../../ui/relay/Icon.js';
import { fetchDiff, fetchGit, type GitOverview } from '../../chat/workspace-api.js';
import { DiffView } from './DiffView.js';
import { PanelBody, PanelHeader, PanelNote, useWorkspaceData } from './PanelShell.js';

/**
 * What the agent has actually changed in this working tree.
 *
 * The list is `git status`; the diff for a file is fetched only when the user
 * opens it. That split matters on a real branch: `git diff` for a large refactor
 * is megabytes, and rendering all of it to show a list of eleven filenames is
 * the difference between a panel that opens instantly and one that hangs the
 * tab.
 */

const KIND_LETTER: Record<GitChange['kind'], string> = {
  create: 'A',
  update: 'M',
  delete: 'D',
  rename: 'R',
};

const KIND_VARIANT: Record<GitChange['kind'], BadgeVariant> = {
  create: 'success',
  update: 'warning',
  delete: 'destructive',
  rename: 'outline',
};

export interface GitChangesPanelProps {
  sessionId: string;
  /** Bumped by the caller when the agent has been working, to re-poll. */
  revision?: number;
  /** Open a changed file in the editor. Absolute path. */
  onOpenFile?: (path: string) => void;
}

export function GitChangesPanel({
  sessionId,
  revision = 0,
  onOpenFile,
}: GitChangesPanelProps): React.JSX.Element {
  const { data, error, busy, reload } = useWorkspaceData<GitOverview>(
    () => fetchGit(sessionId),
    [sessionId, revision],
    Boolean(sessionId),
  );

  const [open, setOpen] = React.useState<string | null>(null);

  // `git status` reports paths relative to the repository root, and the editor
  // route takes anything inside the session directory — so the relative path is
  // handed over as-is rather than being joined against a root this panel would
  // have to learn separately.
  const openFile = React.useCallback(
    (path: string) => onOpenFile?.(path),
    [onOpenFile],
  );

  // A file that stops being changed must not stay expanded showing a diff that
  // no longer exists.
  React.useEffect(() => {
    if (!open || !data?.changes) return;
    if (!data.changes.some((change) => change.path === open)) setOpen(null);
  }, [data, open]);

  const changes = data?.changes ?? [];
  const detail = data?.repo
    ? [data.branch || 'detached', data.ahead ? `↑${data.ahead}` : '', data.behind ? `↓${data.behind}` : '']
        .filter(Boolean)
        .join(' ')
    : undefined;

  return (
    <>
      <PanelHeader title="Changes" detail={detail} onRefresh={reload} busy={busy}>
        {changes.length > 0 ? (
          <Badge variant="neutral">{changes.length}</Badge>
        ) : null}
      </PanelHeader>
      <PanelBody>
        {error ? <PanelNote tone="destructive" icon="circle-alert">{error}</PanelNote> : null}
        {!error && !data && busy ? <PanelNote>Reading the working tree…</PanelNote> : null}
        {!error && data && !data.repo ? (
          <PanelNote icon="git-branch">
            {data.reason || 'This folder is not a git repository.'}
          </PanelNote>
        ) : null}
        {!error && data?.repo && changes.length === 0 ? (
          <PanelNote icon="check">
            Nothing changed. The working tree matches {data.branch ? `\`${data.branch}\`` : 'HEAD'}.
          </PanelNote>
        ) : null}

        {data?.head && data.repo && changes.length === 0 ? (
          <div
            style={{
              padding: '0 12px 12px',
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-2xs)',
              color: 'var(--muted-foreground)',
            }}
          >
            {data.head.sha} {data.head.subject}
          </div>
        ) : null}

        {changes.map((change) => (
          <ChangeRow
            key={`${change.path}:${change.index}${change.worktree}`}
            sessionId={sessionId}
            change={change}
            open={open === change.path}
            onToggle={() => setOpen(open === change.path ? null : change.path)}
            onOpenFile={onOpenFile ? openFile : undefined}
          />
        ))}
      </PanelBody>
    </>
  );
}

function ChangeRow({
  sessionId,
  change,
  open,
  onToggle,
  onOpenFile,
}: {
  sessionId: string;
  change: GitChange;
  open: boolean;
  onToggle: () => void;
  onOpenFile?: (path: string) => void;
}): React.JSX.Element {
  const [hover, setHover] = React.useState(false);

  return (
    <div
      style={{ display: 'flex', alignItems: 'stretch', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        title={change.oldPath ? `${change.oldPath} → ${change.path}` : change.path}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flex: 1,
          minWidth: 0,
          minHeight: 30,
          padding: '0 8px 0 6px',
          background: hover ? 'var(--accent)' : 'transparent',
          border: 0,
          color: 'var(--foreground)',
          font: 'inherit',
          fontSize: 'var(--text-sm)',
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            direction: 'rtl',
            textAlign: 'left',
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-xs)',
          }}
        >
          {/* RTL so a long path truncates at the front, where the least
              informative part is; the bidi isolate keeps the text itself from
              being reordered. */}
          <bdi>{change.path}</bdi>
        </span>
        {change.conflicted ? (
          <Badge variant="destructive" dot>
            !
          </Badge>
        ) : null}
        {change.untracked ? <Badge variant="neutral">new</Badge> : null}
        {change.staged ? <Badge variant="success">staged</Badge> : null}
        <Badge variant={KIND_VARIANT[change.kind]} dot>
          {KIND_LETTER[change.kind]}
        </Badge>
      </button>

      {/* A deleted file has nothing left to open. */}
      {onOpenFile && change.kind !== 'delete' ? (
        <button
          type="button"
          onClick={() => onOpenFile(change.path)}
          aria-label={`Open ${change.path}`}
          title="Open in the editor"
          style={{
            display: 'inline-flex',
            flex: '0 0 auto',
            alignItems: 'center',
            justifyContent: 'center',
            // 34px is this app's touch floor (see IconButton size="lg" and the
            // mobile bar). At 28, flush against the expand toggle, a thumb aimed
            // at "open" collapsed the diff instead.
            width: 34,
            minHeight: 34,
            background: 'transparent',
            border: 0,
            color: 'var(--muted-foreground)',
            // Quiet at rest rather than hidden: a control that only exists on
            // hover does not exist at all on a touch screen.
            opacity: hover ? 1 : 0.55,
            cursor: 'pointer',
          }}
        >
          <Icon name="file-text" size={12} />
        </button>
      ) : null}

      {open ? (
        <div style={{ flexBasis: '100%', minWidth: 0 }}>
          <ChangeDiff sessionId={sessionId} change={change} />
        </div>
      ) : null}
    </div>
  );
}

function ChangeDiff({ sessionId, change }: { sessionId: string; change: GitChange }): React.JSX.Element {
  // Staged-only changes have nothing in the unstaged diff, so asking for the
  // wrong one shows an empty card for a file the panel just said had changed.
  const staged = change.staged && !change.unstaged;

  const { data, error, busy } = useWorkspaceData<{ diffs: FileDiff[]; error?: string }>(
    () => fetchDiff(sessionId, { path: change.path, staged }),
    [sessionId, change.path, staged],
  );

  if (busy && !data) return <PanelNote>Loading diff…</PanelNote>;
  if (error) return <PanelNote tone="destructive" icon="circle-alert">{error}</PanelNote>;
  if (data?.error) return <PanelNote tone="destructive" icon="circle-alert">{data.error}</PanelNote>;
  if (!data || data.diffs.length === 0) {
    return <PanelNote>No textual diff for this file.</PanelNote>;
  }

  return (
    <div style={{ padding: '4px 8px 8px' }}>
      <DiffView diffs={data.diffs} />
    </div>
  );
}
