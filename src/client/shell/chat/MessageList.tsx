import * as React from 'react';
import { ChatTranscript } from '../../chat/transcript.js';
import { createStick, BOTTOM_SLACK, type StickHandle } from '../../chat/stick.js';
import type { TurnSummary } from '../../chat/turns.js';
import { Button } from '../../ui/relay/Button.js';
import { Icon } from '../../ui/relay/Icon.js';
import { MessageBubble } from './MessageBubble.js';
import { TurnStrip } from './TurnStrip.js';

/**
 * The scrolling transcript, grouped into turns.
 *
 * Two subscriptions, deliberately split. This component watches the transcript
 * version, which tells it only that the set of messages may have moved; each
 * bubble watches its own message. A streaming turn fires thousands of events
 * against one message, and if the list re-rendered every bubble for each of
 * them the surface would stall at a few hundred messages. See MessageBubble.
 *
 * Staying pinned to the bottom is delegated to `createStick`, which samples live
 * geometry rather than React state and re-pins on all four of the things that
 * move a scroller's bottom edge — a commit, the content growing, the *viewport*
 * shrinking (the terminal split opening is exactly this), and late async layout.
 * The user scrolling up is an instruction, and it outranks anything the agent is
 * emitting.
 */

export interface MessageListHandle {
  /** Put a turn's strip at the top of the viewport. */
  scrollToTurn(turnId: string): void;
  /** Bring a single message into view, e.g. from the trace timeline. */
  scrollToMessage(messageId: string): void;
  /** Force the scroller back to the bottom. */
  pin(): void;
}

export interface MessageListProps {
  transcript: ChatTranscript;
  /** Derived once by the chat root and shared with the turn index. */
  turns: TurnSummary[];
  onLoadMore?: () => void;
  onFork?: (messageId: string) => void;
  onRetry?: (messageId: string) => void;
  onShowWork?: (messageId: string) => void;
  onEditTurn?: (text: string) => void;
  onCopyTurn?: (turnId: string) => void;
  onForkTurn?: (turnId: string) => void;
  /** Which turn the index has selected; its strip is the sticky one. */
  currentTurnId?: string;
  /**
   * Turns whose body is shown. Absent from this set, a turn's strip stays
   * mounted (so copy/branch keep working) but its messages are hidden.
   * Undefined — no caller managing fold state — reads as "every turn open".
   */
  openTurnIds?: ReadonlySet<string>;
  onToggleTurn?: (turnId: string) => void;
  /**
   * Passed down as primitives, not as a settings object.
   *
   * Every bubble is `React.memo`'d against a message that never changes
   * identity, and a fresh options object per render would defeat that for the
   * whole list on every token of a streaming turn.
   */
  showThinking?: boolean;
  showToolCalls?: boolean;
}

/** How close to the top still counts as asking for the previous page. */
const TOP_SLACK = 48;

// Scroll correction has to land before the browser paints or the transcript
// visibly jumps, so this is a layout effect on the client. Static rendering has
// no layout at all, and React warns about the hook there rather than skipping
// it quietly, so the check is made once here instead of at every call site.
const useScrollEffect =
  typeof window === 'undefined' ? React.useEffect : React.useLayoutEffect;

