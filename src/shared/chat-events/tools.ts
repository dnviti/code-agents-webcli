import type { PlanDocument, ToolKind } from './core.js';
import type { QuestionOption } from './request.js';
/** The MCP server this app exposes to the runtimes it launches. */
export const ASK_MCP_SERVER = 'ccweb';

/**
 * Whether a message id is one this app minted for the user's own turn.
 *
 * `ChatSession.deliver` is the only writer of a user message, and it always
 * mints `user-<uuid>`. Everything else claiming to be the user came from a
 * runtime — the prompt handed straight back, which is what put two identical
 * bubbles in one turn for every ACP runtime and both codex modes (#129).
 *
 * A shape test rather than a list of the ids those runtimes used, because the
 * question is "did this app write it", and the answer for anything this app did
 * not write is no, whatever the runtime chose to call it.
 */
export function isSessionMintedMessageId(id: string): boolean {
  return /^user-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/** Put a multiple-choice question to the user, and wait for the answer. */
export const ASK_QUESTION_TOOL = 'ask_user_question';

/** Private structured-response markers used only when a runtime has no tool hook. */
export const QUESTION_FALLBACK_OPEN = '<ccweb-question>';
export const QUESTION_FALLBACK_CLOSE = '</ccweb-question>';

/**
 * Remove the private no-MCP wire envelope from anything a person can read,
 * copy, export or search. An incomplete envelope is hidden while streaming so
 * its protocol JSON never flashes before the durable QuestionCard replaces it.
 */
export function withoutQuestionFallbackEnvelope(text: string): string {
  let cursor = 0;
  let cleaned = '';
  let removed = false;
  const appendVisible = (segment: string): void => {
    // An envelope normally occupies its own line. Removing it leaves the
    // newline before and after adjacent, which would invent a blank paragraph
    // between prose that was one line apart. Collapse only that one boundary.
    if (cleaned.endsWith('\n') && segment.startsWith('\r\n')) {
      cleaned += segment.slice(2);
    } else if (cleaned.endsWith('\n') && segment.startsWith('\n')) {
      cleaned += segment.slice(1);
    } else {
      cleaned += segment;
    }
  };
  // Each pass advances beyond a complete closing marker, so this is bounded by
  // the input length without putting model-authored JSON through a regexp.
  while (cursor < text.length) {
    const start = text.indexOf(QUESTION_FALLBACK_OPEN, cursor);
    if (start < 0) {
      appendVisible(text.slice(cursor));
      break;
    }
    removed = true;
    appendVisible(text.slice(cursor, start));
    const end = text.indexOf(
      QUESTION_FALLBACK_CLOSE,
      start + QUESTION_FALLBACK_OPEN.length,
    );
    // Hide an incomplete trailing envelope immediately while it streams.
    if (end < 0) return cleaned.trimEnd();
    cursor = end + QUESTION_FALLBACK_CLOSE.length;
  }
  return removed ? cleaned.trim() : text;
}

/** Submit the complete latest Plan-mode document to the Web client. */
export const SUBMIT_PLAN_TOOL = 'submit_plan';

/** What the submission tool is called after Claude-style MCP namespacing. */
export const SUBMIT_PLAN_TOOL_NAME = `mcp__${ASK_MCP_SERVER}__${SUBMIT_PLAN_TOOL}`;

/** Largest plan accepted by the durable store. */
export const MAX_PLAN_TEXT = 200_000;

export const SUBMIT_PLAN_TOOL_DESCRIPTION =
  'Submit your complete implementation plan as markdown for the user to review. In Plan mode, '
  + 'do this before making changes. Submit the complete revised document again whenever the plan '
  + 'changes; the newest numbered revision replaces the previous one.';

/** Instruction prepended only to the runtime copy of a Plan-mode user turn. */
export function planModeDirective(hasPlan: boolean): string {
  const revision = hasPlan
    ? 'A plan already exists; submit the complete revised plan again if this turn changes it.'
    : 'No plan has been submitted yet; do not finish this planning turn without submitting one.';
  return [
    '[Plan mode is active because the user selected it in the Web interface.]',
    'Plan the work without implementing it. Do not edit files or run commands that change state.',
    `Submit the complete plan as markdown with the ${SUBMIT_PLAN_TOOL} tool.`,
    revision,
  ].join(' ');
}

/** Internal turn sent after the user accepts the latest plan. */
export function acceptedPlanDirective(plan: PlanDocument): string {
  return [
    `[The user accepted Plan revision ${plan.revision}. Plan mode is now off.]`,
    'Implement the accepted plan now. Follow the normal permission and approval policy for every action.',
    'The accepted plan follows:',
    plan.markdown,
  ].join('\n\n');
}

/**
 * Ask to answer from the next model up the profile's capability ladder.
 *
 * Offered only to a session that is actually running on a rung — a runtime with
 * no ladder never sees it, because a tool whose only possible answer is "there
 * is nothing to escalate to" costs a round trip and reads to the model as the
 * user having said no.
 */
export const TIER_TOOL = 'request_model_tier';

/** What the ladder tool is called once a runtime has namespaced it. */
export const TIER_TOOL_NAME = `mcp__${ASK_MCP_SERVER}__${TIER_TOOL}`;

/**
 * What the tool is called once a runtime has namespaced it.
 *
 * Claude prefixes MCP tools as `mcp__<server>__<tool>`, and that prefixed name
 * is what shows up in the transcript — so this is the string the UI matches on
 * to draw a question card instead of a generic tool row.
 */
export const ASK_QUESTION_TOOL_NAME = `mcp__${ASK_MCP_SERVER}__${ASK_QUESTION_TOOL}`;

/**
 * Whether a tool name refers to this app's question tool.
 *
 * Suffix rather than equality: runtimes namespace MCP tools differently (and
 * have changed the separator before), so the bare name is the part that can be
 * relied on. Nothing else in the transcript is called this.
 */
/**
 * Turn whatever a model passed as `options` into answerable choices.
 *
 * Shared rather than implemented on each side, and that is the whole point: the
 * server mints the ids it will later be answered with, and the browser mints the
 * same ids again when it rebuilds a card from the tool call in a replayed
 * transcript. Two copies of this that drifted by one dropped entry would put the
 * tick on the wrong option, which is a lie about what the user chose.
 *
 * Ids are positional rather than derived from the labels: two options may
 * legitimately read the same, and a label-derived id would collapse them into
 * one button that answers for both. Anything unusable is dropped instead of
 * rendered as an empty choice, and a bare string is accepted as its own label
 * because that is what a model reaches for when the schema slips its mind.
 */
export function normalizeQuestionOptions(raw: unknown): QuestionOption[] {
  if (!Array.isArray(raw)) return [];
  const options: QuestionOption[] = [];
  for (const entry of raw) {
    let label = '';
    let description: string | undefined;
    if (typeof entry === 'string') {
      label = entry.trim();
    } else if (entry && typeof entry === 'object') {
      const object = entry as Record<string, unknown>;
      const text = object.label ?? object.name ?? object.value ?? object.title;
      if (typeof text === 'string') label = text.trim();
      if (typeof object.description === 'string' && object.description.trim()) {
        description = object.description.trim();
      }
    }
    if (!label) continue;
    options.push({ optionId: `opt-${options.length}`, label, description });
  }
  return options;
}

/**
 * The card's own invitation to answer in free text.
 *
 * Wording matters more than it looks: this is the row a model reaches for on
 * its own — it is what Claude writes as a final option, verbatim — so using the
 * same sentence means a question that arrives with one folds into this row
 * without the card appearing to offer the same thing twice.
 */
export const OWN_WORDS_LABEL = 'Let me explain in my own words';

/**
 * How much free text one answer may carry.
 *
 * The field is an explanation, not a message, and everything typed into it is
 * written to the conversation log and handed to the model as a tool result. A
 * ceiling well above any real answer keeps a hand-crafted socket frame from
 * being an unbounded write.
 */
export const MAX_QUESTION_ANSWER_TEXT = 4000;

/**
 * Options a model writes when it means "or tell me something else".
 *
 * Matched rather than merely tolerated because picking one of these sends the
 * model its own words back — "The user selected: 'Let me explain in my own
 * words'" — which answers nothing and costs a round trip. The card turns such
 * an option into the free-text row instead, so the click leads somewhere.
 *
 * Deliberately a short table of observed phrasings plus the one substring that
 * is never anything else. Anything looser risks folding away a real choice, and
 * the cost of missing one is only that the card's own row appears below it.
 */
const OWN_WORDS_LABELS = new Set([
  'other',
  'other please specify',
  'other specify',
  'something else',
  'none of these',
  'none of these fit',
  'none of these are right',
  'none of the above',
  'let me explain',
  'let me explain myself',
  'let me describe it',
  'i ll explain',
  'i ll explain myself',
  'write my own',
  'write my own answer',
  'type my own',
  'type my own answer',
]);

/**
 * Whether an option is an invitation to type rather than a choice to make.
 *
 * Punctuation and case are stripped first because the same option arrives as
 * "Other…", "other (please specify)" and "Let me explain in my own words." from
 * one model to the next.
 */
export function isOwnWordsOption(label: string): boolean {
  const normalized = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!normalized) return false;
  return normalized.includes('own words') || OWN_WORDS_LABELS.has(normalized);
}

