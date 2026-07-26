import * as React from 'react';
import {
  ChatBlock,
  ChatMessage,
  ChatUsage,
  ErrorBlock,
  ImageBlock,
  NoticeBlock,
} from '../../../shared/chat-events.js';
import { ChatTranscript } from '../../chat/transcript.js';
import { compactCount, formatDuration } from '../../chat/tool-meta.js';
import { Icon } from '../../ui/relay/Icon.js';
import { PHONE_TEXT, TOUCH_GAP, TOUCH_TARGET, usePhone } from '../../ui/touch.js';
import { Markdown, markdownText } from './Markdown.js';
import { PlanPanel } from './PlanPanel.js';

/**
 * One message in the transcript — prose, and nothing else.
 *
 * The bubble subscribes to its own message rather than reading whatever the
 * list handed it. A streaming turn fires an event per token against a single
 * message, and the list re-rendering every bubble for each of those tokens is
 * the difference between a chat that keeps up and one that does not. The list
 * owns "which messages exist"; a bubble owns "what is inside mine".
 *
 * The reducer mutates messages in place, so the `message` prop is a stable
 * object across a whole streaming turn — which is what makes React.memo here
 * actually bite instead of re-rendering on identity churn.
 *
 * Reasoning blocks and tool calls are deliberately not rendered here. They are
 * projected onto the trace rail's timeline instead (chat/activity.ts), where
 * they can be read as a sequence of work rather than as interruptions in the
 * middle of a sentence. What is left behind is a work pill: how much happened,
 * and one click to go and look at it. Moved, never hidden.
 */

export interface MessageBubbleProps {
  message: ChatMessage;
  transcript: ChatTranscript;
  onFork?: (messageId: string) => void;
  /**
   * Resend the turn this message belongs to.
   *
   * Takes the message id. It used to take nothing, which meant the handler had
   * to guess which turn was meant — and it guessed "whichever one is selected",
   * so retrying an error you had scrolled back to resent the newest turn.
   */
  onRetry?: (messageId: string) => void;
  /** Open the rail and scroll its timeline to this message's first event. */
  onShowWork?: (messageId: string) => void;
  /** Put this turn's text back in the composer, unsent. */
  onEdit?: (text: string) => void;
  /** Count reasoning blocks in the work pill, per the chat display settings. */
  showThinking?: boolean;
  /** Count tool calls in the work pill. */
  showToolCalls?: boolean;
}

