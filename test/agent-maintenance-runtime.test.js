const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  JsonFileAgentMaintenanceStore, EnvironmentAgentRuntime, OfficialAgentReleaseSource, OfficialScriptAgentInstaller,
  childProcessRunner,
} = require('../dist/server/services/agent-maintenance-runtime.js');
const { HostEnvironment } = require('../dist/server/services/environments/manager.js');
const { agentCatalogEntry } = require('../dist/shared/agent-maintenance.js');

function target() { return { key: 'server:env:private:7', platform: 'linux', architecture: 'x64', scope: 'private', ownerUserId: 7 }; }
function windowsTarget(architecture = 'x64') { return { ...target(), platform: 'win32', architecture, scope: 'shared', ownerUserId: null }; }
function temp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-maintenance-')); }
function environment(calls) { return { kind: 'host', homeDir: os.tmpdir(), toContainerPath(value) { return value; }, wrap(command, args, options = {}) { calls.push({ command, args, options }); return { command: 'wrapped', args: [command, ...args], env: options.env || {} }; } }; }
function targetIdentity() { return createHash('sha256').update(target().key).digest('hex'); }
function installRoot(dir, agentId, version = '1.2.3', attempt = 'operation') { return path.join(dir, 'agent-maintenance', targetIdentity().slice(0, 24), agentId, version, 'attempts', attempt); }

