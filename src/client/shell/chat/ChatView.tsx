import * as React from 'react';
import { ChatAttachment, ChatDraft, ChatState } from '../../../shared/chat-events.js';
import { uploadAttachment } from '../../chat/attachments-api.js';
import { branchConversation, type BranchedConversation } from '../../chat/branch-api.js';
import {
  ChatController,
  createBuiltInWorkflowRequestId,
  type ChatUnavailable,
} from '../../chat/controller.js';
import { fetchStatus, findFiles } from '../../chat/workspace-api.js';
import { activityEvents } from '../../chat/activity.js';
import { loadEffortPreferences, rememberEffort } from '../../chat/effort-preference.js';
import type { WorkspaceFileTarget } from '../../chat/file-links.js';
import type { ChatTranscript } from '../../chat/transcript.js';
import {
  groupTurns,
  isTurnOpen,
  reconcileTurns,
  turnIndexRows,
  turnOf,
  type TurnSummary,
} from '../../chat/turns.js';
import type { ChatPanelId, ChatViewSettings } from '../../chat/view-settings.js';
import {
  DEFAULT_CHAT_VIEW,
  clampTerminalHeight,
  enabledPanels,
  proseVariables,
} from '../../chat/view-settings.js';
import { Button } from '../../ui/relay/Button.js';
import { Icon } from '../../ui/relay/Icon.js';
import { IconButton } from '../../ui/relay/IconButton.js';
import { showNotification } from '../../ui/notifications.js';
import { PhoneContext } from '../../ui/touch.js';
import { visualViewportKeyboardInset } from '../../ui/keyboard-viewport.js';
import { FloatingMenu } from '../FloatingMenu.js';
import { KEY_STRIP_HEIGHT } from '../KeyStrip.js';
import { Composer } from './Composer.js';
import { FileEditorDialog } from './FileEditorDialog.js';
import { MessageList, type MessageListHandle } from './MessageList.js';
import { hasVisibleContent, messageText } from './MessageBubble.js';
import { PermissionCard } from './PermissionCard.js';
import { QuestionCard } from './QuestionCard.js';
import { PlanPanel } from './PlanPanel.js';
import { PlanDocDialog } from './PlanDocDialog.js';
import { SessionHeader } from './SessionHeader.js';
import { LiveStreamRibbon } from './StreamRibbon.js';
import { TerminalSplit } from './TerminalSplit.js';
import { TracePanel } from './TracePanel.js';
import { TranscriptSearch } from './TranscriptSearch.js';
import { TurnIndex } from './TurnIndex.js';
import { WorkspacePanel } from './WorkspacePanel.js';
import { WorkspaceFileLinkContext } from './WorkspaceFileLinkContext.js';
import { chatCommandFor, isTextEntry } from './keymap.js';

/**
 * The chat surface, assembled: three zones and one optional split.
 *
 * Left, a turn index — the conversation as a list of the things that were
 * asked. Middle, the transcript: prose, grouped into turns under a sticky
 * header, with a real pty split beneath it and the composer under that. Right,
 * the rail: the plan and the trace timeline, which is where reasoning and tool
 * calls now live, alongside the workspace panels this app already had.
 *
 * One subscription, at this level only. The transcript's version counter says
 * "something moved", which is all the header, the index and the rails need — a
 * streaming turn moves one message thousands of times and MessageList already
 * splits that traffic down to the single bubble that changed. Copying the
 * transcript into React state here would undo that split and rebuild the whole
 * conversation per token.
 *
 * The two regions below the transcript — approvals and the composer — are
 * outside the scroller on purpose. A blocked agent and the only control that
 * unblocks it must not be something the user can scroll away from, and no panel
 * toggle may hide them either.
 */

export interface ChatViewProps {
  controller: ChatController;
  runtime: string;
  runtimeLabel: string;
  workingDir: string;
  serverName?: string;
  isMobile?: boolean;
  /**
   * The account's approval preference, which is what a conversation *started*
   * from here would run in.
   *
   * Only the recovery notice reads it, and only to label its buttons. The
   * conversation's own mode comes off the transcript — the two are different
   * facts, and telling them apart on screen is the whole of #134: "Resume this
   * conversation" restores the mode this conversation had, while "Start a new
   * chat" begins one in the mode the preference names.
   */
  approvalPreference?: boolean;
  /**
   * Opens the chat's own display settings — not the app's.
   *
   * The two were the same dialog, which meant the gear inside a conversation
   * offered font size, terminal typeface and install: a page of controls that
   * could not change anything on the surface they were reached from.
   */
  onOpenSettings?: () => void;
  /**
   * Open the list of every conversation this user has.
   *
   * Owned by the shell, which is where the dialog is rendered — a conversation
   * cannot host the list of conversations it is one of. Absent leaves the control
   * out entirely rather than drawing one that does nothing.
   */
  onOpenConversations?: () => void;
  /** What this surface shows. Zones, panels, reasoning, tool calls, usage. */
  view?: ChatViewSettings;
  /** Persist a change made from inside the surface, e.g. closing the rail. */
  onViewChange?: (next: ChatViewSettings) => void;
  theme?: 'dark' | 'light';
  onToggleTheme?: () => void;
  /**
   * The shell's own menu entries — sessions, new, more.
   *
   * Passed down rather than this surface's being passed up, because the menu
   * has to be positioned by whoever knows where the composer is. Anchored to
   * the shell it sat exactly on top of the send button; anchored to the
   * transcript it floats over the conversation and clears everything.
   */
  menuActions?: SurfaceAction[];
  /**
   * Put a conversation this surface created in front of the user.
   *
   * Branching makes a second conversation, and opening a tab on it is the
   * shell's job rather than this component's — this one only knows about the
   * conversation it is showing. Absent, a branch is still made and recorded and
   * the user is told where to find it, which is a weaker outcome than a new tab
   * but not a control that silently did nothing.
   */
  onOpenConversation?: (conversation: BranchedConversation) => void;
}

/** One control on the phone's floating menu. */
export interface SurfaceAction {
  id: string;
  label: string;
  icon: string;
  onPress(): void;
  active?: boolean;
  expands?: boolean;
  toggle?: boolean;
  badge?: boolean;
  disabled?: boolean;
  group?: string;
}

/**
 * Below this the header sheds its decoration.
 *
 * Measured against the real worst case rather than guessed: a bypass badge, a
 * long branch, a deep working directory and six-figure token counts together
 * need about 1000px before something is pushed off the right edge.
 */
const COMPACT_HEADER_AT = 1100;

/** Below this the turn index becomes a numbers-only rail. */
const COLLAPSE_INDEX_AT = 1280;
/** Below this it goes away entirely and lives in a sheet. */
const HIDE_INDEX_AT = 1024;

/** Touch-target floor for this app's phone layout; matches IconButton size="lg". */
const TOUCH = 34;