export const MessageBubble = React.memo(function MessageBubble({
  message,
  transcript,
  onFork,
  onRetry,
  onShowWork,
  onEdit,
  showThinking = true,
  showToolCalls = true,
}: MessageBubbleProps) {
  const id = message.id;

  const subscribe = React.useCallback(
    (listener: () => void) => transcript.subscribeMessage(id, listener),
    [transcript, id],
  );
  const getVersion = React.useCallback(() => transcript.getMessageVersion(id), [transcript, id]);
  // Static rendering has no subscription to read from, so the server snapshot
  // is a constant; the third argument is required or React throws there.
  const version = React.useSyncExternalStore(subscribe, getVersion, ZERO);

  // The version is the honest dependency: the message object never changes
  // identity, only its contents, so nothing else can signal a re-read.
  const current = React.useMemo(
    () => transcript.message(id) || message,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [transcript, id, message, version],
  );

  const [copied, setCopied] = React.useState(false);
  const isPhone = usePhone();
  const isUser = current.role === 'user';
  // A marker is not a turn: no surface, no glyph, no controls, and the full
  // width of the column — it is a line drawn across the conversation.
  const isMarker =
    current.role === 'system'
    && current.blocks.length > 0
    && current.blocks.every((block) => block.kind === 'notice');

  // Derived from this message's own blocks, not from a list handed down. An
  // events array as a prop would be a new object identity every render and
  // would defeat React.memo for the whole transcript on every streamed token.
  const work = React.useMemo(
    () => summariseWork(current, showThinking, showToolCalls),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [current, version, showThinking, showToolCalls],
  );

  const copy = React.useCallback(() => {
    // Same contract as CodeBlock: the label only flips once the write actually
    // resolved, because clipboard access can be refused or unavailable.
    const write = navigator.clipboard?.writeText(messageText(current));
    if (!write) return;
    write
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      })
      .catch(() => {
        /* Left to the user to select manually. */
      });
  }, [current]);

  // Nothing left to draw: an assistant turn that was only machinery, with both
  // display toggles off. An empty bordered row is worse than no row — it reads
  // as a message that failed to render rather than as one the settings hid.
  if (!isUser && !isMarker && !current.streaming && visibleBlocks(current) === 0 && work.total === 0) {
    return null;
  }

  if (isMarker) {
    return (
      <div data-message-id={id} style={{ padding: '10px 14px' }}>
        {current.blocks.map((block, i) => (
          <NoticeRule key={i} block={block as NoticeBlock} />
        ))}
      </div>
    );
  }

  return (
    <article
      data-message-id={id}
      aria-label={isUser ? 'Your message' : 'Assistant message'}
      style={{
        display: 'flex',
        // On a phone the controls drop to a line of their own below the
        // message — see the action column. Beside it they were a 44px-wide
        // column of stacked buttons that made a two-line message four lines
        // tall and took a sixth of the width off the text.
        flexWrap: isPhone ? 'wrap' : 'nowrap',
        gap: 10,
        minWidth: 0,
        padding: isUser ? '10px 14px' : '12px 14px',
        // The user's turn is the only thing in the transcript with a surface
        // under it. That is what makes an hour of conversation skimmable: the
        // asks are the landmarks, and everything between two of them is one
        // answer.
        background: isUser ? 'var(--muted)' : 'transparent',
        borderBottom: '1px solid var(--border)',
        fontFamily: 'var(--font-sans)',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          flex: '0 0 auto',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 18,
          height: 18,
          border: `1px solid ${isUser ? 'var(--border-strong)' : 'var(--border)'}`,
          borderRadius: 'var(--radius)',
          color: isUser ? 'var(--foreground)' : 'var(--muted-foreground)',
        }}
      >
        <Icon name={isUser ? 'user' : 'bot'} size={10} />
      </span>

      <div
        className="chat-prose"
        style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: isUser ? 7 : 10 }}
      >
        {current.blocks.map((block, i) => (
          <BlockView
            key={i}
            block={block}
            plain={isUser}
            onRetry={onRetry ? () => onRetry(id) : undefined}
            caret={Boolean(current.streaming) && i === current.blocks.length - 1}
          />
        ))}
        {current.streaming && visibleBlocks(current) === 0 ? <Caret /> : null}

        {!isUser && work.total > 0 && onShowWork ? (
          <WorkPill label={work.label} onClick={() => onShowWork(id)} />
        ) : null}

        {isUser ? null : <Footer model={current.model} usage={current.usage} />}
      </div>

      <div
        style={{
          // Its own full-width line on a phone, so the buttons can be a row of
          // proper targets without taking that width from the message.
          flex: isPhone ? '1 0 100%' : '0 0 auto',
          display: 'flex',
          // Centred only on a phone, where this is a row of its own under the
          // message. Beside the message it stays top-aligned, level with the
          // first line — which is where it has always been.
          alignItems: isPhone ? 'center' : 'flex-start',
          justifyContent: isPhone ? 'flex-end' : undefined,
          gap: isPhone ? TOUCH_GAP : 2,
        }}
      >
        <span
          style={{
            paddingTop: isPhone ? 0 : 3,
            marginRight: isPhone ? 'auto' : 0,
            fontFamily: 'var(--font-mono)',
            fontSize: isPhone ? PHONE_TEXT.meta : 'var(--text-2xs)',
            color: 'var(--muted-foreground)',
            whiteSpace: 'nowrap',
          }}
        >
          {clockTime(current.ts)}
        </span>
        {/* Always in the DOM and in the tab order. Hover-only controls put the
            power features of this surface out of reach of keyboards and of
            every touch device, which is most of how this app is used. */}
        <ActionButton
          label={copied ? 'Copied' : 'Copy message'}
          icon={copied ? 'check' : 'copy'}
          onClick={copy}
          tone={copied ? 'var(--success)' : undefined}
        />
        {isUser && onEdit ? (
          <ActionButton
            label="Edit and resend"
            icon="pencil"
            onClick={() => onEdit(plainText(current))}
          />
        ) : null}
        {!isUser && onRetry ? (
          <ActionButton label="Retry this turn" icon="refresh-cw" onClick={() => onRetry(id)} />
        ) : null}
        {onFork ? (
          <ActionButton label="Branch from here" icon="git-branch" onClick={() => onFork(id)} />
        ) : null}
      </div>

      {/* Mounted unconditionally: a live region that appears with its text
          already in it is not an update, and assistive tech announces nothing. */}
      <span aria-live="polite" style={SR_ONLY}>
        {current.streaming ? `${isUser ? 'You are' : 'The assistant is'} responding` : ''}
      </span>
    </article>
  );
});