describe('agent maintenance runtime adapters', () => {
  it('closes stdin for non-interactive maintenance commands', async () => {
    const child = [
      "const timer = setTimeout(() => { process.stderr.write('stdin-open'); process.exit(23); }, 500);",
      "process.stdin.resume();",
      "process.stdin.once('end', () => { clearTimeout(timer); process.stdout.write('stdin-eof'); });",
    ].join('\n');
    const result = await childProcessRunner.run(process.execPath, ['-e', child], {
      env: {}, timeoutMs: 2_000,
    });
    assert.equal(result.stdout, 'stdin-eof');
    assert.equal(result.stderr, '');
  });

  it('keeps installer stdout in command failure diagnostics', async () => {
    const child = [
      "process.stdout.write('actionable installer failure');",
      "process.stderr.write('wrapper failure');",
      'process.exit(17);',
    ].join('\n');
    await assert.rejects(
      () => childProcessRunner.run(process.execPath, ['-e', child], { env: {} }),
      (error) => {
        assert.match(error.message, /actionable installer failure/);
        assert.match(error.message, /wrapper failure/);
        assert.equal(error.stdout, 'actionable installer failure');
        assert.equal(error.stderr, 'wrapper failure');
        return true;
      },
    );
  });

  it('persists operation/check records atomically with owner-only permissions', () => {
    const dir = temp(); const store = new JsonFileAgentMaintenanceStore(dir);
    store.saveOperation({ id: 'op', targetKey: 't', agentId: 'claude', kind: 'install', phase: 'failed', createdAt: 1, updatedAt: 1, version: null, error: 'x', retryable: true, canCancel: false, cancelReason: 'done' });
    store.saveOperation({ id: 'complete', targetKey: 'other', agentId: 'codex', kind: 'update', phase: 'complete', createdAt: 1, updatedAt: 2, version: '1.2.3', error: null, retryable: false, canCancel: false, cancelReason: 'done' });
    store.saveCheck({ targetKey: 't', agentId: 'claude', latestVersion: '1.2.3', state: 'current', checkedAt: 1 });
    const file = path.join(dir, 'agent-maintenance.json');
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const restored = new JsonFileAgentMaintenanceStore(dir); assert.deepEqual(restored.loadOperations().map((item) => item.id), ['op']); assert.equal(restored.loadCheck('t', 'claude').latestVersion, '1.2.3');
  });

  it('probes through environment wrapping and preserves an external copy', async () => {
    const dir = temp(); const calls = []; const runtime = new EnvironmentAgentRuntime({ dataDir: dir, environmentFor: async () => environment(calls), runner: { run: async () => ({ stdout: 'claude 1.2.3', stderr: '' }) } });
    const located = await runtime.locate(target(), agentCatalogEntry('claude'));
    assert.deepEqual(located, { state: 'external', version: '1.2.3' }); assert.equal(calls[0].command, 'claude');
    assert.equal(runtime.resolveManagedCommand(target(), agentCatalogEntry('claude')), null);
  });

  it('finds a globally installed Windows npm shim and ignores its extensionless twin', async function () {
    if (process.platform !== 'win32') this.skip();
    const dir = temp(); const bin = path.join(dir, 'global npm');
    const entry = path.join(bin, 'node_modules', 'example-pi', 'cli.js');
    const previousPath = process.env.PATH;
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(path.join(bin, 'pi'), '#!/bin/sh\nexit 99\n');
    fs.writeFileSync(entry, "process.stdout.write('pi 9.8.7');");
    fs.writeFileSync(
      path.join(bin, 'pi.cmd'),
      '@ECHO off\r\nnode.exe "%dp0%\\node_modules\\example-pi\\cli.js" %*\r\n',
    );
    process.env.PATH = `${bin};${previousPath || ''}`;
    try {
      const runtime = new EnvironmentAgentRuntime({
        dataDir: dir,
        environmentFor: async () => new HostEnvironment(dir),
      });
      assert.deepEqual(
        await runtime.locate(windowsTarget(), agentCatalogEntry('pi')),
        { state: 'external', version: '9.8.7' },
      );
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it('distinguishes a present copy with an unreadable version from a missing executable', async () => {
    const dir = temp();
    const present = new EnvironmentAgentRuntime({
      dataDir: dir,
      environmentFor: async () => environment([]),
      runner: { run: async () => { const error = new Error('version probe failed'); error.code = 'EACCES'; throw error; } },
    });
    assert.deepEqual(await present.locate(target(), agentCatalogEntry('claude')), { state: 'external', version: null });
    const missing = new EnvironmentAgentRuntime({
      dataDir: dir,
      environmentFor: async () => environment([]),
      runner: { run: async () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } },
    });
    assert.deepEqual(await missing.locate(target(), agentCatalogEntry('claude')), { state: 'missing', version: null });
  });

  it('preserves managed-version probe diagnostics instead of substituting platform guidance', async () => {
    const dir = temp(); const root = installRoot(dir, 'qwen');
    fs.mkdirSync(path.join(root, 'prefix', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'prefix', 'bin', 'qwen.cmd'), 'shim');
    const runtime = new EnvironmentAgentRuntime({
      dataDir: dir,
      environmentFor: async () => environment([]),
      runner: { run: async () => {
        const error = new Error('qwen version probe failed: missing runtime file');
        error.stdout = `actionable qwen diagnostic under ${path.join(root, '1.2.3')}`;
        throw error;
      } },
    });
    await assert.rejects(
      () => runtime.version(windowsTarget(), agentCatalogEntry('qwen'), root),
      /qwen version probe failed: missing runtime file/,
    );
  });

  it('keeps status available when an active managed command can no longer report its version', async () => {
    const dir = temp(); const root = installRoot(dir, 'qwen'); const windows = windowsTarget();
    fs.mkdirSync(path.join(root, 'prefix', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'prefix', 'bin', 'qwen.cmd'), 'shim');
    const runtime = new EnvironmentAgentRuntime({
      dataDir: dir,
      environmentFor: async () => environment([]),
      runner: { run: async () => { throw new Error('broken managed qwen'); } },
    });
    const installer = new OfficialScriptAgentInstaller({ runtime, fetcher: { get: async () => ({ status: 200, body: Buffer.from('x') }) } });
    await installer.activate({ target: windows, agent: agentCatalogEntry('qwen'), stagingRoot: root, version: '1.2.3' });
    assert.deepEqual(await runtime.locate(windows, agentCatalogEntry('qwen')), {
      state: 'managed', version: null, managedVersion: null,
    });
  });

  it('fails closed when an official endpoint has no explicit version and honors abort', async () => {
    const source = new OfficialAgentReleaseSource({ get: async () => ({ status: 200, body: Buffer.from('unversioned installer') }) });
    assert.equal(await source.latest(target(), agentCatalogEntry('claude'), new AbortController().signal), null);
    const controller = new AbortController(); controller.abort(); assert.equal(await source.latest(target(), agentCatalogEntry('codex'), controller.signal), null);
  });

  it('honors the official POSIX shebang, uses argv execution, and atomically activates only that root', async () => {
    const dir = temp(); const calls = []; const runnerCalls = []; const runtime = new EnvironmentAgentRuntime({ dataDir: dir, environmentFor: async () => environment(calls) });
    const installer = new OfficialScriptAgentInstaller({ runtime, fetcher: { get: async () => ({ status: 200, body: Buffer.from('#!/usr/bin/env bash\nset -o pipefail\n[[ 1 =~ 1 ]]\n') }) }, runner: { run: async (command, args, options) => { runnerCalls.push({ command, args, options }); return { stdout: '', stderr: '' }; } } });
    const root = path.join(dir, 'managed', 'versions', '1.2.3', 'attempts', 'op'); const input = { target: target(), agent: agentCatalogEntry('claude'), stagingRoot: root, version: '1.2.3', environment: { HOME: path.join(root, 'home'), npm_config_prefix: path.join(root, 'prefix') }, signal: new AbortController().signal };
    await installer.install(input); assert.equal(runnerCalls[0].command, 'wrapped'); assert.equal(runnerCalls[0].args[0], path.join(root, 'official-install.sh'));
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(root, 'official-install.sh')).mode & 0o777, 0o700);
    fs.mkdirSync(path.join(root, 'prefix', 'bin'), { recursive: true }); fs.writeFileSync(path.join(root, 'prefix', 'bin', 'claude'), 'binary');
    const old = path.join(dir, 'managed', 'versions', '1.1.0', 'attempts', 'old'); fs.mkdirSync(old, { recursive: true }); fs.writeFileSync(path.join(old, 'stale'), 'stale');
    await installer.activate(input); const command = runtime.resolveManagedCommand(target(), agentCatalogEntry('claude')); assert.equal(command.command, path.join(root, 'prefix', 'bin', 'claude'));
    assert.equal(fs.existsSync(path.join(dir, 'managed', 'versions', '1.1.0')), false);
  });

  it('installs Pi through pinned npm on Windows and selects the native Antigravity manifest', async () => {
    const dir = temp(); const wraps = []; const runnerCalls = [];
    const root = installRoot(dir, 'pi', '0.52.3');
    const runtime = new EnvironmentAgentRuntime({ dataDir: dir, environmentFor: async () => environment(wraps) });
    const nodeArchive = Buffer.from('official node archive');
    const nodeDigest = require('node:crypto').createHash('sha256').update(nodeArchive).digest('hex');
    const installer = new OfficialScriptAgentInstaller({
      runtime,
      fetcher: { get: async (url) => {
        if (url.endsWith('SHASUMS256.txt')) return { status: 200, body: Buffer.from(`${nodeDigest}  node-v22.19.0-win-x64.zip\n`) };
        if (url.endsWith('.zip')) return { status: 200, body: nodeArchive };
        return { status: 200, body: Buffer.from('#!/bin/bash\nexit 0\n') };
      } },
      runner: { run: async (command, args) => {
        runnerCalls.push({ command, args });
        if (args.some((arg) => String(arg).includes('extract-node.ps1'))) {
          fs.mkdirSync(path.join(root, 'node-runtime', 'node_modules', 'npm', 'bin'), { recursive: true });
          fs.writeFileSync(path.join(root, 'node-runtime', 'node.exe'), 'node');
          fs.writeFileSync(path.join(root, 'node-runtime', 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'npm');
          fs.writeFileSync(path.join(root, 'node-runtime', 'node_modules', 'npm', 'bin', 'npx-cli.js'), 'npx');
        }
        if (args.includes('@earendil-works/pi-coding-agent@0.52.3')) {
          fs.writeFileSync(path.join(root, 'prefix', 'bin', 'pi.cmd'), '@ECHO off');
        }
        return { stdout: '', stderr: '' };
      } },
    });
    const windows = windowsTarget();
    let installing = false;
    await installer.install({ target: windows, agent: agentCatalogEntry('pi'), stagingRoot: root, version: '0.52.3', environment: {}, signal: new AbortController().signal, onInstalling: () => { installing = true; } });
    assert.equal(installing, true);
    assert.equal(runnerCalls[1].args[0], path.join(root, 'node-runtime', 'node.exe'));
    assert.equal(runnerCalls[1].args[1], path.join(root, 'node-runtime', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    assert.ok(runnerCalls[1].args.includes('--ignore-scripts'));
    assert.ok(runnerCalls[1].args.includes('@earendil-works/pi-coding-agent@0.52.3'));
    assert.equal(runnerCalls.some((call) => call.args.includes('bash.exe')), false);
    assert.equal(fs.existsSync(path.join(root, 'official-install.sh')), false);
    assert.ok(fs.existsSync(path.join(root, 'prefix', 'bin', 'node.exe')));
    assert.match(fs.readFileSync(path.join(root, 'prefix', 'bin', 'pi.cmd'), 'utf8'), /node-runtime/);
    for (const tool of ['npm', 'npx']) assert.match(fs.readFileSync(path.join(root, 'prefix', 'bin', `${tool}.cmd`), 'utf8'), new RegExp(`${tool}-cli\\.js`));

    let requested = '';
    const releases = new OfficialAgentReleaseSource({ get: async (url) => { requested = url; return { status: 200, body: Buffer.from('{"version":"1.1.7"}') }; } });
    assert.deepEqual(await releases.latest({ ...windows, architecture: 'arm64' }, agentCatalogEntry('antigravity'), new AbortController().signal), { version: '1.1.7', prerelease: true });
    assert.match(requested, /windows_arm64\.json$/);
  });

  it('honors every official Windows installer contract with an isolated profile', async () => {
    const contracts = [
      ['claude', ['1.2.3']],
      ['codex', ['-Release', '1.2.3']],
      ['pi', null],
      ['grok', ['-Version', '1.2.3']],
      ['qwen', null],
      ['kimi', []],
      ['omp', ['-Binary', '-Ref', 'v1.2.3']],
      ['antigravity', null],
    ];
    const outputs = {
      claude: [path.join('home', '.local', 'bin', 'claude.exe')],
      codex: [path.join('prefix', 'bin', 'codex.exe')],
      pi: [path.join('prefix', 'bin', 'pi.cmd')],
      grok: [path.join('prefix', 'bin', 'grok.exe'), path.join('prefix', 'bin', 'agent.exe')],
      qwen: [path.join('prefix', 'bin', 'qwen.cmd')],
      kimi: [path.join('prefix', 'bin', 'kimi.exe')],
      omp: [path.join('prefix', 'bin', 'omp.exe')],
      antigravity: [path.join('prefix', 'bin', 'agy.exe')],
    };
    for (const [agentId, expectedTail] of contracts) {
      const dir = temp(); const root = installRoot(dir, agentId); const wraps = []; const calls = []; const urls = [];
      const nodeArchive = Buffer.from(`node-${agentId}`);
      const nodeDigest = require('node:crypto').createHash('sha256').update(nodeArchive).digest('hex');
      const runtime = new EnvironmentAgentRuntime({ dataDir: dir, environmentFor: async () => environment(wraps) });
      const installer = new OfficialScriptAgentInstaller({
        runtime,
        fetcher: { get: async (url) => {
          urls.push(url);
          if (url.endsWith('SHASUMS256.txt')) return { status: 200, body: Buffer.from(`${nodeDigest}  node-v22.19.0-win-x64.zip\n`) };
          if (url.endsWith('.zip')) return { status: 200, body: nodeArchive };
          return { status: 200, body: Buffer.from('official Windows installer') };
        } },
        runner: { run: async (command, args, options) => {
          calls.push({ command, args, options });
          if (args.some((arg) => String(arg).includes('extract-node.ps1'))) {
            const npm = path.join(root, 'node-runtime', 'node_modules', 'npm', 'bin');
            fs.mkdirSync(npm, { recursive: true });
            fs.writeFileSync(path.join(root, 'node-runtime', 'node.exe'), 'node');
            fs.writeFileSync(path.join(npm, 'npm-cli.js'), 'npm');
            fs.writeFileSync(path.join(npm, 'npx-cli.js'), 'npx');
          }
          const installationInvocation = args.some((arg) => String(arg).endsWith('official-install.ps1'))
            || args.some((arg) => String(arg).startsWith('@earendil-works/pi-coding-agent@'))
            || args.some((arg) => String(arg).startsWith('@qwen-code/qwen-code@'));
          if (installationInvocation) {
            for (const relative of outputs[agentId]) {
              fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
              fs.writeFileSync(path.join(root, relative), 'managed command');
            }
          }
          return { stdout: '', stderr: '' };
        } },
      });
      const windows = windowsTarget();
      await installer.install({ target: windows, agent: agentCatalogEntry(agentId), stagingRoot: root, version: '1.2.3', environment: {}, signal: new AbortController().signal });
      const invocation = ['pi', 'qwen'].includes(agentId)
        ? calls.find((call) => call.args.some((arg) => String(arg).includes(agentId === 'pi' ? '@earendil-works/pi-coding-agent@1.2.3' : '@qwen-code/qwen-code@1.2.3')))
        : calls.find((call) => call.args.some((arg) => String(arg).endsWith('official-install.ps1')));
      assert.ok(invocation, `${agentId} has a Windows installation invocation`);
      assert.equal(invocation.options.env.OS, 'Windows_NT');
      assert.equal(invocation.options.env.USERPROFILE, path.join(root, 'home'));
      assert.equal(invocation.options.env.LOCALAPPDATA, path.join(root, 'home', 'AppData', 'Local'));
      assert.equal(invocation.options.env.APPDATA, path.join(root, 'home', 'AppData', 'Roaming'));
      assert.equal(invocation.options.env.PROCESSOR_ARCHITECTURE, 'AMD64');
      assert.equal('PROCESSOR_ARCHITEW6432' in invocation.options.env, false);
      assert.equal(fs.existsSync(invocation.options.env.LOCALAPPDATA), true);
      if (agentId === 'pi' || agentId === 'qwen') {
        assert.equal(urls.some((url) => url === 'https://pi.dev/install.sh'), false);
        assert.equal(invocation.args.includes('--ignore-scripts'), agentId === 'pi');
        assert.ok(invocation.args.includes('--prefix'));
      } else {
        const scriptAt = invocation.args.findIndex((arg) => String(arg).endsWith('official-install.ps1'));
        const actualTail = invocation.args.slice(scriptAt + 1);
        if (agentId === 'antigravity') {
          assert.deepEqual(actualTail, ['--dir', path.join(root, 'prefix', 'bin'), '--skip-aliases', '--skip-path']);
        } else {
          assert.deepEqual(actualTail, expectedTail, `${agentId} PowerShell arguments`);
        }
      }
      if (agentId === 'codex') {
        assert.equal(invocation.options.env.CODEX_RELEASE, '1.2.3');
        assert.equal(invocation.options.env.CODEX_NON_INTERACTIVE, '1');
        assert.equal(invocation.options.env.CODEX_INSTALL_DIR, path.join(root, 'prefix', 'bin'));
      }
      if (agentId === 'grok') {
        assert.equal(invocation.options.env.GROK_VERSION, '1.2.3');
        assert.equal(invocation.options.env.GROK_CHANNEL, 'stable');
        assert.equal(invocation.options.env.GROK_BIN_DIR, path.join(root, 'prefix', 'bin'));
      }
      if (agentId === 'qwen') {
        assert.equal(invocation.options.env.QWEN_INSTALL_VERSION, '1.2.3');
        assert.equal(invocation.options.env.QWEN_INSTALL_METHOD, 'npm');
        assert.equal(invocation.options.env.QWEN_NO_MODIFY_PATH, '1');
      }
      if (agentId === 'kimi') {
        assert.equal(invocation.options.env.KIMI_VERSION, '1.2.3');
        assert.equal(invocation.options.env.KIMI_INSTALL_DIR, path.join(root, 'prefix'));
        assert.equal(invocation.options.env.KIMI_NO_MODIFY_PATH, '1');
      }
      for (const relative of outputs[agentId]) assert.equal(fs.existsSync(path.join(root, relative)), true, `${agentId} output ${relative}`);
      if (agentId === 'pi') {
        assert.equal(fs.existsSync(path.join(root, 'prefix', 'bin', 'npm.cmd')), true);
        assert.equal(fs.existsSync(path.join(root, 'prefix', 'bin', 'npx.cmd')), true);
      }
      if (['codex', 'grok', 'omp'].includes(agentId)) {
        const cleanup = calls.find((call) => call.args.some((arg) => String(arg).endsWith('cleanup-user-path.ps1')));
        assert.ok(cleanup, `${agentId} removes only its managed user PATH entry`);
        assert.deepEqual(JSON.parse(cleanup.options.env.CAWC_MANAGED_ROOTS), [path.join(dir, 'agent-maintenance', targetIdentity().slice(0, 24), agentId)]);
        const source = fs.readFileSync(path.join(root, 'cleanup-user-path.ps1'), 'utf8');
        assert.match(source, /OrdinalIgnoreCase/);
        assert.match(source, /CAWC_MANAGED_ROOTS/);
      }
    }
  });

  it('uses managed Node and npm for Qwen on Windows ARM64', async () => {
    const dir = temp(); const root = installRoot(dir, 'qwen', '0.21.7'); const calls = [];
    const nodeArchive = Buffer.from('arm64 node');
    const nodeDigest = require('node:crypto').createHash('sha256').update(nodeArchive).digest('hex');
    const runtime = new EnvironmentAgentRuntime({ dataDir: dir, environmentFor: async () => environment([]) });
    const installer = new OfficialScriptAgentInstaller({
      runtime,
      fetcher: { get: async (url) => {
        if (url.endsWith('SHASUMS256.txt')) return { status: 200, body: Buffer.from(`${nodeDigest}  node-v22.19.0-win-arm64.zip\n`) };
        if (url.endsWith('.zip')) return { status: 200, body: nodeArchive };
        return { status: 200, body: Buffer.from('qwen installer') };
      } },
      runner: { run: async (_command, args, options) => {
        calls.push({ args, options });
        if (args.some((arg) => String(arg).includes('extract-node.ps1'))) {
          const npm = path.join(root, 'node-runtime', 'node_modules', 'npm', 'bin');
          fs.mkdirSync(npm, { recursive: true });
          fs.writeFileSync(path.join(root, 'node-runtime', 'node.exe'), 'node');
          fs.writeFileSync(path.join(npm, 'npm-cli.js'), 'npm');
          fs.writeFileSync(path.join(npm, 'npx-cli.js'), 'npx');
        }
        if (args.includes('@qwen-code/qwen-code@0.21.7')) fs.writeFileSync(path.join(root, 'prefix', 'bin', 'qwen.cmd'), 'qwen');
        return { stdout: '', stderr: '' };
      } },
    });
    await installer.install({
      target: windowsTarget('arm64'), agent: agentCatalogEntry('qwen'),
      stagingRoot: root, version: '0.21.7', environment: {}, signal: new AbortController().signal,
    });
    const invocation = calls.find((call) => call.args.includes('@qwen-code/qwen-code@0.21.7'));
    assert.equal(invocation.options.env.QWEN_INSTALL_METHOD, 'npm');
    assert.equal(invocation.options.env.npm_config_prefix, path.join(root, 'prefix', 'bin'));
    assert.equal(invocation.options.env.PROCESSOR_ARCHITECTURE, 'ARM64');
    assert.match(invocation.options.env.PATH, /node-runtime/);
    assert.equal(invocation.args.includes('--ignore-scripts'), false);
    assert.equal(fs.existsSync(path.join(root, 'official-install.ps1')), false);
    assert.equal(fs.existsSync(path.join(root, 'prefix', 'bin', 'qwen.cmd')), true);
  });

  it('cleans a Windows user PATH entry even after installer cancellation', async () => {
    const dir = temp(); const root = installRoot(dir, 'codex', '1.2.3', 'cancelled'); const calls = [];
    const legacyRoot = path.join(dir, 'agent-maintenance', targetIdentity(), 'codex', 'versions', '1.0.0', 'attempts', 'active');
    const controller = new AbortController();
    const runtime = new EnvironmentAgentRuntime({ dataDir: dir, environmentFor: async () => environment([]) });
    const installer = new OfficialScriptAgentInstaller({
      runtime,
      fetcher: { get: async () => ({ status: 200, body: Buffer.from('codex installer') }) },
      runner: { run: async (_command, args, options) => {
        calls.push({ args, options });
        if (args.some((arg) => String(arg).endsWith('official-install.ps1'))) {
          controller.abort();
          throw new Error('installation cancelled');
        }
        return { stdout: '', stderr: '' };
      } },
    });
    fs.mkdirSync(path.join(legacyRoot, 'prefix', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(legacyRoot, 'prefix', 'bin', 'codex.exe'), 'old');
    await installer.activate({ target: windowsTarget(), agent: agentCatalogEntry('codex'), stagingRoot: legacyRoot, version: '1.0.0' });
    await assert.rejects(() => installer.install({
      target: windowsTarget(), agent: agentCatalogEntry('codex'), stagingRoot: root,
      version: '1.2.3', environment: {}, signal: controller.signal,
    }), /installation cancelled/);
    const cleanup = calls.find((call) => call.args.some((arg) => String(arg).endsWith('cleanup-user-path.ps1')));
    assert.ok(cleanup);
    assert.equal(cleanup.options.signal, undefined);
    assert.equal(cleanup.options.timeoutMs, 10_000);
    assert.deepEqual(JSON.parse(cleanup.options.env.CAWC_MANAGED_ROOTS), [
      path.join(dir, 'agent-maintenance', targetIdentity().slice(0, 24), 'codex'),
      path.join(dir, 'agent-maintenance', targetIdentity(), 'codex'),
    ]);
  });

  it('discovers Windows npm shims at both managed prefix layouts', async () => {
    const dir = temp(); const runtime = new EnvironmentAgentRuntime({ dataDir: dir, environmentFor: async () => environment([]) });
    const installer = new OfficialScriptAgentInstaller({ runtime, fetcher: { get: async () => ({ status: 200, body: Buffer.from('x') }) } });
    const windows = windowsTarget();
    for (const relative of [path.join('prefix', 'bin', 'qwen.cmd'), path.join('prefix', 'qwen.cmd')]) {
      const root = path.join(dir, 'managed', String(Math.random()), 'versions', '1.0.0', 'attempts', 'op');
      fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      fs.writeFileSync(path.join(root, relative), 'shim');
      await installer.activate({ target: windows, agent: agentCatalogEntry('qwen'), stagingRoot: root, version: '1.0.0' });
      assert.equal(runtime.resolveManagedCommand(windows, agentCatalogEntry('qwen')).command, path.join(root, relative));
    }
  });

  it('removes the previously active legacy version after compact-layout activation', async () => {
    const dir = temp(); const runtime = new EnvironmentAgentRuntime({ dataDir: dir, environmentFor: async () => environment([]) });
    const installer = new OfficialScriptAgentInstaller({ runtime, fetcher: { get: async () => ({ status: 200, body: Buffer.from('x') }) } });
    const windows = windowsTarget();
    const legacy = path.join(dir, 'agent-maintenance', targetIdentity(), 'claude', 'versions', '1.0.0', 'attempts', 'old');
    const compact = installRoot(dir, 'claude', '1.1.0', 'new');
    for (const root of [legacy, compact]) {
      fs.mkdirSync(path.join(root, 'prefix', 'bin'), { recursive: true });
      fs.writeFileSync(path.join(root, 'prefix', 'bin', 'claude.exe'), 'binary');
    }
    await installer.activate({ target: windows, agent: agentCatalogEntry('claude'), stagingRoot: legacy, version: '1.0.0' });
    await installer.activate({ target: windows, agent: agentCatalogEntry('claude'), stagingRoot: compact, version: '1.1.0' });
    assert.equal(fs.existsSync(path.join(dir, 'agent-maintenance', targetIdentity(), 'claude', 'versions', '1.0.0')), false);
    assert.equal(runtime.resolveManagedCommand(windows, agentCatalogEntry('claude')).command, path.join(compact, 'prefix', 'bin', 'claude.exe'));
  });

  it('never recursively cleans a shaped pointer outside the exact managed target scope', async () => {
    const dir = temp(); const runtime = new EnvironmentAgentRuntime({ dataDir: dir, environmentFor: async () => environment([]) });
    const installer = new OfficialScriptAgentInstaller({ runtime, fetcher: { get: async () => ({ status: 200, body: Buffer.from('x') }) } });
    const windows = windowsTarget();
    const foreign = path.join(dir, 'agent-maintenance', 'different-target', 'claude', 'versions', '1.0.0', 'attempts', 'old');
    const compact = installRoot(dir, 'claude', '1.1.0', 'new');
    for (const root of [foreign, compact]) {
      fs.mkdirSync(path.join(root, 'prefix', 'bin'), { recursive: true });
      fs.writeFileSync(path.join(root, 'prefix', 'bin', 'claude.exe'), 'binary');
    }
    await installer.activate({ target: windows, agent: agentCatalogEntry('claude'), stagingRoot: foreign, version: '1.0.0' });
    await installer.activate({ target: windows, agent: agentCatalogEntry('claude'), stagingRoot: compact, version: '1.1.0' });
    assert.equal(fs.existsSync(path.join(dir, 'agent-maintenance', 'different-target', 'claude', 'versions', '1.0.0')), true);
  });

  it('preserves Windows publisher failures instead of replacing them with runtime guidance', async () => {
    const dir = temp(); const runtime = new EnvironmentAgentRuntime({ dataDir: dir, environmentFor: async () => environment([]) });
    const windows = windowsTarget();
    const install = async (agentId, message) => {
      const installer = new OfficialScriptAgentInstaller({
        runtime,
        fetcher: { get: async () => ({ status: 200, body: Buffer.from('official installer') }) },
        runner: { run: async () => { throw new Error(message); } },
      });
      return installer.install({
        target: windows, agent: agentCatalogEntry(agentId), stagingRoot: path.join(dir, agentId),
        version: '1.2.3', environment: {}, signal: new AbortController().signal,
      });
    };
    await assert.rejects(() => install('codex', 'publisher returned 503'), (error) => {
      assert.match(error.message, /publisher returned 503/);
      return true;
    });
    await assert.rejects(() => install('kimi', 'Git Bash not found'), /Git Bash not found/);
  });

  it('does not expose server or provider credentials to publisher probes and installers', async () => {
    const dir = temp(); const previous = process.env.CODE_AGENTS_TEST_PROVIDER_SECRET;
    const previousArchitecture = process.env.PROCESSOR_ARCHITECTURE;
    process.env.CODE_AGENTS_TEST_PROVIDER_SECRET = 'must-not-leak';
    process.env.PROCESSOR_ARCHITECTURE = 'ARM64';
    const seen = [];
    try {
      const host = new HostEnvironment(dir);
      const runtime = new EnvironmentAgentRuntime({
        dataDir: dir,
        environmentFor: async () => host,
        runner: { run: async (_command, _args, options) => { seen.push(options.env); return { stdout: 'claude 1.2.3', stderr: '' }; } },
      });
      await runtime.locate(target(), agentCatalogEntry('claude'));
      const installer = new OfficialScriptAgentInstaller({
        runtime,
        fetcher: { get: async () => ({ status: 200, body: Buffer.from('#!/bin/sh\nexit 0\n') }) },
        runner: { run: async (_command, _args, options) => { seen.push(options.env); return { stdout: '', stderr: '' }; } },
      });
      const root = path.join(dir, 'safe-env');
      await installer.install({ target: target(), agent: agentCatalogEntry('claude'), stagingRoot: root, version: '1.2.3', environment: {}, signal: new AbortController().signal });
      assert.equal(seen.length, 2);
      assert.equal(seen.some((env) => env.CODE_AGENTS_TEST_PROVIDER_SECRET === 'must-not-leak'), false);
      assert.ok(seen.every((env) => typeof env.PATH === 'string'));
      assert.ok(seen.every((env) => env.PROCESSOR_ARCHITECTURE === 'ARM64'));
    } finally {
      if (previous === undefined) delete process.env.CODE_AGENTS_TEST_PROVIDER_SECRET;
      else process.env.CODE_AGENTS_TEST_PROVIDER_SECRET = previous;
      if (previousArchitecture === undefined) delete process.env.PROCESSOR_ARCHITECTURE;
      else process.env.PROCESSOR_ARCHITECTURE = previousArchitecture;
    }
  });
});
