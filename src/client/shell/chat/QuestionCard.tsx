import * as React from 'react';
import {
  MAX_QUESTION_ANSWER_TEXT,
  OWN_WORDS_LABEL,
  QuestionOption,
  QuestionRequest,
  splitOwnWordsOption,
} from '../../../shared/chat-events.js';
import { Button } from '../../ui/relay/Button.js';
import { Icon } from '../../ui/relay/Icon.js';
import { PHONE_TEXT, TOUCH_TARGET, usePhone } from '../../ui/touch.js';
import { shellStore } from '../store.js';

/**
 * A question the model asked, answered by clicking or by typing.
 *
 * Distinct from `PermissionCard` in the one way that matters: an approval is
 * this app gating the agent, so its options are always some arrangement of
 * allow and deny and the card can style them by meaning. Here the options are
 * whatever the model wrote — the app has no opinion about which is the safe one
 * and must not imply it has, so every choice is weighted the same and none is
 * pre-selected.
 *
 * Every card also offers a free-text answer, because an option list the model
 * wrote cannot anticipate "none of these is quite right" and the models know
 * it: they write that option themselves, and picking it used to send the model
 * its own words back and buy nothing. That row is the textarea instead, and
 * what is typed into it reaches the tool call as the answer.
 *
 * Two modes, one component. Live, it is a set of buttons and the turn is
 * blocked behind it. Afterwards it is the record of what was asked and what was
 * answered, which is the whole reason it renders inside the conversation rather
 * than in a tray that empties: scrolling back past a decision should show the
 * decision.
 */

export interface QuestionCardProps {
  /** The live request, when this question is still waiting on an answer. */
  request?: QuestionRequest;
  /** The question as the model posed it. Present in both modes. */
  question: string;
  header?: string;
  multiSelect: boolean;
  options: QuestionOption[];
  /**
   * Option ids already chosen, for a question that has been answered.
   *
   * An empty array means answered-with-nothing (skipped); `undefined` means not
   * answered, which is a different card entirely. An empty array *with*
   * `ownWords` set is neither: it is a question answered in free text.
   */
  answered?: string[];
  /** What was typed, for a question answered in the user's own words. */
  ownWords?: string;
  /**
   * True when the question ended without anybody being able to answer it.
   *
   * Read only for a question that is no longer live, and it changes one
   * sentence: an unanswered card says the agent stopped waiting rather than
   * accusing its user of having skipped something they were never shown in
   * time.
   */
  abandoned?: boolean;
  /** Free text describing the outcome when the option ids are not available. */
  answerText?: string;
  /** Resolves true only after the server accepts this submission. */
  onAnswer?: (requestId: string, optionIds: string[], skipped: boolean, text?: string) => Promise<boolean> | void;
}

