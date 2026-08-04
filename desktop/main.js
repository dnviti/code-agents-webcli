'use strict';

const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const {
  app,
  BrowserWindow,
  dialog,
  Menu,
  screen,
  session,
  shell,
} = require('electron');
const {
  CUSTOM_TITLE_BAR_HEIGHT,
  desktopPermissionAllowed,
  desktopWindowChrome,
  desktopCookie,
  isSafeExternalUrl,
  loginShellPath,
  readWindowState,
  shutdownAfterStartupFailure,
  titleBarSymbolColor,
  writeWindowState,
} = require('./lib.js');

const APP_NAME = 'Code Agents Web CLI';
const DOCUMENTATION_URL = 'https://github.com/dnviti/code-agents-webcli/blob/main/docs/desktop.md';
const RELEASES_URL = 'https://github.com/dnviti/code-agents-webcli/releases';

let embeddedServer = null;
let localOrigin = null;
let mainWindow = null;
let stateSaveTimer = null;
let shutdownStarted = false;
let shutdownComplete = false;

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
  await server.start();

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

  return { server, url: parsed.origin, auth };
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

function installSessionPolicy(ses, origin) {
  ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin) =>
    desktopPermissionAllowed(permission, requestingOrigin, origin));
  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestingOrigin = details?.requestingUrl || webContents.getURL();
    callback(desktopPermissionAllowed(permission, requestingOrigin, origin));
  });
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
  if (!localOrigin || !embeddedServer) throw new Error('Desktop server is not ready.');
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

  protectNavigation(mainWindow, localOrigin);
  mainWindow.on('resize', () => scheduleWindowStateSave(stateFile));
  mainWindow.on('move', () => scheduleWindowStateSave(stateFile));
  mainWindow.on('maximize', () => scheduleWindowStateSave(stateFile));
  mainWindow.on('unmaximize', () => scheduleWindowStateSave(stateFile));
  mainWindow.on('close', () => {
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
    mainWindow = null;
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    dialog.showErrorBox('The application window stopped', `Renderer reason: ${details.reason}`);
  });

  await mainWindow.loadURL(localOrigin);
  return mainWindow;
}

async function showFlatpakNotice() {
  if (!process.env.FLATPAK_ID) return;
  const marker = path.join(app.getPath('userData'), `flatpak-notice-${app.getVersion()}`);
  if (fs.existsSync(marker)) return;
  const result = await dialog.showMessageBox({
    type: 'info',
    title: 'Flatpak tool access',
    message: 'The Flatpak sandbox may hide coding-agent tools installed on the host.',
    detail:
      'Your home folder is available inside the sandbox, but some host commands or credential '
      + 'helpers may not be. Use the AppImage release when an agent is installed outside your '
      + 'home folder or cannot be found here.',
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

async function runSmokeCheck(started) {
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
  const workingDir = path.dirname(started.server.database.storageDir);
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
  const smokeRoot = smoke ? fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-electron-smoke-')) : null;
  const started = await startEmbeddedServer({
    dataDir: smokeRoot ? path.join(smokeRoot, 'data') : path.join(app.getPath('userData'), 'server'),
    baseFolder: smokeRoot || app.getPath('home'),
  });
  embeddedServer = started.server;
  localOrigin = started.url;

  if (smoke) {
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

  const cookie = {
    ...desktopCookie(localOrigin, started.auth.value, started.auth.name),
    httpOnly: started.auth.httpOnly,
    sameSite: started.auth.sameSite,
  };
  await session.defaultSession.cookies.set(cookie);
  installSessionPolicy(session.defaultSession, localOrigin);
  installMenu();
  await createWindow();
  await showFlatpakNotice();
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
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
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', (event) => {
    if (shutdownComplete || !embeddedServer) return;
    event.preventDefault();
    if (shutdownStarted) return;
    shutdownStarted = true;
    void embeddedServer.shutdown().catch((error) => {
      console.error('Desktop server shutdown failed:', error);
    }).finally(() => {
      embeddedServer = null;
      shutdownComplete = true;
      app.quit();
    });
  });

  app.whenReady().then(boot).catch(async (error) => {
    console.error('Desktop startup failed:', error);
    dialog.showErrorBox(
      `${APP_NAME} could not start`,
      error instanceof Error ? error.message : String(error),
    );
    if (embeddedServer) {
      await shutdownAfterStartupFailure(embeddedServer, (shutdownError) => {
        console.error('Desktop server shutdown after startup failure failed:', shutdownError);
      });
      embeddedServer = null;
    }
    shutdownComplete = true;
    app.quit();
  });
}
