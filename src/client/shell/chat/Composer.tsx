import * as React from 'react';
import {
  ChatAttachment,
  ChatCapabilities,
  ChatUsage,
  ModelChoice,
  QueuedTurn,
  SlashCommand,
} from '../../../shared/chat-events.js';
import { compactCount } from '../../chat/tool-meta.js';
import { mentionAtCaret } from '../../../shared/file-match.js';
import { classifyPaste, MAX_IMAGES_PER_PASTE, PasteCandidate } from '../../../shared/paste-classify.js';
import { MAX_IMAGE_BYTES } from '../../terminal/paste.js';
import { detectMobile } from '../../ui/mobile.js';
import { PHONE_TEXT, PhoneContext, TOUCH_GAP, TOUCH_TARGET, usePhone } from '../../ui/touch.js';
import { showNotification } from '../../ui/notifications.js';
import { Icon } from '../../ui/relay/Icon.js';
import { IconButton } from '../../ui/relay/IconButton.js';
import { Kbd } from '../../ui/relay/Kbd.js';

/**
 * The chat input: a growing textarea plus everything a runtime can opt into —
 * interrupt, slash commands, attachments — each gated on `capabilities` so a
 * runtime that cannot do a thing never grows a control that promises it can.
 *
 * Three things can be picked from here without leaving the keyboard, and all
 * three go through one picker rather than three: slash commands (`/`), files in
 * the working tree (`@`), and files from disk (the paperclip, or a drag, or a
 * paste). Each of the first two also has a button, because a discoverability
 * story that begins "type a character you have not been told about" is not one.
 *
 * Sending is never blocked by the agent being busy. A turn typed while one is
 * running is accepted and queued by the server — see ChatSession — and the
 * chips above the input are the line, oldest first, each one withdrawable until
 * the moment it starts.
 */

export interface ComposerProps {
  onSend: (text: string, attachments: ChatAttachment[]) => void;
  onInterrupt: () => void;
  busy: boolean;
  capabilities: ChatCapabilities;
  disabled?: boolean;
  placeholder?: string;
  onUpload?: (file: File) => Promise<ChatAttachment>;
  /** Controlled draft, so a session switch can restore what was half-typed. */
  draft?: string;
  onDraftChange?: (text: string) => void;
  /** Turns already accepted and waiting their place in line. */
  queued?: QueuedTurn[];
  onCancelQueued?: (id: string) => void;
  /**
   * Rank the working tree against what was typed after `@`.
   *
   * Absent means no file picker at all — the surface has no working directory
   * to search, so offering the affordance would promise a list that never
   * arrives.
   */
  onFindFiles?: (query: string) => Promise<string[]>;
  /**
   * Bump to replace the draft with `seedDraft`.
   *
   * A seed rather than a controlled value: "edit and resend" has to write into
   * the field once, and making the draft controlled would re-render the whole
   * chat surface — turn grouping, activity projection and all — on every
   * keystroke to achieve it.
   */
  seedKey?: number;
  seedDraft?: string;
  /** Shown on the branch chip; the surface reads it from the workspace API. */
  branch?: string;
  /** e.g. "turn 12", for the hint row's right-hand readout. */
  turnLabel?: string;
  /** Session totals, for the same readout. */
  usage?: ChatUsage;
  /**
   * The model this session is actually running.
   *
   * Distinct from `capabilities.models`, which is the menu. Showing the first
   * entry of the menu as the current value is right only by accident.
   */
  model?: string;
  /**
   * Change this conversation's model, independent of the runtime's own
   * default. Always available — see ModelChip — regardless of whether the
   * runtime advertises a model list or a live switch.
   */
  onSetModel?: (model: string) => void;
  /** What the server reported about the last `onSetModel` call, for the chip. */
  modelFeedback?: { applied: 'live' | 'sent' | 'pending' | 'cleared'; message: string } | null;
  /** Drives what the permission chip reports. */
  bypassPermissions?: boolean;
  /** Changes what the hint row says about who owns Return. */
  terminalOpen?: boolean;
}

interface AttachmentEntry {
  key: string;
  file: File;
  status: 'uploading' | 'done' | 'error';
  attachment?: ChatAttachment;
  error?: string;
}

/** One row of the picker, whichever kind is open. */
type PickerRow =
  | { kind: 'command'; key: string; command: SlashCommand }
  | { kind: 'file'; key: string; path: string };

function safeDetectMobile(): boolean {
  // Runs during the initial render (it is a useState initializer), which this
  // component's own test suite exercises with react-dom/server — no window
  // there at all. Same guard MermaidBlock.tsx uses for its theme read.
  try {
    return detectMobile();
  } catch {
    return false;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** DataTransfer -> File[], covering the Safari/Firefox split the same way paste.ts does. */
function filesFromClipboard(data: DataTransfer | null): File[] {
  if (!data) return [];
  if (data.files && data.files.length > 0) return Array.from(data.files);
  const out: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === 'file') {
      const file = item.getAsFile();
      if (file) out.push(file);
    }
  }
  return out;
}

/** How long typing has to pause before the working tree is searched again. */
const FIND_DEBOUNCE_MS = 120;

/**
 * Below this, the toolbar drops its hint line.
 *
 * The composer is not always the width of a window: the workspace rail can take
 * most of the surface, and a phone has none to spare. At 300px the hint
 * truncated to "Send anyway — it …", which is not a shorter sentence, it is a
 * worse one — it occupies the space of advice while giving none.
 */
const HINT_MIN_WIDTH = 380;

