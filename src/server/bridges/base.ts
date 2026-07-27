import { spawn as spawnPty, IPty } from '../services/pty.js';
import * as path from 'path';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import { UserEnvironment } from '../services/environments/types.js';
import { HostEnvironment } from '../services/environments/manager.js';

export interface BridgeSession {
  process: IPty;
  workingDir: string;
  created: Date;
  active: boolean;
  killTimeout: ReturnType<typeof setTimeout> | null;
  stopRequested: boolean;
  finalized: boolean;
}

export interface SessionInfo {
  id: string;
  workingDir: string;
  created: Date;
  active: boolean;
}

export interface StartSessionOptions {
  workingDir?: string;
  /**
   * Where this agent runs. Absent means the host, which is what every caller
   * passed before per-user environments existed.
   */
  environment?: UserEnvironment;
  dangerouslySkipPermissions?: boolean;
  /**
   * Free-text model id from the active runtime profile. Passed via the
   * bridge's model flag, or ignored when the CLI has none.
   */
  model?: string;
  /** Extra CLI arguments from the active runtime profile, appended last. */
  extraArgs?: string[];
  /** Environment variables from the active runtime profile. */
  env?: Record<string, string>;
  onOutput?: (data: string) => void;
  onExit?: (exitCode: number, signal: number) => void;
  onError?: (error: Error) => void;
  cols?: number;
  rows?: number;
}

export abstract class BaseBridge {
  protected sessions: Map<string, BridgeSession> = new Map();
  protected resolvedCommand: string;

  constructor() {
    this.resolvedCommand = this.findCommand(this.getCommandCandidates());
  }

  /** Return ordered list of command paths/names to try. */
  protected abstract getCommandCandidates(): string[];

  /** Return the fallback command name when none of the candidates are found. */
  protected abstract getDefaultCommand(): string;

  /**
   * The CLI's plain name, for callers that must not use a host path.
   *
   * A container resolves the command through the image's PATH; the absolute
   * path this bridge found on the server's own filesystem would simply not be
   * there. Public because chat sessions need it and they do not extend this.
   */
  get defaultCommand(): string {
    return this.getDefaultCommand();
  }

  /** Return a human-readable name for log messages (e.g. "Claude", "Codex"). */
  protected abstract getDisplayName(): string;

  /** Build the argument list for spawning the process. */
  protected abstract getArgs(options: StartSessionOptions): string[];

  /**
   * The flag this CLI uses to pin a model, or null when it has none.
   *
   * Only ever a flag *name*: the value is whatever the user typed, so this
   * stays provider-agnostic. Bridges that return null still honour a profile's
   * `args`, which is the escape hatch for a CLI that spells it differently.
   */
  protected getModelFlag(): string | null {
    return null;
  }

  /**
   * Full argument list: the bridge's own arguments, then the profile's model,
   * then the profile's extra arguments.
   *
   * Profile arguments come last so they can override an earlier flag on CLIs
   * that take last-one-wins, and so the bridge's safety-relevant choices (the
   * approval-bypass flag above all) are never silently displaced by a value
   * typed into Settings.
   */
  protected buildArgs(options: StartSessionOptions): string[] {
    const args = [...this.getArgs(options)];

    const modelFlag = this.getModelFlag();
    if (options.model && modelFlag) {
      args.push(modelFlag, options.model);
    }

    if (options.extraArgs?.length) {
      args.push(...options.extraArgs);
    }

    return args;
  }

  /**
   * Hook called on every chunk of process output.
   * Subclasses can override to implement prompt auto-accept or similar logic.
   * The default implementation is a no-op.
   */
  protected onSessionData(
    _sessionId: string,
    _data: string,
    _dataBuffer: string,
  ): void {
    // no-op by default
  }

