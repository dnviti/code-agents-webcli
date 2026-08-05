const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  JsonFileAgentMaintenanceStore, EnvironmentAgentRuntime, OfficialAgentReleaseSource, OfficialScriptAgentInstaller,
} = require('../dist/server/services/agent-maintenance-runtime.js');
const { HostEnvironment } = require('../dist/server/services/environments/manager.js');
const { agentCatalogEntry } = require('../dist/shared/agent-maintenance.js');

function target() { return { key: 'server:env:private:7', platform: 'linux', architecture: 'x64', scope: 'private', ownerUserId: 7 }; }
function temp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-maintenance-')); }
function environment(calls) { return { wrap(command, args, options = {}) { calls.push({ command, args, options }); return { command: 'wrapped', args: [command, ...args], env: options.env || {} }; } }; }

describe('agent maintenance runtime adapters', () => {
  it('persists operation/check records atomically with owner-only permissions', () => {
    const dir = temp(); const store = new JsonFileAgentMaintenanceStore(dir);
    store.saveOperation({ id: 'op', targetKey: 't', agentId: 'claude', kind: 'install', phase: 'failed', createdAt: 1, updatedAt: 1, version: null, error: 'x', retryable: true, canCancel: false, cancelReason: 'done' });
    store.saveOperation({ id: 'complete', targetKey: 'other', agentId: 'codex', kind: 'update', phase: 'complete', createdAt: 1, updatedAt: 2, version: '1.2.3', error: null, retryable: false, canCancel: false, cancelReason: 'done' });
    store.saveCheck({ targetKey: 't', agentId: 'claude', latestVersion: '1.2.3', state: 'current', checkedAt: 1 });
    const file = path.join(dir, 'agent-maintenance.json'); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const restored = new JsonFileAgentMaintenanceStore(dir); assert.deepEqual(restored.loadOperations().map((item) => item.id), ['op']); assert.equal(restored.loadCheck('t', 'claude').latestVersion, '1.2.3');
  });

  it('probes through environment wrapping and preserves an external copy', async () => {
    const dir = temp(); const calls = []; const runtime = new EnvironmentAgentRuntime({ dataDir: dir, environmentFor: async () => environment(calls), runner: { run: async () => ({ stdout: 'claude 1.2.3', stderr: '' }) } });
    const located = await runtime.locate(target(), agentCatalogEntry('claude'));
    assert.deepEqual(located, { state: 'external', version: '1.2.3' }); assert.equal(calls[0].command, 'claude');
    assert.equal(runtime.resolveManagedCommand(target(), agentCatalogEntry('claude')), null);
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

  it('fails closed when an official endpoint has no explicit version and honors abort', async () => {
    const source = new OfficialAgentReleaseSource({ get: async () => ({ status: 200, body: Buffer.from('unversioned installer') }) });
    assert.equal(await source.latest(target(), agentCatalogEntry('claude'), new AbortController().signal), null);
    const controller = new AbortController(); controller.abort(); assert.equal(await source.latest(target(), agentCatalogEntry('codex'), controller.signal), null);
  });

  it('honors the official POSIX shebang, uses argv execution, and atomically activates only that root', async () => {
    const dir = temp(); const calls = []; const runnerCalls = []; const runtime = new EnvironmentAgentRuntime({ dataDir: dir, environmentFor: async () => environment(calls) });
    const installer = new OfficialScriptAgentInstaller({ runtime, fetcher: { get: async () => ({ status: 200, body: Buffer.from('#!/usr/bin/env bash\nset -o pipefail\n[[ 1 =~ 1 ]]\n') }) }, runner: { run: async (command, args, options) => { runnerCalls.push({ command, args, options }); return { stdout: '', stderr: '' }; } } });
    const root = path.join(dir, 'managed', 'versions', '1.2.3', 'attempts', 'op'); const input = { target: target(), agent: agentCatalogEntry('claude'), stagingRoot: root, version: '1.2.3', environment: { HOME: path.join(root, 'home'), npm_config_prefix: path.join(root, 'prefix') }, signal: new AbortController().signal };
    await installer.install(input); assert.equal(runnerCalls[0].command, 'wrapped'); assert.equal(runnerCalls[0].args[0], path.join(root, 'official-install.sh')); assert.equal(fs.statSync(path.join(root, 'official-install.sh')).mode & 0o777, 0o700);
    fs.mkdirSync(path.join(root, 'prefix', 'bin'), { recursive: true }); fs.writeFileSync(path.join(root, 'prefix', 'bin', 'claude'), 'binary');
    const old = path.join(dir, 'managed', 'versions', '1.1.0', 'attempts', 'old'); fs.mkdirSync(old, { recursive: true }); fs.writeFileSync(path.join(old, 'stale'), 'stale');
    await installer.activate(input); const command = runtime.resolveManagedCommand(target(), agentCatalogEntry('claude')); assert.equal(command.command, path.join(root, 'prefix', 'bin', 'claude'));
    assert.equal(fs.existsSync(path.join(dir, 'managed', 'versions', '1.1.0')), false);
  });

  it('uses the documented Windows Bash prerequisite for pi and native manifest for Antigravity', async () => {
    const dir = temp(); const wraps = []; const runnerCalls = [];
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
        if (args[0] === 'powershell.exe') {
          fs.mkdirSync(path.join(dir, 'pi-windows', 'node-runtime'), { recursive: true });
          fs.writeFileSync(path.join(dir, 'pi-windows', 'node-runtime', 'node.exe'), 'node');
        }
        return { stdout: '', stderr: '' };
      } },
    });
    const windows = { ...target(), platform: 'win32' };
    const root = path.join(dir, 'pi-windows');
    let installing = false;
    await installer.install({ target: windows, agent: agentCatalogEntry('pi'), stagingRoot: root, version: '0.52.3', environment: {}, signal: new AbortController().signal, onInstalling: () => { installing = true; } });
    assert.equal(installing, true);
    assert.equal(runnerCalls[1].args[0], 'bash.exe');
    assert.ok(fs.existsSync(path.join(root, 'official-install.sh')));
    assert.ok(fs.existsSync(path.join(root, 'prefix', 'bin', 'node.exe')));

    let requested = '';
    const releases = new OfficialAgentReleaseSource({ get: async (url) => { requested = url; return { status: 200, body: Buffer.from('{"version":"1.1.7"}') }; } });
    assert.deepEqual(await releases.latest({ ...windows, architecture: 'arm64' }, agentCatalogEntry('antigravity'), new AbortController().signal), { version: '1.1.7', prerelease: true });
    assert.match(requested, /windows_arm64\.json$/);
  });

  it('does not expose server or provider credentials to publisher probes and installers', async () => {
    const dir = temp(); const previous = process.env.CODE_AGENTS_TEST_PROVIDER_SECRET;
    process.env.CODE_AGENTS_TEST_PROVIDER_SECRET = 'must-not-leak';
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
    } finally {
      if (previous === undefined) delete process.env.CODE_AGENTS_TEST_PROVIDER_SECRET;
      else process.env.CODE_AGENTS_TEST_PROVIDER_SECRET = previous;
    }
  });
});
