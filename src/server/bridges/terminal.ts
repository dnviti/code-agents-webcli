import { spawn as defaultSpawnPty, IPty } from '../services/pty.js';
import * as path from 'path';
import * as fs from 'fs';
import { execFileSync as defaultExecFileSync } from 'child_process';
import {
  UserEnvironment,
  WrappedProcessControl,
} from '../services/environments/types.js';
import { HostEnvironment } from '../services/environments/manager.js';

export interface TerminalSession {
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
  runtimeLabel: string;
  terminalMode: 'shell' | 'command';
  shell: string;
}

export interface TerminalSessionInfo {
  id: string;
  workingDir: string;
  created: Date;
  active: boolean;
  runtimeLabel: string;
  terminalMode: 'shell' | 'command';
  shell: string;
}

export interface TerminalStartOptions {
  workingDir?: string;
  /** Whether workingDir is already an absolute path inside the container. */
  cwdKind?: 'host' | 'container';
  /**
   * Where this terminal runs. Absent means the host, which is what every
   * caller passed before per-user environments existed.
   */
  environment?: UserEnvironment;
  onOutput?: (data: string) => void;
  onExit?: (exitCode: number, signal: number) => void;
  onError?: (error: Error) => void;
  cols?: number;
  rows?: number;
  mode?: 'shell' | 'command';
  command?: string;
  shell?: string;
}

export interface LaunchConfig {
  command: string;
  args: string[];
  runtimeLabel: string;
  mode: 'shell' | 'command';
  shell: string;
}

type SpawnFn = typeof defaultSpawnPty;
type ExistsFn = (path: string) => boolean;
type ExecFileSyncFn = typeof defaultExecFileSync;

export interface TerminalBridgeOptions {
  spawn?: SpawnFn;
  existsSync?: ExistsFn;
  execFileSync?: ExecFileSyncFn;
}

const SUPPORTED_SHELLS = ['zsh', 'bash', 'sh'] as const;
type SupportedShell = (typeof SUPPORTED_SHELLS)[number];

export class TerminalBridge {
  private sessions: Map<string, TerminalSession> = new Map();
  private spawnPty: SpawnFn;
  private pathExists: ExistsFn;
  private execFileSync: ExecFileSyncFn;

  constructor(options: TerminalBridgeOptions = {}) {
    this.spawnPty = options.spawn || defaultSpawnPty;
    this.pathExists = options.existsSync || fs.existsSync;
    this.execFileSync = options.execFileSync || defaultExecFileSync;
  }

