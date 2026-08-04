const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CUSTOM_TITLE_BAR_HEIGHT,
  DEFAULT_WINDOW,
  desktopPermissionAllowed,
  desktopWindowChrome,
  desktopCookie,
  isSafeExternalUrl,
  loginShellPath,
  mergePath,
  normalizeWindowState,
  readWindowState,
  shutdownAfterStartupFailure,
  titleBarSymbolColor,
  writeWindowState,
} = require('../desktop/lib.js');

describe('Electron desktop helpers', function () {
  it('keeps the Electron renderer isolated and packaging targets complete', function () {
    const main = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');
    const builder = fs.readFileSync(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8');
    assert.match(main, /nodeIntegration:\s*false/);
    assert.match(main, /contextIsolation:\s*true/);
    assert.match(main, /sandbox:\s*true/);
    assert.match(main, /webSecurity:\s*true/);
    assert.match(main, /setWindowOpenHandler/);
    assert.match(main, /setPermissionRequestHandler/);
    assert.match(main, /will-redirect/);
    assert.match(
      main,
      /if \(app\.isPackaged && app\.commandLine\.hasSwitch\('no-sandbox'\)\) \{[\s\S]{0,160}throw new Error\([\s\S]{0,160}refuses to run without Chromium sandboxing/,
    );
    assert.match(main, /\.\.\.desktopWindowChrome\(\)/);
    assert.match(main, /Menu\.setApplicationMenu\(null\)/);
    assert.match(main, /\.removeMenu\(\)/);
    assert.match(main, /did-change-theme-color/);
    assert.match(main, /shutdownComplete = true;[\s\S]{0,240}app\.exit\(0\);\s*return;/);
    for (const target of ['AppImage', 'flatpak', 'nsis', 'dmg']) {
      assert.match(builder, new RegExp(`\\b${target}\\b`));
    }
    assert.match(builder, /--filesystem=home/);
    assert.match(builder, /asarUnpack:[\s\S]*@lydell/);
    assert.match(builder, /asarUnpack:[\s\S]*dist\/public\/\*\*\/\*/);
    assert.match(builder, /appImage:[\s\S]*executableArgs:\s*\[\]/);
    assert.match(builder, /src\/public\/icons\/icon-512\.png/);

    const release = fs.readFileSync(
      path.join(__dirname, '..', '.github', 'workflows', 'release-on-main.yml'),
      'utf8',
    );
    assert.match(release, /push:\s*\n\s*tags:\s*\n\s*- ['"]v\*\.\*\.\*['"]/);
    assert.match(release, /- ['"]!v\*\.\*\.\*-staging['"]/);
    assert.doesNotMatch(release, /push:\s*\n\s*branches:/);
    assert.match(release, /- os: ubuntu-24\.04/);
    assert.match(release, /EXPECTED_TAG="v\$\{VERSION\}"/);
    assert.match(release, /git merge-base --is-ancestor "\$TAG_TARGET" origin\/main/);
    assert.match(release, /Smoke the native packaged application/);
    assert.match(release, /apt-get install --yes[^\n]*libfuse2t64/);
    assert.match(release, /find release -maxdepth 1 -type f -name ['"]\*\.AppImage['"]/);
    assert.match(release, /if ! unshare -Ur true 2>\/dev\/null; then/);
    assert.match(release, /\/proc\/sys\/kernel\/apparmor_restrict_unprivileged_userns/);
    assert.match(release, /The runner cannot provide Chromium's user-namespace sandbox/);
    assert.match(
      release,
      /timeout --signal=TERM --kill-after=10s 120s[\s\\]*xvfb-run -a "\$appimage" --headless/,
    );
    assert.doesNotMatch(
      release,
      /xvfb-run[\s\S]{0,160}"\$appimage"[\s\\]*--no-sandbox/,
    );
    assert.match(release, /appimage_status=\$\?/);
    assert.match(release, /AppImage` — Linux x64[^\n]*unprivileged user namespaces/);
    assert.match(release, /sha256sum -c SHA256SUMS/);
    assert.match(release, /tag_name:\s*\$\{\{ needs\.verify\.outputs\.tag \}\}/);
    assert.match(release, /target_commitish:\s*\$\{\{ needs\.verify\.outputs\.commit_sha \}\}/);
    assert.match(release, /permissions:\s*\n\s*contents: write/);
  });

  it('grants clipboard access only to the embedded desktop origin', function () {
    const local = 'http://127.0.0.1:43210';
    for (const permission of [
      'notifications',
      'clipboard-read',
      'clipboard-sanitized-write',
    ]) {
      assert.strictEqual(desktopPermissionAllowed(permission, `${local}/terminal`, local), true);
      assert.strictEqual(desktopPermissionAllowed(permission, 'https://example.test', local), false);
    }
    assert.strictEqual(desktopPermissionAllowed('geolocation', local, local), false);
    assert.strictEqual(desktopPermissionAllowed('clipboard-read', 'not a URL', local), false);
  });

  it('uses native-side controls in the PWA title bar and removes the Windows menu bar', function () {
    const overlay = {
      color: '#0a0a0a',
      symbolColor: '#fafafa',
      height: CUSTOM_TITLE_BAR_HEIGHT,
    };
    assert.deepStrictEqual(desktopWindowChrome('win32'), {
      titleBarStyle: 'hidden',
      titleBarOverlay: overlay,
      autoHideMenuBar: true,
    });
    assert.deepStrictEqual(desktopWindowChrome('linux'), {
      titleBarStyle: 'hidden',
      titleBarOverlay: overlay,
      autoHideMenuBar: true,
    });
    const macChrome = desktopWindowChrome('darwin');
    assert.deepStrictEqual(macChrome, {
      titleBarStyle: 'hidden',
      titleBarOverlay: true,
    });
    assert.ok(
      !Object.hasOwn(macChrome, 'trafficLightPosition'),
      'macOS keeps its OS-managed traffic lights in the native upper-left position',
    );
    assert.strictEqual(titleBarSymbolColor('#ffffff'), '#0a0a0a');
    assert.strictEqual(titleBarSymbolColor('#0a0a0a'), '#fafafa');
    assert.strictEqual(titleBarSymbolColor('not-a-colour'), '#fafafa');
  });

  it('restores valid window geometry and drops positions on removed displays', function () {
    const displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }];
    assert.deepStrictEqual(
      normalizeWindowState({ x: 100, y: 70, width: 1100, height: 700, isMaximized: true }, displays),
      { x: 100, y: 70, width: 1100, height: 700, isMaximized: true },
    );
    assert.deepStrictEqual(
      normalizeWindowState({ x: 5000, y: 4000, width: 1100, height: 700 }, displays),
      { width: 1100, height: 700, isMaximized: false },
    );
    assert.deepStrictEqual(normalizeWindowState({ width: 2, height: NaN }), DEFAULT_WINDOW);
  });

  it('writes window state atomically and treats corrupt state as absent', function () {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-desktop-state-'));
    const filename = path.join(directory, 'nested', 'window.json');
    try {
      const state = { x: 20, y: 30, width: 900, height: 640, isMaximized: false };
      writeWindowState(filename, state);
      assert.deepStrictEqual(readWindowState(filename, []), state);
      fs.writeFileSync(filename, '{');
      assert.deepStrictEqual(readWindowState(filename, []), DEFAULT_WINDOW);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('opens only ordinary external web URLs outside the embedded origin', function () {
    const local = 'http://127.0.0.1:43210';
    assert.strictEqual(isSafeExternalUrl('https://github.com/dnviti/code-agents-webcli', local), true);
    assert.strictEqual(isSafeExternalUrl('http://example.test/docs', local), true);
    assert.strictEqual(isSafeExternalUrl(`${local}/api/config`, local), false);
    assert.strictEqual(isSafeExternalUrl('file:///etc/passwd', local), false);
    assert.strictEqual(isSafeExternalUrl('javascript:alert(1)', local), false);
    assert.strictEqual(isSafeExternalUrl('not a URL', local), false);
  });

  it('creates a host-only, HTTP-only strict desktop cookie', function () {
    assert.deepStrictEqual(desktopCookie('http://127.0.0.1:32123/path', 'secret'), {
      url: 'http://127.0.0.1:32123',
      name: 'code_agents_webcli_desktop_auth',
      value: 'secret',
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'strict',
    });
    assert.throws(() => desktopCookie('http://localhost:32123', 'x'), /only valid on loopback/);
    assert.throws(() => desktopCookie('https://127.0.0.1:32123', 'x'), /only valid on loopback/);
    assert.strictEqual(
      desktopCookie('http://127.0.0.1:32123', 'x', 'server_cookie').name,
      'server_cookie',
    );
  });

  it('recovers a login-shell PATH without losing inherited or duplicate entries', function () {
    assert.strictEqual(mergePath('/new:/same', '/same:/old', ':'), '/new:/same:/old');
    const recovered = loginShellPath({
      platform: 'darwin',
      shell: '/bin/zsh',
      inheritedPath: '/usr/bin:/bin',
      execFileSync: (_shell, argv) => {
        assert.deepStrictEqual(argv.slice(0, 1), ['-ilc']);
        return 'startup banner\n__CODE_AGENTS_PATH__=/opt/homebrew/bin:/usr/bin\n';
      },
    });
    assert.strictEqual(recovered, '/opt/homebrew/bin:/usr/bin:/bin');
    assert.strictEqual(
      loginShellPath({ platform: 'win32', inheritedPath: 'C:\\Tools;C:\\Windows' }),
      'C:\\Tools;C:\\Windows',
    );
  });

  it('awaits embedded-server teardown after a post-listen startup failure', async function () {
    const order = [];
    await shutdownAfterStartupFailure({
      async shutdown() {
        await Promise.resolve();
        order.push('shutdown');
      },
    });
    order.push('quit');
    assert.deepStrictEqual(order, ['shutdown', 'quit']);

    let reported = null;
    await shutdownAfterStartupFailure({
      async shutdown() { throw new Error('teardown failed'); },
    }, (error) => { reported = error; });
    assert.match(reported.message, /teardown failed/);
  });
});
