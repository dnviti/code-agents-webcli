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
  skipped?: boolean;
  error?: string;
}

/**
 * The two things that dial into a session's socket.
 *
 * One socket, two kinds of caller: the PreToolUse hook asking whether a tool may
 * run, and the MCP server asking the user a question. They are kept apart here
 * rather than being squeezed into one decider because the answers have nothing
 * in common — a boolean with a reason versus a list of chosen labels — and a
 * union that had to be narrowed at every call site would be worse than two
 * fields.
 */
export interface BrokerHandlers {
  permission: (ask: PermissionAsk) => Promise<PermissionAnswer>;
  question: (ask: QuestionAsk) => Promise<QuestionReply>;
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
    socket.on('close', () => this.open.delete(socket));
    socket.on('error', () => this.open.delete(socket));

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

  private handle(socket: net.Socket, line: string): void {
    let payload: { id?: string; kind?: string; ask?: PermissionAsk; question?: QuestionAsk };
    try {
      payload = JSON.parse(line);
    } catch {
      return;
    }

    const id = payload.id;
    if (!id) return;

    const reply = (answer: PermissionAnswer | QuestionReply): void => {
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
      handlers
        .question(question)
        .then(reply)
        .catch((error: unknown) => {
          reply({ labels: [], error: describeError(error) });
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
    }
    this.open.clear();

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
export function permissionHookSettings(hookScript: string, socketPath: string): string {
  return JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'command',
              command: `${process.execPath} ${JSON.stringify(hookScript)}`,
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
