import * as React from 'react';
import {
  ChatAttachment,
  ChatCapabilities,
  ChatModelDefault,
  ChatModelOrigin,
  ChatUsage,
  EffortChoice,
  ModelChoice,
  QueuedTurn,
  SlashCommand,
} from '../../../shared/chat-events.js';
import { compactCount } from '../../chat/tool-meta.js';
import { MAX_ATTACHMENT_BYTES, safeAttachmentDownloadUrl } from '../../chat/attachments-api.js';
import { mentionAtCaret } from '../../../shared/file-match.js';
import { tokenTotal } from '../../../shared/usage-records.js';
import {
  classifyPaste,
  MAX_IMAGES_PER_PASTE,
  PasteCandidate,
  PasteClassification,
} from '../../../shared/paste-classify.js';
import { detectMobile } from '../../ui/mobile.js';
import { PHONE_TEXT, PhoneContext, TOUCH_GAP, TOUCH_TARGET, usePhone } from '../../ui/touch.js';
import { showNotification } from '../../ui/notifications.js';
import { Icon } from '../../ui/relay/Icon.js';
import { Button } from '../../ui/relay/Button.js';
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
  onUpload?: (file: File, signal?: AbortSignal) => Promise<ChatAttachment>;
  /** Controlled draft, so a session switch can restore what was half-typed. */
  draft?: string;
  onDraftChange?: (text: string) => void;
  /**
   * The files already attached to the unsent message, controlled.
   *
   * Only the ones that finished uploading. A file still going up is this
   * component's own business — there is no attachment yet, only a `File` and a
   * spinner — and it becomes everyone's the moment the server answers with a
   * url. That split is what lets the same list be the conversation's rather than
   * this browser's: a laptop can be uploading a screenshot while the phone shows
   * the two that already landed (#163).
   *
   * Absent leaves the list where it used to be: local state, cleared when the
   * message is sent, seen by nothing else.
   */
  attachments?: ChatAttachment[];
  onAttachmentsChange?: (next: ChatAttachment[]) => void;
  /** Turns already accepted and waiting their place in line. */
  queued?: QueuedTurn[];
  onCancelQueued?: (id: string) => void;
  /** Try a queued turn that could not be handed over again (#89). */
  onRetryQueued?: (id: string) => void;
  /**
   * Deliver one waiting turn now, ahead of the turn in flight.
   *
   * Absent when there is nothing to interrupt — a session that has ended, or an
   * agent already working through the line — so the row does not offer a
   * control that would do nothing to press.
   */
  onSendQueuedNow?: (id: string) => void;
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
   * Every model the last turn was billed to, when it was more than one.
   *
   * A subagent on another model, or a fallback after a failure. The chip shows
   * the count rather than the names — one line cannot hold three model ids —
   * and the full list is on the hover title, where it is a record rather than
   * a guess at which one mattered.
   */
  alsoRan?: string[];
  /**
   * Change this conversation's model, independent of the runtime's own
   * default. Always available — see ModelChip — regardless of whether the
   * runtime advertises a model list or a live switch.
   */
  onSetModel?: (model: string) => void;
  /** What the server reported about the last `onSetModel` call, for the chip. */
  modelFeedback?: { applied: 'live' | 'sent' | 'pending' | 'cleared'; message: string } | null;
  /**
   * Which model a *new* conversation on this runtime would open on, and why.
   *
   * Separate from `model` above, which is what this conversation is running.
   * The picker shows both because they answer different questions, and the
   * second one had no answer at all before #135: a model pinned by a runtime
   * profile was in force and invisible, and a model the user had picked in the
   * last chat was neither.
   */
  modelDefault?: ChatModelDefault | null;
  /**
   * This conversation's own model choice, when it has one.
   *
   * Passed apart from `model` because that one cannot tell the two apart — it
   * is the override *or* whatever the runtime last reported — and the picker
   * has to, or it would describe a model the runtime happened to name as
   * something the user chose.
   */
  modelOverride?: string | null;
  /**
   * The model this conversation was launched on, when the server says.
   *
   * The third of three, and none of them is a substitute for another: `model`
   * is the override or whatever the runtime last reported, `modelDefault` is
   * what a *new* conversation would open on, and this is what the process
   * actually started with. Claude reports no model at all, so on that runtime
   * this is the only truthful answer the chip has (#135).
   */
  modelPinned?: string | null;
  /**
   * Where the model in force came from — the ladder and its rung, the profile,
   * the account's standing choice, or the runtime's own default.
   *
   * The fourth, and the only one that answers *why*. The three above each name
   * a model; this names the thing that chose it, which is what a person with a
   * ladder configured needs in order to tell a ladder that is working from one
   * something else has quietly overridden (#171).
   */
  modelOrigin?: ChatModelOrigin | null;
  /** Why this conversation's ladder was not applied, when it was not. */
  ladderError?: string | null;
  /**
   * The reasoning-effort level this conversation is running at.
   *
   * Distinct from `capabilities.efforts`, which is the ladder — and distinct in
   * a way that matters more here than it does for the model, because a level's
   * whole meaning is its position on that ladder. `high` names the top of grok's
   * and the middle of pi's.
   */
  effort?: string;
  /**
   * Change how hard the agent thinks. Unlike the model this is only offered
   * where the runtime published a ladder to choose from; see EffortChip.
   */
  onSetEffort?: (effort: string) => void;
  /** What the server reported about the last `onSetEffort` call, for the chip. */
  effortFeedback?: {
    applied: 'live' | 'sent' | 'pending' | 'cleared' | 'refused';
    message: string;
  } | null;
  /** Conversation plan mode is available for every Web-chat runtime. */
  planMode?: boolean;
  onSetPlanMode?: (on: boolean) => void;
  /** A planning turn already received its directive, so changing it would lie. */
  planLocked?: boolean;
  planFeedback?: { action: string; changed?: boolean; message: string } | null;
  planDocument?: { markdown: string; revision: number; ts: number } | null;
  onOpenPlan?: () => void;
  /** Drives what the permission chip reports. */
  bypassPermissions?: boolean;
  /**
   * Start a new conversation in this tab, the same thing typing `/clear` does.
   *
   * Absent means no control: a surface that cannot clear must not offer a
   * button that does nothing. Present, it is offered while the conversation is
   * healthy — which is the whole point of it, the recovery banner having been
   * the only place this choice lived and appearing only once the session was
   * already broken.
   */
  onNewChat?: () => void;
  /** Changes what the hint row says about who owns Return. */
  terminalOpen?: boolean;
}

/**
 * One file on its way up, from this browser.
 *
 * Only ever `uploading` or `error` now. A finished upload leaves this list for
 * the attachment list proper, which is the conversation's rather than the
 * window's — the chip on screen looks identical, but the thing behind it stops
 * being a `File` nobody else can see and becomes a url every screen can fetch.
 */
interface AttachmentEntry {
  key: string;
  /** Which pick this was, so the chip keeps one identity across the upload. */
  picked: number;
  file: File;
  /** Stable identity shared by picker, drop and paste de-duplication. */
  fingerprint: string;
  status: 'uploading' | 'error';
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

/**
 * Put a finished upload where it was picked, not where it happened to land.
 *
 * Uploads run at the same time, so a small file overtakes a large one and a
 * batch finishes in an order nobody chose. That matters for two files whose
 * whole point is the pair of them — "here is before, here is after" reaching the
 * agent the other way round is not a cosmetic difference.
 *
 * Placed ahead of the first file the same window picked *after* it, and behind
 * everything else. Anything that arrived from another screen is not in `order`
 * at all and never moves: this window did not see it chosen and has no business
 * having an opinion about when it was.
 */
export function placeByPickOrder(
  list: ChatAttachment[],
  attachment: ChatAttachment,
  picked: number,
  order: Map<string, number>,
): ChatAttachment[] {
  const at = list.findIndex((held) => {
    const other = order.get(held.url);
    return other !== undefined && other > picked;
  });
  if (at === -1) return [...list, attachment];
  return [...list.slice(0, at), attachment, ...list.slice(at)];
}

/**
 * A file identity that survives the different DOM paths which can produce it.
 *
 * This metadata is useful for diagnostics and stable display keys, but is not
 * itself a file identity: two different directories can contain same-named,
 * same-sized files with the same timestamp and different bytes.
 */
export function attachmentFileFingerprint(
  file: Pick<File, 'name' | 'size' | 'type' | 'lastModified'>,
): string {
  return JSON.stringify([file.name, file.size, file.type, file.lastModified]);
}

export interface ReservedAttachmentFile {
  file: File;
  fingerprint: string;
}

/**
 * Owns the two pieces of upload state which must change synchronously.
 *
 * React state updates are intentionally not used as the authority here: two
 * input events can arrive before a render, and a removed upload can resolve
 * after its chip is gone. Reserving before starting and matching the exact
 * AbortSignal on settlement closes both races.
 */
export class AttachmentUploadGuard {
  private readonly activeFiles = new WeakMap<object, string>();
  private readonly fingerprints = new Set<string>();
  private readonly attempts = new Map<string, AbortController>();
  private fileSequence = 0;

