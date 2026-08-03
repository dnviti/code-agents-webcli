import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

/**
 * The approval channel for runtimes that gate tools through an external hook.
 *
 * Claude Code has no permission round-trip on its stream-json channel — a
 * headless session simply runs the tool. What it does have is `PreToolUse`
 * hooks, and a hook can refuse: verified against 2.1.220, a hook returning
 * `permissionDecision: "deny"` blocks the call and the agent receives an error
 * tool result, *even when the session is running in bypassPermissions mode*.
 * That makes the hook a stronger enforcement point than any permission flag,
 * and it is the mechanism this broker exposes to the browser.
 *
 * The hook itself is a short-lived process the CLI spawns, so it needs a way to
 * reach the session that owns the conversation. That is this: a unix socket per
 * chat session, in the app's own data directory, mode 0600. A socket rather
 * than a loopback port because there is no port to collide with, nothing to
 * firewall, and the filesystem already expresses "only this user" — which is
 * the entire access rule we want.
 */

export interface PermissionAsk {
  toolName: string;
  toolInput: unknown;
  toolUseId?: string;
  cwd?: string;
}

export interface PermissionAnswer {
  allow: boolean;
  /** Shown to the agent when refused, so it can adapt rather than retry blindly. */
  reason?: string;
}

/**
 * A question the model asked, as it arrives off the socket.
 *
 * `unknown` on purpose at this layer: the shape is whatever the model passed to
 * the MCP tool, and validating it is the session's job — the broker only routes.
 */
export interface QuestionAsk {
  question?: unknown;
  header?: unknown;
  multiSelect?: unknown;
  options?: unknown;
}

/** What the browser answered, on its way back to the waiting tool call. */
export interface QuestionReply {
  labels: string[];
  /**
   * What the user typed, when they answered in their own words rather than —
   * or as well as — picking. Beside the labels because it is not one of them:
   * a label is an option the model wrote, and this is the user's own sentence.
   */
  text?: string;
  skipped?: boolean;
  error?: string;
}

/**
 * The agent asking to answer from a stronger model than its rung.
 *
 * `unknown` for the same reason `QuestionAsk` is: the shape is whatever the
 * model passed to the tool, and the broker only routes.
 */
export interface TierAsk {
  reason?: unknown;
}

/** What the session decided, on its way back to the waiting tool call. */
export interface TierReply {
  granted: boolean;
  /** The rung now in force, when one was granted. */
  tier?: string;
  model?: string;
  /** The sentence the model reads — a grant, a refusal, or why neither. */
  detail: string;
}

export interface PlanAsk {
  markdown?: unknown;
}

export interface PlanReply {
  accepted: boolean;
  revision?: number;
  detail: string;
}

/**
 * The three things that dial into a session's socket.
 *
 * One socket, three kinds of caller: the PreToolUse hook asking whether a tool
 * may run, the MCP server asking the user a question, and the agent asking to
 * move up a rung. They are kept apart here rather than being squeezed into one
 * decider because the answers have nothing in common — a boolean with a reason,
 * a list of chosen labels, a rung and a model — and a union that had to be
 * narrowed at every call site would be worse than three fields.
 */
export interface BrokerHandlers {
  permission: (ask: PermissionAsk) => Promise<PermissionAnswer>;
  /**
   * A question, and a signal that fires if the caller gives up on it.
   *
   * The signal is the honest half. A `tools/call` blocks a runtime's MCP client,
   * and a client that has stopped waiting says so — kimi sends
   * `notifications/cancelled`, which arrives here as a cancel line. Without it
   * the card stayed on screen offering buttons whose answer had nowhere left to
   * go (#174).
   */
  question: (ask: QuestionAsk, signal?: AbortSignal) => Promise<QuestionReply>;
  tier: (ask: TierAsk) => Promise<TierReply>;
  /** Complete Plan-mode markdown submitted by the model. */
  plan?: (ask: PlanAsk) => Promise<PlanReply>;
}

/**
 * How long a unix socket path may actually be.
 *
 * `bind()` copies the path into `sockaddr_un.sun_path`, a fixed array of 108
 * bytes on Linux and 104 on macOS and the BSDs — one of which is the trailing
 * NUL. Exceed it and the kernel rejects the address; Node reports that as
 * `EINVAL`, which reads like a malformed argument rather than a length limit
 * and is exactly why it was mistaken for one. 103 is the portable floor, so a
 * path that fits here fits everywhere this server runs.
 */
const MAX_SOCKET_PATH_BYTES = 103;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function socketPathFits(candidate: string): boolean {
  return Buffer.byteLength(candidate, 'utf8') <= MAX_SOCKET_PATH_BYTES;
}

