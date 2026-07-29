import * as React from 'react';

import { ChatRole } from '../../../shared/chat-events.js';
import { Icon } from '../../ui/relay/Icon.js';
import { PHONE_TEXT, usePhone } from '../../ui/touch.js';
import { IconButton } from '../../ui/relay/IconButton.js';
import { Badge } from '../../ui/relay/Badge.js';

/** One matched message, as the server's full-text search reports it. */
export interface ChatSearchHit {
  sessionId: string;
  sessionName: string;
  runtime: string;
  /** The message's seq within its session, so onOpen can jump straight to it. */
  seq: number;
  role: ChatRole;
  /** A short excerpt around the match, plain text (already stripped of markdown). */
  snippet: string;
  ts: number;
}

export interface ChatSearchProps {
  /** The actual search; this component only debounces the call and renders what comes back. */
  onSearch: (query: string) => Promise<ChatSearchHit[]>;
  onOpen: (hit: ChatSearchHit) => void;
  autoFocus?: boolean;
}

type Phase = 'idle' | 'searching' | 'results' | 'empty' | 'error';

const DEBOUNCE_MS = 200;

const roleIcon: Record<ChatRole, string> = { user: 'user', assistant: 'bot', system: 'terminal' };

/**
 * Wraps every case-insensitive occurrence of `query` in the snippet with
 * `<mark>`. A snippet the server trimmed around a stemmed or fuzzy match may
 * not literally contain `query` at all — that is fine, the loop just falls
 * through to returning the snippet untouched rather than marking nothing.
 */
function highlightSnippet(snippet: string, query: string): React.ReactNode[] {
  if (!query) return [snippet];
  const haystack = snippet.toLowerCase();
  const needle = query.toLowerCase();
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, cursor);
    if (idx === -1) {
      nodes.push(snippet.slice(cursor));
      break;
    }
    if (idx > cursor) nodes.push(snippet.slice(cursor, idx));
    nodes.push(
      <mark
        key={key++}
        style={{
          background: 'color-mix(in oklab, var(--warning) 35%, transparent)',
          color: 'inherit',
          padding: '0 1px',
        }}
      >
        {snippet.slice(idx, idx + query.length)}
      </mark>,
    );
    cursor = idx + query.length;
  }
  return nodes;
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

interface ResultRowProps {
  id: string;
  hit: ChatSearchHit;
  query: string;
  active: boolean;
  onHover: () => void;
  onOpen: () => void;
}

function ResultRow({ id, hit, query, active, onHover, onOpen }: ResultRowProps): React.JSX.Element {
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      onMouseEnter={onHover}
      onClick={onOpen}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        padding: '6px 12px',
        minHeight: 40,
        cursor: 'pointer',
        background: active ? 'var(--accent)' : 'transparent',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Icon name={roleIcon[hit.role] || 'terminal'} size={11} style={{ color: 'var(--muted-foreground)' }} />
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--muted-foreground)' }}>
          {formatTimestamp(hit.ts)}
        </span>
      </div>
      <div
        style={{
          fontFamily: 'var(--font-sans)',
          fontSize: 'var(--text-sm)',
          lineHeight: 'var(--leading-normal)',
          color: 'var(--foreground)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
        }}
      >
        {highlightSnippet(hit.snippet, query)}
      </div>
    </div>
  );
}

const hintStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '22px 14px',
  color: 'var(--muted-foreground)',
  fontFamily: 'var(--font-sans)',
  fontSize: 'var(--text-sm)',
  textAlign: 'center',
  justifyContent: 'center',
};

interface ResultsProps {
  phase: Phase;
  query: string;
  hits: ChatSearchHit[];
  activeIndex: number;
  errorMessage?: string;
  listId: string;
  onHoverIndex: (i: number) => void;
  onOpenHit: (hit: ChatSearchHit) => void;
}

/**
 * The result list, split out of ChatSearch so the five states it can be in —
 * idle, searching, results, empty, error — are each reachable directly by a
 * prop rather than only through a live debounce timer and a resolved promise,
 * which is what actually keeps this renderable in a single static pass.
 */