/**
 * Split an option list into the real choices and the model's own free-text row.
 *
 * Every match folds into the one row — a model that offers both "None of these"
 * and "Let me explain in my own words" is offering the same thing twice — and
 * the last of them names it, because that is the one a model writes after it
 * has run out of real answers and so is the most explicit.
 *
 * Returns the list untouched when *every* option looks like an invitation to
 * type: a card with nothing on it but a textarea is not the question the model
 * asked, and the guard costs one comparison.
 */
export function splitOwnWordsOption(options: QuestionOption[]): {
  choices: QuestionOption[];
  invitation?: QuestionOption;
} {
  const choices = options.filter((option) => !isOwnWordsOption(option.label));
  if (choices.length === options.length || choices.length === 0) return { choices: options };
  const inviting = options.filter((option) => isOwnWordsOption(option.label));
  return { choices, invitation: inviting[inviting.length - 1] };
}

export function isAskQuestionTool(name: string | undefined): boolean {
  if (!name) return false;
  // Suffix match on the separators runtimes put between a server and its tool.
  // Codex uses `ccweb.ask_user_question`; Claude namespaces MCP tools as
  // `mcp__<server>__<tool>`; omp reports the same tool as
  // `mcp__ccweb_ask_user_question`, with one underscore. Both were observed —
  // an exact-name table would have silently failed for one of them.
  return name === ASK_QUESTION_TOOL || /(^|[._:/])ask_user_question$/.test(name);
}

