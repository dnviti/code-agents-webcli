import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
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

type Decider = (ask: PermissionAsk) => Promise<PermissionAnswer>;

export class PermissionBroker {
  private server: net.Server | null = null;
  private socketPath = '';
  private decide: Decider | null = null;
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
  async listen(decide: Decider): Promise<string> {
    if (this.server) return this.socketPath;

    this.decide = decide;
    fs.mkdirSync(this.socketDir, { recursive: true, mode: 0o700 });
    // mkdir's mode is subject to umask, so it is set explicitly afterwards.
    fs.chmodSync(this.socketDir, 0o700);

    this.socketPath = path.join(
      this.socketDir,
      `perm-${crypto.randomBytes(12).toString('hex')}.sock`,
    );

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
    let payload: { id?: string; ask?: PermissionAsk };
    try {
      payload = JSON.parse(line);
    } catch {
      return;
    }

    const id = payload.id;
    const ask = payload.ask;
    if (!id || !ask) return;

    const reply = (answer: PermissionAnswer): void => {
      if (socket.destroyed) return;
      socket.write(`${JSON.stringify({ id, ...answer })}\n`);
    };

    const decide = this.decide;
    if (!decide) {
      reply({ allow: false, reason: 'the approval channel is not accepting decisions' });
      return;
    }

    decide(ask)
      .then(reply)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        // Failing closed: an approval that cannot be asked has not been given.
        reply({ allow: false, reason: `approval failed: ${message}` });
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
