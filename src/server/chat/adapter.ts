import { spawn, ChildProcessByStdio, ChildProcessWithoutNullStreams } from 'child_process';
import { Readable } from 'stream';
import { UserEnvironment } from '../services/environments/types.js';
import { HostEnvironment } from '../services/environments/manager.js';
import { WrappedProcessControl } from '../services/environments/types.js';
import {
  ChatCapabilities,
  ChatEvent,
  PermissionRequest,
  SlashCommand,
  UserTurn,
} from '../../shared/chat-events.js';

/**
 * The chat adapter contract.
 *
 * One adapter per native protocol, not per CLI: three runtimes speak the Agent
 * Client Protocol and share a single implementation. An adapter's whole job is
 * to turn one runtime's wire format into ChatEvents and to accept a user turn
 * back — it owns no persistence, no sockets, and no policy.
 *
 * Adapters emit events without `seq`: sequence numbers order the session's
 * durable log and only the session can assign them. Stamping them here would
 * hand each adapter a job it cannot do correctly.
 */

/** An event as an adapter emits it, before the session stamps ordering onto it. */
export type AdapterEvent = ChatEvent extends infer Event
  ? Event extends { t: string }
    ? Omit<Event, 'seq' | 'ts'> & { ts?: number }
    : never
  : never;

export interface ChatAdapterOptions {
  sessionId: string;
  workingDir: string;
  /** Whether workingDir is already an absolute path inside the container. */
  cwdKind?: 'host' | 'container';
  /** Resolved executable for the runtime, from the existing bridge lookup. */
  command: string;
  /**
   * The runtime's plain command name, for when the resolved path is a path on
   * a machine the process will not run on. Falls back to `command`.
   */
  commandName?: string;
  /**
   * Where this conversation's runtime runs. Absent means the host — which is
   * what every caller passed before per-user environments existed.
   */
  environment?: UserEnvironment;
  /** Model from the active runtime profile, if any. */
  model?: string;
  /**
   * Reasoning-effort level to launch at, when the conversation has chosen one.
   *
   * Spelled in the runtime's own vocabulary, because that is what it will be
   * handed: `xhigh` for claude and pi, `on` for kimi, `ultra` for codex. The
   * layers above never translate between ladders — a level chosen for one
   * runtime is not offered to another.
   */
  effort?: string;
  /** Extra CLI arguments from the active runtime profile. */
  extraArgs?: string[];
  /** Environment from the active runtime profile. */
  env?: Record<string, string>;
  /**
   * Skip the runtime's own approval prompts entirely.
   *
   * Set from the per-session toggle, which the bypass-by-default setting
   * pre-arms. When true an adapter passes the CLI's own bypass flag and stops
   * emitting permission events, because there is nothing left to approve.
   */
  bypassPermissions?: boolean;
  /** Native session id to resume, when the runtime and the log both have one. */
  resumeSessionId?: string;
  /**
   * What this conversation has already been billed, for a runtime whose cost
   * figure is a running total rather than a per-turn one.
   *
   * Claude is the case this exists for, verified against 2.1.220: its `result`
   * message carries per-turn *token* counts but a `total_cost_usd` that keeps
   * climbing across the whole conversation — and across a `--resume` into a new
   * process, which is why the baseline has to come from outside the adapter.
   * Every consumer downstream, the live meter included, treats cost on a turn
   * as that turn's cost, so the subtraction happens once, here, at the only
   * place that knows the runtime's own convention.
   *
   * Three states, and the third is the interesting one. Undefined means a fresh
   * conversation whose counter starts at zero. A number means a resumed
   * conversation that has been billed exactly that much. `null` means a resumed
   * conversation with no record at all — one that ran before any of this
   * existed — where the counter is already somewhere unknown and well above
   * zero. There the first reading is adopted as the watermark and that turn
   * reports no cost, because "we cannot tell" is the only true answer and it is
   * far better than charging one turn for a fortnight of work.
   */
  costBaselineUsd?: number | null;
  /**
   * The MCP server that lets the model ask the user a multiple-choice question.
   *
   * Handed to adapters whose runtime takes MCP servers through the protocol
   * rather than the command line. Claude gets the same server as a `--mcp-config`
   * argument instead, built by the session; either way the server is the same
   * script and the same socket.
   */
  askMcpServer?: { name: string; command: string; args: string[]; env: Record<string, string> };
  emit: (event: AdapterEvent) => void;
  /**
   * Read a file on the agent's behalf.
   *
   * ACP agents delegate filesystem access to their client, so this is not a
   * convenience: without it the agent cannot read the project it was pointed at.
   * Routed through the caller so path safety and ownership stay in one place.
   */
  readFile?: (path: string) => Promise<string>;
  writeFile?: (path: string, contents: string) => Promise<void>;
  /**
   * Skills and project commands found installed for this session, as a
   * stand-in until the runtime says what it accepts.
   *
   * Scanned by the session, because where to look is a fact about the person
   * the session belongs to rather than about the protocol an adapter speaks.
   * An adapter uses it for two things and no more: showing something in the
   * command menu before its runtime has volunteered a list, and filling in the
   * descriptions for a runtime — Claude — that reports names bare.
   */
  installedCommands?: SlashCommand[];
  /**
   * Agent Skill manifests behind `installedCommands`, for runtimes whose wire
   * protocol distinguishes invoking a skill from sending similarly shaped
   * prompt text. Never copied into capabilities: these are absolute paths in
   * the session owner's environment.
   */
  installedSkills?: Array<{ name: string; path: string }>;
}