  reserve(files: File[]): ReservedAttachmentFile[] {
    const reserved: ReservedAttachmentFile[] = [];
    for (const file of files) {
      let fingerprint = this.activeFiles.get(file);
      if (fingerprint && this.fingerprints.has(fingerprint)) continue;
      if (!fingerprint) {
        this.fileSequence += 1;
        fingerprint = `${attachmentFileFingerprint(file)}#${this.fileSequence}`;
        this.activeFiles.set(file, fingerprint);
      }
      this.fingerprints.add(fingerprint);
      reserved.push({ file, fingerprint });
    }
    return reserved;
  }

  release(fingerprint: string): void {
    this.fingerprints.delete(fingerprint);
  }

  begin(key: string): AbortSignal | null {
    // A rapid double-click on Retry can happen before React paints the
    // uploading state. Only the first click is allowed to start a request.
    if (this.attempts.has(key)) return null;
    const controller = new AbortController();
    this.attempts.set(key, controller);
    return controller.signal;
  }

  settle(key: string, signal: AbortSignal): boolean {
    const current = this.attempts.get(key);
    if (!current || current.signal !== signal) return false;
    this.attempts.delete(key);
    return true;
  }

  cancel(key: string): boolean {
    const current = this.attempts.get(key);
    if (!current) return false;
    this.attempts.delete(key);
    current.abort();
    return true;
  }

  cancelAll(): void {
    for (const current of this.attempts.values()) current.abort();
    this.attempts.clear();
  }

