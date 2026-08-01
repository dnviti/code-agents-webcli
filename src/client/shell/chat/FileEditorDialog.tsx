import * as React from 'react';
import { showConfirm } from '../../ui/confirm.js';
import { Badge } from '../../ui/relay/Badge.js';
import { Button } from '../../ui/relay/Button.js';
import { Dialog } from '../../ui/relay/Dialog.js';
import { Icon } from '../../ui/relay/Icon.js';
import { isHtmlFile, isMarkdownFile, mediaTypeForFile } from '../../../shared/file-media.js';
import { assetBaseUrl, fetchFile, rawFileUrl, saveFile, type WorkspaceFile } from '../../chat/workspace-api.js';
import { Markdown } from './Markdown.js';
import { MediaView } from './MediaView.js';
import { MonacoEditor } from './MonacoEditor.js';

/**
 * A file from the session's working tree, open for reading and editing.
 *
 * Opened by clicking a file in the workspace panel. It is deliberately a modal
 * rather than a fourth region inside the rail: a 320px column is not somewhere
 * anyone can read code, and the conversation underneath is not something the
 * user is doing while they are in here.
 *
 * The hazard this has that an ordinary editor does not is that an agent is
 * editing the same tree, right now, and may well be editing this same file. So:
 * the version opened is carried through the save and the server refuses a stale
 * one, unsaved work is never discarded without asking, and a refused save says
 * what happened and offers to reload rather than leaving the user to guess.
 */

export interface FileEditorDialogProps {
  open: boolean;
  sessionId: string;
  /** Absolute path, as the file tree reports it. */
  filePath: string;
  /** One-based source line requested by a chat link. */
  initialLine?: number;
  onClose: () => void;
  /** Anchor to the bottom edge, where a thumb can reach the buttons. */
  isMobile?: boolean;
}

/**
 * A file's original line ending, so saving it back does not rewrite every line.
 *
 * A textarea normalises CRLF to LF on the way in and gives LF back on the way
 * out. Saving that to a CRLF file changes every line in it — a diff of the
 * whole file for an edit of one line, and the editor could never reach a clean
 * state because what it holds never equals what it read.
 */
function detectNewline(content: string): '\r\n' | '\n' {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

type Status =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; file: WorkspaceFile };

/**
 * Rendered, or the source.
 *
 * Markdown is the one kind of file where the raw text is not the point of
 * opening it — a README is written to be read — so it opens in `preview` and
 * the toggle is there for when you actually want to edit. Everything else has
 * no preview to offer and never leaves `code`.
 */
type ViewMode = 'preview' | 'code';