export function ChatView({
  controller,
  runtime,
  runtimeLabel,
  workingDir,
  serverName,
  isMobile = false,
  approvalPreference = false,
  onOpenSettings,
  onOpenConversations,
  view = DEFAULT_CHAT_VIEW,
  onViewChange,
  theme,
  onToggleTheme,
  menuActions,
  onOpenConversation,
}: ChatViewProps) {
  const transcript = controller.transcript;

  // The returned version is deliberately unused: everything below reads the
  // transcript's live getters, and the subscription is here only to schedule
  // the render in which they are read. Static rendering has no store at all,
  // so the third argument is required or React throws — same constant
  // MessageList passes for the same reason.
  const version = React.useSyncExternalStore(transcript.subscribe, transcript.getVersion, ZERO);

  const chatState = transcript.chatState;
  /**
   * Read off the transcript, so it is this conversation's mode and not the
   * shell's last one.
   *
   * The badge is not a launch-time notice: as long as this is true the session
   * acts without asking, so it has to stay on screen for the conversation's
   * whole life — including while nothing is running it, which is exactly the
   * case a shared shell-level flag got wrong.
   */
  const bypassPermissions = transcript.bypassing;
  const plan = transcript.plan;
  const pending = transcript.pendingPermissions;
  // Only *pending* legacy/incomplete questions that have nowhere else to be
  // drawn. Tool questions live at their call and structured-response fallbacks
  // are folded into an assistant message as durable question blocks. Settled
  // history never belongs in this assertive composer-adjacent safety net: in a
  // paged conversation its original message may simply not be loaded yet.
  const strayQuestions = React.useMemo(
    () =>
      transcript.pendingQuestions.filter(
        (request) => {
          if (request.toolId && transcript.message(messageIdOfTool(transcript, request.toolId))) {
            return false;
          }
          return !transcript.messages.some((message) => message.blocks.some(
            (block) => block.kind === 'question'
              && block.request.requestId === request.requestId,
          ));
        },
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [transcript, version],
  );
  const exited = chatState === 'exited';
  const transportUnavailable = !controller.connectionAvailable;
  const unavailable = controller.unavailableReason;
  const workflowUnavailableReason = !controller.builtInWorkflowsAvailable
    ? 'This server does not support guided workflows.'
    : transportUnavailable
      ? `${serverName || 'This server'} is unavailable. Reconnect it to use server actions.`
      : unavailable?.message
      ?? (exited
        ? 'This conversation has ended.'
        : !transcript.live
          ? 'This conversation is not running. Resume it before creating an issue.'
          : null);
  const busy = transcript.busy;
  const planLocked = transcript.live
    && chatState !== 'idle'
    && chatState !== 'exited'
    && chatState !== 'error';
  // Wider than `busy`, which is only what the send button needs to know: a turn
  // that is waiting on an approval or a question is still a turn in flight, and
  // it is the one a queued correction most often needs to get in front of.
  // And narrower in one way: a runtime that cannot be interrupted cannot be cut
  // in front of, so offering the control there would promise something the
  // server is right to refuse.
  const interruptible =
    Boolean(transcript.capabilities.interrupt)
    && (busy || chatState === 'awaiting_permission' || chatState === 'awaiting_answer');

  const messages = React.useMemo(
    () => transcript.messages,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [transcript, version],
  );

  // Derived per render and memoised on the version counter, never stored.
  // Turn grouping is a view of the transcript, and a second copy of it in state
  // is a second thing that can be wrong about the conversation.
  // The conversation's own turns, not the loaded window's. Grouping is what the
  // window can answer; the number each turn carries and the words it is named
  // by are facts about the conversation, and come from the recording (#86).
  const recorded = transcript.recordedTurns;
  // What each finished turn cost, as the accounting filed it — see `spendFor`.
  // Read through the version counter like everything else here: it arrives with
  // the index and then one turn at a time as they end.
  const spend = React.useMemo(
    () => transcript.turnSpend,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [transcript, version],
  );
  const turns = React.useMemo(
    () => reconcileTurns(groupTurns(messages, chatState), recorded, spend),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messages, version, chatState, recorded, spend],
  );
  // The index lists the conversation, not the part of it this browser holds:
  // the recorded run of turns with the live ones laid over it.
  const indexRows = React.useMemo(
    () => turnIndexRows(recorded, turns, spend),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [recorded, turns, version],
  );
  // Whether that list reaches the conversation's first turn. Past the retention
  // cap the server trims the head of the log and says so — and nothing on
  // screen has ever repeated it, so a list of the surviving turns has been
  // presenting itself as the whole conversation (#86). Read on every render
  // rather than memoised: it arrives with the index, which moves the version
  // counter this whole component already redraws on.
  const indexComplete = controller.recordedTurnsComplete;
  const [selectedTurnId, setSelectedTurnId] = React.useState<string | null>(null);
  const lastTurnId = turns.length ? turns[turns.length - 1].id : '';
  // A selection that no longer exists — the conversation was cleared, or the
  // turn scrolled out of the loaded window — falls back to the newest rather
  // than leaving the index highlighting nothing.
  // Checked against the index rather than the loaded turns: choosing an entry
  // from before what is held is the case the index exists for, and a guard that
  // only knew the loaded ones dropped the highlight the instant it was set
  // (#86). A selection that is in neither — the conversation was cleared —
  // still falls back to the newest rather than highlighting nothing.
  const currentTurnId =
    selectedTurnId && indexRows.some((row) => row.id === selectedTurnId)
      ? selectedTurnId
      : lastTurnId;

  // A turn's fold state, once the user has set it explicitly. Unset, a turn
  // reads as open exactly when it is the newest one — see isTurnOpen — which
  // is what makes a fresh turn open itself and everything before it fold
  // without this ever growing an entry for turns nobody has touched.
  const [openOverrides, setOpenOverrides] = React.useState<Map<string, boolean>>(new Map());
  const openTurnIds = React.useMemo(() => {
    const ids = new Set<string>();
    for (const turn of turns) {
      if (isTurnOpen(turn.id, lastTurnId, openOverrides)) ids.add(turn.id);
    }
    return ids;
  }, [turns, lastTurnId, openOverrides]);

  const toggleTurn = React.useCallback(
    (turnId: string) => {
      setOpenOverrides((prev) => {
        const next = new Map(prev);
        next.set(turnId, !isTurnOpen(turnId, lastTurnId, prev));
        return next;
      });
    },
    [lastTurnId],
  );

  // Idempotent, so a jump into an already-open turn does not thrash the map.
  const openTurn = React.useCallback(
    (turnId: string) => {
      setOpenOverrides((prev) => {
        if (isTurnOpen(turnId, lastTurnId, prev)) return prev;
        const next = new Map(prev);
        next.set(turnId, true);
        return next;
      });
    },
    [lastTurnId],
  );

  const expandAllTurns = React.useCallback(() => {
    setOpenOverrides(() => new Map(turns.map((turn) => [turn.id, true])));
  }, [turns]);

  const collapseAllTurns = React.useCallback(() => {
    setOpenOverrides(() => new Map(turns.map((turn) => [turn.id, false])));
  }, [turns]);

  const [searchOpen, setSearchOpen] = React.useState(false);
  /** The index row whose turn is being paged in, or null. See `selectTurn`. */
  const [seeking, setSeeking] = React.useState<string | null>(null);
  // Paired with a nonce, not held as a bare id: clicking the same work counter
  // twice has to scroll the rail twice, and a string that did not change would
  // leave the timeline's effect with nothing to react to.
  const [focus, setFocus] = React.useState<{ id?: string; nonce: number }>({ nonce: 0 });
  const [indexSheet, setIndexSheet] = React.useState(false);
  const [planOpen, setPlanOpen] = React.useState(false);
  const [planAction, setPlanAction] = React.useState<'accept' | 'reject' | null>(null);
  const [planSheet, setPlanSheet] = React.useState(false);
  // A draft seed, not a controlled value: making the composer controlled would
  // re-render this component — and re-derive the turns and the whole activity
  // projection — on every keystroke.
  const [seed, setSeed] = React.useState<{ key: number; text: string }>({ key: 0, text: '' });
  // A half-typed message belongs to the conversation it was typed into, and to
  // the person typing it rather than to the window they happen to be at. The
  // surface is keyed by session id and remounts on a tab switch, so without this
  // the draft is destroyed by looking at another chat for a moment — and without
  // the sync behind it, by picking up a different device (#163).
  const [draft, setDraft] = useSyncedDraft(controller);
  // Unlike the synchronized composer, this popup draft is local to the active
  // conversation. It lives above the conditional rail so closing the rail or
  // crossing the phone breakpoint cannot destroy it.
  const [issueDraft, setIssueDraft] = React.useState(() => ({
    text: '',
    requestId: createBuiltInWorkflowRequestId(),
  }));
  const setIssuePrompt = React.useCallback((text: string) => {
    setIssueDraft((current) => current.text === text
      ? current
      : { text, requestId: createBuiltInWorkflowRequestId() });
  }, []);
  React.useEffect(() => {
    setIssueDraft({ text: '', requestId: createBuiltInWorkflowRequestId() });
  }, [controller.sessionId]);
  // Shared by the transcript and both workspace tabs. Keeping it above the
  // rail means a code link can open the same popup even while that rail is
  // closed, and closing the rail no longer closes a file somebody is reading.
  const [editing, setEditing] = React.useState<WorkspaceFileTarget | null>(null);

  const planFeedback = controller.planFeedback;
  React.useEffect(() => {
    if (!planAction || !planFeedback || planFeedback.action !== planAction) return;
    setPlanAction(null);
    if (planFeedback.accepted !== true) return;
    setPlanOpen(false);
    if (planAction === 'reject') {
      window.setTimeout(
        () => root.current?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.focus(),
        0,
      );
    }
  }, [planAction, planFeedback]);

  const list = React.useRef<MessageListHandle | null>(null);
  const root = React.useRef<HTMLElement | null>(null);
  const terminalRegion = React.useRef<HTMLDivElement | null>(null);
  const width = useElementWidth(root);
  const keyboardInset = useKeyboardInset(isMobile);
  const branch = useBranch(controller.sessionId, version);

  const openFile = React.useCallback((path: string) => {
    setEditing({ path });
  }, []);

  const openLinkedFile = React.useCallback((target: WorkspaceFileTarget) => {
    setEditing(target);
  }, []);
  const workspaceFileLinks = React.useMemo(
    () => ({ workingDir, onOpen: openLinkedFile }),
    [openLinkedFile, workingDir],
  );

  const setView = React.useCallback(
    (patch: Partial<ChatViewSettings>) => onViewChange?.({ ...view, ...patch }),
    [onViewChange, view],
  );

  /**
   * Open a fresh conversation at the level this runtime was last used at.
   *
   * The other half of `setEffort` below. That one records the choice; this one
   * is what makes recording it worth anything — without it a preference would
   * be written on every pick and read by nobody.
   *
   * Five conditions, and each rules out a way of being wrong.
   *
   * **It only touches a conversation that has not started.** This is the one
   * that matters, and the one this was first written without. Every other guard
   * is equally true of a conversation opened weeks ago and merely looked at
   * again: the surface is keyed on the session id so this effect remounts on
   * every tab switch, `live` and the published ladder both survive on the
   * retained transcript, and a conversation whose chip was never touched carries
   * no override — so clicking a tab silently re-levelled it, wrote the level to
   * its record, and on claude pushed a hidden `/effort` turn into the running
   * process. A preference is for opening the *next* conversation, never for
   * reaching back into one already under way. An empty transcript is what says
   * "this one has not begun".
   *
   * It waits for the runtime to publish a ladder, because until then there is
   * nothing to check a remembered level against and the server would rightly
   * refuse it. It only acts when the record carries no level of its own, so a
   * conversation that has already been set is never quietly moved off it. It
   * checks the level is still on the ladder, because a runtime can narrow one
   * (codex publishes the ladder of the *current* model, and models differ) and a
   * stale favourite must not become a refusal the user has to read. And it fires
   * once per session, so this cannot become a loop with a server that answers
   * `pending`.
   */
  const seededEffort = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (seededEffort.current === controller.sessionId) return;
    if (!transcript.live) return;
    if (transcript.messages.length > 0) return;
    const ladder = transcript.capabilities.efforts;
    if (!ladder?.length) return;
    if (controller.effortOverrideValue) return;
    const remembered = loadEffortPreferences()[runtime];
    if (!remembered || !ladder.some((level) => level.value === remembered)) return;
    seededEffort.current = controller.sessionId;
    controller.setEffort(remembered);
  }, [controller, runtime, transcript, version]);

  // ------------------------------------------------------------------ zones

  const panelsAvailable = enabledPanels(view).length > 0;
  // One answer for both, so the phone's bottom bar can drive it. It used to be
  // separate local state on a phone, which meant the rail was open according to
  // this component and shut according to everything outside it — including the
  // bar that now has to paint which destination you are on.
  const railOpen = panelsAvailable && view.panelOpen;
  // On a phone the rail replaces the conversation rather than sitting beside
  // it: 344px of panel next to a 390px viewport leaves neither usable.
  const railTakesOver = isMobile && railOpen;

  const toggleRail = React.useCallback(() => {
    setView({ panelOpen: !view.panelOpen });
  }, [setView, view.panelOpen]);

  const openRail = React.useCallback(
    (panelTab: ChatPanelId) => {
      if (!view.panelOpen || view.panelTab !== panelTab) setView({ panelOpen: true, panelTab });
    },
    [setView, view.panelOpen, view.panelTab],
  );

  const narrow = width > 0 && width < HIDE_INDEX_AT;
  const indexVisible = view.indexOpen && !isMobile && !narrow;
  const indexCollapsed = width > 0 && width < COLLAPSE_INDEX_AT;
  const compactHeader = width > 0 && width < COMPACT_HEADER_AT;

  const terminalOpen = view.terminalOpen && !exited;

  // ------------------------------------------------------------- callbacks

  const send = React.useCallback(
    (text: string, attachments: ChatAttachment[]) => {
      // Named as the composer's own send, which is what empties the shared
      // draft: a turn sent again from the transcript goes through the same
      // method and must leave a half-written message alone. See sendTurn.
      if (!controller.sendTurn(text, attachments, { fromComposer: true })) return;
      // Emptied here, before the composer empties itself. It clears the text and
      // the files one after the other, and each of those is a publishable state
      // — so without this the account's other screens would watch the message
      // they just saw sent come apart in halves. Cleared first, both of those
      // land on a composer that is already empty and say nothing at all.
      setDraft(EMPTY_DRAFT);
      // Asking for something new is the end of wherever you were going: the
      // list pins to the bottom for the answer, and a jump landing afterwards
      // would scroll the reply away.
      controller.cancelSeek();
      setSeeking(null);
      list.current?.pin();
      setSelectedTurnId(null);
    },
    [controller],
  );
  const interrupt = React.useCallback(() => {
    controller.interrupt();
    // Forced, like send and jump-to-latest: stopping a turn is a moment you
    // want to be looking at its end, not wherever you had scrolled to.
    list.current?.pin();
  }, [controller]);
  const startGitHubIssue = React.useCallback(
    async (prompt: string, requestId: string) => {
      // This is not composer submission: preserving that draft is important
      // when the issue interview is queued behind a current turn.
      await controller.startBuiltInWorkflow('gh-issue', prompt, requestId);
      controller.cancelSeek();
      setSeeking(null);
      setSelectedTurnId(null);
      list.current?.pin();
      if (isMobile) setView({ panelOpen: false });
      // At this point the popup handoff is complete and its success path will
      // clear the retained prompt/id. The server may now release its dedupe
      // entry; before this point a timeout or local failure must remain safe to
      // retry with the same id.
      controller.acknowledgeBuiltInWorkflow('gh-issue', requestId);
    },
    [controller, isMobile, setView],
  );
  const loadMore = React.useCallback(() => controller.loadMore(), [controller]);
  const respond = React.useCallback(
    (requestId: string, optionId: string) => controller.respondPermission(requestId, optionId),
    [controller],
  );
  const answerQuestion = React.useCallback(
    (requestId: string, optionIds: string[], skipped: boolean, text?: string) =>
      controller.answerQuestion(requestId, optionIds, skipped, text),
    [controller],
  );
  const cancelQueued = React.useCallback(
    (queuedId: string) => controller.cancelQueued(queuedId),
    [controller],
  );
  const sendQueuedNow = React.useCallback(
    (queuedId: string) => controller.sendQueuedNow(queuedId),
    [controller],
  );
  const retryQueued = React.useCallback(
    (queuedId: string) => controller.retryQueued(queuedId),
    [controller],
  );
  const setModel = React.useCallback(
    (model: string) => controller.setModel(model),
    [controller],
  );
  /**
   * Send the level, and remember it for the next conversation on this runtime.
   *
   * Two different memories, written in the same breath. The server is told
   * because this conversation has to actually run at the level; the browser is
   * told because the next new conversation on this runtime should open there
   * rather than back at the default, which is what "remember the last setting"
   * means to somebody who has just set it.
   *
   * Stored on the way out rather than on the server's reply, and on purpose:
   * `pending` and `sent` mean the running session did not take the level, but
   * the *choice* was still made and a fresh session is exactly where it would
   * apply. Waiting for `live` would drop the preference in precisely the case
   * it is most useful — a runtime that can only take a level at launch.
   */
  const setEffort = React.useCallback(
    (effort: string) => {
      controller.setEffort(effort);
      rememberEffort(runtime, effort || null);
    },
    [controller, runtime],
  );
  const upload = React.useCallback(
    (file: File) => uploadAttachment(controller.sessionId, file),
    [controller],
  );
  const findProjectFiles = React.useCallback(
    (query: string) => findFiles(controller.sessionId, query).then((result) => result.matches),
    [controller],
  );

  const selectTurn = React.useCallback(
    (id: string) => {
      setSelectedTurnId(id);
      // The strip itself is always mounted, open or not, so this can scroll
      // immediately — only a jump *inside* a turn's body needs to wait for it
      // to open first. See revealMessage.
      openTurn(id);
      if (messages.some((message) => message.id === id)) {
        controller.cancelSeek();
        setSeeking(null);
        list.current?.scrollToTurn(id);
        return;
      }
      // An entry from before what is loaded. The index lists the whole
      // conversation, so choosing one has to fetch it rather than quietly do
      // nothing — the scroll waits until it is actually here.
      //
      // Held here as well as on the controller because this is what redraws:
      // the transcript's version counter is what this surface subscribes to,
      // and "a jump is in flight" is not something the transcript knows.
      setSeeking(id);
      void controller.seekTo(id).then((outcome) => {
        setSeeking((current) => (current === id ? null : current));
        if (outcome === 'arrived') {
          list.current?.scrollToTurn(id);
        } else if (outcome === 'exhausted') {
          showNotification('That turn is no longer in this conversation’s history.', 'error');
        } else if (outcome === 'unreachable') {
          // Which is not the same thing, and must not be said as though it
          // were: one read did not come back. `abandoned` says nothing at all —
          // the user has already gone somewhere else and knows it.
          showNotification('Could not read that far back just now. Try again.', 'error');
        }
      });
    },
    [openTurn, controller, messages],
  );

  const jumpLatest = React.useCallback(() => {
    // Going to the newest turn is the plainest way of saying you are done going
    // backwards, so a jump still walking the log is abandoned rather than left
    // to land and scroll the conversation out from under the arrival.
    controller.cancelSeek();
    setSeeking(null);
    setSelectedTurnId(null);
    list.current?.pin();
  }, [controller]);

  // Leaving the conversation — a tab switch remounts this surface — abandons a
  // jump with it. Otherwise it goes on paging a transcript nobody is looking at.
  React.useEffect(() => () => controller.cancelSeek(), [controller]);

  const stepTurn = React.useCallback(
    (delta: number) => {
      if (!turns.length) return;
      const at = turns.findIndex((turn) => turn.id === currentTurnId);
      const next = Math.min(turns.length - 1, Math.max(0, (at < 0 ? turns.length - 1 : at) + delta));
      selectTurn(turns[next].id);
    },
    [turns, currentTurnId, selectTurn],
  );

  /** Open the rail on the trace and land it on this message's first event. */
  const showWork = React.useCallback(
    (messageId: string) => {
      openRail('trace');
      // Derived on demand rather than held: this runs on a click, and keeping a
      // memo of the whole projection in the chat root is exactly what put the
      // rail on the wrong subscription tier in the first place.
      const first = activityEvents(transcript.messages, {
        reasoning: view.showThinking,
        tools: view.showToolCalls,
      }).find((event) => event.messageId === messageId);
      setFocus((current) => ({ id: first ? first.id : undefined, nonce: current.nonce + 1 }));
    },
    [openRail, transcript, view.showThinking, view.showToolCalls],
  );

  const revealMessage = React.useCallback(
    (messageId: string) => {
      const turn = turnOf(messageId, turns);
      if (turn) openTurn(turn.id);
      // A step that only ran commands has no row of its own (issue #46), and a
      // trace row or a search hit pointing at one would scroll to an element
      // that is not in the document — a click that does nothing at all. The
      // reply that speaks for it is the row to land on instead.
      const target = rowFor(messageId, turn, transcript);
      // A turn that was just opened has not painted yet — its bubbles have no
      // layout box to scroll to until the next tick. A turn already open
      // scrolls one tick later than it strictly needs to, which nothing on
      // screen can tell apart from immediate.
      window.setTimeout(() => list.current?.scrollToMessage(target), 0);
    },
    [turns, openTurn, transcript],
  );

  const copyTurn = React.useCallback(
    (turnId: string) => {
      const turn = turns.find((item) => item.id === turnId);
      if (!turn) return;
      const text = turn.messageIds
        .map((id) => transcript.message(id))
        .filter((message): message is NonNullable<typeof message> => Boolean(message))
        .map((message) => `**${message.role}**\n\n${messageText(message)}`)
        .join('\n\n---\n\n');
      const write = navigator.clipboard?.writeText(text);
      if (!write) return;
      write
        .then(() => showNotification(`Turn ${turn.index} copied as Markdown`))
        .catch(() => showNotification('That turn could not be copied', 'error'));
    },
    [turns, transcript],
  );

  // One at a time. The request creates a conversation, and a double-tap on a
  // phone would create two of them a second apart.
  const [branching, setBranching] = React.useState(false);
  /**
   * Carry on from this turn in a conversation of its own.
   *
   * The turn id goes to the server and everything that matters happens there:
   * the history up to and including it is copied into a new conversation, and
   * the same history is left waiting as that conversation's opening context so
   * its agent knows what came before. Nothing here touches this conversation —
   * a branch is a second thread, not an edit to the one it grew out of.
   *
   * A refusal is reported in the words the server chose: the only failure with
   * an obvious next move is a history too large for the model's window, and
   * that sentence carries the three figures needed to act on it.
   */
  const branchTurn = React.useCallback(
    (anchorId: string) => {
      // The strips are anchored on the opening *message*, like copy beside it,
      // and the server cuts on the turn's own id — the one thing that stays
      // stable when only half a turn is loaded and the message the window opens
      // on is the agent's rather than the user's.
      const turn = turns.find((item) => item.id === anchorId);
      if (!turn || branching) return;
      setBranching(true);
      branchConversation(controller.sessionId, turn.turnId)
        .then((conversation) => {
          if (onOpenConversation) {
            onOpenConversation(conversation);
            return;
          }
          showNotification(
            `Branched at turn ${conversation.turnIndex}. Open “${conversation.name}” from the session list.`,
          );
        })
        .catch((error: unknown) => {
          showNotification(
            error instanceof Error ? error.message : 'That branch could not be made',
            'error',
          );
        })
        .finally(() => setBranching(false));
    },
    [branching, controller, onOpenConversation, turns],
  );

  /** Send the ask that opened *this message's* turn again, as a new turn. */
  const retryTurn = React.useCallback((messageId: string) => {
    // Resolved from the message that was clicked, never from the selection: an
    // error you scrolled back to must resend its own turn, not the newest one.
    const turn = turnOf(messageId, turns);
    if (!turn) return;
    const opener = transcript.message(turn.messageIds[0]);
    const text = opener && opener.role === 'user' ? messageText(opener).trim() : '';
    if (!text) {
      // A turn replayed from history can begin with something other than a
      // user message. Silence would read as a broken button.
      showNotification('There is no message to send again for this turn.');
      return;
    }
    if (opener?.workflow) {
      const requestId = createBuiltInWorkflowRequestId();
      void controller.startBuiltInWorkflow(opener.workflow, text, requestId)
        .then(() => {
          list.current?.pin();
          controller.acknowledgeBuiltInWorkflow(opener.workflow!, requestId);
        })
        .catch((error: unknown) => {
          showNotification(
            error instanceof Error ? error.message : 'That guided workflow could not be started again.',
            'error',
          );
        });
      return;
    }
    controller.sendTurn(text, []);
    list.current?.pin();
  }, [turns, transcript, controller]);

  const seedDraft = React.useCallback((text: string) => {
    setSeed((current) => ({ key: current.key + 1, text }));
  }, []);

  const toggleTerminal = React.useCallback(() => {
    const next = !view.terminalOpen;
    setView({ terminalOpen: next });
    // Focus follows the pane the toggle just revealed, both ways: a split you
    // have to click into is a split you opened for nothing.
    window.setTimeout(() => {
      if (next) {
        const pty = terminalRegion.current?.querySelector('textarea') as HTMLTextAreaElement | null;
        pty?.focus();
      } else {
        const composer = root.current?.querySelector(
          'textarea[aria-label="Message"]',
        ) as HTMLTextAreaElement | null;
        composer?.focus();
      }
      list.current?.pin();
    }, 0);
  }, [setView, view.terminalOpen]);

  // No mode is passed: the server restores the one recorded against this
  // conversation. See ChatController.relaunch.
  const relaunch = React.useCallback(
    (resume: boolean) => controller.relaunch(runtime, { resume }),
    [controller, runtime],
  );

  // ------------------------------------------------------------- shortcuts

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const node = root.current;
      if (!node) return;
      const terminalFocused = Boolean(
        terminalRegion.current && terminalRegion.current.contains(document.activeElement),
      );
      const command = chatCommandFor(event, {
        terminalFocused,
        dialogOpen: Boolean(document.querySelector('[role="dialog"]')),
        // The keymap decides; this only reports where the keystroke landed and
        // what else is on screen to claim it.
        textEntry: isTextEntry(event.target),
        pickerOpen: Boolean(document.querySelector('[role="listbox"][aria-label]')),
        mac: /mac/i.test(navigator.platform || navigator.userAgent || ''),
      });
      if (!command) return;

      if (command === 'interrupt') {
        if (!busy) return;
        event.preventDefault();
        interrupt();
        return;
      }

      event.preventDefault();
      switch (command) {
        case 'toggle-terminal':
          toggleTerminal();
          break;
        case 'search':
          setSearchOpen(true);
          break;
        case 'toggle-rail':
          toggleRail();
          break;
        case 'jump-latest':
          jumpLatest();
          break;
        case 'previous-turn':
          stepTurn(-1);
          break;
        case 'next-turn':
          stepTurn(1);
          break;
        case 'expand-all-turns':
          expandAllTurns();
          break;
        case 'collapse-all-turns':
          collapseAllTurns();
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    busy,
    collapseAllTurns,
    expandAllTurns,
    interrupt,
    jumpLatest,
    stepTurn,
    toggleRail,
    toggleTerminal,
  ]);

  // -------------------------------------------------------------- the pane

  const currentTurn = turns.find((turn) => turn.id === currentTurnId);
  const trace = (
    <TracePanel
      plan={plan}
      showPlan={view.showPlan}
      transcript={transcript}
      showThinking={view.showThinking}
      showToolCalls={view.showToolCalls}
      filter={view.activityFilter}
      onFilter={(activityFilter) => setView({ activityFilter })}
      onReveal={revealMessage}
      focusId={focus.id}
      focusNonce={focus.nonce}
    />
  );

  const openIndex = React.useCallback(() => {
    // One control, two jobs, decided by whether the index has room to be a rail
    // at all. Below 1024px — and on every phone — there is no rail to toggle,
    // so the same control opens the sheet instead of writing a setting whose
    // effect nothing on screen would show.
    if (indexVisible || !(isMobile || narrow)) setView({ indexOpen: !view.indexOpen });
    else setIndexSheet(true);
  }, [indexVisible, isMobile, narrow, setView, view.indexOpen]);

  // This surface's own controls, then the shell's. The ones somebody opened the
  // menu mid-conversation for come first, nearest the button they pressed.
  const phoneMenu: SurfaceAction[] = React.useMemo(
    () => [
      // Things you do to this conversation. Where you can *go* from it — the
      // trace, the files, the shell, the other sessions — is the bottom bar's
      // job, and repeating those here would be two answers to one question.
      { id: 'chat-search', label: 'Search this conversation', icon: 'search', expands: true, group: 'surface', onPress: () => setSearchOpen(true) },
      // Immediately after it, which is where the header puts it too: on a phone
      // the transcript search lives in this sheet rather than in the bar, so this
      // sheet is where "beside the search control" is (#127).
      ...(onOpenConversations
        ? [{
            id: 'chat-conversations',
            label: 'All conversations',
            icon: 'message-square',
            expands: true,
            group: 'surface',
            onPress: onOpenConversations,
          } as SurfaceAction]
        : []),
      { id: 'chat-turns', label: 'Jump to a turn', icon: 'panel-left', active: indexVisible || indexSheet, expands: true, group: 'surface', onPress: openIndex },
      // Folding is a thing you do to the conversation, so it belongs with the
      // things you do to the conversation. This is the phone's route to it —
      // this menu is only ever drawn on a phone. The band the index's own
      // header sheds them in, 1024 to 1280px, is answered by the rail's own
      // menu and by the keyboard, which is where a laptop reaches them (#34).
      { id: 'chat-expand-all', label: 'Expand every turn', icon: 'maximize-2', group: 'surface', onPress: expandAllTurns },
      { id: 'chat-collapse-all', label: 'Collapse every turn', icon: 'fold-vertical', group: 'surface', onPress: collapseAllTurns },
      { id: 'chat-display', label: 'Display settings', icon: 'settings', expands: true, group: 'surface', onPress: () => onOpenSettings?.() },
      ...(menuActions ?? []).map((action) => ({ ...action, group: 'session' })),
    ],
    [
      indexVisible,
      indexSheet,
      openIndex,
      expandAllTurns,
      collapseAllTurns,
      onOpenSettings,
      onOpenConversations,
      menuActions,
    ],
  );

  return (
    // The phone answer, published once for the whole surface. Everything below
    // — down to a copy button inside a tool call — reads it from here rather
    // than from a prop threaded through five components, any one of which could
    // drop it and leave that corner at desktop sizes. See ui/touch.ts.
    <PhoneContext.Provider value={isMobile}>
    <section
      ref={root as React.RefObject<HTMLElement>}
      aria-label={`${runtimeLabel} chat`}
      data-runtime={runtime}
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minHeight: 0,
        // A flex item defaults to `min-width: auto`, which means it refuses to
        // shrink below its content — so one long file path in the rail, or one
        // long line in the transcript, pushed the whole surface wider than the
        // phone and cut off the right-hand edge of everything on it.
        minWidth: 0,
        height: '100%',
        background: 'var(--background)',
        color: 'var(--foreground)',
        fontFamily: 'var(--font-sans)',
        ...(proseVariables(view, isMobile) as React.CSSProperties),
      }}
    >
      <SessionHeader
        runtimeLabel={runtimeLabel}
        workingDir={workingDir}
        branch={branch}
        usage={transcript.usage}
        capabilities={transcript.capabilities}
        state={chatState}
        exited={Boolean(unavailable)}
        bypassPermissions={bypassPermissions}
        ladderError={controller.ladderErrorValue}
        showUsage={view.showUsage}
        terminalOpen={terminalOpen}
        railOpen={railOpen}
        indexOpen={indexVisible}
        isMobile={isMobile}
        compact={compactHeader}
        theme={theme}
        onToggleTerminal={toggleTerminal}
        onToggleRail={toggleRail}
        // One control, two jobs, decided by whether the index has room to be a
        // rail at all. Below 1024px — and on every phone — there is no rail to
        // toggle, so the same button opens the sheet instead of writing a
        // setting whose effect nothing on screen would show.
        onToggleIndex={openIndex}
        onOpenSearch={() => setSearchOpen(true)}
        onOpenConversations={onOpenConversations}
        onOpenSettings={() => onOpenSettings?.()}
        onToggleTheme={onToggleTheme}
      />

      <div style={{ flex: 1, display: 'flex', minHeight: 0, minWidth: 0, position: 'relative' }}>
        {/* Ahead of the transcript in the DOM as well as on screen: the index
            is a navigation surface, and a keyboard user reaching it after the
            whole conversation would have to tab past every message in it. */}
        {indexVisible ? (
          <TurnIndex
            turns={indexRows}
            currentTurnId={currentTurnId}
            onSelect={selectTurn}
            onJumpLatest={jumpLatest}
            collapsed={indexCollapsed}
            onExpandAll={expandAllTurns}
            onCollapseAll={collapseAllTurns}
            complete={indexComplete}
            seekingId={seeking}
          />
        ) : null}

        {/* The conversation column: the transcript and, below it, everything
            that must never scroll away. */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            position: 'relative',
          }}
        >
          {/* On a phone the rail replaces the *transcript*, never the whole
              column. Hiding the column took the pending approvals and the
              composer with it, so a blocked agent became unanswerable by
              opening a panel — and the way back was a control the panel was
              covering. Hidden rather than unmounted: the scroll position of a
              long conversation is worth more than the few nodes this saves. */}
          <div
            style={{
              flex: 1,
              minWidth: 0,
              minHeight: 0,
              display: railTakesOver ? 'none' : 'flex',
              flexDirection: 'column',
              position: 'relative',
            }}
          >
          {/* Over the conversation, clear of everything else. Anchored to the
              transcript rather than to the shell: at the shell's bottom right
              it sat exactly on the send button. Lifted over the terminal's key
              strip when that is open, or the button covers the right-hand keys
              — including the one that summons the keyboard, which is the only
              way left to type letters into that pane. */}
          {isMobile ? (
            <FloatingMenu
              actions={phoneMenu}
              bottomOffset={terminalOpen ? KEY_STRIP_HEIGHT : 0}
            />
          ) : null}

          {searchOpen ? (
            <TranscriptSearch
              messages={messages}
              hasMore={transcript.hasMore}
              onJump={revealMessage}
              onClose={() => setSearchOpen(false)}
            />
          ) : null}

          <WorkspaceFileLinkContext.Provider value={workspaceFileLinks}>
            <MessageList
              ref={list}
              transcript={transcript}
              turns={turns}
              currentTurnId={currentTurnId}
              openTurnIds={openTurnIds}
              onToggleTurn={toggleTurn}
              onLoadMore={loadMore}
              onShowWork={showWork}
              onEditTurn={seedDraft}
              onCopyTurn={copyTurn}
              onForkTurn={branchTurn}
              onRetry={retryTurn}
              showThinking={view.showThinking}
              showToolCalls={view.showToolCalls}
              onAnswerQuestion={answerQuestion}
            />
          </WorkspaceFileLinkContext.Provider>

          {terminalOpen ? (
            <div ref={terminalRegion} style={{ flex: '0 0 auto', minWidth: 0 }}>
              <TerminalSplit
                chatSessionId={controller.sessionId}
                workingDir={workingDir}
                height={clampTerminalHeight(view.terminalHeight, viewportHeight())}
                onResize={(terminalHeight) => setView({ terminalHeight })}
                onClose={toggleTerminal}
                isMobile={isMobile}
                theme={theme}
              />
            </div>
          ) : null}

          </div>

          {/* The rail, inside the column, on a phone only — so everything the
              user must be able to reach stays below it. */}
          {railTakesOver ? (
            <WorkspacePanel
              sessionId={controller.sessionId}
              workingDir={workingDir}
              transcript={transcript}
              runtimeLabel={runtimeLabel}
              settings={view}
              trace={trace}
              onSelectTab={(panelTab: ChatPanelId) => setView({ panelTab })}
              onClose={() => setView({ panelOpen: false })}
              onOpenFile={openFile}
              isMobile
              planMode={controller.planModeValue}
              unavailableReason={workflowUnavailableReason}
              issuePrompt={issueDraft.text}
              issueRequestId={issueDraft.requestId}
              onIssuePromptChange={setIssuePrompt}
              onStartGitHubIssue={startGitHubIssue}
            />
          ) : null}

          {busy || chatState === 'awaiting_permission' || chatState === 'awaiting_answer' || chatState === 'error' ? (
            <LiveStreamRibbon
              transcript={transcript}
              turn={currentTurn}
              state={chatState}
              showThinking={view.showThinking}
              showToolCalls={view.showToolCalls}
              canInterrupt={transcript.capabilities.interrupt}
              onInterrupt={interrupt}
            />
          ) : null}

          <div
            style={{
              flex: '0 0 auto',
              display: 'grid',
              // `minmax(0, 1fr)`, not the implicit `auto` track. A grid item
              // has `min-width: auto` exactly the way a flex item does, so the
              // implicit track refuses to go below the composer's min-content
              // width — and dragging the rail wide would push the composer off
              // the right-hand edge instead of shrinking it.
              gridTemplateColumns: 'minmax(0, 1fr)',
              minWidth: 0,
              gap: 'var(--space-2)',
              // No padding. The composer draws its own frame and the notices
              // and approval cards above it draw their own; an outer inset here
              // was a second margin around boxes that already had one, and it
              // stopped the region reaching the edges of its column.
              padding: 0,
              borderTop: '1px solid var(--border)',
              background: 'var(--background)',
              // iOS does not shrink the layout viewport for the on-screen
              // keyboard, and the shell's existing lift (terminal/keyboard.ts)
              // only fires for the xterm textarea, so the composer would sit
              // under the keyboard. Margin rather than padding: it has to take
              // height away from the flex column, which is what pushes the
              // composer back into view.
              marginBottom: keyboardInset || undefined,
              paddingBottom: isMobile ? 'env(safe-area-inset-bottom, 0px)' : undefined,
            }}
          >
            {unavailable ? (
              <UnavailableNotice
                reason={unavailable}
                runtimeLabel={runtimeLabel}
                bypassPermissions={bypassPermissions}
                preferenceBypasses={approvalPreference}
                onResume={() => relaunch(true)}
                onFresh={() => relaunch(false)}
              />
            ) : (
              <StateNotice state={chatState} runtimeLabel={runtimeLabel} error={transcript.lastError} />
            )}

            {/* The plan is the rail's first block, so closing the rail took it
                away — where before the redesign closing the workspace panel
                *revealed* a plan rail. It comes back here as the same
                disclosure the phone layout already used, on any surface where
                the rail is not showing it. */}
            {view.showPlan && plan.length > 0 && (isMobile || !railOpen || view.panelTab !== 'trace') ? (
              <div>
                <button
                  type="button"
                  aria-expanded={planSheet}
                  onClick={() => setPlanSheet((open) => !open)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    width: '100%',
                    minHeight: TOUCH,
                    padding: '0 var(--space-2)',
                    background: 'var(--card)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius)',
                    color: 'var(--foreground)',
                    font: 'inherit',
                    fontSize: 'var(--text-sm)',
                    textAlign: 'left',
                    cursor: 'pointer',
                  }}
                >
                  <Icon name={planSheet ? 'chevron-down' : 'chevron-right'} size={12} />
                  <Icon name="list-todo" size={12} />
                  Plan
                  <span style={{ marginLeft: 'auto', color: 'var(--muted-foreground)' }}>
                    {plan.filter((item) => item.status === 'completed').length} of {plan.length}
                  </span>
                </button>
                {planSheet ? (
                  <div style={{ marginTop: 'var(--space-1)', maxHeight: '30vh', overflowY: 'auto' }}>
                    <PlanPanel items={plan} compact />
                  </div>
                ) : null}
              </div>
            ) : null}

            {strayQuestions.length > 0 ? (
              <div
                role="region"
                aria-label="Questions from the assistant"
                aria-live="assertive"
                style={{ display: 'grid', gap: 'var(--space-2)', maxHeight: '50vh', overflowY: 'auto' }}
              >
                {strayQuestions.map((recorded) => {
                  const request = transcript.pendingQuestions.find(
                    (pendingQuestion) => pendingQuestion.requestId === recorded.requestId,
                  );
                  const answerKey = recorded.toolId ?? recorded.requestId;
                  return <QuestionCard
                    key={recorded.requestId}
                    request={request}
                    question={recorded.question}
                    header={recorded.header}
                    multiSelect={recorded.multiSelect}
                    options={recorded.options}
                    answered={request ? undefined : transcript.answerFor(answerKey)}
                    ownWords={request ? undefined : transcript.answerTextFor(answerKey)}
                    abandoned={!request && transcript.abandonedFor(answerKey)}
                    onAnswer={transportUnavailable ? undefined : answerQuestion}
                  />;
                })}
              </div>
            ) : null}

            {pending.length > 0 ? (
              // assertive, not polite: nothing else the user does will move the
              // session forward until one of these is answered.
              <div
                role="region"
                aria-label="Pending approvals"
                aria-live="assertive"
                style={{ display: 'grid', gap: 'var(--space-2)', maxHeight: '50vh', overflowY: 'auto' }}
              >
                {pending.map((request) => (
                  <PermissionCard key={request.requestId} request={request} onRespond={respond} busy={transportUnavailable} />
                ))}
              </div>
            ) : null}

            <Composer
              onSend={send}
              onInterrupt={interrupt}
              busy={busy}
              capabilities={transcript.capabilities}
              // Only a dead session takes the input away. An approval on screen
              // used to disable it too, which meant the one moment you most
              // want to type the follow-up — while the agent waits on you — was
              // the one moment you could not. It queues instead.
              disabled={exited || Boolean(unavailable) || transportUnavailable}
              placeholder={placeholderFor(chatState, runtimeLabel, isMobile)}
              queued={transcript.queuedTurns}
              onCancelQueued={cancelQueued}
              // Only offered when there is something to cut in front of. An
              // idle agent is already working through the line, so "now" is
              // what is happening anyway; a session that has ended can take
              // nothing at all. Waiting on a person counts as busy: an approval
              // on screen is exactly when "no, not that file" gets typed, and
              // interrupting clears the card rather than stranding it.
              onSendQueuedNow={interruptible ? sendQueuedNow : undefined}
              onRetryQueued={retryQueued}
              onFindFiles={findProjectFiles}
              onUpload={upload}
              draft={draft.text}
              // Both of these are functions of what the draft *is*, never of
              // what it was when this render happened: a paste that adds text
              // and a drop that adds a file can land in the same tick, and the
              // second one computed from a stale render would undo the first.
              onDraftChange={(text) => setDraft((prev) => ({ ...prev, text }))}
              // The files on the unsent message, held here rather than inside
              // the composer: they are part of what is being written, and what
              // is being written belongs to the conversation now, not to this
              // window. A screenshot dropped on a laptop is on the phone's copy
              // of the same message a moment later.
              attachments={draft.attachments}
              onAttachmentsChange={(attachments) => setDraft((prev) => ({ ...prev, attachments }))}
              seedKey={seed.key}
              seedDraft={seed.text}
              branch={branch}
              turnLabel={currentTurn ? `turn ${currentTurn.index}` : undefined}
              usage={transcript.usage}
              // The conversation's own override wins over whatever the
              // runtime last reported, once it is confirmed live (or cleared).
              // A pending/sent switch is not yet running and is surfaced via
              // modelFeedback instead, so this label never claims a model the
              // session isn't actually on.
              model={controller.modelOverrideValue ?? transcript.model}
              // Only where the runtime reported a genuine split. An override
              // is what was asked for, and pairing it with what the last turn
              // actually ran would read as one claim about one model.
              alsoRan={controller.modelOverrideValue ? undefined : transcript.turnModels}
              onSetModel={setModel}
              modelFeedback={controller.modelFeedback}
              // Where a *new* conversation on this runtime would get its model,
              // which is a different question from the one above and had no
              // answer on screen at all before #135. No effect on the launch:
              // the server resolves that itself, and nothing here seeds a model
              // the way the effort preference seeds a level — only ACP can take
              // a model without a restart, so a post-launch seed would push a
              // visible `/model` turn into a brand new claude conversation.
              modelDefault={controller.modelDefaultValue}
              // What this conversation was actually launched on, which is the
              // only truthful thing to name when the user chose nothing and the
              // runtime reports nothing — claude reports nothing, ever. The
              // default above cannot stand in for it: it is what the *next* new
              // chat would open on, and it changes under an open conversation
              // every time the account's standing choice does.
              modelPinned={controller.modelPinnedValue}
              // And which of four things chose it: the ladder and its rung, the
              // profile, the account's standing choice, or the runtime itself.
              // The three above each name a model; only this says why (#171).
              modelOrigin={controller.modelOriginValue}
              ladderError={controller.ladderErrorValue}
              // Apart from `model` above, because that one is the override *or*
              // whatever the runtime last reported and the picker has to tell
              // those two apart to say which it is describing.
              modelOverride={controller.modelOverrideValue}
              // Same precedence as the model above, and for the same reason:
              // the record's chosen level wins once the server has confirmed
              // it, and otherwise the transcript carries whatever the runtime
              // itself last reported. Both can be absent, which honestly means
              // nobody has chosen and the runtime has not said.
              effort={controller.effortOverrideValue ?? transcript.effort}
              onSetEffort={setEffort}
              effortFeedback={controller.effortFeedback}
              planMode={controller.planModeValue}
              planLocked={planLocked}
              onSetPlanMode={(on) => controller.setPlanMode(on)}
              planFeedback={controller.planFeedback}
              planDocument={controller.planDocumentValue}
              onOpenPlan={() => setPlanOpen(true)}
              // Deliberately the same path as typing it: the button and the
              // three spellings have to end in one state, and the surest way
              // to keep them that way is for the button to *be* the command.
              onNewChat={() => send('/clear', [])}
              bypassPermissions={bypassPermissions}
              terminalOpen={terminalOpen}
            />
          </div>
        </div>

        {railOpen && !railTakesOver ? (
          <WorkspacePanel
            sessionId={controller.sessionId}
            workingDir={workingDir}
            transcript={transcript}
            runtimeLabel={runtimeLabel}
            settings={view}
            trace={trace}
            onSelectTab={(panelTab: ChatPanelId) => setView({ panelTab })}
            onClose={() => setView({ panelOpen: false })}
            onResize={(panelWidth) => setView({ panelWidth })}
            onOpenFile={openFile}
            planMode={controller.planModeValue}
            unavailableReason={workflowUnavailableReason}
            issuePrompt={issueDraft.text}
            issueRequestId={issueDraft.requestId}
            onIssuePromptChange={setIssuePrompt}
            onStartGitHubIssue={startGitHubIssue}
          />
        ) : null}

        {/* On a narrow window or a phone the index is a sheet over the column
            rather than a fourth thing competing for width. */}
        {indexSheet && (isMobile || narrow) ? (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 'var(--z-overlay)' as unknown as number,
              display: 'flex',
              background: 'var(--overlay)',
            }}
          >
            <div style={{ display: 'flex', boxShadow: 'var(--shadow-lg)' }}>
              <TurnIndex
                turns={indexRows}
                currentTurnId={currentTurnId}
                onSelect={(id) => {
                  setIndexSheet(false);
                  selectTurn(id);
                }}
                onJumpLatest={() => {
                  setIndexSheet(false);
                  jumpLatest();
                }}
                onExpandAll={expandAllTurns}
                onCollapseAll={collapseAllTurns}
                complete={indexComplete}
                seekingId={seeking}
              />
            </div>
            <button
              type="button"
              aria-label="Close the turn index"
              onClick={() => setIndexSheet(false)}
              style={{ flex: 1, background: 'transparent', border: 0, cursor: 'default' }}
            />
          </div>
        ) : null}

      </div>
      <FileEditorDialog
        // A new target is a new editor lifecycle. Without the key, the previous
        // file's contents and dirty badge can survive for a frame while the
        // next request is in flight; a different location in the same file also
        // needs its line-navigation effect to run again.
        key={editing ? `${editing.path}:${editing.line ?? ''}` : 'none'}
        open={editing !== null}
        sessionId={controller.sessionId}
        filePath={editing?.path ?? ''}
        initialLine={editing?.line}
        onClose={() => setEditing(null)}
        isMobile={isMobile}
      />
      {planOpen ? <PlanDocDialog plan={controller.planDocumentValue} planMode={controller.planModeValue} disabled={planLocked || !controller.connectionAvailable} feedback={controller.planFeedback?.message || null} retryAction={controller.planFeedback?.accepted === false && controller.planFeedback.action !== 'mode' ? controller.planFeedback.action : null} serverName={serverName} onAccept={(revision) => { setPlanAction('accept'); controller.acceptPlan(revision); }} onReject={(revision) => { setPlanAction('reject'); controller.rejectPlan(revision); }} onClose={() => setPlanOpen(false)} /> : null}
    </section>
    </PhoneContext.Provider>
  );
}

