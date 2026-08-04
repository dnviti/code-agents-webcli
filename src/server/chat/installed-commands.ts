import fs from 'fs';
import path from 'path';
import { SlashCommand } from '../../shared/chat-events.js';

/** Private launch metadata kept separate from the capabilities sent to browsers. */
export interface InstalledSkill {
  name: string;
  path: string;
}

export interface InstalledCommandDiscovery {
  commands: SlashCommand[];
  skills: InstalledSkill[];
}

interface FoundCommand extends SlashCommand {
  /** Present only for Agent Skills, never serialized into `commands`. */
  skillPath?: string;
}

/**
 * What is installed for this session, read off disk.
 *
 * The command menu is supposed to show what a conversation can run. Every
 * runtime knows that list, and every runtime tells us late or not at all:
 * Claude sends it with the first turn's `init`, so a brand-new session used to
 * offer a handful of built-ins and nothing else until a message had already
 * been sent; pi never sends one. The ACP agents volunteer theirs immediately
 * after `session/new`, and current Codex app-server builds answer
 * `skills/list` once the session is open. Where a runtime does say something,
 * what it says wins outright.
 *
 * So this is the stand-in, and it is deliberately not clever. It reads the
 * directories each runtime's own installer writes skills and commands into,
 * takes the name and description their authors wrote in the frontmatter, and
 * returns them. It invents nothing: a skill with no description reaches the
 * menu with no description, because a sentence made up here would be a guess
 * presented as documentation.
 *
 * It is a menu of what is installed, not a promise about a runtime this app
 * cannot interrogate. A runtime is free to refuse something listed here; the
 * moment it says so by reporting its own list, this one is replaced whole.
 */

/** One place a runtime looks, and what kind of thing lives there. */
interface Location {
  /** Relative to the session's home (`~`) or to its working directory. */
  base: 'home' | 'cwd';
  dir: string;
  /**
   * `skills` — directories holding a `SKILL.md`, the Agent Skills layout.
   * `commands` — flat or nested `*.md` files, one command each.
   */
  kind: 'skills' | 'commands';
  /**
   * Look here in every directory from the working directory up to the
   * repository root, not only in the working directory itself.
   *
   * Only for runtimes that document doing it, which so far is agy alone: "the
   * agent walks from your current working directory up to the repository root
   * (e.g. the folder containing `.git`) to find these directories". Watched
   * working — a skill in `<repo>/.agents/skills/` was invoked by name from a
   * session opened in `<repo>/packages/web`, and agy read it.
   *
   * Nearest first, so a skill beside the working directory shadows an
   * ancestor's of the same name.
   */
  walkUp?: boolean;
  /**
   * How far below this directory a skill may sit, when the runtime is stricter
   * than the default recursive walk.
   *
   * `0` means immediate children only. Absent means `MAX_COMMAND_DEPTH`, which
   * is what every runtime got before agy needed otherwise: agy's layout is
   * exactly `<root>/skills/<name>/SKILL.md` and nothing deeper — probed, a
   * skill at `skills/outer/inner/SKILL.md` was reported missing by the agent
   * itself. Recursing past that would put a name on the menu that agy has no
   * skill for.
   */
  maxDepth?: number;
}

/**
 * Where each runtime's installer puts things, from each runtime's own docs.
 *
 * Ordered by priority, highest first, the way each runtime documents its own
 * shadowing: a project skill beats a personal one of the same name. Nothing is
 * guessed — a runtime whose layout was never verified gets no entry at all and
 * falls back to nothing, which is honest, rather than to a directory somebody
 * hoped it would read.
 *
 * kimi and omp are absent on purpose. Both speak ACP and both send their real
 * list within milliseconds of `session/new`, before a person can open the menu,
 * so a fallback for them would be a list nobody sees that could only be wrong.
 */
