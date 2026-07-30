import { spawn } from 'child_process';
import {
  ChatBlock,
  ChatCapabilities,
  ChatUsage,
  EffortChoice,
  ModelChoice,
  ToolBlock,
  ToolKind,
  UserTurn,
  classifyTool,
  rankedEfforts,
} from '../../../shared/chat-events.js';
import { installedModels } from '../installed-models.js';
import { AdapterChild, BaseChatAdapter } from '../adapter.js';

/**
 * Antigravity CLI (`agy`) driven headlessly: `--print --output-format stream-json`.
 *
 * Everything below was read off live captures against agy 1.1.8 on 2026-07-30,
 * not from a schema. The wire is line-delimited JSON with a three-value
 * envelope — `{"event":"init"|"step_update"|"result", <same name>: {…}}` — and a
 * turn looks like this end to end:
 *
 *   {"event":"init","conversation_id":"…","init":{"model":"…","cwd":"…",
 *     "tools":[…],"permission_mode":"request-review"}}
 *   {"event":"step_update","step_update":{"step_index":0,"state":"DONE","step_type":"user_input"}}
 *   {"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"agent_response",
 *     "usage":{"input_tokens":17533,"output_tokens":493,"thinking_tokens":435,
 *              "cache_read_tokens":0,"total_tokens":18026}}}
 *   {"event":"step_update","step_update":{"step_index":4,"state":"ACTIVE","step_type":"tool",
 *     "tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"cat notes.txt"}}}}
 *   {"event":"step_update","step_update":{"step_index":4,"state":"DONE","step_type":"tool",
 *     "duration_seconds":0.013,"tool_info":{…,"output":"line one\r\n…"}}}
 *   {"event":"result","result":{"conversation_id":"…","status":"SUCCESS","response":"…",
 *     "duration_seconds":11.4,"num_turns":1,"usage":{…}}}
 *
 * Four properties of that stream shape this adapter, and each is a measurement:
 *
 * 1. **One process per turn.** `--print` runs a single prompt and exits; there is
 *    no stdin channel to write a second turn into (stdin is closed, and unlike
 *    codex and pi agy does not block on an open one — but nothing reads it
 *    either). Multi-turn is `--conversation <id>`, which resumes agy's own
 *    stored conversation: a second invocation answered "what was the pwd output
 *    I asked about in my previous message?" correctly and carried on numbering
 *    its steps from where the first left off. So `start()` launches nothing and
 *    every `send()` spawns its own child — the same shape as the pi adapter.
 *
 * 2. **`text_delta` is a genuine delta.** An `agent_response` step arrives
 *    `ACTIVE` with the opening of the reply and `DONE` with the rest, and
 *    concatenating them reproduces `result.response` exactly. It is appended,
 *    never used as a replacement.
 *
 * 3. **Reasoning is counted, never shown.** Every `usage` carries
 *    `thinking_tokens` — 435, 359, 317 across one turn of gemini-3.1-pro-low —
 *    and no event anywhere carries a word of it. That is the case
 *    `ThinkingBlock.tokens` exists for, so the entry says how much was thought
 *    rather than opening onto an empty panel.
 *
 * 4. **It cannot stop and ask.** Headless, anything needing the `command`
 *    permission is refused on the spot and the run continues around it:
 *    `tool_info.error` reads `User denied permission to run command:\npwd` while
 *    stderr explains that "headless mode cannot prompt for" it. There is no
 *    approval channel to wire, so `capabilities.permissions` is false and each
 *    refusal is explained in the transcript instead — see `refusalText`.
 */

// ------------------------------------------------------------------ helpers

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * How long a single `--print` run is allowed to take.
 *
 * agy's own default is `5m0s`, which is a sensible ceiling for a scripted
 * one-shot and the wrong one for a conversation: a turn that reads a repository
 * and edits a dozen files runs past it, and the user would see the turn cut off
 * with no explanation anybody could act on. A day is effectively "no ceiling",
 * and the ceiling that matters is the one the user holds — `interrupt()` kills
 * the child, and it is offered because this runtime has nothing subtler.
 *
 * Verified to parse: `--print-timeout 24h` reached model validation, which only
 * runs after the flags are read.
 */
const PRINT_TIMEOUT = '24h';