export function Composer({
  onSend,
  onInterrupt,
  busy,
  capabilities,
  disabled = false,
  placeholder,
  onUpload,
  draft,
  onDraftChange,
  queued = [],
  onCancelQueued,
  onFindFiles,
  seedKey = 0,
  seedDraft = '',
  branch,
  turnLabel,
  usage,
  model,
  onSetModel,
  modelFeedback,
  bypassPermissions = false,
  terminalOpen = false,
}: ComposerProps) {
  const baseId = React.useId();
  const listboxId = `${baseId}-picker`;
  const optionId = (index: number) => `${baseId}-option-${index}`;

  const shellRef = React.useRef<HTMLDivElement | null>(null);
  const pickerRef = React.useRef<HTMLDivElement | null>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const keySeq = React.useRef(0);
  /** Where to put the caret after a completion rewrites the draft. */
  const pendingCaret = React.useRef<number | null>(null);

  /**
   * The surface's answer wins over this component's own.
   *
   * The composer used to decide "am I on a phone?" by calling `detectMobile()`
   * itself, which made it the app's second source for that answer and put it
   * out of reach of anything that renders the surface deliberately — a check at
   * a phone viewport in headless Chrome has no touch points, so the real
   * composer could never be examined at the size it actually ships at.
   *
   * The local detection stays as the fallback: `Composer` is also rendered on
   * its own, outside any `PhoneContext`, and Enter's two jobs (send versus
   * newline) still have to be decided correctly there.
   */
  const surfaceIsPhone = usePhone();
  const [detectedMobile, setIsMobile] = React.useState(safeDetectMobile);
  const isMobile = surfaceIsPhone || detectedMobile;
  const [uncontrolledText, setUncontrolledText] = React.useState('');
  const [entries, setEntries] = React.useState<AttachmentEntry[]>([]);
  const [dragActive, setDragActive] = React.useState(false);
  const [focused, setFocused] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [dismissed, setDismissed] = React.useState(false);
  const [caret, setCaret] = React.useState(0);
  const [fileMatches, setFileMatches] = React.useState<string[]>([]);
  const [findFailed, setFindFailed] = React.useState(false);
  /**
   * Set by the `/` button, cleared by anything that ends the pick.
   *
   * The `@` button needs no equivalent: it inserts the character, and the
   * ordinary caret rule below opens the picker for it. A slash command has to
   * lead the message, so its button cannot simply type into the middle of a
   * draft — it opens the list and lets the completion do the rewriting.
   */
  const [commandsForced, setCommandsForced] = React.useState(false);

  // A tablet rotated into portrait, or a touch laptop window resized, changes
  // which of Enter's two jobs (send vs newline) is correct — see mobile.ts.
  React.useEffect(() => {
    const onResize = () => {
      try {
        setIsMobile(detectMobile());
      } catch {
        /* stays at its last known value */
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const isControlled = draft !== undefined;
  const text = isControlled ? draft! : uncontrolledText;
  const setText = React.useCallback(
    (next: string) => {
      if (isControlled) onDraftChange?.(next);
      else setUncontrolledText(next);
    },
    [isControlled, onDraftChange],
  );

  // Grows to fit the message, capped in CSS (max-height: 40vh on the element
  // itself) so this never needs to know the viewport's actual pixel size.
  React.useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  // A completion replaced a span in the middle of the draft; the caret belongs
  // after what was inserted, not at the end of everything.
  React.useEffect(() => {
    const at = pendingCaret.current;
    if (at === null) return;
    pendingCaret.current = null;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(at, at);
    setCaret(at);
  }, [text]);

  // "Edit and resend" writes here, once per bump. Guarded on the key rather
  // than on the text so resending the same message twice still lands.
  const lastSeed = React.useRef(seedKey);
  React.useEffect(() => {
    if (seedKey === lastSeed.current) return;
    lastSeed.current = seedKey;
    if (!seedKey) return;
    setText(seedDraft);
    pendingCaret.current = seedDraft.length;
    textareaRef.current?.focus();
  }, [seedKey, seedDraft, setText]);

  const attachmentsEnabled = capabilities.attachments && Boolean(onUpload);
  const commands = capabilities.commands ?? [];
  const filesEnabled = Boolean(onFindFiles) && !disabled;

  // ---------------------------------------------------------------- pickers

  /**
   * The slash-command token, when the draft is one.
   *
   * Still anchored to the start of the message: every runtime here reads a
   * command as the first thing on the line, and completing one in the middle
   * of a sentence would produce text the agent treats as prose.
   */
  const typedCommandQuery =
    commands.length > 0 && text.startsWith('/') && !/\s/.test(text)
      ? text.slice(1).toLowerCase()
      : null;
  const commandQuery =
    typedCommandQuery !== null ? typedCommandQuery : commandsForced && commands.length > 0 ? '' : null;

  const commandMatches = React.useMemo(() => {
    if (commandQuery === null) return [];
    return commands.filter((c) => c.name.toLowerCase().startsWith(commandQuery));
  }, [commandQuery, commands]);

  const mention = React.useMemo(
    () => (filesEnabled ? mentionAtCaret(text, caret) : null),
    [filesEnabled, text, caret],
  );
  const mentionQuery = mention ? mention.query : null;

  // Debounced, and re-checked for liveness on the way back: a picker is typed
  // at, so a slow answer for `@ses` must not overwrite the list for `@session`.
  React.useEffect(() => {
    if (mentionQuery === null || !onFindFiles) {
      setFileMatches([]);
      setFindFailed(false);
      return;
    }

    let live = true;
    const timer = setTimeout(() => {
      onFindFiles(mentionQuery).then(
        (paths) => {
          if (!live) return;
          setFileMatches(paths);
          setFindFailed(false);
        },
        () => {
          if (!live) return;
          setFileMatches([]);
          setFindFailed(true);
        },
      );
    }, FIND_DEBOUNCE_MS);

    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [mentionQuery, onFindFiles]);

  // Commands win a tie. `/` only ever starts a message and `@` never does, so
  // the two cannot both be live except while a draft is being rewritten.
  const rows: PickerRow[] = React.useMemo(() => {
    if (commandQuery !== null) {
      return commandMatches.map((command) => ({
        kind: 'command' as const,
        key: `c:${command.name}`,
        command,
      }));
    }
    if (mentionQuery !== null) {
      return fileMatches.map((path) => ({ kind: 'file' as const, key: `f:${path}`, path }));
    }
    return [];
  }, [commandQuery, commandMatches, mentionQuery, fileMatches]);

  const pickerOpen = !disabled && rows.length > 0 && !dismissed;
  const pickerKind: 'commands' | 'files' | null =
    commandQuery !== null ? 'commands' : mentionQuery !== null ? 'files' : null;
  /**
   * Whether the field is a combobox at all.
   *
   * Answered from what the surface *can* offer, not from what is open right
   * now. A textarea that grows and loses `role="combobox"` as the draft changes
   * is announced as a different control every few keystrokes; the pattern is a
   * combobox throughout, with `aria-expanded` carrying the part that moves.
   */
  const completes = commands.length > 0 || filesEnabled;

  // Re-anchor to the top row whenever the filtered set itself changes —
  // otherwise arrowing to row 4 then deleting back to a 2-row match leaves
  // the "active" index pointing at nothing.
  const rowKey = rows.map((row) => row.key).join(' ');
  React.useEffect(() => {
    setActiveIndex(0);
  }, [rowKey]);

  const readyAttachments = entries.filter((e) => e.status === 'done').map((e) => e.attachment!);
  const hasUploading = entries.some((e) => e.status === 'uploading');
  // Deliberately not gated on `busy`. A turn typed while the agent is working
  // is queued rather than refused, which is the whole point of the chips above.
  const canSend = !disabled && !hasUploading && (text.trim().length > 0 || readyAttachments.length > 0);

  function closePicker() {
    setDismissed(true);
    setCommandsForced(false);
  }

  // A picker that only Escape can dismiss is a picker that follows you around
  // the page. Clicking inside the field itself is exempt: that is someone
  // moving the caret, and where the caret lands is what decides whether the
  // picker should still be open — which the mention rule above already answers.
  React.useEffect(() => {
    if (!pickerOpen) return;
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      if (!target) return;
      if (pickerRef.current?.contains(target)) return;
      if (textareaRef.current && textareaRef.current === target) return;
      closePicker();
    };
    // Capture, so a click on a control underneath still reaches that control
    // and still closes this.
    document.addEventListener('mousedown', onPointerDown, true);
    return () => document.removeEventListener('mousedown', onPointerDown, true);
  });

  function submit() {
    if (!canSend) return;
    onSend(text, readyAttachments);
    setText('');
    setEntries([]);
    setCaret(0);
    setCommandsForced(false);
  }

  function completeCommand(cmd: SlashCommand) {
    // Whatever was already typed survives as the command's arguments. Someone
    // who wrote "explain this function" and then reached for the button meant
    // that text to be part of the command, not to be thrown away by it.
    const rest = text.startsWith('/') ? text.slice(1).replace(/^\S*\s*/, '') : text.trimStart();
    const next = `/${cmd.name} ${rest}`;
    setText(next);
    pendingCaret.current = next.length;
    setCommandsForced(false);
    setDismissed(false);
  }

  function completeMention(path: string) {
    const span = mentionAtCaret(text, caret);
    if (!span) return;
    const inserted = `@${path} `;
    setText(text.slice(0, span.start) + inserted + text.slice(span.end));
    pendingCaret.current = span.start + inserted.length;
    setDismissed(false);
  }

  function completeRow(row: PickerRow) {
    if (row.kind === 'command') completeCommand(row.command);
    else completeMention(row.path);
  }

  function openCommands() {
    setDismissed(false);
    setCommandsForced(true);
    textareaRef.current?.focus();
  }

  /** Type the `@` for the user; the caret rule does the rest. */
  function openFiles() {
    const el = textareaRef.current;
    const at = el ? el.selectionStart : text.length;
    const before = text.slice(0, at);
    // A mention has to begin a word, so give it the space it needs rather than
    // producing `notes@` and a picker that never opens.
    const prefix = before && !/\s$/.test(before) ? ' @' : '@';
    const next = before + prefix + text.slice(at);
    setDismissed(false);
    setCommandsForced(false);
    setText(next);
    pendingCaret.current = before.length + prefix.length;
  }

  // -------------------------------------------------------------- the input

  function syncCaret(target: HTMLTextAreaElement) {
    setCaret(target.selectionStart ?? target.value.length);
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    // Any edit re-arms a picker Escape dismissed — the user is typing again,
    // so their last Escape no longer applies to what is now on screen.
    setDismissed(false);
    setText(e.target.value);
    syncCaret(e.target);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (pickerOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % rows.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + rows.length) % rows.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        completeRow(rows[Math.min(activeIndex, rows.length - 1)]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closePicker();
        return;
      }
    }

    // Touch keyboards have no separate "send" gesture, so Enter has to stay a
    // newline there — the button in the corner is the only way to send.
    if (e.key === 'Enter' && !e.shiftKey && !isMobile) {
      e.preventDefault();
      submit();
    }
  }

  // ------------------------------------------------------------ attachments

  function addFile(file: File) {
    if (!onUpload) return;
    keySeq.current += 1;
    const key = `${file.name}-${file.size}-${keySeq.current}`;
    setEntries((prev) => [...prev, { key, file, status: 'uploading' }]);
    onUpload(file).then(
      (attachment) => {
        setEntries((prev) => prev.map((e) => (e.key === key ? { ...e, status: 'done', attachment } : e)));
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : 'That file could not be attached.';
        setEntries((prev) => prev.map((e) => (e.key === key ? { ...e, status: 'error', error: message } : e)));
      },
    );
  }

  function addFiles(files: File[]) {
    files.forEach(addFile);
  }

  function removeEntry(key: string) {
    setEntries((prev) => prev.filter((e) => e.key !== key));
  }

  function onFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length) addFiles(files);
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (disabled || !onUpload) return;
    const files = filesFromClipboard(e.clipboardData);
    if (files.length === 0) return;

    // Same classifier the terminal's image paste uses: a text-only paste must
    // come out of this exactly as if the handler were not attached at all.
    const candidates: PasteCandidate[] = files.map((f) => ({ kind: 'file', type: f.type, size: f.size }));
    const classification = classifyPaste(candidates, MAX_IMAGE_BYTES);
    if (!classification.handled) return;

    e.preventDefault();
    for (const index of classification.oversize) {
      showNotification(
        `${files[index].name || 'That image'} is ${formatBytes(files[index].size)}, over the `
          + `${formatBytes(MAX_IMAGE_BYTES)} limit.`,
        'error',
      );
    }
    if (classification.overflow > 0) {
      showNotification(
        `Only the first ${MAX_IMAGES_PER_PASTE} images were attached; `
          + `${classification.overflow} more were skipped.`,
        'error',
      );
    }
    addFiles(classification.accepted.map((index) => files[index]));
  }

  function onDragOver(e: React.DragEvent) {
    if (disabled || !attachmentsEnabled || !e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    setDragActive(true);
  }

  function onDragLeave() {
    setDragActive(false);
  }

  function onDrop(e: React.DragEvent) {
    if (disabled || !attachmentsEnabled || !e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    setDragActive(false);
    // A drop is unambiguous — there is no text half to preserve the way a
    // paste has — so every dropped file goes straight to upload.
    addFiles(Array.from(e.dataTransfer.files ?? []));
  }

  // ------------------------------------------------------------------ paint

  /**
   * The lit state.
   *
   * Focus is what it tracks, not hover: the point is to say "your typing lands
   * here", and on a surface with a terminal, a transcript and a file tree on it
   * that is a genuine question. A drag counts too — the whole box is the drop
   * target, and it has to look like one before the file is let go.
   */
  const lit = (focused || dragActive) && !disabled;
  const roomy = useRoomy(shellRef);

  const outerStyle: React.CSSProperties = {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-2)',
    padding: 'var(--space-2-5) var(--space-3) var(--space-2)',
    background: 'var(--card)',
    border: `1px solid ${lit ? 'var(--ring)' : 'var(--border)'}`,
    borderRadius: 'var(--radius)',
    opacity: disabled ? 0.6 : 1,
    // Ring plus halo. The inner ring is what makes the edge read as deliberate
    // at a glance; the blurred outer one is what makes it read as lit rather
    // than merely thicker.
    boxShadow: lit
      ? '0 0 0 1px var(--ring), 0 0 24px -10px var(--ring)'
      : '0 1px 2px rgba(0, 0, 0, 0.22)',
    transition:
      'border-color var(--duration-base) var(--ease-standard),'
      + ' box-shadow var(--duration-base) var(--ease-standard),'
      + ' opacity var(--duration-base) var(--ease-standard)',
  };

  const sendLabel = busy ? 'Queue this message' : 'Send message';

  return (
    // Re-published rather than merely consumed: `isMobile` here is the surface's
    // answer *or* this component's own detection, and every control below —
    // the chips, the model picker, send and stop — has to size itself from the
    // same one. Composer mounted on its own on a real phone would otherwise
    // send with Enter like a phone and draw its buttons like a desktop.
    <PhoneContext.Provider value={isMobile}>
    <div ref={shellRef} style={outerStyle} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <TopEdge lit={lit} busy={busy && !disabled} />

      {pickerOpen ? (
        <Picker
          ref={pickerRef}
          id={listboxId}
          kind={pickerKind === 'files' ? 'files' : 'commands'}
          rows={rows}
          activeIndex={Math.min(activeIndex, rows.length - 1)}
          optionId={optionId}
          onPick={completeRow}
          onHover={setActiveIndex}
        />
      ) : null}

      {dragActive ? <DropVeil /> : null}

      {queued.length > 0 ? (
        <div
          role="list"
          aria-label="Messages waiting to be sent"
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}
        >
          {queued.map((turn, index) => (
            <QueuedChip
              key={turn.id}
              turn={turn}
              position={index + 1}
              onCancel={onCancelQueued ? () => onCancelQueued(turn.id) : undefined}
            />
          ))}
        </div>
      ) : null}

      {entries.length > 0 ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-1-5)' }} aria-label="Attachments">
          {entries.map((entry) => (
            <AttachmentChip key={entry.key} entry={entry} onRemove={() => removeEntry(entry.key)} />
          ))}
        </div>
      ) : null}

      <textarea
        ref={textareaRef}
        value={text}
        onChange={handleChange}
        onKeyDown={onKeyDown}
        // Three ways the caret moves without the text changing, and all three
        // have to be caught or the `@` picker silently declines to open:
        // React's `onSelect` is a polyfill over several native events and does
        // not fire for every caret move, `onClick` covers the pointer, and
        // `onKeyUp` covers the arrow and Home/End keys after the move has
        // actually happened (onKeyDown reports the caret's old position).
        onSelect={(e) => syncCaret(e.currentTarget)}
        onKeyUp={(e) => syncCaret(e.currentTarget)}
        onClick={(e) => syncCaret(e.currentTarget)}
        onFocus={(e) => {
          setFocused(true);
          syncCaret(e.currentTarget);
        }}
        onBlur={() => setFocused(false)}
        onPaste={attachmentsEnabled ? handlePaste : undefined}
        placeholder={placeholder ?? 'Message…'}
        aria-label="Message"
        rows={1}
        disabled={disabled}
        role={completes ? 'combobox' : undefined}
        aria-haspopup={completes ? 'listbox' : undefined}
        aria-expanded={completes ? pickerOpen : undefined}
        aria-controls={completes ? listboxId : undefined}
        aria-autocomplete={completes ? 'list' : undefined}
        aria-activedescendant={pickerOpen ? optionId(Math.min(activeIndex, rows.length - 1)) : undefined}
        style={{
          width: '100%',
          minWidth: 0,
          resize: 'none',
          border: 'none',
          outline: 'none',
          background: 'transparent',
          color: 'var(--foreground)',
          fontFamily: 'var(--font-sans)',
          // `input`, not `body` — the extra pixel is what keeps iOS Safari from
          // zooming the page when the field takes focus. See PHONE_TEXT.
          fontSize: isMobile ? PHONE_TEXT.input : 'var(--text-ui)',
          lineHeight: 'var(--leading-normal)',
          // Room to breathe above and below one line of text, which the old
          // 6px did not give it: the field is the thing everything else on this
          // surface is arranged around.
          padding: 'var(--space-1) 0 var(--space-2)',
          // The autosize effect writes `height` directly from `scrollHeight`,
          // so the floor has to be a `min-height` it cannot undercut: one line
          // of 13px text is a 32px box, which on a phone is a smaller thing to
          // aim at than any button around it.
          minHeight: isMobile ? TOUCH_TARGET : undefined,
          maxHeight: '40vh',
          overflowY: 'auto',
        }}
      />

      {attachmentsEnabled ? (
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={onFileInputChange}
          aria-hidden="true"
          tabIndex={-1}
          style={{ display: 'none' }}
        />
      ) : null}

      {/* Two rows under the field rather than one beside it. At one line the
          field and a row of buttons read as a search box; at twelve the buttons
          floated in the middle of a wall of text with nothing to align to.
          Actions first, then a line of plain text that says what the keys do
          and what the conversation has cost. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          // On a phone the row wraps rather than squeezing: six controls at a
          // size a finger can hit do not fit across 390px, and the alternative
          // — the one that shipped — was six controls that do fit and cannot be
          // hit apart.
          flexWrap: isMobile ? 'wrap' : 'nowrap',
          gap: isMobile ? TOUCH_GAP : 7,
          minWidth: 0,
        }}
      >
        {/* On a phone each of these says what it is. A paperclip is a
            convention and `@` and `/` are the characters they type, but on a
            touch screen there is no hover to confirm any of that — the only way
            to find out what a bare glyph does is to press it and see. */}
        {attachmentsEnabled ? (
          <ChipButton
            label="Attach a file or image"
            text="Attach"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
          >
            <Icon name="paperclip" size={isMobile ? 16 : 12} />
          </ChipButton>
        ) : null}

        {filesEnabled ? (
          <ChipButton label="Reference a file from this project" text="File" onClick={openFiles}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: isMobile ? 15 : 12 }}>@</span>
          </ChipButton>
        ) : null}

        {commands.length > 0 ? (
          <ChipButton
            label="Slash commands and skills"
            text="Command"
            aria-expanded={pickerOpen && pickerKind === 'commands'}
            onClick={openCommands}
            disabled={disabled}
          >
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: isMobile ? 15 : 12 }}>/</span>
          </ChipButton>
        ) : null}

        {/* `display: contents` on a phone: the right-hand group stops being a
            group at all and its controls join the row above, so they wrap into
            whatever space is left instead of starting a line of their own —
            which is what left Send sitting alone on a line by itself. */}
        <span
          style={
            isMobile
              ? { display: 'contents' }
              : {
                  marginLeft: 'auto',
                  display: 'flex',
                  alignItems: 'center',
                  flexWrap: 'nowrap',
                  gap: 7,
                  minWidth: 0,
                }
          }
        >
          {branch && roomy ? (
            <Chip
              label={`On branch ${branch}`}
              reason="Switch branches from the terminal or the Changes panel — a checkout under a running agent is not something this control can undo."
              icon="git-branch"
            >
              {branch}
            </Chip>
          ) : null}

          <ModelChip
            current={model}
            models={capabilities.models}
            feedback={modelFeedback}
            onPick={(value) => onSetModel?.(value)}
          />

          <PermissionChip bypassPermissions={bypassPermissions} />

          {busy && !disabled ? (
            <StopButton onClick={onInterrupt} enabled={capabilities.interrupt} />
          ) : null}

          <SendButton label={sendLabel} enabled={canSend} queueing={busy} onClick={submit} />
        </span>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: isMobile ? 'wrap' : 'nowrap',
          gap: 10,
          minWidth: 0,
          fontFamily: 'var(--font-mono)',
          // The right-hand half of this row is the turn number, the token count
          // and the cost — live session figures, so on a phone they are set at
          // the body size like every other one.
          fontSize: isMobile ? PHONE_TEXT.label : 'var(--text-2xs)',
          color: 'var(--muted-foreground)',
        }}
      >
        <span
          style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {/* Dropped on a phone. At the phone type size the sentence does not
              fit the row and truncates to half of itself, and what it was
              telling you — that `@` picks a file and `/` picks a command — is
              now written on the two buttons above it. */}
          {roomy && !isMobile
            ? hintFor({ isMobile, busy, findFailed, filesEnabled, terminalOpen })
            : null}
        </span>
        <span style={{ marginLeft: 'auto', flex: '0 0 auto', whiteSpace: 'nowrap' }}>
          {sessionReadout(turnLabel, usage)}
        </span>
      </div>
    </div>
    </PhoneContext.Provider>
  );
}

