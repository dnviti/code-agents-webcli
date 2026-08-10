'use strict';

const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
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
  isSafeExternalUrl,
  loginShellPath,
  readWindowState,
  titleBarSymbolColor,
  writeWindowState,
} = require('./lib.js');
const { ControllerCatalog } = require('./controller-catalog.js');
const { readControllerPort, writeControllerPort } = require('./controller-endpoint.js');
const { findLanServers } = require('./controller-discovery.js');
const { createElectronControllerSessions } = require('./controller-electron.js');
const { createControllerGateway } = require('./controller-gateway.js');
const { createControllerRuntime, createLocalControllerTransport } = require('./controller-runtime.js');
const { installRendererSessionPolicy } = require('./renderer-session-policy.js');
const { createPhoneAccessService } = require('./phone-access-service.js');
const { runPackagedWorkspacePersistenceSmoke } = require('./packaged-smoke.js');
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
const { CHANNELS: DESKTOP_UPDATE_CHANNELS, registerDesktopUpdateIpc } = require('./update-ipc.js');

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

function serverClass() {
  return require('../dist/server/index.js').ClaudeCodeWebServer;
}

function ptySource() {
  return require('../dist/server/services/pty.js').ptySource();
}

function terminalBridgeClass() {
  return require('../dist/server/bridges/terminal.js').TerminalBridge;
}

function baseBridgeClass() {
  return require('../dist/server/bridges/base.js').BaseBridge;
}

