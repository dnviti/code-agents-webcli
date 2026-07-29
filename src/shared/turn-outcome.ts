/**
 * How a turn ended, from the word the runtime used to end it.
 *
 * A turn's badge is a verdict on the turn, not on the steps inside it. A search
 * that found nothing, a test run that reported failures, a command that came
 * back non-zero: those are what a coding agent's work is made of, and none of
 * them says the turn failed. What does say it is the runtime's own `stopReason`
 * on `turn_end` — the one place any of them states how the thing concluded.
 *
 * Every runtime has its own vocabulary for that, so this is the table. Taken
 * from the captures under `test/fixtures/chat` and from each adapter's own
 * turn-closing paths:
 *
 *   claude  `stop_reason` (`end_turn`, `tool_use`, `max_tokens`, `refusal`) or,
 *           when there is none, the result `subtype` (`success`,
 *           `error_max_turns`, `error_during_execution`)
 *   grok    `stop` / `toolUse` off its `end` line; `error`,
 *           `max_turns_reached` and `exited` from its own close paths
 *   acp     `end_turn`, `EndTurn` (opencode capitalises), `refusal`,
 *           `cancelled`, `max_turn_requests`; `error` when the request rejects
 *   codex   the turn's own status, `completed` or `failed`; `exited` / `error`
 *           when the process goes first
 *   pi      `interrupted` and `error` — a normal completion carries *no* reason
 *
 * Which is why absent reads as `done` rather than as unknown: pi's happy path
 * is an absent reason, and so is every runtime added later that ends a turn
 * plainly. An unrecognised word reads as `done` too. Both are deliberate — the
 * badge is only useful if red is rare and means something, and a new vocabulary
 * word is not evidence that anything went wrong.
 */

/**
 * The outcomes a *finished* turn can have.
 *
 * `running` and `waiting` are states of a turn still in flight, decided by the
 * session rather than by how it ended, so they live in `TurnStatus` and not
 * here.
 */
export type TurnOutcome = 'done' | 'failed';

/**
 * Stop reasons that mean the turn itself did not complete.
 *
 * Compared case-insensitively, because the same protocol is spelled
 * `end_turn` by one CLI and `EndTurn` by another.
 *
 * Deliberately not here:
 *
 *   `interrupted` / `cancelled`  the user stopped it; nothing went wrong, and
 *                                painting their own decision red is a milder
 *                                version of the complaint this exists to fix
 *   `refusal`                    the agent answered, and the answer is that it
 *                                would not do the thing. Calling that a failed
 *                                turn means reading what an answer *meant*,
 *                                which a badge cannot do honestly
 *   `max_tokens`                 the answer is truncated, not missing
 */
const FAILURE_REASONS = new Set([
  'error',
  'failed',
  'exited',
  'error_during_execution',
  'error_max_turns',
  'max_turns_reached',
  'max_turn_requests',
]);

/** How a turn that has ended should read, given the reason it ended with. */
export function turnOutcomeOf(stopReason: string | undefined): TurnOutcome {
  if (!stopReason) return 'done';
  return FAILURE_REASONS.has(stopReason.trim().toLowerCase()) ? 'failed' : 'done';
}