/**
 * The lit edge, and the working edge.
 *
 * One element doing two jobs on purpose: they are the same 1px strip, they
 * never both apply (a session cannot be idle and working at once, and the
 * sweep already carries a colour of its own), and splitting them meant two
 * absolutely-positioned overlays whose z-order had to be kept in step.
 */
function TopEdge({ lit, busy }: { lit: boolean; busy: boolean }): React.JSX.Element {
  const base: React.CSSProperties = {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: 1,
    pointerEvents: 'none',
  };

  if (busy) {
    return (
      <span
        aria-hidden="true"
        style={{
          ...base,
          backgroundImage: 'linear-gradient(90deg, transparent, var(--ring), transparent)',
          backgroundSize: '45% 100%',
          backgroundRepeat: 'no-repeat',
          animation: 'relay-composer-sweep 1.8s var(--ease-in-out) infinite',
        }}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      style={{
        ...base,
        background: 'var(--ring)',
        transform: lit ? 'scaleX(1)' : 'scaleX(0)',
        transformOrigin: 'center',
        transition: 'transform var(--duration-base) var(--ease-out)',
      }}
    />
  );
}

/** What the whole box turns into while a file is over it. */
function DropVeil(): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        // Opaque first, then the translucent version. An engine without
        // `color-mix` drops the second declaration and keeps the first, which
        // is a solid veil rather than an invisible one.
        backgroundColor: 'var(--card)',
        // Not fully opaque: the field stays legible underneath, so the box
        // still reads as the composer rather than as a modal that appeared.
        background: 'color-mix(in srgb, var(--card) 88%, transparent)',
        color: 'var(--foreground)',
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--text-sm)',
        pointerEvents: 'none',
        animation: 'relay-fade-in var(--duration-fast) var(--ease-out)',
        zIndex: 2,
      }}
    >
      <Icon name="paperclip" size={13} />
      Drop to attach
    </div>
  );
}