export function FileEditorDialog({
  open,
  sessionId,
  filePath,
  initialLine,
  onClose,
  isMobile = false,
}: FileEditorDialogProps): React.JSX.Element | null {
  const [status, setStatus] = React.useState<Status>({ kind: 'loading' });
  const [text, setText] = React.useState('');
  const [newline, setNewline] = React.useState<'\r\n' | '\n'>('\n');
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [savedAt, setSavedAt] = React.useState<number | null>(null);
  const [reloadToken, setReloadToken] = React.useState(0);

  // Decided from the name, before anything is fetched: a 40 MB screen recording
  // must not be pulled through the JSON file route to be told it is binary.
  const media = React.useMemo(() => mediaTypeForFile(filePath), [filePath]);
  const markdown = React.useMemo(() => isMarkdownFile(filePath), [filePath]);
  const html = React.useMemo(() => isHtmlFile(filePath), [filePath]);
  // Both open rendered, because both are written to be looked at rather than
  // read as source. The toggle is the same one either way.
  const previewable = markdown || html;
  // Keyed on the file so opening a second markdown file comes back to the
  // preview rather than inheriting the last one's toggle.
  const [view, setView] = React.useState<ViewMode>(
    initialLine === undefined && previewable ? 'preview' : 'code',
  );
  React.useEffect(
    () => setView(initialLine === undefined && previewable ? 'preview' : 'code'),
    [previewable, filePath, initialLine],
  );

  // Read inside callbacks that outlive the render they were made in.
  const dirtyRef = React.useRef(false);
  /**
   * Which load/save this component is currently on.
   *
   * Bumped whenever the file or the reload changes. Every async result checks
   * it before touching state: without it a save that resolves after the dialog
   * was reopened on a different file installs the *old* file as the current
   * one, and the next Save writes that file's path with this file's text.
   */
  const generation = React.useRef(0);

  React.useEffect(() => {
    if (!open || !filePath) return;
    // Media is streamed by the element itself from the raw route; there is
    // nothing here to read, and reading it would mean base64 in a JSON body.
    if (media) return;

    generation.current += 1;
    const mine = generation.current;

    setStatus({ kind: 'loading' });
    setSaveError(null);
    setSavedAt(null);

    fetchFile(sessionId, filePath).then(
      (file) => {
        if (generation.current !== mine) return;
        const ending = detectNewline(file.content);
        // Normalised for the textarea, which would do it anyway; the original
        // ending is remembered so saving restores it.
        const normalised = ending === '\r\n' ? file.content.replace(/\r\n/g, '\n') : file.content;
        setNewline(ending);
        setStatus({ kind: 'ready', file: { ...file, content: normalised } });
        setText(normalised);
      },
      (error: unknown) => {
        if (generation.current !== mine) return;
        setStatus({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
      },
    );
  }, [open, sessionId, filePath, reloadToken]);

  const file = status.kind === 'ready' ? status.file : null;
  const dirty = Boolean(file) && text !== file!.content;
  dirtyRef.current = dirty;

  const editable = Boolean(file) && !file!.binary && !file!.tooLarge && file!.writable;

  const save = React.useCallback(async () => {
    if (!file || !editable || saving) return;
    const mine = generation.current;
    setSaving(true);
    setSaveError(null);
    try {
      // The file's own line ending is restored on the way out, so a CRLF file
      // comes back as CRLF and the diff is the edit rather than every line.
      const onDisk = newline === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
      const result = await saveFile(sessionId, file.path, onDisk, file.mtimeMs);
      if (generation.current !== mine) return;
      // The saved text becomes the new baseline, so the dirty marker clears and
      // a second save carries the version the server just wrote.
      setStatus({ kind: 'ready', file: { ...file, content: text, mtimeMs: result.mtimeMs, size: result.size } });
      setSavedAt(Date.now());
    } catch (error: unknown) {
      if (generation.current !== mine) return;
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation.current === mine) setSaving(false);
    }
  }, [file, editable, saving, sessionId, text, newline]);

  const confirmDiscard = React.useCallback(
    (description: string): Promise<boolean> => {
      if (!dirtyRef.current) return Promise.resolve(true);
      return showConfirm({
        title: 'Discard your changes?',
        description,
        confirmLabel: 'Discard',
        cancelLabel: 'Keep editing',
        tone: 'danger',
      });
    },
    [],
  );

  const requestClose = React.useCallback(() => {
    void confirmDiscard('This file has edits that have not been saved.').then((ok) => {
      if (ok) onClose();
    });
  }, [confirmDiscard, onClose]);

  /**
   * Re-read the file from disk.
   *
   * It asks first, and it has to: this is the button the conflict message
   * points at, so it is pressed precisely when there *are* unsaved edits, and
   * throwing them away silently would destroy exactly the work the refusal was
   * protecting.
   */
  const requestReload = React.useCallback(() => {
    void confirmDiscard('Reloading replaces what is in the editor with the copy on disk.').then((ok) => {
      if (ok) setReloadToken((n) => n + 1);
    });
  }, [confirmDiscard]);

  if (!open) return null;

  const name = file?.name ?? filePath.split('/').pop() ?? filePath;
  // The panel's height, not the content's. Everything inside fills what this
  // leaves, so dragging the corner changes the editor with it — where a
  // viewport-relative height on the content stayed exactly the same size no
  // matter how large the window was made.
  const panelHeight = isMobile ? undefined : 'min(78dvh, 860px)';
  // The one thing that still needs a number of its own: a sheet is sized by the
  // Dialog, and a media element with no height at all collapses to nothing.
  const bodyHeight = isMobile ? 'min(46dvh, 420px)' : '100%';
  const titleIcon = media
    ? { image: 'image', video: 'monitor', audio: 'volume-2', pdf: 'file-text' }[media.kind]
    : 'file-text';

  return (
    <Dialog
      open={open}
      titleText={file?.relativePath ?? filePath}
      title={
        // `flex`, not `inline-flex`, and every fixed-width part pinned: inside
        // the title's `white-space: nowrap` an inline-level box is laid out at
        // max-content and then clipped without an ellipsis (#114). Only the
        // file name gives way.
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ display: 'inline-flex', flexShrink: 0 }}>
            <Icon name={titleIcon} size={14} />
          </span>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
          {dirty ? <span style={{ display: 'inline-flex', flexShrink: 0 }}><Badge variant="warning" dot>unsaved</Badge></span> : null}
          {file && !editable ? <span style={{ display: 'inline-flex', flexShrink: 0 }}><Badge variant="outline">read-only</Badge></span> : null}
        </span>
      }
      // The view switch is a control, not a label, so it belongs with the other
      // controls rather than inside a title that is now allowed to be cut: a
      // clipped title would take it away entirely at a phone width (#114).
      headerActions={previewable && file ? <ViewToggle value={view} onChange={setView} /> : null}
      description={file?.relativePath ?? filePath}
      width="min(1100px, 92vw)"
      // On a phone a centred panel puts its footer under the on-screen keyboard
      // the moment the editor takes focus; a bottom sheet keeps Save reachable.
      placement={isMobile ? 'bottom' : 'center'}
      // This is a panel to work in, not a question to answer: it sits open
      // beside the conversation while the user reads code and types about it,
      // so it has to be possible to shove it out of the way.
      movable
      height={panelHeight}
      bodyFill={!isMobile}
      onClose={requestClose}
      footer={
        <>
          {saveError ? (
            <span
              role="alert"
              style={{
                flex: 1,
                minWidth: 0,
                alignSelf: 'center',
                fontFamily: 'var(--font-sans)',
                fontSize: 'var(--text-sm)',
                color: 'var(--destructive)',
              }}
            >
              {saveError}
            </span>
          ) : savedAt ? (
            <span
              role="status"
              style={{
                flex: 1,
                alignSelf: 'center',
                fontFamily: 'var(--font-sans)',
                fontSize: 'var(--text-sm)',
                color: 'var(--success)',
              }}
            >
              Saved
            </span>
          ) : null}

          <Button
            variant="secondary"
            onClick={media ? () => setReloadToken((n) => n + 1) : requestReload}
            disabled={saving}
          >
            Reload
          </Button>
          <Button variant="secondary" onClick={requestClose} disabled={saving}>
            Close
          </Button>
          {editable ? (
            <Button variant="primary" onClick={() => void save()} disabled={!dirty || saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          ) : null}
        </>
      }
    >
      {media ? (
        <MediaView
          kind={media.kind}
          // The token is in the URL rather than a header: it is the element
          // that fetches, not this code, so Reload has no other way to make it
          // ask again rather than redraw what it already has.
          src={`${rawFileUrl(sessionId, filePath)}&v=${reloadToken}`}
          name={name}
          height={bodyHeight}
        />
      ) : null}

      {!media && status.kind === 'loading' ? <Note>Opening {name}…</Note> : null}
      {!media && status.kind === 'error' ? (
        <Note tone="destructive" icon="circle-alert">
          {status.message}
        </Note>
      ) : null}

      {file ? (
        // `flex: 1` so this column takes the body's height, `minHeight: 0` so it
        // may be shorter than its content — without which the editor pushes the
        // panel taller instead of scrolling inside it.
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minHeight: 0 }}>
          {file.reason ? <Note icon="circle-alert">{file.reason}</Note> : null}
          {file.binary || file.tooLarge ? null : view === 'preview' && html ? (
            <HtmlPreview
              text={text}
              baseHref={assetBaseUrl(sessionId, file.relativePath || file.path)}
              height={bodyHeight}
              label={`Preview of ${file.relativePath}`}
            />
          ) : view === 'preview' ? (
            <MarkdownPreview text={text} height={bodyHeight} label={`Preview of ${file.relativePath}`} />
          ) : (
            <MonacoEditor
              value={text}
              onChange={(next) => {
                // The green "Saved" refers to the previous contents; leaving it
                // up over fresh edits says they are safe when they are not.
                if (savedAt !== null) setSavedAt(null);
                setText(next);
              }}
              language={file.language}
              // The path, not just the language: Monaco resolves the grammar
              // from the extension against its own registry of ninety-odd
              // languages, where `file.language` carries a fence name from the
              // app's eleven-grammar highlighter. That one is still passed,
              // because it is what the fallback editor reads.
              path={file.relativePath || file.path}
              readOnly={!editable}
              onSave={() => void save()}
              ariaLabel={`Contents of ${file.relativePath}`}
              height={bodyHeight}
              initialLine={initialLine}
            />
          )}
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 10,
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-2xs)',
              color: 'var(--muted-foreground)',
            }}
          >
            <span>{file.language ?? 'plain text'}</span>
            <span>{formatBytes(file.size)}</span>
            {editable ? <span>⌘/Ctrl+S to save</span> : null}
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}

