import * as React from 'react';
import { QuestionOption, QuestionRequest } from '../../../shared/chat-events.js';
import { Button } from '../../ui/relay/Button.js';
import { Icon } from '../../ui/relay/Icon.js';

/**
 * A question the model asked, answered by clicking.
 *
 * Distinct from `PermissionCard` in the one way that matters: an approval is
 * this app gating the agent, so its options are always some arrangement of
 * allow and deny and the card can style them by meaning. Here the options are
 * whatever the model wrote — the app has no opinion about which is the safe one
 * and must not imply it has, so every choice is weighted the same and none is
 * pre-selected.
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
   * answered, which is a different card entirely.
   */
  answered?: string[];
  /** Free text describing the outcome when the option ids are not available. */
  answerText?: string;
  onAnswer?: (requestId: string, optionIds: string[], skipped: boolean) => void;
}

export function QuestionCard({
  request,
  question,
  header,
  multiSelect,
  options,
  answered,
  answerText,
  onAnswer,
}: QuestionCardProps) {
  // Held locally as well as read from the transcript so the card settles the
  // instant it is clicked. The server's answer follows a beat later — and is
  // what a second browser watching the same conversation sees — but the person
  // who clicked should not watch their own click take a round trip.
  const [sent, setSent] = React.useState<string[] | null>(null);
  const [checked, setChecked] = React.useState<string[]>([]);

  const live = Boolean(request && onAnswer) && sent === null && answered === undefined;
  const picked = sent ?? answered;

  const answer = (optionIds: string[], skipped: boolean): void => {
    if (!request || !onAnswer || sent !== null) return;
    setSent(skipped ? [] : optionIds);
    onAnswer(request.requestId, optionIds, skipped);
  };

  const toggle = (optionId: string): void => {
    setChecked((current) =>
      current.includes(optionId)
        ? current.filter((each) => each !== optionId)
        : [...current, optionId],
    );
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

      {live && multiSelect ? (
        <MultiSelect options={options} checked={checked} onToggle={toggle} />
      ) : live ? (
        <div style={{ display: 'grid', gap: 6 }}>
          {options.map((option) => (
            <Button
              key={option.optionId}
              variant="outline"
              size="sm"
              style={{ justifyContent: 'flex-start', textAlign: 'left', height: 'auto', padding: '8px 10px' }}
              onClick={() => answer([option.optionId], false)}
            >
              <OptionText option={option} />
            </Button>
          ))}
        </div>
      ) : (
        <Answered options={options} picked={picked} answerText={answerText} />
      )}

      {live ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {multiSelect ? (
            <Button
              variant="primary"
              size="sm"
              disabled={checked.length === 0}
              iconLeft={<Icon name="check" size={12} />}
              onClick={() => answer(checked, false)}
            >
              Confirm
            </Button>
          ) : null}
          {/* Offered, but never as a way to make the card go away quietly: the
              model is told the question was skipped and carries on, which is
              the only ending that does not leave the turn hanging. */}
          <Button variant="ghost" size="sm" onClick={() => answer([], true)}>
            Skip
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function OptionText({ option }: { option: QuestionOption }): React.JSX.Element {
  return (
    <span style={{ display: 'grid', gap: 2, minWidth: 0 }}>
      <span style={{ fontSize: 'var(--text-ui)', color: 'var(--foreground)' }}>{option.label}</span>
      {option.description ? (
        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--muted-foreground)' }}>
          {option.description}
        </span>
      ) : null}
    </span>
  );
}

function MultiSelect({
  options,
  checked,
  onToggle,
}: {
  options: QuestionOption[];
  checked: string[];
  onToggle: (optionId: string) => void;
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
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={on}
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
 */
function Answered({
  options,
  picked,
  answerText,
}: {
  options: QuestionOption[];
  picked?: string[];
  answerText?: string;
}): React.JSX.Element {
  // No ids to match against — a card rebuilt from a replayed transcript, where
  // the resolution is known only as the sentence the model was given. Showing
  // that verbatim beats showing every option as unpicked.
  if (!picked && answerText) {
    return (
      <div style={{ display: 'grid', gap: 6 }}>
        {options.map((option) => (
          <PlainOption key={option.optionId} option={option} chosen={false} muted />
        ))}
        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--muted-foreground)' }}>{answerText}</span>
      </div>
    );
  }

  const chosen = picked ?? [];
  // "Nobody answered" and "we no longer know what was answered" are different
  // facts and used to be drawn as the same sentence (#113): a card whose
  // answer had been lost read as one the user had skipped, next to an agent
  // that had plainly acted on an answer. A real skip is an empty array; not
  // knowing is `undefined`.
  const outcome = !picked ? 'unknown' : chosen.length === 0 ? 'skipped' : 'chosen';
  return (
    <div style={{ display: 'grid', gap: 6 }} data-question-answer={outcome}>
      {options.map((option) => (
        <PlainOption key={option.optionId} option={option} chosen={chosen.includes(option.optionId)} />
      ))}
      {outcome !== 'chosen' ? (
        <span
          role="status"
          style={{ fontSize: 'var(--text-sm)', color: 'var(--muted-foreground)' }}
        >
          {outcome === 'skipped'
            ? 'Skipped without answering.'
            : 'What was picked is no longer in this conversation’s record.'}
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