function hintFor({
  isMobile,
  busy,
  findFailed,
  filesEnabled,
  terminalOpen,
}: {
  isMobile: boolean;
  busy: boolean;
  findFailed: boolean;
  filesEnabled: boolean;
  terminalOpen: boolean;
}): React.ReactNode {
  if (findFailed) return 'Could not search this project’s files.';
  if (busy) return 'Send anyway — it will go as soon as this turn finishes.';
  if (isMobile) return filesEnabled ? '@ for a file, / for a command' : 'Tap send when you are ready';
  return (
    <>
      <Kbd>Return</Kbd> sends · <Kbd>Shift</Kbd>+<Kbd>Return</Kbd> newline
      {filesEnabled ? ' · @ file · / command · drop files anywhere' : null}
      {/* With a shell on screen, "Return sends" is ambiguous until you know
          which surface is listening. */}
      {terminalOpen ? ' · the terminal takes Return while it has focus' : null}
    </>
  );
}

/** `turn 12 · 349k tok · $0.4133`, with nothing invented for what is missing. */
function sessionReadout(turnLabel: string | undefined, usage: ChatUsage | undefined): string {
  const bits: string[] = [];
  if (turnLabel) bits.push(turnLabel);
  if (usage) {
    const total = usage.totalTokens
      ?? [usage.inputTokens, usage.outputTokens].reduce<number | undefined>(
        (sum, value) => (value === undefined ? sum : (sum ?? 0) + value),
        undefined,
      );
    if (total !== undefined) bits.push(`${compactCount(total)} tok`);
    if (usage.costUsd !== undefined) bits.push(`$${usage.costUsd.toFixed(4)}`);
  }
  return bits.join(' · ');
}

