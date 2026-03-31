import { spawn as spawnPty, IPty } from 'node-pty';
import * as path from 'path';
import * as fs from 'fs';
import { execFileSync } from 'child_process';

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
  dangerouslySkipPermissions?: boolean;
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

  /** Return a human-readable name for log messages (e.g. "Claude", "Codex"). */
  protected abstract getDisplayName(): string;

  /** Build the argument list for spawning the process. */
  protected abstract getArgs(options: StartSessionOptions): string[];

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

      const args = this.getArgs(options);

      const ptyProcess = spawnPty(this.resolvedCommand, args, {
        cwd: workingDir,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          FORCE_COLOR: '1',
          COLORTERM: 'truecolor',
        },
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
            session.process.kill('SIGKILL');
          }
        }, 5000);
      }
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      console.warn(`Error stopping session ${sessionId}:`, message);
    }

    session.stopRequested = true;
    session.active = false;
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
    this.sessions.delete(sessionId);
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
