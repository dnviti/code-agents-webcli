const assert = require('assert');
const path = require('path');
const { TerminalBridge } = require('../dist/server/bridges/terminal.js');

function createFakePty() {
  return {
    killSignals: [],
    writeCalls: [],
    resizeCalls: [],
    onData(handler) {
      this.onDataHandler = handler;
    },
    onExit(handler) {
      this.onExitHandler = handler;
    },
    on(event, handler) {
      if (event === 'error') {
        this.onErrorHandler = handler;
      }
    },
    write(data) {
      this.writeCalls.push(data);
    },
    resize(cols, rows) {
      this.resizeCalls.push({ cols, rows });
    },
    kill(signal) {
      this.killSignals.push(signal);
    },
    emitData(data) {
      if (this.onDataHandler) {
        this.onDataHandler(data);
      }
    },
    emitExit(code, signal) {
      if (this.onExitHandler) {
        this.onExitHandler({ exitCode: code, signal });
      }
    },
    emitError(error) {
      if (this.onErrorHandler) {
        this.onErrorHandler(error);
      }
    }
  };
}

describe('TerminalBridge', function() {
  let bridge;
  let spawnCalls;
  let ptys;

  beforeEach(function() {
    spawnCalls = [];
    ptys = [];
    bridge = new TerminalBridge({
      spawn(command, args, options) {
        const pty = createFakePty();
        ptys.push(pty);
        spawnCalls.push({ command, args, options, pty });
        return pty;
      },
      existsSync(candidate) {
        return ['/bin/zsh', '/bin/bash', '/bin/sh'].includes(candidate);
      },
      execFileSync() {
        return '';
      }
    });
  });

  it('starts an interactive zsh shell', async function() {
    const session = await bridge.startSession('session-1', {
      mode: 'shell',
      shell: 'zsh',
      workingDir: '/tmp'
    });

    assert.strictEqual(spawnCalls.length, 1);
    assert.strictEqual(path.basename(spawnCalls[0].command), 'zsh');
    assert.deepStrictEqual(spawnCalls[0].args, ['-i']);
    assert.strictEqual(spawnCalls[0].options.cwd, '/tmp');
    assert.strictEqual(session.runtimeLabel, 'zsh');
    assert.strictEqual(session.terminalMode, 'shell');
  });

  it('runs a custom command through the selected shell', async function() {
    const session = await bridge.startSession('session-2', {
      mode: 'command',
      shell: 'bash',
      command: 'watch podman ps'
    });

    assert.strictEqual(spawnCalls.length, 1);
    assert.strictEqual(path.basename(spawnCalls[0].command), 'bash');
    assert.deepStrictEqual(spawnCalls[0].args, ['-lc', 'watch podman ps']);
    assert.strictEqual(session.runtimeLabel, 'watch podman ps');
    assert.strictEqual(session.terminalMode, 'command');
  });

  it('rejects unsupported shells', function() {
    assert.throws(() => {
      bridge.buildLaunchConfig({ mode: 'shell', shell: 'fish' });
    }, /Unsupported shell/);
  });

  it('requires a non-empty custom command', function() {
    assert.throws(() => {
      bridge.buildLaunchConfig({ mode: 'command', command: '   ' });
    }, /Custom command is required/);
  });

  it('forwards input and resize operations to the PTY', async function() {
    await bridge.startSession('session-3', { shell: 'sh' });

    await bridge.sendInput('session-3', 'ls\n');
    await bridge.resize('session-3', 120, 40);

    assert.deepStrictEqual(ptys[0].writeCalls, ['ls\n']);
    assert.deepStrictEqual(ptys[0].resizeCalls, [{ cols: 120, rows: 40 }]);
  });

  it('cleans up the session when the PTY exits', async function() {
    let exitResult = null;
    await bridge.startSession('session-4', {
      onExit(code, signal) {
        exitResult = { code, signal };
      }
    });

    ptys[0].emitExit(0, 15);

    assert.strictEqual(bridge.getSession('session-4'), undefined);
    assert.deepStrictEqual(exitResult, { code: 0, signal: 15 });
  });

  it('stops the PTY with SIGTERM', async function() {
    await bridge.startSession('session-5', { shell: 'bash' });

    await bridge.stopSession('session-5');

    assert.deepStrictEqual(ptys[0].killSignals, ['SIGTERM']);
  });

  it('ignores benign EIO errors during shutdown', async function() {
    let reportedError = null;

    await bridge.startSession('session-6', {
      onError(error) {
        reportedError = error;
      }
    });

    await bridge.stopSession('session-6');
    ptys[0].emitError(Object.assign(new Error('read EIO'), { code: 'EIO' }));
    ptys[0].emitExit(143, 0);

    assert.strictEqual(reportedError, null);
    assert.strictEqual(bridge.getSession('session-6'), undefined);
  });
});