  clear(): void {
    this.cancelAll();
    this.fingerprints.clear();
  }
}

/** Kept pure so the upload/error send gate is deterministic in non-DOM tests. */
export function canSendComposerMessage(
  disabled: boolean,
  entries: ReadonlyArray<Pick<AttachmentEntry, 'status'>>,
  text: string,
  attachmentCount: number,
): boolean {
  // An error is still part of the unsent message until it is retried or
  // removed. Sending around it would silently drop the file the chip names.
  return !disabled && entries.length === 0 && (text.trim().length > 0 || attachmentCount > 0);
}

/** Chat attachment paste uses the route's 20 MiB cap, not terminal paste's cap. */
export function classifyComposerClipboardFiles(
  files: ReadonlyArray<Pick<File, 'type' | 'size'>>,
): PasteClassification {
  const candidates: PasteCandidate[] = files.map((file) => ({
    kind: 'file',
    type: file.type,
    size: file.size,
  }));
  return classifyPaste(candidates, MAX_ATTACHMENT_BYTES);
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
  attachments: controlledAttachments,
  onAttachmentsChange,
  queued = [],
  onCancelQueued,
  onSendQueuedNow,
  onRetryQueued,
  onFindFiles,
  seedKey = 0,
  seedDraft = '',
  branch,
  turnLabel,
  usage,
  model,
  alsoRan,
  onSetModel,
  modelFeedback,
  modelDefault,
  modelOverride,
  modelPinned,
  modelOrigin,
  ladderError,
  effort,
  onSetEffort,
  effortFeedback,
  planMode = false,
  onSetPlanMode,
  planLocked = false,
  planFeedback,
  planDocument,
  onOpenPlan,
  bypassPermissions = false,
  terminalOpen = false,
  onNewChat,
}: ComposerProps) {
  const baseId = React.useId();
  const listboxId = `${baseId}-picker`;
  const optionId = (index: number) => `${baseId}-option-${index}`;

  const shellRef = React.useRef<HTMLDivElement | null>(null);
  const pickerRef = React.useRef<HTMLDivElement | null>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const keySeq = React.useRef(0);
  const uploadGuard = React.useRef(new AttachmentUploadGuard());
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
  /** Files still going up from this window, and the ones that failed to. */
  const [entries, setEntries] = React.useState<AttachmentEntry[]>([]);
  /** Where the finished ones live when nobody outside is holding them. */
  const [uncontrolledAttachments, setUncontrolledAttachments] = React.useState<ChatAttachment[]>([]);
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
  /**
   * Whether the phone's secondary controls are showing.
   *
   * Attach, the two pickers, the model and the approvals readout are five
   * controls that a phone has no room for beside the field and no reason to
   * show while you are typing — the two that matter mid-sentence are send and
   * stop. Shut by default, and the room goes to the conversation.
   */
  const [toolsOpen, setToolsOpen] = React.useState(false);

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

  // Same two-mode arrangement as the draft above, and for the same reason: this
  // component is also rendered on its own, where there is nobody outside to hold
  // the list for it.
  const attachmentsControlled = controlledAttachments !== undefined;
  const attachments = attachmentsControlled ? controlledAttachments! : uncontrolledAttachments;
  /**
   * The list as it stands right now, uploads included.
   *
   * A controlled list cannot be updated from a function of its previous value —
   * that belongs to whoever holds it — so two files finishing within the same
   * frame would each append to the same stale array and the first one would be
   * dropped. Writing the answer here as well as sending it out is what makes the
   * second upload see the first.
   */
  const attachmentsRef = React.useRef(attachments);
  attachmentsRef.current = attachments;
  /**
   * The files this window uploaded, kept by the url they were stored under.
   *
   * Two things are lost the moment an upload finishes and the chip starts
   * drawing from the attachment instead of the `File`. The name: the server
   * stores files under a name it can trust — spaces and brackets become dashes —
   * so "My Report (final).pdf" would visibly rename itself under the person who
   * picked it. And the picture: the thumbnail is already in memory here, and
   * swapping it for a fetch of the same image is a flicker charged for nothing.
   *
   * Only ever an improvement on what the other screens see, never a
   * disagreement about *which* file: both are naming one stored object, this one
   * by the name it arrived with.
   */
  const localFiles = React.useRef(new Map<string, File>());
  /** Reservation to release when a locally uploaded attachment is removed. */
  const localFingerprints = React.useRef(new Map<string, string>());
  /**
   * What order the files picked in this window were picked in.
   *
   * Uploads run at the same time, so a small file overtakes a large one and they
   * finish in neither the order they were chosen nor any order a person would
   * predict. That matters for two files whose whole point is the pair of them —
   * "here is before, here is after" reaching the agent the other way round is
   * not a cosmetic difference — so a finished upload takes its place in the list
   * rather than the next free one at the end.
   *
   * Only ever consulted about this window's own picks. A file that arrived from
   * another screen has no place in this ordering and is never moved by it.
   */
  const pickOrder = React.useRef(new Map<string, number>());
  const setAttachments = React.useCallback(
    (next: ChatAttachment[]) => {
      attachmentsRef.current = next;
      if (attachmentsControlled) onAttachmentsChange?.(next);
      else setUncontrolledAttachments(next);
    },
    [attachmentsControlled, onAttachmentsChange],
  );

  // Abort requests on unmount. Some upload handlers (including the built-in
  // one) honour the signal; handlers that do not are still tombstoned by the
  // exact-signal check before their promise can update state.
  React.useEffect(() => () => uploadGuard.current.clear(), []);

  // A controlled attachment can be removed by another screen. Drop the local
  // fingerprint then as well, otherwise picking that file again in this window
  // would be mistaken for a duplicate of an attachment that no longer exists.
  React.useEffect(() => {
    const live = new Set(attachments.map((attachment) => attachment.url));
    for (const [url, fingerprint] of localFingerprints.current) {
      if (live.has(url)) continue;
      localFingerprints.current.delete(url);
      localFiles.current.delete(url);
      pickOrder.current.delete(url);
      uploadGuard.current.release(fingerprint);
    }
  }, [attachments]);

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

  // Deliberately not gated on `busy`. A turn typed while the agent is working
  // is queued rather than refused, which is the whole point of the chips above.
  const canSend = canSendComposerMessage(disabled, entries, text, attachments.length);

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
    onSend(text, attachments);
    setText('');
    setAttachments([]);
    localFiles.current.clear();
    localFingerprints.current.clear();
    pickOrder.current.clear();
    // Only this window's failures. A file that could not be uploaded was never
    // part of the message being sent, but the chip explaining that has no reason
    // to outlive the message it was attached to.
    setEntries([]);
    uploadGuard.current.clear();
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

  function startUpload(entry: AttachmentEntry) {
    if (!onUpload) return;
    const signal = uploadGuard.current.begin(entry.key);
    if (!signal) return;

    // Retry keeps the same key, pick position and reservation. The synchronous
    // guard above prevents a second retry while this state update is pending.
    setEntries((prev) => prev.map((held) => (
      held.key === entry.key ? { ...held, status: 'uploading', error: undefined } : held
    )));

    let request: Promise<ChatAttachment>;
    try {
      request = onUpload(entry.file, signal);
    } catch (error) {
      request = Promise.reject(error);
    }

    void request.then(
      (attachment) => {
        // Removal aborts when possible and deletes this exact attempt. Even an
        // upload handler which ignores AbortSignal cannot resurrect the chip.
        if (!uploadGuard.current.settle(entry.key, signal)) return;
        // Handed over: the bytes are on the server under a url of its choosing,
        // so this stops being a file this window is holding and becomes one the
        // conversation has. The chip does not move — the one drawn from the
        // local `File` is replaced by one drawn from the attachment, in the same
        // place, with the same name on it.
        setEntries((prev) => prev.filter((held) => held.key !== entry.key));
        localFiles.current.set(attachment.url, entry.file);
        localFingerprints.current.set(attachment.url, entry.fingerprint);
        pickOrder.current.set(attachment.url, entry.picked);
        const existing = attachmentsRef.current.findIndex((held) => held.url === attachment.url);
        if (existing >= 0) {
          const next = [...attachmentsRef.current];
          next[existing] = attachment;
          setAttachments(next);
        } else {
          setAttachments(placeByPickOrder(
            attachmentsRef.current,
            attachment,
            entry.picked,
            pickOrder.current,
          ));
        }
      },
      (error: unknown) => {
        if (!uploadGuard.current.settle(entry.key, signal)) return;
        const message = error instanceof Error ? error.message : 'That file could not be attached.';
        setEntries((prev) => prev.map((held) => (
          held.key === entry.key ? { ...held, status: 'error', error: message } : held
        )));
      },
    );
  }

  function addFiles(files: File[]) {
    if (!onUpload) return;
    const next = uploadGuard.current.reserve(files).map(({ file, fingerprint }) => {
      keySeq.current += 1;
      const picked = keySeq.current;
      return {
        key: `${file.name}-${file.size}-${picked}`,
        picked,
        file,
        fingerprint,
        status: 'uploading' as const,
      };
    });
    if (next.length === 0) return;
    setEntries((prev) => [...prev, ...next]);
    next.forEach(startUpload);
  }

  /** Take a file out of the message before it is sent, everywhere it is shown. */
  function removeAttachment(url: string) {
    localFiles.current.delete(url);
    const fingerprint = localFingerprints.current.get(url);
    if (fingerprint) uploadGuard.current.release(fingerprint);
    localFingerprints.current.delete(url);
    pickOrder.current.delete(url);
    setAttachments(attachmentsRef.current.filter((attachment) => attachment.url !== url));
  }

  function removeEntry(entry: AttachmentEntry) {
    uploadGuard.current.cancel(entry.key);
    uploadGuard.current.release(entry.fingerprint);
    setEntries((prev) => prev.filter((held) => held.key !== entry.key));
  }

  function retryEntry(entry: AttachmentEntry) {
    startUpload(entry);
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
    const classification = classifyComposerClipboardFiles(files);
    if (!classification.handled) return;

    e.preventDefault();
    for (const index of classification.oversize) {
      showNotification(
        `${files[index].name || 'That image'} is ${formatBytes(files[index].size)}, over the `
          + `${formatBytes(MAX_ATTACHMENT_BYTES)} limit.`,
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

  /**
   * Every file on the unsent message, in one list.
   *
   * One list rather than two — the ones that have landed and the ones still
   * going up — because a chip has to survive the moment its upload finishes.
   * Rendered as two arrays it could not: React keys are scoped to the array they
   * are in, so a file moving between them is torn down and built again, which
   * replays the chip's entry animation and throws away the thumbnail it had
   * already made. A file picked here keeps one identity through both halves of
   * its life; one that arrived from another screen is named by its url, which is
   * the only name this window ever knew it by.
   */
  const chips: {
    key: string;
    name: string;
    size: number;
    mime: string;
    file?: File;
    preview?: string;
    status?: 'uploading' | 'error';
    error?: string;
    onRetry?: () => void;
    onRemove: () => void;
  }[] = [
    ...attachments.map((attachment) => {
      // Present only for a file picked in this window; every other screen draws
      // the same attachment from the server's copy of it.
      const local = localFiles.current.get(attachment.url);
      const picked = pickOrder.current.get(attachment.url);
      return {
        key: picked === undefined ? attachment.url : `picked:${picked}`,
        name: local?.name ?? attachment.name,
        size: local?.size ?? attachment.size,
        mime: local?.type || attachment.mime,
        file: local,
        // The server's own copy, which every screen on this account can fetch.
        // A `blob:` url would be a picture only one window can see, and the
        // phone showing the same message would draw a broken image in place of
        // the screenshot.
        preview: attachment.url,
        onRemove: () => removeAttachment(attachment.url),
      };
    }),
    ...entries.map((entry) => ({
      key: `picked:${entry.picked}`,
      name: entry.file.name,
      size: entry.file.size,
      mime: entry.file.type,
      file: entry.file,
      status: entry.status,
      error: entry.error,
      onRetry: entry.status === 'error' ? () => retryEntry(entry) : undefined,
      onRemove: () => removeEntry(entry),
    })),
  ];

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
  /**
   * The phone's resting shape: the field and its buttons on one line.
   *
   * Only while the extra controls are shut. Open, they are five more chips that
   * have nowhere to go on a shared line, so the column comes back.
   */
  const phoneCollapsed = isMobile && !toolsOpen;

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
        <QueuedList
          queued={queued}
          onCancelQueued={onCancelQueued}
          onSendQueuedNow={onSendQueuedNow}
          onRetryQueued={onRetryQueued}
        />
      ) : null}

      {/* The message's files first, then whatever this window is still sending
          up. Attached order, in effect — an upload joins the first group the
          moment it lands, at the end of it — and it keeps the row from
          reshuffling under the cursor as each one finishes. */}
      {chips.length > 0 ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-1-5)' }} aria-label="Attachments">
          {chips.map((chip) => (
            <AttachmentChip
              key={chip.key}
              name={chip.name}
              size={chip.size}
              mime={chip.mime}
              file={chip.file}
              preview={chip.preview}
              status={chip.status}
              error={chip.error}
              onRetry={chip.onRetry}
              onRemove={chip.onRemove}
            />
          ))}
        </div>
      ) : null}

      {/* One line, not two, while the extra controls are shut.
          `display: contents` everywhere else, so the desktop keeps the column
          it has: the field over its own row of actions, which is what stops the
          buttons floating in the middle of a twelve-line draft. On a phone
          collapsed there is no twelve-line draft to float in and the second row
          was 52px the conversation could have had. */}
      <div
        style={
          phoneCollapsed
            ? { display: 'flex', alignItems: 'flex-end', gap: TOUCH_GAP, minWidth: 0 }
            : { display: 'contents' }
        }
      >
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
          // On the shared row it is the part that gives, so the buttons beside
          // it keep their size. A flex item's `min-width: auto` would refuse.
          ...(phoneCollapsed ? { flex: 1, minWidth: 0, width: undefined } : null),
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
          and what the conversation has cost.

          On a phone the first row is send and stop, and everything else is
          behind the disclosure at its left. */}
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
          // Beside the field rather than under it, and only as wide as its
          // buttons.
          ...(phoneCollapsed ? { flex: '0 0 auto' } : null),
        }}
      >
        {/* On a phone each of these says what it is. A paperclip is a
            convention and `@` and `/` are the characters they type, but on a
            touch screen there is no hover to confirm any of that — the only way
            to find out what a bare glyph does is to press it and see. */}
        {isMobile ? (
          <ChipButton
            label={toolsOpen ? 'Hide the other controls' : 'Show the other controls'}
            // Labelled like everything else on this row: a bare `+` says
            // "attach" to most people, which is the control next to it.
            text={toolsOpen ? 'Less' : 'More'}
            aria-expanded={toolsOpen}
            onClick={() => setToolsOpen((value) => !value)}
          >
            <Icon name={toolsOpen ? 'chevron-down' : 'chevron-up'} size={18} />
          </ChipButton>
        ) : null}

        {attachmentsEnabled && (!isMobile || toolsOpen) ? (
          <ChipButton
            label="Attach a file or image"
            text="Attach"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
          >
            <Icon name="paperclip" size={isMobile ? 16 : 12} />
          </ChipButton>
        ) : null}

        {filesEnabled && (!isMobile || toolsOpen) ? (
          <ChipButton label="Reference a file from this project" text="File" onClick={openFiles}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: isMobile ? 15 : 12 }}>@</span>
          </ChipButton>
        ) : null}

        {commands.length > 0 && (!isMobile || toolsOpen) ? (
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

        {/* Not gated on `busy`: clearing mid-answer is allowed and acts at
            once — the process the turn is running in is the one being replaced,
            so waiting for it to finish would only postpone the same
            interruption. Gated on `disabled` like the rest of the row, because
            a session with nothing running it has the recovery offer instead,
            which is where starting again belongs when it is a recovery.

            No confirmation. The typed command does not ask either, and the
            conversation is not deleted by this — the log keeps it for history,
            search and export. A dialog in front of something done many times a
            day costs more than the press it guards. */}
        {onNewChat && (!isMobile || toolsOpen) ? (
          <ChipButton
            label="Start a new conversation — this one is kept, the agent forgets it"
            text="New chat"
            onClick={onNewChat}
            disabled={disabled}
          >
            <Icon name="message-square" size={isMobile ? 16 : 12} />
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
          {branch && roomy && (!isMobile || toolsOpen) ? (
            <Chip
              label={`On branch ${branch}`}
              reason="Switch branches from the terminal or the Changes panel — a checkout under a running agent is not something this control can undo."
              icon="git-branch"
            >
              {branch}
            </Chip>
          ) : null}

          {!isMobile || toolsOpen ? (
            <>
              <ModelChip
                current={model}
                alsoRan={alsoRan}
                models={capabilities.models}
                feedback={modelFeedback}
                fallback={modelDefault}
                override={modelOverride}
                pinned={modelPinned}
                origin={modelOrigin}
                ladderError={ladderError}
                onPick={(value) => onSetModel?.(value)}
              />

              {/* Next to the model because they are the same kind of decision
                  — which brain, and how hard it works — and because this one
                  removes itself entirely when the runtime publishes no ladder,
                  so the row does not gain a permanent gap for a control that
                  half the runtimes cannot offer. */}
              <EffortChip
                current={effort}
                efforts={capabilities.efforts}
                feedback={effortFeedback}
                onPick={(value) => onSetEffort?.(value)}
              />

              {onSetPlanMode ? (
                <PlanModeChip
                  on={planMode}
                  locked={planLocked}
                  feedback={planFeedback}
                  onToggle={onSetPlanMode}
                />
              ) : null}

              {planDocument && onOpenPlan ? (
                <ChipButton label="Read the submitted plan" text="Plan" onClick={onOpenPlan}>
                  <Icon name="list-todo" size={13} />
                </ChipButton>
              ) : null}

              <PermissionChip bypassPermissions={bypassPermissions} />
            </>
          ) : null}

          {/* Not on a phone's resting row. Stopping is possible exactly while
              the live ribbon is on screen, and the ribbon carries a labelled
              stop of its own directly above this — a second one here costs the
              field about a third of its width to say the same thing twice, and
              the field is what the row is for. */}
          {busy && !disabled && !phoneCollapsed ? (
            <StopButton onClick={onInterrupt} enabled={capabilities.interrupt} />
          ) : null}

          <SendButton label={sendLabel} enabled={canSend} queueing={busy} onClick={submit} />
        </span>
      </div>
      </div>

      {/* Hidden on a phone until the other controls are, because the session
          header already carries the cost and this row is otherwise a line of
          chrome under the one thing you are trying to type into. */}
      <div
        style={{
          display: isMobile && !toolsOpen ? 'none' : 'flex',
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
    // `tokenTotal`, not a sum of its own: this used to add the input to the
    // output and stop there, which on a runtime that reports no total of its
    // own — Claude — left out the cache buckets, most of the bill. So the
    // session line, the meter above it and the historical record were three
    // different answers about one conversation (#80).
    const total = tokenTotal(usage);
    if (total !== null) bits.push(`${compactCount(total)} tok`);
    if (usage.costUsd !== undefined) bits.push(`$${usage.costUsd.toFixed(4)}`);
    // Otherwise this line degrades to a bare `turn 3` against a runtime that
    // reports nothing, which reads as a session that has spent nothing. Only
    // ever off a spoken absence — the session states it after watching a turn
    // finish, and a transcript that has simply not heard yet says nothing here,
    // as it should.
    //
    // One phrase when both halves are silent, the same rule the compact meter
    // follows and for the same reason: this line is one nowrap span that
    // neither shrinks nor wraps, and "tokens not reported · cost not reported"
    // measured 445px against a 390px phone — 55px of it off the side of the
    // screen (test/browser/checks.ts).
    const noTokens = total === null && usage.usageSource === 'none';
    const noCost = usage.costUsd === undefined && usage.costSource === 'none';
    if (noTokens && noCost) bits.push('usage not reported');
    else if (noTokens) bits.push('tokens not reported');
    else if (noCost) bits.push('cost not reported');
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
/**
 * Where a new conversation on this runtime would get its model.
 *
 * Deliberately phrased as the *default*, never as the running model: on a
 * runtime that fixes the model when the process is spawned the two are
 * routinely different, and a line that read like a status would be wrong every
 * time somebody picked a model mid-conversation.
 */
function describeModelDefault(fallback: ChatModelDefault): string {
  if (fallback.source === 'personal' && fallback.model) {
    return `Your standing choice for this runtime: ${fallback.model}.`;
  }
  if (fallback.source === 'profile' && fallback.model) {
    return fallback.profileName
      ? `From the "${fallback.profileName}" runtime profile: ${fallback.model}.`
      : `From the active runtime profile: ${fallback.model}.`;
  }
  if (fallback.source === 'ladder' && fallback.model) {
    const ladder = fallback.profileName ? `the "${fallback.profileName}" ladder` : 'the active ladder';
    return `The ${fallback.tier} rung of ${ladder}: ${fallback.model}.`;
  }
  return 'No default set — this runtime picks for itself.';
}

/**
 * What *this* conversation is running, and why it is on it.
 *
 * The question the chip could not answer before the ladder existed, and the one
 * the issue asks for by name: the model in use, the rung it corresponds to, and
 * which of four things chose it. Separate from the default above because the
 * two are routinely different and stating either as the other is the whole of
 * #135.
 */
function describeModelOriginLine(origin: ChatModelOrigin, chosen: boolean): string | null {
  if (!origin.model) {
    return origin.source === 'runtime' ? 'Running on this runtime’s own default.' : null;
  }
  switch (origin.source) {
    case 'ladder': {
      const ladder = origin.profileName ? `the "${origin.profileName}" ladder` : 'the active ladder';
      const fell = origin.requestedTier
        ? ` (${origin.requestedTier} is blank, so the nearest filled rung answered)`
        : '';
      return `Running on the ${origin.tier} rung of ${ladder}${fell}.`;
    }
    case 'profile':
      return origin.profileName
        ? `Running on the model set by the "${origin.profileName}" runtime profile.`
        : 'Running on the model set by the active runtime profile.';
    case 'personal':
      return 'Running on your standing choice for this runtime.';
    case 'override':
      // Two different facts arrive under this one source, and only one of them
      // is a choice. A conversation that has an override in force was told to
      // run this model and can be told to stop; a conversation that merely
      // *launched* on one is fixed to it because that is what it started with —
      // a profile's model, an account's standing choice, or a branch's source —
      // and calling that "chosen" credits the user with a decision they never
      // made, next to a Clear that would not undo it.
      return chosen
        ? 'Chosen for this conversation only.'
        : `Staying on ${origin.model}, the model it launched on.`;
    default:
      return 'Running on this runtime’s own default.';
  }
}

/**
 * What clearing the override would actually do.
 *
 * Two different answers, and conflating them was the trap: clearing does not
 * fall back to a standing choice, it *forgets* it. That is what makes this
 * entry the only way to undo a model that has become the default for every new
 * chat on this runtime, and saying "falls back to your last choice" would
 * describe the opposite of what the click does.
 */
function describeModelClear(fallback: ChatModelDefault): string {
  if (fallback.source === 'personal' && fallback.model) {
    return `Clearing drops it, and forgets ${fallback.model} as your standing choice for this runtime.`;
  }
  if (fallback.source === 'profile' && fallback.model) {
    return fallback.profileName
      ? `Clearing falls back to the "${fallback.profileName}" runtime profile: ${fallback.model}.`
      : `Clearing falls back to the active runtime profile: ${fallback.model}.`;
  }
  return 'Clearing leaves the model to this runtime.';
}

function ModelChip({
  current,
  alsoRan,
  models,
  onPick,
  feedback,
  fallback,
  override,
  pinned,
  origin,
  ladderError,
}: {
  /** What the session reported it is running, when it reported anything. */
  current: string | undefined;
  /** Every model the last turn ran on, when the runtime reported more than one. */
  alsoRan?: string[];
  models: ModelChoice[] | undefined;
  onPick: (value: string) => void;
  /** What the server said happened to the last pick made here. */
  feedback?: { applied: 'live' | 'sent' | 'pending' | 'cleared'; message: string } | null;
  /** Where a new conversation's model would come from; null when unsaid. */
  fallback?: ChatModelDefault | null;
  /** This conversation's own choice, as distinct from what the runtime reported. */
  override?: string | null;
  /**
   * The model this conversation was actually launched on; null when unsaid.
   *
   * Apart from `fallback` because they answer different questions, and the chip
   * would be lying if it used one for the other: this is what the process is
   * running, that is what the next new chat would open on.
   */
  pinned?: string | null;
  /** Where the model in force came from, and which rung it is; null when unsaid. */
  origin?: ChatModelOrigin | null;
  /** Why the ladder was not applied, when it was not. */
  ladderError?: string | null;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [customValue, setCustomValue] = React.useState('');
  const ref = React.useRef<HTMLDivElement | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const isPhone = usePhone();

  /**
   * Only the outcomes this control cannot say for itself (issue #128).
   *
   * The same rule the effort chip took in #119, and for the same reasons. A
   * model that switched needs no announcement: the chip is relabelled with its
   * name the instant the switch lands, so a box beside it reading "Switched to
   * claude-sonnet for this conversation" spends the user's attention repeating
   * what their eye has already reached — and on a phone, where this wrapper is
   * `static` so the menu can have the composer's width, it repeats it on top of
   * the field they were about to type into.
   *
   * Three outcomes survive, because each is one the chip gets wrong on its own:
   * `sent` means the runtime was asked and has not answered yet, so the word is
   * in the transcript rather than here; `pending` will not reach this
   * conversation at all before it is relaunched; and `cleared` is the least
   * visible of the three, because the chip has already fallen back to whatever
   * the session last reported — which is not what the next one will run.
   *
   * Unlike the effort ladder there is no `refused`: a model name is free text
   * and nothing here can pre-judge it.
   */
  const notice = feedback && feedback.applied !== 'live' ? feedback : null;

  /**
   * The answer goes away on its own, after long enough to read it.
   *
   * Left standing it becomes a fixture rather than a reply, and this box and the
   * effort chip's are anchored at the same height — two of them overlap into a
   * pile of opaque boxes, and on a phone, where both resolve against the
   * composer instead of against their own chip, they land on identical
   * coordinates and the older one is simply invisible underneath.
   *
   * Keyed on the answer itself and not on its text, so a second answer restarts
   * the clock rather than inheriting the remains of the first one's — including
   * when the two read the same. The controller mints a fresh result object for
   * every reply the server sends and hands back that same object until the next
   * one, so this changes exactly once per answer and never on a redraw. Keyed on
   * the string instead, an outcome repeated word for word — the same model picked
   * twice on a runtime that cannot switch mid-session, or "use the default"
   * clicked twice — left the dependency unchanged after the timeout had hidden
   * the box, so the second click answered with nothing at all.
   */
  const [showFeedback, setShowFeedback] = React.useState(false);
  React.useEffect(() => {
    if (!notice) return;
    setShowFeedback(true);
    const timer = setTimeout(() => setShowFeedback(false), 7000);
    return () => clearTimeout(timer);
  }, [notice]);

  /**
   * What the chip names when the session has reported nothing.
   *
   * The word "model" used to sit here for the whole of a conversation whose
   * runtime never emits a session event — which on a profile-pinned install
   * meant the pin was genuinely in force and nowhere on screen (#135).
   *
   * The pin, and never the default. They are routinely different and the
   * difference is the whole point: the default is what the *next* new chat
   * would open on, so naming it here would put a model on the chip that this
   * conversation was never launched on and never will be — and it would change
   * under an open conversation the moment the same account picked a model
   * anywhere else. The pin is what the launch actually used, so naming it is a
   * statement about this conversation and nothing else.
   */
  const effective = current ?? pinned ?? undefined;
  // The session's own model wins. `models` is a menu in whatever order the
  // runtime listed it, and its first entry is the current one only by accident.
  const matched = models?.find((m) => m.value === effective || m.name === effective);
  const named = matched?.name ?? effective ?? 'model';
  // The others are counted, not named: three model ids do not fit on a chip,
  // and picking one of them to show would undo the point of reporting a split.
  const others = (alsoRan ?? []).filter((model) => model !== current);
  // The rung rides on the chip rather than only in the menu, because "which
  // model is this on" and "how expensive is that" are one glance for anybody
  // who built a ladder — and the menu is two clicks away.
  const rung = origin?.source === 'ladder' && origin.tier && origin.model === effective
    ? origin.tier
    : null;
  const withRung = rung ? `${named} · ${rung}` : named;
  const label = others.length > 0 ? `${withRung} +${others.length}` : withRung;

  /**
   * Why this model and not another — the question the picker could not answer.
   *
   * Two sentences at most, because there are only ever two facts: what fixed
   * this conversation's model, and what the default is. A server that said
   * nothing about the default produces nothing here rather than a guess, so an
   * older one degrades to the wording that shipped before.
   *
   * The middle case is the one that has to be said out loud rather than implied:
   * a conversation pinned to a model the default no longer names is *staying*
   * on it, and a line that only described the default would read as a claim
   * about what is running.
   */
  const clearPhrase = fallback ? describeModelClear(fallback) : null;
  const staysOn = pinned && pinned !== fallback?.model ? `Staying on ${pinned}.` : null;
  // The origin answers "why is this conversation on this model" outright, so it
  // replaces the inference `staysOn` was making from a mismatch. A server that
  // predates it sends nothing and the older wording still applies.
  const inForce = origin ? describeModelOriginLine(origin, Boolean(override)) : staysOn;
  const sourceLine = !fallback
    ? inForce
    : override
      ? `Chosen for this conversation only. ${clearPhrase}`
      : inForce
        ? `${inForce} ${describeModelDefault(fallback)}`
        : describeModelDefault(fallback);

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

  /**
   * The list, narrowed by what has been typed.
   *
   * The same field does both jobs. A runtime that publishes hundreds of models
   * — pi lists 277 — turns an unfiltered menu into a scroll nobody reads, and
   * adding a second input beside a box already labelled "type a model name"
   * would be two ways to say the same thing. Typing narrows; `Use` still sends
   * whatever was typed, so a model the runtime did not list stays reachable
   * even when it matches nothing.
   */
  const query = customValue.trim().toLowerCase();
  const shown = query
    ? (models ?? []).filter(
        (choice) =>
          choice.value.toLowerCase().includes(query)
          || choice.name.toLowerCase().includes(query)
          || (choice.description ?? '').toLowerCase().includes(query),
      )
    : models ?? [];

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
        title={
          // The same rule as the box, and for the same reason: a hover reading
          // "Switched to claude-sonnet for this conversation" would have
          // displaced the description of what this control *does* for the rest
          // of the conversation, in favour of a sentence the chip beneath the
          // pointer already spells out. An outcome the chip cannot show still
          // takes the slot, so it stays findable after its box has timed out.
          // The source rides on the end of the resting title rather than
          // replacing it, because a hover is also the only route to it on a
          // desktop without opening the menu — and the menu is a click that
          // covers the composer.
          notice?.message
          || (others.length > 0
            ? `This turn ran on: ${[named, ...others].join(', ')}`
            : `Model: ${label}${sourceLine ? ` — ${sourceLine}` : ''}`)
        }
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
          {/* Above the field rather than below the list, because it is context
              for every choice underneath it — including the clear entry at the
              bottom, which is the one the sentence's second half is about. */}
          {sourceLine ? (
            <div
              data-model-source=""
              style={{
                padding: '2px 4px 6px',
                color: 'var(--muted-foreground)',
                // The list's own size, not the 10px the hints below it use: it
                // is a sentence rather than a caption, and it is the thing that
                // explains every entry underneath it.
                fontSize: isPhone ? PHONE_TEXT.body : 'var(--text-xs)',
                lineHeight: 1.4,
              }}
            >
              {sourceLine}
            </div>
          ) : null}

          {/* A ladder that could not be applied. Said here rather than swallowed:
              the settings page reported it as saved, and without this the only
              evidence is a model nobody chose. */}
          {ladderError ? (
            <div
              data-ladder-error=""
              style={{
                padding: '2px 4px 6px',
                color: 'var(--destructive)',
                fontSize: isPhone ? PHONE_TEXT.body : 'var(--text-xs)',
                lineHeight: 1.4,
              }}
            >
              {ladderError}
            </div>
          ) : null}

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
              placeholder={models?.length ? 'Filter, or type any model name…' : 'Type any model name…'}
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

          {shown.map((choice) => (
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

          {models?.length && shown.length === 0 ? (
            <div
              style={{
                padding: '4px 8px 2px',
                color: 'var(--muted-foreground)',
                fontSize: isPhone ? PHONE_TEXT.body : 'var(--text-2xs)',
              }}
            >
              No listed model matches — Use sends it anyway.
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
            title={clearPhrase ?? undefined}
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

      {!open && notice && showFeedback ? (
        <div
          role="status"
          style={{
            position: 'absolute',
            right: 0,
            // Upward on a phone, and the reason is that `top: 100%` resolves
            // against the composer there rather than against this chip — the
            // wrapper is `static` so the menu can have the composer's width.
            // Below the composer is the bottom navigation bar, which this would
            // cover: an opaque box at `--z-dropdown` sitting on the buttons, or
            // off the screen entirely once the safe-area inset is counted.
            ...(isPhone ? { bottom: '100%', marginBottom: 6 } : { top: '100%', marginTop: 4 }),
            maxWidth: 240,
            padding: '4px 6px',
            background: 'var(--popover)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            // Every outcome that reaches here is "saved, but not yet" — true,
            // worth reading once, and not worth alarm. The one that used to be
            // drawn in full-strength foreground was the one that had already
            // happened, which was the loudest thing on screen for the least news.
            color: 'var(--muted-foreground)',
            fontSize: isPhone ? PHONE_TEXT.body : 'var(--text-2xs)',
            zIndex: 'var(--z-dropdown)' as unknown as number,
          }}
        >
          {notice.message}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Where a level sits on its runtime's ladder, as a colour.
 *
 * The five stops are CSS custom properties (see `--effort-0..4` in relay.css),
 * so the ramp themes itself and this only has to say where between two of them
 * a rank falls. Interpolating rather than snapping to the nearest stop matters
 * for the longer ladders: pi has seven levels, and rounding each to one of five
 * colours would give two pairs of neighbours the same one — which is precisely
 * the comparison the colour exists to make.
 *
 * `in oklab` because the alternative interpolates through sRGB and takes the
 * green-to-amber leg through a muddy olive that reads as neither.
 */
function effortTone(rank: number): string {
  const clamped = Math.min(1, Math.max(0, rank));
  const position = clamped * 4;
  const stop = Math.min(3, Math.floor(position));
  const mix = Math.round((position - stop) * 100);
  if (mix === 0) return `var(--effort-${stop})`;
  return `color-mix(in oklab, var(--effort-${stop + 1}) ${mix}%, var(--effort-${stop}))`;
}

/** Bars in the little meter drawn on the chip. Four reads at 26px; five does not. */
const EFFORT_BARS = 4;

/**
 * How hard the agent thinks, and the one place to change it.
 *
 * Every runtime here has a reasoning-effort knob and no two spell it the same
 * way — claude runs low through max, kimi is off or on, codex goes as far as
 * `ultra`, omp has an `auto` that decides per prompt. So this control offers
 * exactly what the running runtime published and nothing else. There is no free
 * text and no unified vocabulary: unlike a model name, a level this app invented
 * would either be refused mid-turn or, on pi, warned about on a stderr nobody
 * reads and then silently ignored while the chip claimed it was live.
 *
 * Three things say the level at once, and that redundancy is the design rather
 * than decoration. The **text** names it. The **meter** fills in proportion to
 * where it sits on its own runtime's ladder, which is the only honest way to
 * compare `on` against `xhigh`. The **colour** runs from the same grey as every
 * other chip on the row up to the loudest thing in the palette, so a glance
 * costs nothing. Colour alone would fail a colourblind reader; the meter alone
 * would not catch the eye; the animation — which scales with the level too —
 * would fail anyone who has asked for less motion, and does, deliberately.
 */
function EffortChip({
  current,
  efforts,
  onPick,
  feedback,
}: {
  /** The level in force, as the record or the runtime reported it, if either did. */
  current: string | undefined;
  /** What this runtime says it accepts, cheapest first, or undefined if it says nothing. */
  efforts: EffortChoice[] | undefined;
  onPick: (value: string) => void;
  /** What the server said happened to the last pick made here. */
  feedback?: {
    applied: 'live' | 'sent' | 'pending' | 'cleared' | 'refused';
    message: string;
  } | null;
}): React.JSX.Element | null {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement | null>(null);
  const isPhone = usePhone();

  /**
   * Only the outcomes this control cannot say for itself (issue #119).
   *
   * A change that took effect needs no announcement. The chip redraws the
   * instant it lands — the level named, metered and coloured — so a box beside
   * it reading "Now thinking at high" spends the user's attention repeating
   * what their eye has already reached, and on a phone, where it resolves
   * against the composer rather than against this chip, it repeats it on top of
   * the field they were about to type into.
   *
   * The other four outcomes are precisely the ones the chip gets wrong on its
   * own, so they are still said out loud: a `refused` level was never stored
   * and the conversation is still running at the old one; `sent` is waiting on
   * the runtime's own word in the transcript; and `pending` and `cleared` do
   * not reach the conversation in progress at all — `cleared` least visibly of
   * the three, because the chip has already dropped back to the default it will
   * not actually run at until the next session. Silently swallowing any of
   * those would leave a change looking made that was not.
   */
  const notice = feedback && feedback.applied !== 'live' ? feedback : null;

  /**
   * The answer goes away on its own, after long enough to read it.
   *
   * It used to sit there until the conversation was reset, which made it a
   * permanent fixture rather than a reply: two of these — this one and the model
   * picker's, anchored at the same height — overlap into a pile of opaque boxes,
   * and on a phone, where both resolve against the composer instead of against
   * their own chip, they land on exactly the same coordinates and the older one
   * is simply invisible underneath.
   *
   * Keyed on the answer itself and not on its text, for the reason the model
   * picker's copy of this spells out: two identical outcomes in a row have to be
   * announced twice, and a string dependency cannot tell them apart.
   */
  const [showFeedback, setShowFeedback] = React.useState(false);
  React.useEffect(() => {
    if (!notice) return;
    setShowFeedback(true);
    const timer = setTimeout(() => setShowFeedback(false), 7000);
    return () => clearTimeout(timer);
  }, [notice]);

  React.useEffect(() => {
    if (!open) return;
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

  // Nothing at all rather than a disabled control, and this is the one place
  // this file departs from how the model picker behaves. A model can always be
  // typed at a runtime and tried, so offering it is never wrong. An effort level
  // cannot: with no published ladder there is no value that would be accepted,
  // and a control that can only ever refuse is worse than the space it occupies
  // — especially on a phone, where it would push Send onto its own line to do it.
  if (!efforts?.length) return null;

  const matched = efforts.find((level) => level.value === current);
  // Only what the runtime named. An unrecognised `current` is a level from
  // before a model switch narrowed the ladder, and calling it by its old name
  // would attach this runtime's meter and colour to a level it no longer has.
  const rank = matched?.rank ?? 0;
  const label = matched?.name ?? 'effort';
  const tone = matched ? effortTone(rank) : 'var(--muted-foreground)';
  const filled = matched ? Math.max(1, Math.round(rank * EFFORT_BARS)) : 0;

  // Both scale with the level, so the chip is still at the bottom of the ladder
  // and unmistakable at the top. `rank === 0` gets no animation whatsoever: the
  // least thinking on offer should look like the quietest thing on the row.
  const pulsing = rank > 0;
  const pulse: React.CSSProperties = pulsing
    ? {
        animation: `relay-effort-pulse ${(3.4 - rank * 2.1).toFixed(2)}s var(--ease-in-out) infinite`,
        // Read by the keyframe. Kept as custom properties because a keyframe
        // cannot see a component's props, and hand-writing five keyframes to
        // cover five intensities would fix the ramp to whichever ladder was
        // longest.
        ['--effort-glow-on' as string]: `color-mix(in oklab, ${tone} ${Math.round(24 + rank * 46)}%, transparent)`,
        ['--effort-glow-size' as string]: `${(3 + rank * 6).toFixed(1)}px`,
      }
    : {};

  const pick = (value: string): void => {
    setOpen(false);
    onPick(value);
  };

  return (
    <div style={{ position: isPhone ? 'static' : 'relative', flex: '0 0 auto' }} ref={ref}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Change how hard the agent thinks"
        title={
          // The same rule as the box, and for the same reason: a hover that
          // reads "Now thinking at high" would have displaced the description
          // of what this control *does* for the rest of the conversation, in
          // favour of a sentence the chip beneath the pointer already spells
          // out. An outcome the chip cannot show still takes the slot, so a
          // refusal stays findable after its box has timed out.
          notice?.message
          || (matched
            ? `Effort: ${matched.name}${matched.description ? ` — ${matched.description}` : ''}`
            : 'Effort: whatever this runtime does by default')
        }
        onClick={() => setOpen((value) => !value)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          height: isPhone ? TOUCH_TARGET : 26,
          padding: isPhone ? '0 10px' : '0 8px',
          whiteSpace: 'nowrap',
          background: open ? 'var(--accent)' : 'transparent',
          // The border carries the colour too, at a fraction of it. The same
          // idiom the branch and permission chips use, so a coloured chip on
          // this row looks like the others rather than like a new species.
          border: `1px solid ${matched ? `color-mix(in oklab, ${tone} 42%, var(--border))` : 'var(--border)'}`,
          borderRadius: 'var(--radius)',
          fontFamily: 'var(--font-mono)',
          fontSize: isPhone ? PHONE_TEXT.label : 'var(--text-2xs)',
          color: tone,
          cursor: 'pointer',
          ...pulse,
        }}
      >
        <EffortMeter filled={filled} tone={tone} />
        {label}
        <Icon name="chevron-down" size={9} />
      </button>

      {open ? (
        <div
          role="listbox"
          aria-label="Effort levels"
          style={{
            position: 'absolute',
            right: 0,
            left: isPhone ? 0 : undefined,
            bottom: '100%',
            marginBottom: 6,
            minWidth: isPhone ? 0 : 220,
            maxHeight: isPhone ? '50vh' : 300,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
            padding: 'var(--space-1)',
            background: 'var(--popover)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            boxShadow: 'var(--shadow-popover)',
            animation: 'relay-rise var(--duration-fast) var(--ease-out)',
            zIndex: 'var(--z-dropdown)' as unknown as number,
          }}
        >
          {efforts.map((level) => {
            const selected = level.value === current;
            const levelTone = effortTone(level.rank);
            return (
              <button
                key={level.value}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => pick(level.value)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  minHeight: isPhone ? TOUCH_TARGET : undefined,
                  padding: isPhone ? '8px 12px' : '5px 8px',
                  background: selected ? 'var(--accent)' : 'transparent',
                  border: 0,
                  borderRadius: 'var(--radius)',
                  color: selected ? 'var(--foreground)' : 'var(--muted-foreground)',
                  font: 'inherit',
                  fontSize: isPhone ? PHONE_TEXT.body : 'var(--text-xs)',
                  textAlign: 'left',
                  cursor: 'pointer',
                }}
              >
                {/* The same meter as the chip, so the menu is a ladder you can
                    see rather than a list of words whose order you have to
                    take on trust. */}
                <EffortMeter
                  filled={Math.max(1, Math.round(level.rank * EFFORT_BARS))}
                  tone={levelTone}
                />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ color: levelTone }}>{level.name}</span>
                  {level.description ? (
                    <span
                      style={{
                        display: 'block',
                        color: 'var(--muted-foreground)',
                        fontSize: isPhone ? PHONE_TEXT.meta : 'var(--text-2xs)',
                        whiteSpace: 'normal',
                      }}
                    >
                      {level.description}
                    </span>
                  ) : null}
                </span>
                {selected ? <Icon name="check" size={11} /> : null}
              </button>
            );
          })}

          {/* The way back, for the same reason the model picker has one: every
              row above names a level, so without this a conversation could be
              moved off the runtime's own default and never returned to it. */}
          <button
            type="button"
            role="option"
            aria-selected={!matched}
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

      {!open && notice && showFeedback ? (
        <div
          role="status"
          style={{
            position: 'absolute',
            right: 0,
            // Upward on a phone, and the reason is that `top: 100%` resolves
            // against the composer there rather than against this chip — the
            // wrapper is `static` so the popover can have the composer's width.
            // Below the composer is the bottom navigation bar, which this would
            // cover: an opaque box at `--z-dropdown` sitting on the buttons, or
            // off the screen entirely once the safe-area inset is counted.
            ...(isPhone ? { bottom: '100%', marginBottom: 6 } : { top: '100%', marginTop: 4 }),
            maxWidth: 240,
            padding: '4px 6px',
            background: 'var(--popover)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            // A refusal is the one outcome worth colouring: it means the level
            // was not stored and nothing changed, which a grey note reading like
            // every other grey note would let slide past. The rest are "saved,
            // but not yet" — true, worth reading once, and not worth alarm.
            color: notice.applied === 'refused' ? 'var(--warning)' : 'var(--muted-foreground)',
            fontSize: isPhone ? PHONE_TEXT.body : 'var(--text-2xs)',
            zIndex: 'var(--z-dropdown)' as unknown as number,
          }}
        >
          {notice.message}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The level as bars, for everyone the colour does not reach.
 *
 * `aria-hidden` because the level is already named in text beside it and the
 * button carries its own label; a screen reader announcing four decorative
 * spans would be reading out the picture of the word it just read.
 */
function EffortMeter({ filled, tone }: { filled: number; tone: string }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 1, height: 9, flex: '0 0 auto' }}
    >
      {Array.from({ length: EFFORT_BARS }, (_, index) => (
        <span
          key={index}
          style={{
            width: 2,
            // Rising bars rather than equal ones: the shape says "a scale" on
            // its own, before the fill does, which is what makes an unfilled
            // meter still legible as the bottom of a ladder.
            height: 3 + index * 2,
            background: index < filled ? tone : 'var(--border)',
            transition: 'background var(--duration-base) var(--ease-out)',
          }}
        />
      ))}
    </span>
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
function PlanModeChip({
  on,
  locked,
  feedback,
  onToggle,
}: {
  on: boolean;
  locked: boolean;
  feedback?: { action: string; changed?: boolean; message: string } | null;
  onToggle: (on: boolean) => void;
}): React.JSX.Element {
  const isPhone = usePhone();
  const label = on
    ? 'Plan mode is on — the agent must submit a plan before implementation'
    : 'Plan mode — ask the agent to prepare a plan first';
  const refusal = feedback?.action === 'mode' && feedback.changed === false ? feedback.message : '';
  const reason = locked
    ? 'The agent is preparing a plan right now. This control is available when that turn ends.'
    : refusal;
  return (
    <button
      type="button"
      onClick={() => onToggle(!on)}
      disabled={locked}
      aria-pressed={on}
      aria-label={label}
      title={reason ? `${label}. ${reason}` : label}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto', gap: 5,
        height: isPhone ? TOUCH_TARGET : 26, padding: isPhone ? '0 10px' : '0 8px', whiteSpace: 'nowrap',
        background: on ? 'var(--accent)' : 'transparent', border: `1px solid ${on ? 'var(--ring)' : 'var(--border)'}`,
        borderRadius: 'var(--radius)', fontFamily: 'var(--font-sans)', fontSize: isPhone ? PHONE_TEXT.label : 'var(--text-2xs)',
        color: on ? 'var(--foreground)' : 'var(--muted-foreground)', opacity: locked ? 0.5 : 1,
        cursor: locked ? 'not-allowed' : 'pointer',
      }}
    >
      <Icon name="list-todo" size={isPhone ? 14 : 12} />
      <span>{on ? 'Plan on' : 'Plan'}</span>
    </button>
  );
}

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
 * The line of messages waiting to be sent.
 *
 * One waiting message is drawn as it always was. Past that the list collapses
 * to the newest message alone, with the rest behind a count — because the list
 * grows to twenty, each row is full width, and twenty rows push the
 * conversation off the top of the screen and, on a phone, the composer itself
 * off the bottom. A queue you cannot see past is worse than a queue you cannot
 * read all of at once.
 *
 * The newest is the one on show, not the one about to be sent: it is what you
 * just typed and are still deciding about, and the one you are most likely to
 * withdraw.
 *
 * The disclosure control lives *on that row* rather than on a line of its own,
 * which is what keeps a collapsed queue of twenty exactly as tall as a queue of
 * one. It stays on that row when the list is open, so it is the same mounted
 * button either way and the keyboard does not lose its place on toggling.
 */
function QueuedList({
  queued,
  onCancelQueued,
  onSendQueuedNow,
  onRetryQueued,
}: {
  queued: QueuedTurn[];
  onCancelQueued?: (id: string) => void;
  onSendQueuedNow?: (id: string) => void;
  onRetryQueued?: (id: string) => void;
}): React.JSX.Element {
  // Held here, above the rows, so a message arriving or leaving re-renders the
  // list without deciding for the user whether it is open. Nothing reaches in
  // to set it: an open list stays open as the queue grows, a closed one stays
  // closed, and neither springs on the user mid-sentence.
  const [open, setOpen] = React.useState(false);
  const isPhone = usePhone();
  const listId = React.useId();
  const listRef = React.useRef<HTMLDivElement | null>(null);

  // Opening scrolls to the end, so the list appears to grow *upwards* out of
  // the row that was already there. Without this the box opens at the top of a
  // queue of twenty and the newest message — the one being looked at, and the
  // one carrying the control that closes the list again — is off the bottom of
  // its own scrolling space with nothing saying where it went.
  //
  // On the open itself only: re-running it as messages arrive would yank the
  // list back down under someone reading their way up it.
  React.useEffect(() => {
    if (!open) return;
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [open]);

  // A message that could not be handed over is never folded away (#89).
  // Staying silent about it is the one thing the queue must not do, and a
  // failed row hidden behind a "+3" is silence with an extra step.
  const foldable = queued.filter(
    (turn, index) => !turn.error && index !== queued.length - 1,
  ).length;
  const collapsible = foldable > 0;
  const collapsed = collapsible && !open;
  const hidden = foldable;
  const rows = collapsed
    ? queued.filter((turn, index) => Boolean(turn.error) || index === queued.length - 1)
    : queued;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <div
        id={listId}
        ref={listRef}
        role="list"
        aria-label="Messages waiting to be sent"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-1)',
          // Opened, the list is bounded and scrolls inside its own space. Left
          // to grow it would do exactly what collapsing exists to prevent —
          // twenty rows is taller than a phone screen, so the composer and the
          // conversation would both be gone.
          ...(collapsible && open
            ? { maxHeight: isPhone ? '30vh' : 260, overflowY: 'auto', overscrollBehavior: 'contain' }
            : null),
        }}
      >
        {rows.map((turn) => {
          const position = queued.indexOf(turn) + 1;
          return (
            <QueuedChip
              key={turn.id}
              turn={turn}
              position={position}
              onCancel={onCancelQueued ? () => onCancelQueued(turn.id) : undefined}
              onSendNow={onSendQueuedNow ? () => onSendQueuedNow(turn.id) : undefined}
              onRetry={onRetryQueued ? () => onRetryQueued(turn.id) : undefined}
              disclosure={
                collapsible && position === queued.length
                  ? { open, hidden, listId, onToggle: () => setOpen((was) => !was) }
                  : undefined
              }
            />
          );
        })}
      </div>
      {/* The count changes as the agent works through the line and as you add
          to it, and a number that only exists as a glyph on a button changes
          silently. Announced politely, so it waits its turn rather than cutting
          across what is being read. */}
      <span role="status" aria-live="polite" style={queueCountStyle}>
        {collapsible
          ? collapsed
            ? `${queued.length} messages waiting to be sent, ${hidden} hidden`
            : `${queued.length} messages waiting to be sent, all shown`
          : ''}
      </span>
    </div>
  );
}

const queueCountStyle: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

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
  onSendNow,
  onRetry,
  disclosure,
}: {
  turn: QueuedTurn;
  position: number;
  onCancel?: () => void;
  onSendNow?: () => void;
  onRetry?: () => void;
  disclosure?: { open: boolean; hidden: number; listId: string; onToggle: () => void };
}): React.JSX.Element {
  const attachments = turn.attachments?.length ?? 0;
  // One press, whatever the click count: the server settles a double click on
  // its own — the id leaves the queue before anything is interrupted — but this
  // saves the second round trip and stops the row flashing twice.
  //
  // Released again after a moment rather than latched: a promotion the server
  // declines (it was already delivering something else) leaves this row on
  // screen, and a control that is dead for the rest of the conversation is a
  // worse outcome than the double click it was guarding against.
  const [sending, setSending] = React.useState(false);
  React.useEffect(() => {
    if (!sending) return undefined;
    const timer = setTimeout(() => setSending(false), 2500);
    return () => clearTimeout(timer);
  }, [sending]);
  const isPhone = usePhone();
  // A message that could not be handed over is still here, with its text, and
  // says so where it sits — the alternative the queue used to offer was
  // silence, which is the one thing a queue must never do (#89).
  const failed = Boolean(turn.error);
  return (
    <div
      role="listitem"
      style={{
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        // The row carries two controls that do opposite things to the same
        // message, and on a phone they are 44px targets side by side: below the
        // touch floor the seam between them is invisible and "send this now"
        // and "throw this away" become one strip.
        gap: isPhone ? TOUCH_GAP : 7,
        minHeight: 26,
        padding: '2px 4px 2px 7px',
        background: 'var(--muted)',
        border: `1px solid ${failed ? 'var(--destructive)' : 'var(--border)'}`,
        borderRadius: 'var(--radius)',
        color: 'var(--muted-foreground)',
        fontSize: 'var(--text-2xs)',
        animation: 'relay-chip-in var(--duration-base) var(--ease-out)',
      }}
    >
      {disclosure ? (
        // Not an IconButton: the count is the point, and a number is not
        // legible inside an 18px square. Kept at the far left, as far from the
        // control that throws the message away as the row allows.
        <button
          type="button"
          onClick={disclosure.onToggle}
          aria-expanded={disclosure.open}
          aria-controls={disclosure.listId}
          aria-label={
            disclosure.open
              ? `Hide the ${disclosure.hidden} other waiting messages`
              : `Show ${disclosure.hidden} more waiting ${disclosure.hidden === 1 ? 'message' : 'messages'}`
          }
          title={
            disclosure.open
              ? `Hide the ${disclosure.hidden} other waiting messages`
              : `Show ${disclosure.hidden} more waiting ${disclosure.hidden === 1 ? 'message' : 'messages'}`
          }
          style={{
            flex: '0 0 auto',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 2,
            minWidth: isPhone ? TOUCH_TARGET : 30,
            minHeight: isPhone ? TOUCH_TARGET : 20,
            padding: '0 4px',
            borderRadius: 'var(--radius)',
            border: '1px solid var(--border)',
            background: 'transparent',
            color: 'var(--muted-foreground)',
            font: 'inherit',
            fontFamily: 'var(--font-mono)',
            fontVariantNumeric: 'tabular-nums',
            cursor: 'pointer',
          }}
        >
          <Icon name={disclosure.open ? 'chevron-down' : 'chevron-right'} size={10} />
          {disclosure.open ? null : `+${disclosure.hidden}`}
        </button>
      ) : null}
      <span
        aria-hidden="true"
        style={{
          flex: '0 0 auto',
          fontFamily: 'var(--font-mono)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {failed ? <Icon name="circle-alert" size={11} /> : position}
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
      {onSendNow ? (
        // Deliberately said in full rather than "Send now": the two controls on
        // this row do opposite things to the same message, and a screen reader
        // moving between them has only these two labels to tell them apart.
        <IconButton
          type="button"
          size="sm"
          label={`Send queued message ${position} now, interrupting the agent`}
          disabled={sending}
          onClick={() => {
            setSending(true);
            onSendNow();
          }}
        >
          <Icon name="arrow-up" size={11} />
        </IconButton>
      ) : null}
      {failed && onRetry ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          iconLeft={<Icon name="rotate-cw" size={11} />}
          onClick={onRetry}
          style={{ flex: '0 0 auto', fontSize: 'var(--text-2xs)' }}
        >
          Try again
        </Button>
      ) : null}
      {onCancel ? (
        <IconButton
          type="button"
          size="sm"
          label={failed ? `Discard the message that could not be sent` : `Remove queued message ${position}`}
          onClick={onCancel}
        >
          <Icon name="x" size={11} />
        </IconButton>
      ) : null}
      {failed ? (
        // Its own line, full width: the reason is a sentence, and squeezing it
        // beside a message that is already being ellipsised would leave
        // neither readable. `alert` so it is announced when it appears —
        // nobody is looking at the composer while a queue works through.
        <span
          role="alert"
          style={{ flex: '1 0 100%', color: 'var(--destructive)', whiteSpace: 'normal' }}
        >
          Not sent: {turn.error}
        </span>
      ) : null}
    </div>
  );
}

/**
 * One file on the unsent message.
 *
 * Named rather than handed an entry, because there are now two kinds of thing
 * behind an identical chip: a `File` this window is still uploading, and an
 * attachment the conversation has — which may have been picked on somebody
 * else's screen and reached this one down the socket. What a chip needs is a
 * name, a size and something to draw, and both kinds can give all three.
 */
export function AttachmentChip({
  name,
  size,
  mime,
  file,
  preview: previewUrl,
  status = 'done',
  error,
  onRetry,
  onRemove,
}: {
  name: string;
  size: number;
  mime: string;
  /** Present only while this window is the one uploading it. */
  file?: File;
  /** The server's copy, for a file that has finished going up. */
  preview?: string;
  status?: 'uploading' | 'done' | 'error';
  error?: string;
  /** Present for a failed local upload; retry reuses its identity and order. */
  onRetry?: () => void;
  onRemove: () => void;
}) {
  const failed = status === 'error';
  const isImage = mime.startsWith('image/');
  // The local file wins while there is one: it is already in memory, so the
  // thumbnail appears the instant the file is picked rather than after a round
  // trip. Once the upload lands there is no `File` any more and the server's own
  // url takes over — which is also the only one a second screen ever has.
  const objectUrl = useObjectUrl(isImage && !failed && file ? file : null);
  const preview = objectUrl ?? (isImage && !failed ? previewUrl : null) ?? null;
  const icon = failed ? 'circle-alert' : isImage ? 'image' : 'file-text';
  const download = status === 'done' ? safeAttachmentDownloadUrl(previewUrl) : null;
  const identity = (
    <>
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
            animation: status === 'uploading' ? 'relay-pulse 1.2s var(--ease-in-out) infinite' : undefined,
          }}
        >
          <Icon name={icon} size={11} />
        </span>
      )}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
    </>
  );

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
        opacity: status === 'uploading' ? 0.75 : 1,
        animation: 'relay-chip-in var(--duration-base) var(--ease-out)',
        transition: 'opacity var(--duration-base) var(--ease-standard)',
      }}
      title={failed ? error : `${name} (${formatBytes(size)})`}
    >
      {download ? (
        <a
          href={download}
          download={name}
          aria-label={`Download ${name}`}
          title={`Download ${name}`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            minWidth: 0,
            color: 'inherit',
            textDecoration: 'none',
          }}
        >
          {identity}
        </a>
      ) : (
        identity
      )}
      <span style={{ flex: '0 0 auto', color: 'var(--muted-foreground)' }}>{formatBytes(size)}</span>
      {failed && onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          aria-label={`Retry ${name}`}
          title={`Retry uploading ${name}`}
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
          <Icon name="refresh-cw" size={10} />
        </button>
      ) : null}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${name}`}
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