  private commandExists(command: string): boolean {
    try {
      this.execFileSync('which', [command], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  getSupportedShells(): readonly string[] {
    return SUPPORTED_SHELLS;
  }

  getShellCandidates(shellName: string): string[] {
    const normalized = (shellName || '').trim();
    if (!normalized) {
      return [];
    }

    if (normalized.includes(path.sep)) {
      const basename = path.basename(normalized);
      return [normalized, ...this.getShellCandidates(basename)];
    }

    switch (normalized as SupportedShell) {
      case 'zsh':
        return [
          path.basename(process.env.SHELL || '') === 'zsh'
            ? process.env.SHELL!
            : null,
          path.join(
            process.env.HOME || '/',
            '.local',
            'bin',
            'zsh',
          ),
          '/bin/zsh',
          '/usr/bin/zsh',
          'zsh',
        ].filter(Boolean) as string[];
      case 'bash':
        return [
          path.basename(process.env.SHELL || '') === 'bash'
            ? process.env.SHELL!
            : null,
          path.join(
            process.env.HOME || '/',
            '.local',
            'bin',
            'bash',
          ),
          '/bin/bash',
          '/usr/bin/bash',
          'bash',
        ].filter(Boolean) as string[];
      case 'sh':
        return [
          path.basename(process.env.SHELL || '') === 'sh'
            ? process.env.SHELL!
            : null,
          '/bin/sh',
          '/usr/bin/sh',
          'sh',
        ].filter(Boolean) as string[];
      default:
        return [];
    }
  }

  resolveShell(shellName?: string): string {
    const requestedShell = (shellName || '').trim();
    const normalizedName = requestedShell
      ? path.basename(requestedShell)
      : '';

    if (
      requestedShell &&
      !(SUPPORTED_SHELLS as readonly string[]).includes(normalizedName)
    ) {
      throw new Error(
        `Unsupported shell "${requestedShell}". Supported shells: ${SUPPORTED_SHELLS.join(', ')}`,
      );
    }

    const preferredShells: string[] = [];
    if (requestedShell) {
      preferredShells.push(...this.getShellCandidates(requestedShell));
    } else if (process.env.SHELL) {
      preferredShells.push(
        ...this.getShellCandidates(process.env.SHELL),
      );
    }

    for (const fallback of SUPPORTED_SHELLS) {
      preferredShells.push(...this.getShellCandidates(fallback));
    }

    const seen = new Set<string>();
    for (const candidate of preferredShells) {
      if (!candidate || seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);

      if (this.pathExists(candidate) || this.commandExists(candidate)) {
        return candidate;
      }
    }

    throw new Error(
      `Unable to find an available shell. Tried: ${SUPPORTED_SHELLS.join(', ')}`,
    );
  }

  /**
   * The shell to launch, asked of whichever machine will run it.
   *
   * In a container the host's answer is worthless and actively harmful: this
   * host's `$SHELL` may be `/home/daniele/.local/bin/zsh`, a path that exists
   * nowhere in the image. The environment reports what it actually has, probed
   * once when it was created.
   */
  private resolveShellFor(options: TerminalStartOptions): string {
    const environment = options.environment;
    if (!environment || environment.kind !== 'container') {
      return this.resolveShell(options.shell);
    }

    const available = environment.shells;
    if (!available.length) {
      return 'sh';
    }

    const requested = (options.shell || '').trim();
    if (requested) {
      const basename = path.basename(requested);
      if (available.includes(basename)) {
        return basename;
      }
    }

    return available[0];
  }

  buildLaunchConfig(options: TerminalStartOptions = {}): LaunchConfig {
    const mode: 'shell' | 'command' =
      options.mode === 'command' ? 'command' : 'shell';

    if (mode === 'command') {
      const command =
        typeof options.command === 'string'
          ? options.command.trim()
          : '';
      if (!command) {
        throw new Error('Custom command is required');
      }

      const shellPath = this.resolveShellFor(options);
      return {
        command: shellPath,
        args: ['-lc', command],
        runtimeLabel: command,
        mode,
        shell: path.basename(shellPath),
      };
    }

    const shellPath = this.resolveShellFor(options);
    return {
      command: shellPath,
      args: ['-i'],
      runtimeLabel: path.basename(shellPath),
      mode,
      shell: path.basename(shellPath),
    };
  }

  async startSession(
    sessionId: string,
    options: TerminalStartOptions = {},
  ): Promise<TerminalSession> {
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} already exists`);
    }

    const {
      workingDir = process.cwd(),
      onOutput = () => {},
      onExit = () => {},
      onError = () => {},
      cols = 80,
      rows = 24,
    } = options;

    const launchConfig = this.buildLaunchConfig(options);

    try {
      console.log(`Starting terminal session ${sessionId}`);
      console.log(
        `Command: ${launchConfig.command} ${launchConfig.args.join(' ')}`,
      );
      console.log(`Working directory: ${workingDir}`);
      console.log(`Terminal size: ${cols}x${rows}`);

      // The environment decides *where* the pty's program runs; on the host it
      // is the identity, so this is the same spawn it has always been.
      const launch = (options.environment || new HostEnvironment(workingDir)).wrap(
        launchConfig.command,
        launchConfig.args,
        {
          cwd: workingDir,
          cwdKind: options.cwdKind,
          env: {
            TERM: 'xterm-256color',
            FORCE_COLOR: '1',
            COLORTERM: 'truecolor',
          },
          tty: true,
          trackProcess: true,
        },
      );
      if (options.environment?.kind === 'container' && !launch.processControl) {
        throw new Error('Container environment did not provide verified process control');
      }

      const terminalProcess = this.spawnPty(
        launch.command,
        launch.args,
        {
          // A container exec sets its own working directory through the
          // engine, and the host path does not exist for the engine client, so
          // the spawn's cwd is only meaningful in host mode.
          cwd: options.environment?.kind === 'container' ? undefined : workingDir,
          env: launch.env,
          cols,
          rows,
          name: 'xterm-color',
        },
      );

      let resolveClosed!: () => void;
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      const session: TerminalSession = {
        process: terminalProcess,
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
        runtimeLabel: launchConfig.runtimeLabel,
        terminalMode: launchConfig.mode,
        shell: launchConfig.shell,
      };

      this.sessions.set(sessionId, session);

      terminalProcess.onData((data: string) => {
        if (process.env.DEBUG) {
          console.log(
            `Terminal session ${sessionId} output:`,
            data,
          );
        }
        onOutput(data);
      });

      terminalProcess.onExit(({ exitCode, signal }) => {
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
            `Terminal session ${sessionId} could not verify shutdown:`,
            error,
          );
        });
      });

      (terminalProcess as any).on('error', (error: Error) => {
        if (this.shouldIgnorePtyError(session, error)) {
          return;
        }

        console.error(
          `Terminal session ${sessionId} error:`,
          error,
        );
        session.terminalEvent ||= { kind: 'error', error };
        void this.stopAndFinalizeSession(sessionId, session).catch((stopError) => {
          console.error(
            `Terminal session ${sessionId} could not verify shutdown:`,
            stopError,
          );
        });
      });

      console.log(
        `Terminal session ${sessionId} started successfully`,
      );
      return session;
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      console.error(
        `Failed to start terminal session ${sessionId}:`,
        error,
      );
      throw new Error(`Failed to start terminal: ${message}`);
    }
  }

  async sendInput(sessionId: string, data: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.active) {
      throw new Error(
        `Session ${sessionId} not found or not active`,
      );
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
      throw new Error(
        `Session ${sessionId} not found or not active`,
      );
    }

    try {
      session.process.resize(cols, rows);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      console.warn(
        `Failed to resize session ${sessionId}:`,
        message,
      );
    }
  }

  async stopSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    await this.stopAndFinalizeSession(sessionId, session);
  }

  getSession(sessionId: string): TerminalSession | undefined {
    return this.sessions.get(sessionId);
  }

  getAllSessions(): TerminalSessionInfo[] {
    return Array.from(this.sessions.entries()).map(
      ([id, session]) => ({
        id,
        workingDir: session.workingDir,
        created: session.created,
        active: session.active,
        runtimeLabel: session.runtimeLabel,
        terminalMode: session.terminalMode,
        shell: session.shell,
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
    session: TerminalSession,
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
    if (this.sessions.get(sessionId) === session) {
      this.sessions.delete(sessionId);
    }
    return true;
  }

  private async stopAndFinalizeSession(
    sessionId: string,
    session: TerminalSession,
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
          console.error(`Terminal session ${sessionId} error callback failed:`, error);
        }
        return;
      }

      const exitCode = event?.kind === 'exit' ? event.exitCode : 0;
      const signal = event?.kind === 'exit' ? event.signal : 0;
      console.log(
        `Terminal session ${sessionId} exited with code ${exitCode}, signal ${signal}`,
      );
      try {
        session.onExit(exitCode, signal);
      } catch (error) {
        console.error(`Terminal session ${sessionId} exit callback failed:`, error);
      }
    })();

    session.stopPromise = attempt;
    try {
      await attempt;
    } catch (error) {
      if (session.stopPromise === attempt) session.stopPromise = null;
      throw error;
    }
  }

  private async stopLocalClient(
    sessionId: string,
    session: TerminalSession,
  ): Promise<void> {
    if (session.clientExited) return;

    try {
      session.process.kill('SIGTERM');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Error sending SIGTERM to terminal session ${sessionId}:`, message);
    }

    if (!session.killTimeout) {
      session.killTimeout = setTimeout(() => {
        if (!session.clientExited) {
          try {
            session.process.kill('SIGKILL');
          } catch {
            // A concurrent exit won the race.
          }
        }
      }, 5000);
      session.killTimeout.unref?.();
    }

    const failed = new Promise<never>((_resolve, reject) => {
      if (session.closeTimeout) clearTimeout(session.closeTimeout);
      session.closeTimeout = setTimeout(() => {
        reject(new Error(
          `Could not verify that the terminal client for session ${sessionId} closed`,
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
    session: TerminalSession,
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

export default TerminalBridge;