const ZERO = (): number => 0;

/**
 * The row that stands for a message on screen.
 *
 * Itself, unless it is a step that said nothing — then the next message in its
 * turn that did, because that is the one carrying its work counter. Failing that,
 * the last one before it, so a turn whose tail is all machinery still lands
 * somewhere. Falls back to the id given, which scrolls nowhere and is exactly
 * what happened before this existed.
 *
 * Exported so the rule can be asserted directly: everything it guards happens
 * inside a `setTimeout` around a scroll, which a rendered tree cannot show.
 */
export function rowFor(
  messageId: string,
  turn: TurnSummary | undefined,
  transcript: ChatTranscript,
): string {
  const message = transcript.message(messageId);
  if (!turn || !message || hasVisibleContent(message)) return messageId;

  const ids = turn.messageIds;
  const at = ids.indexOf(messageId);
  if (at < 0) return messageId;

  const visible = (id: string): boolean => {
    const other = transcript.message(id);
    return Boolean(other && hasVisibleContent(other));
  };
  const after = ids.slice(at + 1).find(visible);
  if (after) return after;
  const before = ids.slice(0, at).filter(visible).pop();
  return before || messageId;
}

function viewportHeight(): number {
  return typeof window === 'undefined' ? 900 : window.innerHeight;
}

