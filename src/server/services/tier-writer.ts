import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TIER_TOOL } from '../../shared/chat-events.js';
import { MODEL_TIERS, ModelTier, RuntimeProfile } from '../../shared/runtime-profiles.js';

/**
 * Write-through for capability tiers.
 *
 * Tiers are an abstraction this app owns; every runtime expresses them
 * differently, so each supported one gets a writer that renders the same four
 * strings into that CLI's native format. Runtimes with no delegation concept
 * simply have no writer, and the Settings UI says so rather than silently
 * accepting values that go nowhere.
 *
 * ## The profile wins (#171)
 *
 * This used to refuse to touch a file it had not written: a config without the
 * marker line below belonged to the user, and the tier was reported as not
 * applied. That rule is reversed. The profile is now the single source of truth
 * for the runtimes it covers, because the alternative — a ladder that decides
 * which model answers every turn, silently doing nothing because of a file
 * somebody left in a home directory a year ago — is a worse failure than an
 * overwrite. The file is replaced and the replacement is reported.
 *
 * A `.bak` is written once beside the first file replaced, so what was there is
 * still on disk. It is not a restore path — nothing in the app reads it back —
 * and it is never refreshed, because a second overwrite would replace the
 * user's original with our own generated file and leave them nothing.
 *
 * One rule survives intact: nothing is ever deleted. Switching profiles rewrites
 * our files; it does not clean up, because "clean up" and "delete the user's
 * agent" are the same operation from the filesystem's point of view.
 */
export const MANAGED_MARKER = 'managed-by: code-agents-webcli';

export interface TierWriteResult {
  /** Files written or rewritten. */
  written: string[];
  /**
   * Files that were the user's and were replaced anyway, with what happened to
   * the original. Reported rather than silent: this is the one operation here
   * that destroys something.
   */
  replaced: { file: string; reason: string }[];
  /** Extra CLI arguments the runtime needs in order to pick the config up. */
  args: string[];
  /** Set when the runtime has no tier concept at all. */
  unsupported?: boolean;
  /**
   * Set when nothing was written because the destination is only known once a
   * session starts. Carries the sentence to show instead of an empty report.
   */
  deferred?: string;
  /**
   * Set when the write-through failed outright — a read-only directory, a full
   * disk. Carries the sentence a launch shows while starting anyway.
   */
  failed?: string;
}

export interface TierWriterContext {
  /** Where generated, app-owned config files live. */
  generatedDir: string;
  homeDir: string;
  /**
   * The session's working directory, when one is known.
   *
   * Absent while previewing a save from Settings, where no session exists yet.
   * A writer that can only place its files per-session says so instead of
   * writing (see `deferred`).
   */
  workingDir?: string;
}

type Writer = (
  tiers: Partial<Record<ModelTier, string>>,
  profile: RuntimeProfile,
  ctx: TierWriterContext,
) => TierWriteResult;

/** Reasoning effort per tier. Cheap tiers think less; that is most of the saving. */
const TIER_EFFORT: Record<ModelTier, string> = {
  floor: 'low',
  mid: 'medium',
  high: 'high',
  top: 'max',
};

const TIER_DESCRIPTION: Record<ModelTier, string> = {
  floor:
    'Floor tier - high-volume, low-judgment, read-only work: codebase mapping, ' +
    'large searches, scanning verbose output, summarizing noisy results.',
  mid:
    'Mid tier - the standard coding model: standard implementation, most ' +
    'refactors, test writing, straightforward debugging.',
  high:
    'High tier - a strong reasoning model: tricky debugging, security-sensitive ' +
    'logic, cross-cutting implementation, adversarial review.',
  top:
    'Top tier - the most capable model, for the hardest work only: ambiguous ' +
    'architecture, high-stakes design, review of critical logic.',
};

/** Read-only tiers get a restricted toolset; the mid tier needs to edit. */
const TIER_TOOLS: Partial<Record<ModelTier, string>> = {
  floor: 'read, bash',
  top: 'read, bash',
};

function isManaged(file: string): boolean {
  try {
    return fs.readFileSync(file, 'utf8').includes(MANAGED_MARKER);
  } catch {
    return false;
  }
}