/**
 * agy's own effort words, and the only three it will accept.
 *
 * Not transcribed from `--help` alone — confirmed by handing it a word it does
 * not have: `--effort banana` answered `invalid --effort "banana" (valid: low,
 * medium, high)`. That is agy enumerating its own vocabulary while refusing one,
 * which is the same evidence the pi adapter's ladder rests on.
 */
const EFFORT_LEVELS = ['low', 'medium', 'high'] as const;

const EFFORT_DESCRIPTIONS: Record<string, string> = {
  low: 'The least thinking agy offers.',
  medium: 'The middle of the three.',
  high: 'The most agy will spend on thinking.',
};

function effortLadder(values: readonly string[]): EffortChoice[] {
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
function splitEffortSuffix(model: string): { stem: string; level: string } | null {
  for (const level of EFFORT_LEVELS) {
    const suffix = `-${level}`;
    if (model.endsWith(suffix)) {
      return { stem: model.slice(0, -suffix.length), level };
    }
  }
  return null;
}

/**
 * agy's file-mutating tools, whose names the shared classifier reads as `other`.
 *
 * `write_to_file` and `notebook_edit` already land on `edit` through the generic
 * patterns; these three do not — "replace_file_content" contains none of the
 * words that classifier looks for. A fact about this CLI's tool vocabulary, so
 * it is stated here rather than by widening a pattern every other runtime
 * shares.
 */
const TOOL_KIND_OVERRIDES: Record<string, ToolKind> = {
  replace_file_content: 'edit',
  multi_replace_file_content: 'edit',
  sed_file: 'edit',
};

function toolKindFor(name: string): ToolKind {
  return TOOL_KIND_OVERRIDES[name] ?? classifyTool(name);
}

/**
 * The parameter each tool names its target file with, so a card can say what
 * was touched and the "files changed" affordance has something to point at.
 *
 * Only the keys observed on the wire, and only where the parameter really is a
 * path: `run_command` reports `CommandLine`, which is not one.
 */
const PATH_PARAMETERS = ['TargetFile', 'AbsolutePath', 'DirectoryPath', 'FilePath', 'Path'];

function pathsFrom(parameters: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const key of PATH_PARAMETERS) {
    const value = str(parameters[key]);
    if (value) paths.push(value);
  }
  return paths;
}

