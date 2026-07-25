import * as React from 'react';
import { ChatAttachment, ChatState } from '../../../shared/chat-events.js';
import { uploadAttachment } from '../../chat/attachments-api.js';
import { ChatController, type ChatUnavailable } from '../../chat/controller.js';
import { findFiles } from '../../chat/workspace-api.js';
import type { ChatPanelId, ChatViewSettings } from '../../chat/view-settings.js';
import { DEFAULT_CHAT_VIEW, enabledPanels } from '../../chat/view-settings.js';
import { Badge } from '../../ui/relay/Badge.js';
import { Button } from '../../ui/relay/Button.js';
import { Icon } from '../../ui/relay/Icon.js';
import { IconButton } from '../../ui/relay/IconButton.js';
import { Tooltip } from '../../ui/relay/Tooltip.js';
import { Composer } from './Composer.js';
import { MessageList } from './MessageList.js';
import { PermissionCard } from './PermissionCard.js';
import { PlanPanel } from './PlanPanel.js';
import { UsageMeter } from './UsageMeter.js';
import { WorkspacePanel } from './WorkspacePanel.js';

/**
 * The chat surface, assembled.
 *
 * Everything on screen here is built elsewhere; this file decides where each
 * piece sits and which of them the current transcript state justifies showing.
 *
 * One subscription, at this level only. The transcript's version counter says
 * "something moved", which is all the header, the rails and the pinned regions
 * need — a streaming turn moves one message thousands of times and MessageList
 * already splits that traffic down to the single bubble that changed (see
 * MessageList and MessageBubble). Copying the transcript into React state here
 * would undo that split and rebuild the whole conversation per token.
 *
 * The two regions below the transcript — approvals and the composer — are
 * outside the scroller on purpose. A blocked agent and the only control that
 * unblocks it must not be something the user can scroll away from.
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
  /** What this surface shows. Panels, reasoning, tool cards, plan, usage. */
  view?: ChatViewSettings;
  /** Persist a change made from inside the surface, e.g. closing the rail. */
  onViewChange?: (next: ChatViewSettings) => void;
  /**
   * Whether this session was launched with tool approvals bypassed.
   *
   * Passed in rather than read off the transcript because the flag lives on the
   * server snapshot (`ChatSnapshot.bypassPermissions`) and ChatController does
   * not retain it. The badge it drives is not a launch-time notice: as long as
   * this is true the session acts without asking, and that has to stay on
   * screen for the whole session rather than scrolling away with a toast.
   */
  bypassPermissions?: boolean;
}

interface StateMeta {
  label: string;
  icon: string;
  color: string;
  /** Reuse of the existing relay-pulse keyframe, for states that are ongoing. */
  pulse?: boolean;
}

const STATE_META: Record<ChatState, StateMeta> = {
  starting: { label: 'Starting', icon: 'loader-circle', color: 'var(--muted-foreground)', pulse: true },
  idle: { label: 'Ready', icon: 'circle', color: 'var(--muted-foreground)' },
  thinking: { label: 'Thinking', icon: 'brain', color: 'var(--ansi-green)', pulse: true },
  running: { label: 'Working', icon: 'loader-circle', color: 'var(--ansi-green)', pulse: true },
  awaiting_permission: { label: 'Waiting for you', icon: 'shield', color: 'var(--warning)' },
  exited: { label: 'Exited', icon: 'plug', color: 'var(--muted-foreground)' },
  error: { label: 'Error', icon: 'circle-alert', color: 'var(--destructive)' },
};

/** Announced but not painted — the header shows a leaf, screen readers get the path. */
const SR_ONLY: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0,0,0,0)',
};

/** Touch-target floor for this app's phone layout; matches IconButton size="lg". */
const TOUCH = 34;