export interface ChatAdapter {
  readonly runtime: string;
  readonly capabilities: ChatCapabilities;
  /** Launch the runtime and complete whatever handshake it requires. */
  start(): Promise<void>;
  /** Queue a user turn. Resolves when the runtime has accepted it, not when it replies. */
  send(turn: UserTurn): Promise<void>;
  /**
   * False while a `send()` would be refused, even though the last turn is over.
   *
   * Absent means "always ready", which is true of every adapter driving one
   * long-lived process. The one-shot adapters spawn a process per turn and
   * announce the turn's end from a line of *stdout*, while that process is
   * still exiting — so for a few milliseconds the session believes it is idle
   * and the adapter would still throw. Delivering a queued turn in that window
   * wrote the user's message into the transcript and then threw, leaving it
   * asked-but-never-answered with the rest of the queue stuck behind it (#89).
   *
   * Each implementation returns exactly the condition its own `send()` throws
   * on, so this is the same question, asked before the damage instead of after.
   */
  readonly readyForTurn?: boolean;
  /** Cancel the running turn, leaving the session alive. */
  interrupt(): Promise<void>;
  /** Answer a pending approval. */
  respondPermission(requestId: string, optionId: string): void;
  /** Switch model mid-session, for runtimes that allow it. */
  setModel?(model: string): Promise<void>;
  /**
   * Change the model the *next* turn runs on, for a runtime that cannot change
   * the one already running.
   *
   * pi spawns one process per turn, so its model is an argv entry rather than
   * anything a live session holds — there is nothing to ask, and the next
   * `send()` simply builds a different command line. Separate from `setModel`
   * because the difference is one the caller has to be able to state: an
   * escalation that promised a stronger model *now* and delivered it next turn
   * had the model attempting work it could not do (#171).
   */
  setModelNextTurn?(model: string): void;
  /**
   * Switch reasoning effort mid-session, for runtimes that allow it.
   *
   * Resolving means the runtime took it, and an implementation must not resolve
   * on anything weaker than that — the caller reports `live` to the user on the
   * strength of this promise. Where a runtime cannot be asked until the next
   * turn (codex, pi), the implementation stores the level, resolves, and emits
   * the `effort` event itself; where it answers immediately (grok, kimi, omp,
   * claude) it waits for that answer. Absent means the runtime has no way to
   * change level without a relaunch, and the caller says so instead of guessing.
   */
  setEffort?(effort: string): Promise<void>;
  /** Branch the conversation at an earlier point, for runtimes that support it. */
  fork?(atMessageId: string): Promise<string | null>;
  stop(): Promise<void>;
  readonly alive: boolean;
}

