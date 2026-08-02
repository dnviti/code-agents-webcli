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
  withoutQuestionFallbackEnvelope,
} from '../../../shared/chat-events.js';
import {
  blockDraws,
  drawsQuestion,
  hasVisibleContent,
  isRule,
} from '../../../shared/chat-visibility.js';
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
 * middle of a sentence. What is left behind is a counter in the action row: how
 * much happened, and one click to go and look at it. Moved, never hidden.
 *
 * That counter used to be a full-width button under the prose spelling the same
 * thing out in words ("3 commands · 2 reasoning · 12s — show work"). It cost a
 * line of the conversation on nearly every assistant turn, so a long exchange
 * read as a stack of banners rather than as a conversation. It now sits with
 * the other per-message actions as two glyphs and two numbers (issue #118); the
 * words it dropped are still in its accessible description.
 *
 * A step that was *only* machinery therefore has nothing left to say, and gets
 * no row at all — a glyph, a clock and a counter with no sentence beside them
 * is a row the eye has to stop on to learn that nothing was said. Its work is
 * not lost: the list hands those ids to the next message that does speak (see
 * `carriedIds`), whose counter counts them and whose click lands on the first
 * of them. The rail keeps every event either way.
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
  /** Count reasoning blocks in the work counter, per the chat display settings. */
  showThinking?: boolean;
  /** Count tool calls in the work counter. */
  showToolCalls?: boolean;
  /**
   * Answer a question the model asked from its card in the conversation.
   *
   * Must be referentially stable — this component is memoised, and a fresh
   * closure per render would re-render the whole transcript on every token.
   */
  onAnswerQuestion?: (requestId: string, optionIds: string[], skipped: boolean, text?: string) => void;
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
  // one has opened, and a counter that inherited that call has to hear about it.
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
  const isMarker = isRule(current);

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
    // A rule carries no clock, because a compaction or a branch happens *to*
    // the turn it is drawn in and shares its moment. A failure filed this way
    // does not: a background workflow is filed under the turn that launched it
    // and can break half an hour after that turn ended, so this one row says
    // when (#140).
    const stamped = current.blocks.some((block) => block.kind === 'error');
    return (
      <div data-message-id={id} style={{ padding: '10px 14px' }}>
        {current.blocks.map((block, i) =>
          block.kind === 'error' ? (
            <ErrorCallout key={i} block={block} />
          ) : (
            <NoticeRule key={i} block={block as NoticeBlock} />
          ),
        )}
        {stamped ? (
          <div
            style={{
              marginTop: 4,
              fontFamily: 'var(--font-mono)',
              fontSize: isPhone ? PHONE_TEXT.detail : 'var(--text-2xs)',
              color: 'var(--muted-foreground)',
            }}
          >
            {clockTime(current.ts)}
          </div>
        ) : null}
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
        {current.streaming && !current.blocks.some(blockDraws) ? <Caret /> : null}

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
            fontSize: isPhone ? PHONE_TEXT.detail : 'var(--text-2xs)',
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
        {!isUser && work.total > 0 && onShowWork ? (
          // Aimed at the earliest step it counts, not at this message: the point
          // of the counter on a reply that follows silent work is to open the
          // trace at the *start* of that stretch.
          <WorkCounter work={work} onClick={() => onShowWork(work.firstId || id)} />
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
 * Whether a message is drawn at all, and whether it is drawn as a rule.
 *
 * Both rules moved to `shared/chat-visibility.ts` for #132, because three
 * places have to reach the same answer — this bubble, the list folding silent
 * steps onto the next reply, and a test asking it of a real recording without
 * bundling React. Re-exported here so the callers that already import them from
 * this module keep working.
 */
export { hasVisibleContent, isRule };

/** Split a carried-ids prop back into ids. */
function splitIds(joined: string): string[] {
  return joined ? joined.split(',') : [];
}

interface WorkSummary {
  total: number;
  /** Tool calls counted, after the display settings had their say. */
  tools: number;
  /** Reasoning blocks counted, likewise. */
  reasoning: number;
  /** Summed from the calls that reported one; 0 when none did. */
  durationMs: number;
  /** The earliest message that contributed, so the counter can point there. */
  firstId?: string;
}

/**
 * What the counter says: how much machinery these messages carried.
 *
 * Takes a list rather than one message because a reply speaks for the silent
 * steps before it as well as for itself — "3 commands" on a sentence that ran
 * one of them and inherited two is the honest figure, and a counter per step is
 * exactly the clutter that was removed.
 *
 * Returns the figures rather than a sentence built from them, because the two
 * places they are needed want them differently: the control draws each beside
 * its own glyph, and its accessible description spells all of them out.
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
      if (block.kind === 'tool' && drawsQuestion(block)) {
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

  return { total: tools + reasoning, tools, reasoning, durationMs, firstId };
}

/**
 * The words the glyphs and numbers stand for.
 *
 * Two icons and two integers are legible at a glance and meaningless to a
 * screen reader, so the counts go in the label in full. The elapsed time comes
 * with them: it is the one figure the old wide button carried that the compact
 * control has no room to draw, and it is worth more here than nowhere.
 */
function workDescription({ tools, reasoning, durationMs }: WorkSummary): string {
  const bits: string[] = [];
  if (tools) bits.push(`${tools} command${tools === 1 ? '' : 's'}`);
  if (reasoning) bits.push(`${reasoning} reasoning step${reasoning === 1 ? '' : 's'}`);
  if (durationMs > 0) {
    const formatted = formatDuration(durationMs);
    if (formatted) bits.push(formatted);
  }
  return `Show work: ${bits.join(', ')}`;
}

/**
 * The one thing the transcript keeps of a turn's machinery.
 *
 * Not a disclosure: expanding it here would put the wall of tool output back in
 * the middle of the prose, which is the thing the redesign removed. It is a
 * pointer — it opens the rail and scrolls the timeline to this message.
 *
 * It sits in the action row rather than under the prose, and is sized like the
 * buttons around it, because that row is where everything else you can do to a
 * message already lives. A count of zero is left out entirely: a turn that only
 * thought shows a brain and nothing else, and "0" beside a terminal is a fact
 * nobody needed to be told.
 */
function WorkCounter({ work, onClick }: { work: WorkSummary; onClick: () => void }): React.JSX.Element {
  const isPhone = usePhone();
  const [hot, setHot] = React.useState(false);
  const label = workDescription(work);
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
        // Between the pairs, not inside them: a number belongs to the glyph on
        // its left, and equal spacing everywhere would read as four things.
        gap: isPhone ? 8 : 5,
        flex: '0 0 auto',
        // Same hit area as its neighbours — it is one more message action, and
        // a shorter one would be the odd target out under a fingertip.
        minWidth: isPhone ? TOUCH_TARGET : 22,
        height: isPhone ? TOUCH_TARGET : 22,
        padding: isPhone ? '0 8px' : '0 4px',
        background: hot ? 'var(--accent)' : 'transparent',
        border: '1px solid transparent',
        borderRadius: 'var(--radius)',
        fontFamily: 'var(--font-mono)',
        fontSize: isPhone ? PHONE_TEXT.detail : 'var(--text-2xs)',
        lineHeight: 1,
        // Quiet, but not faded. The buttons either side of this one sit at 0.65
        // opacity at rest, and that is fine for them: they carry a verb, drawn
        // as a glyph, that is recognised rather than read. This one carries a
        // *number*, and a number at 0.65 over `--muted-foreground` composites
        // below the contrast a small figure needs to be resolved at all — which
        // the wide button it replaces never did to its counts. So it takes the
        // muted colour and none of the fade, and brightens the whole way on
        // hover and focus, exactly as that button did.
        color: hot ? 'var(--foreground)' : 'var(--muted-foreground)',
        whiteSpace: 'nowrap',
        cursor: 'pointer',
        transition: 'color var(--duration-fast), background var(--duration-fast)',
      }}
    >
      {work.tools ? <Count icon="terminal" value={work.tools} isPhone={isPhone} /> : null}
      {work.reasoning ? <Count icon="brain" value={work.reasoning} isPhone={isPhone} /> : null}
    </button>
  );
}

/**
 * One glyph and the number beside it, kept together on a line.
 *
 * Not marked `aria-hidden`: the button's own `aria-label` already replaces
 * everything inside it for assistive tech, and hiding the number as well would
 * take it out of reach of anything that reads drawn text — including the checks
 * that measure whether it is big enough to read on a phone.
 */
function Count({
  icon,
  value,
  isPhone,
}: {
  icon: string;
  value: number;
  isPhone: boolean;
}): React.JSX.Element {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
      <Icon name={icon} size={isPhone ? 13 : 11} />
      {value}
    </span>
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
  onAnswerQuestion?: (requestId: string, optionIds: string[], skipped: boolean, text?: string) => void;
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
          <Markdown text={withoutQuestionFallbackEnvelope(block.text)} />
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
      if (drawsQuestion(block)) {
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

    case 'question': {
      const recorded = block.request;
      const request = transcript.pendingQuestions.find(
        (pending) => pending.requestId === recorded.requestId,
      );
      const answerKey = recorded.toolId ?? recorded.requestId;
      const durable = block.answer;
      return (
        <QuestionCard
          request={request}
          question={recorded.question}
          header={recorded.header}
          multiSelect={recorded.multiSelect}
          options={recorded.options}
          answered={request ? undefined : (transcript.answerFor(answerKey) ?? durable?.optionIds)}
          ownWords={request ? undefined : (transcript.answerTextFor(answerKey) ?? durable?.text)}
          abandoned={!request && (transcript.abandonedFor(answerKey) || durable?.abandoned)}
          onAnswer={onAnswerQuestion}
        />
      );
    }

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
  onAnswerQuestion?: (requestId: string, optionIds: string[], skipped: boolean, text?: string) => void;
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
      // The other half of an answer, for a question answered in free text: the
      // ids alone would come back as an empty list, which is what a skip looks
      // like, and the card would say nobody answered a question that was.
      ownWords={request ? undefined : transcript.answerTextFor(block.toolId)}
      // The fallback for a card rebuilt from a snapshot, where the resolution
      // event was folded away before this browser ever saw it: the tool result
      // is the model's own copy of the answer and is still in the block.
      answerText={!request && !answered ? block.output : undefined}
      // Whether anybody was ever in a position to answer. An empty list of
      // picks says "no options were chosen" and nothing about why; this is the
      // difference between a question its user declined and one whose agent had
      // already stopped listening (#174).
      abandoned={!request && transcript.abandonedFor(block.toolId)}
      onAnswer={onAnswerQuestion}
    />
  );
}

/** The same glyph the action that caused each rule is drawn with elsewhere. */
const NOTICE_GLYPH: Partial<Record<NoticeBlock['notice'], string>> = {
  interrupted: 'square',
  branched: 'git-branch',
  // A rung change, up or down. One glyph for both directions: the detail beside
  // it names the rung, and two arrows would encode as a symbol the one thing
  // the sentence already says out loud.
  model: 'chevrons-up-down',
};

/**
 * A rule across the conversation, marking something that happened to it.
 *
 * A line rather than a message, because nobody said it. Compaction is the case
 * that matters: everything above the rule is still on screen and still worth
 * reading, and is no longer in the agent's context — so an answer that
 * contradicts something from earlier is explained rather than baffling.
 */
function NoticeRule({ block }: { block: NoticeBlock }): React.JSX.Element {
  const isPhone = usePhone();
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
        // 10px is below the 12px a phone can be read at (#92).
        fontSize: isPhone ? PHONE_TEXT.detail : 'var(--text-2xs)',
        letterSpacing: 'var(--tracking-wide)',
      }}
    >
      <span aria-hidden="true" style={{ flex: 1, height: 1, background: 'var(--border)' }} />
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
        <Icon name={NOTICE_GLYPH[block.notice] ?? 'fold-vertical'} size={11} />
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
  // A sentence, so it is written at the size a sentence is written at. Left on
  // `--text-sm` it sat 3px under the prose around it on a phone and exactly on
  // the floor the browser checks measure to — the one message in the
  // conversation that has to be read, in the smallest type on screen.
  const isPhone = usePhone();
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
        // An error *is* the message here, so it reads at the message's size
        // rather than at a size of its own — which is also what keeps it above
        // the accounting around it on a phone (#92).
        fontSize: 'var(--chat-prose-size, var(--text-ui))',
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
        // The model this answer ran on and what it cost: per-answer accounting,
        // not the session's, so it sits below the message rather than beside
        // the header's live figures. Raising it to match them is what made the
        // message the smallest text on the screen (#92).
        fontSize: isPhone ? PHONE_TEXT.detail : 'var(--text-2xs)',
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

/** Keep the private no-MCP wire envelope out of rendered and copied history. */
export { withoutQuestionFallbackEnvelope };

/** Plain text of a whole message, for the copy button. */
export function messageText(message: ChatMessage): string {
  const parts: string[] = [];
  for (const block of message.blocks) {
    switch (block.kind) {
      case 'text':
        // Reasoning is deliberately left out: copying a message is copying the
        // answer, not the working.
        parts.push(message.role === 'user'
          ? block.text
          : markdownText(withoutQuestionFallbackEnvelope(block.text)));
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
      case 'question':
        parts.push([
          block.request.question,
          ...block.request.options.map((option) => option.label),
          ...((block.answer?.optionIds ?? []).map((optionId) =>
            block.request.options.find((option) => option.optionId === optionId)?.label ?? optionId)),
          block.answer?.text ?? '',
        ].join('\n'));
        break;
      default:
        break;
    }
  }
  return parts.filter(Boolean).join('\n\n');
}