/**
 * Write the tier, replacing whatever is there.
 *
 * A file we did not write is copied to `<file>.bak` first — once, ever. `wx`
 * is what makes it once: after the first replacement the backup holds the
 * user's original, and a second pass must not overwrite that with the generated
 * file it is about to replace.
 */
function writeManaged(file: string, contents: string, result: TierWriteResult): void {
  if (fs.existsSync(file) && !isManaged(file)) {
    let reason = 'the profile is the source of truth now, so yours was replaced';
    try {
      const backup = `${file}.bak`;
      fs.writeFileSync(backup, fs.readFileSync(file), { flag: 'wx' });
      reason = `the profile is the source of truth now; yours was copied to ${path.basename(backup)}`;
    } catch (error) {
      // EEXIST means the original is already saved from an earlier pass, which
      // is the good case. Anything else loses the copy but must not stop the
      // ladder from being applied — the overwrite is the behaviour that was
      // asked for, and the backup is the courtesy on top of it.
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        // A `.bak` already there is from an *earlier* replacement, or is the
        // user's own file. Either way it is not a copy of what is being
        // replaced now, and saying it was would be the one claim here that
        // could cost somebody work: they would read "your original is safe"
        // over a file that had just been destroyed without one.
        reason =
          'the profile is the source of truth now, so yours was replaced — the .bak beside it is '
          + 'older and is not a copy of what was just replaced';
      }
    }
    result.replaced.push({ file, reason });
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, 'utf8');
  result.written.push(file);
}

/**
 * Marks the generated agent directory as build output, so a project the app
 * writes into does not grow untracked files in `git status`. Written with `wx`,
 * so a `.gitignore` the user put there first is never touched.
 */
const AGENTS_GITIGNORE = [
  '# Written by code-agents-webcli: capability-tier agents for this session.',
  '# Regenerated on every launch; nothing here is yours to keep.',
  '*',
  '',
].join('\n');

function ensureIgnored(dir: string): void {
  try {
    fs.writeFileSync(path.join(dir, '.gitignore'), AGENTS_GITIGNORE, { flag: 'wx' });
  } catch (error) {
    // EEXIST is the normal case after the first launch. Anything else is worth
    // knowing about, but never worth failing a session start over.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      console.warn('Could not mark the generated agents directory as ignored:', error);
    }
  }
}

/**
 * The first component of `dest` under `anchor` that is a symlink, or null.
 *
 * Grok and pi write into directories a repository controls (`.grok/roles/`,
 * `.pi/agents/`). Every fs call that follows symlinks turns a checked-in link
 * into a write to an arbitrary path under the server account, so the
 * destination is walked component by component with `lstat` — which never
 * follows — before anything is created. A symlink anywhere in the path,
 * including the final file, rejects the write.
 */
function symlinkViolation(anchor: string, dest: string): string | null {
  const relative = path.relative(anchor, dest);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  let current = anchor;
  for (const part of relative.split(/[\\/]+/)) {
    if (!part) continue;
    current = path.join(current, part);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      // The component does not exist yet: nothing to follow, and nothing
      // below it can exist either.
      break;
    }
    if (stat.isSymbolicLink()) return current;
  }
  return null;
}

/**
 * Refuse the write-through when `dest` passes through a symlink, explaining
 * why on `result.failed`. Returns true when the caller must abort.
 */
function rejectSymlinkedDestination(anchor: string, dest: string, result: TierWriteResult): boolean {
  const violation = symlinkViolation(anchor, dest);
  if (!violation) return false;
  result.failed =
    `Not applied: ${violation} is a symlink, and writing through it could ` +
    'overwrite a file the repository does not own. Remove the symlink and re-apply.';
  return true;
}

/**
 * pi's half of the escalation channel, as a pi extension.
 *
 * Every other laddered runtime is handed the tool as an MCP server. pi cannot
 * take one — its dist tree has no MCP implementation whatsoever — but it does
 * take extensions that register tools the model can call, which is the same
 * capability by a different road. Verified against pi 0.60.x: `pi -e <file>`
 * with a `pi.registerTool` call puts the tool in front of the model, the model
 * calls it, and the result comes back as an ordinary tool result.
 *
 * Written as source rather than assembled from the session's values because it
 * reads everything it needs from the environment at call time — which is what
 * lets one static file serve every session, and lets a *terminal* launch load
 * the same file harmlessly: with no socket in the environment there is nothing
 * to register, so the tool never appears.
 *
 * `node:net` and the JSON line frame are the same client the MCP server uses;
 * kept separate rather than shared because this file is read by pi's own
 * TypeScript loader in pi's process, and importing anything of this app's into
 * it would drag the app's module graph into the agent.
 */