/**
 * A spawned CLI, with or without a writable stdin.
 *
 * The persistent adapters keep stdin open and write turns into it. The one-shot
 * ones get their prompt from argv and must *close* stdin instead — pi and
 * `codex exec` both block forever on an open empty pipe, producing no output at
 * all. Both shapes are named here so that difference is a fact the type checker
 * enforces at every `.stdin` rather than a comment someone can miss.
 */
export type AdapterChild =
  | ChildProcessWithoutNullStreams
  | ChildProcessByStdio<null, Readable, Readable>;

interface AdapterChildLifecycle {
  child: AdapterChild;
  closed: boolean;
  closedPromise: Promise<void>;
  resolveClosed: () => void;
  processControl?: WrappedProcessControl;
  spawned: boolean;
  spawnSettled: boolean;
  spawnOutcome: Promise<boolean>;
  resolveSpawnOutcome: (spawned: boolean) => void;
  remoteVerified: boolean;
  stopPromise: Promise<void> | null;
}

/**
 * Maximum serialized size of one runtime protocol record.
 *
 * Codex legitimately embeds multi-megabyte command output in a single JSON-RPC
 * line. The old 1,000,000-character guard discarded those records whenever a
 * pipe split them before their newline. Sixteen MiB leaves room for the
 * runtime's bounded output plus JSON escaping while still bounding one
 * session's incomplete record in memory.
 */
const MAX_PROTOCOL_LINE_BYTES = 16 * 1024 * 1024;
const INITIAL_PROTOCOL_BUFFER_BYTES = 4 * 1024;
const RETAINED_PROTOCOL_BUFFER_BYTES = 64 * 1024;

/**
 * Shared plumbing for adapters that drive a child process over stdio.
 *
 * All four protocols are line-delimited JSON over stdout, so framing, stderr
 * capture, exit handling and teardown live here and each adapter is left with
 * the part that is genuinely its own: translating messages.
 *
 * Note this spawns a plain child process rather than a PTY. Chat mode wants a
 * pipe, not a terminal — a PTY would make these CLIs draw a TUI at us, which is
 * exactly the output we are trying to get away from.
 */
export abstract class BaseChatAdapter implements ChatAdapter {
  abstract readonly runtime: string;
  abstract readonly capabilities: ChatCapabilities;

  protected child: AdapterChild | null = null;
  private stdoutLine = Buffer.alloc(0);
  private stdoutBytes = 0;
  private discardingStdoutLine = false;
  /** Overridden only by the framing harness so overflow recovery stays cheap to test. */
  protected maxProtocolLineBytes = MAX_PROTOCOL_LINE_BYTES;
  protected stderrTail = '';
  protected stopped = false;
  protected exited = false;
  private childLifecycle: AdapterChildLifecycle | null = null;
  /**
   * The cwd as the runtime itself sees it.
   *
   * Session records deliberately keep a host path for bind-mounted locations
   * so server-owned file APIs can use it. Protocol handshakes run inside the
   * container, however, and must receive the translated mount path. An
   * explicitly container-local cwd is already in that namespace and is left
   * unchanged. Resolve this once, after project admission supplied the exact
   * environment, so every protocol and the actual spawn agree.
   */
  protected readonly runtimeWorkingDir: string;

  constructor(protected readonly options: ChatAdapterOptions) {
    const environment = options.environment;
    this.runtimeWorkingDir = environment?.kind === 'container'
      && options.cwdKind !== 'container'
      ? environment.toContainerPath(options.workingDir)
      : options.workingDir;
  }

  get alive(): boolean {
    const lifecycle = this.childLifecycle;
    return Boolean(this.child) && (
      !this.exited
      || Boolean(
        lifecycle
        && lifecycle.child === this.child
        && (!lifecycle.closed || !lifecycle.remoteVerified),
      )
    );
  }

  /** A one-shot adapter may not replace this lifecycle until proof settles. */
  protected childNeedsVerifiedClose(child: AdapterChild | null = this.child): boolean {
    if (!child) return false;
    const lifecycle = this.childLifecycle;
    return Boolean(
      lifecycle
      && lifecycle.child === child
      && (!lifecycle.closed || !lifecycle.remoteVerified),
    );
  }

  /** Arguments for the spawn. */
  protected abstract buildArgs(): string[];

