import { spawn as defaultSpawnPty, IPty } from 'node-pty';
import * as path from 'path';
import * as fs from 'fs';
import { execFileSync as defaultExecFileSync } from 'child_process';

export interface TerminalSession {
  process: IPty;
  workingDir: string;
  created: Date;
  active: boolean;
  killTimeout: ReturnType<typeof setTimeout> | null;
  stopRequested: boolean;
  finalized: boolean;
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

      const shellPath = this.resolveShell(options.shell);
      return {
        command: shellPath,
        args: ['-lc', command],
        runtimeLabel: command,
        mode,
        shell: path.basename(shellPath),
      };
    }

    const shellPath = this.resolveShell(options.shell);
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

      const terminalProcess = this.spawnPty(
        launchConfig.command,
        launchConfig.args,
        {
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
        },
      );

      const session: TerminalSession = {
        process: terminalProcess,
        workingDir,
        created: new Date(),
        active: true,
        killTimeout: null,
        stopRequested: false,
        finalized: false,
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
        if (!this.finalizeSession(sessionId, session)) {
          return;
        }

        console.log(
          `Terminal session ${sessionId} exited with code ${exitCode}, signal ${signal}`,
        );
        onExit(exitCode ?? 0, signal ?? 0);
      });

      (terminalProcess as any).on('error', (error: Error) => {
        if (this.shouldIgnorePtyError(session, error)) {
          return;
        }

        if (!this.finalizeSession(sessionId, session)) {
          return;
        }

        console.error(
          `Terminal session ${sessionId} error:`,
          error,
        );
        onError(error);
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
      console.warn(
        `Error stopping terminal session ${sessionId}:`,
        message,
      );
    }

    session.stopRequested = true;
    session.active = false;
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

    session.active = false;
    this.sessions.delete(sessionId);
    return true;
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