const PI_TIER_EXTENSION = `// ${MANAGED_MARKER}
// Generated. Registers the capability-ladder escalation tool for this session.
import { Type } from "typebox";
import * as net from "node:net";

const SOCKET = process.env.CCWEB_ASK_SOCKET;
const ENABLED = process.env.CCWEB_TIER_LADDER === "1";

function requestTier(reason: string): Promise<{ detail: string }> {
  return new Promise((resolve) => {
    const socket = net.createConnection(SOCKET as string);
    const id = "tier-" + process.pid + "-" + Date.now();
    let buffer = "";
    const done = (detail: string) => {
      socket.destroy();
      resolve({ detail });
    };
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(JSON.stringify({ id, kind: "tier", tier: { reason } }) + "\\n");
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let at: number;
      while ((at = buffer.indexOf("\\n")) !== -1) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (!line) continue;
        try {
          const reply = JSON.parse(line);
          if (reply.id === id) {
            done(typeof reply.detail === "string" ? reply.detail : "no answer was given");
            return;
          }
        } catch {
          // Not ours, or not JSON. The socket is shared.
        }
      }
    });
    socket.on("error", () => done("the request could not reach the app"));
    socket.on("close", () => done("the conversation ended before this was decided"));
  });
}

export default function (pi: any) {
  if (!SOCKET || !ENABLED) return;
  pi.registerTool({
    name: "${TIER_TOOL}",
    label: "Move up a rung",
    description:
      "Ask to answer this task from the next model up your capability ladder, and wait for " +
      "the user to approve. Use it only when the work in front of you is genuinely beyond the " +
      "model you are on - subtle debugging, ambiguous architecture, security-sensitive logic, " +
      "review of code that matters - and not for work that is merely long or tedious. The " +
      "stronger model costs the user real money, they are asked before it is used, and the " +
      "conversation returns to its usual rung once this turn ends. This call blocks until they " +
      "decide. If it is refused, carry on with the model you have rather than asking again.",
    parameters: Type.Object({
      reason: Type.String({
        description:
          "One sentence on what makes this task too hard for the model you are on. The user " +
          "reads this and nothing else before deciding, so name the specific difficulty.",
      }),
    }),
    async execute(_toolCallId: string, params: { reason: string }) {
      const decision = await requestTier(params.reason);
      return { content: [{ type: "text", text: decision.detail }], details: {} };
    },
  });
}
`;

/**
 * omp's model roles, in the order its own settings surface shows them.
 *
 * Each role names a job rather than a size; the rungs are the preference order
 * the ladder answers with. The first rung with a model wins, so a blank rung
 * falls back to a neighbour instead of leaving the role empty. `vision` reads
 * images: if the floor model cannot see them, the multimodal model belongs on
 * `mid`.
 */
const OMP_ROLES: ReadonlyArray<readonly [string, readonly ModelTier[]]> = [
  ['default', ['mid', 'high']],
  ['smol', ['floor', 'mid']],
  ['slow', ['high', 'top']],
  ['vision', ['floor', 'mid']],
  ['plan', ['top', 'high']],
  ['designer', ['mid', 'high']],
  ['commit', ['floor', 'mid']],
  ['tiny', ['floor', 'mid']],
  ['task', ['mid', 'high']],
  ['advisor', ['top', 'high']],
];

