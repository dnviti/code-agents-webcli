const assert = require('assert');
const { execFile, execFileSync } = require('child_process');
const { randomBytes } = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const {
  RepositoryInspector,
  RepositoryInspectionError,
  GitStorageLimitError,
  defaultGitRunner,
} = require('../dist/server/services/composition/repository-inspector.js');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-inspector-fixture-'));
  const source = path.join(root, 'source');
  const tempRoot = path.join(root, 'inspection-tmp');
  const executionMarker = path.join(root, 'REPOSITORY_CODE_EXECUTED');
  const hostileHome = path.join(root, 'hostile-home');
  fs.mkdirSync(source);
  fs.mkdirSync(tempRoot);
  fs.mkdirSync(hostileHome);
  git(source, 'init', '-b', 'main');
  git(source, 'config', 'user.name', 'Fixture');
  git(source, 'config', 'user.email', 'fixture@example.test');

  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({
    engines: { node: '20.11.1' },
    scripts: {
      prepare: `printf repository-code > ${JSON.stringify(executionMarker)}`,
      postinstall: `printf repository-code > ${JSON.stringify(executionMarker)}`,
    },
  }));
  fs.writeFileSync(path.join(source, '.python-version'), '3.12.4\n');
  fs.writeFileSync(path.join(source, 'pyproject.toml'), [
    '[project]',
    'requires-python = ">=3.11"', // a range is visible only through the catalog default/.python-version
  ].join('\n'));
  fs.writeFileSync(path.join(source, '.php-version'), '8.4.22\n');
  fs.writeFileSync(path.join(source, 'composer.json'), JSON.stringify({
    require: { php: '^8.3' }, // a range is visible only through the catalog default/.php-version
    scripts: { postInstall: `printf repository-code > ${JSON.stringify(executionMarker)}` },
  }));
  fs.writeFileSync(path.join(source, 'setup.py'), [
    'from pathlib import Path',
    `Path(${JSON.stringify(executionMarker)}).write_text("setup executed")`,
  ].join('\n'));
  fs.writeFileSync(path.join(source, '.gitattributes'), 'payload filter=hostile\n');
  fs.writeFileSync(path.join(source, 'payload'), 'filter me\n');
  fs.writeFileSync(path.join(source, '.gitmodules'), [
    '[submodule "hostile"]',
    '\tpath = vendor/hostile',
    '\turl = ext::sh -c touch% malicious',
  ].join('\n'));
  fs.mkdirSync(path.join(source, 'hooks'));
  fs.writeFileSync(path.join(source, 'hooks', 'post-checkout'), `#!/bin/sh\ntouch ${executionMarker}\n`, { mode: 0o755 });

  // This is the user's ambient config, outside the inspector's injected empty
  // HOME. If inherited, merely smudging payload would create the marker.
  fs.writeFileSync(path.join(hostileHome, '.gitconfig'), [
    '[filter "hostile"]',
    `\tsmudge = sh -c 'touch ${executionMarker}; cat'`,
    '\trequired = true',
    '[protocol "ext"]',
    '\tallow = always',
  ].join('\n'));

  git(source, 'add', '.');
  git(source, 'commit', '-m', 'malicious static fixture');
  const oid = git(source, 'rev-parse', 'HEAD');
  return { root, source, tempRoot, executionMarker, hostileHome, oid };
}

function localFixtureRunner(remoteUrl, source, requests) {
  return async (request) => {
    requests.push(request);
    // Preserve the production request for assertions, but adapt the HTTPS URL
    // to a local Git transport so this test makes no network call.
    const args = request.args.map((arg) => {
      if (arg === remoteUrl) return source;
      if (arg === 'protocol.file.allow=never') return 'protocol.file.allow=always';
      return arg;
    });
    const env = { ...request.env, GIT_ALLOW_PROTOCOL: 'file' };
    const result = await execFileAsync('git', args, {
      cwd: request.cwd,
      env,
      encoding: 'buffer',
      timeout: request.timeoutMs,
      maxBuffer: Math.max(request.maxStdoutBytes, request.maxStderrBytes),
      signal: request.signal,
    });
    return {
      stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout),
      stderr: Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr),
    };
  };
}