  protected findCommand(possibleCommands: string[]): string {
    for (const cmd of possibleCommands) {
      try {
        if (fs.existsSync(cmd) || this.commandExists(cmd)) {
          console.log(`Found ${this.getDisplayName()} command at: ${cmd}`);
          return cmd;
        }
      } catch {
        continue;
      }
    }

    const fallback = this.getDefaultCommand();
    console.error(
      `${this.getDisplayName()} command not found, using default "${fallback}"`,
    );
    return fallback;
  }

  protected commandExists(command: string): boolean {
    try {
      execFileSync('which', [command], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  async startSession(
    sessionId: string,
    options: StartSessionOptions = {},
  ): Promise<BridgeSession> {
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} already exists`);
    }

    const {
      workingDir = process.cwd(),
      dangerouslySkipPermissions = false,
      onOutput = () => {},
      onExit = () => {},
      onError = () => {},
      cols = 80,
      rows = 24,
      env: profileEnv,
    } = options;

    try {
      const displayName = this.getDisplayName();

      console.log(`Starting ${displayName} session ${sessionId}`);
      console.log(`Command: ${this.resolvedCommand}`);
      console.log(`Working directory: ${workingDir}`);
      console.log(`Terminal size: ${cols}x${rows}`);

      if (dangerouslySkipPermissions) {
        console.log(
          `WARNING: Skipping permissions for ${displayName} session ${sessionId}`,
        );
      }

      // Built from the *resolved* options: `workingDir` defaults above, and a
      // bridge that reasons about the directory it is launched in (omp does)
      // must see the directory the PTY will actually get, not `undefined`.
      const args = this.buildArgs({ ...options, workingDir });

      if (args.length) {
        console.log(`Args: ${args.join(' ')}`);
      }

      // The environment decides *where* this runs; on the host it is the
      // identity, so this is the same spawn it has always been.
      const environment = options.environment || new HostEnvironment(workingDir);
      // `resolvedCommand` is an absolute path found on *this* machine at
      // construction time. Inside a container it is very likely a path that
      // does not exist, so the plain name is used and the image's own PATH
      // resolves it — which is also what makes the base image the place where
      // an administrator decides which agents exist.
      const command = environment.kind === 'container'
        ? this.getDefaultCommand()
        : this.resolvedCommand;
      const launch = environment.wrap(command, args, {
        cwd: workingDir,
        env: {
          // Profile variables sit between the inherited environment and the
          // terminal settings: they may override an inherited value (that is
          // the point) but never TERM/COLORTERM, which describe this PTY rather
          // than the user's preference and would corrupt rendering if changed.
          ...(profileEnv || {}),
          TERM: 'xterm-256color',
          FORCE_COLOR: '1',
          COLORTERM: 'truecolor',
        },
        tty: true,
      });

      const ptyProcess = spawnPty(launch.command, launch.args, {
        // In a container the engine sets the working directory itself, and the
        // host path means nothing to the engine client.
        cwd: environment.kind === 'container' ? undefined : workingDir,
        env: launch.env,
        cols,
        rows,
        name: 'xterm-color',
      });

      const session: BridgeSession = {
        process: ptyProcess,
        workingDir,
        created: new Date(),
        active: true,
        killTimeout: null,
        stopRequested: false,
        finalized: false,
      };

      this.sessions.set(sessionId, session);

      let dataBuffer = '';

      ptyProcess.onData((data: string) => {
        if (process.env.DEBUG) {
          console.log(`${displayName} session ${sessionId} output:`, data);
        }

        dataBuffer += data;

        // Let the subclass react to data (e.g. trust prompt handling)
        this.onSessionData(sessionId, data, dataBuffer);

        // Prevent memory issues by trimming the buffer
        if (dataBuffer.length > 10000) {
          dataBuffer = dataBuffer.slice(-5000);
        }

        onOutput(data);
      });

      ptyProcess.onExit(({ exitCode, signal }) => {
        if (!this.finalizeSession(sessionId, session)) {
          return;
        }

        console.log(
          `${displayName} session ${sessionId} exited with code ${exitCode}, signal ${signal}`,
        );
        onExit(exitCode ?? 0, signal ?? 0);
      });

      (ptyProcess as any).on('error', (error: Error) => {
        if (this.shouldIgnorePtyError(session, error)) {
          return;
        }

        if (!this.finalizeSession(sessionId, session)) {
          return;
        }

        console.error(
          `${displayName} session ${sessionId} error:`,
          error,
        );
        onError(error);
      });

      console.log(
        `${displayName} session ${sessionId} started successfully`,
      );
      return session;
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      console.error(
        `Failed to start ${this.getDisplayName()} session ${sessionId}:`,
        error,
      );
      throw new Error(
        `Failed to start ${this.getDisplayName()}: ${message}`,
      );
    }
  }

  async sendInput(sessionId: string, data: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.active) {
      throw new Error(`Session ${sessionId} not found or not active`);
    }

    try {
      session.process.write(data);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to send input to session ${sessionId}: ${message}`,
      );
    }
  }