/**
 * A control on the composer's action row: a 26px square, or a labelled target
 * on a phone.
 *
 * `text` is drawn only on a phone. On the desktop row the glyph plus a hover
 * tooltip is enough and three labelled chips would crowd out the field; on a
 * phone there is no hover, so the label is the only thing that answers "what
 * does this do" without pressing it.
 */
function ChipButton({
  label,
  text,
  onClick,
  disabled,
  children,
  ...rest
}: {
  label: string;
  text?: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  const [hover, setHover] = React.useState(false);
  const isPhone = usePhone();
  const labelled = isPhone && Boolean(text);
  const side = isPhone ? TOUCH_TARGET : 26;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: '0 0 auto',
        gap: labelled ? 6 : 0,
        width: labelled ? undefined : side,
        minWidth: side,
        height: side,
        padding: labelled ? '0 12px' : 0,
        fontFamily: 'var(--font-sans)',
        fontSize: labelled ? PHONE_TEXT.body : undefined,
        background: hover && !disabled ? 'var(--accent)' : 'transparent',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        color: hover && !disabled ? 'var(--foreground)' : 'var(--muted-foreground)',
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'background var(--duration-fast), color var(--duration-fast)',
      }}
      {...rest}
    >
      {children}
      {labelled ? <span>{text}</span> : null}
    </button>
  );
}

/**
 * A readout the runtime does not let this surface change.
 *
 * Rendered and disabled rather than hidden: the value is worth knowing, and a
 * control that vanishes reads as a bug while one that says why reads as a
 * property of the runtime — which is what it is.
 */
