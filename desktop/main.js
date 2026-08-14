'use strict';

const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  app,
  autoUpdater: nativeAutoUpdater,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  screen,
  session,
  shell,
} = require('electron');
const {
  CUSTOM_TITLE_BAR_HEIGHT,
  desktopWindowChrome,
  hostLoginShell,
  loginShellPath,
  readWindowState,
  titleBarSymbolColor,
  writeWindowState,
} = require('./lib.js');
const { installRendererSessionPolicy, protectNavigation } = require('./renderer-session-policy.js');
const {
  migrateLegacyRendererStorage,
  rendererPreferenceArgument,
} = require('./legacy-renderer-preferences.js');
const { DesktopUpdateService } = require('./updater.js');
const { loadElectronUpdaterProvider } = require('./electron-updater-provider.js');
const {
  FlatpakUpdaterProvider,
  readRunningFlatpakInfo,
  writeJsonAtomic,
} = require('./flatpak-updater-provider.js');
const { registerDesktopUpdateIpc } = require('./update-ipc.js');

const APP_NAME = 'Code Agents Web CLI';
const DOCUMENTATION_URL = 'https://github.com/dnviti/code-agents-webcli/blob/main/docs/desktop.md';
const RELEASES_URL = 'https://github.com/dnviti/code-agents-webcli/releases';

let embeddedServer = null;
let controllerGateway = null;
let controllerOrigin = null;
let trustedRendererOrigin = null;
let controllerRuntime = null;
let phoneAccessService = null;
let mainWindow = null;
let stateSaveTimer = null;
let shutdownStarted = false;
let shutdownComplete = false;
let legacyRendererPreferences = {};
let desktopUpdateService = null;
let disposeDesktopUpdateIpc = null;
let shutdownPromise = null;
let updateInstallShutdown = false;
let updateQuitAuthorized = false;

const DESKTOP_UPDATE_BUSY_PHASES = new Set([
  'downloading', 'ready', 'installing', 'restarting',
]);

function desktopUpdateBusy() {
  return DESKTOP_UPDATE_BUSY_PHASES.has(desktopUpdateService?.snapshot()?.phase);
}

function authorizeDesktopUpdateQuit() {
  updateQuitAuthorized = true;
}

function revokeDesktopUpdateQuit() {
  updateQuitAuthorized = false;
}