  async resize(
    sessionId: string,
    cols: number,
    rows: number,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.active) {
      throw new Error(`Session ${sessionId} not found or not active`);
    }

    try {
      session.process.resize(cols, rows);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      console.warn(`Failed to resize session ${sessionId}:`, message);
    }
  }

  async stopSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    try {
      if (session.killTimeout) {
        clearTimeout(session.killTimeout);
        session.killTimeout = null;
      }

      if (session.active && session.process) {
        session.stopRequested = true;
        session.active = false;
        session.process.kill('SIGTERM');

        session.killTimeout = setTimeout(() => {
          if (!session.finalized && session.process) {
            try {
              session.process.kill('SIGKILL');
            } catch {
              // Process is already gone.
            }
          }
        }, 5000);
        session.killTimeout.unref?.();
      }
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      console.warn(`Error stopping session ${sessionId}:`, message);
    }

    session.stopRequested = true;
    session.active = false;

    // Free the id now rather than when the PTY finally dies, so restarting the
    // same session immediately after a stop does not hit "already exists".
    // The captured `session` object keeps the kill timer and exit handlers
    // working, and finalizeSession only deletes an entry it still owns.
    if (this.sessions.get(sessionId) === session) {
      this.sessions.delete(sessionId);
    }
  }

  /**
   * The executable this bridge resolved at construction.
   *
   * Exposed so chat mode can spawn the same binary the terminal mode would.
   * The lookup walks a runtime-specific candidate list and is not something to
   * repeat in a second place, where it would drift the first time a CLI moves.
   */
  get command(): string {
    return this.resolvedCommand;
  }

  getSession(sessionId: string): BridgeSession | undefined {
    return this.sessions.get(sessionId);
  }

  getAllSessions(): SessionInfo[] {
    return Array.from(this.sessions.entries()).map(
      ([id, session]) => ({
        id,
        workingDir: session.workingDir,
        created: session.created,
        active: session.active,
      }),
    );
  }

  async cleanup(): Promise<void> {
    const sessionIds = Array.from(this.sessions.keys());
    for (const sessionId of sessionIds) {
      await this.stopSession(sessionId);
    }
  }

  private finalizeSession(
    sessionId: string,
    session: BridgeSession,
  ): boolean {
    if (session.finalized) {
      return false;
    }

    session.finalized = true;

    if (session.killTimeout) {
      clearTimeout(session.killTimeout);
      session.killTimeout = null;
    }

    session.active = false;
    // Only drop the map entry if it still belongs to this run: a restart under
    // the same id must survive the previous run's late exit.
    if (this.sessions.get(sessionId) === session) {
      this.sessions.delete(sessionId);
    }
    return true;
  }

  private shouldIgnorePtyError(
    session: BridgeSession,
    error: Error,
  ): boolean {
    const errno = error as NodeJS.ErrnoException;
    const message = errno.message || '';

    return (
      errno.code === 'EIO' ||
      (session.stopRequested &&
        (errno.code === 'EOF' ||
          errno.code === 'ERR_STREAM_DESTROYED' ||
          message.includes('read EIO')))
    );
  }
}
