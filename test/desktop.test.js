const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CUSTOM_TITLE_BAR_HEIGHT,
  DEFAULT_WINDOW,
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
const {
  installRendererSessionPolicy,
  rendererPermissionAllowed,
} = require('../desktop/renderer-session-policy.js');

describe('Electron desktop helpers', function () {
  it('keeps the Electron renderer isolated and packaging targets complete', function () {
    const main = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');
    const builder = fs.readFileSync(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8');
    assert.match(main, /nodeIntegration:\s*false/);
    assert.match(main, /contextIsolation:\s*true/);
    assert.match(main, /sandbox:\s*true/);
    assert.match(main, /webSecurity:\s*true/);
    assert.match(main, /setWindowOpenHandler/);
    const rendererPolicy = fs.readFileSync(
      path.join(__dirname, '..', 'desktop', 'renderer-session-policy.js'),
      'utf8',
    );
    assert.match(rendererPolicy, /setPermissionRequestHandler/);
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
    const ci = fs.readFileSync(
      path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'),
      'utf8',
    );
    const ciSandbox = fs.readFileSync(
      path.join(__dirname, '..', 'scripts', 'configure-ci-electron-sandbox.sh'),
      'utf8',
    );
    const attachmentRunner = fs.readFileSync(
      path.join(__dirname, 'electron-attachment', 'run.js'),
      'utf8',
    );
    assert.strictEqual(
      (ci.match(/bash scripts\/configure-ci-electron-sandbox\.sh/g) || []).length,
      1,
      'ordinary CI configures its Electron helper exactly once',
    );
    assert.strictEqual(
      (release.match(/bash scripts\/configure-ci-electron-sandbox\.sh/g) || []).length,
      2,
      'tag CI configures both its verify and Linux desktop helpers',
    );
    for (const workflow of [ci, release]) {
      assert.match(workflow, /bash scripts\/configure-ci-electron-sandbox\.sh/);
    }
    const ciInstall = ci.indexOf('run: npm ci');
    const ciConfigure = ci.indexOf('run: bash scripts/configure-ci-electron-sandbox.sh');
    const ciTest = ci.indexOf('run: npm test');
    assert.ok(ciInstall >= 0 && ciInstall < ciConfigure && ciConfigure < ciTest,
      'ordinary CI configures the helper after install and before tests');

    const releaseVerify = release.slice(release.indexOf('\n  verify:'), release.indexOf('\n  docker:'));
    assert.ok(
      releaseVerify.indexOf('run: npm ci') < releaseVerify.indexOf('run: bash scripts/configure-ci-electron-sandbox.sh')
        && releaseVerify.indexOf('run: bash scripts/configure-ci-electron-sandbox.sh')
          < releaseVerify.indexOf('run: npm test'),
      'tag verification configures the helper after install and before tests',
    );
    const releaseDesktop = release.slice(
      release.indexOf('\n  desktop:'),
      release.indexOf('\n  desktop-upgrade-qualification:'),
    );
    assert.ok(
      releaseDesktop.indexOf('name: Build signed desktop packages')
        < releaseDesktop.indexOf('name: Configure Electron sandbox helper')
        && releaseDesktop.indexOf('name: Configure Electron sandbox helper')
          < releaseDesktop.indexOf('name: Verify native attachment gestures and controller routing'),
      'desktop artifacts are built before the helper is elevated for the renderer harness',
    );
    assert.match(ciSandbox, /ELECTRON_OVERRIDE_DIST_PATH is not allowed/);
    assert.match(ciSandbox, /package_entry="\$\(node -p 'require\.resolve\("electron"\)'\)"/);
    assert.match(ciSandbox, /expected_package_root="\$workspace_root\/node_modules\/electron"/);
    assert.match(ciSandbox, /node -e 'require\("electron"\)'/);
    assert.match(ciSandbox, /electron_candidate="\$\(node -p 'require\("electron"\)'\)"/);
    assert.match(ciSandbox, /\[ ! -f "\$electron_candidate" \] \|\| \[ -L "\$electron_candidate" \]/);
    assert.match(ciSandbox, /electron_executable="\$\(realpath -e -- "\$electron_candidate"\)"/);
    assert.match(ciSandbox, /dist_candidate="\$package_root\/dist"/);
    assert.match(ciSandbox, /\[ ! -d "\$dist_candidate" \] \|\| \[ -L "\$dist_candidate" \]/);
    assert.match(ciSandbox, /dist_root="\$\(realpath -e -- "\$dist_candidate"\)"/);
    assert.match(ciSandbox, /"\$dist_root" != "\$dist_candidate"/);
    assert.match(ciSandbox, /dirname -- "\$electron_executable"\)" != "\$dist_root"/);
    assert.match(ciSandbox, /candidate="\$dist_root\/chrome-sandbox"/);
    assert.match(ciSandbox, /\[ ! -f "\$candidate" \] \|\| \[ -L "\$candidate" \]/);
    assert.match(ciSandbox, /target="\$\(realpath -e -- "\$candidate"\)"/);
    assert.match(ciSandbox, /link_count="\$\(stat -c '%h' -- "\$target"\)"/);
    assert.match(ciSandbox, /"\$target" != "\$candidate"/);
    assert.match(ciSandbox, /"\$link_count" != '1'/);
    assert.match(ciSandbox, /sudo chown root:root -- "\$target"/);
    assert.match(ciSandbox, /sudo chmod 4755 -- "\$target"/);
    assert.match(ciSandbox, /stat -c '%u:%g:%a' -- "\$target"/);
    assert.match(ciSandbox, /sandbox_mode" != '0:0:4755'/);
    assert.match(ciSandbox, /Electron sandbox helper has insecure identity or mode/);
    assert.match(attachmentRunner, /Electron attachment renderer is required in CI/);
    assert.match(attachmentRunner, /if \(!requestedEnvironment\.CI\) return selected/);
    assert.match(release, /push:\s*\n\s*tags:\s*\n\s*- ['"]v\*\.\*\.\*['"]/);
    assert.match(release, /- ['"]!v\*\.\*\.\*-staging['"]/);
    assert.doesNotMatch(release, /push:\s*\n\s*branches:/);
    assert.match(release, /- os: ubuntu-24\.04/);
    assert.match(release, /EXPECTED_TAG="v\$\{VERSION\}"/);
    assert.match(release, /git merge-base --is-ancestor "\$TAG_TARGET" origin\/main/);
    assert.match(release, /Smoke the native packaged application/);
    assert.match(release, /Smoke the installed Flatpak artifact/);
    assert.match(release, /flatpak install --user --noninteractive --no-deps --bundle/);
    assert.match(release, /flatpak uninstall --user --noninteractive --delete-data/);
    assert.match(release, /DESKTOP_WORKSPACE_ATTACHMENT_SMOKE_OK/);
    assert.match(release, /DESKTOP_PACKAGED_RENDERER_SMOKE_OK/);
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

  it('keeps desktop permissions exact-origin and denies broad filesystem access', function () {
    const origin = 'http://127.0.0.1:43210';
    for (const permission of ['notifications', 'clipboard-read', 'clipboard-sanitized-write']) {
      assert.strictEqual(rendererPermissionAllowed(permission, `${origin}/chat`, origin), true);
      assert.strictEqual(rendererPermissionAllowed(permission, 'https://example.test', origin), false);
    }
    for (const permission of ['fileSystem', 'fileSystemWrite', 'openExternal']) {
      assert.strictEqual(
        rendererPermissionAllowed(permission, `${origin}/chat`, origin),
        false,
        `${permission} must not be granted to the renderer`,
      );
    }
    assert.strictEqual(
      rendererPermissionAllowed('notifications', 'http://127.0.0.1:43211/chat', origin),
      false,
      'even the one permitted capability is pinned to the exact gateway origin',
    );

    const installed = {};
    installRendererSessionPolicy({
      setPermissionCheckHandler(handler) { installed.check = handler; },
      setPermissionRequestHandler(handler) { installed.request = handler; },
    }, origin);
    assert.strictEqual(installed.check(null, 'clipboard-read', origin), true);
    assert.strictEqual(installed.check(null, 'fileSystem', origin), false);
    let decision = null;
    installed.request(
      { getURL: () => `${origin}/chat` },
      'notifications',
      (allowed) => { decision = allowed; },
      {},
    );
    assert.strictEqual(decision, true);
  });

  it('owns phone sharing in the desktop lifecycle without starting it implicitly', function () {
    const main = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');
    assert.match(main, /createPhoneAccessService\(\{[\s\S]*localAvailable:\s*false/);
    assert.match(main, /createControllerGateway\(\{[\s\S]*phoneAccess:\s*phoneAccessService/);
    assert.match(main, /attachLocal\([\s\S]*setLocalAvailable\(true\)/);
    assert.match(main, /reportLocalFailure\([\s\S]*setLocalAvailable\(false/);
    assert.match(main, /DESKTOP_PHONE_ACCESS_SMOKE_OK off-start-stop-port-released/);
    assert.match(main, /desktopUpdateBusy\(\) && !updateQuitAuthorized/);
    assert.match(main, /beforeInstall: authorizeDesktopUpdateQuit/);
    assert.match(main, /afterInstallFailure: revokeDesktopUpdateQuit/);
    assert.match(main, /nativeAutoUpdater/);
    assert.match(main, /service\.status\(\)\.state !== 'off'/);
    assert.match(main, /probe\.listen\(\{ host: '127\.0\.0\.1', port: running\.port/);
    const phoneClose = main.indexOf("attempt('phone access'");
    const serverClose = main.indexOf("attempt('embedded server'", phoneClose);
    const controllerStop = main.indexOf("attempt('controller runtime'", phoneClose);
    const gatewayClose = main.indexOf("attempt('controller gateway'", phoneClose);
    assert.ok(phoneClose >= 0 && serverClose > phoneClose
      && controllerStop > serverClose && gatewayClose > controllerStop,
    'phone sharing closes before the embedded server, controller runtime, and controller gateway');
  });

  it('qualifies workspace-local binary attachments and the renderer in the packaged smoke', function () {
    const main = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');
    const smoke = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'packaged-smoke.js'), 'utf8');
    assert.match(main, /runPackagedWorkspacePersistenceSmoke\(\{/);
    assert.match(main, /baseFolder: path\.resolve\(baseFolder\)/);
    assert.match(main, /const workingDir = started\.baseFolder/);
    assert.doesNotMatch(main, /path\.dirname\(started\.server\.database\.storageDir\)/);
    assert.match(
      main,
      /fs\.realpathSync\(fs\.mkdtempSync\(path\.join\(os\.tmpdir\(\), 'cc-web-electron-smoke-'\)\)\)/,
      'the packaged smoke must admit the same canonical tmp namespace it sends to the server',
    );
    assert.match(main, /runPackagedRendererSmoke\(started/);
    assert.match(main, /DESKTOP_WORKSPACE_ATTACHMENT_SMOKE_OK/);
    assert.match(main, /DESKTOP_PACKAGED_RENDERER_SMOKE_OK/);
    assert.ok(
      main.indexOf('DESKTOP_WORKSPACE_ATTACHMENT_SMOKE_OK') < main.indexOf('DESKTOP_SMOKE_OK'),
      'the final packaged marker must follow the workspace persistence assertion',
    );
    assert.match(smoke, /\/api\/sessions\/create/);
    assert.match(smoke, /chat-attachments\?name=packaged-smoke\.bin/);
    assert.match(smoke, /downloadResponse\.arrayBuffer\(\)/);
    assert.match(smoke, /session-state\.sqlite/);
    assert.match(smoke, /runtime_sessions.*usage_jobs.*usage_job_models.*usage_job_tools/s);
    assert.match(smoke, /cache-control.*no-store/s);
    assert.doesNotMatch(smoke, /clearAuthCache|fromPartition/);
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