const ZERO = (): number => 0;

const SR_ONLY: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
};

/** How many blocks this message would actually paint. */
function visibleBlocks(message: ChatMessage): number {
  return message.blocks.filter((block) => block.kind !== 'thinking' && block.kind !== 'tool').length;
}

interface WorkSummary {
  total: number;
  label: string;
}

/**
 * What the pill says: how much machinery this message carried.
 *
 * Duration is summed from the calls that reported one rather than measured
 * between timestamps — a message's `ts` is when it opened, and the gap to the
 * next one includes however long the user spent reading.
 */
function summariseWork(
  message: ChatMessage,
  showThinking: boolean,
  showToolCalls: boolean,
): WorkSummary {
  let tools = 0;
  let reasoning = 0;
  let durationMs = 0;
  for (const block of message.blocks) {
    if (block.kind === 'tool' && showToolCalls) {
      tools += 1;
      if (block.durationMs !== undefined) durationMs += block.durationMs;
    } else if (block.kind === 'thinking' && showThinking) {
      reasoning += 1;
    }
  }

  const bits: string[] = [];
  if (tools) bits.push(`${tools} command${tools === 1 ? '' : 's'}`);
  if (reasoning) bits.push(`${reasoning} reasoning`);
  if (durationMs > 0) {
    const formatted = formatDuration(durationMs);
    if (formatted) bits.push(formatted);
  }

  return { total: tools + reasoning, label: bits.join(' · ') };
}

/**
 * The one thing the transcript keeps of a turn's machinery.
 *
 * Not a disclosure: expanding it here would put the wall of tool output back in
 * the middle of the prose, which is the thing the redesign removed. It is a
 * pointer — it opens the rail and scrolls the timeline to this message.
 */
function WorkPill({ label, onClick }: { label: string; onClick: () => void }): React.JSX.Element {
  const isPhone = usePhone();
  const [hover, setHover] = React.useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      style={{
        alignSelf: 'flex-start',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        maxWidth: '100%',
        height: isPhone ? TOUCH_TARGET : 24,
        padding: isPhone ? '0 12px' : '0 8px',
        background: 'var(--card)',
        border: `1px solid ${hover ? 'var(--border-strong)' : 'var(--border)'}`,
        borderRadius: 'var(--radius)',
        fontFamily: 'var(--font-mono)',
        fontSize: isPhone ? PHONE_TEXT.body : 10.5,
        color: hover ? 'var(--foreground)' : 'var(--muted-foreground)',
        cursor: 'pointer',
        transition: 'border-color var(--duration-fast), color var(--duration-fast)',
      }}
    >
      <Icon name="terminal" size={isPhone ? 16 : 10} />
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </span>
      <span style={{ flex: '0 0 auto', color: 'var(--foreground)' }}>show work</span>
    </button>
  );
}