  /** Handle one parsed line of stdout. */
  protected abstract handleMessage(message: unknown): void;

  abstract send(turn: UserTurn): Promise<void>;
  abstract interrupt(): Promise<void>;
  abstract respondPermission(requestId: string, optionId: string): void;

  /** Hook for a handshake that must complete before the session is usable. */
  protected async handshake(): Promise<void> {}

  protected emit(event: AdapterEvent): void {
    const stamped = { ...event, ts: event.ts ?? Date.now() } as AdapterEvent;
    const lifecycle = this.childLifecycle;
    // An engine client can exit while its `docker exec`/`kubectl exec` command
    // is still running remotely. `state: exited` releases project admission,
    // so container-backed adapters may publish it only after the token-bound
    // remote process group has been verified gone.
    if (
      stamped.t === 'state'
      && stamped.state === 'exited'
      && lifecycle
      && (!lifecycle.closed || !lifecycle.remoteVerified)
    ) {
      void this.waitForVerifiedClose(lifecycle.child).then(() => {
        this.options.emit(stamped);
      }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.options.emit({
          t: 'error',
          message: `${this.runtime}: ${message}`,
          fatal: true,
          ts: Date.now(),
        });
        this.options.emit({ t: 'state', state: 'error', ts: Date.now() });
      });
      return;
    }
    this.options.emit(stamped);
  }

  /**
   * Spawn this runtime's CLI where the conversation's owner lives.
   *
   * Every adapter goes through here rather than calling `spawn` itself: the
   * decision "host or this user's container" has exactly one right answer per
   * session, and four copies of it is four chances for an agent to run on the
   * host while the terminal beside it runs in a container.
   *
   * `stdio` still belongs to the caller — the runtimes disagree about whether
   * stdin should be a pipe or closed, and that difference is load-bearing
   * (see the notes at the codex and pi call sites).
   */
  protected launchChild(
    args: string[],
    stdio: ['pipe' | 'ignore', 'pipe', 'pipe'],
  ): ChildProcessWithoutNullStreams {
    const environment = this.options.environment;
    // A container exec resolves the command through the image's PATH; the
    // absolute path found on this host almost certainly is not in the image.
    const command = environment && environment.kind === 'container'
      ? this.options.commandName || this.options.command
      : this.options.command;

    const launch = (environment || new HostEnvironment(this.options.workingDir)).wrap(
      command,
      args,
      {
        cwd: this.options.workingDir,
        cwdKind: this.options.cwdKind,
        env: {
          ...(this.options.env || {}),
          // These CLIs check for a TTY to decide whether to draw a TUI and to
          // colour their output. We want neither: chat mode reads the
          // structured stream, and ANSI in a JSON string is noise the UI would
          // have to strip.
          NO_COLOR: '1',
          TERM: 'dumb',
          FORCE_COLOR: '0',
        },
        // Deliberately no tty: `exec -t` would give the CLI exactly the
        // terminal it must not detect, and would merge stderr into stdout.
        tty: false,
        trackProcess: true,
      },
    );
    if (environment?.kind === 'container' && !launch.processControl) {
      throw new Error(
        `${this.runtime}: container environment did not provide verified process control`,
      );
    }

    const child = spawn(launch.command, launch.args, {
      cwd: environment?.kind === 'container' ? undefined : this.options.workingDir,
      env: launch.env,
      stdio,
    }) as ChildProcessWithoutNullStreams;
    let resolveClosed!: () => void;
    const closedPromise = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    let resolveSpawnOutcome!: (spawned: boolean) => void;
    const spawnOutcome = new Promise<boolean>((resolve) => {
      resolveSpawnOutcome = resolve;
    });
    const lifecycle: AdapterChildLifecycle = {
      child,
      closed: false,
      closedPromise,
      resolveClosed,
      processControl: launch.processControl,
      spawned: false,
      spawnSettled: false,
      spawnOutcome,
      resolveSpawnOutcome,
      remoteVerified: !launch.processControl,
      stopPromise: null,
    };
    this.childLifecycle = lifecycle;
    child.once('spawn', () => {
      lifecycle.spawned = true;
      lifecycle.spawnSettled = true;
      lifecycle.resolveSpawnOutcome(true);
    });
    child.once('error', () => {
      // An async spawn error before `spawn` proves the engine client never
      // launched, so there cannot be a remote process/control file to verify.
      if (!lifecycle.spawned) {
        lifecycle.spawnSettled = true;
        lifecycle.remoteVerified = true;
        lifecycle.resolveSpawnOutcome(false);
      }
    });
    const markClosed = (): void => {
      if (lifecycle.closed) return;
      lifecycle.closed = true;
      lifecycle.resolveClosed();
    };
    // `exit` precedes stdio shutdown. A one-shot adapter may still receive the
    // last stdout chunks after it, so only `close` authorises buffer reset,
    // lifecycle replacement, or publication of `state: exited`.
    child.once('close', markClosed);
    return child;
  }

  async start(): Promise<void> {
    if (this.child) {
      throw new Error(`chat adapter for ${this.runtime} already started`);
    }

    const args = this.buildArgs();
    const child = this.launchChild(args, ['pipe', 'pipe', 'pipe']);

    this.child = child;

    this.resetStdoutFraming();
    child.stdout.on('data', (chunk: Buffer) => this.feedStdout(chunk));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      // Kept as a tail rather than streamed: these CLIs write progress noise to
      // stderr, and only the last of it is useful when explaining a crash.
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
    });

    child.on('error', (error: Error) => {
      this.emit({ t: 'error', message: `${this.runtime}: ${error.message}`, fatal: true });
      this.emit({ t: 'state', state: 'error' });
      const lifecycle = this.childLifecycle?.child === child
        ? this.childLifecycle
        : null;
      if (lifecycle && !lifecycle.spawned) {
        // ENOENT/EACCES before `spawn` proves there is no engine client and no
        // remote command. Still wait for Node's `close` event before declaring
        // the adapter gone so its stdio lifecycle cannot race replacement.
        this.exited = true;
        this.emit({ t: 'state', state: 'exited' });
      }
    });

    child.on('exit', (code, signal) => {
      this.exited = true;
      if (this.stopped) {
        this.emit({ t: 'state', state: 'exited' });
        return;
      }
      const detail = this.stderrTail.trim();
      const how = signal ? `signal ${signal}` : `code ${code}`;
      this.emit({
        t: 'error',
        message: detail
          ? `${this.runtime} exited (${how}): ${detail}`
          : `${this.runtime} exited (${how})`,
        fatal: true,
      });
      this.emit({ t: 'state', state: 'exited' });
    });

    await this.handshake();
  }

  /** Clear retained protocol bytes before a newly spawned stdout stream begins. */
  protected resetStdoutFraming(): void {
    this.clearStdoutLine(true);
    this.discardingStdoutLine = false;
  }

  private clearStdoutLine(release = false): void {
    this.stdoutBytes = 0;
    if (release || this.stdoutLine.length > RETAINED_PROTOCOL_BUFFER_BYTES) {
      this.stdoutLine = Buffer.alloc(0);
    }
  }

  /** Copy input into bounded owned storage; never retain a caller's Buffer view. */
  private appendStdoutSegment(segment: Buffer): void {
    const required = this.stdoutBytes + segment.length;
    if (required > this.stdoutLine.length) {
      const initial = Math.min(this.maxProtocolLineBytes, INITIAL_PROTOCOL_BUFFER_BYTES);
      const grown = this.stdoutLine.length > 0 ? this.stdoutLine.length * 2 : initial;
      const capacity = Math.min(this.maxProtocolLineBytes, Math.max(required, grown));
      const next = Buffer.allocUnsafe(capacity);
      if (this.stdoutBytes > 0) {
        this.stdoutLine.copy(next, 0, 0, this.stdoutBytes);
      }
      this.stdoutLine = next;
    }

    segment.copy(this.stdoutLine, this.stdoutBytes);
    this.stdoutBytes = required;
  }

  /**
   * Frame one runtime's UTF-8, newline-delimited JSON stream.
   *
   * Kept protected because the spawn-per-turn adapters own their stdout
   * listener but speak the same wire format. Strings are accepted for focused
   * protocol tests; production listeners leave stdout undecoded and pass exact
   * bytes so a multibyte code point split across chunks remains intact.
   */
  protected feedStdout(chunk: Buffer | string, source = this.runtime): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    let offset = 0;

    while (offset < bytes.length) {
      if (this.discardingStdoutLine) {
        const newline = bytes.indexOf(0x0a, offset);
        if (newline === -1) return;
        this.discardingStdoutLine = false;
        offset = newline + 1;
        continue;
      }

      const newline = bytes.indexOf(0x0a, offset);
      const end = newline === -1 ? bytes.length : newline;
      const segment = bytes.subarray(offset, end);

      if (this.stdoutBytes + segment.length > this.maxProtocolLineBytes) {
        this.clearStdoutLine();
        this.emit({
          t: 'error',
          message: `${source} sent an oversized line; discarded the buffer`,
        });
        if (newline === -1) {
          this.discardingStdoutLine = true;
          return;
        }
        offset = newline + 1;
        continue;
      }

      if (segment.length > 0) {
        this.appendStdoutSegment(segment);
      }
      if (newline === -1) return;

      const line = this.stdoutBytes > 0
        ? this.stdoutLine.toString('utf8', 0, this.stdoutBytes).trim()
        : '';
      this.clearStdoutLine();
      offset = newline + 1;
      if (!line) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Not every line is protocol: CLIs print banners and warnings on
        // stdout too. Dropping unparseable lines is correct; surfacing them
        // as errors would fill the transcript with startup chatter.
        continue;
      }

      try {
        this.handleMessage(parsed);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.emit({
          t: 'error',
          message: `${source} adapter failed to handle a message: ${message}`,
        });
      }
    }
  }

  protected writeLine(payload: unknown): void {
    if (!this.child || this.exited) return;
    const stdin = this.child.stdin;
    if (!stdin) {
      // Reachable only if a one-shot adapter (stdin closed, prompt in argv)
      // grew a protocol write. Reported rather than dropped: a protocol message
      // that silently goes nowhere is indistinguishable from the agent simply
      // never answering, which is the hardest kind of hang to find.
      this.emit({
        t: 'error',
        message: `${this.runtime}: cannot write to a child started without stdin`,
      });
      return;
    }
    stdin.write(`${JSON.stringify(payload)}\n`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const child = this.child;
    if (!child) return;
    try {
      // Absent for the one-shot adapters, which never opened one.
      child.stdin?.end();
    } catch {
      // Already closed; verified teardown below is what actually matters.
    }
    await this.terminateChild(child, 'SIGTERM');
  }

  /**
   * Await one particular launch, not whichever child a later one stored.
   * One-shot adapters call this from their exit/error handlers before making a
   * turn idle or allowing the next process to replace its lifecycle handle.
   */
  protected async waitForVerifiedClose(child: AdapterChild): Promise<void> {
    await this.settleChild(child);
  }

  /** Used by one-shot interrupt as well as whole-session stop. */
  protected async terminateChild(
    child: AdapterChild,
    signal: NodeJS.Signals = 'SIGTERM',
  ): Promise<void> {
    await this.settleChild(child, signal);
  }

  private async settleChild(
    child: AdapterChild,
    signal?: NodeJS.Signals,
  ): Promise<void> {
    const lifecycle = this.childLifecycle?.child === child
      ? this.childLifecycle
      : null;
    if (!lifecycle) {
      throw new Error(`${this.runtime}: cannot verify the child process lifecycle`);
    }
    if (lifecycle.stopPromise) return lifecycle.stopPromise;

    const attempt = (async () => {
      if (signal && !lifecycle.closed) {
        try {
          child.kill(signal);
        } catch {
          // The verified exit/close event below remains the authority.
        }
      }

      let escalate: ReturnType<typeof setTimeout> | null = null;
      let closeTimeout: ReturnType<typeof setTimeout> | null = null;
      const localStop = lifecycle.closed
        ? Promise.resolve()
        : Promise.race([
            lifecycle.closedPromise,
            new Promise<never>((_resolve, reject) => {
              if (signal) {
                escalate = setTimeout(() => {
                  if (!lifecycle.closed) {
                    try {
                      child.kill('SIGKILL');
                    } catch {
                      // A concurrent exit won the race.
                    }
                  }
                }, 5000);
                escalate.unref?.();
              }
              closeTimeout = setTimeout(() => {
                reject(new Error(
                  `${this.runtime}: could not verify that the local runtime client closed`,
                ));
              }, 10_000);
              closeTimeout.unref?.();
            }),
          ]).finally(() => {
            if (escalate) clearTimeout(escalate);
            if (closeTimeout) clearTimeout(closeTimeout);
          });

      // `spawn()` returning is not the `spawn` event. An immediate stop can
      // arrive in that gap; wait for either successful spawn or the definitive
      // pre-spawn error before deciding whether a remote command can exist.
      const spawned = lifecycle.spawnSettled
        ? lifecycle.spawned
        : await lifecycle.spawnOutcome;
      const remoteStop = spawned && lifecycle.processControl
        ? lifecycle.processControl.stop()
        : Promise.resolve();
      const [localResult, remoteResult] = await Promise.allSettled([
        localStop,
        remoteStop,
      ]);
      if (remoteResult.status === 'rejected') throw remoteResult.reason;
      if (localResult.status === 'rejected') throw localResult.reason;
      lifecycle.remoteVerified = true;
    })();

    lifecycle.stopPromise = attempt;
    try {
      await attempt;
    } catch (error) {
      if (lifecycle.stopPromise === attempt) lifecycle.stopPromise = null;
      throw error;
    }
  }
}