/** One line naming what the call is doing, from whichever parameter says. */
function titleFor(name: string, parameters: Record<string, unknown>): string | undefined {
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
function isAutoDenial(message: string): boolean {
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
function refusalText(what: string | undefined, detail: string): string {
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

// ------------------------------------------------------------------ adapter

export class AntigravityChatAdapter extends BaseChatAdapter {
  readonly runtime = 'antigravity';

  readonly capabilities: ChatCapabilities = {
    // `text_delta` arrives while the turn is still running, and it appends —
    // see property 2 in the class comment.
    streaming: true,
    // Counted but never shown: the entry reports its size. Property 3.
    thinking: true,
    toolCalls: true,
    // No diff anywhere on the wire. `replace_file_content` reports its
    // `TargetFile` and nothing else — no old text, no new text, no hunk — so a
    // diff shown here would be one this app had gone and computed rather than
    // one the agent reported.
    diffs: false,
    // Property 4: nothing to approve, because nothing is ever asked.
    permissions: false,
    interrupt: true,
    // `--conversation <id>`, watched resuming a conversation with its history
    // intact after the first process had exited.
    resume: true,
    // No flag resumes a conversation at an earlier point; `--conversation` picks
    // up its head.
    fork: false,
    // By path, in the prompt — see `withAttachments`. There is no attachment
    // flag and no `@file` mention syntax (probed: `@notes.txt` reached the model
    // as literal text), but this app already stores every upload *inside* the
    // session's working directory, and agy reads what it is pointed at. Watched
    // working both ways: a text file, and a PNG whose product name and version
    // it read out of the pixels with `view_file`.
    attachments: true,
    usage: true,
    // Tokens only. Nothing in `init`, `step_update` or `result` prices a turn,
    // and this app buys no price list to guess with.
    cost: false,
    // No plan or todo channel: `--mode plan` parses and changes nothing
    // observable, and no step type carries a checklist.
    plan: false,
    // Not agy's commands — this app's, and the only ones that do anything in an
    // Antigravity conversation.
    //
    // agy has a slash menu of its own, forty entries deep, and every one of them
    // belongs to its terminal UI: driven headlessly it interprets none of them.
    // Probed with `/agents`, which the CLI answers instantly at its own prompt —
    // in `--print` mode it went to the model instead and came back with 18,441
    // tokens of prose *about* what subagents are. Putting that menu here would be
    // exactly the defect #71 was filed for: a command offered, picked, and
    // delivered to an agent that can only read it.
    //
    // The three below are different. `ChatSession` intercepts them itself and
    // never forwards them (see `isClearingCommand`), so they work identically in
    // every conversation this app runs, agy's included. They are listed because
    // without them the menu is empty — and an empty list does not merely show an
    // empty menu, it takes the button that opens it off the composer entirely.
    commands: [
      { name: 'clear', description: 'Start a new conversation, forgetting everything above' },
      { name: 'new', description: 'Start a new conversation — the same thing as /clear' },
      { name: 'reset', description: 'Start a new conversation — the same thing as /clear' },
    ],
  };

  private turnCounter = 0;
  private turnInFlight = false;
  private turnInterrupted = false;
  private currentTurnId: string | null = null;
  private assistantMsgId: string | null = null;
  private blockIndex = 0;
  private sawResult = false;
  private sessionAnnounced = false;

  /** agy's own id for this conversation, which is how the next turn resumes it. */
  private conversationId: string | undefined = this.options.resumeSessionId;
  /** The model agy said it was running, never the one this app asked for. */
  private reportedModel: string | undefined;
  /** The model the next child is launched with. Seeded from the launch option. */
  private model: string | undefined = this.options.model;

  /** Where each open block sits, keyed by agy's own step index. */
  private readonly textBlocks = new Map<number, number>();
  /** step index -> the tool id its card was opened under. */
  private readonly toolIds = new Map<number, string>();
  /** The one thinking block of the message currently open, once anything thought. */
  private thinkingBlock: number | null = null;

  /**
   * The ladder currently on offer, and the level within it.
   *
   * Both derive from the model list agy prints, so nothing here is a level this
   * app invented — see `publishEfforts`.
   */
  private modelList: ModelChoice[] = [];
  private effortLevels: readonly string[] = [];
  /** Only ever set when no model is pinned, which is the only case `--effort` is accepted in. */
  private effortFlag: string | undefined;

  /** The adapter outlives every child; a turn is a process, the session is not. */
  override get alive(): boolean {
    return !this.stopped;
  }

  /**
   * The same condition `send()` throws on, asked in advance (#89).
   *
   * The turn is declared over by the `result` line, which arrives while the
   * child is still exiting.
   */
  get readyForTurn(): boolean {
    return !this.turnInFlight;
  }

  async start(): Promise<void> {
    // Nothing to launch: there is no process without a prompt. The session line
    // is still emitted so the conversation opens with a runtime that has
    // introduced itself, rather than one that says nothing until the first
    // message. No model is named — agy has not run yet, and `options.model` is a
    // request this app made rather than an observation it took.
    this.emit({
      t: 'session',
      ...(this.conversationId ? { nativeSessionId: this.conversationId } : {}),
      cwd: this.options.workingDir,
      capabilities: this.capabilities,
    });
    // Best effort and deliberately not awaited: the picker is worth having and
    // not worth holding a conversation open for. `installedModels` caches per
    // binary, so this is the same probe the session runs and costs one spawn
    // between them.
    void this.loadModels();
    this.emit({ t: 'state', state: 'idle' });
  }

  /**
   * Ask agy which models it accepts, and work out the effort ladder from them.
   *
   * The two questions have one answer here. `--effort` is refused outright
   * whenever a model is named — `--model gemini-3.6-flash-low --effort high`
   * answers "conflicts with --effort=high", and `--model claude-sonnet-4-6
   * --effort high` answers "--effort is not supported for model" — so the flag
   * is only ever usable on a session that pins no model at all. What agy offers
   * instead is the level *inside the model id*: `gemini-3.6-flash-high`,
   * `-medium` and `-low` are three entries in its own list.
   *
   * So the ladder offered is whichever of those three siblings agy actually
   * printed, and changing level swaps the id. Every level on the menu is a model
   * agy named; nothing here is inferred from a pattern that might not have an id
   * behind it.
   */
  private async loadModels(): Promise<void> {
    const models = await installedModels(this.runtime, this.options.command, this.options.env);
    if (this.stopped) return;
    this.modelList = models;
    if (models.length > 0) {
      this.capabilities.models = models;
      this.emit({ t: 'capabilities', capabilities: { models } });
    }
    this.publishEfforts();
  }

  /** The levels available for the model in force, and the one it is on. */
  private publishEfforts(): void {
    const previous = this.effortLevels;
    let current: string | null;

    if (!this.model) {
      // No model pinned, so `--effort` is accepted and all three are on offer.
      this.effortLevels = EFFORT_LEVELS;
      current = this.effortFlag ?? null;
    } else {
      const split = splitEffortSuffix(this.model);
      if (!split) {
        // agy's own words for this case: "--effort is not supported for model".
        this.effortLevels = [];
        current = null;
      } else {
        const ids = new Set(this.modelList.map((entry) => entry.value));
        // Only siblings agy actually printed. With no list yet (the probe is
        // still running, or the binary is gone) the level in force is still
        // reportable — it is written on the id — but nothing else is offered.
        this.effortLevels = EFFORT_LEVELS.filter((level) => ids.has(`${split.stem}-${level}`));
        current = split.level;
      }
    }

    const efforts = this.effortLevels.length > 1 ? effortLadder(this.effortLevels) : undefined;
    const changed =
      previous.length !== this.effortLevels.length
      || previous.some((level, index) => level !== this.effortLevels[index]);
    if (changed) {
      this.capabilities.efforts = efforts;
      this.emit({ t: 'capabilities', capabilities: { efforts } });
    }
    this.emit({ t: 'effort', effort: current });
  }

  /**
   * Move to a different level, which for a spawn-per-turn adapter is free.
   *
   * There is no live process to convince: the next `agy` is launched with the
   * new value, so setting the field *is* the change. Which field depends on how
   * agy expresses the level for the model in force (see `loadModels`) — the flag
   * when nothing is pinned, the model id when something is.
   *
   * Rejected rather than stored when agy has no such level for this model, and
   * it has to be: storing one would either put a `--effort` on the command line
   * that agy refuses outright — failing the next turn — or name a model id that
   * does not exist, while the control reported the level as live.
   */
  async setEffort(effort: string): Promise<void> {
    if (!this.effortLevels.includes(effort)) {
      throw new Error(
        this.model
          ? `antigravity: ${this.model} has no "${effort}" level to switch to`
          : `antigravity: no effort level called "${effort}"`,
      );
    }

    if (!this.model) {
      this.effortFlag = effort;
      this.emit({ t: 'effort', effort });
      return;
    }

    const split = splitEffortSuffix(this.model);
    if (!split) {
      throw new Error(`antigravity: --effort is not supported for model ${this.model}`);
    }
    this.model = `${split.stem}-${effort}`;
    this.emit({ t: 'capabilities', capabilities: { models: this.modelList } });
    this.emit({ t: 'effort', effort });
  }

  /**
   * Point the next turn at a different model.
   *
   * Same mechanics as the level above and for the same reason — the model is a
   * flag on a process that has not started yet. The ladder is republished
   * because it belongs to the model: moving from `gemini-3.6-flash-high` (three
   * levels) to `claude-sonnet-4-6` (none) has to take the control away rather
   * than leave it offering levels that model will refuse.
   */
  async setModel(model: string): Promise<void> {
    this.model = model || undefined;
    // A level asked for while nothing was pinned cannot ride along onto a model:
    // the two are mutually exclusive on the command line.
    if (this.model) this.effortFlag = undefined;
    this.publishEfforts();
  }

  protected buildArgs(): string[] {
    const args = [
      '--output-format',
      'stream-json',
      // Not optional. Without it agy runs every shell tool in
      // ~/.gemini/antigravity-cli/scratch rather than the folder this session is
      // for — measured three ways: a fresh directory, a directory agy had been
      // trusted in, and the app's own repository all answered `pwd` with the
      // scratch path, and all three answered correctly with this flag. Asked to
      // read a file that was sitting right there, the unflagged run reported no
      // such file existed. Interactive mode does not have the problem, which is
      // why the terminal bridge does not pass it.
      //
      // The project it creates is scoped to the invocation: `~/.gemini/projects.json`
      // is unchanged after a run, so this cannot accumulate entries in the
      // user's own project list. It also composes with `--conversation` —
      // a resumed conversation kept its history and still answered `pwd` with
      // the session's directory.
      '--new-project',
      '--print-timeout',
      PRINT_TIMEOUT,
    ];

    if (this.model) args.push('--model', this.model);
    // Only ever reachable with no model pinned; agy refuses the combination.
    if (!this.model && this.effortFlag) args.push('--effort', this.effortFlag);
    if (this.options.bypassPermissions) {
      // Verified: with it, `init` reports `permission_mode: "always-proceed"`
      // and a shell command runs. Without it, `request-review`, and the same
      // command is auto-denied.
      args.push('--dangerously-skip-permissions');
    }
    if (this.conversationId) args.push('--conversation', this.conversationId);
    if (this.options.extraArgs?.length) args.push(...this.options.extraArgs);
    return args;
  }

  async send(turn: UserTurn): Promise<void> {
    if (this.stopped) throw new Error('antigravity chat adapter is stopped');
    if (this.turnInFlight) throw new Error('antigravity: a turn is already running on this session');

    this.turnInFlight = true;
    this.turnInterrupted = false;
    this.sawResult = false;
    this.currentTurnId = `t${++this.turnCounter}`;
    this.assistantMsgId = null;
    this.blockIndex = 0;
    this.thinkingBlock = null;
    this.textBlocks.clear();
    this.toolIds.clear();

    // The user's own message is not written here: `ChatSession.deliver` has
    // already put it in the transcript with the turn id it minted (#129).
    this.emit({ t: 'state', state: 'thinking' });

    // `--print` last so the prompt is the final pair on the line and a long one
    // does not bury the flags in a log.
    const args = [...this.buildArgs(), '--print', withAttachments(turn)];

    return new Promise<void>((resolve, reject) => {
      const child = spawn(this.options.command, args, {
        cwd: this.options.workingDir,
        env: {
          ...process.env,
          ...(this.options.env || {}),
          NO_COLOR: '1',
          TERM: 'dumb',
          FORCE_COLOR: '0',
        },
        // Closed rather than piped: the prompt is in argv and nothing is ever
        // written here. Measured as safe — a run with stdin ignored completed in
        // 5.4s, the same as one with a terminal behind it.
        stdio: ['ignore', 'pipe', 'pipe'],
      }) as AdapterChild;

      this.child = child;
      this.exited = false;
      this.stdoutBuffer = '';
      this.stderrTail = '';

      let settled = false;
      const accept = (): void => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => this.feedStdout(chunk));

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        this.stderrTail = (this.stderrTail + chunk).slice(-4000);
      });

      // "Accepted" means the process started, which is what `send()` promises —
      // not that agy has replied.
      child.on('spawn', accept);

      child.on('error', (error: Error) => {
        this.exited = true;
        this.emit({ t: 'error', message: `antigravity: ${error.message}` });
        this.closeTurn('error');
        if (!settled) {
          settled = true;
          reject(error);
        }
      });

      child.on('exit', (code, signal) => this.onTurnExit(code, signal));
    });
  }

  async interrupt(): Promise<void> {
    if (!this.child || this.exited) return;
    // A one-shot process has no cancel message. Killing it ends this turn and
    // nothing else: the conversation lives in agy's own store, and the next
    // `send()` resumes it with `--conversation`.
    this.turnInterrupted = true;
    this.child.kill('SIGINT');
  }

  respondPermission(_requestId: string, _optionId: string): void {
    // capabilities.permissions is false: nothing is ever pending to answer.
  }

  private onTurnExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exited = true;

    if (this.stopped) {
      this.turnInFlight = false;
      this.emit({ t: 'state', state: 'exited' });
      return;
    }

    if (this.turnInterrupted) {
      this.closeTurn('interrupted');
      return;
    }

    if (this.sawResult) {
      // `result` already closed the turn; the exit that follows it is ordinary.
      this.turnInFlight = false;
      return;
    }

    const detail = this.stderrTail.trim();
    const how = signal ? `signal ${signal}` : `code ${code}`;
    this.emit({
      t: 'error',
      message: detail ? `antigravity exited (${how}): ${detail}` : `antigravity exited (${how})`,
    });
    this.closeTurn('error');
  }

  /** Mirrors the base class's line framing, which is private there. */
  private feedStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline: number;
    while ((newline = this.stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // agy prints the occasional plain-text notice on stdout; the same
        // tolerance every other adapter here applies.
        continue;
      }

      try {
        this.handleMessage(parsed);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.emit({ t: 'error', message: `antigravity adapter failed to handle a message: ${message}` });
      }
    }

    if (this.stdoutBuffer.length > 1_000_000) {
      this.stdoutBuffer = '';
      this.emit({ t: 'error', message: 'antigravity sent an oversized line; discarded the buffer' });
    }
  }

  protected handleMessage(raw: unknown): void {
    const envelope = record(raw);
    switch (str(envelope.event)) {
      case 'init':
        this.onInit(record(envelope.init), str(envelope.conversation_id));
        return;
      case 'step_update':
        this.onStep(record(envelope.step_update));
        return;
      case 'result':
        this.onResult(record(envelope.result));
        return;
      default:
        // An envelope this adapter has not seen. Dropping is correct; throwing
        // would take the turn down over a line nobody needed.
        return;
    }
  }

  private onInit(init: Record<string, unknown>, conversationId: string | undefined): void {
    if (conversationId) this.conversationId = conversationId;
    // Present only when `--model` was passed: a run with no model flag reports
    // no model at all, so this is agy confirming what it was given rather than
    // naming the default it picked.
    this.reportedModel = str(init.model) ?? this.reportedModel;

    if (this.sessionAnnounced) return;
    this.sessionAnnounced = true;
    // A second `session` line, and the one that matters: it carries the id the
    // conversation is resumed by, which is the only thing that lets this
    // conversation come back with its history after the server restarts.
    this.emit({
      t: 'session',
      ...(this.conversationId ? { nativeSessionId: this.conversationId } : {}),
      ...(this.reportedModel ? { model: this.reportedModel } : {}),
      cwd: str(init.cwd) || this.options.workingDir,
      capabilities: this.capabilities,
    });
  }

  private onStep(step: Record<string, unknown>): void {
    const index = num(step.step_index);
    if (index === undefined) return;
    const state = str(step.state) || '';
    const type = str(step.step_type) || '';

    switch (type) {
      case 'agent_response':
        this.onAgentResponse(index, step);
        return;
      case 'tool':
        this.onToolStep(index, state, step);
        return;
      case 'subagent':
        this.onSubagentStep(index, state, step);
        return;
      case 'checkpoint':
        // agy's own bookkeeping between steps. It carries a handful of tokens,
        // which `result.usage` already includes, and nothing to render.
        return;
      case 'user_input':
      case 'system_message':
      case 'unknown':
        // `user_input` is the prompt the session already wrote down;
        // `system_message` and `unknown` arrive with no payload at all — no
        // text, no tool, no usage — so there is nothing to draw for them.
        return;
      default:
        return;
    }
  }

  /** The assistant message this turn's blocks hang off, opened on first need. */
  private ensureMessage(): string {
    if (this.assistantMsgId) return this.assistantMsgId;
    this.assistantMsgId = `a_${this.currentTurnId ?? `t${this.turnCounter}`}`;
    this.emit({
      t: 'msg_start',
      id: this.assistantMsgId,
      role: 'assistant',
      turnId: this.currentTurnId ?? `t${this.turnCounter}`,
      ...(this.reportedModel ? { model: this.reportedModel } : {}),
    });
    return this.assistantMsgId;
  }

  private onAgentResponse(index: number, step: Record<string, unknown>): void {
    const usage = record(step.usage);
    const thinking = num(usage.thinking_tokens) ?? 0;
    if (thinking > 0) this.addThinking(thinking);

    const delta = str(step.text_delta);
    if (!delta) return;

    const msgId = this.ensureMessage();
    let block = this.textBlocks.get(index);
    if (block === undefined) {
      block = this.blockIndex++;
      this.textBlocks.set(index, block);
      this.emit({ t: 'block_start', msgId, index: block, block: { kind: 'text', text: '' } });
    }
    // A true append: the `ACTIVE` half and the `DONE` half of one step
    // concatenate into `result.response`. See property 2 in the class comment.
    this.emit({ t: 'block_delta', msgId, index: block, text: delta });
  }

  /**
   * Record that the model thought, and how much, since agy will not say what.
   *
   * One block per message rather than one per step: the size is the only thing
   * on offer, and half a dozen entries each reading "~318 tokens" is a worse
   * account of one turn's reasoning than a single running total. `block_delta`
   * carries `tokens` for exactly this.
   */
  private addThinking(tokens: number): void {
    const msgId = this.ensureMessage();
    if (this.thinkingBlock === null) {
      this.thinkingBlock = this.blockIndex++;
      this.emit({
        t: 'block_start',
        msgId,
        index: this.thinkingBlock,
        block: { kind: 'thinking', text: '', tokens },
      });
      return;
    }
    this.emit({ t: 'block_delta', msgId, index: this.thinkingBlock, tokens });
  }

  private onToolStep(index: number, state: string, step: Record<string, unknown>): void {
    const info = record(step.tool_info);
    const name = str(step.tool_name) || str(info.name) || 'tool';
    const parameters = record(info.parameters);
    const toolId = this.openTool(index, {
      kind: 'tool',
      toolId: '',
      name,
      ...(titleFor(name, parameters) ? { title: titleFor(name, parameters) } : {}),
      toolKind: toolKindFor(name),
      status: 'running',
      input: parameters,
      ...(pathsFrom(parameters).length ? { locations: pathsFrom(parameters) } : {}),
    });
    if (state === 'ACTIVE') {
      this.emit({ t: 'state', state: 'running' });
      return;
    }

    const durationMs = this.durationOf(step);
    const error = record(info.error);
    const message = str(error.message);

    if (state === 'ERROR' || message) {
      const detail = message || 'the tool call failed';
      const denied = isAutoDenial(detail);
      this.emit({
        t: 'tool',
        toolId,
        patch: {
          status: denied ? 'denied' : 'failed',
          error: detail,
          ...(durationMs !== undefined ? { durationMs } : {}),
        },
      });
      if (denied) {
        // The card can say "denied"; only the transcript can say by whom, and
        // the answer — nobody — is the part that needs explaining.
        this.emit({
          t: 'permission_resolved',
          requestId: toolId,
          optionId: 'reject_once',
          allowed: false,
          automatic: true,
        });
        this.emitBlock({ kind: 'error', text: refusalText(titleFor(name, parameters) || name, detail), fatal: false });
      }
      return;
    }

    this.emit({
      t: 'tool',
      toolId,
      patch: {
        status: 'completed',
        ...(str(info.output) !== undefined ? { output: str(info.output) } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
      },
    });
  }

  /**
   * Work agy handed to an agent of its own.
   *
   * `subagent_info.subagents[]` is agy's own shape, captured live:
   * `{type_name, role, initial_prompt, conversation_id, log_uri,
   * workspace_uris}`. Rendered as a tool call named `subagent` because that is
   * the name the delegation panel matches on — one vocabulary for "an agent ran
   * an agent" across every runtime, rather than a second list of tool names to
   * keep in step (see shared/agent-activity.ts).
   */
  private onSubagentStep(index: number, state: string, step: Record<string, unknown>): void {
    const info = record(step.subagent_info);
    const entries = Array.isArray(info.subagents) ? info.subagents.map(record) : [];
    const first = entries[0] ?? {};
    const role = str(first.role);
    const prompt = str(first.initial_prompt);
    const type = str(first.type_name);

    const toolId = this.openTool(index, {
      kind: 'tool',
      toolId: '',
      name: 'subagent',
      ...(role ? { title: role } : {}),
      toolKind: 'task',
      status: 'running',
      input: { subagents: entries },
      agent: {
        steps: [],
        status: 'running',
        ...(prompt ? { prompt } : {}),
        ...(type ? { subagentType: type } : {}),
      },
    });
    if (state === 'ACTIVE') {
      this.emit({ t: 'state', state: 'running' });
      return;
    }

    const durationMs = this.durationOf(step);
    const failed = state === 'ERROR';
    this.emit({
      t: 'tool',
      toolId,
      patch: {
        status: failed ? 'failed' : 'completed',
        ...(durationMs !== undefined ? { durationMs } : {}),
        agent: {
          steps: [],
          status: failed ? 'failed' : 'completed',
          ...(prompt ? { prompt } : {}),
          ...(type ? { subagentType: type } : {}),
        },
      },
    });
  }

  /**
   * Open a card for this step if it has not been opened, and answer with its id.
   *
   * agy reports a step twice — `ACTIVE` then `DONE`/`ERROR` — but a reconnect or
   * a very fast tool can leave only the second, so the block is opened from
   * whichever report arrives first and patched by id afterwards.
   */
  private openTool(index: number, block: ToolBlock): string {
    const existing = this.toolIds.get(index);
    if (existing) return existing;
    const toolId = `agy-${this.currentTurnId ?? 't0'}-s${index}`;
    this.toolIds.set(index, toolId);
    const msgId = this.ensureMessage();
    this.emit({ t: 'block_start', msgId, index: this.blockIndex++, block: { ...block, toolId } });
    return toolId;
  }

  /** A block of this turn's own, appended after whatever is already there. */
  private emitBlock(block: ChatBlock): void {
    const msgId = this.ensureMessage();
    this.emit({ t: 'block_start', msgId, index: this.blockIndex++, block });
  }

  private durationOf(step: Record<string, unknown>): number | undefined {
    const seconds = num(step.duration_seconds);
    return seconds === undefined ? undefined : Math.round(seconds * 1000);
  }

  private onResult(result: Record<string, unknown>): void {
    this.sawResult = true;
    const conversationId = str(result.conversation_id);
    if (conversationId) this.conversationId = conversationId;

    const status = str(result.status) || 'SUCCESS';
    const failure = str(result.error);
    if (status !== 'SUCCESS' || failure) {
      // agy's own sentence, verbatim: a bad model id answers "model zzz is not
      // recognized…" and goes on to list the ones it has, which is exactly what
      // somebody needs to fix it.
      const detail = failure || `antigravity reported ${status}`;
      this.emit({ t: 'error', message: `antigravity: ${detail}`, fatal: false });
      this.emitBlock({ kind: 'error', text: detail, fatal: false });
    }

    this.closeTurn(status === 'SUCCESS' && !failure ? 'completed' : 'failed', {
      usage: translateUsage(record(result.usage)),
      durationMs: this.durationOf(result),
      modelTurns: num(result.num_turns),
    });
  }

  private closeTurn(
    stopReason: string,
    extra: { usage?: ChatUsage; durationMs?: number; modelTurns?: number } = {},
  ): void {
    this.turnInFlight = false;
    if (this.assistantMsgId) {
      this.emit({ t: 'msg_end', msgId: this.assistantMsgId, stopReason });
    }
    if (this.currentTurnId) {
      this.emit({
        t: 'turn_end',
        turnId: this.currentTurnId,
        stopReason,
        ...(extra.usage ? { usage: extra.usage } : {}),
        ...(extra.durationMs !== undefined ? { durationMs: extra.durationMs } : {}),
        ...(extra.modelTurns !== undefined ? { modelTurns: extra.modelTurns } : {}),
        ...(this.reportedModel && extra.usage
          ? { models: [{ model: this.reportedModel, usage: extra.usage }] }
          : {}),
      });
    }
    this.currentTurnId = null;
    this.assistantMsgId = null;
    this.emit({ t: 'state', state: 'idle' });
  }
}