function placeholderFor(state: ChatState, runtimeLabel: string, isPhone = false): string {
  if (state === 'exited') return 'This session has ended';
  // No longer 'answer this before you can type': the composer stays live and
  // queues, so the sentence has to describe what happens rather than forbid it.
  if (state === 'awaiting_permission' || state === 'awaiting_answer') {
    return isPhone ? 'Answer above, or type' : 'Answer above — or type the next message';
  }
  if (state === 'thinking' || state === 'running') {
    // Short enough for the one line a phone's field is. The long form wrapped
    // to two, which grew the composer by 26px for a sentence saying what the
    // ribbon directly above it already says.
    return isPhone ? 'Queue a follow-up…' : `Queue a follow-up while ${runtimeLabel} works…`;
  }
  return isPhone ? 'Message…' : `Message ${runtimeLabel}…`;
}

/**
 * The branch this conversation's working directory is on.
 *
 * Read from the workspace status endpoint rather than guessed from the path,
 * and re-read whenever the agent finishes working — which is when a checkout it
 * performed would have taken effect.
 */
function useBranch(sessionId: string, version: number): string | undefined {
  const [branch, setBranch] = React.useState<string | undefined>(undefined);
  const settled = React.useRef(0);

  // Coarse: one read per ~40 transcript versions is enough for a label that
  // only changes when somebody checks out, and a read per token would be a
  // `git` invocation per token.
  const bucket = Math.floor(version / 40);

  React.useEffect(() => {
    if (!sessionId) return;
    let live = true;
    const at = ++settled.current;
    fetchStatus(sessionId)
      .then((status) => {
        // A slow answer for an earlier bucket must not overwrite a later one.
        if (!live || at !== settled.current) return;
        setBranch(status.git?.branch ?? undefined);
      })
      .catch(() => {
        // Not a git repository, or no workspace API. The header simply has no
        // branch to show, which is the truth.
      });
    return () => {
      live = false;
    };
  }, [sessionId, bucket]);

  return branch;
}