/**
 * pi.
 *
 * Written into the *session's* `.pi/agents/`, not `~/.pi/agent/agents/`.
 *
 * pi resolves subagents from four directories and lets later ones win on name
 * conflicts: `~/.claude/agents`, then `~/.pi/agent/agents`, then the nearest
 * project `.claude/agents`, then the nearest project `.pi/agents` — which is
 * therefore the one place this app can define `floor`/`mid`/`high`/`top`
 * without touching anything of the user's. (Verified against pi-code's
 * `subagent/agents.ts`; the project search stops at the repository root.)
 *
 * That location still matters after #171 made the profile win. What is replaced
 * is a project-local `.pi/agents/<tier>.md`; a hand-written ladder in
 * `~/.pi/agent/agents` stays byte-for-byte intact and keeps applying to every pi
 * session run outside this app, and agents the app does *not* define — a
 * `planner`, a `reviewer` — still load from there and remain available inside
 * it. Writing to the home directory instead, as this once did, would have made
 * the reversal "your whole ladder or ours".
 *
 * The model is written provider-qualified only if the user qualified it: pi
 * resolves a bare "vendor/model" by treating the part before the slash as a
 * provider name, but which prefix is correct depends entirely on how that
 * install is authenticated, so guessing would be worse than passing it through.
 */
const writePiTiers: Writer = (tiers, profile, ctx) => {
  const result: TierWriteResult = { written: [], replaced: [], args: [] };

  if (!ctx.workingDir) {
    // Saving from Settings: there is no session yet, so there is no directory
    // to write into. Say when it will happen rather than reporting nothing.
    result.deferred =
      'Applied per session: the tier agents are written into each session’s ' +
      'working directory when it starts, where they override the global ones by ' +
      'name. Nothing in ~/.pi/agent/agents is touched.';
    return result;
  }

  const dir = path.join(ctx.workingDir, '.pi', 'agents');
  if (rejectSymlinkedDestination(ctx.workingDir, dir, result)) return result;
  fs.mkdirSync(dir, { recursive: true });
  ensureIgnored(dir);

  for (const tier of MODEL_TIERS) {
    const model = tiers[tier];
    if (!model) continue;
    const file = path.join(dir, `${tier}.md`);
    if (rejectSymlinkedDestination(ctx.workingDir, file, result)) return result;

    const tools = TIER_TOOLS[tier];
    const frontmatter = [
      '---',
      `name: ${tier}`,
      // Quoted: descriptions contain colons, and an unquoted colon breaks the
      // YAML parse, which makes the agent vanish with no error at all.
      `description: ${JSON.stringify(TIER_DESCRIPTION[tier])}`,
      ...(tools ? [`tools: ${tools}`] : []),
      `model: ${model}`,
      `effort: ${TIER_EFFORT[tier]}`,
      `# ${MANAGED_MARKER} (profile: ${profile.name})`,
      '---',
      '',
      TIER_DESCRIPTION[tier],
      '',
      ...(tools
        ? [
            'You are read-only: use bash for inspection only - searching, reading, and git history; never edit, write, install, or commit.',
            '',
          ]
        : []),
      'Report what you found or changed, with concrete file:line references.',
      '',
    ].join('\n');

    writeManaged(file, frontmatter, result);
  }

  // And the one thing pi cannot be handed any other way. pi has no MCP support
  // at all — the whole of its dist tree has zero references to `mcpServers` or
  // the protocol — so the escalation tool every other laddered runtime receives
  // as an MCP server has to arrive as a pi extension instead. Same socket, same
  // frame, same session on the other end.
  const extensionDir = path.join(ctx.workingDir, '.pi', 'ccweb');
  if (rejectSymlinkedDestination(ctx.workingDir, extensionDir, result)) return result;
  fs.mkdirSync(extensionDir, { recursive: true });
  ensureIgnored(extensionDir);
  const extension = path.join(extensionDir, 'tier-ladder.ts');
  if (rejectSymlinkedDestination(ctx.workingDir, extension, result)) return result;
  writeManaged(extension, PI_TIER_EXTENSION, result);
  if (result.written.includes(extension)) {
    // Relative, deliberately: an absolute host path is not the path this file
    // has inside a per-user container, and the working directory is the one
    // thing both sides agree on. `.pi/ccweb` rather than `.pi/extensions`
    // because pi auto-discovers the latter for a trusted project, and a
    // extension loaded twice registers its tool twice.
    result.args.push('-e', path.join('.pi', 'ccweb', 'tier-ladder.ts'));
  }

  return result;
};