const LOCATIONS: Record<string, Location[]> = {
  claude: [
    { base: 'cwd', dir: '.claude/skills', kind: 'skills' },
    { base: 'cwd', dir: '.claude/commands', kind: 'commands' },
    { base: 'home', dir: '.claude/skills', kind: 'skills' },
    { base: 'home', dir: '.claude/commands', kind: 'commands' },
  ],
  // `08-skills.md`: grok reads its own tiers and, unless the compat flag is
  // turned off, Claude's user directories as well.
  grok: [
    { base: 'cwd', dir: '.grok/skills', kind: 'skills' },
    { base: 'cwd', dir: '.grok/commands', kind: 'commands' },
    { base: 'cwd', dir: '.agents/skills', kind: 'skills' },
    { base: 'home', dir: '.grok/skills', kind: 'skills' },
    { base: 'home', dir: '.grok/commands', kind: 'commands' },
    { base: 'home', dir: '.claude/skills', kind: 'skills' },
    { base: 'home', dir: '.claude/commands', kind: 'commands' },
  ],
  // pi's `docs/skills.md`. Its Claude-compatibility is opt-in through settings
  // rather than on by default, so it is not listed here.
  pi: [
    { base: 'cwd', dir: '.pi/skills', kind: 'skills' },
    { base: 'cwd', dir: '.agents/skills', kind: 'skills' },
    { base: 'home', dir: '.pi/agent/skills', kind: 'skills' },
    { base: 'home', dir: '.agents/skills', kind: 'skills' },
  ],
  codex: [
    { base: 'cwd', dir: '.codex/skills', kind: 'skills' },
    { base: 'cwd', dir: '.agents/skills', kind: 'skills' },
    { base: 'home', dir: '.codex/skills', kind: 'skills' },
    { base: 'home', dir: '.agents/skills', kind: 'skills' },
    { base: 'home', dir: '.codex/prompts', kind: 'commands' },
    // Hidden children are skipped by the generic walk. This explicit root is
    // the fallback for exec mode and app-server builds without `skills/list`;
    // current app-server builds report the same system skills themselves.
    { base: 'home', dir: '.codex/skills/.system', kind: 'skills' },
  ],
  /**
   * agy's customisation system: a `skills/` folder inside a "customisation
   * root", which its own `agy-customizations` skill documents as `.agents/` —
   * "or `.agent/`, `_agents/`, `_agent/`" — in the project, and
   * `~/.gemini/config/` globally.
   *
   * This runtime's menu had to be proved rather than assumed, because it is
   * doing something the others' are not. agy publishes no command list and
   * interprets none of its terminal UI's forty slash commands headlessly — but
   * it does act on a *skill* named in the prompt: a skill at
   * `.agents/skills/marker-reporter/SKILL.md`, invoked as `/marker-reporter`,
   * made it open that SKILL.md and answer with the token the skill specifies.
   * So every row below was probed against agy 1.1.8 by asking the agent itself
   * which of a set of planted skills were available to it:
   *
   *   .agents  _agents  .agent  _agent      all four AVAILABLE
   *   <root>/plugins/<p>/skills/<s>         AVAILABLE, and *not* namespaced
   *   ~/.gemini/config/skills               AVAILABLE from an unrelated cwd
   *   skills/outer/inner/SKILL.md           MISSING — hence `maxDepth`
   *
   * `~/.agents/skills` has no row of its own, and the distinction is worth
   * being exact about because this machine has forty-three pi and grok skills
   * in it. It is a *user-scoped* root for those two runtimes; agy's user-scoped
   * root is `~/.gemini/config/`, and a skill planted in `~/.agents/skills` was
   * not found from an unrelated working directory. What agy does do is treat
   * `.agents` as a *workspace* root — so if the walk below happens to pass
   * through the home directory (a home that is itself a git repository, with
   * the session opened under it), those skills are found and offered. That is
   * not the table over-reaching: agy would load them there too.
   *
   * The built-in directory is deliberately absent, and this is the row that
   * changed on being probed rather than assumed. Only one of its three skills
   * is live: `/antigravity_guide` answers from the skill, while
   * `/permissioned-github` answers "no such skill" and `/agy-customizations`
   * quietly opens the wrong file. Two undeliverable entries to gain one
   * documentation skill is the exact trade #71 was filed over. It is also
   * checksummed and re-extracted by the binary on upgrade, so its contents are
   * not ours to depend on.
   *
   * `skills.json` / `plugins.json` — agy's pointer files, which can name any
   * absolute or `~/`-relative directory and chain through `inherits` — are real
   * and verified, and cannot be expressed as a `{base, dir}` row at all. A
   * project using one has skills this menu will not show. That is an
   * under-report, which is the safe direction, and it is written down in
   * docs/runtimes.md rather than left to be discovered.
   */
  antigravity: [
    // Workspace roots, nearest directory first, then the aliases in the order
    // agy's own documentation lists them. `skills` before `plugins` at each
    // root so a plain skill shadows a plugin's of the same name — agy does not
    // namespace plugin skills, so the collision is real.
    ...['.agents', '_agents', '.agent', '_agent'].flatMap((root): Location[] => [
      { base: 'cwd', dir: `${root}/skills`, kind: 'skills', walkUp: true, maxDepth: 0 },
      // `<root>/plugins/<plugin>/skills/<skill>/SKILL.md` — two levels below the
      // directory named here, which is what `maxDepth: 2` buys.
      { base: 'cwd', dir: `${root}/plugins`, kind: 'skills', walkUp: true, maxDepth: 2 },
    ]),
    { base: 'home', dir: '.gemini/config/skills', kind: 'skills', maxDepth: 0 },
    { base: 'home', dir: '.gemini/config/plugins', kind: 'skills', maxDepth: 2 },
  ],
};