/**
 * Rendered markdown, or the source.
 *
 * Two buttons rather than one that toggles, so both states are visible at once
 * and the control says what it will do rather than what it just did — a single
 * button labelled "Code" is unreadable as either "you are in code" or "press
 * for code".
 *
 * The preview renders the *draft*, not the file on disk, so switching back and
 * forth while editing shows the edit. That is the whole reason to have both.
 */
function ViewToggle({
  value,
  onChange,
}: {
  value: ViewMode;
  onChange: (next: ViewMode) => void;
}): React.JSX.Element {
  return (
    <span
      role="group"
      aria-label="How to show this file"
      style={{
        display: 'inline-flex',
        flex: '0 0 auto',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        overflow: 'hidden',
      }}
    >
      {(['preview', 'code'] as const).map((mode) => {
        const active = value === mode;
        return (
          <button
            key={mode}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(mode)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              height: 24,
              padding: '0 8px',
              border: 'none',
              background: active ? 'var(--accent)' : 'transparent',
              color: active ? 'var(--foreground)' : 'var(--muted-foreground)',
              font: 'inherit',
              fontSize: 'var(--text-2xs)',
              cursor: 'pointer',
              transition: 'background var(--duration-fast) var(--ease-standard)',
            }}
          >
            <Icon name={mode === 'preview' ? 'eye' : 'code'} size={11} />
            {mode === 'preview' ? 'Preview' : 'Code'}
          </button>
        );
      })}
    </span>
  );
}

