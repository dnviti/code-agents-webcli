import * as React from 'react';
import type { ChatMessage } from '../../../shared/chat-events.js';
import { ChatTranscript } from '../../chat/transcript.js';
import { createStick, BOTTOM_SLACK, type StickHandle } from '../../chat/stick.js';
import { messageWeight, retain } from '../../chat/retain.js';
import type { TurnSummary } from '../../chat/turns.js';
import { Button } from '../../ui/relay/Button.js';
import { Icon } from '../../ui/relay/Icon.js';
import { usePhone } from '../../ui/touch.js';
import { MessageBubble, hasVisibleContent, isRule } from './MessageBubble.js';
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
 *
 * A folded turn's bubbles are not built at all until it is opened, and what has
 * been built is kept to a bounded amount of content — see `retain`. This used to
 * render every turn and hide the folded ones, which meant entering a long
 * conversation prepared its whole backlog for nobody to look at.
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
  /** Answer a question the model asked, from its card in the conversation. */
  onAnswerQuestion?: (requestId: string, optionIds: string[], skipped: boolean) => void;
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
      onAnswerQuestion,
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
    const isPhone = usePhone();

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

    const scrollToId = React.useCallback((selector: string, retry = true) => {
      const el = scroller.current;
      if (!el) return;
      const target = el.querySelector(selector) as HTMLElement | null;
      if (!target) {
        // The turn being jumped to may only just have been opened, and its
        // bubbles are built by that render rather than sitting hidden in the
        // document already. One frame later they are there. Once only, so a
        // jump to something that genuinely is not in the transcript settles
        // instead of retrying forever.
        if (retry && typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => scrollToId(selector, false));
        }
        return;
      }
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
    //
    // Keyed on `version`, not on `messages`: the transcript appends to its
    // array in place, so its identity never changes and a `[messages]` map
    // would be built once at mount and then never see another message. Every
    // later id would miss and render nothing — a turn whose body stays empty
    // while its strip keeps counting.
    const messageById = React.useMemo(() => {
      const map = new Map<string, (typeof messages)[number]>();
      for (const message of messages) map.set(message.id, message);
      return map;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [messages, version]);

    const lastTurnId = turns.length ? turns[turns.length - 1].id : undefined;

    // ------------------------------------------------- which turns are built
    //
    // An absent `openTurnIds` means nobody is managing fold state, so every
    // turn reads as open — and every turn is therefore prepared, exactly as it
    // was before any of this existed.
    const openSet = React.useMemo(
      () => openTurnIds ?? new Set(turns.map((turn) => turn.id)),
      [openTurnIds, turns],
    );

    // Weighed once per turn and remembered. Only a turn that is neither open
    // nor live is ever weighed (see `retain`), and such a turn is finished, so
    // its content cannot change underneath the cache. The message count is in
    // the key anyway, because paging older history in can extend the first
    // group.
    const weights = React.useRef(new Map<string, number>());
    // Indexed rather than searched: this runs on every render, and a `find`
    // per candidate turn is quadratic in a conversation long enough for any of
    // this to matter.
    const turnById = React.useMemo(() => {
      const map = new Map<string, TurnSummary>();
      for (const turn of turns) map.set(turn.id, turn);
      return map;
    }, [turns]);
    const turnIds = React.useMemo(() => turns.map((turn) => turn.id), [turns]);
    const weightOf = React.useCallback(
      (turnId: string) => {
        const turn = turnById.get(turnId);
        if (!turn) return 0;
        const key = `${turnId}:${turn.messageIds.length}`;
        const cached = weights.current.get(key);
        if (cached !== undefined) return cached;
        let weight = 0;
        for (const id of turn.messageIds) {
          const message = messageById.get(id);
          if (message) weight += messageWeight(message);
        }
        weights.current.set(key, weight);
        return weight;
      },
      [turnById, messageById],
    );

    // Held in a ref and recomputed during render rather than in an effect: an
    // effect would paint one frame with the old answer, which on the frame that
    // opens a turn is a visible empty body. `retain` is idempotent and returns
    // its previous answer unchanged when nothing moved, so running it twice —
    // as StrictMode does — cannot drift.
    const retainedRef = React.useRef<string[]>([]);
    retainedRef.current = retain(retainedRef.current, {
      order: turnIds,
      open: openSet,
      liveId: lastTurnId,
      weightOf,
    });
    const retainedIds = retainedRef.current;
    const retained = React.useMemo(() => new Set(retainedIds), [retainedIds]);

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
            //
            // `0`, not a 160px floor. A flex item cannot shrink below its
            // min-height, so a floor taller than the space available does not
            // reserve room — it overflows the column, and the transcript gets
            // painted over the live ribbon and the composer beneath it. A phone
            // in landscape has about 160px for the whole conversation once the
            // header, the ribbon and the composer have taken theirs, so this
            // was the shape it broke in first. Flex already gives the scroller
            // every pixel the column can spare, which is what the floor was for.
            minHeight: 0,
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
                  {/* A folded turn that has been opened before is hidden rather
                      than unmounted, so re-opening it is instant. One that has
                      not is empty until it is opened — that is the whole point
                      of this, and nothing is lost by it: a bubble reads its
                      message off the transcript and subscribes to it on mount,
                      so a turn that kept running while folded shows its current
                      state when it is finally built, not a snapshot from when
                      it was folded. */}
                  <div id={bodyId} hidden={!open} style={{ display: open ? 'flex' : 'none', flexDirection: 'column' }}>
                    {!retained.has(turn.id) ? null : rowsOf(turn.messageIds, messageById).map(({ message, carriedIds }) => (
                      <MessageBubble
                        key={message.id}
                        message={message}
                        transcript={transcript}
                        onFork={fork}
                        onRetry={retry}
                        onShowWork={showWork}
                        onEdit={edit}
                        carriedIds={carriedIds}
                        showThinking={showThinking}
                        showToolCalls={showToolCalls}
                        onAnswerQuestion={onAnswerQuestion}
                      />
                    ))}
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
              // The key is omitted on a phone, not set to `undefined`: the
              // style object is spread over the primitive's own, so a present
              // key wins whatever its value is — `height: undefined` deleted
              // the touch floor as thoroughly as `height: 34` overrode it, and
              // left the pill 17px tall. 34 is a desktop choice: `sm` is 26px
              // and this floats over the transcript, where it has to be found.
              style={{
                pointerEvents: 'auto',
                ...(isPhone ? null : { height: 34 }),
                boxShadow: 'var(--shadow-md)',
              }}
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

interface Row {
  message: ChatMessage;
  /** The silent steps this row speaks for, oldest first, comma-joined. */
  carriedIds: string;
}

/**
 * The rows a turn actually draws, and which silent steps each one carries.
 *
 * A step that produced only tool calls and reasoning has no row (see
 * MessageBubble). Its id is held here until a message that does speak comes
 * along, and handed to that message so its work counter counts the whole
 * stretch and opens the trace at the start of it.
 *
 * Silent steps still pending at the end of a turn are simply dropped: there is
 * no reply to hang them on, and inventing a row for them is the thing this
 * removes. Nothing is lost — the turn strip still counts them and the rail
 * still holds every event.
 */
function rowsOf(messageIds: string[], byId: Map<string, ChatMessage>): Row[] {
  const rows: Row[] = [];
  let silent: string[] = [];
  for (const messageId of messageIds) {
    const message = byId.get(messageId);
    if (!message) continue;
    if (!hasVisibleContent(message)) {
      silent.push(message.id);
      continue;
    }
    // A rule across the conversation cannot speak for the work before it: it
    // has no action row to put the counter in, so anything handed to it is
    // dropped rather than carried. The steps go on waiting for the next message
    // that can. Without this a workflow failing mid-turn took the trace entry
    // point for its own tool call off the transcript (#140).
    if (isRule(message)) {
      rows.push({ message, carriedIds: '' });
      continue;
    }
    rows.push({ message, carriedIds: silent.join(',') });
    silent = [];
  }
  return rows;
}

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
