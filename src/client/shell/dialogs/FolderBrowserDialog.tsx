import * as React from 'react';

import type { FolderEntry } from '../store';
import { Button } from '../../ui/relay/Button';
import { Checkbox } from '../../ui/relay/Checkbox';
import { Dialog } from '../../ui/relay/Dialog';
import { Icon } from '../../ui/relay/Icon';
import { IconButton } from '../../ui/relay/IconButton';
import { Input } from '../../ui/relay/Input';

export interface FolderBrowserDialogProps {
  open: boolean;
  path: string | null;
  parentPath: string | null;
  entries: FolderEntry[];
  workingDirKind: 'host' | 'container' | null;
  lifetime: 'workspace' | 'owner_home' | 'disposable' | null;
  showHidden: boolean;
  loading: boolean;
  /** True while the inline "new folder" row is open. */
  creating: boolean;
  onNavigate(path: string): void;
  onUp(): void;
  onHome(): void;
  onToggleHidden(next: boolean): void;
  onStartCreate(): void;
  onCancelCreate(): void;
  onCreate(name: string): void;
  /** Accept the current directory as the working directory. */
  onSelect(): void;
  onClose(): void;
}

/**
 * Rejects the names the create endpoint would reject anyway, so the user learns
 * about a bad name at the keystroke rather than after a round trip. Returns the
 * message to show, or null when the name is worth sending.
 */
function validateFolderName(name: string): string | null {
  if (!name) return 'Enter a folder name.';
  if (name.includes('/') || name.includes('\\')) {
    return 'A folder name cannot contain path separators.';
  }
  return null;
}

function FolderRow({
  entry,
  onNavigate,
}: {
  entry: FolderEntry;
  onNavigate(path: string): void;
}): React.JSX.Element {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      type="button"
      onClick={() => onNavigate(entry.path)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={entry.path}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        padding: '8px 10px',
        textAlign: 'left',
        background: hover ? 'var(--accent)' : 'transparent',
        border: '1px solid transparent',
        borderRadius: 'var(--radius)',
        color: 'var(--foreground)',
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--text-ui)',
        cursor: 'pointer',
        transition: 'background var(--duration-fast) var(--ease-standard)',
      }}
    >
      <Icon name="folder" size={15} style={{ color: 'var(--muted-foreground)' }} />
      {/* Folder names come from the filesystem and any signed-in user can create
          one, so they are rendered as text children — never as markup. */}
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {entry.name}
      </span>
      <Icon name="chevron-right" size={13} style={{ color: 'var(--muted-foreground)' }} />
    </button>
  );
}

export function FolderBrowserDialog({
  open,
  path,
  parentPath,
  entries,
  workingDirKind,
  lifetime,
  showHidden,
  loading,
  creating,
  onNavigate,
  onUp,
  onHome,
  onToggleHidden,
  onStartCreate,
  onCancelCreate,
  onCreate,
  onSelect,
  onClose,
}: FolderBrowserDialogProps): React.JSX.Element | null {
  const [name, setName] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  // Every time the row opens it starts blank: a name left over from the last
  // attempt (or the error explaining why it failed) would otherwise be sitting
  // there pre-filled.
  React.useEffect(() => {
    if (!creating) return;
    setName('');
    setError(null);
  }, [creating]);

  if (!open) return null;

  const submit = (): void => {
    const trimmed = name.trim();
    const message = validateFolderName(trimmed);
    if (message) {
      setError(message);
      return;
    }
    onCreate(trimmed);
  };

  const mutedTextStyle: React.CSSProperties = {
    fontFamily: 'var(--font-sans)',
    fontSize: 'var(--text-sm)',
    color: 'var(--muted-foreground)',
  };

  const footer = (
    <>
      <Checkbox
        checked={showHidden}
        onChange={onToggleHidden}
        label="Show hidden folders"
        style={{ marginRight: 'auto' }}
      />
      <Button variant="secondary" onClick={onClose}>
        Cancel
      </Button>
      <Button variant="primary" onClick={onSelect}>
        Use this folder
      </Button>
    </>
  );

  const lifetimeNotice = workingDirKind === 'container' && lifetime
    ? lifetime === 'owner_home'
      ? 'This folder is in the project owner’s home and survives project-container rebuilds.'
      : lifetime === 'workspace'
        ? 'This folder is in the workspace. A true rebuild clones the repository fresh; dirty repository work is preserved on a WIP branch, but a workspace without a repository is not preserved.'
        : 'This folder is disposable container storage. It may disappear when the project container is rebuilt.'
    : null;

  return (
    <Dialog open title="Select working directory" width={620} onClose={onClose} footer={footer}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <IconButton
          variant="outline"
          label="Parent directory"
          disabled={parentPath === null}
          onClick={onUp}
        >
          <Icon name="arrow-up" size={15} />
        </IconButton>
        <IconButton variant="outline" label="Home directory" onClick={onHome}>
          <Icon name="home" size={15} />
        </IconButton>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Input mono readOnly value={path ?? ''} aria-label="Current directory" />
        </div>
        <IconButton variant="outline" label="New folder" onClick={onStartCreate}>
          <Icon name="folder-plus" size={15} />
        </IconButton>
      </div>

      {lifetimeNotice ? (
        <div
          role="note"
          style={{
            marginTop: 10,
            padding: '9px 11px',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            background: lifetime === 'disposable' ? 'var(--destructive-muted, var(--muted))' : 'var(--muted)',
            color: lifetime === 'disposable' ? 'var(--destructive)' : 'var(--muted-foreground)',
            fontFamily: 'var(--font-sans)',
            fontSize: 'var(--text-sm)',
            lineHeight: 1.45,
          }}
        >
          {lifetimeNotice}
        </div>
      ) : null}

      {creating ? (
        <div
          style={{
            marginTop: 10,
            padding: 10,
            background: 'var(--muted)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Input
                autoFocus
                value={name}
                placeholder="Folder name"
                invalid={error !== null}
                aria-label="Folder name"
                onChange={(event) => {
                  setName(event.currentTarget.value);
                  setError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    submit();
                  } else if (event.key === 'Escape') {
                    // Dialog listens for Escape on `document` to close itself.
                    // Here Escape belongs to the create row alone, so the whole
                    // browser does not vanish when the user abandons a name.
                    event.stopPropagation();
                    onCancelCreate();
                  }
                }}
              />
            </div>
            <Button variant="primary" size="sm" onClick={submit}>
              Create
            </Button>
            <Button variant="secondary" size="sm" onClick={onCancelCreate}>
              Cancel
            </Button>
          </div>
          {error ? (
            <div
              style={{
                marginTop: 6,
                fontFamily: 'var(--font-sans)',
                fontSize: 'var(--text-sm)',
                color: 'var(--destructive)',
              }}
            >
              {error}
            </div>
          ) : null}
        </div>
      ) : null}

      <div
        style={{
          marginTop: 10,
          maxHeight: '46vh',
          overflowY: 'auto',
          padding: 6,
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
        }}
      >
        {/* An in-flight fetch says so, so a slow directory never reads as an
            empty one. */}
        {loading ? <div style={{ ...mutedTextStyle, padding: '8px 10px' }}>Loading…</div> : null}
        {!loading && entries.length === 0 ? (
          <div
            style={{
              ...mutedTextStyle,
              padding: 26,
              textAlign: 'center',
              border: '1px dashed var(--border)',
              borderRadius: 'var(--radius)',
            }}
          >
            No folders here
          </div>
        ) : null}
        {entries.map((entry) => (
          <FolderRow key={entry.path} entry={entry} onNavigate={onNavigate} />
        ))}
      </div>
    </Dialog>
  );
}
