import type { FileDiff, ToolKind } from './core.js';
/**
 * One option offered for a pending approval.
 *
 * Mirrors ACP's shape because it is the most expressive of the four: the others
 * collapse onto it (an allow/deny pair) without losing anything.
 */
export interface PermissionOption {
  optionId: string;
  name: string;
  /** How the UI should weight the button. */
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

export interface PermissionRequest {
  requestId: string;
  /** Tool call this approval gates, when it gates one. */
  toolId?: string;
  title: string;
  toolKind: ToolKind;
  /** Command, path or arguments the user is being asked to approve. */
  input?: unknown;
  /** Populated for patch approvals, so the user reviews the actual change. */
  diffs?: FileDiff[];
  reason?: string;
  options: PermissionOption[];
  ts: number;
}

/**
 * One selectable answer to a question the model asked.
 *
 * `optionId` is minted by this app rather than taken from the model, which only
 * ever supplies a label: two options can legitimately carry the same words
 * ("Yes, and stop" / "Yes, and stop") and an id derived from the text would make
 * them the same button.
 */
export interface QuestionOption {
  optionId: string;
  label: string;
  /** The model's own gloss on what picking this means. */
  description?: string;
}

/** How a question is waiting for its answer. */
export type QuestionOrigin = 'tool' | 'structured_handoff';

/**
 * A question the model asked, waiting on a person.
 *
 * Deliberately *not* a `PermissionRequest`. An approval is the app gating the
 * agent — the options are always some arrangement of allow and deny, and the
 * answer's meaning is known before it is given. A question is the agent asking
 * the user something the app has no opinion about, the options are whatever the
 * model wrote, and the answer is content rather than a decision. Folding the two
 * together would mean either teaching the approval card to render arbitrary
 * options or teaching `isAllowOption` to answer for text it cannot interpret.
 */
export interface QuestionRequest {
  requestId: string;
  /**
   * Tool calls have a live resolver in the current process. A structured
   * handoff ended the model turn before asking and can therefore be restored
   * from the durable log after a restart. Missing is a legacy recorded event.
   */
  origin?: QuestionOrigin;
  /**
   * The tool call that asked, when it could be identified.
   *
   * Present so the card can be drawn where the question was actually asked
   * rather than in a tray at the bottom. Optional because correlation is
   * best-effort and an uncorrelated question must still be answerable — an
   * agent blocked on a question with no button anywhere is a hung session.
   */
  toolId?: string;
  question: string;
  /** A short label for the question, when the model supplied one. */
  header?: string;
  /** True when more than one option may be picked before confirming. */
  multiSelect: boolean;
  options: QuestionOption[];
  ts: number;
}

/**
 * The durable outbox entry created when a structured handoff is answered.
 *
 * It repeats the bounded, validated content needed for the internal turn so a
 * restart never has to reconstruct model input from a card that is no longer
 * pending. The matching `question_continuation` event removes it once delivery
 * has either been accepted by the runtime or deliberately abandoned.
 */
export interface QuestionContinuation {
  continuationId: string;
  /**
   * The runtime handoff has crossed its durable pre-send boundary.
   *
   * Optional for logs written before this state existed. A recovered entry in
   * this state is deliberately not sent again unless an adapter can
   * authoritatively reconcile it: the previous process may have handed it to
   * the runtime before dying.
   */
  dispatching?: true;
  request: QuestionRequest;
  answer: {
    optionIds: string[];
    labels: string[];
    text?: string;
    skipped?: boolean;
  };
}

/** The allow/deny pair used when a runtime offers no options of its own. */
export function defaultPermissionOptions(): PermissionOption[] {
  return [
    { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'allow_always', name: 'Allow for this session', kind: 'allow_always' },
    { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
  ];
}

/** Whether an option id means "let it run". Used by the bypass path too. */
export function isAllowOption(option: PermissionOption | undefined): boolean {
  return option?.kind === 'allow_once' || option?.kind === 'allow_always';
}

