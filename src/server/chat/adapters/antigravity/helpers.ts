import {
  EffortChoice,
  ToolKind,
  UserTurn,
  classifyTool,
  rankedEfforts,
} from '../../../../shared/chat-events.js';
import {
  EFFORT_DESCRIPTIONS,
  EFFORT_LEVELS,
  PATH_PARAMETERS,
  TOOL_KIND_OVERRIDES,
} from './constants.js';

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function effortLadder(values: readonly string[]): EffortChoice[] {
  const ordered = EFFORT_LEVELS.filter((level) => values.includes(level));
  return rankedEfforts(
    ordered.map((value) => ({ value, name: value, description: EFFORT_DESCRIPTIONS[value] })),
  );
}

/**
 * A model id split into the part that names the model and the part that names
 * how hard it thinks, when agy spells it that way.
 *
 * `agy models` prints `gemini-3.6-flash-high`, `gemini-3.6-flash-medium`,
 * `gemini-3.6-flash-low` — one id per level — beside ids that carry no level at
 * all (`claude-sonnet-4-6`). `claude-opus-4-6-thinking` deliberately does not
 * split: `thinking` is not one of the three words agy accepts as an effort, so
 * the id is left whole and that model simply publishes no ladder.
 */
export function splitEffortSuffix(model: string): { stem: string; level: string } | null {
  for (const level of EFFORT_LEVELS) {
    const suffix = `-${level}`;
    if (model.endsWith(suffix)) {
      return { stem: model.slice(0, -suffix.length), level };
    }
  }
  return null;
}

export function toolKindFor(name: string): ToolKind {
  return TOOL_KIND_OVERRIDES[name] ?? classifyTool(name);
}

export function pathsFrom(parameters: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const key of PATH_PARAMETERS) {
    const value = str(parameters[key]);
    if (value) paths.push(value);
  }
  return paths;
}

/** One line naming what the call is doing, from whichever parameter says. */
export function titleFor(name: string, parameters: Record<string, unknown>): string | undefined {
  if (name === 'run_command') return str(parameters.CommandLine);
  const [path] = pathsFrom(parameters);
  if (path) return path;
  return str(parameters.Query) || str(parameters.SearchTerm);
}

/**
 * Whether this failure is the headless auto-denial rather than a tool that
 * genuinely went wrong.
 *
 * Matched on agy's own wording, captured verbatim from a `request-review` run:
 * `User denied permission to run command:\npwd`. Nobody denied anything — there
 * was nobody to ask — and calling it a failure without saying so is exactly the
 * "unexplained failure" this runtime's approval story has to avoid.
 */
export function isAutoDenial(message: string): boolean {
  return /^User denied permission to /i.test(message.trim());
}

/**
 * What to say in the conversation when a tool was refused for want of anybody
 * to ask.
 *
 * Names what was refused and what would have allowed it, because those are the
 * two things a person needs and neither is on the card: the tool row says
 * "denied", and the reason it was denied is a property of how the session was
 * started, several screens away.
 */
export function refusalText(what: string | undefined, detail: string): string {
  const subject = what ? `\`${what}\`` : 'a tool call';
  return (
    `Antigravity refused ${subject} and carried on without it.\n\n`
    + `Driven headlessly this CLI cannot stop and ask, so anything needing approval is `
    + `denied on the spot — nobody was asked and nobody declined. To let calls like this `
    + `through, start the conversation with approvals bypassed (the "No prompts" launch, `
    + `or the approvals switch in Settings).\n\n`
    + `What it reported: ${detail}`
  );
}

/**
 * The prompt agy is actually handed: what the user typed, and where their
 * attachments are.
 *
 * agy takes one string and has no attachment channel — no flag in `--help`, and
 * no mention syntax either: `@notes.txt` in a prompt reached the model as
 * literal text and it went and opened the file with a tool of its own. That last
 * part is what makes this work rather than a fudge. Every upload this app
 * accepts is written *inside* the session's working directory
 * (`.cc-web/attachments/`), which is the directory agy is pointed at, and agy
 * reads what it is pointed at: a text file, and — verified separately, because
 * it is the case worth doubting — a PNG, whose product name and version it read
 * out of the pixels with `view_file`.
 *
 * So the paths are named in the prompt. This is the same act every other adapter
 * here performs through whatever door its runtime opens — pi appends `@path` to
 * argv, codex sends a `localImage` input item — and it is deliberately kept out
 * of the transcript: `ChatSession.deliver` has already recorded the user's own
 * words, and the attachment chips beside them are what a reader sees. What the
 * runtime receives and what the record shows differ here on purpose, the same
 * way a branch's briefing does.
 *
 * Attachments with no `path` are skipped rather than described: that field is
 * optional, and a runtime that cannot be handed a path has nothing to be told.
 */
export function withAttachments(turn: UserTurn): string {
  const paths = (turn.attachments || [])
    .map((attachment) => attachment.path)
    .filter((path): path is string => typeof path === 'string' && path.length > 0);
  if (paths.length === 0) return turn.text;

  const listed = paths.map((path) => `- ${path}`).join('\n');
  const preamble =
    paths.length === 1
      ? 'The user attached this file to the message above. It is already saved in this '
        + 'workspace — open it with your own tools when the message refers to it:'
      : `The user attached these ${paths.length} files to the message above. They are already `
        + 'saved in this workspace — open them with your own tools when the message refers to them:';
  // A blank line and a heading, so a message that is nothing but attachments
  // still reads as a request rather than as a bare list of paths.
  return `${turn.text}\n\n${preamble}\n${listed}`;
}
