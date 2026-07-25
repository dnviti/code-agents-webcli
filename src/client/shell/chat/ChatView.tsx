import * as React from 'react';
import { ChatAttachment, ChatState } from '../../../shared/chat-events.js';
import { ChatController } from '../../chat/controller.js';
import { Badge } from '../../ui/relay/Badge.js';
import { Icon } from '../../ui/relay/Icon.js';
import { IconButton } from '../../ui/relay/IconButton.js';
import { Tooltip } from '../../ui/relay/Tooltip.js';
import { Composer } from './Composer.js';
import { MessageList } from './MessageList.js';
import { PermissionCard } from './PermissionCard.js';
import { PlanPanel } from './PlanPanel.js';
import { UsageMeter } from './UsageMeter.js';

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
  onOpenSettings?: () => void;
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
}: ChatViewProps) {
  const transcript = controller.transcript;

  // The returned version is deliberately unused: everything below reads the
  // transcript's live getters, and the subscription is here only to schedule
  // the render in which they are read. Static rendering has no store at all,
  // so the third argument is required or React throws — same constant
  // MessageList passes for the same reason.
  React.useSyncExternalStore(transcript.subscribe, transcript.getVersion, ZERO);

  const chatState = transcript.chatState;
  const meta = STATE_META[chatState] || STATE_META.idle;
  const plan = transcript.plan;
  const pending = transcript.pendingPermissions;
  const exited = chatState === 'exited';
  const awaiting = chatState === 'awaiting_permission';

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

  const showRail = !isMobile && plan.length > 0;
  const showPlanSheet = isMobile && plan.length > 0;

  return (
    <section
      aria-label={`${runtimeLabel} chat`}
      data-runtime={runtime}
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minHeight: 0,
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
          <UsageMeter usage={transcript.usage} capabilities={transcript.capabilities} compact />

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

          {onOpenSettings ? (
            <IconButton
              type="button"
              size={isMobile ? 'lg' : 'md'}
              label="Settings"
              onClick={onOpenSettings}
            >
              <Icon name="settings" />
            </IconButton>
          ) : null}
        </div>
      </header>

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {/* An empty transcript is MessageList's own quiet prompt to start.
              Duplicating it here would put two invitations on one screen. */}
          <MessageList transcript={transcript} onLoadMore={loadMore} />
        </div>

        {showRail ? (
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

      <div
        style={{
          flex: '0 0 auto',
          display: 'grid',
          gap: 'var(--space-2)',
          padding: 'var(--space-2) var(--space-3) var(--space-3)',
          borderTop: '1px solid var(--border)',
          background: 'var(--background)',
          // iOS does not shrink the layout viewport for the on-screen keyboard,
          // and the shell's existing lift (terminal/keyboard.ts) only fires for
          // the xterm textarea, so the composer would sit under the keyboard.
          // Margin rather than padding: it has to take height away from the
          // flex column, which is what pushes the composer back into view.
          marginBottom: keyboardInset || undefined,
          paddingBottom: isMobile ? 'env(safe-area-inset-bottom, 0px)' : undefined,
        }}
      >
        <StateNotice state={chatState} runtimeLabel={runtimeLabel} error={transcript.lastError} />

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
          disabled={exited || awaiting}
          placeholder={placeholderFor(chatState, runtimeLabel)}
        />
      </div>
    </section>
  );
}

const ZERO = (): number => 0;

function placeholderFor(state: ChatState, runtimeLabel: string): string {
  if (state === 'exited') return 'This session has ended';
  if (state === 'awaiting_permission') return 'Answer the approval above to continue';
  return `Message ${runtimeLabel}…`;
}

/**
 * The three states that owe the user a sentence.
 *
 * `exited` deliberately carries no button: nothing in this pane can restart a
 * dead process, and an affordance that cannot deliver is worse than the plain
 * statement that the session is over.
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