describe('static composition repository inspector', function () {
  it('disables the POSIX-bounded repository surface explicitly on Windows', async function () {
    const inspector = new RepositoryInspector({ platform: 'win32' });
    await assert.rejects(
      inspector.inspect({ repoUrl: 'https://example.test/owner/repository' }),
      (error) => error instanceof RepositoryInspectionError
        && error.code === 'unsupported_platform'
        && /unavailable on Windows/.test(error.message),
    );
  });

  this.timeout(15_000);

  it('detects Node, Python and PHP at one exact OID without executing repository-controlled behavior', async function () {
    const f = fixture();
    const remoteUrl = 'https://github.com/example/malicious.git';
    const credential = 'fixture-private-token';
    const requests = [];
    const previousHome = process.env.HOME;
    process.env.HOME = f.hostileHome;
    try {
      const inspector = new RepositoryInspector({
        runner: localFixtureRunner(remoteUrl, f.source, requests),
        fetch: async (_url, init) => {
          assert.strictEqual(init.redirect, 'error');
          assert.deepStrictEqual(init.headers, {
            Accept: 'application/x-git-upload-pack-advertisement',
            Authorization: `Bearer ${credential}`,
          });
          return { status: 200, body: { cancel: async () => {} } };
        },
        tempRoot: f.tempRoot,
      });
      const result = await inspector.inspect({ repoUrl: remoteUrl, credential });

      assert.strictEqual(result.sourceOid, f.oid);
      assert.strictEqual(result.sourceRef, 'refs/heads/main');
      assert.deepStrictEqual(result.forgeHint, { kind: 'github', host: 'github.com' });
      assert.deepStrictEqual(
        result.detectedRuntimes.map((runtime) => runtime.runtimeId),
        ['node', 'python', 'php'],
      );
      const node = result.detectedRuntimes[0];
      const python = result.detectedRuntimes[1];
      const php = result.detectedRuntimes[2];
      assert.strictEqual(node.selectedVersion, '20.11.1');
      assert.strictEqual(node.versionSource, 'marker');
      assert.deepStrictEqual(node.versionHints, [{ path: 'package.json', version: '20.11.1' }]);
      assert.strictEqual(python.selectedVersion, '3.12.4');
      assert.deepStrictEqual(python.versionHints, [{ path: '.python-version', version: '3.12.4' }]);
      assert.ok(python.sources.includes('setup.py'), 'an inert Python marker remains visible');
      assert.strictEqual(php.selectedVersion, '8.4.22');
      assert.deepStrictEqual(php.versionHints, [{ path: '.php-version', version: '8.4.22' }]);
      assert.ok(php.sources.includes('composer.json'), 'Composer metadata remains an inert PHP marker');
      assert.ok(!fs.existsSync(f.executionMarker), 'no hook, filter, package script, or setup.py ran');
      assert.deepStrictEqual(fs.readdirSync(f.tempRoot), [], 'the isolated bare repository was cleaned up');

      const flattened = requests.map((request) => request.args.join(' '));
      assert.ok(flattened.every((command) => !command.includes(credential)), 'the token is absent from every argv');
      assert.ok(flattened.some((command) => command.includes(`fetch`) && command.includes(f.oid)));
      assert.ok(flattened.some((command) => command.includes(`ls-tree -r -z --full-tree ${f.oid}`)));
      assert.ok(flattened.some((command) => /cat-file blob [0-9a-f]{40}$/.test(command)));
      for (const command of flattened) {
        assert.doesNotMatch(command, /(?:^| )(?:checkout|clone|submodule|archive)(?: |$)/);
        assert.doesNotMatch(command, /(?:^| )config(?: |$)/, 'repository or ambient config is never queried');
        assert.doesNotMatch(command, /cat-file blob [^ ]*:/, 'blob reads never use a path/revision expression');
      }
      const first = requests[0];
      assert.strictEqual(first.env.HOME.startsWith(f.tempRoot), true);
      assert.strictEqual(first.env.GIT_CONFIG_NOSYSTEM, '1');
      assert.strictEqual(first.env.GIT_ALLOW_PROTOCOL, 'https');
      assert.ok(requests.every((request) => request.args.includes('core.hooksPath=/dev/null')));
      assert.ok(requests.every((request) => request.args.includes('fetch.unpackLimit=1')));
      assert.ok(requests.every((request) => request.args.includes('protocol.file.allow=never')));
      assert.ok(requests.every((request) => request.args.includes('protocol.ext.allow=never')));
      assert.ok(requests.every((request) => request.maxFileBytes === 64 * 1024 * 1024));
      assert.ok(requests.every((request) => request.storageRoot === request.cwd));
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('keeps a credential out of argv and sanitizes reflected runner failures', async function () {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-inspector-secret-'));
    const secret = 'secret-token-value';
    const requests = [];
    let fetchHeaders;
    try {
      const inspector = new RepositoryInspector({
        tempRoot,
        fetch: async (_url, init) => {
          fetchHeaders = init.headers;
          return { status: 200, body: { cancel: async () => {} } };
        },
        runner: async (request) => {
          requests.push(request);
          throw new Error(`host reflected ${secret}`);
        },
      });
      await assert.rejects(
        inspector.inspect({ repoUrl: 'https://gitlab.com/example/private.git', credential: secret }),
        (error) => {
          assert.ok(error instanceof RepositoryInspectionError);
          assert.strictEqual(error.code, 'repository_unavailable');
          assert.ok(!error.message.includes(secret));
          return true;
        },
      );
      assert.strictEqual(fetchHeaders.Authorization, `Bearer ${secret}`);
      assert.ok(requests.length > 0);
      assert.ok(requests.every((request) => !request.args.join('\0').includes(secret)));
      assert.deepStrictEqual(fs.readdirSync(tempRoot), []);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects non-HTTPS and credential-bearing repository URLs before any I/O', async function () {
    let calls = 0;
    const inspector = new RepositoryInspector({
      fetch: async () => { calls += 1; return { status: 200 }; },
      runner: async () => { calls += 1; return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; },
    });
    for (const repoUrl of [
      'http://example.test/repo.git',
      'file:///tmp/repo.git',
      'https://user:secret@example.test/repo.git',
      'https://example.test/repo.git?x=1',
    ]) {
      await assert.rejects(inspector.inspect({ repoUrl }), (error) => error.code === 'invalid_url');
    }
    assert.strictEqual(calls, 0);
  });

  it('fails closed when an allowlisted marker exceeds a configured blob bound', async function () {
    const f = fixture();
    const remoteUrl = 'https://example.test/large-marker.git';
    try {
      const inspector = new RepositoryInspector({
        runner: localFixtureRunner(remoteUrl, f.source, []),
        fetch: async () => ({ status: 200, body: { cancel: async () => {} } }),
        tempRoot: f.tempRoot,
        limits: { maxBlobBytes: 8 },
      });
      await assert.rejects(
        inspector.inspect({ repoUrl: remoteUrl }),
        (error) => error instanceof RepositoryInspectionError && error.code === 'limit_exceeded',
      );
      assert.deepStrictEqual(fs.readdirSync(f.tempRoot), []);
      assert.ok(!fs.existsSync(f.executionMarker));
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('caps the real Git fetch pack at the inherited POSIX file-size boundary', async function () {
    if (process.platform === 'win32') this.skip();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-inspector-pack-cap-'));
    const source = path.join(root, 'source');
    const destination = path.join(root, 'destination.git');
    const emptyTemplate = path.join(root, 'empty-template');
    const home = path.join(root, 'home');
    const maxFileBytes = 64 * 1024;
    try {
      fs.mkdirSync(source);
      fs.mkdirSync(emptyTemplate);
      fs.mkdirSync(home);
      git(source, 'init', '-b', 'main');
      git(source, 'config', 'user.name', 'Fixture');
      git(source, 'config', 'user.email', 'fixture@example.test');
      fs.writeFileSync(path.join(source, 'large.bin'), randomBytes(512 * 1024));
      git(source, 'add', 'large.bin');
      git(source, 'commit', '-m', 'large incompressible object');
      git(root, 'init', '--bare', `--template=${emptyTemplate}`, destination);

      await assert.rejects(defaultGitRunner({
        args: [
          '-c', 'fetch.unpackLimit=1',
          '--git-dir', destination,
          'fetch', '--no-tags', '--no-recurse-submodules', '--depth=1',
          `file://${source}`, 'HEAD',
        ],
        cwd: root,
        env: {
          PATH: '/usr/local/bin:/usr/bin:/bin',
          HOME: home,
          XDG_CONFIG_HOME: home,
          LC_ALL: 'C',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_SYSTEM: '/dev/null',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_ALLOW_PROTOCOL: 'file',
          GIT_TERMINAL_PROMPT: '0',
        },
        timeoutMs: 5_000,
        maxStdoutBytes: 64 * 1024,
        maxStderrBytes: 64 * 1024,
        maxFileBytes,
        storageRoot: destination,
      }), (error) => error instanceof GitStorageLimitError);

      const sizes = [];
      const pending = [destination];
      while (pending.length) {
        const candidate = pending.pop();
        for (const entry of fs.readdirSync(candidate, { withFileTypes: true })) {
          const child = path.join(candidate, entry.name);
          if (entry.isDirectory()) pending.push(child);
          else if (entry.isFile()) sizes.push(fs.statSync(child).size);
        }
      }
      assert.ok(sizes.length > 0);
      assert.ok(Math.max(...sizes) <= maxFileBytes, 'the pack never crosses the 512-byte-rounded hard ceiling');
      assert.ok(sizes.includes(maxFileBytes), 'the failed pack reached the enforced boundary');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects cumulative temp usage made of individually small files and still cleans up', async function () {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-inspector-total-cap-'));
    let runnerCalls = 0;
    try {
      const inspector = new RepositoryInspector({
        tempRoot,
        fetch: async () => ({ status: 200, body: { cancel: async () => {} } }),
        runner: async (request) => {
          runnerCalls += 1;
          const fragments = path.join(request.cwd, 'small-fragments');
          fs.mkdirSync(fragments);
          for (let index = 0; index < 24; index += 1) {
            fs.writeFileSync(path.join(fragments, String(index)), Buffer.alloc(1024, index));
          }
          return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        },
        limits: { maxRepositoryBytes: 64 * 1024 },
      });
      await assert.rejects(
        inspector.inspect({ repoUrl: 'https://example.test/many-small-objects.git' }),
        (error) => error instanceof RepositoryInspectionError && error.code === 'limit_exceeded',
      );
      assert.strictEqual(runnerCalls, 1);
      assert.deepStrictEqual(fs.readdirSync(tempRoot), []);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('uses visible pinned defaults for dynamic or ranged version expressions', async function () {
    const f = fixture();
    const remoteUrl = 'https://example.test/dynamic-versions.git';
    try {
      fs.writeFileSync(path.join(f.source, 'package.json'), JSON.stringify({ engines: { node: '>=20' } }));
      fs.writeFileSync(path.join(f.source, '.python-version'), '${PYTHON_VERSION}\n');
      git(f.source, 'add', 'package.json', '.python-version');
      git(f.source, 'commit', '-m', 'dynamic version expressions');
      const inspector = new RepositoryInspector({
        runner: localFixtureRunner(remoteUrl, f.source, []),
        fetch: async () => ({ status: 200, body: { cancel: async () => {} } }),
        tempRoot: f.tempRoot,
      });
      const result = await inspector.inspect({ repoUrl: remoteUrl });
      const node = result.detectedRuntimes.find((runtime) => runtime.runtimeId === 'node');
      const python = result.detectedRuntimes.find((runtime) => runtime.runtimeId === 'python');
      assert.deepStrictEqual(
        { version: node.selectedVersion, source: node.versionSource, hints: node.versionHints },
        { version: '22.14.0', source: 'catalog_default', hints: [] },
      );
      assert.deepStrictEqual(
        { version: python.selectedVersion, source: python.versionSource, hints: python.versionHints },
        { version: '3.13.2', source: 'catalog_default', hints: [] },
      );
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('enforces the access deadline even when an injected fetch ignores abort', async function () {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-inspector-timeout-'));
    try {
      const inspector = new RepositoryInspector({
        tempRoot,
        fetch: async () => new Promise(() => {}),
        runner: async () => { throw new Error('Git must not start'); },
        limits: { commandMs: 20, wallClockMs: 40 },
      });
      await assert.rejects(
        inspector.inspect({ repoUrl: 'https://example.test/never.git' }),
        (error) => error instanceof RepositoryInspectionError && error.code === 'timed_out',
      );
      assert.deepStrictEqual(fs.readdirSync(tempRoot), []);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
