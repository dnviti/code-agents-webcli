import * as React from 'react';
import {
  ChatBlock,
  ChatMessage,
  ChatUsage,
  ErrorBlock,
  ImageBlock,
  NoticeBlock,
  ToolBlock,
  askedQuestionFrom,
  looksLikeAskCall,
} from '../../../shared/chat-events.js';
import { ChatTranscript } from '../../chat/transcript.js';
import { compactCount, formatDuration } from '../../chat/tool-meta.js';
import { Icon } from '../../ui/relay/Icon.js';
import { PHONE_TEXT, TOUCH_GAP, TOUCH_TARGET, usePhone } from '../../ui/touch.js';
import { Markdown, markdownText } from './Markdown.js';
import { PlanPanel } from './PlanPanel.js';
import { QuestionCard } from './QuestionCard.js';

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
 *
 * A step that was *only* machinery therefore has nothing left to say, and gets
 * no row at all — a glyph, a clock and a pill with no sentence beside them is a
 * row the eye has to stop on to learn that nothing was said. Its work is not
 * lost: the list hands those ids to the next message that does speak (see
 * `carriedIds`), whose pill counts them and whose "show work" lands on the
 * first of them. The rail keeps every event either way.
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
  /**
   * Ids of the silent steps this message speaks for, oldest first, comma-joined.
   *
   * A string rather than an array because it is a prop of a `React.memo`
   * component: a fresh array per render would compare unequal every time and
   * re-render the whole transcript on every streamed token.
   */
  carriedIds?: string;
  /** Put this turn's text back in the composer, unsent. */
  onEdit?: (text: string) => void;
  /** Count reasoning blocks in the work pill, per the chat display settings. */
  showThinking?: boolean;
  /** Count tool calls in the work pill. */
  showToolCalls?: boolean;
  /**
   * Answer a question the model asked from its card in the conversation.
   *
   * Must be referentially stable — this component is memoised, and a fresh
   * closure per render would re-render the whole transcript on every token.
   */
  onAnswerQuestion?: (requestId: string, optionIds: string[], skipped: boolean) => void;
}

