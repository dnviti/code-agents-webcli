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

  it('keeps Unix shell launch arguments unchanged', function() {
    const config = bridge.buildLaunchConfig({
      mode: 'command',
      shell: 'sh',
      command: 'printf ok',
    });

    assert.strictEqual(config.command, '/bin/sh');
    assert.deepStrictEqual(config.args, ['-lc', 'printf ok']);
  });

  it('uses the injected Unix shell environment', function() {
    const unixBridge = new TerminalBridge({
      platform: 'linux',
      env: { SHELL: '/custom/sh' },
      existsSync(candidate) { return candidate === '/custom/sh'; },
      execFileSync() { throw new Error('unreachable'); },
    });

    assert.strictEqual(unixBridge.resolveShell('sh'), '/custom/sh');
  });

  it('probes shell availability on the host inside Flatpak', function() {
    const calls = [];
    const flatpakBridge = new TerminalBridge({
      platform: 'linux',
      env: { FLATPAK_ID: 'io.github.dnviti.code-agents-webcli', SHELL: '/bin/zsh' },
      existsSync() { return false; },
      execFileSync(command, args) { calls.push({ command, args }); return ''; },
    });
    assert.strictEqual(flatpakBridge.resolveShell(), '/bin/zsh');
    assert.deepStrictEqual(calls[0], {
      command: '/usr/bin/flatpak-spawn',
      args: ['--host', 'which', '/bin/zsh'],
    });
  });

  it('does not mistake a sandbox-only shell for a host shell', function() {
    const flatpakBridge = new TerminalBridge({
      platform: 'linux',
      env: { FLATPAK_ID: 'io.github.dnviti.code-agents-webcli', SHELL: '/bin/zsh' },
      existsSync(candidate) { return candidate === '/bin/zsh'; },
      execFileSync(_command, args) {
        if (args.at(-1) === '/bin/sh') return '';
        throw new Error('not installed on host');
      },
    });
    assert.strictEqual(flatpakBridge.resolveShell(), '/bin/sh');
  });

  it('advertises one friendly Windows choice per shell family', function() {
    const bridge = new TerminalBridge({ platform: 'win32' });
    assert.deepStrictEqual(bridge.getSupportedShells(), ['pwsh', 'powershell', 'cmd']);
  });

  it('resolves PowerShell 7 on Windows without invoking Unix which', function() {
    const resolverCalls = [];
    const windowsBridge = new TerminalBridge({
      platform: 'win32',
      env: {},
      existsSync() { return false; },
      execFileSync(command, args) {
        resolverCalls.push({ command, args });
        if (command === 'where.exe' && args[0] === 'pwsh.exe') return '';
        throw new Error('not found');
      },
    });

    const config = windowsBridge.buildLaunchConfig({ mode: 'shell' });

    assert.strictEqual(config.command, 'pwsh.exe');
    assert.deepStrictEqual(config.args, ['-NoLogo']);
    assert.deepStrictEqual(resolverCalls, [{ command: 'where.exe', args: ['pwsh.exe'] }]);
  });

  it('uses Windows PowerShell command arguments', function() {
    const windowsBridge = new TerminalBridge({
      platform: 'win32',
      env: {},
      existsSync(candidate) { return candidate === 'powershell.exe'; },
      execFileSync() { throw new Error('unreachable'); },
    });

    const config = windowsBridge.buildLaunchConfig({
      mode: 'command',
      shell: 'powershell.exe',
      command: 'Get-ChildItem',
    });

    assert.strictEqual(config.command, 'powershell.exe');
    assert.deepStrictEqual(config.args, ['-NoLogo', '-Command', 'Get-ChildItem']);
  });

  it('uses ComSpec and cmd command arguments on Windows', function() {
    const windowsBridge = new TerminalBridge({
      platform: 'win32',
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      existsSync(candidate) { return candidate === 'C:\\Windows\\System32\\cmd.exe'; },
      execFileSync() { throw new Error('unreachable'); },
    });

    const interactive = windowsBridge.buildLaunchConfig({ mode: 'shell', shell: 'ComSpec' });
    const command = windowsBridge.buildLaunchConfig({
      mode: 'command', shell: 'cmd.exe', command: 'dir',
    });

    assert.strictEqual(interactive.command, 'C:\\Windows\\System32\\cmd.exe');
    assert.deepStrictEqual(interactive.args, []);
    assert.deepStrictEqual(command.args, ['/d', '/s', '/c', 'dir']);
  });

  it('lists supported Windows shells in resolution errors', function() {
    const windowsBridge = new TerminalBridge({ platform: 'win32', env: {} });

    assert.throws(
      () => windowsBridge.buildLaunchConfig({ mode: 'shell', shell: 'zsh' }),
      /Supported shells: pwsh\.exe \(pwsh\), powershell\.exe \(powershell\), cmd\.exe \(cmd, ComSpec\)/,
    );
  });

  it('uses the Bash shell advertised by a project container', function() {
    const config = bridge.buildLaunchConfig({
      mode: 'shell',
      shell: 'sh',
      environment: { kind: 'container', shells: ['bash'] },
    });

    assert.strictEqual(config.command, 'bash');
    assert.deepStrictEqual(config.args, ['-i']);
    assert.strictEqual(config.runtimeLabel, 'bash');
  });

  it('uses Unix argv for a container shell from a Windows host', function() {
    const windowsBridge = new TerminalBridge({ platform: 'win32', env: {} });
    const environment = { kind: 'container', shells: ['bash'] };

    const interactive = windowsBridge.buildLaunchConfig({ mode: 'shell', environment });
    const command = windowsBridge.buildLaunchConfig({
      mode: 'command', environment, command: 'echo ready',
    });

    assert.deepStrictEqual(interactive.args, ['-i']);
    assert.deepStrictEqual(command.args, ['-lc', 'echo ready']);
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
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(bridge.getSession('session-4'), undefined);
    assert.deepStrictEqual(exitResult, { code: 0, signal: 15 });
  });

  it('stops the PTY with SIGTERM', async function() {
    await bridge.startSession('session-5', { shell: 'bash' });

    const stopping = bridge.stopSession('session-5');

    assert.ok(bridge.getSession('session-5'), 'ownership remains until close');
    ptys[0].emitExit(143, 15);
    await stopping;

    assert.deepStrictEqual(ptys[0].killSignals, ['SIGTERM']);
  });

  it('ignores benign EIO errors during shutdown', async function() {
    let reportedError = null;

    await bridge.startSession('session-6', {
      onError(error) {
        reportedError = error;
      }
    });

    const stopping = bridge.stopSession('session-6');
    ptys[0].emitError(Object.assign(new Error('read EIO'), { code: 'EIO' }));
    ptys[0].emitExit(143, 0);
    await stopping;

    assert.strictEqual(reportedError, null);
    assert.strictEqual(bridge.getSession('session-6'), undefined);
  });

  it('retains the session until remote process proof succeeds', async function() {
    let verifyRemote;
    const remoteProof = new Promise((resolve) => { verifyRemote = resolve; });
    const environment = {
      kind: 'container',
      name: 'project-runtime',
      shells: ['sh'],
      wrap(command, args) {
        return {
          command,
          args,
          env: process.env,
          processControl: { stop: () => remoteProof },
        };
      },
    };
    await bridge.startSession('session-remote-proof', { shell: 'sh', environment });

    const stopping = bridge.stopSession('session-remote-proof');
    ptys[0].emitExit(143, 15);
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(bridge.getSession('session-remote-proof'));
    verifyRemote();
    await stopping;
    assert.strictEqual(bridge.getSession('session-remote-proof'), undefined);
  });

  it('fails before spawning when a container omits process control', async function() {
    const environment = {
      kind: 'container',
      shells: ['sh'],
      wrap(command, args) { return { command, args, env: process.env }; },
    };

    await assert.rejects(
      bridge.startSession('session-missing-control', { shell: 'sh', environment }),
      /verified process control/,
    );
    assert.strictEqual(spawnCalls.length, 0);
  });
});