function updateHandshakeToken(argumentName) {
  const prefix = `--${argumentName}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  const value = argument?.slice(prefix.length) || '';
  return /^[0-9a-f]{48}$/.test(value) ? value : null;
}

const updateRelaunchToken = updateHandshakeToken('cc-web-update-relaunch');
const updateProbeToken = updateHandshakeToken('cc-web-update-probe');
let rendererReady = false;
let rendererReadyFailure = null;
let resolveRendererReady = null;
const rendererReadyPromise = updateRelaunchToken
  ? new Promise((resolve) => {
      resolveRendererReady = resolve;
    })
  : Promise.resolve();

function createCodeAgentsServer(options) {
  return require('../dist/sdk/node/index.js').createCodeAgentsServer(options);
}

function localIdentity() {
  try {
    const info = os.userInfo();
    return { username: info.username, name: info.username };
  } catch {
    return {
      username: process.env.USER || process.env.USERNAME || 'desktop-user',
      name: process.env.USER || process.env.USERNAME || 'Desktop user',
    };
  }
}

async function startEmbeddedServer({ dataDir, baseFolder }) {
  // Fail before drawing a window. A package without the platform PTY can still
  // serve HTML, but its defining terminal/agent feature cannot work; presenting
  // that as a healthy app would turn a packaging defect into a blank session.
  require('../dist/sdk/node/qualification.js').qualificationTools().ptySource();
  if (process.env.FLATPAK_ID) process.env.SHELL = hostLoginShell();
  process.env.PATH = loginShellPath({ inheritedPath: process.env.PATH });
  if (process.platform === 'win32' && !process.env.HOME) process.env.HOME = baseFolder;

  const authToken = randomBytes(32).toString('hex');
  const server = createCodeAgentsServer({
    port: 0,
    host: '127.0.0.1',
    baseFolder,
    dataDir,
    desktop: { authToken, ...localIdentity() },
  });
  const listener = await server.start();

  const url = server.localUrl;
  const auth = server.desktopAuthCookie;
  if (!url || !auth) {
    await server.shutdown();
    throw new Error('The embedded server started without a desktop URL or authentication cookie.');
  }
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') {
    await server.shutdown();
    throw new Error(`Refusing unsafe desktop listener ${parsed.origin}.`);
  }

  return {
    server,
    listener,
    url: parsed.origin,
    auth,
    // Keep the admission root chosen for this embedded server. Deriving it
    // back from the data directory is not equivalent inside Flatpak, where
    // the sandbox may relocate application data independently of /tmp.
    baseFolder: path.resolve(baseFolder),
    dataDir: path.resolve(dataDir),
  };
}

function scheduleWindowStateSave(filename) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  clearTimeout(stateSaveTimer);
  stateSaveTimer = setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      writeWindowState(filename, {
        ...mainWindow.getNormalBounds(),
        isMaximized: mainWindow.isMaximized(),
      });
    } catch (error) {
      console.warn('Could not save desktop window state:', error);
    }
  }, 250);
}

function installMenu() {
  // The web shell owns the desktop chrome on Windows and Linux. Leaving an
  // application menu installed would reserve a second bar and let Alt bring it
  // back over the custom title bar.
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: APP_NAME,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: '&File',
      submenu: [{ role: 'close' }],
    },
    {
      label: '&Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
    {
      label: '&View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools', visible: !app.isPackaged },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '&Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
    {
      role: 'help',
      submenu: [
        { label: 'Desktop application guide', click: () => void shell.openExternal(DOCUMENTATION_URL) },
        { label: 'Download releases', click: () => void shell.openExternal(RELEASES_URL) },
      ],
    },
  ]));
}

async function createWindow() {
  if (!controllerOrigin || !controllerGateway) throw new Error('Desktop controller is not ready.');
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }

  const stateFile = path.join(app.getPath('userData'), 'window-state.json');
  const state = readWindowState(stateFile, screen.getAllDisplays());
  const { isMaximized, ...bounds } = state;
  const icon = path.join(__dirname, '..', 'src', 'public', 'icons', 'icon-512.png');
  mainWindow = new BrowserWindow({
    ...bounds,
    ...desktopWindowChrome(),
    minWidth: 720,
    minHeight: 520,
    show: false,
    title: APP_NAME,
    icon: fs.existsSync(icon) ? icon : undefined,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: [rendererPreferenceArgument(legacyRendererPreferences)].filter(Boolean),
    },
  });
  if (process.platform !== 'darwin') {
    const chromeWindow = mainWindow;
    chromeWindow.removeMenu();
    chromeWindow.webContents.on('did-change-theme-color', (_event, color) => {
      if (!color || chromeWindow.isDestroyed()) return;
      chromeWindow.setTitleBarOverlay({
        color,
        symbolColor: titleBarSymbolColor(color),
        height: CUSTOM_TITLE_BAR_HEIGHT,
      });
    });
  }
  if (isMaximized) mainWindow.maximize();

  protectNavigation(mainWindow, controllerOrigin);
  for (const event of ['resize', 'move', 'maximize', 'unmaximize']) {
    mainWindow.on(event, () => scheduleWindowStateSave(stateFile));
  }
  mainWindow.on('close', (event) => {
    // Removing the in-app close paths is not sufficient: native window chrome,
    // menus, and OS shortcuts can still request a quit. Once consent starts,
    // keep the working process alive until the verified installer/relauncher
    // explicitly authorizes this close.
    if (desktopUpdateBusy() && !updateQuitAuthorized) {
      event.preventDefault();
      return;
    }
    clearTimeout(stateSaveTimer);
    try {
      writeWindowState(stateFile, {
        ...mainWindow.getNormalBounds(),
        isMaximized: mainWindow.isMaximized(),
      });
    } catch (error) {
      console.warn('Could not save desktop window state:', error);
    }
  });
  mainWindow.on('closed', () => {
    failRendererReady(Object.assign(new Error('The updated application window closed during startup.'), {
      code: 'FLATPAK_RENDERER_NOT_READY',
    }));
    mainWindow = null;
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    failRendererReady(Object.assign(new Error(`The updated renderer stopped (${details.reason}).`), {
      code: 'FLATPAK_RENDERER_NOT_READY',
    }));
    dialog.showErrorBox('The application window stopped', `Renderer reason: ${details.reason}`);
  });

  await mainWindow.loadURL(controllerOrigin);
  return mainWindow;
}

async function showFlatpakNotice() {
  if (!process.env.FLATPAK_ID) return;
  const marker = path.join(app.getPath('userData'), `flatpak-notice-${app.getVersion()}`);
  if (fs.existsSync(marker)) return;
  const result = await dialog.showMessageBox({
    type: 'info',
    title: 'Flatpak host tool access',
    message: 'Terminals and coding-agent tools run on your host system.',
    detail:
      'The application uses your configured host shell and host PATH. Commands run from this '
      + 'Flatpak therefore have the same access and privileges as commands you start in your '
      + 'normal terminal.',
    buttons: ['Continue', 'Read the guide'],
    defaultId: 0,
    cancelId: 0,
  });
  try {
    fs.writeFileSync(marker, `${new Date().toISOString()}\n`, { mode: 0o600 });
  } catch {
    // The notice may repeat when userData is read-only; that is preferable to
    // claiming it was acknowledged when it was not.
  }
  if (result.response === 1) void shell.openExternal(DOCUMENTATION_URL);
}

function createDesktopUpdateProvider() {
  if (!app.isPackaged || process.env.CODE_AGENTS_WEBCLI_DESKTOP_SMOKE === '1') return null;
  if (process.env.FLATPAK_ID || fs.existsSync('/.flatpak-info')) {
    return {
      name: 'flatpak',
      provider: new FlatpakUpdaterProvider({
        executable: process.execPath,
        manifestPublicKeyFile: path.join(process.resourcesPath, 'flatpak-update-public-key.asc'),
        relaunchDirectory: path.join(app.getPath('userData'), 'desktop-update-relaunch'),
        releaseSingleInstanceLock: () => app.releaseSingleInstanceLock(),
        reacquireSingleInstanceLock: () => app.requestSingleInstanceLock(),
      }),
    };
  }
  return {
    name: 'electron',
    provider: loadElectronUpdaterProvider({
      beforeInstall: authorizeDesktopUpdateQuit,
      afterInstallFailure: revokeDesktopUpdateQuit,
      nativeAutoUpdater,
    }),
  };
}

async function prepareDesktopUpdateInstall() {
  if (shutdownComplete) return;
  if (shutdownStarted && !updateInstallShutdown) {
    const error = new Error('The application is already closing.');
    error.code = 'DESKTOP_SHUTDOWN_IN_PROGRESS';
    throw error;
  }
  shutdownStarted = true;
  updateInstallShutdown = true;
  try {
    await shutdownDesktop({ forUpdate: true });
    shutdownComplete = true;
  } catch (error) {
    shutdownStarted = false;
    updateInstallShutdown = false;
    throw error;
  }
}

function relaunchFiles(token = updateRelaunchToken) {
  const directory = path.join(app.getPath('userData'), 'desktop-update-relaunch');
  return {
    request: token ? path.join(directory, `${token}.request.json`) : null,
    ack: token ? path.join(directory, `${token}.ack.json`) : null,
  };
}

function validateUpdateHandshake(token, expectedMode) {
  if (!token) return null;
  const files = relaunchFiles(token);
  const stat = fs.statSync(files.request);
  if (!stat.isFile() || stat.size < 2 || stat.size > 8 * 1024) {
    throw Object.assign(new Error('The Flatpak update handoff is malformed.'), {
      code: 'FLATPAK_RELAUNCH_MISMATCH',
    });
  }
  const request = JSON.parse(fs.readFileSync(files.request, 'utf8'));
  const age = Date.now() - Date.parse(String(request.requestedAt || ''));
  const running = readRunningFlatpakInfo();
  if (request.schemaVersion !== 1 || request.token !== token || request.mode !== expectedMode
    || !/^\d+\.\d+\.\d+$/.test(String(request.expectedVersion || ''))
    || !/^[0-9a-f]{64}$/i.test(String(request.expectedCommit || ''))
    || !Number.isFinite(age) || age < -60_000 || age > 5 * 60_000
    || app.getVersion() !== request.expectedVersion
    || running.commit.toLowerCase() !== request.expectedCommit.toLowerCase()) {
    const error = new Error('The relaunched Flatpak does not match the confirmed update.');
    error.code = 'FLATPAK_RELAUNCH_MISMATCH';
    throw error;
  }
  return { files, request, running };
}

function validateUpdateRelaunch() {
  return validateUpdateHandshake(updateRelaunchToken, 'relaunch');
}

function acknowledgeUpdateHandshake(token, mode, ok, detail = {}) {
  if (!token) return;
  const { ack } = relaunchFiles(token);
  try {
    let commit = null;
    try { commit = readRunningFlatpakInfo().commit.toLowerCase(); } catch { /* reported below */ }
    writeJsonAtomic(ack, {
      schemaVersion: 1,
      ok,
      token,
      mode,
      version: app.getVersion(),
      commit,
      ...detail,
    });
  } catch (error) {
    console.error('Could not acknowledge Flatpak relaunch:', error?.code || error?.message || error);
  }
}

function acknowledgeUpdateRelaunch(ok, detail = {}) {
  acknowledgeUpdateHandshake(updateRelaunchToken, 'relaunch', ok, detail);
}

function noteRendererReady() {
  if (rendererReady) return;
  rendererReady = true;
  resolveRendererReady?.();
}

function failRendererReady(error) {
  if (!updateRelaunchToken || rendererReady) return;
  rendererReadyFailure = error;
  resolveRendererReady?.();
}

async function waitForRendererReady(timeoutMs = 45_000) {
  if (!updateRelaunchToken) return;
  let timeout = null;
  try {
    await Promise.race([
      rendererReadyPromise,
      new Promise((_resolve, reject) => {
        timeout = setTimeout(() => reject(Object.assign(
          new Error('The updated application window did not become ready.'),
          { code: 'FLATPAK_RENDERER_NOT_READY' },
        )), timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  if (rendererReadyFailure) throw rendererReadyFailure;
  if (!rendererReady || !mainWindow || mainWindow.isDestroyed()) {
    throw Object.assign(new Error('The updated application window is unavailable.'), {
      code: 'FLATPAK_RENDERER_NOT_READY',
    });
  }
}

function initializeDesktopUpdates(userData) {
  let selected = null;
  try {
    selected = createDesktopUpdateProvider();
  } catch (error) {
    // A packaging defect must not make the whole desktop application unusable.
    console.error('Desktop updater could not initialize:', error?.code || error?.message || error);
  }
  desktopUpdateService = new DesktopUpdateService({
    currentVersion: app.getVersion(),
    provider: selected?.provider || null,
    providerName: selected?.name || null,
    enabled: Boolean(selected),
    stateFile: path.join(userData, 'desktop-update-state.json'),
    beginInstall: async () => { updateQuitAuthorized = false; },
    prepareInstall: prepareDesktopUpdateInstall,
    finishInstall: async () => {
      authorizeDesktopUpdateQuit();
      app.quit();
    },
  });
  disposeDesktopUpdateIpc = registerDesktopUpdateIpc({
    ipcMain,
    service: desktopUpdateService,
    getWindow: () => mainWindow,
    getOrigin: () => trustedRendererOrigin,
    onRendererReady: noteRendererReady,
  });
}

async function boot() {
  app.setName(APP_NAME);
  if (process.platform === 'win32') app.setAppUserModelId('io.github.dnviti.code-agents-webcli');
  if (app.isPackaged && app.commandLine.hasSwitch('no-sandbox')) {
    throw new Error(
      'This packaged app refuses to run without Chromium sandboxing. Enable unprivileged '
      + 'user namespaces for AppImage support or use the Flatpak package.',
    );
  }

  const smoke = process.env.CODE_AGENTS_WEBCLI_DESKTOP_SMOKE === '1';
  // Host processes launched through flatpak-spawn cannot see the sandbox's
  // private /tmp mount. Keep the smoke workspace under the home mount, which
  // is visible in both namespaces, so its terminal stage can use --directory.
  const smokeRoot = smoke
    ? fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.cc-web-electron-smoke-')))
    : null;
  if (smoke) {
    const { runPackagedSmokeCheck } = require('./packaged-smoke-runner.js');
    console.log('DESKTOP_SMOKE_STAGE embedded-server');
    const started = await startEmbeddedServer({
      dataDir: path.join(smokeRoot, 'data'),
      baseFolder: smokeRoot,
    });
    embeddedServer = started.server;
    console.log('DESKTOP_SMOKE_STAGE embedded-ready');
    try {
      await runPackagedSmokeCheck(started);
    } finally {
      await embeddedServer.shutdown();
      embeddedServer = null;
      fs.rmSync(smokeRoot, { recursive: true, force: true });
    }
    shutdownComplete = true;
    // Smoke mode has already shut down every resource it owns. Exit directly
    // so AppImage's FUSE launcher cannot keep CI waiting on Electron teardown.
    app.exit(0);
    return;
  }

  // Controller modules consume compiled SDK contracts. Load them inside the
  // caught startup path so an absent/corrupt build still reaches the dialog.
  const { ControllerCatalog } = require('./controller-catalog.js');
  const { readControllerPort } = require('./controller-endpoint.js');
  const { startControllerGateway } = require('./controller-startup.js');
  const { findLanServers } = require('./controller-discovery.js');
  const { createElectronControllerSessions } = require('./controller-electron.js');
  const { createControllerGateway } = require('./controller-gateway.js');
  const { createControllerRuntime } = require('./controller-runtime.js');
  const { createPhoneAccessService } = require('./phone-access-service.js');
  const userData = app.getPath('userData');
  const controllerEndpointFile = path.join(userData, 'controller', 'gateway.json');
  const controllerPort = readControllerPort(controllerEndpointFile);
  const catalog = new ControllerCatalog({
    filename: path.join(userData, 'controller', 'servers.json'),
  });
  const remoteSessions = createElectronControllerSessions({ session, BrowserWindow });
  controllerRuntime = createControllerRuntime({
    catalog,
    electronSessions: remoteSessions,
    findLanServers,
  });
  phoneAccessService = createPhoneAccessService({
    controller: controllerRuntime,
    dataDir: path.join(userData, 'controller'),
    localAvailable: false,
  });
  const startedController = await startControllerGateway({
    createGateway: createControllerGateway,
    gatewayOptions: {
      publicDir: path.join(__dirname, '..', 'dist', 'public'),
      controller: controllerRuntime,
      phoneAccess: phoneAccessService,
    },
    persistedPort: controllerPort,
    endpointFile: controllerEndpointFile,
  });
  controllerGateway = startedController.gateway;
  const controllerEndpoint = startedController.endpoint;
  if (startedController.recoveredFrom) {
    console.warn(
      `Controller port ${startedController.recoveredFrom.port} was unavailable `
      + `(${startedController.recoveredFrom.code}); moved to ${controllerEndpoint.port}.`,
    );
  }
  controllerOrigin = controllerEndpoint.origin;
  trustedRendererOrigin = controllerEndpoint.origin;
  const controllerAuthentication = controllerGateway.authentication();
  const controllerUrls = [
    `${controllerAuthentication.origin}/*`,
    `${controllerAuthentication.origin.replace('http:', 'ws:')}/*`,
  ];
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: controllerUrls }, (details, callback) => {
    const requestHeaders = Object.fromEntries(Object.entries(details.requestHeaders || {}).filter(
      ([name]) => name.toLowerCase() !== controllerAuthentication.header,
    ));
    requestHeaders[controllerAuthentication.header] = controllerAuthentication.value;
    callback({ requestHeaders });
  });
  controllerRuntime.start();

  try {
    const started = await startEmbeddedServer({
      dataDir: path.join(userData, 'server'),
      baseFolder: app.getPath('home'),
    });
    embeddedServer = started.server;
    controllerRuntime.attachLocal({ origin: started.url, auth: started.auth });
    await phoneAccessService.setLocalAvailable(true);
    started.listener.on('error', (error) => {
      controllerRuntime?.reportLocalFailure(error);
      void phoneAccessService?.setLocalAvailable(false, error)
        .catch((failure) => console.error('Phone access could not stop after a Local computer failure:', failure));
    });
    started.listener.on('close', () => {
      if (!shutdownStarted) {
        const error = Object.assign(
          new Error('The Local computer server stopped.'),
          { code: 'LOCAL_SERVER_STOPPED' },
        );
        controllerRuntime?.reportLocalFailure(error);
        void phoneAccessService?.setLocalAvailable(false, error)
          .catch((failure) => console.error('Phone access could not stop after Local computer closed:', failure));
      }
    });
  } catch (error) {
    controllerRuntime.reportLocalFailure(error);
    await phoneAccessService.setLocalAvailable(false, error);
    console.error('Local computer server could not start; remote controller remains available:', error);
  }

  installRendererSessionPolicy(session.defaultSession, controllerOrigin);
  installMenu();
  initializeDesktopUpdates(userData);
  await migrateLegacyRendererStorage(userData, session, async (preferences) => {
    legacyRendererPreferences = preferences;
    // The migration helper clears only defaultSession's non-cookie renderer
    // storage and HTTP cache before this first load. It records completion only
    // after loadURL lets the isolated preload restore the safe preferences.
    await createWindow();
  });
  if (!updateRelaunchToken) await showFlatpakNotice();
  desktopUpdateService?.start();
}

async function shutdownDesktop({ forUpdate = false } = {}) {
  if (shutdownPromise) return shutdownPromise;
  const updater = desktopUpdateService;
  const phoneAccess = phoneAccessService;
  const runtime = controllerRuntime;
  const gateway = controllerGateway;
  const server = embeddedServer;
  shutdownPromise = (async () => {
    const failures = [];
    const attempt = async (name, operation, completed) => {
      try {
        await Promise.resolve().then(operation);
        completed?.();
        return true;
      } catch (error) {
        failures.push({ name, error });
        return false;
      }
    };
    const continueAfter = (ok) => ok || !forUpdate;

    let proceed = true;
    if (!forUpdate && updater) {
      proceed = continueAfter(await attempt('updater', () => updater.stop()));
    }
    // Keep the controller gateway (and therefore the retry dialog) alive until
    // every Local-work resource has closed successfully. Update failures stop
    // here instead of tearing down unrelated pieces and stranding the window.
    if (proceed && phoneAccess) {
      proceed = continueAfter(await attempt('phone access', () => phoneAccess.close(), () => {
        if (phoneAccessService === phoneAccess) phoneAccessService = null;
      }));
    }
    if (proceed && server) {
      proceed = continueAfter(await attempt('embedded server', () => server.shutdown(), () => {
        if (embeddedServer === server) embeddedServer = null;
      }));
    }
    if (proceed && runtime) {
      proceed = continueAfter(await attempt('controller runtime', () => runtime.stop(), () => {
        if (controllerRuntime === runtime) controllerRuntime = null;
      }));
    }
    if (proceed && gateway) {
      proceed = continueAfter(await attempt('controller gateway', () => gateway.close(), () => {
        if (controllerGateway === gateway) controllerGateway = null;
      }));
    }
    if (failures.length > 0) {
      for (const failure of failures) {
        console.error(`Desktop ${failure.name} shutdown failed:`, failure.error?.code || failure.error?.message || failure.error);
      }
      const error = new AggregateError(failures.map((failure) => failure.error), 'Desktop cleanup did not finish.');
      error.code = 'DESKTOP_SHUTDOWN_FAILED';
      error.publicMessage = 'Local computer could not close cleanly. Resolve the reported work and retry the update.';
      throw error;
    }
    if (!forUpdate || !controllerGateway) controllerOrigin = null;
  })();
  try {
    return await shutdownPromise;
  } finally {
    shutdownPromise = null;
  }
}

if (updateProbeToken) {
  try {
    validateUpdateHandshake(updateProbeToken, 'probe');
    acknowledgeUpdateHandshake(updateProbeToken, 'probe', true);
    app.exit(0);
  } catch (error) {
    acknowledgeUpdateHandshake(updateProbeToken, 'probe', false, {
      code: error?.code || 'FLATPAK_PROBE_MISMATCH',
    });
    app.exit(1);
  }
} else {
  const hasLock = app.requestSingleInstanceLock();
  if (!hasLock) {
    acknowledgeUpdateRelaunch(false, { code: 'FLATPAK_RELAUNCH_LOCK_BUSY' });
    app.quit();
  } else {
    app.on('second-instance', () => {
      void createWindow().catch((error) => console.error('Could not focus desktop window:', error));
    });
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createWindow().catch((error) => console.error('Could not recreate desktop window:', error));
      }
    });
    app.on('window-all-closed', () => {
      // The packaged qualification owns a hidden, non-persistent window and
      // deliberately destroys it midway through the remaining native smokes.
      if (process.env.CODE_AGENTS_WEBCLI_DESKTOP_SMOKE !== '1' && process.platform !== 'darwin') app.quit();
    });
    app.on('will-quit', () => {
      void desktopUpdateService?.stop()
        .catch((error) => console.error('Desktop updater shutdown failed:', error?.code || error?.message || error));
      disposeDesktopUpdateIpc?.();
      disposeDesktopUpdateIpc = null;
    });
    app.on('before-quit', (event) => {
      if (desktopUpdateBusy() && !updateQuitAuthorized) {
        event.preventDefault();
        return;
      }
      if (shutdownComplete) return;
      event.preventDefault();
      if (shutdownStarted) return;
      shutdownStarted = true;
      void shutdownDesktop()
        .catch((error) => console.error('Desktop cleanup failed during quit:', error?.code || error?.message || error))
        .finally(() => {
          shutdownComplete = true;
          app.quit();
        });
    });

    app.whenReady().then(async () => {
      validateUpdateRelaunch();
      await boot();
      await waitForRendererReady();
      acknowledgeUpdateRelaunch(true);
    }).catch(async (error) => {
      console.error('Desktop startup failed:', error);
      if (updateRelaunchToken) app.releaseSingleInstanceLock();
      acknowledgeUpdateRelaunch(false, { code: error?.code || 'FLATPAK_RELAUNCH_START_FAILED' });
      if (!updateRelaunchToken) {
        dialog.showErrorBox(
          `${APP_NAME} could not start`,
          error instanceof Error ? error.message : String(error),
        );
      }
      try {
        await shutdownDesktop();
      } catch (shutdownError) {
        console.error('Desktop cleanup failed after startup error:', shutdownError?.code || shutdownError?.message || shutdownError);
      }
      shutdownComplete = true;
      app.quit();
    });
  }
}
