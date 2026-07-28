import * as React from 'react';
import { ChatAttachment, ChatState } from '../../../shared/chat-events.js';
import { uploadAttachment } from '../../chat/attachments-api.js';
import { ChatController, type ChatUnavailable } from '../../chat/controller.js';
import { fetchStatus, findFiles } from '../../chat/workspace-api.js';
import { activityEvents } from '../../chat/activity.js';
import type { ChatTranscript } from '../../chat/transcript.js';
import {
  groupTurns,
  isTurnOpen,
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
import { FloatingMenu } from '../FloatingMenu.js';
import { Composer } from './Composer.js';
import { MessageList, type MessageListHandle } from './MessageList.js';
import { hasVisibleContent, messageText } from './MessageBubble.js';
import { PermissionCard } from './PermissionCard.js';
import { QuestionCard } from './QuestionCard.js';
import { PlanPanel } from './PlanPanel.js';
import { SessionHeader } from './SessionHeader.js';
import { LiveStreamRibbon } from './StreamRibbon.js';
import { TerminalSplit } from './TerminalSplit.js';
import { TracePanel } from './TracePanel.js';
import { TranscriptSearch } from './TranscriptSearch.js';
import { TurnIndex } from './TurnIndex.js';
import { WorkspacePanel } from './WorkspacePanel.js';
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
  isMobile?: boolean;
  /**
   * Opens the chat's own display settings — not the app's.
   *
   * The two were the same dialog, which meant the gear inside a conversation
   * offered font size, terminal typeface and install: a page of controls that
   * could not change anything on the surface they were reached from.
   */
  onOpenSettings?: () => void;
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
  isMobile = false,
  onOpenSettings,
  view = DEFAULT_CHAT_VIEW,
  onViewChange,
  theme,
  onToggleTheme,
  menuActions,
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
  // Only the questions that have nowhere else to be drawn. A question that
  // names the call that asked it renders inside the conversation at that call,
  // which is where it was asked; this is the safety net for one that could not
  // be correlated, and without it that question would have no button anywhere
  // and the turn behind it would never move.
  const strayQuestions = React.useMemo(
    () =>
      transcript.pendingQuestions.filter(
        (request) => !request.toolId || !transcript.message(messageIdOfTool(transcript, request.toolId)),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [transcript, version],
  );
  const exited = chatState === 'exited';
  const unavailable = controller.unavailableReason;
  const busy = transcript.busy;
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
  const turns = React.useMemo(
    () => groupTurns(messages, chatState),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messages, version, chatState],
  );
  // The index lists the conversation, not the part of it this browser holds:
  // the recorded run of turns with the live ones laid over it (#86). Derived
  // rather than stored, like the turns themselves.
  const indexRows = React.useMemo(
    () => turnIndexRows(controller.recordedTurns?.turns ?? [], turns),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [controller, turns, version],
  );
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
  // Paired with a counter, not held as a bare id: clicking the same work pill
  // twice has to scroll the rail twice, and a string that did not change would
  // leave the timeline's effect with nothing to react to.
  const [focus, setFocus] = React.useState<{ id?: string; nonce: number }>({ nonce: 0 });
  const [indexSheet, setIndexSheet] = React.useState(false);
  const [planSheet, setPlanSheet] = React.useState(false);
  // A draft seed, not a controlled value: making the composer controlled would
  // re-render this component — and re-derive the turns and the whole activity
  // projection — on every keystroke.
  const [seed, setSeed] = React.useState<{ key: number; text: string }>({ key: 0, text: '' });
  // A half-typed message belongs to the conversation it was typed into. The
  // surface is keyed by session id and remounts on a tab switch, so without
  // this the draft is destroyed by looking at another chat for a moment.
  const [draft, setDraft] = useSessionDraft(controller.sessionId);

  const list = React.useRef<MessageListHandle | null>(null);
  const root = React.useRef<HTMLElement | null>(null);
  const terminalRegion = React.useRef<HTMLDivElement | null>(null);
  const width = useElementWidth(root);
  const keyboardInset = useKeyboardInset(isMobile);
  const branch = useBranch(controller.sessionId, version);

  const setView = React.useCallback(
    (patch: Partial<ChatViewSettings>) => onViewChange?.({ ...view, ...patch }),
    [onViewChange, view],
  );

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
      controller.sendTurn(text, attachments);
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
  const loadMore = React.useCallback(() => controller.loadMore(), [controller]);
  const respond = React.useCallback(
    (requestId: string, optionId: string) => controller.respondPermission(requestId, optionId),
    [controller],
  );
  const answerQuestion = React.useCallback(
    (requestId: string, optionIds: string[], skipped: boolean) =>
      controller.answerQuestion(requestId, optionIds, skipped),
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
        list.current?.scrollToTurn(id);
        return;
      }
      // An entry from before what is loaded. The index lists the whole
      // conversation, so choosing one has to fetch it rather than quietly do
      // nothing — the scroll waits until it is actually here.
      void controller.loadUntilLoaded(id).then((here) => {
        if (here) list.current?.scrollToTurn(id);
      });
    },
    [openTurn, controller, messages],
  );

  const jumpLatest = React.useCallback(() => {
    setSelectedTurnId(null);
    list.current?.pin();
  }, []);

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
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, interrupt, jumpLatest, stepTurn, toggleRail, toggleTerminal]);

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
      { id: 'chat-turns', label: 'Jump to a turn', icon: 'panel-left', active: indexVisible || indexSheet, expands: true, group: 'surface', onPress: openIndex },
      { id: 'chat-display', label: 'Display settings', icon: 'settings', expands: true, group: 'surface', onPress: () => onOpenSettings?.() },
      ...(menuActions ?? []).map((action) => ({ ...action, group: 'session' })),
    ],
    [indexVisible, indexSheet, openIndex, onOpenSettings, menuActions],
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
        ...(proseVariables(view) as React.CSSProperties),
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
              it sat exactly on the send button. */}
          {isMobile ? <FloatingMenu actions={phoneMenu} /> : null}

          {searchOpen ? (
            <TranscriptSearch
              messages={messages}
              hasMore={transcript.hasMore}
              onJump={revealMessage}
              onClose={() => setSearchOpen(false)}
            />
          ) : null}

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
            onRetry={retryTurn}
            showThinking={view.showThinking}
            showToolCalls={view.showToolCalls}
            onAnswerQuestion={answerQuestion}
          />

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
              settings={view}
              trace={trace}
              onSelectTab={(panelTab: ChatPanelId) => setView({ panelTab })}
              onClose={() => setView({ panelOpen: false })}
              isMobile
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
                {strayQuestions.map((request) => (
                  <QuestionCard
                    key={request.requestId}
                    request={request}
                    question={request.question}
                    header={request.header}
                    multiSelect={request.multiSelect}
                    options={request.options}
                    onAnswer={answerQuestion}
                  />
                ))}
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
                  <PermissionCard key={request.requestId} request={request} onRespond={respond} />
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
              disabled={exited || Boolean(unavailable)}
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
              draft={draft}
              onDraftChange={setDraft}
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
            settings={view}
            trace={trace}
            onSelectTab={(panelTab: ChatPanelId) => setView({ panelTab })}
            onClose={() => setView({ panelOpen: false })}
            onResize={(panelWidth) => setView({ panelWidth })}
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
    </section>
    </PhoneContext.Provider>
  );
}

