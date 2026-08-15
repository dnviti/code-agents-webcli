import { spawn as spawnPty, IPty } from '../services/runtime/terminal/pty.js';
import * as path from 'path';
import * as fs from 'fs';
import {
  execFileSync as defaultExecFileSync,
  type ExecFileSyncOptionsWithStringEncoding,
} from 'child_process';
import {
  UserEnvironment,
  WrappedProcessControl,
} from '../services/environments/types.js';
import { HostEnvironment, wrapHostCommand } from '../services/environments/manager.js';

type ExecFileText = (
  file: string,
  args: readonly string[],
  options: ExecFileSyncOptionsWithStringEncoding,
) => string;

export interface BaseBridgeOptions {
  /** Injectable for deterministic Windows resolution tests. */
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  existsSync?: (candidate: string) => boolean;
  execFileSync?: ExecFileText;
}

export interface BridgeSession {
  process: IPty;
  workingDir: string;
  created: Date;
  active: boolean;
  killTimeout: ReturnType<typeof setTimeout> | null;
  closeTimeout: ReturnType<typeof setTimeout> | null;
  stopRequested: boolean;
  finalized: boolean;
  clientExited: boolean;
  closed: Promise<void>;
  resolveClosed: () => void;
  stopPromise: Promise<void> | null;
  processControl?: WrappedProcessControl;
  terminalEvent:
    | { kind: 'exit'; exitCode: number; signal: number }
    | { kind: 'error'; error: Error }
    | null;
  onExit: (exitCode: number, signal: number) => void;
  onError: (error: Error) => void;
}

export interface SessionInfo {
  id: string;
  workingDir: string;
  created: Date;
  active: boolean;
}

export interface StartSessionOptions {
  workingDir?: string;
  /** Whether workingDir is already an absolute path inside the container. */
  cwdKind?: 'host' | 'container';
  /**
   * Where this agent runs. Absent means the host, which is what every caller
   * passed before per-user environments existed.
   */
  environment?: UserEnvironment;
  /**
   * Exact executable selected for this launch.
   *
   * Agent maintenance resolves this from the session's execution environment
   * immediately before spawning. Absent keeps the historical bridge lookup.
   */
  command?: string;
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
  protected readonly platform: NodeJS.Platform;
  protected readonly hostEnv: NodeJS.ProcessEnv;
  private readonly pathExists: (candidate: string) => boolean;
  private readonly execFile: ExecFileText;