export const MessageBubble = React.memo(function MessageBubble({
  message,
  transcript,
  onFork,
  onRetry,
  onShowWork,
  onEdit,
  carriedIds = '',
  showThinking = true,
  showToolCalls = true,
  onAnswerQuestion,
}: MessageBubbleProps) {
  const id = message.id;

  // This message, plus the silent steps it speaks for — a tool call can report
  // how long it took after the message it belongs to has closed and the next
  // one has opened, and a pill that inherited that call has to hear about it.
  // Still one bubble per event rather than the whole list: nothing here widens
  // to the transcript.
  const watched = React.useMemo(() => [id, ...splitIds(carriedIds)], [id, carriedIds]);

  const subscribe = React.useCallback(
    (listener: () => void) => {
      const offs = watched.map((each) => transcript.subscribeMessage(each, listener));
      return () => {
        for (const off of offs) off();
      };
    },
    [transcript, watched],
  );
  const getVersion = React.useCallback(
    () => watched.reduce((sum, each) => sum + transcript.getMessageVersion(each), 0),
    [transcript, watched],
  );
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

  // Derived from blocks, not from a list handed down. An events array as a prop
  // would be a new object identity every render and would defeat React.memo for
  // the whole transcript on every streamed token — which is also why the silent
  // steps this message speaks for arrive as a joined string of ids.
  //
  // Those steps are resolved through the transcript rather than subscribed to:
  // a step only becomes silent-and-carried once the message after it has opened,
  // by which time nothing is still streaming into it.
  const work = React.useMemo(
    () => {
      const carried = splitIds(carriedIds)
        .map((carriedId) => transcript.message(carriedId))
        .filter((message): message is ChatMessage => Boolean(message));
      return summariseWork([...carried, current], showThinking, showToolCalls);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [transcript, current, version, carriedIds, showThinking, showToolCalls],
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

  // Nothing to say: a step that was only machinery. Its tool calls and its
  // reasoning are on the rail, and its count is carried onto the next message
  // that does speak, so the row itself would be an empty bordered strip with a
  // clock on it — indistinguishable from a message that failed to render.
  //
  // Independent of the display settings, and independent of `streaming`: a step
  // that has so far produced only tool calls is exactly the case this is about,
  // and the live ribbon is what says the agent is working while it does.
  //
  // The one row kept: a message that has opened and produced *nothing* yet,
  // while streaming. That is the caret between sending and the first block
  // arriving, and it is a reply about to happen rather than machinery.
  //
  // The rule itself lives in `hasVisibleContent` because the list decides which
  // ids to carry with it, and the two answers must be the same one.
  if (!hasVisibleContent(current)) return null;

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
            transcript={transcript}
            onAnswerQuestion={onAnswerQuestion}
            onRetry={onRetry ? () => onRetry(id) : undefined}
            caret={Boolean(current.streaming) && i === current.blocks.length - 1}
          />
        ))}
        {current.streaming && visibleBlocks(current) === 0 ? <Caret /> : null}

        {!isUser && work.total > 0 && onShowWork ? (
          // Aimed at the earliest step it counts, not at this message: the point
          // of the pill on a reply that follows silent work is to open the trace
          // at the *start* of that stretch.
          <WorkPill label={work.label} onClick={() => onShowWork(work.firstId || id)} />
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

/**
 * How many blocks this message would actually paint.
 *
 * Tool calls are machinery and live on the trace rail — with one exception. A
 * question the model asked is a tool call only in the mechanical sense; what it
 * actually is, is the agent talking to the user, and burying it on the rail
 * would hide the one card the turn is blocked behind.
 */
function visibleBlocks(message: ChatMessage): number {
  return message.blocks.filter(
    (block) =>
      block.kind !== 'thinking'
      && (block.kind !== 'tool' || looksLikeAskCall(block.name, block.input)),
  ).length;
}

/**
 * Whether this message gets a row of its own in the transcript.
 *
 * The list needs the same answer the bubble reaches, because it is what decides
 * which ids are carried onto the next message that speaks. Exported rather than
 * duplicated: two copies of this rule drifting apart would silently either
 * double-count a step or drop it from every pill.
 */
export function hasVisibleContent(message: ChatMessage): boolean {
  if (message.role === 'user') return true;
  if (visibleBlocks(message) > 0) return true;
  // Opened and still empty: the caret. See the early return in the bubble.
  return message.blocks.length === 0 && Boolean(message.streaming);
}

/** Split a carried-ids prop back into ids. */
function splitIds(joined: string): string[] {
  return joined ? joined.split(',') : [];
}

interface WorkSummary {
  total: number;
  label: string;
  /** The earliest message that contributed, so the pill can point there. */
  firstId?: string;
}

/**
 * What the pill says: how much machinery these messages carried.
 *
 * Takes a list rather than one message because a reply speaks for the silent
 * steps before it as well as for itself — "3 commands" on a sentence that ran
 * one of them and inherited two is the honest figure, and a pill per step is
 * exactly the clutter that was removed.
 *
 * Duration is summed from the calls that reported one rather than measured
 * between timestamps — a message's `ts` is when it opened, and the gap to the
 * next one includes however long the user spent reading.
 */
function summariseWork(
  messages: ChatMessage[],
  showThinking: boolean,
  showToolCalls: boolean,
): WorkSummary {
  let tools = 0;
  let reasoning = 0;
  let durationMs = 0;
  let firstId: string | undefined;
  for (const message of messages) {
    for (const block of message.blocks) {
      // The question card is rendered in the conversation, so counting it here
      // as well would put "1 command" on a turn whose only machinery is the
      // question already on screen.
      if (block.kind === 'tool' && looksLikeAskCall(block.name, block.input)) {
        continue;
      }
      if (block.kind === 'tool' && showToolCalls) {
        tools += 1;
        if (block.durationMs !== undefined) durationMs += block.durationMs;
      } else if (block.kind === 'thinking' && showThinking) {
        reasoning += 1;
      } else {
        continue;
      }
      // The first *counted* block, not the first carried id: a step whose only
      // activity the display settings dropped has nothing on the timeline to
      // land on, and focusing it would open the rail on nothing.
      if (firstId === undefined) firstId = message.id;
    }
  }

  const bits: string[] = [];
  if (tools) bits.push(`${tools} command${tools === 1 ? '' : 's'}`);
  if (reasoning) bits.push(`${reasoning} reasoning`);
  if (durationMs > 0) {
    const formatted = formatDuration(durationMs);
    if (formatted) bits.push(formatted);
  }

  return { total: tools + reasoning, label: bits.join(' · '), firstId };
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
  transcript,
  onAnswerQuestion,
  onRetry,
}: {
  block: ChatBlock;
  /** True for the user's own turn, where text is echoed literally. */
  plain: boolean;
  caret: boolean;
  transcript: ChatTranscript;
  onAnswerQuestion?: (requestId: string, optionIds: string[], skipped: boolean) => void;
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
      return null;

    case 'tool':
      // The one tool call that belongs in the conversation rather than on the
      // rail: it *is* the agent addressing the user. Everything else about a
      // tool call is machinery.
      if (looksLikeAskCall(block.name, block.input)) {
        return (
          <QuestionBlock
            block={block}
            transcript={transcript}
            onAnswerQuestion={onAnswerQuestion}
          />
        );
      }
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
 * A question the model asked, drawn from the call that asked it.
 *
 * The tool block is the durable record — the arguments *are* the question, and
 * they are persisted and replayed like any other block — so this needs no side
 * table to render from and survives a reload, a rejoin and a server restart.
 * The transcript is consulted only for the two things the block cannot know:
 * whether the question is still waiting, and which options were picked.
 */
function QuestionBlock({
  block,
  transcript,
  onAnswerQuestion,
}: {
  block: ToolBlock;
  transcript: ChatTranscript;
  onAnswerQuestion?: (requestId: string, optionIds: string[], skipped: boolean) => void;
}): React.JSX.Element | null {
  const asked = askedQuestionFrom(block.input);
  // Still streaming its arguments in, or malformed. Nothing to draw yet — and
  // an empty bordered card would read as a question with no answers.
  if (!asked) return null;

  const request = transcript.questionFor(block.toolId);
  const answered = request ? undefined : transcript.answerFor(block.toolId);

  return (
    <QuestionCard
      request={request}
      question={asked.question}
      header={asked.header}
      multiSelect={asked.multiSelect}
      options={asked.options}
      answered={answered}
      // The fallback for a card rebuilt from a snapshot, where the resolution
      // event was folded away before this browser ever saw it: the tool result
      // is the model's own copy of the answer and is still in the block.
      answerText={!request && !answered ? block.output : undefined}
      onAnswer={onAnswerQuestion}
    />
  );
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