/**
 * `result.usage` -> ChatUsage.
 *
 * Per turn, not per conversation: the figures are the sum of that invocation's
 * own steps and nothing earlier. Checked line by line against a captured turn —
 * 9888 + 123 + 2075 + 2212 + 2407 input tokens across five steps, and
 * `result.usage.input_tokens` of exactly 16705 — and again across a resumed
 * conversation, whose second invocation reported only what its own steps spent.
 * That is what makes it safe to attach to `turn_end`, where usage merges
 * additively.
 *
 * `thinking_tokens` maps to `reasoningTokens` and is deliberately not added to
 * the total: agy's own `total_tokens` is `input + output`, and its
 * `output_tokens` already contains the thinking (1438 output against 1111
 * thinking on the same turn), so counting it again would inflate every figure
 * downstream.
 */
function translateUsage(usage: Record<string, unknown>): ChatUsage | undefined {
  const input = num(usage.input_tokens);
  const output = num(usage.output_tokens);
  const cacheRead = num(usage.cache_read_tokens);
  const reasoning = num(usage.thinking_tokens);
  const total = num(usage.total_tokens);
  if (
    input === undefined
    && output === undefined
    && cacheRead === undefined
    && reasoning === undefined
    && total === undefined
  ) {
    return undefined;
  }
  return {
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
    ...(total !== undefined ? { totalTokens: total } : {}),
  };
}

export default AntigravityChatAdapter;