export class PermissionBroker {
  private server: net.Server | null = null;
  private socketPath = '';
  /** Set only when the socket had to be placed outside `socketDir`. */
  private tempDir: string | null = null;
  private handlers: BrokerHandlers | null = null;
  private readonly open = new Set<net.Socket>();
  /**
   * Questions still in flight, so a later cancel line can find its own.
   *
   * Keyed by the id the caller minted, which is the only name the two sides
   * share: the session's request id is created after this point and is never
   * sent back down the socket.
   */
  private readonly askedQuestions = new Map<net.Socket, Map<string, AbortController>>();

  constructor(private readonly socketDir: string) {}

  get path(): string {
    return this.socketPath;
  }

  get active(): boolean {
    return this.server !== null;
  }

  /**
   * Start listening and return the socket path to hand to the runtime.
   *
   * The filename carries random bytes rather than the session id: the id is
   * knowable by anyone who can list the user's sessions, and while the
   * directory mode already stops another account from connecting, there is no
   * reason to make the path guessable by whatever else runs as this user.
   */
  async listen(handlers: BrokerHandlers): Promise<string> {
    if (this.server) return this.socketPath;

    this.handlers = handlers;
    this.socketPath = this.reservePath();

    const server = net.createServer((socket) => this.accept(socket));
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.socketPath, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    fs.chmodSync(this.socketPath, 0o600);
    server.on('error', () => {
      // A listener error after startup means the socket is unusable; the hook
      // will fail closed on its next connect, which is the safe direction.
    });

    return this.socketPath;
  }

  /**
   * Choose a path the kernel will actually accept, and create its directory.
   *
   * The data directory is wherever the user pointed `--data-dir`, and it can be
   * arbitrarily deep — deep enough on its own to blow the 103-byte budget above
   * before this adds a single character. So the preferred location is tried
   * first and a private `mkdtemp` under the OS temp directory is the fallback:
   * still 0700, still unguessable, and short by construction. Falling back is
   * strictly better than the alternative, which is the session refusing to
   * start at all with a message about an invalid argument.
   */
  private reservePath(): string {
    // 8 random bytes rather than the session id: the id is knowable by anyone
    // who can list the user's sessions, and while the directory mode already
    // stops another account from connecting, there is no reason to make the
    // path guessable by whatever else runs as this user.
    const name = `p${crypto.randomBytes(8).toString('hex')}.sock`;

    const preferred = path.join(this.socketDir, name);
    if (socketPathFits(preferred)) {
      fs.mkdirSync(this.socketDir, { recursive: true, mode: 0o700 });
      // mkdir's mode is subject to umask, so it is set explicitly afterwards.
      fs.chmodSync(this.socketDir, 0o700);
      return preferred;
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccweb-'));
    fs.chmodSync(dir, 0o700);
    this.tempDir = dir;

    const fallback = path.join(dir, name);
    if (!socketPathFits(fallback)) {
      // Only reachable if TMPDIR itself is pathological. Say so plainly rather
      // than letting bind() answer with EINVAL again.
      fs.rmSync(dir, { recursive: true, force: true });
      this.tempDir = null;
      throw new Error(
        `no room for an approval socket: even ${fallback} exceeds the ` +
          `${MAX_SOCKET_PATH_BYTES}-byte unix socket path limit. Set TMPDIR to a shorter path.`,
      );
    }

    return fallback;
  }

  private accept(socket: net.Socket): void {
    this.open.add(socket);
    socket.on('close', () => this.releaseSocket(socket));
    socket.on('error', () => this.releaseSocket(socket));

    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let at: number;
      while ((at = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (!line) continue;
        this.handle(socket, line);
      }
    });
  }

  /** A caller going away cancels only the questions that arrived on its socket. */
  private releaseSocket(socket: net.Socket): void {
    this.open.delete(socket);
    const questions = this.askedQuestions.get(socket);
    if (!questions) return;
    this.askedQuestions.delete(socket);
    for (const abort of questions.values()) abort.abort();
  }