function permissionBrokerClass() {
  return require('../dist/server/chat/permission-broker.js').PermissionBroker;
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
  ptySource();
  if (process.env.FLATPAK_ID) process.env.SHELL = hostLoginShell();
  process.env.PATH = loginShellPath({ inheritedPath: process.env.PATH });
  if (process.platform === 'win32' && !process.env.HOME) process.env.HOME = baseFolder;

  const authToken = randomBytes(32).toString('hex');
  const Server = serverClass();
  const server = new Server({
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

  const appMenu = process.platform === 'darwin'
    ? [{
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
      }]
    : [];

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...appMenu,
    {
      label: '&File',
      submenu: [process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' }],
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
        ...(process.platform === 'darwin'
          ? [{ role: 'pasteAndMatchStyle' }, { role: 'delete' }, { role: 'selectAll' }]
          : [{ role: 'delete' }, { type: 'separator' }, { role: 'selectAll' }]),
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
        ...(process.platform === 'darwin'
          ? [{ type: 'separator' }, { role: 'front' }]
          : [{ role: 'close' }]),
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

function protectNavigation(win, origin) {
  const openExternal = (url) => {
    if (isSafeExternalUrl(url, origin)) void shell.openExternal(url);
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  const keepInsideOrigin = (event, url) => {
    try {
      if (new URL(url).origin === origin) return;
    } catch {
      // Rejected below.
    }
    event.preventDefault();
    openExternal(url);
  };
  win.webContents.on('will-navigate', keepInsideOrigin);
  win.webContents.on('will-redirect', keepInsideOrigin);
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
  mainWindow.on('resize', () => scheduleWindowStateSave(stateFile));
  mainWindow.on('move', () => scheduleWindowStateSave(stateFile));
  mainWindow.on('maximize', () => scheduleWindowStateSave(stateFile));
  mainWindow.on('unmaximize', () => scheduleWindowStateSave(stateFile));
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

async function smokeBridgeCommand(bridge, sessionId, options, marker) {
  let output = '';
  let exitCode = null;
  let terminalError = null;
  const terminal = await bridge.startSession(sessionId, {
    ...options,
    onOutput: (chunk) => { output += chunk; },
    onExit: (code) => { exitCode = code; },
    onError: (error) => { terminalError = error; },
  });
  let timeout = null;
  try {
    await Promise.race([
      terminal.closed,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${sessionId} timed out.`)), 10_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (bridge.getSession(sessionId)) await bridge.stopSession(sessionId).catch(() => undefined);
  }
  if (terminalError) throw terminalError;
  if (exitCode !== 0 || !output.includes(marker)) {
    throw new Error(`${sessionId} failed (exit ${exitCode}, output ${JSON.stringify(output)}).`);
  }
}

async function runPhoneAccessSmoke(started, workingDir) {
  const local = createLocalControllerTransport({ origin: started.url, auth: started.auth });
  const controller = {
    listTargets: () => [{ id: 'local', name: 'Local computer', status: 'ready' }],
    request: (serverId, options) => {
      if (serverId !== 'local') throw new Error('Phone smoke attempted non-local routing.');
      return local.requestTarget(options);
    },
    connectWebSocket: (serverId, options) => {
      if (serverId !== 'local') throw new Error('Phone smoke attempted a non-local WebSocket.');
      return local.connectTargetWebSocket(options);
    },
  };
  const service = createPhoneAccessService({
    controller,
    dataDir: path.join(workingDir, 'phone-access-smoke'),
    localAvailable: true,
    allowEphemeralPort: true,
  });
  try {
    if (service.status().state !== 'off') throw new Error('Phone access was not initially off.');
    const running = await service.start({ mode: 'tailscale', port: 0 });
    if (running.state !== 'running' || !running.port || running.pairing || Object.keys(running.origins).length) {
      throw new Error('Phone access smoke published a route before Tailscale validation.');
    }
    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: running.port });
      socket.once('connect', () => { socket.destroy(); resolve(); });
      socket.once('error', reject);
    });
    await service.stop();
    if (service.status().state !== 'off') throw new Error('Phone access did not return to off.');

    // Rebinding the exact port is a stronger packaged-artifact assertion than
    // merely observing status: it proves shutdown left no listener behind.
    const probe = net.createServer();
    await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen({ host: '127.0.0.1', port: running.port, exclusive: true }, resolve);
    });
    await new Promise((resolve) => probe.close(resolve));
  } finally {
    await service.close();
  }
  console.log('DESKTOP_PHONE_ACCESS_SMOKE_OK off-start-stop-port-released');
}

async function smokeDeadline(label, operation, timeoutMs = 30_000) {
  let timer = null;
  try {
    return await Promise.race([
      operation,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runPackagedRendererSmoke(started, expectedSessionName) {
  // A non-persist:* partition exercises Chromium and the packaged renderer
  // without putting this qualification run's cookie, cache, or web storage in
  // the user's default profile. Remote OAuth partitions remain untouched.
  const partition = `desktop-smoke-${randomBytes(12).toString('hex')}`;
  const smokeSession = session.fromPartition(partition, { cache: false });
  await smokeSession.cookies.set({
    url: `${started.url}/`,
    name: started.auth.name,
    value: started.auth.value,
    httpOnly: true,
    sameSite: 'strict',
  });
  installRendererSessionPolicy(smokeSession, started.url);
  const win = new BrowserWindow({
    width: 900,
    height: 650,
    show: false,
    title: `${APP_NAME} packaged smoke`,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      partition,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  ipcMain.handle(DESKTOP_UPDATE_CHANNELS.snapshot, () => ({
    phase: 'disabled',
    currentVersion: app.getVersion(),
    generation: 0,
  }));
  protectNavigation(win, started.url);
  let rendererFailure = null;
  win.webContents.once('render-process-gone', (_event, details) => {
    rendererFailure = new Error(`Packaged smoke renderer stopped (${details.reason}).`);
  });
  try {
    await smokeDeadline('packaged renderer navigation', win.loadURL(started.url));
    await smokeDeadline('packaged renderer hydration', (async () => {
      for (;;) {
        if (rendererFailure) throw rendererFailure;
        if (win.isDestroyed()) throw new Error('Packaged smoke window was destroyed during hydration.');
        const ready = await win.webContents.executeJavaScript(`(() => {
          const root = document.getElementById('relayRoot');
          return document.getElementById('bootTitlebar') === null
            && Boolean(root && root.childElementCount > 0)
            && document.body.innerText.includes(${JSON.stringify(expectedSessionName)});
        })()`, true);
        if (ready) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    })());
  } finally {
    if (!win.isDestroyed()) win.destroy();
    ipcMain.removeHandler(DESKTOP_UPDATE_CHANNELS.snapshot);
    await smokeSession.clearStorageData().catch(() => undefined);
  }
  console.log('DESKTOP_PACKAGED_RENDERER_SMOKE_OK isolated-window-hydrated');
}

async function runSmokeCheck(started) {
  console.log('DESKTOP_SMOKE_STAGE config');
  const cookie = `${started.auth.name}=${encodeURIComponent(started.auth.value)}`;
  const headers = { Cookie: cookie };
  const page = await fetch(`${started.url}/`, { headers });
  if (!page.ok) throw new Error(`Desktop smoke page failed with HTTP ${page.status}.`);
  const html = await page.text();
  if (!html.includes('<title>Code Agents Web CLI</title>')) {
    throw new Error('Desktop smoke page did not contain the packaged browser shell.');
  }

  const response = await fetch(`${started.url}/api/config`, { headers });
  if (!response.ok) throw new Error(`Desktop smoke request failed with HTTP ${response.status}.`);
  const config = await response.json();
  if (!config.currentUser || !Array.isArray(config.supportedShells)) {
    throw new Error('Desktop smoke config did not carry the local user and shell catalog.');
  }
  const workingDir = started.baseFolder;
  if (typeof workingDir !== 'string' || !path.isAbsolute(workingDir)) {
    throw new Error('Desktop smoke did not retain its embedded server base folder.');
  }
  console.log('DESKTOP_SMOKE_STAGE workspace-attachment');
  const persistence = await runPackagedWorkspacePersistenceSmoke({
    started,
    workspaceRoot: path.join(workingDir, 'workspace-smoke'),
    dataDir: started.server.database.storageDir,
  });
  console.log(`DESKTOP_WORKSPACE_ATTACHMENT_SMOKE_OK bytes=${persistence.bytes} ${persistence.mode}`);
  console.log('DESKTOP_SMOKE_STAGE packaged-renderer');
  await runPackagedRendererSmoke(started, persistence.sessionName);
  console.log('DESKTOP_SMOKE_STAGE phone-access');
  await runPhoneAccessSmoke(started, workingDir);
  console.log('DESKTOP_SMOKE_STAGE terminal');
  const TerminalBridge = terminalBridgeClass();
  await smokeBridgeCommand(new TerminalBridge(), 'desktop-pty-smoke', {
    workingDir,
    mode: 'command',
    command: 'echo DESKTOP_PTY_OK',
  }, 'DESKTOP_PTY_OK');

  const PermissionBroker = permissionBrokerClass();
  const broker = new PermissionBroker(path.join(workingDir, 'ipc-smoke'));
  try {
    const endpoint = await broker.listen({
      permission: async () => ({ allow: true, reason: 'DESKTOP_IPC_OK' }),
      question: async () => ({ labels: [], skipped: true }),
      tier: async () => ({ granted: false, detail: 'not used by smoke' }),
    });
    await new Promise((resolve, reject) => {
      const socket = net.createConnection(endpoint);
      let response = '';
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error('Desktop IPC smoke timed out.'));
      }, 10_000);
      socket.setEncoding('utf8');
      socket.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      socket.once('connect', () => {
        socket.write(`${JSON.stringify({
          id: 'desktop-ipc-smoke',
          ask: { toolName: 'smoke', toolInput: {} },
        })}\n`);
      });
      socket.on('data', (chunk) => {
        response += chunk;
        const newline = response.indexOf('\n');
        if (newline < 0) return;
        clearTimeout(timeout);
        const reply = JSON.parse(response.slice(0, newline));
        socket.destroy();
        if (reply.id !== 'desktop-ipc-smoke' || reply.allow !== true
          || reply.reason !== 'DESKTOP_IPC_OK') {
          reject(new Error(`Desktop IPC smoke returned ${JSON.stringify(reply)}.`));
          return;
        }
        resolve();
      });
    });
  } finally {
    broker.close();
  }
  console.log(`DESKTOP_IPC_OK ${process.platform === 'win32' ? 'named-pipe' : 'unix-socket'}`);

  if (process.platform === 'win32') {
    const shim = path.join(workingDir, 'desktop-agent-smoke.cmd');
    fs.writeFileSync(shim, '@echo off\r\necho DESKTOP_AGENT_OK\r\n', { mode: 0o700 });
    const BaseBridge = baseBridgeClass();
    class SmokeAgentBridge extends BaseBridge {
      getCommandCandidates() { return [shim]; }
      getDefaultCommand() { return shim; }
      getDisplayName() { return 'desktop agent smoke'; }
      getArgs() { return []; }
    }
    await smokeBridgeCommand(new SmokeAgentBridge(), 'desktop-agent-smoke', {
      workingDir,
    }, 'DESKTOP_AGENT_OK');
  }
  console.log(`DESKTOP_SMOKE_OK ${process.platform}-${process.arch} pty=${ptySource()}`);
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
    console.log('DESKTOP_SMOKE_STAGE embedded-server');
    const started = await startEmbeddedServer({
      dataDir: path.join(smokeRoot, 'data'),
      baseFolder: smokeRoot,
    });
    embeddedServer = started.server;
    console.log('DESKTOP_SMOKE_STAGE embedded-ready');
    try {
      await runSmokeCheck(started);
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
  controllerGateway = createControllerGateway({
    publicDir: path.join(__dirname, '..', 'dist', 'public'),
    controller: controllerRuntime,
    phoneAccess: phoneAccessService,
    port: controllerPort,
  });
  const controllerEndpoint = await controllerGateway.listen();
  controllerOrigin = controllerEndpoint.origin;
  trustedRendererOrigin = controllerEndpoint.origin;
  if (controllerPort === 0) writeControllerPort(controllerEndpointFile, controllerEndpoint.port);
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