/**
 * Base for the two adapters that speak JSON-RPC 2.0 (ACP and codex app-server).
 *
 * Adds request/response correlation and, critically, server-to-client requests:
 * both protocols ask the *client* for things mid-turn — permission decisions,
 * file reads — and an adapter that only listens will deadlock the agent waiting
 * for an answer that never comes.
 */
export abstract class JsonRpcChatAdapter extends BaseChatAdapter {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  /** requestId -> the JSON-RPC id waiting on a permission answer. */
  protected readonly permissionWaiters = new Map<string, number | string>();

  protected call(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.writeLine({ jsonrpc: '2.0', id, method, params });
    });
  }

  protected notify(method: string, params?: unknown): void {
    this.writeLine({ jsonrpc: '2.0', method, params });
  }

  protected respond(id: number | string, result: unknown): void {
    this.writeLine({ jsonrpc: '2.0', id, result });
  }

  protected respondError(id: number | string, code: number, message: string): void {
    this.writeLine({ jsonrpc: '2.0', id, error: { code, message } });
  }

  /** Handle a request the agent made of us. Must always answer. */
  protected abstract handleServerRequest(
    id: number | string,
    method: string,
    params: Record<string, unknown>,
  ): void;

  /** Handle a notification the agent sent us. */
  protected abstract handleNotification(method: string, params: Record<string, unknown>): void;

  protected handleMessage(message: unknown): void {
    const rpc = message as {
      id?: number | string;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
      error?: { code: number; message: string };
    };

    if (rpc.method && rpc.id !== undefined) {
      this.handleServerRequest(rpc.id, rpc.method, rpc.params || {});
      return;
    }

    if (rpc.method) {
      this.handleNotification(rpc.method, rpc.params || {});
      return;
    }

    if (rpc.id !== undefined) {
      const waiter = this.pending.get(rpc.id as number);
      if (!waiter) return;
      this.pending.delete(rpc.id as number);
      if (rpc.error) {
        waiter.reject(new Error(rpc.error.message || 'request failed'));
      } else {
        waiter.resolve(rpc.result);
      }
    }
  }

  async stop(): Promise<void> {
    // Reject anything still in flight so callers awaiting a turn do not hang
    // forever on a process that is going away.
    for (const [, waiter] of this.pending) {
      waiter.reject(new Error(`${this.runtime} session stopped`));
    }
    this.pending.clear();
    await super.stop();
  }
}

/** Build a permission request with the fields every adapter must supply. */
export function permissionRequest(
  partial: Omit<PermissionRequest, 'ts'> & { ts?: number },
): PermissionRequest {
  return { ...partial, ts: partial.ts ?? Date.now() };
}
