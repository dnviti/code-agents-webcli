import * as React from 'react';
import { ChatTranscript } from '../../chat/transcript.js';
import { Button } from '../../ui/relay/Button.js';
import { Icon } from '../../ui/relay/Icon.js';
import { MessageBubble } from './MessageBubble.js';

/**
 * The scrolling transcript.
 *
 * Two subscriptions, deliberately split. This component watches the transcript
 * version, which tells it only that the set of messages may have moved; each
 * bubble watches its own message. A streaming turn fires thousands of events
 * against one message, and if the list re-rendered every bubble for each of
 * them the surface would stall at a few hundred messages. See MessageBubble.
 *
 * Scroll behaviour mirrors the terminal side (src/client/terminal/controller.ts):
 * "am I at the bottom" is sampled from the live geometry, and new output only
 * follows the viewport down when that was already true. The user scrolling up
 * is an instruction, and it outranks anything the agent is emitting.
 */

export interface MessageListProps {
  transcript: ChatTranscript;
  onLoadMore?: () => void;
  onFork?: (messageId: string) => void;
  onRetry?: () => void;
}

/** How close to an edge still counts as being at it, in px. */
const BOTTOM_SLACK = 24;
const TOP_SLACK = 48;

// Scroll correction has to land before the browser paints or the transcript
// visibly jumps, so this is a layout effect on the client. Static rendering has
// no layout at all, and React warns about the hook there rather than skipping
// it quietly, so the check is made once here instead of at every call site.
const useScrollEffect =
  typeof window === 'undefined' ? React.useEffect : React.useLayoutEffect;

export function MessageList({ transcript, onLoadMore, onFork, onRetry }: MessageListProps) {
  const version = React.useSyncExternalStore(transcript.subscribe, transcript.getVersion, ZERO);
  const messages = React.useMemo(
    () => transcript.messages,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [transcript, version],
  );

  const scroller = React.useRef<HTMLDivElement | null>(null);
  const [stuck, setStuck] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);

  // Read inside layout effects and scroll handlers, where a state value would
  // be a render behind the geometry it is describing.
  const stuckRef = React.useRef(true);
  const firstIdRef = React.useRef<string | undefined>(undefined);
  const heightRef = React.useRef(0);

  // Kept in refs so a caller passing fresh closures every render does not
  // defeat React.memo on every bubble in the list.
  const forkRef = React.useRef(onFork);
  const retryRef = React.useRef(onRetry);
  const loadRef = React.useRef(onLoadMore);
  React.useEffect(() => {
    forkRef.current = onFork;
    retryRef.current = onRetry;
    loadRef.current = onLoadMore;
  }, [onFork, onRetry, onLoadMore]);

  const fork = React.useMemo(
    () => (onFork ? (messageId: string) => forkRef.current?.(messageId) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [Boolean(onFork)],
  );
  const retry = React.useMemo(
    () => (onRetry ? () => retryRef.current?.() : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [Boolean(onRetry)],
  );

  // A ref rather than the state value: this fires from a scroll handler and
  // from a layout effect, and a state read there is a render behind.
  const loadingRef = React.useRef(false);
  const requestMore = React.useCallback(() => {
    if (loadingRef.current || !loadRef.current || !transcript.hasMore) return;
    loadingRef.current = true;
    setLoadingMore(true);
    loadRef.current();
  }, [transcript]);

  const setStick = React.useCallback((next: boolean) => {
    if (stuckRef.current === next) return;
    stuckRef.current = next;
    setStuck(next);
  }, []);

  const onScroll = React.useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setStick(el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK);
    if (el.scrollTop <= TOP_SLACK) requestMore();
  }, [requestMore, setStick]);

  const jumpToLatest = React.useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setStick(true);
    el.scrollTop = el.scrollHeight;
  }, [setStick]);

  useScrollEffect(() => {
    const el = scroller.current;
    if (!el) return;

    const firstId = messages.length ? messages[0].id : undefined;
    const prepended = firstIdRef.current !== undefined && firstId !== firstIdRef.current;

    if (stuckRef.current) {
      el.scrollTop = el.scrollHeight;
    } else if (prepended) {
      // The classic defect on this surface: older messages land above the
      // viewport and everything the user was reading jumps down the page.
      // Adding back exactly what the document grew by keeps it still.
      el.scrollTop += el.scrollHeight - heightRef.current;
    }

    if (prepended) {
      loadingRef.current = false;
      setLoadingMore(false);
    }

    firstIdRef.current = firstId;
    heightRef.current = el.scrollHeight;

    // A transcript shorter than its viewport never fires a scroll event, so the
    // top would never be reached and paging would never start. requestMore is
    // idempotent while a page is in flight, so this cannot spin.
    if (el.scrollHeight <= el.clientHeight) requestMore();
  }, [version, messages, requestMore]);

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <div
        ref={scroller}
        onScroll={onScroll}
        role="log"
        aria-label="Conversation"
        // Focusable so the transcript can be scrolled from the keyboard; a
        // scroll container that only responds to a pointer strands anyone
        // without one.
        tabIndex={0}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          overflowX: 'hidden',
          overscrollBehavior: 'contain',
          WebkitOverflowScrolling: 'touch',
          padding: '8px 0 16px',
        }}
      >
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

        {messages.length === 0 ? (
          <EmptyState />
        ) : (
          messages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              transcript={transcript}
              onFork={fork}
              onRetry={retry}
            />
          ))
        )}
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
}

const ZERO = (): number => 0;

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