  constructor(options: BaseBridgeOptions = {}) {
    this.platform = options.platform || process.platform;
    this.hostEnv = options.env || process.env;
    this.pathExists = options.existsSync || fs.existsSync;
    this.execFile = options.execFileSync || defaultExecFileSync;
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
        const resolved = this.pathExists(cmd) ? cmd : this.locateCommand(cmd);
        if (resolved) {
          console.log(`Found ${this.getDisplayName()} command at: ${resolved}`);
          return resolved;
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
    return this.locateCommand(command) !== null;
  }

  /** Resolve the real Windows shim path; a boolean is not enough to launch it. */
  private locateCommand(command: string): string | null {
    try {
      const output = this.execFile(
        this.platform === 'win32' ? 'where.exe' : 'which',
        [command],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
      );
      if (this.platform !== 'win32') return command;
      for (const line of String(output).split(/\r?\n/)) {
        const candidate = line.trim().replace(/^"|"$/g, '');
        const extension = path.win32.extname(candidate).toLowerCase();
        if (['.exe', '.com', '.cmd', '.bat'].includes(extension)) return candidate;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Run a synchronous probe through the same Windows shim rules as a session. */
  protected resolvedCommandOutput(
    args: string[],
    options: ExecFileSyncOptionsWithStringEncoding,
  ): string {
    const launch = wrapHostCommand(this.resolvedCommand, args, this.platform, this.hostEnv);
    return this.execFile(launch.command, launch.args, {
      ...options,
      ...(launch.envPatch ? {
        env: { ...(options.env || this.hostEnv), ...launch.envPatch },
      } : {}),
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
    } as ExecFileSyncOptionsWithStringEncoding);
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
      console.log(`Command: ${options.command || this.resolvedCommand}`);
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
      const command = options.command || (environment.kind === 'container'
        ? this.getDefaultCommand()
        : this.resolvedCommand);
      const launch = environment.wrap(command, args, {
        cwd: workingDir,
        cwdKind: options.cwdKind,
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
        trackProcess: true,
      });
      if (environment.kind === 'container' && !launch.processControl) {
        throw new Error('Container environment did not provide verified process control');
      }

      const ptyProcess = spawnPty(launch.command, launch.windowsVerbatimArguments ? launch.args.join(' ') : launch.args, {
        // In a container the engine sets the working directory itself, and the
        // host path means nothing to the engine client.
        cwd: environment.kind === 'container' ? undefined : workingDir,
        env: launch.env,
        cols,
        rows,
        name: 'xterm-color',
      });

      let resolveClosed!: () => void;
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      const session: BridgeSession = {
        process: ptyProcess,
        workingDir,
        created: new Date(),
        active: true,
        killTimeout: null,
        closeTimeout: null,
        stopRequested: false,
        finalized: false,
        clientExited: false,
        closed,
        resolveClosed,
        stopPromise: null,
        processControl: launch.processControl,
        terminalEvent: null,
        onExit,
        onError,
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
        if (!session.clientExited) {
          session.clientExited = true;
          session.terminalEvent ||= {
            kind: 'exit',
            exitCode: exitCode ?? 0,
            signal: signal ?? 0,
          };
          session.resolveClosed();
        }
        void this.stopAndFinalizeSession(sessionId, session).catch((error) => {
          console.error(
            `${displayName} session ${sessionId} could not verify shutdown:`,
            error,
          );
        });
      });

      (ptyProcess as any).on('error', (error: Error) => {
        if (this.shouldIgnorePtyError(session, error)) {
          return;
        }

        console.error(
          `${displayName} session ${sessionId} error:`,
          error,
        );
        session.terminalEvent ||= { kind: 'error', error };
        void this.stopAndFinalizeSession(sessionId, session).catch((stopError) => {
          console.error(
            `${displayName} session ${sessionId} could not verify shutdown:`,
            stopError,
          );
        });
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
    await this.stopAndFinalizeSession(sessionId, session);
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
    if (session.closeTimeout) {
      clearTimeout(session.closeTimeout);
      session.closeTimeout = null;
    }

    session.active = false;
    // Only drop the map entry if it still belongs to this run: a restart under
    // the same id must survive the previous run's late exit.
    if (this.sessions.get(sessionId) === session) {
      this.sessions.delete(sessionId);
    }
    return true;
  }

  /**
   * Stop both halves of a container-backed run: the local engine client and
   * the identity-bound process group inside the container. The shared promise
   * makes explicit stops, PTY exits and PTY errors one teardown rather than
   * three racing lifecycle notifications.
   */
  private async stopAndFinalizeSession(
    sessionId: string,
    session: BridgeSession,
  ): Promise<void> {
    if (session.finalized) return;
    if (session.stopPromise) return session.stopPromise;

    const attempt = (async () => {
      session.stopRequested = true;
      session.active = false;

      const localStop = this.stopLocalClient(sessionId, session);
      const remoteStop = session.processControl?.stop() ?? Promise.resolve();
      const [localResult, remoteResult] = await Promise.allSettled([
        localStop,
        remoteStop,
      ]);

      if (remoteResult.status === 'rejected') throw remoteResult.reason;
      if (localResult.status === 'rejected') throw localResult.reason;
      if (!this.finalizeSession(sessionId, session)) return;

      const event = session.terminalEvent;
      if (event?.kind === 'error') {
        try {
          session.onError(event.error);
        } catch (error) {
          console.error(`Session ${sessionId} error callback failed:`, error);
        }
        return;
      }

      const exitCode = event?.kind === 'exit' ? event.exitCode : 0;
      const signal = event?.kind === 'exit' ? event.signal : 0;
      console.log(
        `${this.getDisplayName()} session ${sessionId} exited with code ${exitCode}, signal ${signal}`,
      );
      try {
        session.onExit(exitCode, signal);
      } catch (error) {
        console.error(`Session ${sessionId} exit callback failed:`, error);
      }
    })();

    session.stopPromise = attempt;
    try {
      await attempt;
    } catch (error) {
      // Fail closed, but allow an explicit later stop to retry a transient
      // engine failure while the bridge still owns this session id.
      if (session.stopPromise === attempt) session.stopPromise = null;
      throw error;
    }
  }

  private async stopLocalClient(
    sessionId: string,
    session: BridgeSession,
  ): Promise<void> {
    if (session.clientExited) return;

    try {
      session.process.kill('SIGTERM');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Error sending SIGTERM to session ${sessionId}:`, message);
    }

    if (!session.killTimeout) {
      session.killTimeout = setTimeout(() => {
        if (!session.clientExited) {
          try {
            session.process.kill('SIGKILL');
          } catch {
            // A concurrent exit won the race; its callback resolves `closed`.
          }
        }
      }, 5000);
      session.killTimeout.unref?.();
    }

    const failed = new Promise<never>((_resolve, reject) => {
      if (session.closeTimeout) clearTimeout(session.closeTimeout);
      session.closeTimeout = setTimeout(() => {
        reject(new Error(
          `Could not verify that the ${this.getDisplayName()} client for session ${sessionId} closed`,
        ));
      }, 10_000);
      session.closeTimeout.unref?.();
    });

    try {
      await Promise.race([session.closed, failed]);
    } finally {
      if (session.killTimeout) {
        clearTimeout(session.killTimeout);
        session.killTimeout = null;
      }
      if (session.closeTimeout) {
        clearTimeout(session.closeTimeout);
        session.closeTimeout = null;
      }
    }
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