export function ChatSearchResults({
  phase, query, hits, activeIndex, errorMessage, listId, onHoverIndex, onOpenHit,
}: ResultsProps): React.JSX.Element {
  if (phase === 'idle') {
    return (
      <div id={listId} style={hintStyle}>
        <Icon name="search" size={14} />
        Search across every session&apos;s messages.
      </div>
    );
  }

  if (phase === 'searching') {
    return (
      <div id={listId} style={hintStyle} aria-live="polite">
        <Icon name="loader-circle" size={13} style={{ animation: 'relay-spin 900ms linear infinite' }} />
        Searching…
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div id={listId} role="alert" style={{ ...hintStyle, color: 'var(--destructive)' }}>
        <Icon name="circle-alert" size={13} />
        {errorMessage || 'Search failed. Try again.'}
      </div>
    );
  }

  if (phase === 'empty') {
    return (
      <div id={listId} style={hintStyle} aria-live="polite">
        No messages match &quot;{query}&quot;.
      </div>
    );
  }

  // phase === 'results' — grouped by session, first-seen order (the server
  // already ranked hits, and re-sorting sessions here would fight that ranking).
  const groups: Array<{ sessionId: string; sessionName: string; runtime: string; rows: Array<{ hit: ChatSearchHit; index: number }> }> = [];
  const indexOfSession = new Map<string, number>();
  hits.forEach((hit, index) => {
    let gi = indexOfSession.get(hit.sessionId);
    if (gi === undefined) {
      gi = groups.length;
      indexOfSession.set(hit.sessionId, gi);
      groups.push({ sessionId: hit.sessionId, sessionName: hit.sessionName, runtime: hit.runtime, rows: [] });
    }
    groups[gi].rows.push({ hit, index });
  });

  return (
    <div id={listId} role="listbox" aria-label="Search results" aria-live="polite" style={{ overflowY: 'auto' }}>
      {groups.map((g) => (
        <div key={g.sessionId}>
          <div
            style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px 3px',
              fontFamily: 'var(--font-sans)', fontSize: 'var(--text-2xs)', color: 'var(--muted-foreground)',
            }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.sessionName}</span>
            <Badge variant="outline" style={{ height: 15, padding: '0 5px', fontSize: 'var(--text-2xs)', flex: '0 0 auto' }}>
              {g.runtime}
            </Badge>
          </div>
          {g.rows.map(({ hit, index }) => (
            <ResultRow
              key={`${hit.sessionId}-${hit.seq}`}
              id={`${listId}-opt-${index}`}
              hit={hit}
              query={query}
              active={index === activeIndex}
              onHover={() => onHoverIndex(index)}
              onOpen={() => onOpenHit(hit)}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function ChatSearch({ onSearch, onOpen, autoFocus }: ChatSearchProps): React.JSX.Element {
  const isPhone = usePhone();
  const [query, setQuery] = React.useState('');
  const [phase, setPhase] = React.useState<Phase>('idle');
  const [hits, setHits] = React.useState<ChatSearchHit[]>([]);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [errorMessage, setErrorMessage] = React.useState<string | undefined>(undefined);
  // Bumped on every query change and checked when a search resolves, so a slow
  // response to a stale keystroke can never overwrite the result of a later one.
  const requestRef = React.useRef(0);
  const listId = React.useId();

  React.useEffect(() => {
    const trimmed = query.trim();
    requestRef.current += 1;
    if (!trimmed) {
      setPhase('idle');
      setHits([]);
      setErrorMessage(undefined);
      return;
    }
    setPhase('searching');
    const id = requestRef.current;
    const timer = window.setTimeout(() => {
      onSearch(trimmed)
        .then((results) => {
          if (requestRef.current !== id) return;
          setHits(results);
          setActiveIndex(0);
          setPhase(results.length ? 'results' : 'empty');
        })
        .catch((err: unknown) => {
          if (requestRef.current !== id) return;
          setErrorMessage(err instanceof Error ? err.message : 'Search failed');
          setPhase('error');
        });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, onSearch]);

  const openHit = React.useCallback((hit: ChatSearchHit) => onOpen(hit), [onOpen]);

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (phase !== 'results' || hits.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((i) => (i + 1) % hits.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((i) => (i - 1 + hits.length) % hits.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const hit = hits[activeIndex];
      if (hit) openHit(hit);
    }
  };

  const activeHit = phase === 'results' ? hits[activeIndex] : undefined;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--popover)' }}>
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px',
          height: 44, borderBottom: '1px solid var(--border)', flex: '0 0 auto',
        }}
      >
        <Icon name="search" size={14} style={{ color: 'var(--muted-foreground)', flex: '0 0 auto' }} />
        <input
          type="text"
          autoFocus={autoFocus}
          value={query}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => setQuery(event.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder="Search all sessions…"
          aria-label="Search all sessions"
          role="combobox"
          aria-expanded={phase === 'results'}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeHit ? `${listId}-opt-${activeIndex}` : undefined}
          style={{
            flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent',
            color: 'var(--foreground)', fontFamily: 'var(--font-sans)',
            // A field the user types into: below 16px iOS Safari magnifies the
            // page on focus and never undoes it (#92).
            fontSize: isPhone ? PHONE_TEXT.input : 'var(--text-ui)',
          }}
        />
        {query ? (
          <IconButton size="lg" label="Clear search" onClick={() => setQuery('')}>
            <Icon name="x" size={13} />
          </IconButton>
        ) : null}
      </div>
      <ChatSearchResults
        phase={phase}
        query={query.trim()}
        hits={hits}
        activeIndex={activeIndex}
        errorMessage={errorMessage}
        listId={listId}
        onHoverIndex={setActiveIndex}
        onOpenHit={openHit}
      />
    </div>
  );
}