/**
 * The working directory and every ancestor up to the repository root.
 *
 * The rule is agy's own, quoted on `Location.walkUp`, and the stopping
 * condition is the one it names: the folder holding `.git`. Where there is no
 * `.git` above the working directory at all, only the working directory itself
 * is searched — walking to the filesystem root on the off chance would pick up
 * whatever `.agents` happens to sit in `/tmp` or in somebody's home, which is
 * how a menu ends up offering a skill from a project the session has nothing to
 * do with.
 *
 * Deliberately two passes rather than one: the repository root has to be *found*
 * before anything is scanned, because whether an ancestor counts depends on
 * whether a `.git` turns up above it.
 */
function upToRepositoryRoot(workingDir: string): string[] {
  const chain: string[] = [];
  const start = path.resolve(workingDir);
  let current = start;
  // Bounded: a path deeper than this is pathological, and the cost of the guard
  // is one comparison.
  for (let depth = 0; depth < 32; depth++) {
    chain.push(current);
    let isRoot = false;
    try {
      isRoot = fs.existsSync(path.join(current, '.git'));
    } catch {
      // Unreadable; treat it as "not the root" and keep climbing.
    }
    if (isRoot) return chain;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  // Resolved, like every entry the loop above would have produced: a relative
  // working directory must not come back out of here in a different shape from
  // an absolute one.
  return [start];
}

/**
 * Which runtimes enumerate what is installed when they report their own list.
 *
 * The same kind of per-runtime knowledge as `LOCATIONS`, and it belongs beside
 * it: both are statements about what a runtime does with the skills and
 * commands its own installer wrote to disk.
 *
 * It exists because "the runtime's list replaces the stand-in" is true of one
 * runtime here and false of another. Claude's `init` names everything it will
 * accept — 104 entries on this machine, its skills and its plugins' among them
 * — so anything the scan adds on top is a name Claude has no command for, which
 * is exactly what `/shadcn` was: on the menu, and delivered as ordinary prompt
 * text to an agent that could only read it (#71). Grok on ACP announces seven
 * built-ins and nothing about `.grok/skills`, so for grok the same replacement
 * empties the menu milliseconds after the handshake (#73).
 *
 * Absent means false, which keeps a runtime nobody has checked on the safe
 * side: its user's skills stay on the menu rather than disappearing the moment
 * it says anything at all.
 */
const ENUMERATES_INSTALLED: Record<string, boolean> = {
  claude: true,
  grok: false,
  pi: false,
  // App-server's `skills/list` is the effective enabled catalogue, including
  // shared, plugin and system skills. Exec mode never sends an update, so its
  // launch-time disk stand-in remains intact despite this being true.
  codex: true,
  // Stated rather than left to the default, because it has been checked: agy
  // never reports a command list at all, so there is nothing that could
  // legitimately replace what is on disk.
  antigravity: false,
};

/** Whether this runtime's own command list can be taken as the whole of one. */
export function enumeratesInstalledCommands(runtime: string): boolean {
  return ENUMERATES_INSTALLED[runtime] === true;
}

/**
 * Ceilings, so a session cannot be held up by somebody's home directory.
 *
 * The scan runs once, between the launch request and the first event, and a
 * skills tree is normally a few dozen small files. These bound the pathological
 * case — a `commands` directory pointed at a source tree — rather than any real
 * one, and hitting them costs entries at the end of an already long menu.
 */
const MAX_ENTRIES = 500;
const MAX_COMMAND_DEPTH = 3;
const FRONTMATTER_BYTES = 8192;
/**
 * Directories opened per scan.
 *
 * The entry ceiling alone does not bound a walk that *finds* nothing: a
 * `commands` directory pointed at a source tree is thousands of folders and no
 * commands, and the depth limit still lets it read every one. This is the real
 * stop.
 */
const MAX_DIRECTORIES = 400;

/**
 * Read the frontmatter of a markdown file, as a flat string map.
 *
 * A deliberately small YAML reader, because two keys are wanted from it and a
 * dependency for that is not worth carrying. It understands what skill authors
 * actually write: `key: value`, quoted values, and the folded and literal block
 * scalars (`>-`, `|`) that every long `description:` in the wild uses. Anything
 * it does not understand it skips, which costs a description and never a
 * session.
 */
function readFrontmatter(file: string): Record<string, string> {
  let head: string;
  try {
    const handle = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(FRONTMATTER_BYTES);
      const read = fs.readSync(handle, buffer, 0, FRONTMATTER_BYTES, 0);
      head = buffer.subarray(0, read).toString('utf8');
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return {};
  }

  const normalised = head.replace(/^﻿/, '');
  if (!/^---\r?\n/.test(normalised)) return {};
  const body = normalised.slice(normalised.indexOf('\n') + 1);
  const end = body.search(/\r?\n---\s*(\r?\n|$)/);
  const lines = (end === -1 ? body : body.slice(0, end)).split(/\r?\n/);

  const fields: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const match = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(lines[i] ?? '');
    if (!match) continue;
    const key = match[1]!;
    let value = match[2]!.trim();

    // A block scalar: the value is the indented lines that follow, joined the
    // way YAML would join them — folded keeps the paragraph on one line,
    // literal keeps its newlines.
    if (value === '>' || value === '>-' || value === '|' || value === '|-') {
      const folded = value.startsWith('>');
      const block: string[] = [];
      while (i + 1 < lines.length && /^(\s+\S|\s*$)/.test(lines[i + 1] ?? '')) {
        const next = lines[++i] ?? '';
        if (!next.trim() && i + 1 >= lines.length) break;
        block.push(next.trim());
      }
      value = folded ? block.join(' ').trim() : block.join('\n').trim();
    } else if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }

    if (value) fields[key] = value;
  }
  return fields;
}