const ZERO = (): number => 0;

/**
 * The row that stands for a message on screen.
 *
 * Itself, unless it is a step that said nothing — then the next message in its
 * turn that did, because that is the one carrying its work pill. Failing that,
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

/**
 * A draft, kept against its own session id.
 *
 * Session storage rather than local: a draft is something you are in the middle
 * of, and one restored into a new window a week later is a surprise rather than
 * a convenience. Writes are cheap and rare enough not to need debouncing — a
 * keystroke is one small string into one key.
 */
function useSessionDraft(sessionId: string): [string, (next: string) => void] {
  const key = `cc-web-chat-draft:${sessionId}`;
  const [draft, setDraft] = React.useState(() => {
    try {
      return sessionStorage.getItem(key) ?? '';
    } catch {
      // Private browsing, or storage disabled. The draft simply does not persist.
      return '';
    }
  });

  const update = React.useCallback(
    (next: string) => {
      setDraft(next);
      try {
        if (next) sessionStorage.setItem(key, next);
        else sessionStorage.removeItem(key);
      } catch {
        // Applying it anyway is right: it works for this session, it just will
        // not survive a reload.
      }
    },
    [key],
  );

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
  onResume,
  onFresh,
}: {
  reason: ChatUnavailable;
  /** What this pane calls the runtime, used when the server named none. */
  runtimeLabel: string;
  onResume: () => void;
  onFresh: () => void;
}) {
  const label = reason.runtimeLabel || runtimeLabel || 'The agent';
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
      </p>

      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        {/* Offered only when it can actually deliver. A "Resume" that quietly
            produced an agent with no memory of the transcript above it would be
            the most expensive kind of wrong: it looks like it worked. */}
        {reason.canResume ? (
          <Button variant="primary" onClick={onResume}>
            Resume this conversation
          </Button>
        ) : null}
        <Button variant={reason.canResume ? 'ghost' : 'primary'} onClick={onFresh}>
          Start a new chat
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
      const covered = window.innerHeight - viewport.height;
      if (covered <= KEYBOARD_MIN_INSET_PX) {
        setInset(0);
        return;
      }
      setInset(Math.max(0, covered - mobileBarHeight()));
    };

    apply();
    viewport.addEventListener('resize', apply);
    viewport.addEventListener('scroll', apply);
    return () => {
      viewport.removeEventListener('resize', apply);
      viewport.removeEventListener('scroll', apply);
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