function Chip({
  label,
  reason,
  icon,
  tone,
  children,
}: {
  label: string;
  reason: string;
  icon?: string;
  tone?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const isPhone = usePhone();
  return (
    <button
      type="button"
      disabled
      aria-label={label}
      title={`${label}. ${reason}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        flex: '0 1 auto',
        minWidth: 0,
        height: isPhone ? TOUCH_TARGET : 26,
        padding: isPhone ? '0 10px' : '0 8px',
        whiteSpace: 'nowrap',
        background: 'transparent',
        border: `1px solid ${tone ? `color-mix(in oklab, ${tone} 38%, transparent)` : 'var(--border)'}`,
        borderRadius: 'var(--radius)',
        fontFamily: 'var(--font-mono)',
        fontSize: isPhone ? PHONE_TEXT.label : 'var(--text-2xs)',
        color: tone || 'var(--muted-foreground)',
        cursor: 'default',
      }}
    >
      {icon ? <Icon name={icon} size={10} /> : null}
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{children}</span>
    </button>
  );
}

/**
 * The model, and the one always-honest way to change it.
 *
 * There is no protocol message every runtime answers to for "switch model" —
 * some can rewrite it live, most only take it through their own `/model`
 * command or at spawn — so this control never claims to know in advance which
 * of those a pick will get. It always accepts a choice, from the list when the
 * runtime has one and from free text regardless, sends it, and reports back
 * whatever the server says actually happened. A disabled control that told the
 * user to start a new session was a worse answer than trying and being honest
 * about the result.
 */
function ModelChip({
  current,
  models,
  onPick,
  feedback,
}: {
  /** What the session reported it is running, when it reported anything. */
  current: string | undefined;
  models: ModelChoice[] | undefined;
  onPick: (value: string) => void;
  /** What the server said happened to the last pick made here. */
  feedback?: { applied: 'live' | 'sent' | 'pending' | 'cleared'; message: string } | null;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [customValue, setCustomValue] = React.useState('');
  const ref = React.useRef<HTMLDivElement | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const isPhone = usePhone();
  // The session's own model wins. `models` is a menu in whatever order the
  // runtime listed it, and its first entry is the current one only by accident.
  const matched = models?.find((m) => m.value === current || m.name === current);
  const label = matched?.name ?? current ?? 'model';

  React.useEffect(() => {
    if (!open) return;
    setCustomValue('');
    inputRef.current?.focus();
    const onPointerDown = (event: MouseEvent): void => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (value: string): void => {
    setOpen(false);
    onPick(value);
  };

  const submitCustom = (): void => {
    const value = customValue.trim();
    if (!value) return;
    pick(value);
  };

  return (
    <div
      ref={ref}
      style={{
        // Static on a phone so the list below resolves against the composer
        // rather than this chip: anchored to a chip sitting near the right
        // edge of a 390px screen, a 200px-wide list hangs off it.
        position: isPhone ? 'static' : 'relative',
        flex: '0 0 auto',
      }}
    >
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Change model"
        title={feedback?.message || `Model: ${label}`}
        onClick={() => setOpen((value) => !value)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          height: isPhone ? TOUCH_TARGET : 26,
          padding: isPhone ? '0 10px' : '0 8px',
          whiteSpace: 'nowrap',
          background: open ? 'var(--accent)' : 'transparent',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          fontFamily: 'var(--font-mono)',
          fontSize: isPhone ? PHONE_TEXT.label : 'var(--text-2xs)',
          color: 'var(--muted-foreground)',
          cursor: 'pointer',
        }}
      >
        {label}
        <Icon name="chevron-down" size={9} />
      </button>
      {open ? (
        <div
          role="listbox"
          aria-label="Models"
          style={{
            position: 'absolute',
            // On a phone this resolves against the composer (see above), so
            // pinning both edges gives the list the composer's own width.
            right: 0,
            left: isPhone ? 0 : undefined,
            bottom: '100%',
            marginBottom: 6,
            minWidth: isPhone ? 0 : 200,
            maxHeight: isPhone ? '50vh' : 260,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
            padding: 'var(--space-1)',
            background: 'var(--popover)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            boxShadow: 'var(--shadow-popover)',
            zIndex: 'var(--z-dropdown)' as unknown as number,
          }}
        >
          <div style={{ display: 'flex', gap: isPhone ? TOUCH_GAP : 4, padding: '2px 2px 6px' }}>
            <input
              ref={inputRef}
              value={customValue}
              onChange={(event) => setCustomValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  submitCustom();
                }
              }}
              placeholder="Type any model name…"
              aria-label="Custom model name"
              style={{
                flex: 1,
                minWidth: 0,
                height: isPhone ? TOUCH_TARGET : 24,
                padding: isPhone ? '0 10px' : '0 6px',
                background: 'var(--background)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius)',
                color: 'var(--foreground)',
                font: 'inherit',
                // `input`, not `body`: see PHONE_TEXT — anything smaller and
                // iOS Safari zooms the page the moment this takes focus.
                fontSize: isPhone ? PHONE_TEXT.input : 'var(--text-xs)',
              }}
            />
            <button
              type="button"
              onClick={submitCustom}
              disabled={!customValue.trim()}
              aria-label="Use this model"
              style={{
                flex: '0 0 auto',
                height: isPhone ? TOUCH_TARGET : 24,
                padding: isPhone ? '0 14px' : '0 8px',
                background: 'transparent',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius)',
                color: 'var(--foreground)',
                fontSize: isPhone ? PHONE_TEXT.body : 'var(--text-2xs)',
                cursor: customValue.trim() ? 'pointer' : 'not-allowed',
                opacity: customValue.trim() ? 1 : 0.5,
              }}
            >
              Use
            </button>
          </div>

          {(models ?? []).map((choice) => (
            <button
              key={choice.value}
              type="button"
              role="option"
              aria-selected={choice.value === current || choice.name === current}
              onClick={() => pick(choice.value)}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                width: '100%',
                minHeight: isPhone ? TOUCH_TARGET : undefined,
                padding: isPhone ? '8px 12px' : '5px 8px',
                background: 'transparent',
                border: 0,
                borderRadius: 'var(--radius)',
                color: 'var(--foreground)',
                font: 'inherit',
                fontSize: isPhone ? PHONE_TEXT.body : 'var(--text-xs)',
                textAlign: 'left',
                cursor: 'pointer',
              }}
            >
              <span style={{ fontFamily: 'var(--font-mono)' }}>{choice.name}</span>
              {choice.description ? (
                <span style={{ color: 'var(--muted-foreground)' }}>{choice.description}</span>
              ) : null}
            </button>
          ))}

          {!models?.length ? (
            <div
              style={{
                padding: '4px 8px 2px',
                color: 'var(--muted-foreground)',
                fontSize: isPhone ? PHONE_TEXT.body : 'var(--text-2xs)',
              }}
            >
              This runtime hasn&apos;t listed models — type one above.
            </div>
          ) : null}

          {/* The way back. Picking a model is one click; without this, undoing
              that choice was impossible — the text field refuses to submit
              empty and every entry above carries a name — so a conversation
              could be moved off its profile default but never returned to it,
              and a typo stayed in force for every later launch. */}
          <button
            type="button"
            role="option"
            aria-selected={false}
            onClick={() => pick('')}
            style={{
              width: '100%',
              marginTop: 2,
              minHeight: isPhone ? TOUCH_TARGET : undefined,
              padding: isPhone ? '8px 12px' : '5px 8px',
              background: 'transparent',
              border: 0,
              borderTop: '1px solid var(--border)',
              borderRadius: 0,
              color: 'var(--muted-foreground)',
              font: 'inherit',
              fontSize: isPhone ? PHONE_TEXT.body : 'var(--text-xs)',
              textAlign: 'left',
              cursor: 'pointer',
            }}
          >
            Use the default for this runtime
          </button>
        </div>
      ) : null}

      {!open && feedback ? (
        <div
          role="status"
          style={{
            position: 'absolute',
            right: 0,
            top: '100%',
            marginTop: 4,
            maxWidth: 240,
            padding: '4px 6px',
            background: 'var(--popover)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            color:
              feedback.applied === 'live'
                ? 'var(--foreground)'
                : 'var(--muted-foreground)',
            fontSize: isPhone ? PHONE_TEXT.body : 'var(--text-2xs)',
            zIndex: 'var(--z-dropdown)' as unknown as number,
          }}
        >
          {feedback.message}
        </div>
      ) : null}
    </div>
  );
}

/**
 * What the agent is allowed to do without asking.
 *
 * Read-only on purpose. Approvals are a launch decision — the flag lives on the
 * server's session record and there is no message that changes it underneath a
 * running process — so this reports the truth and says where the choice is
 * made. A picker here that silently did nothing would be the worst of the three
 * options available.
 */
function PermissionChip({ bypassPermissions }: { bypassPermissions: boolean }): React.JSX.Element {
  return (
    <Chip
      label={bypassPermissions ? 'Approvals bypassed' : 'Approvals asked for'}
      reason="Set when the session is launched; start a new session to change it."
      icon="shield"
      tone={bypassPermissions ? 'var(--destructive)' : undefined}
    >
      {bypassPermissions ? 'bypass' : 'ask first'}
    </Chip>
  );
}

/**
 * Send.
 *
 * Filled rather than ghost, and the only filled control on the surface: on a
 * screen of outlines and muted text there is exactly one thing you press to
 * make something happen, and it should not take a second to find.
 */
function SendButton({
  label,
  enabled,
  queueing,
  onClick,
}: {
  label: string;
  enabled: boolean;
  queueing: boolean;
  onClick: () => void;
}): React.JSX.Element {
  const [hover, setHover] = React.useState(false);
  const [pressed, setPressed] = React.useState(false);
  const isPhone = usePhone();

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={!enabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        setPressed(false);
      }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: '0 0 auto',
        gap: isPhone ? 6 : 0,
        width: isPhone ? undefined : 34,
        minWidth: TOUCH_TARGET,
        height: isPhone ? TOUCH_TARGET : 30,
        padding: isPhone ? '0 14px' : 0,
        fontFamily: 'var(--font-sans)',
        fontSize: isPhone ? PHONE_TEXT.body : undefined,
        borderRadius: 'var(--radius)',
        border: '1px solid transparent',
        background: enabled ? 'var(--primary)' : 'var(--muted)',
        color: enabled ? 'var(--primary-foreground)' : 'var(--muted-foreground)',
        cursor: enabled ? 'pointer' : 'not-allowed',
        opacity: enabled ? 1 : 0.7,
        // Press first: a held button that is also hovered should read as
        // pressed, which is the state the pointer is actually in.
        transform: pressed && enabled ? 'scale(0.94)' : hover && enabled ? 'translateY(-1px)' : 'none',
        transition:
          'transform var(--duration-fast) var(--ease-out),'
          + ' background var(--duration-fast) var(--ease-standard),'
          + ' color var(--duration-fast) var(--ease-standard),'
          + ' opacity var(--duration-fast) var(--ease-standard)',
      }}
    >
      <Icon name={queueing ? 'corner-down-left' : 'arrow-up'} size={isPhone ? 18 : 14} />
      {isPhone ? <span>{queueing ? 'Queue' : 'Send'}</span> : null}
    </button>
  );
}

/**
 * Stop.
 *
 * Disabled rather than hidden when the runtime has no interrupt channel: a
 * control that vanished would read as a bug, not as "this runtime just doesn't
 * support it". The label is also the tooltip.
 */
function StopButton({ onClick, enabled }: { onClick: () => void; enabled: boolean }): React.JSX.Element {
  const label = enabled ? 'Stop' : 'This runtime cannot be interrupted';
  const isPhone = usePhone();
  const tone = enabled ? { color: 'var(--destructive)', borderColor: 'var(--destructive)' } : undefined;
  return (
    <IconButton
      type="button"
      size="md"
      variant="outline"
      label={label}
      disabled={!enabled}
      onClick={enabled ? onClick : undefined}
      style={
        isPhone
          ? {
              ...tone,
              width: undefined,
              minWidth: TOUCH_TARGET,
              height: TOUCH_TARGET,
              gap: 6,
              padding: '0 12px',
              fontFamily: 'var(--font-sans)',
              fontSize: PHONE_TEXT.body,
            }
          : tone
      }
    >
      <Icon name="square" size={isPhone ? 15 : 11} />
      {/* A bare square is not "stop" to anybody who has not been told. */}
      {isPhone ? <span>Stop</span> : null}
    </IconButton>
  );
}

/** Commands and files, in one list. */
const Picker = React.forwardRef<HTMLDivElement, {
  id: string;
  kind: 'commands' | 'files';
  rows: PickerRow[];
  activeIndex: number;
  optionId: (index: number) => string;
  onPick: (row: PickerRow) => void;
  onHover: (index: number) => void;
}>(function Picker({ id, kind, rows, activeIndex, optionId, onPick, onHover }, ref): React.JSX.Element {
  const listRef = React.useRef<HTMLDivElement | null>(null);

  // Arrowing past the fold has to bring the list with it. Without this the
  // highlight walked off the bottom of a scrollable popup and kept going,
  // leaving nothing selected-looking on screen and no way to see where you were.
  React.useEffect(() => {
    const list = listRef.current;
    const active = list?.children[activeIndex] as HTMLElement | undefined;
    if (!active) return;
    // `nearest` rather than `center`: it moves only when the row is actually
    // out of view, so stepping through visible rows does not jerk the list.
    active.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, rows.length]);

  return (
    <div
      ref={(node) => {
        listRef.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) ref.current = node;
      }}
      id={id}
      role="listbox"
      aria-label={kind === 'files' ? 'Files in this project' : 'Slash commands'}
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: '100%',
        marginBottom: 6,
        maxHeight: 260,
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        padding: 'var(--space-1)',
        background: 'var(--popover)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        boxShadow: 'var(--shadow-popover)',
        animation: 'relay-scale-in var(--duration-fast) var(--ease-out)',
        zIndex: 'var(--z-dropdown)' as unknown as number,
      }}
    >
      {rows.map((row, i) => (
        <PickerRowView
          key={row.key}
          row={row}
          id={optionId(i)}
          active={i === activeIndex}
          onPick={() => onPick(row)}
          onHover={() => onHover(i)}
        />
      ))}
    </div>
  );
});

function PickerRowView({
  row,
  id,
  active,
  onPick,
  onHover,
}: {
  row: PickerRow;
  id: string;
  active: boolean;
  onPick: () => void;
  /** The pointer moving over a row selects it, the way every menu behaves. */
  onHover: () => void;
}): React.JSX.Element {
  const style: React.CSSProperties = {
    display: 'flex',
    alignItems: 'baseline',
    gap: 8,
    width: '100%',
    padding: '6px 8px',
    background: active ? 'var(--accent)' : 'transparent',
    border: 'none',
    borderRadius: 'var(--radius)',
    color: 'var(--foreground)',
    fontFamily: 'var(--font-sans)',
    fontSize: 'var(--text-sm)',
    textAlign: 'left',
    cursor: 'pointer',
    transition: 'background var(--duration-instant) var(--ease-standard)',
  };

  // mousedown, not click: click fires after the textarea has already blurred,
  // which would drop the picker before this runs.
  const press = (e: React.MouseEvent) => {
    e.preventDefault();
    onPick();
  };

  if (row.kind === 'command') {
    const { command } = row;
    return (
      <button
        id={id}
        type="button"
        role="option"
        aria-selected={active}
        tabIndex={-1}
        onMouseDown={press}
        onMouseMove={onHover}
        style={style}
      >
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontWeight: 'var(--font-semibold)' as React.CSSProperties['fontWeight'],
          }}
        >
          /{command.name}
        </span>
        {command.hint ? (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--muted-foreground)' }}>
            {command.hint}
          </span>
        ) : null}
        {command.description ? <Trailing>{command.description}</Trailing> : null}
      </button>
    );
  }

  const cut = row.path.lastIndexOf('/');
  const name = cut >= 0 ? row.path.slice(cut + 1) : row.path;
  const dir = cut >= 0 ? row.path.slice(0, cut) : '';
  return (
    <button
      id={id}
      type="button"
      role="option"
      aria-selected={active}
      tabIndex={-1}
      onMouseDown={press}
      onMouseMove={onHover}
      title={row.path}
      style={style}
    >
      <span style={{ flex: '0 0 auto', color: 'var(--muted-foreground)' }}>
        <Icon name="file-text" size={11} />
      </span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', whiteSpace: 'nowrap' }}>{name}</span>
      {dir ? <Trailing mono>{dir}</Trailing> : null}
    </button>
  );
}

/** The dimmed, truncating right-hand half of a picker row. */
function Trailing({ children, mono }: { children: React.ReactNode; mono?: boolean }): React.JSX.Element {
  return (
    <span
      style={{
        flex: 1,
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        // Right-aligned so a long directory truncates on its left, where the
        // repeated `src/…` prefixes are, rather than losing the leaf.
        direction: mono ? 'rtl' : undefined,
        textAlign: mono ? 'left' : undefined,
        fontFamily: mono ? 'var(--font-mono)' : undefined,
        color: 'var(--muted-foreground)',
        fontSize: 'var(--text-xs)',
      }}
    >
      {children}
    </span>
  );
}

/**
 * One turn waiting in line.
 *
 * A full-width row rather than a pill: the point is to be able to read what you
 * queued and decide whether you still want it, and a 220px chip with an
 * ellipsis after four words cannot answer that.
 */
function QueuedChip({
  turn,
  position,
  onCancel,
}: {
  turn: QueuedTurn;
  position: number;
  onCancel?: () => void;
}): React.JSX.Element {
  const attachments = turn.attachments?.length ?? 0;
  return (
    <div
      role="listitem"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        minHeight: 26,
        padding: '2px 4px 2px 7px',
        background: 'var(--muted)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        color: 'var(--muted-foreground)',
        fontSize: 'var(--text-2xs)',
        animation: 'relay-chip-in var(--duration-base) var(--ease-out)',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          flex: '0 0 auto',
          fontFamily: 'var(--font-mono)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {position}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          color: 'var(--foreground)',
        }}
        title={turn.text}
      >
        {turn.text || '(attachments only)'}
      </span>
      {attachments > 0 ? (
        <span style={{ flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
          <Icon name="paperclip" size={10} />
          {attachments}
        </span>
      ) : null}
      {onCancel ? (
        <IconButton type="button" size="sm" label={`Remove queued message ${position}`} onClick={onCancel}>
          <Icon name="x" size={11} />
        </IconButton>
      ) : null}
    </div>
  );
}

function AttachmentChip({ entry, onRemove }: { entry: AttachmentEntry; onRemove: () => void }) {
  const failed = entry.status === 'error';
  const isImage = entry.file.type.startsWith('image/');
  const preview = useObjectUrl(isImage && !failed ? entry.file : null);
  const icon = failed ? 'circle-alert' : isImage ? 'image' : 'file-text';

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 26,
        maxWidth: 240,
        padding: preview ? '0 6px 0 0' : '0 6px 0 8px',
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--text-2xs)',
        color: failed ? 'var(--destructive)' : 'var(--foreground)',
        background: 'var(--muted)',
        border: `1px solid ${failed ? 'var(--destructive)' : 'var(--border)'}`,
        borderRadius: 'var(--radius)',
        opacity: entry.status === 'uploading' ? 0.75 : 1,
        animation: 'relay-chip-in var(--duration-base) var(--ease-out)',
        transition: 'opacity var(--duration-base) var(--ease-standard)',
      }}
      title={failed ? entry.error : `${entry.file.name} (${formatBytes(entry.file.size)})`}
    >
      {preview ? (
        // The picture itself, not an icon standing in for one. Attaching a
        // screenshot and being shown a grey rectangle labelled "image" is a
        // worse answer than the one the browser can give for free.
        <img
          src={preview}
          alt=""
          style={{ width: 24, height: 24, objectFit: 'cover', flex: '0 0 auto', display: 'block' }}
        />
      ) : (
        <span
          style={{
            display: 'inline-flex',
            flex: '0 0 auto',
            animation: entry.status === 'uploading' ? 'relay-pulse 1.2s var(--ease-in-out) infinite' : undefined,
          }}
        >
          <Icon name={icon} size={11} />
        </span>
      )}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.file.name}</span>
      <span style={{ flex: '0 0 auto', color: 'var(--muted-foreground)' }}>{formatBytes(entry.file.size)}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${entry.file.name}`}
        style={{
          display: 'inline-flex',
          flex: '0 0 auto',
          alignItems: 'center',
          justifyContent: 'center',
          width: 16,
          height: 16,
          padding: 0,
          background: 'transparent',
          border: 'none',
          color: 'inherit',
          cursor: 'pointer',
        }}
      >
        <Icon name="x" size={10} />
      </button>
    </span>
  );
}

/**
 * Whether there is room for the hint line.
 *
 * Measured rather than guessed from `isMobile`: the composer is narrow when the
 * workspace rail is dragged wide, on a desktop, at any window size — and it is
 * comfortably wide on a tablet in landscape. The question is about this box,
 * not about the device.
 *
 * Defaults to true so it renders on the server and on the first paint, then
 * corrects itself. The other way round the hint flashes in, which is worse than
 * a hint that occasionally flashes out.
 */
function useRoomy(ref: React.RefObject<HTMLElement | null>): boolean {
  const [roomy, setRoomy] = React.useState(true);

  React.useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;

    const measure = (): void => setRoomy(element.getBoundingClientRect().width >= HINT_MIN_WIDTH);
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return roomy;
}

/**
 * A blob URL for a File, revoked when it is replaced or the chip goes away.
 *
 * In an effect rather than during render: `createObjectURL` allocates until
 * something revokes it, and a render that runs twice — or on the server, where
 * the API does not exist at all — would leak one or throw.
 */
function useObjectUrl(file: File | null): string | null {
  const [url, setUrl] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!file || typeof URL === 'undefined' || !URL.createObjectURL) {
      setUrl(null);
      return;
    }
    const created = URL.createObjectURL(file);
    setUrl(created);
    return () => {
      setUrl(null);
      URL.revokeObjectURL(created);
    };
  }, [file]);

  return url;
}