/** A name the menu can show: no slash, no whitespace, not empty. */
function cleanName(raw: string): string {
  return raw.trim().replace(/^\//, '').replace(/\s+/g, '-');
}

/**
 * Read a directory, spending one of the walk's budget of them.
 *
 * The budget is per scan and is carried in a counter rather than threaded
 * through every call, because the recursion is depth-first and what has to be
 * capped is the total, not any one branch. A module-level counter is safe here
 * precisely because the whole scan is synchronous: two sessions starting at
 * once cannot interleave, so neither can spend the other's budget.
 */
let directoriesLeft = MAX_DIRECTORIES;

/** Whether a directory is there at all, without spending the walk's budget. */
function existsDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function entriesIn(dir: string): fs.Dirent[] {
  if (directoriesLeft <= 0) return [];
  directoriesLeft -= 1;
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Does this entry lead to a directory — following a symlink if it is one?
 *
 * `readdir` reports a symlink as a symlink and nothing more, and a skills
 * directory is very often a tree of links: every skill in this machine's own
 * `~/.claude/skills` is one, which is how a first version of this scan found
 * forty-three skills and reported none of them.
 */
function leadsToDirectory(root: string, entry: fs.Dirent): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return fs.statSync(path.join(root, entry.name)).isDirectory();
  } catch {
    return false;
  }
}