export function QuestionCard({
  request,
  question,
  header,
  multiSelect,
  options,
  answered,
  ownWords,
  answerText,
  abandoned,
  onAnswer,
}: QuestionCardProps) {
  // Held locally only after the server acknowledged it. The durable transcript
  // is still authoritative, including when another browser answered first.
  const [sent, setSent] = React.useState<string[] | null>(null);
  const [sentOwnWords, setSentOwnWords] = React.useState<string | undefined>(undefined);
  // Kept even when the transport rejects the frame. It is never rendered as
  // an answer; it only lets the eventual durable outcome explain that words
  // typed in this browser were not the words the agent received.
  const [attemptedOwnWords, setAttemptedOwnWords] = React.useState<string | undefined>(undefined);
  const [sending, setSending] = React.useState(false);
  const [checked, setChecked] = React.useState<string[]>([]);
  // The free-text row, open or not, and what is in it. Held here rather than in
  // the row itself because a multi-select confirms from the button below, which
  // has to be able to see whether anything was typed.
  const [typing, setTyping] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const connectionState = React.useSyncExternalStore(
    shellStore.subscribe,
    () => shellStore.getSnapshot().connection.state,
    () => 'disconnected',
  );

  // An accepted acknowledgement is intentionally only local until the
  // transcript records it. If the socket drops in that interval, return the
  // still-pending question to its interactive form; do not retry it for them.
  React.useEffect(() => {
    if (connectionState === 'connected' || answered !== undefined) return;
    setSent(null);
    setSentOwnWords(undefined);
    setSending(false);
  }, [answered, connectionState]);

  const live = Boolean(request && onAnswer) && sent === null && answered === undefined;
  // An acknowledgement may settle the card before the durable event arrives.
  // That event is what the model was handed, so it wins outright the moment it
  // exists — a card still showing the sentence this browser sent, beside an
  // agent that was told the question was skipped, is the one thing it must
  // never say. Both halves move together:
  // picks and words are one answer, and mixing this browser's words into
  // someone else's picks would invent a third that nobody gave.
  const settled = answered !== undefined;
  const picked = settled ? answered : (sent ?? undefined);
  const typed = settled ? ownWords : sentOwnWords;
  // Words this browser sent that are not in that record — a question already
  // answered from somewhere else, or a session that did not take them. Said
  // plainly rather than letting the sentence vanish from under whoever typed
  // it, because the agent is acting on the answer above and not on theirs.
  const dropped = Boolean(
    attemptedOwnWords
      && settled
      && ownWords !== attemptedOwnWords,
  );

  // Only what is both typed and on screen counts. Closing the row takes the
  // sentence back off the card, and an answer that carried it anyway would be
  // sending something the user can no longer see.
  const pendingText = typing ? draft.trim() : '';

  // The model's own "or tell me something else" option, when it wrote one, so
  // the card shows one free-text row rather than that option beside its own.
  // Live only: the record of what was asked lists every option as it was
  // offered, including that one.
  const { choices, invitation } = React.useMemo(() => splitOwnWordsOption(options), [options]);

  const answer = (optionIds: string[], skipped: boolean, text?: string): void => {
    if (!request || !onAnswer || sent !== null || sending) return;
    setAttemptedOwnWords(skipped ? undefined : text || undefined);
    setSending(true);
    void Promise.resolve()
      .then(async () => (await onAnswer(request.requestId, optionIds, skipped, text || undefined)) === true)
      .then((accepted) => {
        if (!accepted) return;
        setSent(skipped ? [] : optionIds);
        setSentOwnWords(skipped ? undefined : text || undefined);
      })
      .finally(() => setSending(false));
  };

  const toggle = (optionId: string): void => {
    setChecked((current) =>
      current.includes(optionId)
        ? current.filter((each) => each !== optionId)
        : [...current, optionId],
    );
  };

  // What Confirm does, and what Enter in the textarea does: send the ticks and
  // the sentence together. A multi-select answered only in free text is a real
  // answer, so this is offered whenever either half has something in it.
  const canConfirm = !sending && (checked.length > 0 || pendingText.length > 0);
  const confirm = (): void => {
    if (!canConfirm) return;
    answer(multiSelect ? checked : [], false, pendingText || undefined);
  };

  // Escape closes every dialog in this app. This is not a dialog — there is no
  // prior state to fall back to, only an agent sitting and waiting — so a stray
  // Escape must do nothing rather than appear to dismiss something that is
  // still, in fact, blocking the turn.
  const swallowEscape = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') event.stopPropagation();
  };

  return (
    <div
      role="group"
      aria-label={`Question from the assistant: ${question}`}
      data-question-card={live ? 'live' : 'answered'}
      onKeyDown={swallowEscape}
      style={{
        border: `1px solid ${live ? 'var(--info)' : 'var(--border)'}`,
        background: 'var(--card)',
        display: 'grid',
        // Not the implicit `auto` track. A grid item's `min-width` is `auto`,
        // so an auto track is sized by its widest child and a single long
        // option pushed the card itself wider than the column it sits in —
        // which is how the text ended up outside the conversation rather than
        // merely outside the card.
        gridTemplateColumns: 'minmax(0, 1fr)',
        gap: 10,
        padding: 12,
        maxWidth: 'var(--chat-prose-width, 74ch)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <Icon
          name="circle-help"
          size={16}
          style={{ color: live ? 'var(--info)' : 'var(--muted-foreground)', marginTop: 2 }}
        />
        <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: 4 }}>
          {header ? (
            <span
              style={{
                fontSize: 'var(--text-2xs)',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                color: 'var(--muted-foreground)',
              }}
            >
              {header}
            </span>
          ) : null}
          <span
            style={{
              fontSize: 'var(--text-body)',
              fontWeight: 'var(--font-semibold)',
              color: 'var(--foreground)',
              ...WRAPS,
            }}
          >
            {question}
          </span>
          {live && multiSelect ? (
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--muted-foreground)' }}>
              Pick as many as apply, then confirm.
            </span>
          ) : null}
        </div>
      </div>

      {live ? (
        <div style={{ display: 'grid', gap: 6 }}>
          {multiSelect ? (
            <MultiSelect options={choices} checked={checked} onToggle={toggle} disabled={sending} />
          ) : (
            choices.map((option) => (
              <Button
                key={option.optionId}
                variant="outline"
                size="sm"
                disabled={sending}
                style={OPTION_BUTTON}
                onClick={() => answer([option.optionId], false)}
              >
                <OptionText option={option} />
              </Button>
            ))
          )}
          <OwnWords
            label={invitation?.label || OWN_WORDS_LABEL}
            description={invitation?.description}
            open={typing}
            value={draft}
            onOpen={() => setTyping(true)}
            onClose={() => setTyping(false)}
            onChange={setDraft}
            onSubmit={confirm}
            disabled={sending}
            // The row sends for itself only when there is no Confirm below it.
            // Two buttons that answer the same question, one of them ignoring
            // half the card, is worse than the extra click.
            showSend={!multiSelect}
          />
        </div>
      ) : (
        <Answered
          options={options}
          picked={picked}
          ownWords={typed}
          answerText={answerText}
          dropped={dropped}
          abandoned={abandoned}
        />
      )}

      {live ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {multiSelect ? (
            <Button
              variant="primary"
              size="sm"
              disabled={!canConfirm}
              iconLeft={<Icon name="check" size={12} />}
              onClick={confirm}
            >
              Confirm
            </Button>
          ) : null}
          {/* Offered, but never as a way to make the card go away quietly: the
              model is told the question was skipped and carries on, which is
              the only ending that does not leave the turn hanging. */}
          <Button variant="ghost" size="sm" disabled={sending} onClick={() => answer([], true)}>
            Skip
          </Button>
          {sending ? (
            <span role="status" data-question-answer-sending="true" style={{ fontSize: 'var(--text-sm)', color: 'var(--muted-foreground)' }}>
              Sending answer…
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Long-answer wrapping, applied everywhere an option's own words are drawn.
 *
 * `Button` sets `white-space: nowrap`, which is right for a button with a verb
 * on it and wrong for an option whose description is a sentence the model
 * wrote: those routinely run wider than the card, and the text simply left the
 * right-hand edge of the conversation. `anywhere` covers the other half — a
 * path or a URL with no space in it has nowhere to break otherwise.
 */
const WRAPS: React.CSSProperties = {
  whiteSpace: 'normal',
  overflowWrap: 'anywhere',
};

/** The shared shape of an option row that is a button. */
const OPTION_BUTTON: React.CSSProperties = {
  justifyContent: 'flex-start',
  textAlign: 'left',
  height: 'auto',
  width: '100%',
  padding: '8px 10px',
  // `Button` sets 1, which stacks wrapped lines on top of each other.
  lineHeight: 'var(--leading-normal)',
  ...WRAPS,
};

function OptionText({ option }: { option: QuestionOption }): React.JSX.Element {
  return (
    <span style={{ display: 'grid', gap: 2, flex: 1, minWidth: 0, ...WRAPS }}>
      <span style={{ fontSize: 'var(--text-ui)', color: 'var(--foreground)' }}>{option.label}</span>
      {option.description ? (
        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--muted-foreground)' }}>
          {option.description}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The free-text answer, offered on every question.
 *
 * Collapsed until it is wanted, so a yes/no question is still two buttons and a
 * quiet third row. Open, it is a textarea and the answer it sends is whatever
 * is in it — the same tool call, the same result, no second turn spent asking
 * the user to repeat themselves in prose.
 */
function OwnWords({
  label,
  description,
  open,
  value,
  onOpen,
  onClose,
  onChange,
  onSubmit,
  showSend,
  disabled,
}: {
  label: string;
  description?: string;
  open: boolean;
  value: string;
  onOpen: () => void;
  onClose: () => void;
  onChange: (value: string) => void;
  onSubmit: () => void;
  showSend: boolean;
  disabled: boolean;
}): React.JSX.Element {
  const isPhone = usePhone();
  const area = React.useRef<HTMLTextAreaElement | null>(null);

  React.useEffect(() => {
    if (open) area.current?.focus();
  }, [open]);

  if (!open) {
    return (
      <Button
        variant="outline"
        size="sm"
        aria-expanded={false}
        data-question-own-words="closed"
        style={OPTION_BUTTON}
        disabled={disabled}
        onClick={onOpen}
      >
        <OptionText option={{ optionId: 'own-words', label, description }} />
      </Button>
    );
  }

  return (
    <div
      data-question-own-words="open"
      style={{
        display: 'grid',
        gap: 6,
        padding: '8px 10px',
        border: '1px solid var(--info)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--text-ui)', ...WRAPS }}>{label}</span>
        <Button
          variant="ghost"
          size="sm"
          aria-expanded
          aria-label="Close the free-text answer and go back to the options"
          onClick={onClose}
          disabled={disabled}
          style={{ padding: '0 6px', height: 'auto' }}
        >
          <Icon name="x" size={12} />
        </Button>
      </div>
      <textarea
        ref={area}
        value={value}
        maxLength={MAX_QUESTION_ANSWER_TEXT}
        aria-label="Your answer, in your own words"
        placeholder="Type your answer…"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          // The composer's convention, because this is the same act: text on
          // its way to the agent. A touch keyboard has no separate send
          // gesture, so Enter stays a newline there and the button is the way.
          if (event.key === 'Enter' && !event.shiftKey && !isPhone) {
            event.preventDefault();
            if (value.trim()) onSubmit();
          }
        }}
        rows={3}
        style={{
          width: '100%',
          minWidth: 0,
          minHeight: isPhone ? TOUCH_TARGET * 2 : 60,
          resize: 'vertical',
          padding: '6px 8px',
          background: 'var(--input)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          color: 'var(--foreground)',
          fontFamily: 'var(--font-sans)',
          // 16px on a phone or iOS Safari zooms in on focus and never back out.
          fontSize: isPhone ? PHONE_TEXT.input : 'var(--text-ui)',
          lineHeight: 'var(--leading-normal)',
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {showSend ? (
          <Button
            variant="primary"
            size="sm"
            disabled={disabled || !value.trim()}
            iconLeft={<Icon name="arrow-up" size={12} />}
            onClick={onSubmit}
          >
            Send
          </Button>
        ) : null}
        <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--muted-foreground)' }}>
          {isPhone
            ? showSend
              ? 'Sent as your answer to this question.'
              : 'Confirm below sends this with anything you ticked.'
            : showSend
              ? 'Enter sends, Shift+Enter starts a new line.'
              : 'Enter sends this with anything you ticked; Shift+Enter starts a new line.'}
        </span>
      </div>
    </div>
  );
}

function MultiSelect({
  options,
  checked,
  onToggle,
  disabled,
}: {
  options: QuestionOption[];
  checked: string[];
  onToggle: (optionId: string) => void;
  disabled: boolean;
}): React.JSX.Element {
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {options.map((option) => {
        const on = checked.includes(option.optionId);
        return (
          <label
            key={option.optionId}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              padding: '8px 10px',
              border: `1px solid ${on ? 'var(--info)' : 'var(--border)'}`,
              background: on ? 'var(--accent)' : 'transparent',
              cursor: disabled ? 'default' : 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={on}
              disabled={disabled}
              onChange={() => onToggle(option.optionId)}
              style={{ marginTop: 3 }}
            />
            <OptionText option={option} />
          </label>
        );
      })}
    </div>
  );
}

/**
 * What was asked and what was answered, after the fact.
 *
 * Every option is still listed rather than only the chosen one: "picked B" says
 * much less on its own than "picked B out of A, B, C", and the whole point of
 * leaving this in the transcript is that it still reads as a decision later.
 * Listed exactly as it was offered, too — the live card folds the model's own
 * "or tell me something else" option into the textarea, but the record of what
 * the model put on screen is not the place to tidy that away.
 */
function Answered({
  options,
  picked,
  ownWords,
  answerText,
  dropped = false,
  abandoned = false,
}: {
  options: QuestionOption[];
  picked?: string[];
  ownWords?: string;
  answerText?: string;
  /** True when words typed here are not the answer the session recorded. */
  dropped?: boolean;
  /** True when the question ended before anybody could answer it. */
  abandoned?: boolean;
}): React.JSX.Element {
  // No ids to match against — a card rebuilt from a replayed transcript, where
  // the resolution is known only as the sentence the model was given. Showing
  // that verbatim beats showing every option as unpicked.
  if (!picked && !ownWords && answerText) {
    return (
      <div style={{ display: 'grid', gap: 6 }}>
        {options.map((option) => (
          <PlainOption key={option.optionId} option={option} chosen={false} muted />
        ))}
        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--muted-foreground)', ...WRAPS }}>
          {answerText}
        </span>
      </div>
    );
  }

  const chosen = picked ?? [];
  // "Nobody answered" and "we no longer know what was answered" are different
  // facts and used to be drawn as the same sentence (#113): a card whose
  // answer had been lost read as one the user had skipped, next to an agent
  // that had plainly acted on an answer. A real skip is an empty array; not
  // knowing is `undefined`. Words typed into the card are a third thing again,
  // and the one case where an empty array of picks is still an answer.
  //
  // And a fourth: the question that ended before anybody could answer it.
  // It arrives looking exactly like a skip — no picks, no words — so it has to
  // be told apart by the flag rather than by the shape of the answer, which is
  // why the session records one (#174).
  const outcome = ownWords
    ? 'chosen'
    : !picked
      ? 'unknown'
      : chosen.length > 0
        ? 'chosen'
        : abandoned
          ? 'abandoned'
          : 'skipped';
  return (
    <div style={{ display: 'grid', gap: 6 }} data-question-answer={outcome}>
      {options.map((option) => (
        <PlainOption key={option.optionId} option={option} chosen={chosen.includes(option.optionId)} />
      ))}
      {ownWords ? (
        <PlainOption
          option={{
            optionId: 'own-words',
            label: ownWords,
            description: 'Answered in their own words',
          }}
          chosen
        />
      ) : null}
      {outcome !== 'chosen' ? (
        <span
          role="status"
          style={{ fontSize: 'var(--text-sm)', color: 'var(--muted-foreground)' }}
        >
          {outcome === 'skipped'
            ? 'Skipped without answering.'
            : outcome === 'abandoned'
              ? 'The agent stopped waiting for an answer, so this was never put to anyone.'
              : 'What was picked is no longer in this conversation’s record.'}
        </span>
      ) : null}
      {dropped ? (
        <span
          role="status"
          data-question-answer-dropped="true"
          style={{ fontSize: 'var(--text-sm)', color: 'var(--warning)', ...WRAPS }}
        >
          What you typed was not recorded as the answer to this question, and the agent was not
          given it.
        </span>
      ) : null}
    </div>
  );
}

function PlainOption({
  option,
  chosen,
  muted = false,
}: {
  option: QuestionOption;
  chosen: boolean;
  muted?: boolean;
}): React.JSX.Element {
  return (
    <div
      data-question-option={chosen ? 'chosen' : 'offered'}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        padding: '6px 10px',
        border: `1px solid ${chosen ? 'var(--success)' : 'var(--border)'}`,
        // Not colour alone: the chosen option carries a tick, so the answer is
        // still legible to someone who cannot separate the two borders.
        opacity: chosen || muted ? 1 : 0.6,
      }}
    >
      <Icon
        name={chosen ? 'check' : 'circle'}
        size={13}
        style={{ marginTop: 3, color: chosen ? 'var(--success)' : 'var(--muted-foreground)' }}
      />
      <OptionText option={option} />
      {chosen ? <span style={SR_ONLY}>chosen</span> : null}
    </div>
  );
}

const SR_ONLY: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
};
