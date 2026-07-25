import * as React from 'react';
import { detectServerLinks, type DetectedLink } from '../../../shared/detect-links.js';
import type { ChatMessage } from '../../../shared/chat-events.js';
import type { ChatTranscript } from '../../chat/transcript.js';
import { Icon } from '../../ui/relay/Icon.js';
import { PanelBody, PanelHeader, PanelNote } from './PanelShell.js';

/**
 * Apps the agent started, as links you can actually open.
 *
 * A dev server prints its address and, in this app, that address is useless
 * text: it names `localhost` on the machine running the agent, and the browser
 * reading it is very often a phone somewhere else on the network. So the
 * addresses are collected out of what the agent printed and re-pointed at the
 * host this page was served from — which is the same machine — and offered as
 * ordinary links.
 *
 * Newest first: when a server is restarted on a different port, the one that is
 * actually listening is the one that was mentioned last.
 */

export interface LinksPanelProps {
  transcript: ChatTranscript;
  /** Where the page is loaded from; loopback addresses are rewritten to it. */
  pageHost?: string;
}

/**
 * How far back to scan. Every tool output in a long conversation is a lot of
 * text to re-scan on each render, and a server announced two hundred messages
 * ago is not the one the user is trying to open.
 */
const SCAN_MESSAGES = 60;

export function LinksPanel({ transcript, pageHost }: LinksPanelProps): React.JSX.Element {
  const version = React.useSyncExternalStore(transcript.subscribe, transcript.getVersion, ZERO);

  const host =
    pageHost ?? (typeof window === 'undefined' ? '' : window.location.hostname);

  const links = React.useMemo(
    () => collectLinks(transcript.messages, host),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [transcript, version, host],
  );

  return (
    <>
      <PanelHeader title="Links" detail={links.length ? `${links.length} found` : undefined} />
      <PanelBody>
        {links.length === 0 ? (
          <PanelNote icon="wifi">
            No local servers mentioned yet. When the agent starts one, its address appears here as
            a link you can open.
          </PanelNote>
        ) : null}
        {links.map((link) => (
          <LinkRow key={link.url} link={link} />
        ))}
      </PanelBody>
    </>
  );
}

const ZERO = (): number => 0;

/**
 * Scan the tail of the conversation for server addresses.
 *
 * Tool output first — that is where `npm run dev` prints — but assistant prose
 * counts too, because an agent very often repeats the URL in its summary and
 * sometimes that is the only place it appears.
 */
function collectLinks(messages: ChatMessage[], pageHost: string): DetectedLink[] {
  const recent = messages.slice(-SCAN_MESSAGES);
  const found = new Map<string, DetectedLink>();

  for (const message of recent) {
    if (message.role === 'user') continue;
    for (const block of message.blocks) {
      const text =
        block.kind === 'tool'
          ? block.output || ''
          : block.kind === 'text'
            ? block.text
            : '';
      if (!text) continue;
      for (const link of detectServerLinks(text, pageHost)) {
        // Re-setting moves it to the end of insertion order, which is what
        // makes the most recently mentioned address sort first below.
        found.delete(link.url);
        found.set(link.url, link);
      }
    }
  }

  return Array.from(found.values()).reverse();
}

function LinkRow({ link }: { link: DetectedLink }): React.JSX.Element {
  const [hover, setHover] = React.useState(false);
  const rewritten = link.url !== link.original;

  return (
    <a
      href={link.url}
      target="_blank"
      rel="noreferrer noopener"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 10px',
        background: hover ? 'var(--accent)' : 'transparent',
        color: 'var(--foreground)',
        textDecoration: 'none',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <span style={{ flex: '0 0 auto', color: 'var(--info)' }}>
        <Icon name="wifi" size={13} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: 'block',
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-xs)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {link.url}
        </span>
        {rewritten ? (
          // Said out loud: the address the agent printed and the address that
          // works from this browser are different, and silently swapping one
          // for the other would look like the panel had invented a URL.
          <span
            style={{
              display: 'block',
              marginTop: 2,
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-2xs)',
              color: 'var(--muted-foreground)',
            }}
          >
            printed as {link.original}
          </span>
        ) : null}
      </span>
      <span style={{ flex: '0 0 auto', color: 'var(--muted-foreground)' }}>
        <Icon name="arrow-right" size={12} />
      </span>
    </a>
  );
}
