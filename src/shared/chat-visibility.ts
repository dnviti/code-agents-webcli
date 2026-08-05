/**
 * Whether a step is worth a row in the conversation, and what happens to the
 * ones that are not.
 *
 * Issue #46 set the rule: a step that produced only tool activity and no
 * written reply gets no row of its own. Its work is counted on the next reply
 * that does say something, and the detail stays on the trace.
 *
 * Issue #132 is what that rule missed. It decided from the *kind* of a step's
 * blocks — a `text` block meant "this one spoke" — and never from whether
 * anything would actually appear on the screen. Oh My Pi sends a reply that is
 * a single space alongside the tool activity on almost every step, so almost
 * every step counted as having spoken and got the row #46 exists to remove: a
 * bordered strip holding a model name, a clock and a work counter, and no
 * sentence anywhere in it. In one recorded conversation, 22 of 29 rows.
 *
 * The other agents on that protocol — Kimi, Grok — send the same blank replies
 * and escaped only because they group a whole turn into one step, so the blank
 * lands in the same row as the real answer. Lucky, not safe. Claude has its own
 * trigger: a command whose arguments happen to mention the name of the question
 * tool is taken for a question the agent asked, and a question with no question
 * in it paints nothing.
 *
 * So the rule here asks the only question that matters: would this paint? It
 * lives in `shared/` because the answer has to be the same in three places —
 * the bubble deciding whether to draw itself, the list deciding which steps to
 * fold, and a test that wants to ask it of a recorded conversation without
 * bundling React.
 */

import {
  ChatBlock,
  ChatMessage,
  ToolBlock,
  askedQuestionFrom,
  looksLikeAskCall,
} from './chat-events.js';

/**
 * Whether a tool call is a question this app will actually draw a card for.
 *
 * `looksLikeAskCall` is deliberately loose — it matches a call whose arguments
 * merely mention the tool's name — because the session needs it that way: it
 * pairs an incoming question with the call that asked it while the arguments
 * are still streaming and cannot yet be parsed (#42). That looseness is right
 * there and wrong here. A `Bash` call running `grep ask_user_question` matched
 * it, was promoted out of the trace into the conversation, and then drew
 * nothing, because there is no question in it to draw.
 *
 * The tighter test is simply: is there a question in there? Note the one
 * consequence — a real ask call has no row for as long as its arguments are
 * still arriving, because the input is only parsed when the block closes. The
 * card appeared at exactly that moment before this too; only the border moves.
 */
export function drawsQuestion(block: ToolBlock): boolean {
  return looksLikeAskCall(block.name, block.input) && askedQuestionFrom(block.input) !== null;
}

/**
 * Whether this block would put anything readable on the screen.
 *
 * `thinking` is always false: reasoning lives behind its own control and on the
 * trace, and a step whose only content is thought is a silent step by #46's
 * definition. Every other kind answers for itself.
 */
export function blockDraws(block: ChatBlock): boolean {
  switch (block.kind) {
    case 'text':
      return block.text.trim().length > 0;
    case 'thinking':
      return false;
    case 'tool':
      return drawsQuestion(block);
    case 'plan':
      // An empty plan renders null. It is a plan the runtime announced and
      // never filled in, and a border around nothing is not a plan.
      return block.items.some((item) => item.text.trim().length > 0);
    case 'notice':
      return block.text.trim().length > 0;
    case 'question':
      return block.request.question.trim().length > 0;
    case 'attachment':
    case 'image':
    case 'error':
      return true;
    default:
      // A block kind added later draws by default. The failure that way round
      // is a row nobody wanted; the other way round is content nobody sees.
      return true;
  }
}