/**
 * Same read-only tiers as TIER_TOOLS, in claude's PascalCase tool names.
 *
 * Claude codes its available tools as `Read`, `Grep`, `Glob`, `Bash`, `Write`,
 * `Edit`, ... The restricted rungs get inspection tools only; the workhorse
 * rungs omit the list and inherit everything. Bash is deliberately absent from
 * the read-only rungs: a shell with redirection and `sed`/`rm` is not a
 * read-only agent, however the prompt words it.
 */
const CLAUDE_TIER_TOOLS: Partial<Record<ModelTier, string[]>> = {
  floor: ['Read', 'Grep', 'Glob'],
  top: ['Read', 'Grep', 'Glob'],
};

/**
 * Claude Code.
 *
 * Claude has no per-role ladder either, but it does take session-scoped
 * subagents on the command line: `--agents` accepts JSON defining agents that
 * live for that one process. Each rung becomes one agent with the rung's
 * model, so nothing is written into the user's repository — the whole ladder
 * arrives as launch arguments, which is also why there is nothing to defer
 * when no session directory is known.
 *
 * Verified against claude 2.1.221: `--agents <json>` is in the CLI reference,
 * and the JSON accepts the same fields as `.claude/agents/<name>.md`
 * frontmatter — `description`, `prompt`, `tools`, `model`, `effort` (see
 * code.claude.com/docs/en/sub-agents).
 */
const writeClaudeTiers: Writer = (tiers, _profile, _ctx) => {
  const result: TierWriteResult = { written: [], replaced: [], args: [] };

  const agents: Record<string, unknown> = {};
  for (const tier of MODEL_TIERS) {
    const model = tiers[tier];
    if (!model) continue;

    const tools = CLAUDE_TIER_TOOLS[tier];
    const readOnly = tools
      ? [
          'You are read-only: inspect with Read, Grep, and Glob, and never edit, write, install, or commit.',
          '',
        ]
      : [];
    agents[tier] = {
      description: TIER_DESCRIPTION[tier],
      prompt: [
        TIER_DESCRIPTION[tier],
        '',
        ...readOnly,
        'Report what you found or changed, with concrete file:line references.',
        '',
      ].join('\n'),
      ...(tools ? { tools } : {}),
      model,
      effort: TIER_EFFORT[tier],
    };
  }
  if (Object.keys(agents).length === 0) return result;

  // One argv element: the spawn passes arguments verbatim, so the JSON needs
  // no shell quoting, and it stays independent of anything the user's own
  // ~/.claude settings do elsewhere.
  result.args.push('--agents', JSON.stringify(agents));
  return result;
};

/**
 * Grok.
 *
 * Grok Build expresses per-role models natively: custom roles are declared in
 * `~/.grok/config.toml` under `[subagents.roles.<name>]` or discovered from
 * `.grok/roles/*.toml` (project) and `~/.grok/roles/*.toml` (user), one role
 * per file with the file name as the role name. Each role carries its own
 * `model` and `default_capability_mode`. Writing into the session's project
 * `.grok/roles/` follows the same precedence trick as pi: the project copy
 * lands where the per-session ladder belongs, and the user's home directory
 * is never touched.
 *
 * Verified against grok's own user guide (`16-subagents.md` in the grok-build
 * tree); the ACP entry point this app drives (`grok agent stdio`) reads the
 * same configuration, so re-check against the installed build the first time
 * one is present.
 */
const writeGrokTiers: Writer = (tiers, profile, ctx) => {
  const result: TierWriteResult = { written: [], replaced: [], args: [] };

  if (!ctx.workingDir) {
    result.deferred =
      'Applied per session: the rung role files are written into each session’s ' +
      'working directory when it starts. Nothing in ~/.grok is touched.';
    return result;
  }

  const dir = path.join(ctx.workingDir, '.grok', 'roles');
  if (rejectSymlinkedDestination(ctx.workingDir, dir, result)) return result;
  fs.mkdirSync(dir, { recursive: true });
  ensureIgnored(dir);

  for (const tier of MODEL_TIERS) {
    const model = tiers[tier];
    if (!model) continue;
    const file = path.join(dir, `${tier}.toml`);
    if (rejectSymlinkedDestination(ctx.workingDir, file, result)) return result;

    const readOnly = tier === 'floor' || tier === 'top';
    const lines = [
      `# ${MANAGED_MARKER} (profile: ${profile.name})`,
      // Quoted: TOML requires double-quoted strings for text values (bare
      // words are not string syntax), and JSON.stringify quotes and escapes.
      `description = ${JSON.stringify(TIER_DESCRIPTION[tier])}`,
      `model = ${JSON.stringify(model)}`,
      // The read-only rungs get a capability mode that cannot edit; the
      // workhorse rungs omit it and use the role's full toolset.
      ...(readOnly ? ['default_capability_mode = "read-only"'] : []),
      '',
    ].join('\n');

    writeManaged(file, lines, result);
  }

  return result;
};

