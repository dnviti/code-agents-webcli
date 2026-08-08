import { spawn } from 'child_process';
import { ModelChoice } from '../../shared/chat-events.js';
import { wrapHostCommand } from '../services/environments/manager.js';

/**
 * Which models a runtime will accept, asked of the runtime itself.
 *
 * The sibling of `installed-commands.ts`, and for the same reason: the picker
 * is supposed to offer what a conversation can actually run, and a runtime that
 * knows the answer perfectly well may have no way of volunteering it over the
 * protocol it speaks here. codex does (`model/list`, handled in its adapter)
 * and the ACP agents do (their model select). grok and pi do not — but both
 * ship a command that prints the list, and running it is a great deal more
 * honest than asking a person to remember a model id and type it correctly,
 * with no feedback when they get it wrong.
 *
 * Nothing is invented. The commands below were run against the installed
 * binaries and their output parsed as observed; a runtime with no entry gets no
 * list at all, and its picker keeps the typed box and says so. A model this
 * returns is a model the runtime named, never one this app thinks it has.
 *
 * The result is cached for the life of the process, keyed by the command that
 * produced it. A model list changes when a CLI is upgraded or a provider key is
 * added, which is not something that happens between two turns of a
 * conversation — and the alternative is spawning a process on every session
 * start for a menu most sessions never open.
 */

/** How a runtime is asked, and how its answer is read. */
interface Listing {
  args: string[];
  parse: (stdout: string) => ModelChoice[];
}

const PROBE_TIMEOUT_MS = 8_000;
/** Enough for pi's several hundred rows; a runaway process is not read at all. */
const MAX_OUTPUT_BYTES = 2_000_000;

/**
 * `grok models` — plain text, no JSON mode (checked: `--json` is rejected).
 *
 *   You are logged in with grok.com.
 *
 *   Default model: grok-build
 *
 *   Available models:
 *     * grok-build (default)
 *     - sxs-claude-opus-4-6
 *     - grok-4.5
 *
 * The bullet distinguishes the default from the rest, which is worth keeping —
 * it is the model a conversation gets when nobody chooses one.
 */
function parseGrokModels(stdout: string): ModelChoice[] {
  const models: ModelChoice[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s{2,}([*-])\s+(\S+)(\s+\(default\))?\s*$/.exec(line);
    if (!match) continue;
    const value = match[2];
    const isDefault = match[1] === '*' || Boolean(match[3]);
    models.push({ value, name: value, ...(isDefault ? { description: 'default' } : {}) });
  }
  return models;
}

/**
 * `pi --list-models` — a fixed-width table with a header row.
 *
 *   provider    model                        context  max-out  thinking  images
 *   openrouter  anthropic/claude-opus-4.1    200K     32K      yes       yes
 *
 * The second column is what `--model` takes (pi's own help documents
 * `provider/id`, and that is the form printed here). The first is which
 * provider it comes through, which is not part of the name but is the one
 * piece of context that tells two otherwise identically-named entries apart.
 */
function parsePiModels(stdout: string): ModelChoice[] {
  const models: ModelChoice[] = [];
  for (const line of stdout.split('\n')) {
    const columns = line.trim().split(/\s{2,}/);
    if (columns.length < 2) continue;
    const [provider, value] = columns;
    // The header names its own columns, which is how it is recognised rather
    // than by position: a version that adds a preamble line above it would
    // otherwise contribute "provider" as a model.
    if (provider === 'provider' && value === 'model') continue;
    if (!value || /\s/.test(value)) continue;
    models.push({ value, name: value, ...(provider ? { description: provider } : {}) });
  }
  return models;
}

/**
 * `agy models` — one model id per line, nothing else.
 *
 *   gemini-3.6-flash-high
 *   gemini-3.6-flash-medium
 *   claude-sonnet-4-6
 *
 * No default is marked and no description is offered, so none is invented. agy
 * *does* know a display name for each ("Gemini 3.6 Flash (High)", printed when
 * it refuses an unknown id) but it prints those from a different command, in a
 * different format, and pairing the two lists by position would silently
 * mislabel every model the day one of them grows a row.
 */