/**
 * Whether a tool block is this app's question tool, however the runtime named it.
 *
 * The name alone is not enough. ACP has no separate tool-name field at all: the
 * adapter uses the agent's own title for the block ("Asking tabs vs spaces
 * preference"), and the real tool name turns up inside the arguments instead
 * (omp puts it in `rawInput.path`). So the arguments are consulted too.
 */
export function looksLikeAskCall(name: string | undefined, input: unknown): boolean {
  if (isAskQuestionTool(name)) return true;
  if (input === undefined || input === null) return false;
  try {
    return JSON.stringify(input).includes(ASK_QUESTION_TOOL);
  } catch {
    return false;
  }
}

/** A question as it can be read back out of the call that asked it. */
export interface AskedQuestion {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: QuestionOption[];
}

/**
 * Read a question back out of a tool call's arguments.
 *
 * Shared between the session — which pairs an incoming question with the call
 * that asked it — and the browser, which rebuilds the card from a replayed
 * transcript. Two implementations that disagreed about which options survive
 * would put the tick on an option the user did not choose.
 *
 * Two shapes are accepted because two were observed: the arguments themselves,
 * and an envelope carrying them as a JSON string (omp reports the call as
 * `{ path: 'xd://mcp__ccweb_ask_user_question', content: '{...}' }`). Tolerant
 * by contract — `input` is `unknown` everywhere else in this file for good
 * reason, and a malformed call should render as nothing rather than throw.
 */
export function askedQuestionFrom(input: unknown): AskedQuestion | null {
  const object = asRecord(input);
  if (!object) return null;

  const direct = readQuestion(object);
  if (direct) return direct;

  // An envelope. `content` is the field omp uses; the others cost nothing to
  // accept and save a second round of probing if another agent picks one.
  for (const key of ['content', 'arguments', 'input', 'params']) {
    const inner = object[key];
    if (typeof inner === 'string') {
      try {
        const parsed = readQuestion(asRecord(JSON.parse(inner)));
        if (parsed) return parsed;
      } catch {
        // Not JSON, so not a question. Keep looking.
      }
    } else if (inner && typeof inner === 'object') {
      const parsed = readQuestion(asRecord(inner));
      if (parsed) return parsed;
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readQuestion(object: Record<string, unknown> | undefined): AskedQuestion | null {
  if (!object) return null;
  const question = typeof object.question === 'string' ? object.question.trim() : '';
  if (!question) return null;
  const options = normalizeQuestionOptions(object.options);
  if (options.length === 0) return null;
  return {
    question,
    header:
      typeof object.header === 'string' && object.header.trim() ? object.header.trim() : undefined,
    multiSelect: object.multiSelect === true,
    options,
  };
}

/**
 * Tool-name → kind mapping shared by every adapter.
 *
 * Substring matching on a lowercased name, because the four protocols spell the
 * same operation a dozen ways and an exact-match table would need editing every
 * time a CLI renames a tool. Order matters: the first hit wins, so the more
 * specific prefixes are listed before the generic ones.
 */
const TOOL_KIND_PATTERNS: Array<[RegExp, ToolKind]> = [
  [/todo|task_?list|plan/, 'todo'],
  [/multi_?edit|edit|write|patch|apply|create_?file/, 'edit'],
  [/delete|remove|rm\b/, 'delete'],
  [/move|rename/, 'move'],
  [/grep|glob|search|find|list_?dir|ls\b/, 'search'],
  [/bash|shell|exec|command|terminal|run\b/, 'execute'],
  [/fetch|http|web|url|browser/, 'fetch'],
  [/think|reason/, 'think'],
  [/agent|task|subagent|dispatch/, 'task'],
  [/read|cat|view|open/, 'read'],
];

/** Best-effort category for a runtime's tool name. Never throws, never guesses wildly. */
export function classifyTool(name: string): ToolKind {
  const lowered = String(name || '').toLowerCase();
  for (const [pattern, kind] of TOOL_KIND_PATTERNS) {
    if (pattern.test(lowered)) {
      return kind;
    }
  }
  return 'other';
}