/**
 * Whether a block is worth writing down, which is not the same question as
 * whether it would be drawn.
 *
 * `blockDraws` answers "would this paint a row", so it is false for a `thinking`
 * block and for every tool call that is not a question — correctly, because
 * neither earns a step a row of its own. Asked at *record* time that answer
 * stops being a layout decision: a block refused there is not written down, so
 * it is gone from the trace and the work counter too, and no later fold can put
 * it back. The two codex adapters were asking it there, which is safe only for
 * as long as `itemToBlock` keeps failing to recognise the items in question —
 * today real `codex exec --json` sends `command_execution` where that mapper
 * reads `commandExecution`, so a shell call arrives as unmapped text and is kept
 * by accident rather than on purpose. The first person to teach the mapper
 * codex's real spelling would have silently deleted every command and diff on
 * that path.
 *
 * So the record path asks this instead, and refuses only content that is blank
 * on its own terms: the blank reply #132 was filed for, and a plan a runtime
 * announced and never filled in. Reasoning and tool calls are always written
 * down — an empty reasoning block is a real state the surface has its own words
 * for (#120), and a tool call belongs to the trace whether or not it earns a
 * row. Deciding the row is the display fold's job, and it does it from the
 * record.
 */
export function blockHasContent(block: ChatBlock): boolean {
  switch (block.kind) {
    case 'text':
    case 'notice':
      return block.text.trim().length > 0;
    case 'plan':
      return block.items.some((item) => item.text.trim().length > 0);
    case 'question':
      return block.request.question.trim().length > 0;
    default:
      return true;
  }
}

/**
 * A message drawn as a line across the conversation rather than as a turn: no
 * surface, no glyph, no controls, the full width of the column.
 *
 * Errors count as well as notices, because the conversation now writes one of
 * its own — a workflow that failed after its turn was over has nothing to be
 * appended to and gets a message to itself (#140). Given the assistant's chrome
 * it would be an avatar and a copy button around a failure nobody said, which
 * is the misattribution the compaction rule is drawn this way to avoid.
 */
export function isRule(message: ChatMessage): boolean {
  return (
    message.role === 'system'
    && message.blocks.length > 0
    && message.blocks.every((block) => block.kind === 'notice' || block.kind === 'error')
  );
}

/**
 * Whether this message gets a row of its own in the transcript.
 *
 * One carve-out, and it is load-bearing: a reply that has opened and written
 * nothing yet is the caret. Claude and pi both open an empty text block before
 * the first delta arrives, so a pure paint test would make a live answer's row
 * blink out of existence for that window and back in a moment later.
 *
 * The carve-out is deliberately narrow — every block blank text, nothing else.
 * A step that already carries thinking or tool blocks is a silent step doing
 * work, which is precisely what #46 folds away, and widening this to cover it
 * would put every Oh My Pi step's empty row back for as long as it ran.
 */
export function hasVisibleContent(message: ChatMessage): boolean {
  if (message.role === 'user') return true;
  if (message.blocks.some(blockDraws)) return true;
  return (
    Boolean(message.streaming)
    && message.blocks.every((block) => block.kind === 'text' && block.text.trim().length === 0)
  );
}

/** A row in the conversation, and the silent steps folded onto it. */
export interface FoldedRow {
  message: ChatMessage;
  /** Ids of the steps folded onto this one, oldest first. */
  carriedIds: string[];
}

/**
 * The messages that get a row, each carrying the silent steps before it.
 *
 * A step that says nothing is not drawn, and its work is handed to the next one
 * that does: that reply's counter says how much happened on the way to it, and
 * its trace opens at the start of the stretch.
 *
 * Silent steps still pending at the end of a turn are simply dropped: there is
 * no reply to hang them on, and inventing a row for them is the thing this
 * removes. Nothing is lost — the turn strip still counts them and the rail
 * still holds every event.
 */
export function foldRows(messages: ChatMessage[]): FoldedRow[] {
  const rows: FoldedRow[] = [];
  let silent: string[] = [];
  for (const message of messages) {
    if (!hasVisibleContent(message)) {
      silent.push(message.id);
      continue;
    }
    // A rule across the conversation cannot speak for the work before it: it
    // has no action row to put the counter in, so anything handed to it is
    // dropped rather than carried. The steps go on waiting for the next message
    // that can. Without this a workflow failing mid-turn took the trace entry
    // point for its own tool call off the transcript (#140).
    if (isRule(message)) {
      rows.push({ message, carriedIds: [] });
      continue;
    }
    rows.push({ message, carriedIds: silent });
    silent = [];
  }
  return rows;
}
