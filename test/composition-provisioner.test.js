const assert = require('assert');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  PINNED_MISE_ARTIFACTS,
  PINNED_TEA_ARTIFACTS,
  PINNED_TEA_VERSION,
  ProjectProvisioner,
  fetchPinnedMiseArtifact,
  fetchPinnedTeaArtifact,
  probeTargetPlatform,
  withOwnerToolVersionLock,
} = require('../dist/server/services/composition/provisioner.js');
const {
  FORGE_CATALOG,
  ForgeCredentialMaterializer,
  forgeEnvironment,
  forgeForHost,
} = require('../dist/server/services/composition/forge.js');

class MemoryInstallationState {
  constructor() { this.byComposition = new Map(); }
  ensureItems(compositionId, items) {
    const records = this.byComposition.get(compositionId) || [];
    for (const item of items) {
      if (!records.some((record) => record.id === item.id)) {
        records.push({ ...item, status: 'pending', attempts: 0, installedVersion: null, errorCode: null, errorMessage: null });
      }
    }
    this.byComposition.set(compositionId, records);
  }
  list(compositionId) { return (this.byComposition.get(compositionId) || []).map((record) => ({ ...record })); }
  record(compositionId, itemId) { return this.byComposition.get(compositionId).find((record) => record.id === itemId); }
  markInstalling(compositionId, itemId) { const record = this.record(compositionId, itemId); record.status = 'installing'; record.attempts += 1; }
  markInstalled(compositionId, itemId, version) { const record = this.record(compositionId, itemId); Object.assign(record, { status: 'installed', installedVersion: version, errorCode: null, errorMessage: null }); }
  markFailed(compositionId, itemId, errorCode, errorMessage) { const record = this.record(compositionId, itemId); Object.assign(record, { status: 'failed', errorCode, errorMessage }); }
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'composition-provisioner-'));
  const owner = path.join(root, 'owner');
  const overlay = path.join(root, 'overlay');
  fs.mkdirSync(owner, { mode: 0o700 });
  fs.mkdirSync(overlay, { mode: 0o700 });
  return { root, owner, overlay };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

