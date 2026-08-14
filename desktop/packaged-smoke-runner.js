'use strict';

const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const { app, BrowserWindow, ipcMain, session } = require('electron');
const { createLocalControllerTransport } = require('./controller-runtime.js');
const { createPhoneAccessService } = require('./phone-access-service.js');
const { installRendererSessionPolicy, protectNavigation } = require('./renderer-session-policy.js');
const { runPackagedWorkspacePersistenceSmoke } = require('./packaged-smoke.js');
const { CHANNELS: DESKTOP_UPDATE_CHANNELS } = require('./update-ipc.js');

const APP_NAME = 'Code Agents Web CLI';

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
  try {
    await smokeDeadline(sessionId, terminal.closed, 10_000);
  } finally {
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

    // Rebinding the exact port proves shutdown left no listener behind.
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
  // Exercise Chromium and the packaged renderer without touching the user's
  // default profile or any persistent remote OAuth partition.
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

async function runPackagedSmokeCheck(started) {
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
  const { implementationForQualification, qualificationTools } = require('../dist/sdk/node/qualification.js');
  const implementation = implementationForQualification(started.server);
  const { BaseBridge, PermissionBroker, TerminalBridge, ptySource } = qualificationTools();

  console.log('DESKTOP_SMOKE_STAGE workspace-attachment');
  const persistence = await runPackagedWorkspacePersistenceSmoke({
    started: { ...started, server: implementation },
    workspaceRoot: path.join(workingDir, 'workspace-smoke'),
    dataDir: started.dataDir,
  });
  console.log(`DESKTOP_WORKSPACE_ATTACHMENT_SMOKE_OK bytes=${persistence.bytes} ${persistence.mode}`);
  console.log('DESKTOP_SMOKE_STAGE packaged-renderer');
  await runPackagedRendererSmoke(started, persistence.sessionName);
  console.log('DESKTOP_SMOKE_STAGE phone-access');
  await runPhoneAccessSmoke(started, workingDir);
  console.log('DESKTOP_SMOKE_STAGE terminal');
  await smokeBridgeCommand(new TerminalBridge(), 'desktop-pty-smoke', {
    workingDir,
    mode: 'command',
    command: 'echo DESKTOP_PTY_OK',
  }, 'DESKTOP_PTY_OK');

  const broker = new PermissionBroker(path.join(workingDir, 'ipc-smoke'));
  try {
    const endpoint = await broker.listen({
      permission: async () => ({ allow: true, reason: 'DESKTOP_IPC_OK' }),
      question: async () => ({ labels: [], skipped: true }),
      tier: async () => ({ granted: false, detail: 'not used by smoke' }),
    });
    await new Promise((resolve, reject) => {
      const socket = net.createConnection(endpoint);
      let responseText = '';
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error('Desktop IPC smoke timed out.'));
      }, 10_000);
      socket.setEncoding('utf8');
      socket.once('error', (error) => { clearTimeout(timeout); reject(error); });
      socket.once('connect', () => {
        socket.write(`${JSON.stringify({
          id: 'desktop-ipc-smoke',
          ask: { toolName: 'smoke', toolInput: {} },
        })}\n`);
      });
      socket.on('data', (chunk) => {
        responseText += chunk;
        const newline = responseText.indexOf('\n');
        if (newline < 0) return;
        clearTimeout(timeout);
        const reply = JSON.parse(responseText.slice(0, newline));
        socket.destroy();
        if (reply.id !== 'desktop-ipc-smoke' || reply.allow !== true || reply.reason !== 'DESKTOP_IPC_OK') {
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
    class SmokeAgentBridge extends BaseBridge {
      getCommandCandidates() { return [shim]; }
      getDefaultCommand() { return shim; }
      getDisplayName() { return 'desktop agent smoke'; }
      getArgs() { return []; }
    }
    await smokeBridgeCommand(new SmokeAgentBridge(), 'desktop-agent-smoke', { workingDir }, 'DESKTOP_AGENT_OK');
  }
  console.log(`DESKTOP_SMOKE_OK ${process.platform}-${process.arch} pty=${ptySource()}`);
}

module.exports = { runPackagedSmokeCheck };