/** What a composer holds before any of it is a turn. */
interface DraftState {
  text: string;
  attachments: ChatAttachment[];
}

const EMPTY_DRAFT: DraftState = { text: '', attachments: [] };

/**
 * Read this browser's own copy of a draft back.
 *
 * Session storage rather than local: a draft is something you are in the middle
 * of, and one restored into a new window a week later is a surprise rather than
 * a convenience.
 *
 * A bare string is what every version before the shared composer wrote here, and
 * it still reads correctly — as a draft with nothing attached to it, which is
 * exactly what it was.
 */
function readStoredDraft(key: string): DraftState {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(key);
  } catch {
    // Private browsing, or storage disabled. Nothing was kept.
    return EMPTY_DRAFT;
  }
  if (!raw) return EMPTY_DRAFT;
  try {
    const parsed = JSON.parse(raw) as Partial<DraftState>;
    // Anything that parses but is not one of these is a draft from before this
    // was written that happened to look like JSON — `42`, `true`, `[1, 2]`. It
    // is still what somebody typed, so it is still their draft.
    if (!parsed || typeof parsed !== 'object' || typeof parsed.text !== 'string') {
      return { text: raw, attachments: [] };
    }
    return {
      text: parsed.text,
      attachments: Array.isArray(parsed.attachments) ? parsed.attachments : [],
    };
  } catch {
    return { text: raw, attachments: [] };
  }
}