describe('composition provisioning foundation', function () {
  it('pins all Linux architecture/libc binaries to the verified v2026.8.1 checksums', function () {
    assert.strictEqual(Object.isFrozen(PINNED_MISE_ARTIFACTS), true);
    assert.deepStrictEqual(PINNED_MISE_ARTIFACTS.map((artifact) => ({
      key: `${artifact.platform.arch}-${artifact.platform.libc}`,
      url: artifact.url,
      sha256: artifact.sha256,
    })), [
      { key: 'arm64-glibc', url: 'https://github.com/jdx/mise/releases/download/v2026.8.1/mise-v2026.8.1-linux-arm64', sha256: '54f9e0b4c4085cde1c80e107671a0058d4b234f7d2fc6bd3b61ead68df6cfcef' },
      { key: 'arm64-musl', url: 'https://github.com/jdx/mise/releases/download/v2026.8.1/mise-v2026.8.1-linux-arm64-musl', sha256: '509e42504b83347d8ae3d63f6d284c4a8f8c807ec775a102cfc20d7c8bef4b0b' },
      { key: 'x64-glibc', url: 'https://github.com/jdx/mise/releases/download/v2026.8.1/mise-v2026.8.1-linux-x64', sha256: '961b1fcc78830e861ab887abd19d9b961478bcf252e37881fdd61c81388308d4' },
      { key: 'x64-musl', url: 'https://github.com/jdx/mise/releases/download/v2026.8.1/mise-v2026.8.1-linux-x64-musl', sha256: '522fd15a3b0748d8a240bdf06cd45f679f759a097e2f49b436363e92c48fdbdc' },
    ]);
  });

  it('pins both official tea v0.15.1 Linux binaries to their release checksums', function () {
    assert.strictEqual(PINNED_TEA_VERSION, '0.15.1');
    assert.strictEqual(Object.isFrozen(PINNED_TEA_ARTIFACTS), true);
    assert.deepStrictEqual(PINNED_TEA_ARTIFACTS.map((artifact) => ({
      arch: artifact.platform.arch,
      url: artifact.url,
      sha256: artifact.sha256,
    })), [
      {
        arch: 'arm64',
        url: 'https://gitea.com/gitea/tea/releases/download/v0.15.1/tea-0.15.1-linux-arm64',
        sha256: '0db109df6696bfe01f9203402f503404692404d4ea9c16a540ecaeecc8e6bab2',
      },
      {
        arch: 'x64',
        url: 'https://gitea.com/gitea/tea/releases/download/v0.15.1/tea-0.15.1-linux-amd64',
        sha256: 'aac99cc6e650a81ae7b5061f8c75bc0eade4509c828d97b6072e1f0a3bd24357',
      },
    ]);
  });

  it('follows signed HTTPS release redirects only from the fixed official hosts', async function () {
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, options) => {
      calls.push({ url: String(url), options });
      return {
        ok: true,
        url: 'https://signed-artifacts.example.test/object',
        headers: { get: () => '7' },
        arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4, 5, 6, 7]).buffer,
      };
    };
    try {
      await fetchPinnedMiseArtifact({
        version: 'fixture', platform: { os: 'linux', arch: 'x64', libc: 'glibc' },
        url: 'https://github.com/jdx/mise/releases/download/v1/mise', sha256: 'a'.repeat(64),
      });
      await fetchPinnedTeaArtifact({
        version: 'fixture', platform: { os: 'linux', arch: 'x64' },
        url: 'https://gitea.com/gitea/tea/releases/download/v1/tea', sha256: 'b'.repeat(64),
      });
      assert.deepStrictEqual(calls.map((call) => call.options.redirect), ['follow', 'follow']);
      await assert.rejects(() => fetchPinnedMiseArtifact({
        version: 'fixture', platform: { os: 'linux', arch: 'x64', libc: 'glibc' },
        url: 'https://example.test/mise', sha256: 'a'.repeat(64),
      }), /pin is invalid/);
      await assert.rejects(() => fetchPinnedTeaArtifact({
        version: 'fixture', platform: { os: 'linux', arch: 'x64' },
        url: 'https://example.test/tea', sha256: 'b'.repeat(64),
      }), /pin is invalid/);
      assert.strictEqual(calls.length, 2);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('allows the declared size of the pinned v2026.8.1 x64 binary', async function () {
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      url: 'https://release-assets.githubusercontent.com/pinned-mise',
      headers: { get: (name) => name === 'content-length' ? '110870608' : null },
      arrayBuffer: async () => Uint8Array.from([1]).buffer,
    });
    try {
      const bytes = await fetchPinnedMiseArtifact({
        version: 'v2026.8.1', platform: { os: 'linux', arch: 'x64', libc: 'glibc' },
        url: 'https://github.com/jdx/mise/releases/download/v2026.8.1/mise-v2026.8.1-linux-x64',
        sha256: 'a'.repeat(64),
      });
      assert.deepStrictEqual([...bytes], [1]);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('probes target compatibility with one fixed script and normalises architecture', async function () {
    const calls = [];
    const platform = await probeTargetPlatform({ run: async (command, args) => {
      calls.push({ command, args });
      return { stdout: 'Linux\naarch64\nmusl\n', stderr: '' };
    } });
    assert.deepStrictEqual(platform, { os: 'linux', arch: 'arm64', libc: 'musl', namespace: 'linux-arm64-musl' });
    assert.strictEqual(calls[0].command, 'sh');
    assert.ok(calls[0].args[1].includes('command -v bash'));
    assert.ok(calls[0].args[1].includes('command -v git'));
    assert.ok(calls[0].args[1].includes('command -v setsid'));
    assert.ok(!calls[0].args[1].includes('/workspace'));
  });

  it('installs independently, writes a durable activation, and retries only failures', async function () {
    const { root, owner, overlay } = fixture();
    const state = new MemoryInstallationState();
    const binary = Buffer.from('fixture mise binary');
    const checksum = crypto.createHash('sha256').update(binary).digest('hex');
    const calls = [];
    let failPython = true;
    const runner = { run: async (command, args, options = {}) => {
      calls.push({ command, args: [...args], options });
      if (args.at(-1) === 'python@3.13' && failPython) throw new Error('unsafe remote detail');
      return { stdout: '', stderr: '' };
    } };
    const provisioner = new ProjectProvisioner({
      runner,
      state,
      artifacts: [{
        version: 'test', platform: { os: 'linux', arch: 'x64', libc: 'glibc' },
        url: 'https://example.test/mise', sha256: checksum,
      }],
      fetchArtifact: async () => binary,
      probe: async () => ({ os: 'linux', arch: 'x64', libc: 'glibc', namespace: 'linux-x64-glibc' }),
    });
    const request = {
      compositionId: 'revision-1', ownerHomeHost: owner, ownerHomeContainer: '/home/ada',
      projectOverlayHost: overlay,
      items: [
        { id: 'node', tool: 'node', version: '22.18.0' },
        { id: 'python', tool: 'python', version: '3.13' },
      ],
    };
    const first = await provisioner.provision(request);
    assert.deepStrictEqual(first.items.map(({ id, status, attempts, errorCode }) => ({ id, status, attempts, errorCode })), [
      { id: 'node', status: 'installed', attempts: 1, errorCode: null },
      { id: 'python', status: 'failed', attempts: 1, errorCode: 'INSTALL_FAILED' },
    ]);
    assert.ok(!first.items[1].errorMessage.includes('unsafe remote detail'));
    const installs = calls.filter((call) => call.args.includes('install'));
    for (const call of installs) {
      assert.deepStrictEqual(call.args.slice(0, 4), ['--no-config', '--no-hooks', 'install', '--yes']);
      assert.strictEqual(call.options.cwd, '/opt/code-agents-project');
      assert.match(call.options.env.MISE_SHIMS_DIR,
        /^\/opt\/code-agents-project\/\.mise-install-shims\/[0-9a-f-]{36}$/);
      assert.strictEqual(JSON.stringify(call).includes('token'), false);
    }
    const isolatedShims = installs.map((call) => call.options.env.MISE_SHIMS_DIR);
    assert.strictEqual(new Set(isolatedShims).size, 2);
    const stagingCleanups = calls.filter((call) => (
      call.command === 'rm' && call.args[0] === '-rf' && isolatedShims.includes(call.args[2])
    ));
    assert.deepStrictEqual(new Set(stagingCleanups.map((call) => call.args[2])), new Set(isolatedShims),
      'staging shims are removed after both successful and failed installs');
    const reshims = calls.filter((call) => call.args.at(-1) === 'reshim');
    assert.strictEqual(reshims.length, 1);
    assert.strictEqual(reshims[0].options.env.MISE_SHIMS_DIR,
      '/home/ada/.local/share/code-agents/mise/shims');
    const miseHost = path.join(owner, '.local', 'share', 'code-agents', 'platforms', 'linux-x64-glibc', 'bin', 'mise');
    assert.strictEqual(fs.statSync(miseHost).mode & 0o777, 0o700);
    const stableMise = path.join(owner, '.local', 'bin', 'mise');
    assert.strictEqual(fs.statSync(stableMise).mode & 0o777, 0o700);
    assert.notStrictEqual(fs.statSync(stableMise).ino, fs.statSync(miseHost).ino);
    assert.match(fs.readFileSync(stableMise, 'utf8'), /linux-\$code_agents_arch-\$code_agents_libc\/bin\/mise/);
    assert.match(fs.readFileSync(path.join(overlay, 'mise.toml'), 'utf8'), /node = "22\.18\.0"[\s\S]*python = "3\.13"/);

    failPython = false;
    const beforeRetry = calls.length;
    const retried = await provisioner.retryFailed(request);
    const retryInstalls = calls.slice(beforeRetry).filter((call) => call.args.includes('install'));
    assert.strictEqual(retryInstalls.length, 1);
    assert.strictEqual(retryInstalls[0].args.at(-1), 'python@3.13');
    assert.deepStrictEqual(retried.items.map(({ id, status, attempts }) => ({ id, status, attempts })), [
      { id: 'node', status: 'installed', attempts: 1 },
      { id: 'python', status: 'installed', attempts: 2 },
    ]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('installs an agent package through its fixed backend and publishes its executable shim', async function () {
    const { root, owner, overlay } = fixture();
    const state = new MemoryInstallationState();
    const binary = Buffer.from('fixture mise binary for agent install');
    const checksum = crypto.createHash('sha256').update(binary).digest('hex');
    const calls = [];
    const provisioner = new ProjectProvisioner({
      runner: { run: async (command, args, options = {}) => {
        calls.push({ command, args: [...args], options });
        return { stdout: '', stderr: '' };
      } },
      state,
      artifacts: [{
        version: 'test', platform: { os: 'linux', arch: 'x64', libc: 'glibc' },
        url: 'https://example.test/mise', sha256: checksum,
      }],
      fetchArtifact: async () => binary,
      probe: async () => ({ os: 'linux', arch: 'x64', libc: 'glibc', namespace: 'linux-x64-glibc' }),
    });
    const result = await provisioner.provision({
      compositionId: 'agent-recipe', ownerHomeHost: owner, ownerHomeContainer: '/home/ada',
      projectOverlayHost: overlay,
      items: [
        { id: 'agent-foundation-node', tool: 'node', version: '22.14.0' },
        { id: 'php', tool: 'php', version: '8.4.22' },
        { id: 'agent-codex', tool: 'agent-codex', version: '0.146.0' },
      ],
    });

    assert.deepStrictEqual(result.items.map(({ id, status }) => ({ id, status })), [
      { id: 'agent-foundation-node', status: 'installed' },
      { id: 'php', status: 'installed' },
      { id: 'agent-codex', status: 'installed' },
    ]);
    assert.deepStrictEqual(
      calls.filter((call) => call.args.includes('install')).map((call) => call.args.at(-1)),
      ['node@22.14.0', 'php@8.4.22', 'npm:@openai/codex@0.146.0'],
    );
    assert.match(
      fs.readFileSync(path.join(overlay, 'mise.toml'), 'utf8'),
      /node = "22\.14\.0"[\s\S]*php = "8\.4\.22"[\s\S]*"npm:@openai\/codex" = "0\.146\.0"/,
    );
    assert.match(fs.readFileSync(path.join(owner, '.local', 'bin', 'mise'), 'utf8'),
      /exec "\$code_agents_binary" exec -- "\$code_agents_invoked_as"/);
    const codexShim = path.join(owner, '.local', 'share', 'code-agents', 'mise', 'shims', 'codex');
    assert.strictEqual(fs.lstatSync(codexShim).isFile(), true,
      'the selected agent gets a stable executable entrypoint, not a platform-pinned symlink');
    assert.strictEqual(fs.statSync(codexShim).mode & 0o777, 0o700);
    assert.match(fs.readFileSync(codexShim, 'utf8'),
      /exec "\$code_agents_binary" exec -- "\$code_agents_invoked_as"/);
    const phpShim = path.join(owner, '.local', 'share', 'code-agents', 'mise', 'shims', 'php');
    assert.strictEqual(fs.statSync(phpShim).mode & 0o777, 0o700);
    assert.match(fs.readFileSync(phpShim, 'utf8'),
      /exec "\$code_agents_binary" exec -- "\$code_agents_invoked_as"/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('serializes the same owner/tool/version across provisioner instances', async function () {
    const { root, owner, overlay } = fixture();
    const secondOverlay = path.join(root, 'overlay-second');
    fs.mkdirSync(secondOverlay, { mode: 0o700 });
    const binary = Buffer.from('shared mise fixture');
    const artifact = {
      version: 'fixture', platform: { os: 'linux', arch: 'x64', libc: 'glibc' },
      url: 'https://example.test/shared-mise',
      sha256: crypto.createHash('sha256').update(binary).digest('hex'),
    };
    const firstInstallEntered = deferred();
    const releaseFirstInstall = deferred();
    const secondInitialRead = deferred();
    let secondProbeEntered = false;
    const events = [];
    const firstState = new MemoryInstallationState();
    const secondState = new MemoryInstallationState();
    const originalSecondList = secondState.list.bind(secondState);
    let secondLists = 0;
    secondState.list = (compositionId) => {
      secondLists += 1;
      if (secondLists === 1) secondInitialRead.resolve();
      return originalSecondList(compositionId);
    };
    const common = {
      artifacts: [artifact],
      fetchArtifact: async () => binary,
    };
    const first = new ProjectProvisioner({
      ...common,
      state: firstState,
      probe: async () => ({ os: 'linux', arch: 'x64', libc: 'glibc', namespace: 'linux-x64-glibc' }),
      runner: { run: async (_command, args) => {
        if (args.includes('install')) {
          events.push('first-enter');
          firstInstallEntered.resolve();
          await releaseFirstInstall.promise;
          events.push('first-leave');
        }
        return { stdout: '', stderr: '' };
      } },
    });
    const second = new ProjectProvisioner({
      ...common,
      state: secondState,
      probe: async () => {
        secondProbeEntered = true;
        events.push('second-probe');
        return { os: 'linux', arch: 'x64', libc: 'glibc', namespace: 'linux-x64-glibc' };
      },
      runner: { run: async (_command, args) => {
        if (args.includes('install')) events.push('second-enter');
        return { stdout: '', stderr: '' };
      } },
    });
    const firstRun = first.provision({
      compositionId: 'same-version-first', ownerHomeHost: owner, ownerHomeContainer: '/home/ada',
      projectOverlayHost: overlay, items: [{ id: 'node', tool: 'node', version: '22.18.0' }],
    });
    await firstInstallEntered.promise;
    const secondRun = second.provision({
      compositionId: 'same-version-second', ownerHomeHost: owner, ownerHomeContainer: '/home/ada',
      projectOverlayHost: secondOverlay, items: [{ id: 'node', tool: 'node', version: '22.18.0' }],
    });
    await secondInitialRead.promise;
    await nextTurn();
    await nextTurn();
    assert.strictEqual(secondProbeEntered, false, 'second instance crossed the shared install lock');
    releaseFirstInstall.resolve();
    await Promise.all([firstRun, secondRun]);
    assert.deepStrictEqual(events, ['first-enter', 'first-leave', 'second-probe', 'second-enter']);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('holds cleanup behind an in-flight install and exposes an in-lock reference recheck', async function () {
    const { root, owner, overlay } = fixture();
    const state = new MemoryInstallationState();
    const binary = Buffer.from('cleanup coordination fixture');
    const installEntered = deferred();
    const releaseInstall = deferred();
    const provisioner = new ProjectProvisioner({
      state,
      artifacts: [{
        version: 'fixture', platform: { os: 'linux', arch: 'x64', libc: 'glibc' },
        url: 'https://example.test/cleanup-mise',
        sha256: crypto.createHash('sha256').update(binary).digest('hex'),
      }],
      fetchArtifact: async () => binary,
      probe: async () => ({ os: 'linux', arch: 'x64', libc: 'glibc', namespace: 'linux-x64-glibc' }),
      runner: { run: async (_command, args) => {
        if (args.includes('install')) {
          installEntered.resolve();
          await releaseInstall.promise;
        }
        return { stdout: '', stderr: '' };
      } },
    });
    const installing = provisioner.provision({
      compositionId: 'cleanup-coordination', ownerHomeHost: owner, ownerHomeContainer: '/home/ada',
      projectOverlayHost: overlay, items: [{ id: 'node', tool: 'node', version: '22.18.0' }],
    });
    await installEntered.promise;

    let cleanupEntered = false;
    let removed = false;
    const cleanup = withOwnerToolVersionLock({
      ownerHomeHost: owner, tool: 'node', version: '22.18.0',
    }, async () => {
      cleanupEntered = true;
      const referenced = state.list('cleanup-coordination')
        .some((record) => record.id === 'node' && record.status === 'installed');
      if (referenced) return 'kept';
      removed = true;
      return 'removed';
    });
    await nextTurn();
    await nextTurn();
    assert.strictEqual(cleanupEntered, false);
    releaseInstall.resolve();
    const [, cleanupResult] = await Promise.all([installing, cleanup]);
    assert.strictEqual(cleanupResult, 'kept');
    assert.strictEqual(removed, false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('allows distinct versions in one owner home to install concurrently', async function () {
    const { root, owner, overlay } = fixture();
    const secondOverlay = path.join(root, 'overlay-distinct');
    fs.mkdirSync(secondOverlay, { mode: 0o700 });
    const binary = Buffer.from('concurrent mise fixture');
    const artifact = {
      version: 'fixture', platform: { os: 'linux', arch: 'x64', libc: 'glibc' },
      url: 'https://example.test/concurrent-mise',
      sha256: crypto.createHash('sha256').update(binary).digest('hex'),
    };
    const bothInstallsEntered = deferred();
    const releaseInstalls = deferred();
    const firstReshimEntered = deferred();
    const releaseFirstReshim = deferred();
    const entered = [];
    const installShimDirectories = new Map();
    const reshimEntries = [];
    let activeReshims = 0;
    let maxActiveReshims = 0;
    const makeProvisioner = (label, state) => new ProjectProvisioner({
      state,
      artifacts: [artifact],
      fetchArtifact: async () => binary,
      probe: async () => ({ os: 'linux', arch: 'x64', libc: 'glibc', namespace: 'linux-x64-glibc' }),
      runner: { run: async (_command, args, options = {}) => {
        if (args.includes('install')) {
          entered.push(label);
          installShimDirectories.set(label, options.env.MISE_SHIMS_DIR);
          if (entered.length === 2) bothInstallsEntered.resolve();
          await releaseInstalls.promise;
        }
        if (args.at(-1) === 'reshim') {
          reshimEntries.push({ label, shims: options.env.MISE_SHIMS_DIR });
          activeReshims += 1;
          maxActiveReshims = Math.max(maxActiveReshims, activeReshims);
          if (reshimEntries.length === 1) {
            firstReshimEntered.resolve();
            await releaseFirstReshim.promise;
          }
          activeReshims -= 1;
        }
        return { stdout: '', stderr: '' };
      } },
    });
    const first = makeProvisioner('22', new MemoryInstallationState()).provision({
      compositionId: 'distinct-22', ownerHomeHost: owner, ownerHomeContainer: '/home/ada',
      projectOverlayHost: overlay, items: [{ id: 'node', tool: 'node', version: '22.18.0' }],
    });
    const second = makeProvisioner('23', new MemoryInstallationState()).provision({
      compositionId: 'distinct-23', ownerHomeHost: owner, ownerHomeContainer: '/home/ada',
      projectOverlayHost: secondOverlay, items: [{ id: 'node', tool: 'node', version: '23.1.0' }],
    });
    let installWatchdog;
    let reshimWatchdog;
    try {
      await Promise.race([
        bothInstallsEntered.promise,
        new Promise((_, reject) => {
          installWatchdog = setTimeout(() => reject(new Error('distinct versions were serialized')), 1_000);
        }),
      ]);
      assert.deepStrictEqual(new Set(entered), new Set(['22', '23']));
      assert.strictEqual(installShimDirectories.size, 2);
      assert.notStrictEqual(installShimDirectories.get('22'), installShimDirectories.get('23'));
      for (const directory of installShimDirectories.values()) {
        assert.match(directory, /^\/opt\/code-agents-project\/\.mise-install-shims\/[0-9a-f-]{36}$/);
        assert.notStrictEqual(directory, '/home/ada/.local/share/code-agents/mise/shims');
      }
      releaseInstalls.resolve();

      await Promise.race([
        firstReshimEntered.promise,
        new Promise((_, reject) => {
          reshimWatchdog = setTimeout(() => reject(new Error('shared reshim did not start')), 1_000);
        }),
      ]);
      await nextTurn();
      await nextTurn();
      assert.strictEqual(reshimEntries.length, 1, 'a second writer entered the shared shims directory');
      assert.strictEqual(maxActiveReshims, 1);
      releaseFirstReshim.resolve();
      const results = await Promise.all([first, second]);
      assert.ok(results.every((result) => result.items[0].status === 'installed'));
      assert.deepStrictEqual(new Set(reshimEntries.map((entry) => entry.label)), new Set(['22', '23']));
      assert.ok(reshimEntries.every((entry) => (
        entry.shims === '/home/ada/.local/share/code-agents/mise/shims'
      )));
      assert.strictEqual(maxActiveReshims, 1);
    } finally {
      if (installWatchdog) clearTimeout(installWatchdog);
      if (reshimWatchdog) clearTimeout(reshimWatchdog);
      releaseInstalls.resolve();
      releaseFirstReshim.resolve();
      await Promise.allSettled([first, second]);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps publication anchored when an owner swaps a checked path for a symlink', async function () {
    const { root, owner, overlay } = fixture();
    const outside = path.join(root, 'outside');
    const outsideBin = path.join(
      outside, 'share', 'code-agents', 'platforms', 'linux-x64-glibc', 'bin',
    );
    fs.mkdirSync(outsideBin, { recursive: true, mode: 0o700 });
    const binary = Buffer.from('anchored mise fixture');
    const checksum = crypto.createHash('sha256').update(binary).digest('hex');
    const fetchEntered = deferred();
    const releaseFetch = deferred();
    const provisioner = new ProjectProvisioner({
      state: new MemoryInstallationState(),
      runner: { run: async () => ({ stdout: '', stderr: '' }) },
      artifacts: [{
        version: 'fixture', platform: { os: 'linux', arch: 'x64', libc: 'glibc' },
        url: 'https://example.test/anchored-mise', sha256: checksum,
      }],
      fetchArtifact: async () => {
        fetchEntered.resolve();
        await releaseFetch.promise;
        return binary;
      },
      probe: async () => ({ os: 'linux', arch: 'x64', libc: 'glibc', namespace: 'linux-x64-glibc' }),
    });
    const running = provisioner.provision({
      compositionId: 'symlink-race', ownerHomeHost: owner, ownerHomeContainer: '/home/ada',
      projectOverlayHost: overlay, items: [{ id: 'node', tool: 'node', version: '22' }],
    });
    await fetchEntered.promise;

    const originalLocal = path.join(owner, '.local');
    const heldLocal = path.join(owner, '.local-held');
    fs.renameSync(originalLocal, heldLocal);
    fs.symlinkSync(outside, originalLocal, 'dir');
    releaseFetch.resolve();
    const result = await running;

    assert.strictEqual(result.items[0].status, 'failed');
    assert.strictEqual(fs.existsSync(path.join(outsideBin, 'mise')), false,
      'server publication escaped through the replacement symlink');
    assert.strictEqual(fs.readFileSync(path.join(
      heldLocal, 'share', 'code-agents', 'platforms', 'linux-x64-glibc', 'bin', 'mise',
    ), 'utf8'), 'anchored mise fixture');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('dispatches stable mise across x64/arm64 and glibc/musl shared-home targets', async function () {
    const { root, owner, overlay } = fixture();
    const state = new MemoryInstallationState();
    const variants = [
      { arch: 'x64', libc: 'glibc', uname: 'x86_64' },
      { arch: 'x64', libc: 'musl', uname: 'amd64' },
      { arch: 'arm64', libc: 'glibc', uname: 'aarch64' },
      { arch: 'arm64', libc: 'musl', uname: 'arm64' },
    ].map((platform) => {
      const key = `${platform.arch}-${platform.libc}`;
      const bytes = Buffer.from(
        `#!/bin/sh\nprintf '%s\\n' '${key}'\nif test "$#" -gt 0; then printf '<%s>\\n' "$@"; fi\n`,
      );
      return {
        ...platform,
        key,
        bytes,
        artifact: {
          version: 'fixture',
          platform: { os: 'linux', arch: platform.arch, libc: platform.libc },
          url: `https://example.test/mise-${key}`,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        },
      };
    });
    let selected = variants[0];
    const runnerCalls = [];
    const provisioner = new ProjectProvisioner({
      runner: { run: async (command, args) => {
        runnerCalls.push({ command, args: [...args] });
        return { stdout: '', stderr: '' };
      } },
      state,
      artifacts: variants.map((variant) => variant.artifact),
      fetchArtifact: async (artifact) => variants.find((variant) => variant.artifact.url === artifact.url).bytes,
      probe: async () => ({
        os: 'linux', arch: selected.arch, libc: selected.libc,
        namespace: `linux-${selected.arch}-${selected.libc}`,
      }),
    });
    for (const variant of variants) {
      selected = variant;
      await provisioner.provision({
        compositionId: `mise-${variant.key}`,
        ownerHomeHost: owner,
        ownerHomeContainer: '/home/ada',
        projectOverlayHost: overlay,
        items: [{ id: 'node', tool: 'node', version: '22' }],
      });
    }

    const fakeBin = path.join(root, 'fake-bin');
    fs.mkdirSync(fakeBin, { mode: 0o700 });
    fs.writeFileSync(path.join(fakeBin, 'uname'), '#!/bin/sh\nprintf "%s\\n" "$TEST_UNAME"\n', { mode: 0o700 });
    fs.writeFileSync(path.join(fakeBin, 'ldd'), '#!/bin/sh\nprintf "%s\\n" "$TEST_LIBC"\n', { mode: 0o700 });
    const stable = path.join(owner, '.local', 'bin', 'mise');
    fs.writeFileSync(stable, '#!/bin/sh\nexit 99\n');
    selected = variants[0];
    const refreshed = await provisioner.provision({
      compositionId: `mise-${selected.key}`,
      ownerHomeHost: owner,
      ownerHomeContainer: '/home/ada',
      projectOverlayHost: overlay,
      items: [{ id: 'node', tool: 'node', version: '22' }],
    });
    assert.strictEqual(refreshed.platform, null);
    assert.match(fs.readFileSync(stable, 'utf8'), /code_agents_invoked_as=\$\{0##\*\/\}/);
    assert.match(fs.readFileSync(path.join(
      owner, '.local', 'share', 'code-agents', 'mise', 'shims', 'node',
    ), 'utf8'), /code_agents_invoked_as=\$\{0##\*\/\}/);
    for (const variant of variants) {
      const output = execFileSync(stable, [], {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: owner,
          PATH: fakeBin,
          TEST_UNAME: variant.uname,
          TEST_LIBC: variant.libc,
        },
      });
      assert.strictEqual(output.trim(), variant.key);
    }
    const dispatchEnv = {
      ...process.env,
      HOME: owner,
      PATH: fakeBin,
      TEST_UNAME: 'x86_64',
      TEST_LIBC: 'glibc',
    };
    assert.strictEqual(
      execFileSync(stable, ['--version'], { encoding: 'utf8', env: dispatchEnv }).trim(),
      'x64-glibc\n<--version>',
      'direct mise calls must keep their original arguments',
    );
    const ghShim = path.join(root, 'gh');
    fs.symlinkSync(stable, ghShim);
    assert.strictEqual(
      execFileSync(ghShim, ['auth', 'login'], { encoding: 'utf8', env: dispatchEnv }).trim(),
      'x64-glibc\n<exec>\n<-->\n<gh>\n<auth>\n<login>',
      'mise shims must dispatch the invoked tool instead of treating arguments as mise tasks',
    );
    const installCommands = runnerCalls.filter((call) => call.args.includes('install')).map((call) => call.command);
    for (const variant of variants) {
      assert.ok(installCommands.some((command) => command.includes(
        `/platforms/linux-${variant.arch}-${variant.libc}/bin/mise`,
      )));
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('fails every item safely before execution when the pinned checksum differs', async function () {
    const { root, owner, overlay } = fixture();
    const state = new MemoryInstallationState();
    let executions = 0;
    const provisioner = new ProjectProvisioner({
      runner: { run: async () => { executions += 1; return { stdout: '', stderr: '' }; } },
      state,
      artifacts: [{ version: 'test', platform: { os: 'linux', arch: 'x64', libc: 'glibc' }, url: 'https://example.test/mise', sha256: '0'.repeat(64) }],
      fetchArtifact: async () => Buffer.from('wrong'),
      probe: async () => ({ os: 'linux', arch: 'x64', libc: 'glibc', namespace: 'linux-x64-glibc' }),
    });
    const result = await provisioner.provision({
      compositionId: 'bad-pin', ownerHomeHost: owner, ownerHomeContainer: '/home/ada', projectOverlayHost: overlay,
      items: [{ id: 'node', tool: 'node', version: '22' }],
    });
    assert.strictEqual(executions, 0);
    assert.strictEqual(result.items[0].status, 'failed');
    assert.strictEqual(result.items[0].errorCode, 'MISE_CHECKSUM_MISMATCH');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('installs checksum-verified tea for both architectures and dispatches with tmpfs config', async function () {
    const { root, owner, overlay } = fixture();
    const state = new MemoryInstallationState();
    const variants = [
      { arch: 'x64', uname: 'x86_64' },
      { arch: 'arm64', uname: 'aarch64' },
    ].map((platform) => {
      const bytes = Buffer.from(`#!/bin/sh\nprintf '%s:%s\\n' '${platform.arch}' "$XDG_CONFIG_HOME"\n`);
      return {
        ...platform,
        bytes,
        artifact: {
          version: '0.15.1',
          platform: { os: 'linux', arch: platform.arch },
          url: `https://example.test/tea-${platform.arch}`,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        },
      };
    });
    let selected = variants[0];
    let fetches = 0;
    let executions = 0;
    const provisioner = new ProjectProvisioner({
      runner: { run: async () => { executions += 1; return { stdout: '', stderr: '' }; } },
      state,
      teaArtifacts: variants.map((variant) => variant.artifact),
      fetchTeaArtifact: async (artifact) => {
        fetches += 1;
        return variants.find((variant) => variant.artifact.url === artifact.url).bytes;
      },
      probe: async () => ({
        os: 'linux', arch: selected.arch, libc: 'glibc', namespace: `linux-${selected.arch}-glibc`,
      }),
    });
    for (const variant of variants) {
      selected = variant;
      const result = await provisioner.provision({
        compositionId: `tea-${variant.arch}`,
        ownerHomeHost: owner,
        ownerHomeContainer: '/home/ada',
        projectOverlayHost: overlay,
        items: [{ id: 'tea', tool: 'tea', version: '0.15.1' }],
      });
      assert.strictEqual(result.misePath, null);
      assert.strictEqual(result.items[0].status, 'installed');
      const binary = path.join(
        owner, '.local', 'share', 'code-agents', 'tools', 'tea', '0.15.1', `linux-${variant.arch}`, 'tea',
      );
      assert.strictEqual(fs.statSync(binary).mode & 0o777, 0o700);
      assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'), variant.artifact.sha256);
    }
    assert.strictEqual(fetches, 2);
    assert.strictEqual(executions, 0, 'direct tea installation must not execute target commands');
    assert.doesNotMatch(fs.readFileSync(path.join(overlay, 'mise.toml'), 'utf8'), /tea/);

    const fakeBin = path.join(root, 'fake-tea-bin');
    fs.mkdirSync(fakeBin, { mode: 0o700 });
    fs.writeFileSync(path.join(fakeBin, 'uname'), '#!/bin/sh\nprintf "%s\\n" "$TEST_UNAME"\n', { mode: 0o700 });
    const stable = path.join(owner, '.local', 'bin', 'tea');
    assert.strictEqual(fs.statSync(stable).mode & 0o777, 0o700);
    for (const variant of variants) {
      const output = execFileSync(stable, [], {
        encoding: 'utf8',
        env: { ...process.env, HOME: owner, PATH: fakeBin, TEST_UNAME: variant.uname },
      });
      assert.strictEqual(output.trim(), `${variant.arch}:/run/code-agents-forge/xdg`);
    }

    await assert.rejects(() => provisioner.provision({
      compositionId: 'tea-unpinned', ownerHomeHost: owner, ownerHomeContainer: '/home/ada', projectOverlayHost: overlay,
      items: [{ id: 'tea', tool: 'tea', version: '0.9.2' }],
    }), /unsupported tool or version/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('records a safe tea failure when direct artifact verification differs', async function () {
    const { root, owner, overlay } = fixture();
    const state = new MemoryInstallationState();
    const provisioner = new ProjectProvisioner({
      runner: { run: async () => ({ stdout: '', stderr: '' }) },
      state,
      teaArtifacts: [{
        version: '0.15.1', platform: { os: 'linux', arch: 'x64' },
        url: 'https://example.test/tea', sha256: '0'.repeat(64),
      }],
      fetchTeaArtifact: async () => Buffer.from('wrong'),
      probe: async () => ({ os: 'linux', arch: 'x64', libc: 'musl', namespace: 'linux-x64-musl' }),
    });
    const result = await provisioner.provision({
      compositionId: 'tea-bad-pin', ownerHomeHost: owner, ownerHomeContainer: '/home/ada', projectOverlayHost: overlay,
      items: [{ id: 'tea', tool: 'tea', version: '0.15.1' }],
    });
    assert.strictEqual(result.items[0].status, 'failed');
    assert.strictEqual(result.items[0].errorCode, 'TEA_CHECKSUM_MISMATCH');
    assert.strictEqual(result.items[0].errorMessage, 'Pinned tea checksum did not match');
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('fixed forge credential materialisation', function () {
  it('maps only the fixed forge catalog and requires a choice for unknown hosts', function () {
    assert.strictEqual(forgeForHost('github.com').cli, 'gh');
    assert.strictEqual(forgeForHost('gitlab.com').cli, 'glab');
    assert.strictEqual(forgeForHost('code.example.test'), null);
    assert.deepStrictEqual(forgeForHost('code.example.test', 'forgejo'), {
      kind: 'forgejo', cli: 'tea', version: '0.15.1', installer: 'direct',
    });
    assert.strictEqual(FORGE_CATALOG.github.version, '2.97.0');
    assert.strictEqual(FORGE_CATALOG.gitlab.version, '1.111.0');
    assert.strictEqual(FORGE_CATALOG.gitea.version, '0.15.1');
    assert.deepStrictEqual(Object.keys(FORGE_CATALOG), ['github', 'gitlab', 'gitea', 'forgejo']);
  });

  it('puts auth only on stdin and keeps metadata/env confined to tmpfs paths', async function () {
    const secret = 'owner-secret-123';
    const calls = [];
    const materializer = new ForgeCredentialMaterializer({ run: async (command, args, options = {}) => {
      calls.push({ command, args: [...args], options });
      return { stdout: '', stderr: '' };
    } });
    await materializer.materialize({ host: 'github.com', kind: 'github', token: secret });
    await materializer.materialize({ host: 'gitlab.com', kind: 'gitlab', token: secret });
    const tea = await materializer.materialize({ host: 'forge.example.test', kind: 'forgejo', token: secret });
    assert.deepStrictEqual(tea, {
      cli: 'tea', host: 'forge.example.test', configRoot: '/run/code-agents-forge/xdg/tea',
    });
    assert.ok(calls.some((call) => call.command === 'gh' && call.options.input === `${secret}\n`));
    assert.ok(calls.some((call) => call.command === 'glab' && call.options.input === `${secret}\n`));
    const teaConfig = calls.find((call) => call.command === 'install'
      && call.args.at(-1) === '/run/code-agents-forge/xdg/tea/config.yml');
    assert.ok(teaConfig);
    assert.deepStrictEqual(JSON.parse(teaConfig.options.input), {
      logins: [{
        name: 'forge.example.test', url: 'https://forge.example.test', token: secret, default: true,
      }],
    });
    for (const call of calls) {
      assert.strictEqual(JSON.stringify({ command: call.command, args: call.args, env: call.options.env }).includes(secret), false);
      assert.ok(!call.options.env || Object.values(call.options.env).every((value) => value.startsWith('/run/code-agents-forge')));
    }
    assert.ok(Object.values(forgeEnvironment()).every((value) => value.startsWith('/run/code-agents-forge')));
  });
});
