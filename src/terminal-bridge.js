const { spawn } = require('node-pty');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

class TerminalBridge {
  constructor(options = {}) {
    this.sessions = new Map();
    this.spawnPty = options.spawn || spawn;
    this.pathExists = options.existsSync || fs.existsSync;
    this.execFileSync = options.execFileSync || execFileSync;
  }

  commandExists(command) {
    try {
      this.execFileSync('which', [command], { stdio: 'ignore' });
      return true;
    } catch (error) {
      return false;
    }
  }

  getSupportedShells() {
    return ['zsh', 'bash', 'sh'];
  }

  getShellCandidates(shellName) {
    const normalized = (shellName || '').trim();
    if (!normalized) {
      return [];
    }

    if (normalized.includes(path.sep)) {
      const basename = path.basename(normalized);
      return [normalized, ...this.getShellCandidates(basename)];
    }

    switch (normalized) {
      case 'zsh':
        return [
          path.basename(process.env.SHELL || '') === 'zsh' ? process.env.SHELL : null,
          path.join(process.env.HOME || '/', '.local', 'bin', 'zsh'),
          '/bin/zsh',
          '/usr/bin/zsh',
          'zsh'
        ].filter(Boolean);
      case 'bash':
        return [
          path.basename(process.env.SHELL || '') === 'bash' ? process.env.SHELL : null,
          path.join(process.env.HOME || '/', '.local', 'bin', 'bash'),
          '/bin/bash',
          '/usr/bin/bash',
          'bash'
        ].filter(Boolean);
      case 'sh':
        return [
          path.basename(process.env.SHELL || '') === 'sh' ? process.env.SHELL : null,
          '/bin/sh',
          '/usr/bin/sh',
          'sh'
        ].filter(Boolean);
      default:
        return [];
    }
  }

  resolveShell(shellName) {
    const requestedShell = (shellName || '').trim();
    const normalizedName = requestedShell ? path.basename(requestedShell) : '';

    if (requestedShell && !this.getSupportedShells().includes(normalizedName)) {
      throw new Error(`Unsupported shell "${requestedShell}". Supported shells: ${this.getSupportedShells().join(', ')}`);
    }

    const preferredShells = [];
    if (requestedShell) {
      preferredShells.push(...this.getShellCandidates(requestedShell));
    } else if (process.env.SHELL) {
      preferredShells.push(...this.getShellCandidates(process.env.SHELL));
    }

    for (const fallback of this.getSupportedShells()) {
      preferredShells.push(...this.getShellCandidates(fallback));
    }

    const seen = new Set();
    for (const candidate of preferredShells) {
      if (!candidate || seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);

      if (this.pathExists(candidate) || this.commandExists(candidate)) {
        return candidate;
      }
    }

    throw new Error(`Unable to find an available shell. Tried: ${this.getSupportedShells().join(', ')}`);
  }

  buildLaunchConfig(options = {}) {
    const mode = options.mode === 'command' ? 'command' : 'shell';

    if (mode === 'command') {
      const command = typeof options.command === 'string' ? options.command.trim() : '';
      if (!command) {
        throw new Error('Custom command is required');
      }

      const shellPath = this.resolveShell(options.shell);
      return {
        command: shellPath,
        args: ['-lc', command],
        runtimeLabel: command,
        mode,
        shell: path.basename(shellPath)
      };
    }

    const shellPath = this.resolveShell(options.shell);
    return {
      command: shellPath,
      args: ['-i'],
      runtimeLabel: path.basename(shellPath),
      mode,
      shell: path.basename(shellPath)
    };
  }

  async startSession(sessionId, options = {}) {
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} already exists`);
    }

    const {
      workingDir = process.cwd(),
      onOutput = () => {},
      onExit = () => {},
      onError = () => {},
      cols = 80,
      rows = 24
    } = options;

    const launchConfig = this.buildLaunchConfig(options);

    try {
      console.log(`Starting terminal session ${sessionId}`);
      console.log(`Command: ${launchConfig.command} ${launchConfig.args.join(' ')}`);
      console.log(`Working directory: ${workingDir}`);
      console.log(`Terminal size: ${cols}x${rows}`);

      const terminalProcess = this.spawnPty(launchConfig.command, launchConfig.args, {
        cwd: workingDir,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          FORCE_COLOR: '1',
          COLORTERM: 'truecolor'
        },
        cols,
        rows,
        name: 'xterm-color'
      });

      const session = {
        process: terminalProcess,
        workingDir,
        created: new Date(),
        active: true,
        killTimeout: null,
        runtimeLabel: launchConfig.runtimeLabel,
        terminalMode: launchConfig.mode,
        shell: launchConfig.shell
      };

      this.sessions.set(sessionId, session);

      terminalProcess.onData((data) => {
        if (process.env.DEBUG) {
          console.log(`Terminal session ${sessionId} output:`, data);
        }
        onOutput(data);
      });

      terminalProcess.onExit((exitCode, signal) => {
        console.log(`Terminal session ${sessionId} exited with code ${exitCode}, signal ${signal}`);
        if (session.killTimeout) {
          clearTimeout(session.killTimeout);
          session.killTimeout = null;
        }
        session.active = false;
        this.sessions.delete(sessionId);
        onExit(exitCode, signal);
      });

      terminalProcess.on('error', (error) => {
        console.error(`Terminal session ${sessionId} error:`, error);
        if (session.killTimeout) {
          clearTimeout(session.killTimeout);
          session.killTimeout = null;
        }
        session.active = false;
        this.sessions.delete(sessionId);
        onError(error);
      });

      console.log(`Terminal session ${sessionId} started successfully`);
      return session;
    } catch (error) {
      console.error(`Failed to start terminal session ${sessionId}:`, error);
      throw new Error(`Failed to start terminal: ${error.message}`);
    }
  }

  async sendInput(sessionId, data) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.active) {
      throw new Error(`Session ${sessionId} not found or not active`);
    }

    try {
      session.process.write(data);
    } catch (error) {
      throw new Error(`Failed to send input to session ${sessionId}: ${error.message}`);
    }
  }

  async resize(sessionId, cols, rows) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.active) {
      throw new Error(`Session ${sessionId} not found or not active`);
    }

    try {
      session.process.resize(cols, rows);
    } catch (error) {
      console.warn(`Failed to resize session ${sessionId}:`, error.message);
    }
  }

  async stopSession(sessionId) {
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
        session.process.kill('SIGTERM');
        session.killTimeout = setTimeout(() => {
          if (session.active && session.process) {
            session.process.kill('SIGKILL');
          }
        }, 5000);
      }
    } catch (error) {
      console.warn(`Error stopping terminal session ${sessionId}:`, error.message);
    }

    session.active = false;
    this.sessions.delete(sessionId);
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId);
  }

  getAllSessions() {
    return Array.from(this.sessions.entries()).map(([id, session]) => ({
      id,
      workingDir: session.workingDir,
      created: session.created,
      active: session.active,
      runtimeLabel: session.runtimeLabel,
      terminalMode: session.terminalMode,
      shell: session.shell
    }));
  }

  async cleanup() {
    const sessionIds = Array.from(this.sessions.keys());
    for (const sessionId of sessionIds) {
      await this.stopSession(sessionId);
    }
  }
}

module.exports = TerminalBridge;