function BlockView({
  block,
  plain,
  caret,
  onRetry,
}: {
  block: ChatBlock;
  /** True for the user's own turn, where text is echoed literally. */
  plain: boolean;
  caret: boolean;
  onRetry?: () => void;
}) {
  switch (block.kind) {
    case 'text':
      // A user who typed backticks or asterisks meant them. Running their own
      // input back through a renderer silently rewrites what they wrote.
      if (plain) {
        return (
          <p
            style={{
              margin: 0,
              maxWidth: 'var(--chat-prose-width, 74ch)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontSize: 'var(--chat-prose-size, var(--text-ui))',
              lineHeight: 'var(--leading-normal)',
            }}
          >
            {block.text}
            {caret ? <Caret /> : null}
          </p>
        );
      }
      return (
        // The class goes on the element the renderer's blocks are *direct*
        // children of. The measure rule uses `>` so that a code block, a table
        // or a diff — which are not in the selector — keeps the width its
        // content needs; a descendant selector would have capped them too.
        <div className="chat-prose" style={{ minWidth: 0 }}>
          <Markdown text={block.text} />
          {caret ? <Caret /> : null}
        </div>
      );

    // Reasoning and tool calls live on the trace timeline now. Returning null
    // rather than removing the cases: a block kind that silently fell through
    // to `default` would be indistinguishable from one nobody has handled yet.
    case 'thinking':
    case 'tool':
      return null;

    case 'plan':
      return <PlanPanel items={block.items} />;

    case 'image':
      return <ImageView block={block} />;

    case 'notice':
      return <NoticeRule block={block} />;

    case 'error':
      return <ErrorCallout block={block} onRetry={onRetry} />;

    default:
      return null;
  }
}

/**
 * A rule across the conversation, marking something that happened to it.
 *
 * A line rather than a message, because nobody said it. Compaction is the case
 * that matters: everything above the rule is still on screen and still worth
 * reading, and is no longer in the agent's context — so an answer that
 * contradicts something from earlier is explained rather than baffling.
 */
function NoticeRule({ block }: { block: NoticeBlock }): React.JSX.Element {
  return (
    <div
      role="separator"
      aria-label={block.detail ? `${block.text} — ${block.detail}` : block.text}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        padding: '2px 0',
        color: 'var(--muted-foreground)',
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--text-2xs)',
        letterSpacing: 'var(--tracking-wide)',
      }}
    >
      <span aria-hidden="true" style={{ flex: 1, height: 1, background: 'var(--border)' }} />
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
        <Icon name="fold-vertical" size={11} />
        {block.text}
        {block.detail ? (
          <span style={{ fontFamily: 'var(--font-mono)', opacity: 0.75 }}>{block.detail}</span>
        ) : null}
      </span>
      <span aria-hidden="true" style={{ flex: 1, height: 1, background: 'var(--border)' }} />
    </div>
  );
}

function ImageView({ block }: { block: ImageBlock }) {
  return (
    <img
      src={block.url}
      alt={block.alt || 'Attached image'}
      loading="lazy"
      style={{
        maxWidth: 'min(100%, 420px)',
        height: 'auto',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
      }}
    />
  );
}

function ErrorCallout({ block, onRetry }: { block: ErrorBlock; onRetry?: () => void }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        maxWidth: 760,
        padding: '8px 10px',
        border: '1px solid color-mix(in oklab, var(--destructive) 38%, transparent)',
        background: 'color-mix(in oklab, var(--destructive) 8%, transparent)',
        color: 'var(--destructive)',
        fontSize: 'var(--text-sm)',
        borderRadius: 'var(--radius)',
      }}
    >
      <span style={{ marginTop: 2 }}>
        <Icon name="circle-alert" size={13} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* The word carries the meaning; the colour only reinforces it. */}
        <strong style={{ fontWeight: 'var(--font-semibold)' }}>Error</strong>
        <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{block.text}</div>
      </div>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            minHeight: 34,
            padding: '0 8px',
            background: 'transparent',
            border: '1px solid color-mix(in oklab, var(--destructive) 38%, transparent)',
            color: 'var(--destructive)',
            font: 'inherit',
            fontSize: 'var(--text-xs)',
            cursor: 'pointer',
            borderRadius: 'var(--radius)',
          }}
        >
          <Icon name="refresh-cw" size={11} />
          Retry
        </button>
      ) : null}
    </div>
  );
}

