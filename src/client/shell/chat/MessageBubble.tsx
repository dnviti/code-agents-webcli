import * as React from 'react';
import {
  ChatBlock,
  ChatMessage,
  ChatUsage,
  ErrorBlock,
  ImageBlock,
  ThinkingBlock,
} from '../../../shared/chat-events.js';
import { ChatTranscript } from '../../chat/transcript.js';
import { Icon } from '../../ui/relay/Icon.js';
import { Markdown, markdownText } from './Markdown.js';
import { ToolCallCard } from './ToolCallCard.js';
import { PlanPanel } from './PlanPanel.js';

/**
 * One message in the transcript.
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
 */

export interface MessageBubbleProps {
  message: ChatMessage;
  transcript: ChatTranscript;
  onFork?: (messageId: string) => void;
  onRetry?: () => void;
}

const ROLE_META: Record<string, { icon: string; label: string }> = {
  user: { icon: 'user', label: 'You' },
  assistant: { icon: 'bot', label: 'Assistant' },
  system: { icon: 'message-square', label: 'System' },
};

export const MessageBubble = React.memo(function MessageBubble({
  message,
  transcript,
  onFork,
  onRetry,
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
  const isUser = current.role === 'user';
  const meta = ROLE_META[current.role] || ROLE_META.assistant;

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

  return (
    <article
      aria-label={`${meta.label} message`}
      style={{
        display: 'grid',
        gap: 6,
        padding: '10px 12px',
        // Role is carried by three independent signals — icon, text label and
        // this surface — so it survives a monochrome display or colour blindness.
        background: isUser ? 'var(--card)' : 'transparent',
        borderLeft: isUser ? '2px solid var(--border-strong)' : '2px solid transparent',
      }}
    >
      <header style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 20 }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 18,
            height: 18,
            border: '1px solid var(--border)',
            color: 'var(--muted-foreground)',
            borderRadius: 'var(--radius)',
          }}
        >
          <Icon name={meta.icon} size={11} />
        </span>
        <span
          style={{
            fontSize: 'var(--text-xs)',
            fontWeight: 'var(--font-semibold)',
            letterSpacing: 'var(--tracking-wide)',
            color: 'var(--foreground)',
          }}
        >
          {meta.label}
        </span>
        {current.streaming ? (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-2xs)',
              color: 'var(--muted-foreground)',
            }}
          >
            writing
          </span>
        ) : null}

        <span style={{ flex: 1 }} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          {/* Always in the DOM and in the tab order. Hover-only controls put the
              two power features of this surface out of reach of keyboards and
              of every touch device, which is most of how this app is used. */}
          <ActionButton
            label={copied ? 'Copied' : 'Copy message'}
            icon={copied ? 'check' : 'copy'}
            onClick={copy}
            tone={copied ? 'var(--success)' : undefined}
          />
          {onFork ? (
            <ActionButton
              label="Branch from here"
              icon="git-branch"
              onClick={() => onFork(id)}
            />
          ) : null}
        </div>
      </header>

      <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
        {current.blocks.map((block, i) => (
          <BlockView
            key={i}
            block={block}
            plain={isUser}
            onRetry={onRetry}
            caret={Boolean(current.streaming) && i === current.blocks.length - 1}
          />
        ))}
        {current.streaming && current.blocks.length === 0 ? <Caret /> : null}
      </div>

      {/* Mounted unconditionally: a live region that appears with its text
          already in it is not an update, and assistive tech announces nothing. */}
      <span
        aria-live="polite"
        style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}
      >
        {current.streaming ? `${meta.label} is responding` : ''}
      </span>

      <Footer model={current.model} usage={current.usage} />
    </article>
  );
});

const ZERO = (): number => 0;

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
          <div
            style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              lineHeight: 'var(--leading-normal)',
            }}
          >
            {block.text}
            {caret ? <Caret /> : null}
          </div>
        );
      }
      return (
        <div style={{ minWidth: 0 }}>
          <Markdown text={block.text} />
          {caret ? <Caret /> : null}
        </div>
      );

    case 'thinking':
      return <Thinking block={block} />;

    case 'tool':
      return <ToolCallCard block={block} />;

    case 'plan':
      return <PlanPanel items={block.items} />;

    case 'image':
      return <ImageView block={block} />;

    case 'error':
      return <ErrorCallout block={block} onRetry={onRetry} />;

    default:
      return null;
  }
}

function Thinking({ block }: { block: ThinkingBlock }) {
  const [open, setOpen] = React.useState(false);
  const regionId = React.useId();

  const { lines, tokens } = React.useMemo(() => {
    const text = block.text || '';
    return {
      lines: text ? text.split('\n').length : 0,
      // Four characters per token is the usual rough ratio; this is a size cue,
      // not an accounting figure, so an approximation is honest enough.
      tokens: Math.ceil(text.length / 4),
    };
  }, [block.text]);

  return (
    <div style={{ border: '1px solid var(--border)', background: 'var(--muted)' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={regionId}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          width: '100%',
          minHeight: 34,
          padding: '0 8px',
          background: 'transparent',
          border: 0,
          color: 'var(--muted-foreground)',
          font: 'inherit',
          fontSize: 'var(--text-xs)',
          textAlign: 'left',
          cursor: 'pointer',
          borderRadius: 'var(--radius)',
        }}
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
        <Icon name="brain" size={12} />
        <span style={{ fontWeight: 'var(--font-medium)' }}>
          {open ? 'Hide reasoning' : 'Reasoning'}
        </span>
        <span
          style={{
            marginLeft: 'auto',
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-2xs)',
            whiteSpace: 'nowrap',
          }}
        >
          {lines} {lines === 1 ? 'line' : 'lines'} · ~{compact(tokens)} tok
        </span>
      </button>
      {open ? (
        <div
          id={regionId}
          style={{
            padding: '2px 10px 8px',
            color: 'var(--muted-foreground)',
            fontSize: 'var(--text-sm)',
          }}
        >
          <Markdown text={block.text} dense />
        </div>
      ) : null}
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
        maxWidth: '100%',
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
        // 34px keeps it a comfortable touch target on the phone layout.
        width: 34,
        height: 34,
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
      <Icon name={icon} size={13} />
    </button>
  );
}

function Footer({ model, usage }: { model?: string; usage?: ChatUsage }) {
  const bits: string[] = [];
  if (model) bits.push(model);
  if (usage) {
    if (usage.inputTokens !== undefined) bits.push(`${compact(usage.inputTokens)} in`);
    if (usage.outputTokens !== undefined) bits.push(`${compact(usage.outputTokens)} out`);
    if (usage.cacheReadTokens) bits.push(`${compact(usage.cacheReadTokens)} cached`);
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
        fontSize: 'var(--text-2xs)',
        color: 'var(--muted-foreground)',
      }}
    >
      {bits.map((bit, i) => (
        <span key={i}>{bit}</span>
      ))}
    </footer>
  );
}

/** Short form for token counts, which routinely run to six figures. */
function compact(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
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