/**
 * The composer, shared with every other screen looking at this conversation.
 *
 * Three copies of one sentence, and each of them earns its place. The React
 * state is what the field renders from. Session storage is what survives this
 * page being reloaded, and it is the only copy left when the server has
 * restarted under an open tab. The server's own is the one the account's other
 * screens read, which is the whole point (#163).
 *
 * The rule between them is the plainest one that works: whoever typed last wins.
 * There is no merging here and there should not be — two devices belonging to
 * one person are almost never typed into at the same instant, and the price of
 * pretending otherwise would be a character-level protocol for a feature whose
 * real job is to let somebody stand up and finish their sentence on a phone.
 */
function useSyncedDraft(
  controller: ChatController,
): [DraftState, (next: DraftState | ((prev: DraftState) => DraftState)) => void] {
  const key = `cc-web-chat-draft:${controller.sessionId}`;

  const [draft, setDraft] = React.useState<DraftState>(() => {
    // The conversation's own composer beats this browser's memory of it: a tab
    // switched away from and back has a controller that was listening the whole
    // time, and what it heard is newer than anything written here.
    const held = controller.draftValue;
    if (held.revision > 0) return { text: held.text, attachments: held.attachments };
    return readStoredDraft(key);
  });

  /** So the effect below can read the current draft without re-running on it. */
  const latest = React.useRef(draft);
  latest.current = draft;

  const remember = React.useCallback(
    (next: DraftState) => {
      try {
        if (next.text || next.attachments.length) sessionStorage.setItem(key, JSON.stringify(next));
        else sessionStorage.removeItem(key);
      } catch {
        // Applying it anyway is right: it works for this window, it just will
        // not survive a reload.
      }
    },
    [key],
  );

  /**
   * Change the composer, here and everywhere.
   *
   * Takes a function as well as a value, and the composer needs it to: sending a
   * message clears the text and the files through two separate callbacks, and
   * the second of them would otherwise be computed from the render before the
   * first — putting the sent message straight back into the field, and then on
   * to every other screen as a fresh edit.
   */
  const update = React.useCallback(
    (next: DraftState | ((prev: DraftState) => DraftState)) => {
      const value = typeof next === 'function' ? next(latest.current) : next;
      latest.current = value;
      setDraft(value);
      remember(value);
      controller.publishDraft(value.text, value.attachments);
    },
    [controller, remember],
  );

  React.useEffect(() => {
    const apply = (incoming: ChatDraft | null): void => {
      if (incoming) {
        const next = { text: incoming.text, attachments: incoming.attachments };
        setDraft(next);
        remember(next);
        return;
      }
      // The server has no composer for this conversation — it has restarted, or
      // nothing has been typed into it since it came up. This browser may be the
      // only thing still holding what was being written, so it offers it rather
      // than waiting to be asked. Nothing goes out when there is nothing to
      // offer, so an empty composer stays quiet.
      const held = latest.current;
      if (held.text || held.attachments.length) {
        controller.publishDraft(held.text, held.attachments);
      }
    };

    const stop = controller.subscribeDraft(apply);
    // The join may have been answered before this surface existed — a tab
    // switched back to has been subscribed all along — in which case no
    // broadcast is coming and the answer is already on the controller.
    const answer = controller.draftAnswer;
    if (answer === 'held') apply(controller.draftValue);
    else if (answer === 'none') apply(null);
    return stop;
  }, [controller, remember]);

  // The moments where a quarter of a second is a quarter of a second too long:
  // the page being hidden, and this conversation being left. Somebody putting a
  // laptop down mid-sentence is precisely the person about to pick up a phone.
  React.useEffect(() => {
    const flush = (): void => controller.flushDraft();
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', flush);
      flush();
    };
  }, [controller]);

  return [draft, update];
}