function parseAntigravityModels(stdout: string): ModelChoice[] {
  const models: ModelChoice[] = [];
  for (const line of stdout.split('\n')) {
    const value = line.trim();
    // A model id, and nothing that is prose: agy prints ids bare, so anything
    // with a space or a punctuation mark in it is a banner rather than a model.
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)) continue;
    models.push({ value, name: value });
  }
  return models;
}

const LISTINGS: Record<string, Listing> = {
  grok: { args: ['models'], parse: parseGrokModels },
  pi: { args: ['--list-models'], parse: parsePiModels },
  antigravity: { args: ['models'], parse: parseAntigravityModels },
};

const cache = new Map<string, Promise<ModelChoice[]>>();

/**
 * Ask a runtime for its models, or get nothing.
 *
 * Never throws and never rejects. A runtime that is not installed, is not
 * logged in, prints something unrecognisable, or takes too long all produce an
 * empty list — which is the same state as a runtime that publishes nothing, and
 * the picker already handles that honestly.
 */
export function installedModels(runtime: string, command: string, env?: NodeJS.ProcessEnv): Promise<ModelChoice[]> {
  const listing = LISTINGS[runtime];
  if (!listing) return Promise.resolve([]);

  // The separator is a NUL rather than a space, so a command path with a space
  // in it cannot collide with another runtime's entry. Written as an escape
  // rather than as the byte itself: a literal NUL in the source makes git treat
  // this whole file as binary and stop producing a diff for it.
  const key = `${runtime}\u0000${command}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const probe = new Promise<ModelChoice[]>((resolve) => {
    const processEnv = {
      ...process.env,
      ...(env || {}),
      NO_COLOR: '1',
      TERM: 'dumb',
      FORCE_COLOR: '0',
    };
    const launch = wrapHostCommand(command, listing.args, process.platform, processEnv);
    const child = spawn(launch.command, launch.args, {
      env: { ...processEnv, ...(launch.envPatch || {}) },
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
      // Closed, not piped, and this is the reason this is a `spawn` rather than
      // the `execFile` it used to be — that helper leaves stdin an open pipe and
      // has no option to close it. `agy models` waits on that pipe forever:
      // measured at no output and no exit until the timeout killed it, against
      // 2.0s and the full list with stdin ignored. The picker said "this runtime
      // hasn't listed models" about a runtime that lists them perfectly well,
      // and every probe cost the whole timeout.
      //
      // Applied to all of them rather than to agy alone: nothing here writes to
      // a child, a listing command that reads stdin would hang for every runtime
      // equally, and the same trap has already caught `codex exec` and `pi -p`
      // elsewhere in this codebase.
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Parsed even when the process failed: a CLI that prints its list and then
      // exits non-zero for an unrelated reason (an update notice, a failing
      // telemetry ping) has still answered the question.
      try {
        resolve(listing.parse(stdout));
      } catch {
        resolve([]);
      }
    };

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone between the check and the call.
      }
      finish();
    }, PROBE_TIMEOUT_MS);
    timer.unref?.();

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      // Bounded rather than unbounded: a runaway process must not be read into
      // memory, and no real listing comes close to this.
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk;
    });
    // Drained and dropped. Left unread, a chatty CLI fills the pipe buffer and
    // blocks — the same hang this function exists to have stopped hitting.
    child.stderr.resume();

    child.on('error', () => finish());
    child.on('close', () => finish());
  }).catch(() => [] as ModelChoice[]);

  cache.set(key, probe);
  return probe;
}

/** Drop what has been probed. For tests, which install different fake binaries. */
export function resetInstalledModels(): void {
  cache.clear();
}
