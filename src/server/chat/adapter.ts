import { spawn, ChildProcessByStdio, ChildProcessWithoutNullStreams } from 'child_process';
import { Readable } from 'stream';
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
  /** Resolved executable for the runtime, from the existing bridge lookup. */
  command: string;
  /** Model from the active runtime profile, if any. */
  model?: string;
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
}

export interface ChatAdapter {
  readonly runtime: string;
  readonly capabilities: ChatCapabilities;
  /** Launch the runtime and complete whatever handshake it requires. */
  start(): Promise<void>;
  /** Queue a user turn. Resolves when the runtime has accepted it, not when it replies. */
  send(turn: UserTurn): Promise<void>;
  /** Cancel the running turn, leaving the session alive. */
  interrupt(): Promise<void>;
  /** Answer a pending approval. */
  respondPermission(requestId: string, optionId: string): void;
  /** Switch model mid-session, for runtimes that allow it. */
  setModel?(model: string): Promise<void>;
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
  protected stdoutBuffer = '';
  protected stderrTail = '';
  protected stopped = false;
  protected exited = false;

  constructor(protected readonly options: ChatAdapterOptions) {}

  get alive(): boolean {
    return Boolean(this.child) && !this.exited;
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
    this.options.emit({ ...event, ts: event.ts ?? Date.now() } as AdapterEvent);
  }

  async start(): Promise<void> {
    if (this.child) {
      throw new Error(`chat adapter for ${this.runtime} already started`);
    }

    const args = this.buildArgs();
    const child = spawn(this.options.command, args, {
      cwd: this.options.workingDir,
      env: {
        ...process.env,
        ...(this.options.env || {}),
        // These CLIs check for a TTY to decide whether to draw a TUI and to
        // colour their output. We want neither: chat mode reads the structured
        // stream, and ANSI in a JSON string is noise the UI would have to strip.
        NO_COLOR: '1',
        TERM: 'dumb',
        FORCE_COLOR: '0',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      // Kept as a tail rather than streamed: these CLIs write progress noise to
      // stderr, and only the last of it is useful when explaining a crash.
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
    });

    child.on('error', (error: Error) => {
      this.exited = true;
      this.emit({ t: 'error', message: `${this.runtime}: ${error.message}`, fatal: true });
      this.emit({ t: 'state', state: 'error' });
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

  private onStdout(chunk: string): void {
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
          message: `${this.runtime} adapter failed to handle a message: ${message}`,
        });
      }
    }

    // A runtime that never emits a newline would otherwise grow this without
    // bound; past a megabyte the stream is not line-delimited JSON at all.
    if (this.stdoutBuffer.length > 1_000_000) {
      this.stdoutBuffer = '';
      this.emit({
        t: 'error',
        message: `${this.runtime} sent an oversized line; discarded the buffer`,
      });
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
    if (!child || this.exited) return;

    try {
      // Absent for the one-shot adapters, which never opened one.
      child.stdin?.end();
    } catch {
      // Already closed; the kill below is what actually matters.
    }

    child.kill('SIGTERM');
    // Same escalation the PTY bridge uses, for the same reason: a runtime
    // mid-tool-call can ignore SIGTERM, and a session that will not die blocks
    // the id from being reused.
    const escalate = setTimeout(() => {
      if (!this.exited) {
        try {
          child.kill('SIGKILL');
        } catch {
          // Gone between the check and the call.
        }
      }
    }, 5000);
    escalate.unref?.();
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