/** Skills: every directory holding a `SKILL.md`, searched recursively. */
function scanSkills(
  root: string,
  prefix: string,
  depth: number,
  out: FoundCommand[],
  maxDepth: number = MAX_COMMAND_DEPTH,
): void {
  if (out.length >= MAX_ENTRIES || depth > maxDepth) return;
  for (const entry of entriesIn(root)) {
    if (out.length >= MAX_ENTRIES) return;
    if (entry.name.startsWith('.') || !leadsToDirectory(root, entry)) continue;
    const dir = path.join(root, entry.name);
    const manifest = path.join(dir, 'SKILL.md');
    if (fs.existsSync(manifest)) {
      const fields = readFrontmatter(manifest);
      // The standard says a skill's name matches its directory, and most agree;
      // where the frontmatter disagrees the frontmatter is what its author
      // wrote, so it is what the menu shows.
      const name = cleanName(fields.name || entry.name);
      if (name) {
        out.push({ name: prefix + name, description: fields.description, skillPath: manifest });
      }
      continue;
    }
    scanSkills(dir, prefix, depth + 1, out, maxDepth);
  }
}

/**
 * Commands: one `*.md` file each.
 *
 * A file in a subdirectory is namespaced with its directory, `dir:name`, which
 * is how Claude Code and grok both address a project command that lives in a
 * folder.
 */
function scanCommands(root: string, prefix: string, depth: number, out: FoundCommand[]): void {
  if (out.length >= MAX_ENTRIES || depth > MAX_COMMAND_DEPTH) return;
  for (const entry of entriesIn(root)) {
    if (out.length >= MAX_ENTRIES) return;
    if (entry.name.startsWith('.')) continue;
    const full = path.join(root, entry.name);
    if (leadsToDirectory(root, entry)) {
      scanCommands(full, `${prefix}${cleanName(entry.name)}:`, depth + 1, out);
      continue;
    }
    if (!entry.name.toLowerCase().endsWith('.md')) continue;
    if (entry.name === 'SKILL.md') continue;
    const fields = readFrontmatter(full);
    const name = cleanName(entry.name.slice(0, -3));
    if (name) out.push({ name: prefix + name, description: fields.description });
  }
}

/**
 * Skills and commands a plugin brings with it.
 *
 * Only Claude has this, and its own installer keeps the register: the cache
 * holds several versions of a plugin at once and only `installed_plugins.json`
 * says which one is live. A plugin's entries are addressed `plugin:name`, the
 * same way the runtime reports them in `init` — which is what makes the two
 * lists line up when the real one arrives.
 */
/**
 * Which plugins are switched on, or null when nothing says.
 *
 * Installed is not the same as enabled: this machine has eleven plugins in the
 * cache and five turned on, and the runtime lists the five. Settings are read
 * user file first, local override second, which is the order Claude resolves
 * them in. A missing or unreadable settings file means no opinion, and every
 * installed plugin is listed — the same answer the fallback gave before any of
 * this, and a better one than an empty menu.
 */
function enabledPlugins(home: string): Map<string, boolean> | null {
  let found: Map<string, boolean> | null = null;
  for (const file of ['settings.json', 'settings.local.json']) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(home, '.claude', file), 'utf8'));
    } catch {
      continue;
    }
    const flags = (parsed as { enabledPlugins?: Record<string, unknown> })?.enabledPlugins;
    if (!flags || typeof flags !== 'object') continue;
    found = found ?? new Map<string, boolean>();
    for (const [key, value] of Object.entries(flags)) found.set(key, value === true);
  }
  return found;
}