/** The surface's own width, for the layout breakpoints. */
function useElementWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = React.useState(0);

  React.useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const measure = (): void => setWidth(element.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return width;
}

/**
 * A conversation with nothing running it, and the two ways out.
 *
 * The ordinary way to get here is the server restarting: chat sessions live in
 * its memory and transcripts live on disk, so the conversation outlives the
 * process that was having it. What the user saw before was the app-wide
 * "Connection error" panel — covering the transcript, blaming the network, and
 * offering a Retry that reconnected a socket that had never been the problem.
 *
 * Both buttons act on *this* session in *this* tab, which is the point: the
 * conversation is what the user came back for, and sending them to a new tab
 * to escape the error would leave it behind.
 */
function UnavailableNotice({
  reason,
  runtimeLabel,
  bypassPermissions,
  preferenceBypasses,
  onResume,
  onFresh,
}: {
  reason: ChatUnavailable;
  /** What this pane calls the runtime, used when the server named none. */
  runtimeLabel: string;
  /** The mode this conversation was running in, which resuming restores. */
  bypassPermissions: boolean;
  /** The mode the account's preference names, which starting over produces. */
  preferenceBypasses: boolean;
  onResume: () => void;
  onFresh: () => void;
}) {
  const label = reason.runtimeLabel || runtimeLabel || 'The agent';
  // The two buttons answer to different rules, and used to disagree in silence:
  // one came back in the conversation's own mode and the other always dropped
  // to asking. They now follow the one rule — continue replays the grant, begin
  // takes the preference — and each says which mode it lands in, so a bypass is
  // never restored, or dropped, without the user seeing it happen (#134).
  const resumeMode = bypassPermissions ? 'approvals bypassed' : 'asks first';
  const freshMode = preferenceBypasses ? 'approvals bypassed' : 'asks first';
  return (
    <div
      role="alert"
      style={{
        display: 'grid',
        gap: 'var(--space-2)',
        padding: 'var(--space-3)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        background: 'var(--card)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
        <span aria-hidden="true" style={{ color: 'var(--warning)', display: 'inline-flex' }}>
          <Icon name="plug" size={16} />
        </span>
        <strong style={{ fontSize: 'var(--text-body)' }}>
          {`${label} is no longer running`}
        </strong>
      </div>

      <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--muted-foreground)' }}>
        {reason.canResume
          ? 'This conversation is safe — it is stored on disk. Pick it up where it left off, or start a new one in this tab.'
          : 'This conversation is safe — it is stored on disk. Nothing recorded which conversation the agent had, so it cannot be given its context back; a new one starts with this transcript closed.'}
        {' '}
        {/* Spelled out for the case where starting over is the only button
            there is: without a Resume beside it to compare against, the label
            alone leaves nothing to say what changed. */}
        {`A new conversation runs with ${freshMode}, from your Settings.`}
      </p>

      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        {/* Offered only when it can actually deliver. A "Resume" that quietly
            produced an agent with no memory of the transcript above it would be
            the most expensive kind of wrong: it looks like it worked. */}
        {reason.canResume ? (
          <Button variant="primary" onClick={onResume}>
            {`Resume this conversation · ${resumeMode}`}
          </Button>
        ) : null}
        <Button variant={reason.canResume ? 'ghost' : 'primary'} onClick={onFresh}>
          {`Start a new chat · ${freshMode}`}
        </Button>
      </div>
    </div>
  );
}

/**
 * The three states that owe the user a sentence.
 *
 * `exited` carries no button of its own: the recovery offer above is where
 * that choice lives, and it appears on the same condition with more to say.
 */
function StateNotice({
  state,
  runtimeLabel,
  error,
}: {
  state: ChatState;
  runtimeLabel: string;
  error?: string;
}) {
  if (state === 'error') {
    return (
      <Notice tone="var(--destructive)" icon="circle-alert" role="alert">
        {error || `${runtimeLabel} reported an error.`}
      </Notice>
    );
  }

  if (state === 'exited') {
    return (
      <Notice tone="var(--muted-foreground)" icon="plug" role="status">
        {`${runtimeLabel} has exited. This transcript is read-only.`}
        {error ? <span style={{ color: 'var(--destructive)' }}> {error}</span> : null}
      </Notice>
    );
  }

  if (state === 'starting') {
    return (
      <Notice tone="var(--muted-foreground)" icon="loader-circle" role="status" pulse>
        {`Starting ${runtimeLabel}…`}
      </Notice>
    );
  }

  return null;
}

function Notice({
  tone,
  icon,
  role,
  pulse,
  children,
}: {
  tone: string;
  icon: string;
  role: 'alert' | 'status';
  pulse?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      role={role}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        padding: 'var(--space-2)',
        border: `1px solid ${tone}`,
        borderRadius: 'var(--radius)',
        background: 'var(--card)',
        color: tone,
        fontSize: 'var(--text-sm)',
        lineHeight: 'var(--leading-snug)',
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          marginTop: 1,
          animation: pulse ? 'relay-pulse 1.4s var(--ease-standard) infinite' : undefined,
        }}
      >
        <Icon name={icon} size={13} />
      </span>
      <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>{children}</span>
    </div>
  );
}