/**
 * A page, rendered as a page.
 *
 * In a sandboxed frame with no `allow-same-origin`, so the document gets an
 * opaque origin: it can run its own scripts and do nothing to this app — no
 * reading the auth cookie, no reaching into the DOM around it, no navigating
 * the tab out from under the user. That is what makes previewing a file
 * somebody else's agent just wrote a reasonable thing to do.
 *
 * `srcdoc` rather than pointing the frame at the file, so the preview shows the
 * *draft* — edit the source, switch back, and it is what you just typed. The
 * cost is that a relative `./style.css` has nothing to resolve against, which
 * is what the injected `<base>` is for: it points at the file's own folder on
 * the asset route, so the page loads its own parts exactly as it would on disk.
 */
function HtmlPreview({
  text,
  baseHref,
  height,
  label,
}: {
  text: string;
  baseHref: string;
  height: React.CSSProperties['height'];
  label: string;
}): React.JSX.Element {
  const doc = React.useMemo(() => withBase(text, baseHref), [text, baseHref]);

  return (
    <iframe
      title={label}
      // No `allow-same-origin`: with it, the two tokens together would hand the
      // page this app's origin back and undo the whole point of the sandbox.
      sandbox="allow-scripts allow-forms allow-popups allow-modals"
      srcDoc={doc}
      style={{
        height,
        width: '100%',
        minHeight: 0,
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        // A page brings its own colours and rarely a background; without this
        // it renders black-on-transparent over the app's dark panel.
        background: '#ffffff',
      }}
    />
  );
}

/**
 * Point a document's relative references at the folder it came from.
 *
 * Inserted after an existing `<head>` when there is one so it precedes the
 * links that need it, and prepended otherwise — a `<base>` only governs what
 * comes after it, and half the HTML in a project has no `<head>` at all.
 * A document that already declares its own base keeps it: that is the author
 * saying where their links point, and this has no business overruling it.
 */
function withBase(html: string, href: string): string {
  if (/<base\b/i.test(html)) return html;
  const tag = `<base href="${href.replace(/"/g, '&quot;')}">`;
  const head = html.match(/<head\b[^>]*>/i);
  if (head) {
    const at = (head.index ?? 0) + head[0].length;
    return html.slice(0, at) + tag + html.slice(at);
  }
  return tag + html;
}

/**
 * The rendered half.
 *
 * Reuses the chat's own markdown renderer, which is what makes a ```mermaid
 * fence in a README come out as a diagram rather than as a code block — the
 * diagram support is already there, and a second renderer would be a second
 * set of answers about what a heading looks like.
 */
function MarkdownPreview({
  text,
  height,
  label,
}: {
  text: string;
  height: React.CSSProperties['height'];
  label: string;
}): React.JSX.Element {
  return (
    <div
      // Focusable so it can be scrolled from the keyboard: a long README with
      // no tab stop is reachable only with a pointer.
      tabIndex={0}
      role="document"
      aria-label={label}
      style={{
        height,
        minHeight: 0,
        overflow: 'auto',
        padding: 'var(--space-4) var(--space-5)',
        background: 'var(--background)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--text-ui)',
        lineHeight: 'var(--leading-normal)',
        color: 'var(--foreground)',
      }}
    >
      {text.trim() ? (
        <Markdown text={text} />
      ) : (
        <span style={{ color: 'var(--muted-foreground)' }}>This file is empty.</span>
      )}
    </div>
  );
}

function Note({
  children,
  tone = 'muted',
  icon,
}: {
  children: React.ReactNode;
  tone?: 'muted' | 'destructive';
  icon?: string;
}): React.JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 7,
        padding: '8px 10px',
        border: `1px solid ${tone === 'destructive' ? 'var(--destructive)' : 'var(--border)'}`,
        borderRadius: 'var(--radius)',
        background: 'var(--card)',
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--text-sm)',
        lineHeight: 'var(--leading-snug)',
        color: tone === 'destructive' ? 'var(--destructive)' : 'var(--muted-foreground)',
      }}
    >
      {icon ? (
        <span style={{ marginTop: 1, flex: '0 0 auto' }}>
          <Icon name={icon} size={13} />
        </span>
      ) : null}
      <span style={{ minWidth: 0, wordBreak: 'break-word' }}>{children}</span>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
