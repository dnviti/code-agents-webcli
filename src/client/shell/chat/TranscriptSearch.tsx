import * as React from 'react';
import type { ChatMessage } from '../../../shared/chat-events.js';
import { messageText } from '../../../shared/chat-reducer.js';
import { Icon } from '../../ui/relay/Icon.js';
import { PHONE_TEXT, usePhone } from '../../ui/touch.js';

/**
 * Find something in this conversation.
 *
 * Local to the transcript the browser already holds, not a server query. The
 * distinction matters: this is the ⌘F you press because you remember reading
 * something two turns ago, and it has to answer instantly and land you on the
 * message. Paging further back is what the "Load earlier messages" control at
 * the top of the scroller is for, and a search that silently only covered the
 * loaded window while looking like it covered everything would be worse than
 * one that says which it is.
 *
 * `ChatSearch` is the other thing — a ranked, server-backed search across every
 * session — and is deliberately left alone.
 */

export interface TranscriptSearchProps {
  messages: ChatMessage[];
  /** True when older pages of this conversation are still on the server. */
  hasMore?: boolean;
  onJump(messageId: string): void;
  onClose(): void;
}

export function TranscriptSearch({
  messages,
  hasMore = false,
  onJump,
  onClose,
}: TranscriptSearchProps): React.JSX.Element {
  const isPhone = usePhone();
  const [query, setQuery] = React.useState('');
  const [at, setAt] = React.useState(0);
  const input = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const hits = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [] as string[];
    return messages
      .filter((message) => messageText(message).toLowerCase().includes(needle))
      .map((message) => message.id);
  }, [messages, query]);

  // A new query starts at the newest match rather than the oldest: what you are
  // usually looking for is the most recent time it was said. And it *goes*
  // there — the counter reads "3/3" from the first keystroke, so an Enter that
  // moved to 2/3 without ever showing 3/3 would skip the match it named.
  React.useEffect(() => {
    const next = hits.length ? hits.length - 1 : 0;
    setAt(next);
    if (hits.length) onJump(hits[next]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hits.length, query]);

  const go = React.useCallback(
    (delta: number) => {
      if (!hits.length) return;
      const next = (at + delta + hits.length) % hits.length;
      setAt(next);
      onJump(hits[next]);
    },
    [at, hits, onJump],
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (!hits.length) return;
      // Enter always moves: the match the counter names is already on screen,
      // put there when the query changed.
      go(event.shiftKey ? 1 : -1);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  const count = query.trim()
    ? hits.length
      ? `${at + 1}/${hits.length}`
      : 'no matches'
    : '';

  return (
    <div
      role="search"
      style={{
        position: 'absolute',
        top: 8,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 'var(--z-dropdown)' as unknown as number,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        maxWidth: 'calc(100% - 24px)',
        height: 32,
        padding: '0 8px',
        background: 'var(--popover)',
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--radius)',
        boxShadow: 'var(--shadow-popover)',
      }}
    >
      <Icon name="search" size={12} style={{ color: 'var(--muted-foreground)', flex: '0 0 auto' }} />
      <input
        ref={input}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Search this transcript"
        aria-label="Search this transcript"
        style={{
          width: 240,
          minWidth: 0,
          border: 'none',
          outline: 'none',
          background: 'transparent',
          color: 'var(--foreground)',
          fontFamily: 'var(--font-sans)',
          // A field the user types into, so it clears the iOS no-zoom floor:
          // below 16px Safari magnifies the page on focus and never undoes it
          // (#92).
          fontSize: isPhone ? PHONE_TEXT.input : 'var(--text-sm)',
        }}
      />
      <span
        aria-live="polite"
        style={{
          flex: '0 0 auto',
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--text-2xs)',
          color: 'var(--muted-foreground)',
          whiteSpace: 'nowrap',
        }}
      >
        {count}
      </span>
      {hasMore && query.trim() ? (
        <span
          title="Older messages are still on the server. Load them to search further back."
          style={{ flex: '0 0 auto', display: 'inline-flex', color: 'var(--warning)' }}
        >
          <Icon name="circle-alert" size={11} />
        </span>
      ) : null}
      <SearchButton label="Previous match" icon="arrow-up" onClick={() => go(-1)} />
      <SearchButton label="Next match" icon="arrow-down" onClick={() => go(1)} />
      <SearchButton label="Close search" icon="x" onClick={onClose} />
    </div>
  );
}

function SearchButton({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: string;
  onClick: () => void;
}): React.JSX.Element {
  const isPhone = usePhone();
  const [hover, setHover] = React.useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: '0 0 auto',
        width: 22,
        height: 22,
        background: hover ? 'var(--accent)' : 'transparent',
        border: 0,
        borderRadius: 'var(--radius)',
        color: hover ? 'var(--foreground)' : 'var(--muted-foreground)',
        cursor: 'pointer',
      }}
    >
      <Icon name={icon} size={11} />
    </button>
  );
}