/**
 * Oh My Pi.
 *
 * omp has native model roles, so tiers map onto config rather than onto agent
 * files, and `--config` takes an overlay for a single run. That keeps the
 * user's own ~/.omp/agent/config.yml untouched.
 */
const writeOmpTiers: Writer = (tiers, profile, ctx) => {
  const result: TierWriteResult = { written: [], replaced: [], args: [] };

  // omp's roles are not a 1:1 match for the four tiers: `smol` is the cheap
  // helper, `task` runs delegated work, `slow` is the reasoning model, and
  // `plan` and `advisor` ride the top rung. `designer` follows the tiers
  // closest to its job, and the small utility roles — `vision`, `commit`,
  // `tiny` — take the cheapest rung that can still do theirs. The table is
  // shared, so every one of omp's ten roles resolves here in the same order
  // omp presents them.
  const roles: Array<[string, string]> = [];
  for (const [role, rungs] of OMP_ROLES) {
    for (const tier of rungs) {
      const model = tiers[tier];
      if (model) {
        roles.push([role, model]);
        break;
      }
    }
  }

  const lines = [
    `# ${MANAGED_MARKER} (profile: ${profile.name})`,
    '# Generated from the capability tiers configured in Settings.',
    '# Edits here are overwritten when the profile is saved.',
    'modelRoles:',
  ];
  let any = false;
  for (const [role, model] of roles) {
    // Quoted so a model id containing ':' (a thinking-level suffix, say) stays
    // one scalar instead of parsing as a nested mapping.
    lines.push(`  ${role}: ${JSON.stringify(model)}`);
    any = true;
  }
  if (!any) return result;

  const file = path.join(ctx.generatedDir, `omp-${profile.id}.yml`);
  writeManaged(file, `${lines.join('\n')}\n`, result);
  if (result.written.includes(file)) {
    result.args.push('--config', file);
  }
  return result;
};

const WRITERS: Record<string, Writer> = {
  pi: writePiTiers,
  claude: writeClaudeTiers,
  grok: writeGrokTiers,
  omp: writeOmpTiers,
};


/** Whether tiers configured for this runtime will actually be applied. */
export function supportsTiers(runtime: string): boolean {
  return runtime in WRITERS;
}

export function tierCapableRuntimes(): string[] {
  return Object.keys(WRITERS);
}

/**
 * Render a profile's tiers into the runtime's native config.
 *
 * Returns the extra arguments the spawn needs, plus what was written and what
 * of the user's was replaced to do it. Never throws: a failed write degrades to
 * "launched without tiers", which is recoverable, where a thrown error would
 * mean the user cannot start the runtime at all. The reason travels back as
 * `failed`, because a launch that quietly drops the ladder is exactly the
 * silence this issue exists to remove.
 */
export function applyTiers(
  profile: RuntimeProfile,
  ctx: TierWriterContext,
): TierWriteResult {
  const empty: TierWriteResult = { written: [], replaced: [], args: [] };
  if (!profile.tiers || Object.keys(profile.tiers).length === 0) return empty;

  const writer = WRITERS[profile.runtime];
  if (!writer) return { ...empty, unsupported: true };

  try {
    return writer(profile.tiers, profile, ctx);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`runtime profiles: could not write ${profile.runtime} tiers: ${message}`);
    return { ...empty, failed: `the ladder could not be written to disk (${message})` };
  }
}

export function defaultTierContext(dataDir: string): TierWriterContext {
  return {
    generatedDir: path.join(dataDir, 'runtime-profiles'),
    homeDir: os.homedir(),
  };
}