function scanPlugins(home: string, out: FoundCommand[]): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(home, '.claude/plugins/installed_plugins.json'), 'utf8'));
  } catch {
    return;
  }
  const plugins = (parsed as { plugins?: Record<string, unknown> })?.plugins;
  if (!plugins || typeof plugins !== 'object') return;
  const enabled = enabledPlugins(home);

  for (const [key, value] of Object.entries(plugins)) {
    if (out.length >= MAX_ENTRIES) return;
    if (enabled && enabled.get(key) !== true) continue;
    const installs = Array.isArray(value) ? value : [];
    // Last write wins, matching the order the installer appends in.
    const installPath = installs
      .map((install) => (install as { installPath?: unknown })?.installPath)
      .filter((p): p is string => typeof p === 'string' && p.length > 0)
      .pop();
    if (!installPath) continue;
    const plugin = cleanName(key.split('@')[0] ?? '');
    if (!plugin) continue;
    scanSkills(path.join(installPath, 'skills'), `${plugin}:`, 0, out);
    scanCommands(path.join(installPath, 'commands'), `${plugin}:`, 0, out);
  }
}

export interface InstalledCommandsOptions {
  /**
   * The home directory of whoever this session belongs to.
   *
   * Passed in rather than read from `process.env` on purpose. Where sessions run
   * in per-user environments this is that person's home, and reading the
   * server's own would turn the command menu into a window onto somebody else's
   * machine. A session lists what it can run and nothing more.
   */
  home?: string;
  workingDir: string;
}

/**
 * What this session could run, before its runtime has said anything.
 *
 * Names are unique: the first location to claim a name keeps it, and the table
 * is ordered so that is the one the runtime would itself prefer.
 */
export function discoverInstalledCommands(
  runtime: string,
  options: InstalledCommandsOptions,
): InstalledCommandDiscovery {
  const locations = LOCATIONS[runtime];
  if (!locations) return { commands: [], skills: [] };
  const home = options.home;
  directoriesLeft = MAX_DIRECTORIES;

  const found: FoundCommand[] = [];
  for (const location of locations) {
    if (found.length >= MAX_ENTRIES) break;
    const roots =
      location.base === 'home'
        ? home
          ? [home]
          : []
        : location.walkUp
          ? upToRepositoryRoot(options.workingDir)
          : [options.workingDir];
    for (const root of roots) {
      if (found.length >= MAX_ENTRIES) break;
      const dir = path.join(root, location.dir);
      // Checked before the scan, and only so a directory that is not there
      // costs nothing. `entriesIn` spends one of the walk's budget of directory
      // opens whether or not the open succeeds, and a `walkUp` row multiplies
      // the misses: eight roots against a deep tree is a hundred failed opens,
      // which would exhaust the budget before the personal directories at the
      // end of the table were ever reached.
      if (!existsDirectory(dir)) continue;
      if (location.kind === 'skills') scanSkills(dir, '', 0, found, location.maxDepth);
      else scanCommands(dir, '', 0, found);
    }
  }
  if (runtime === 'claude' && home) scanPlugins(home, found);

  const seen = new Set<string>();
  const commands: SlashCommand[] = [];
  const skills: InstalledSkill[] = [];
  for (const command of found) {
    if (seen.has(command.name)) continue;
    seen.add(command.name);
    commands.push(
      command.description
        ? { name: command.name, description: command.description }
        : { name: command.name },
    );
    if (command.skillPath) skills.push({ name: command.name, path: command.skillPath });
  }
  return { commands, skills };
}

/** Public compatibility surface for callers that only need menu entries. */
export function listInstalledCommands(
  runtime: string,
  options: InstalledCommandsOptions,
): SlashCommand[] {
  return discoverInstalledCommands(runtime, options).commands;
}

/**
 * Look a description up by name, for a runtime that reports bare names.
 *
 * Claude's `init` lists what it accepts and says nothing about any of it. The
 * names it reports are the truth and replace whatever was shown before; the
 * descriptions are the ones their authors wrote on disk, matched by name. That
 * is not merging two lists — the list is entirely the runtime's — it is filling
 * in a column the runtime left blank from the only place an answer exists.
 */
export function describeFrom(
  installed: SlashCommand[],
): (name: string) => string | undefined {
  const table = new Map<string, string>();
  for (const command of installed) {
    if (command.description) table.set(command.name.toLowerCase(), command.description);
  }
  return (name: string) => table.get(cleanName(String(name || '')).toLowerCase());
}