function Caret() {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: 7,
        height: '1em',
        marginLeft: 2,
        verticalAlign: 'text-bottom',
        background: 'var(--foreground)',
        animation: 'relay-cursor-blink 1s step-end infinite',
      }}
    />
  );
}

function ActionButton({
  label,
  icon,
  onClick,
  tone,
}: {
  label: string;
  icon: string;
  onClick: () => void;
  tone?: string;
}) {
  const [hot, setHot] = React.useState(false);
  const isPhone = usePhone();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      onMouseEnter={() => setHot(true)}
      onMouseLeave={() => setHot(false)}
      onFocus={() => setHot(true)}
      onBlur={() => setHot(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: isPhone ? TOUCH_TARGET : 22,
        height: isPhone ? TOUCH_TARGET : 22,
        background: hot ? 'var(--accent)' : 'transparent',
        border: '1px solid transparent',
        color: tone || 'var(--muted-foreground)',
        // Quiet at rest rather than hidden: a control that only exists on hover
        // does not exist at all on a touch screen.
        opacity: hot || tone ? 1 : 0.65,
        cursor: 'pointer',
        borderRadius: 'var(--radius)',
        transition: 'opacity var(--duration-fast), background var(--duration-fast)',
      }}
    >
      <Icon name={icon} size={isPhone ? 18 : 11} />
    </button>
  );
}

function Footer({ model, usage }: { model?: string; usage?: ChatUsage }) {
  const isPhone = usePhone();
  const bits: string[] = [];
  if (model) bits.push(model);
  if (usage) {
    if (usage.inputTokens !== undefined) bits.push(`${compactCount(usage.inputTokens)} in`);
    if (usage.outputTokens !== undefined) bits.push(`${compactCount(usage.outputTokens)} out`);
    if (usage.cacheReadTokens) bits.push(`${compactCount(usage.cacheReadTokens)} cached`);
    if (usage.costUsd !== undefined) bits.push(`$${usage.costUsd.toFixed(4)}`);
  }
  if (!bits.length) return null;

  return (
    <footer
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 8,
        fontFamily: 'var(--font-mono)',
        // The model this answer ran on, and what it cost: the same figures the
        // header carries, so the same rule applies to them here.
        fontSize: isPhone ? PHONE_TEXT.label : 'var(--text-2xs)',
        color: 'var(--muted-foreground)',
      }}
    >
      {bits.map((bit, i) => (
        <span key={i}>{bit}</span>
      ))}
    </footer>
  );
}

/** hh:mm of a message's timestamp, in the viewer's locale. */
function clockTime(ts: number): string {
  if (!ts) return '';
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** The literal text of a turn, for seeding the composer with it again. */
export function plainText(message: ChatMessage): string {
  return message.blocks
    .filter((block): block is Extract<ChatBlock, { kind: 'text' }> => block.kind === 'text')
    .map((block) => block.text)
    .join('\n\n');
}

/** Plain text of a whole message, for the copy button. */
export function messageText(message: ChatMessage): string {
  const parts: string[] = [];
  for (const block of message.blocks) {
    switch (block.kind) {
      case 'text':
        // Reasoning is deliberately left out: copying a message is copying the
        // answer, not the working.
        parts.push(message.role === 'user' ? block.text : markdownText(block.text));
        break;
      case 'error':
        parts.push(block.text);
        break;
      case 'tool':
        parts.push(block.output ? `${block.name}\n${block.output}` : block.name);
        break;
      case 'plan':
        parts.push(
          block.items
            .map((item) => `- [${item.status === 'completed' ? 'x' : ' '}] ${item.text}`)
            .join('\n'),
        );
        break;
      case 'image':
        parts.push(block.alt ? `${block.alt} (${block.url})` : block.url);
        break;
      default:
        break;
    }
  }
  return parts.filter(Boolean).join('\n\n');
}