export function ChatView({
  controller,
  runtime,
  runtimeLabel,
  workingDir,
  isMobile = false,
  onOpenSettings,
  bypassPermissions = false,
  view = DEFAULT_CHAT_VIEW,
  onViewChange,
}: ChatViewProps) {
  const transcript = controller.transcript;

  // The returned version is deliberately unused: everything below reads the
  // transcript's live getters, and the subscription is here only to schedule
  // the render in which they are read. Static rendering has no store at all,
  // so the third argument is required or React throws — same constant
  // MessageList passes for the same reason.
  React.useSyncExternalStore(transcript.subscribe, transcript.getVersion, ZERO);

  const chatState = transcript.chatState;
  const plan = transcript.plan;
  const pending = transcript.pendingPermissions;
  const exited = chatState === 'exited';

  const unavailable = controller.unavailableReason;

  // The log replays to `idle` on its own — a conversation that ended on a
  // finished turn reads as Ready — so a session whose process is gone showed a
  // green "Ready" pill above a notice saying it was not running. The state of
  // the *process* wins over the state of the transcript.
  const meta = unavailable ? STATE_META.exited : STATE_META[chatState] || STATE_META.idle;

  const relaunch = React.useCallback(
    (resume: boolean) => controller.relaunch(runtime, { resume, bypassPermissions }),
    [controller, runtime, bypassPermissions],
  );

  const [planOpen, setPlanOpen] = React.useState(false);
  const keyboardInset = useKeyboardInset(isMobile);

  const send = React.useCallback(
    (text: string, attachments: ChatAttachment[]) => controller.sendTurn(text, attachments),
    [controller],
  );
  const interrupt = React.useCallback(() => controller.interrupt(), [controller]);
  const loadMore = React.useCallback(() => controller.loadMore(), [controller]);
  const respond = React.useCallback(
    (requestId: string, optionId: string) => controller.respondPermission(requestId, optionId),
    [controller],
  );
  const cancelQueued = React.useCallback(
    (queuedId: string) => controller.cancelQueued(queuedId),
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

  const showRail = !isMobile && view.showPlan && plan.length > 0;
  const showPlanSheet = isMobile && view.showPlan && plan.length > 0;

  const panelsAvailable = enabledPanels(view).length > 0;
  const workspaceOpen = view.panelOpen && panelsAvailable;

  const setView = React.useCallback(
    (patch: Partial<ChatViewSettings>) => onViewChange?.({ ...view, ...patch }),
    [onViewChange, view],
  );

  const selectPanel = React.useCallback(
    (panelTab: ChatPanelId) => setView({ panelTab }),
    [setView],
  );
  const closePanel = React.useCallback(() => setView({ panelOpen: false }), [setView]);

  // On a phone the rail replaces the conversation rather than sitting beside
  // it: 320px of panel next to a 390px viewport leaves neither usable.
  const workspaceTakesOver = isMobile && workspaceOpen;

  return (
    <section
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
      }}
    >
      <header
        style={{
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          flexWrap: 'wrap',
          minHeight: isMobile ? TOUCH + 6 : 34,
          padding: `var(--space-1) var(--space-3)`,
          borderBottom: '1px solid var(--border)',
          background: 'var(--chrome)',
          color: 'var(--chrome-foreground)',
        }}
      >
        <span
          style={{
            fontSize: 'var(--text-ui)',
            fontWeight: 'var(--font-semibold)' as React.CSSProperties['fontWeight'],
            letterSpacing: 'var(--tracking-tight)',
            whiteSpace: 'nowrap',
          }}
        >
          {runtimeLabel}
        </span>

        <Tooltip label={workingDir} side="bottom">
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              minWidth: 0,
              maxWidth: isMobile ? 140 : 260,
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-xs)',
              color: 'var(--muted-foreground)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            <Icon name="folder" size={11} />
            {basename(workingDir)}
            <span style={SR_ONLY}>{workingDir}</span>
          </span>
        </Tooltip>

        <Badge variant="outline">Beta</Badge>

        {bypassPermissions ? (
          <Badge variant="warning" dot>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Icon name="shield" size={10} />
              Approvals bypassed
            </span>
          </Badge>
        ) : null}

        <div
          style={{
            marginLeft: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2-5)',
            minWidth: 0,
          }}
        >
          {/* UsageMeter renders nothing at all when the runtime has reported no
              numbers, which is exactly the "when there is usage to show" rule —
              deciding it twice is how the two answers drift apart. */}
          {view.showUsage ? (
            <UsageMeter usage={transcript.usage} capabilities={transcript.capabilities} compact />
          ) : null}

          <div
            role="status"
            aria-live="polite"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}
          >
            <span
              style={{
                display: 'inline-flex',
                color: meta.color,
                animation: meta.pulse ? 'relay-pulse 1.4s var(--ease-standard) infinite' : undefined,
              }}
            >
              <Icon name={meta.icon} size={11} />
            </span>
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--muted-foreground)' }}>
              {meta.label}
            </span>
          </div>

          {panelsAvailable && onViewChange ? (
            <IconButton
              type="button"
              size={isMobile ? 'lg' : 'md'}
              label={workspaceOpen ? 'Hide workspace panel' : 'Show workspace panel'}
              aria-pressed={workspaceOpen}
              onClick={() => setView({ panelOpen: !workspaceOpen })}
              style={workspaceOpen ? { color: 'var(--foreground)' } : undefined}
            >
              <Icon name="panel-left" />
            </IconButton>
          ) : null}

          {onOpenSettings ? (
            <IconButton
              type="button"
              size={isMobile ? 'lg' : 'md'}
              label="Chat display settings"
              onClick={onOpenSettings}
            >
              <Icon name="settings" />
            </IconButton>
          ) : null}
        </div>
      </header>

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* Ahead of the transcript in the DOM as well as on screen: the rail
            is a sibling navigation surface, and a keyboard user reaching it
            after the whole conversation would have to tab past every message
            in it. */}
        {workspaceOpen ? (
          <WorkspacePanel
            sessionId={controller.sessionId}
            workingDir={workingDir}
            transcript={transcript}
            settings={view}
            onSelectTab={selectPanel}
            onClose={closePanel}
            onResize={(panelWidth) => setView({ panelWidth })}
            isMobile={isMobile}
          />
        ) : null}

        {/* The conversation column: the transcript and, below it, everything
            that must never scroll away. The composer used to sit outside this
            row entirely, which made it the full width of the surface — so the
            workspace rail was drawn over the left end of the input, and
            dragging the rail wider covered more of it. It belongs to this
            column, and is bounded by the same two rails the transcript is. */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            // Hidden rather than unmounted on a phone: the scroll position of a
            // long conversation is worth more than the few nodes this saves.
            display: workspaceTakesOver ? 'none' : 'flex',
            flexDirection: 'column',
            minHeight: 0,
          }}
        >
          {/* An empty transcript is MessageList's own quiet prompt to start.
              Duplicating it here would put two invitations on one screen. */}
          <MessageList
            transcript={transcript}
            onLoadMore={loadMore}
            showThinking={view.showThinking}
            showToolCalls={view.showToolCalls}
          />

          <div
            style={{
              flex: '0 0 auto',
              display: 'grid',
              // `minmax(0, 1fr)`, not the implicit `auto` track. A grid item
              // has `min-width: auto` exactly the way a flex item does, so the
              // implicit track refuses to go below the composer's min-content
              // width — and once the composer lived in this column rather than
              // across the whole surface, dragging the workspace rail wide
              // pushed it straight off the right-hand edge instead of shrinking
              // it. `minWidth: 0` on the container alone does not fix this; the
              // track is what has to be allowed to shrink.
              gridTemplateColumns: 'minmax(0, 1fr)',
              minWidth: 0,
              gap: 'var(--space-2)',
              padding: 'var(--space-2) var(--space-3) var(--space-3)',
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

            {showPlanSheet ? (
              <div>
                <button
                  type="button"
                  aria-expanded={planOpen}
                  onClick={() => setPlanOpen((open) => !open)}
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
                  <Icon name={planOpen ? 'chevron-down' : 'chevron-right'} size={12} />
                  <Icon name="list-todo" size={12} />
                  Plan
                  <span style={{ marginLeft: 'auto', color: 'var(--muted-foreground)' }}>
                    {plan.filter((item) => item.status === 'completed').length} of {plan.length}
                  </span>
                </button>
                {planOpen ? (
                  <div style={{ marginTop: 'var(--space-1)', maxHeight: '30vh', overflowY: 'auto' }}>
                    <PlanPanel items={plan} compact />
                  </div>
                ) : null}
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
              busy={transcript.busy}
              capabilities={transcript.capabilities}
              // Only a dead session takes the input away. An approval on screen
              // used to disable it too, which meant the one moment you most
              // want to type the follow-up — while the agent waits on you — was
              // the one moment you could not. It queues instead.
              // Also while the recovery offer is up: a message typed into a
              // session with no process would come straight back as the same
              // failure, and the choice above is what has to happen first.
              disabled={exited || Boolean(unavailable)}
              placeholder={placeholderFor(chatState, runtimeLabel)}
              queued={transcript.queuedTurns}
              onCancelQueued={cancelQueued}
              onFindFiles={findProjectFiles}
              onUpload={upload}
            />
          </div>
        </div>

        {showRail && !workspaceOpen ? (
          <aside
            aria-label="Plan"
            style={{
              flex: '0 0 auto',
              width: 264,
              minHeight: 0,
              overflowY: 'auto',
              padding: 'var(--space-2)',
              borderLeft: '1px solid var(--border)',
              background: 'var(--sidebar)',
            }}
          >
            <PlanPanel items={plan} />
          </aside>
        ) : null}
      </div>
    </section>
  );
}

const ZERO = (): number => 0;

function placeholderFor(state: ChatState, runtimeLabel: string): string {
  if (state === 'exited') return 'This session has ended';
  // No longer 'answer this before you can type': the composer stays live and
  // queues, so the sentence has to describe what happens rather than forbid it.
  if (state === 'awaiting_permission') return 'Answer above — or type the next message';
  return `Message ${runtimeLabel}…`;
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

/** Trailing-slash tolerant leaf of a path, in either separator style. */
function basename(dir: string): string {
  const trimmed = String(dir || '').replace(/[/\\]+$/, '');
  if (!trimmed) return dir || '/';
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return cut >= 0 ? trimmed.slice(cut + 1) || trimmed : trimmed;
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
