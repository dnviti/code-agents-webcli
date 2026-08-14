import { ASK_QUESTION_TOOL, QUESTION_FALLBACK_OPEN, QUESTION_FALLBACK_CLOSE } from '../../shared/chat-events.js';
import { QuestionAsk, QuestionReply } from './permission-broker.js';

export const PLAN_SAFE_SLASH_COMMANDS = new Set(['/model', '/effort']);

export function questionToolDirective(): string {
  return [
    '[Interactive questions are available in this Web conversation in both Default and Plan mode.]',
    `When the next step needs a user decision, call the ${ASK_QUESTION_TOOL} tool and wait for the answer instead of guessing or asking in prose.`,
    'Use an ordinary response when no user decision is needed.',
  ].join(' ');
}

export function questionFallbackDirective(): string {
  return [
    '[Interactive-question fallback for this Web conversation.]',
    'If you need a user decision and the ask_user_question tool is unavailable, stop instead of guessing.',
    `Return exactly ${QUESTION_FALLBACK_OPEN}{"version":1,"question":"...","header":"2-4 words","multiSelect":false,"options":[{"label":"...","description":"..."}]}${QUESTION_FALLBACK_CLOSE}.`,
    'The Web interface will show the choices and send the answer in a continuation. Use ordinary prose when no decision is needed.',
  ].join(' ');
}

export function responseQuestionEnvelope(
  markdown: string,
): { question?: QuestionAsk; error?: string; start: number; end: number } | null {
  const start = markdown.lastIndexOf(QUESTION_FALLBACK_OPEN);
  if (start < 0) return null;
  const from = start + QUESTION_FALLBACK_OPEN.length;
  const end = markdown.indexOf(QUESTION_FALLBACK_CLOSE, from);
  if (end < 0) {
    return {
      error: 'the structured question envelope was not closed',
      start,
      end: markdown.length,
    };
  }
  try {
    const value = JSON.parse(markdown.slice(from, end).trim());
    const version = value && typeof value === 'object' && !Array.isArray(value)
      ? (value as { version?: unknown }).version
      : undefined;
    const envelopeEnd = end + QUESTION_FALLBACK_CLOSE.length;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { error: 'the structured question payload was not an object', start, end: envelopeEnd };
    }
    // An unversioned envelope can still be in flight from a prompt issued by
    // the previous server release. Treat that one shape as legacy v1; every
    // newly advertised envelope carries an explicit version and every present
    // unsupported version is rejected.
    if (version !== undefined && version !== 1) {
      return { error: `structured question version ${String(version)} is not supported`, start, end: envelopeEnd };
    }
    return { question: value as QuestionAsk, start, end: envelopeEnd };
  } catch {
    return {
      error: 'the structured question payload was not valid JSON',
      start,
      end: end + QUESTION_FALLBACK_CLOSE.length,
    };
  }
}

/** Remove every private envelope, including malformed or unterminated ones. */
export function stripResponseQuestionEnvelopes(markdown: string): string {
  let visible = '';
  let cursor = 0;
  while (cursor < markdown.length) {
    const start = markdown.indexOf(QUESTION_FALLBACK_OPEN, cursor);
    if (start < 0) return `${visible}${markdown.slice(cursor)}`.trim();
    visible += markdown.slice(cursor, start);
    const close = markdown.indexOf(
      QUESTION_FALLBACK_CLOSE,
      start + QUESTION_FALLBACK_OPEN.length,
    );
    if (close < 0) return visible.trim();
    cursor = close + QUESTION_FALLBACK_CLOSE.length;
  }
  return visible.trim();
}

export function questionContinuation(question: string, answer: QuestionReply): string {
  if (answer.error) {
    return `[The interactive question could not be delivered: ${answer.error}. Ask the user in plain prose.]`;
  }
  if (answer.skipped || (answer.labels.length === 0 && !answer.text)) {
    return `[The user skipped this question without answering: ${question}. Continue with the most reasonable option and state the assumption.]`;
  }
  const selected = answer.labels.length > 0 ? `Selected: ${answer.labels.join(', ')}.` : '';
  const typed = answer.text ? `Their own words: ${answer.text}` : '';
  return `[The user answered the interactive question "${question}". ${selected} ${typed}]`.trim();
}

/**
 * Answers used to settle a question because its turn went away are terminal,
 * not content for a new continuation turn.
 *
 * Kept deliberately narrower than "any error": a delivery failure while the
 * runtime is still alive must still send the prose fallback below, otherwise
 * the agent remains blocked with no way to ask again. These are the three
 * reasons minted by this session when nobody can answer any more.
 */
export function cancelledFallbackAnswer(answer: QuestionReply): boolean {
  if (!answer.error) return false;
  return answer.error === 'the turn was interrupted'
    || answer.error === 'the session was stopped'
    || answer.error === 'the agent stopped waiting for an answer';
}
