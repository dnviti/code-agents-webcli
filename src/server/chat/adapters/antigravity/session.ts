import {
  ChatCapabilities,
  ChatUsage,
  ModelChoice,
} from '../../../../shared/chat-events.js';
import { installedModels } from '../../installed-models.js';
import { BaseChatAdapter } from '../../adapter.js';
import { mergeSlashCommands } from '../../../../shared/slash-commands.js';
import { effortLadder, splitEffortSuffix } from './helpers.js';
import { EFFORT_LEVELS, PRINT_TIMEOUT } from './constants.js';

/**
 * The first half of `AntigravityChatAdapter`: the session's state and the
 * picker — which models agy accepts, and at which effort. Nothing here spawns a
 * process; that is the next link's job. See the full wire walk-through on the
 * facade.
 */
export abstract class AntigravityBase extends BaseChatAdapter {
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
    // The half of the menu that is this app's own. The other half — the user's
    // skills — is added by the session from `installed-commands.ts`, which has
    // an `antigravity` entry naming the directories agy really reads.
    //
    // What is *not* here is agy's own slash menu, forty entries deep and every
    // one of them its terminal UI's: driven headlessly it interprets none of
    // them. Probed with `/agents`, which the CLI answers instantly at its own
    // prompt — in `--print` mode it went to the model instead and came back with
    // 18,441 tokens of prose *about* what subagents are. Putting that menu here
    // would be exactly the defect #71 was filed for: a command offered, picked,
    // and delivered to an agent that can only read it.
    //
    // A skill is the opposite case, which is why it is offered: agy acts on one
    // named in the prompt. `/marker-reporter` made it open the SKILL.md in
    // `.agents/skills/` and answer with the token that skill specifies.
    //
    // The three below are this app's, not any runtime's. `ChatSession`
    // intercepts them itself and never forwards them (see `isClearingCommand`),
    // so they work identically in every conversation it runs. They are listed
    // because without them a machine with no skills installed has an empty menu
    // — and an empty list does not merely show an empty menu, it takes the
    // button that opens it off the composer entirely.
    commands: mergeSlashCommands(
      [
        { name: 'clear', description: 'Start a new conversation, forgetting everything above' },
        { name: 'new', description: 'Start a new conversation — the same thing as /clear' },
        { name: 'reset', description: 'Start a new conversation — the same thing as /clear' },
      ],
      this.options.installedCommands,
    ),
  };

  protected turnCounter = 0;
  protected turnInFlight = false;
  protected turnInterrupted = false;
  protected currentTurnId: string | null = null;
  protected assistantMsgId: string | null = null;
  protected blockIndex = 0;
  protected sawResult = false;
  protected sessionAnnounced = false;

  /** agy's own id for this conversation, which is how the next turn resumes it. */
  protected conversationId: string | undefined = this.options.resumeSessionId;
  /** The model agy said it was running, never the one this app asked for. */
  protected reportedModel: string | undefined;
  /** The model the next child is launched with. Seeded from the launch option. */
  protected model: string | undefined = this.options.model;

  /** Where each open block sits, keyed by agy's own step index. */
  protected readonly textBlocks = new Map<number, number>();
  /** step index -> the tool id its card was opened under. */
  protected readonly toolIds = new Map<number, string>();
  /** The one thinking block of the message currently open, once anything thought. */
  protected thinkingBlock: number | null = null;

  /**
   * The ladder currently on offer, and the level within it.
   *
   * Both derive from the model list agy prints, so nothing here is a level this
   * app invented — see `publishEfforts`.
   */
  protected modelList: ModelChoice[] = [];
  protected effortLevels: readonly string[] = [];
  /** Only ever set when no model is pinned, which is the only case `--effort` is accepted in. */
  protected effortFlag: string | undefined;

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
    return !this.turnInFlight
      && (!this.child || this.exited)
      && !this.childNeedsVerifiedClose();
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
      cwd: this.runtimeWorkingDir,
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
  protected publishEfforts(): void {
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

  /**
   * End the turn, whatever shape its ending took.
   *
   * Implemented in the concrete leaf — the only class with access to every
   * piece of a turn — but declared here because `send()` and the exit path in
   * the next link need to close a turn they only started.
   */
  protected abstract closeTurn(
    stopReason: string,
    extra?: { usage?: ChatUsage; durationMs?: number; modelTurns?: number },
  ): void;
}