export const MessageList = React.forwardRef<MessageListHandle, MessageListProps>(
  function MessageList(
    {
      transcript,
      turns,
      onLoadMore,
      onFork,
      onRetry,
      onShowWork,
      onEditTurn,
      onCopyTurn,
      onForkTurn,
      currentTurnId,
      openTurnIds,
      onToggleTurn,
      showThinking = true,
      showToolCalls = true,
    },
    handle,
  ) {
    const version = React.useSyncExternalStore(transcript.subscribe, transcript.getVersion, ZERO);
    const messages = React.useMemo(
      () => transcript.messages,
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [transcript, version],
    );

    const scroller = React.useRef<HTMLDivElement | null>(null);
    const content = React.useRef<HTMLDivElement | null>(null);
    const [stuck, setStuck] = React.useState(true);

    // Read off the transcript rather than tracked here. This used to be local
    // state cleared only when a page actually prepended a message — so a page
    // that legitimately came back with none (or never came back at all) left
    // "Loading earlier messages" on screen for the rest of the session. The
    // controller owns the request's lifetime and settles it however it ends.
    const loadingMore = transcript.loadingMore;

    const firstIdRef = React.useRef<string | undefined>(undefined);
    const heightRef = React.useRef(0);

    // One handle for the life of the component; React attaches and detaches the
    // elements through the callback refs below.
    const stickRef = React.useRef<StickHandle | null>(null);
    if (stickRef.current === null) stickRef.current = createStick(BOTTOM_SLACK);
    const stick = stickRef.current;
    React.useEffect(() => () => stick.dispose(), [stick]);

    // Kept in refs so a caller passing fresh closures every render does not
    // defeat React.memo on every bubble in the list.
    const forkRef = React.useRef(onFork);
    const retryRef = React.useRef(onRetry);
    const loadRef = React.useRef(onLoadMore);
    const workRef = React.useRef(onShowWork);
    const editRef = React.useRef(onEditTurn);
    React.useEffect(() => {
      forkRef.current = onFork;
      retryRef.current = onRetry;
      loadRef.current = onLoadMore;
      workRef.current = onShowWork;
      editRef.current = onEditTurn;
    }, [onFork, onRetry, onLoadMore, onShowWork, onEditTurn]);

    const fork = React.useMemo(
      () => (onFork ? (messageId: string) => forkRef.current?.(messageId) : undefined),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [Boolean(onFork)],
    );
    const retry = React.useMemo(
      () => (onRetry ? (messageId: string) => retryRef.current?.(messageId) : undefined),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [Boolean(onRetry)],
    );
    const showWork = React.useMemo(
      () => (onShowWork ? (messageId: string) => workRef.current?.(messageId) : undefined),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [Boolean(onShowWork)],
    );
    const edit = React.useMemo(
      () => (onEditTurn ? (text: string) => editRef.current?.(text) : undefined),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [Boolean(onEditTurn)],
    );

    // The controller de-duplicates concurrent requests, so this only has to
    // avoid asking for something that does not exist.
    const requestMore = React.useCallback(() => {
      if (!loadRef.current || transcript.loadingMore || !transcript.hasMore) return;
      loadRef.current();
    }, [transcript]);

    const attachScroller = React.useCallback(
      (node: HTMLDivElement | null) => {
        scroller.current = node;
        stick.attachScroller(node);
      },
      [stick],
    );

    const attachContent = React.useCallback(
      (node: HTMLDivElement | null) => {
        content.current = node;
        stick.attachContent(node);
      },
      [stick],
    );

    const onScroll = React.useCallback(() => {
      const el = scroller.current;
      if (!el) return;
      stick.sample();
      const atBottom = stick.isStuck();
      setStuck((was) => (was === atBottom ? was : atBottom));
      if (el.scrollTop <= TOP_SLACK) requestMore();
    }, [requestMore, stick]);

    const scrollToId = React.useCallback((selector: string) => {
      const el = scroller.current;
      if (!el) return;
      const target = el.querySelector(selector) as HTMLElement | null;
      if (!target) return;
      // `scrollTo` on this scroller, never `scrollIntoView`: the latter scrolls
      // every ancestor too and can drag the whole app shell sideways to bring a
      // wide code block into view.
      el.scrollTo({ top: Math.max(0, target.offsetTop - el.offsetTop) });
    }, []);

    React.useImperativeHandle(
      handle,
      () => ({
        scrollToTurn: (turnId: string) => scrollToId(`[data-turn-id="${cssEscape(turnId)}"]`),
        scrollToMessage: (messageId: string) =>
          scrollToId(`[data-message-id="${cssEscape(messageId)}"]`),
        pin: () => {
          stick.pin(true);
          setStuck(true);
        },
      }),
      [scrollToId, stick],
    );

    useScrollEffect(() => {
      const el = scroller.current;
      if (!el) return;

      const firstId = messages.length ? messages[0].id : undefined;
      const prepended = firstIdRef.current !== undefined && firstId !== firstIdRef.current;

      if (stick.isStuck()) {
        stick.pin(true);
      } else if (prepended) {
        // The classic defect on this surface: older messages land above the
        // viewport and everything the user was reading jumps down the page.
        // Adding back exactly what the document grew by keeps it still.
        el.scrollTop += el.scrollHeight - heightRef.current;
      }

      firstIdRef.current = firstId;
      heightRef.current = el.scrollHeight;

      // A transcript shorter than its viewport never fires a scroll event, so the
      // top would never be reached and paging would never start. requestMore is
      // idempotent while a page is in flight, so this cannot spin.
      if (el.scrollHeight <= el.clientHeight) requestMore();
    }, [version, messages, requestMore, stick]);

    const jumpToLatest = React.useCallback(() => {
      stick.pin(true);
      setStuck(true);
    }, [stick]);

    // Looked up by id rather than iterated in transcript order: a turn's own
    // messages are already listed on it, and rendering turn-by-turn (below) is
    // what lets a collapsed turn hide its whole body as one unit.
    const messageById = React.useMemo(() => {
      const map = new Map<string, (typeof messages)[number]>();
      for (const message of messages) map.set(message.id, message);
      return map;
    }, [messages]);

    const lastTurnId = turns.length ? turns[turns.length - 1].id : undefined;

    // Which strip has just acknowledged a copy. The prop existed and nothing
    // ever set it, so the glyph never flipped and the click had no feedback.
    const [copiedTurn, setCopiedTurn] = React.useState<string | null>(null);
    const copyTurn = React.useCallback(
      (turnId: string) => {
        onCopyTurn?.(turnId);
        setCopiedTurn(turnId);
        window.setTimeout(() => setCopiedTurn((current) => (current === turnId ? null : current)), 1400);
      },
      [onCopyTurn],
    );

    return (
      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
        <div
          ref={attachScroller}
          onScroll={onScroll}
          role="log"
          aria-label="Conversation"
          // Focusable so the transcript can be scrolled from the keyboard; a
          // scroll container that only responds to a pointer strands anyone
          // without one.
          tabIndex={0}
          style={{
            flex: 1,
            // A normal block scroller. Never `justify-content: flex-end` to fake
            // bottom alignment — that makes the scrollback unreachable.
            minHeight: 160,
            overflowY: 'auto',
            overflowX: 'hidden',
            overscrollBehavior: 'contain',
            WebkitOverflowScrolling: 'touch',
          }}
        >
          <div ref={attachContent} style={{ display: 'flex', flexDirection: 'column' }}>
            {transcript.hasMore && onLoadMore ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  minHeight: 34,
                  fontSize: 'var(--text-xs)',
                  color: 'var(--muted-foreground)',
                }}
              >
                {loadingMore ? (
                  <>
                    <span style={{ animation: 'relay-pulse 1.2s var(--ease-standard) infinite' }}>
                      <Icon name="loader-circle" size={12} />
                    </span>
                    <span aria-live="polite">Loading earlier messages</span>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={requestMore}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      minHeight: 34,
                      padding: '0 10px',
                      background: 'transparent',
                      border: '1px solid var(--border)',
                      color: 'var(--muted-foreground)',
                      font: 'inherit',
                      fontSize: 'var(--text-xs)',
                      cursor: 'pointer',
                      borderRadius: 'var(--radius)',
                    }}
                  >
                    <Icon name="arrow-up" size={11} />
                    Load earlier messages
                  </button>
                )}
              </div>
            ) : null}

            {messages.length === 0 ? <EmptyState /> : null}

            {turns.map((turn) => {
              const open = !openTurnIds || openTurnIds.has(turn.id);
              const bodyId = turnBodyId(turn.id);
              return (
                <React.Fragment key={turn.id}>
                  <TurnStrip
                    turn={turn}
                    anchorId={turn.id}
                    // Sticky for the turn you are in, static above it. The
                    // selected turn wins over "the last one" so that jumping
                    // back through the index leaves a header on screen.
                    variant={turn.id === (currentTurnId || lastTurnId) ? 'current' : 'past'}
                    copied={copiedTurn === turn.id}
                    onCopy={() => copyTurn(turn.id)}
                    onBranch={onForkTurn ? () => onForkTurn(turn.id) : undefined}
                    open={open}
                    onToggleOpen={() => onToggleTurn?.(turn.id)}
                    bodyId={bodyId}
                  />
                  {/* Hidden rather than unmounted: a collapsed turn's bubbles
                      keep their scroll offsets and streaming subscriptions, so
                      re-expanding it is instant and cannot desync from a turn
                      that kept running underneath. */}
                  <div id={bodyId} hidden={!open} style={{ display: open ? 'flex' : 'none', flexDirection: 'column' }}>
                    {turn.messageIds.map((messageId) => {
                      const message = messageById.get(messageId);
                      if (!message) return null;
                      return (
                        <MessageBubble
                          key={message.id}
                          message={message}
                          transcript={transcript}
                          onFork={fork}
                          onRetry={retry}
                          onShowWork={showWork}
                          onEdit={edit}
                          showThinking={showThinking}
                          showToolCalls={showToolCalls}
                        />
                      );
                    })}
                  </div>
                </React.Fragment>
              );
            })}
          </div>
        </div>

        {!stuck && messages.length > 0 ? (
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 12,
              display: 'flex',
              justifyContent: 'center',
              // The overlay must not swallow clicks aimed at the message under it.
              pointerEvents: 'none',
            }}
          >
            <Button
              size="sm"
              variant="secondary"
              onClick={jumpToLatest}
              iconLeft={<Icon name="arrow-down" size={12} />}
              style={{ pointerEvents: 'auto', height: 34, boxShadow: 'var(--shadow-md)' }}
            >
              Jump to latest
            </Button>
          </div>
        ) : null}
      </div>
    );
  },
);

const ZERO = (): number => 0;

/**
 * Escape an id for use inside an attribute selector.
 *
 * Message and turn ids are server-generated UUIDs today, but they are also
 * replayed from disk and carried across versions, and a selector built by
 * concatenation is one odd id away from throwing inside a scroll handler.
 */
function turnBodyId(turnId: string): string {
  return `turn-body-${turnId}`;
}

function cssEscape(value: string): string {
  const escape = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS?.escape;
  return escape ? escape(value) : value.replace(/["\\]/g, '\\$&');
}

function EmptyState() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        padding: '48px 24px',
        textAlign: 'center',
        color: 'var(--muted-foreground)',
      }}
    >
      <Icon name="message-square" size={22} />
      <p style={{ margin: 0, fontSize: 'var(--text-body)', color: 'var(--foreground)' }}>
        Nothing here yet
      </p>
      <p style={{ margin: 0, fontSize: 'var(--text-sm)', maxWidth: 320 }}>
        Ask a question or describe a task to start the conversation.
      </p>
    </div>
  );
}