  private handle(socket: net.Socket, line: string): void {
    let payload: {
      id?: string;
      kind?: string;
      ask?: PermissionAsk;
      question?: QuestionAsk;
      tier?: TierAsk;
      plan?: PlanAsk;
    };
    try {
      payload = JSON.parse(line);
    } catch {
      return;
    }

    const id = payload.id;
    if (!id) return;

    const reply = (answer: PermissionAnswer | QuestionReply | TierReply | PlanReply): void => {
      if (socket.destroyed) return;
      socket.write(`${JSON.stringify({ id, ...answer })}\n`);
    };

    const handlers = this.handlers;

    // A question from the MCP server. Note the opposite failure direction from
    // an approval below: nothing is gated on the answer, so a question that
    // cannot be asked comes back as an error the model can route around rather
    // than as a refusal, and never as silence.
    if (payload.kind === 'question') {
      const question = payload.question ?? {};
      if (!handlers) {
        reply({ labels: [], error: 'this session is not accepting questions' });
        return;
      }
      const abort = new AbortController();
      let questions = this.askedQuestions.get(socket);
      if (!questions) {
        questions = new Map();
        this.askedQuestions.set(socket, questions);
      }
      // Reusing an id on one connection supersedes only that connection's old
      // call. Another runtime-side client may legitimately mint the same id.
      questions.get(id)?.abort();
      questions.set(id, abort);
      handlers
        .question(question, abort.signal)
        .then(reply)
        .catch((error: unknown) => {
          reply({ labels: [], error: describeError(error) });
        })
        .finally(() => {
          const current = this.askedQuestions.get(socket);
          if (current?.get(id) === abort) current.delete(id);
          if (current?.size === 0) this.askedQuestions.delete(socket);
        });
      return;
    }

    // The caller has stopped waiting for one of its own questions. No reply
    // goes back: the `tools/call` this belongs to is already over on the other
    // side, and writing to it would be answering nobody. What it is for is the
    // card, which the session takes down when the signal fires.
    if (payload.kind === 'cancel') {
      const questions = this.askedQuestions.get(socket);
      questions?.get(id)?.abort();
      questions?.delete(id);
      if (questions?.size === 0) this.askedQuestions.delete(socket);
      return;
    }

    // A request to move up a rung. Failing closed like an approval rather than
    // open like a question, and for the same reason an approval does: the thing
    // being asked for costs real money on a more expensive model, so silence
    // has to mean "no" — but with a sentence, because an agent told only "no"
    // will ask again.
    if (payload.kind === 'tier') {
      if (!handlers) {
        reply({ granted: false, detail: 'this conversation is not running on a ladder' });
        return;
      }
      handlers
        .tier(payload.tier ?? {})
        .then(reply)
        .catch((error: unknown) => {
          reply({ granted: false, detail: `the request failed: ${describeError(error)}` });
        });
      return;
    }

    if (payload.kind === 'plan') {
      if (!handlers?.plan) {
        reply({ accepted: false, detail: 'this session is not accepting Plan documents' });
        return;
      }
      handlers.plan(payload.plan ?? {}).then(reply).catch((error: unknown) => {
        reply({ accepted: false, detail: `the plan could not be stored: ${describeError(error)}` });
      });
      return;
    }

    const ask = payload.ask;
    if (!ask) return;

    if (!handlers) {
      reply({ allow: false, reason: 'the approval channel is not accepting decisions' });
      return;
    }

    handlers
      .permission(ask)
      .then(reply)
      .catch((error: unknown) => {
        // Failing closed: an approval that cannot be asked has not been given.
        reply({ allow: false, reason: `approval failed: ${describeError(error)}` });
      });
  }

  close(): void {
    for (const socket of this.open) {
      socket.destroy();
      this.releaseSocket(socket);
    }
    this.open.clear();
    this.askedQuestions.clear();

    if (this.server) {
      this.server.close();
      this.server = null;
    }

    if (this.socketPath) {
      try {
        fs.unlinkSync(this.socketPath);
      } catch {
        // Already gone, or never created.
      }
      this.socketPath = '';
    }

    if (this.tempDir) {
      try {
        fs.rmSync(this.tempDir, { recursive: true, force: true });
      } catch {
        // A leftover empty directory in the temp dir is not worth reporting.
      }
      this.tempDir = null;
    }
  }
}

/**
 * Session-scoped settings that install the approval hook.
 *
 * Passed to the CLI as `--settings <json>`, which layers on top of the user's
 * own configuration for this run only. Nothing is written to the user's
 * ~/.claude directory: their hooks, their permissions and their settings file
 * are left exactly as they were, which matters because this app is not the only
 * thing using that CLI.
 *
 * `timeout` is generous on purpose. The hook blocks until a person answers, and
 * the CLI kills a hook that overruns — a short timeout would silently turn "the
 * user stepped away" into "the tool was refused".
 */
export function permissionHookSettings(
  hookScript: string,
  socketPath: string,
  /** See the note on `askMcpConfig`: the runtime may not be on this machine. */
  nodePath: string = process.execPath,
): string {
  return JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'command',
              command: `${nodePath} ${JSON.stringify(hookScript)}`,
              timeout: 3600,
            },
          ],
        },
      ],
    },
    env: {
      CCWEB_PERMISSION_SOCKET: socketPath,
    },
  });
}