/**
 * How many pixels of the viewport the on-screen keyboard is covering.
 *
 * Zero everywhere the browser already resizes the layout viewport for the
 * keyboard (Android Chrome), so the two mechanisms cannot double-count — the
 * same reasoning, and the same 120px "that is a keyboard, not a URL bar"
 * threshold, as watchKeyboardInset in terminal/keyboard.ts.
 *
 * The mobile bar sits below this pane and keeps its own height in the flow, so
 * only the part of the keyboard that reaches past the bar has to be given back.
 */
const KEYBOARD_MIN_INSET_PX = 120;
const MOBILE_BAR_FALLBACK_PX = 56;

function useKeyboardInset(isMobile: boolean): number {
  const [inset, setInset] = React.useState(0);

  React.useEffect(() => {
    if (!isMobile) {
      setInset(0);
      return;
    }
    const viewport = window.visualViewport;
    if (!viewport) return;

    const apply = () => {
      const covered = visualViewportKeyboardInset(viewport);
      if (covered <= KEYBOARD_MIN_INSET_PX) {
        setInset(0);
        return;
      }
      setInset(Math.max(0, covered - mobileBarHeight()));
    };

    apply();
    viewport.addEventListener('resize', apply);
    viewport.addEventListener('scroll', apply);
    document.addEventListener('focusin', apply);
    document.addEventListener('focusout', apply);
    return () => {
      viewport.removeEventListener('resize', apply);
      viewport.removeEventListener('scroll', apply);
      document.removeEventListener('focusin', apply);
      document.removeEventListener('focusout', apply);
    };
  }, [isMobile]);

  return inset;
}

function mobileBarHeight(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--mobile-bar-height');
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : MOBILE_BAR_FALLBACK_PX;
}

/**
 * Which message holds a given tool call, or '' when the transcript has none.
 *
 * Used only to decide whether a pending question already has a card inside the
 * conversation. A question whose call is above the loaded window — or whose call
 * never arrived — needs the pinned card instead, and asking the transcript is
 * the only way to tell those apart from one that is on screen.
 */
function messageIdOfTool(transcript: ChatTranscript, toolId: string): string {
  for (const message of transcript.messages) {
    for (const block of message.blocks) {
      if (block.kind === 'tool' && block.toolId === toolId) return message.id;
    }
  }
  return '';
}
