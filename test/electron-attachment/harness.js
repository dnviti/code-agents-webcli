'use strict';

const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const { app, BrowserWindow, clipboard, nativeImage, session } = require('electron');
const esbuild = require('esbuild');
const WebSocket = require('ws');

const { ControllerCatalog } = require('../../desktop/controller/catalog.js');
const {
  CONTROLLER_AUTH_HEADER,
  createControllerGateway,
} = require('../../desktop/controller-gateway.js');
const { qualifySessionId, parseQualifiedSessionId } = require('../../desktop/controller-protocol.js');
const { createControllerRuntime } = require('../../desktop/controller/runtime.js');
const { installRendererSessionPolicy } = require('../../desktop/renderer-session-policy.js');

console.log('ELECTRON_ATTACHMENT_E2E_PHASE electron:loaded');

const ROOT = path.resolve(__dirname, '..', '..');
const PNG = fs.readFileSync(path.join(ROOT, 'src', 'public', 'icons', 'icon-16.png'));
const TIMEOUT_MS = 20_000;

function response(body, options = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  return {
    statusCode: options.statusCode || 200,
    headers: {
      'content-type': options.contentType || (Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json'),
      'content-length': String(bytes.length),
      'x-content-type-options': 'nosniff',
    },
    body: Readable.from([bytes]),
  };
}

async function readBytes(body) {
  const chunks = [];
  for await (const chunk of body || Readable.from([])) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function safeName(value) {
  return String(value || 'attachment')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 80) || 'attachment';
}

class TargetSocket extends EventEmitter {
  constructor(target) {
    super();
    this.target = target;
    this.readyState = WebSocket.OPEN;
  }

  send(data) {
    this.target.messages.push(JSON.parse(String(data)));
  }

  close() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
}

class AttachmentTarget {
  constructor(id, origin) {
    this.id = id;
    this.origin = origin;
    this.sequence = 0;
    this.files = new Map();
    this.uploads = [];
    this.downloads = [];
    this.messages = [];
  }

  identity() {
    return {
      product: { id: 'code-agents-webcli', name: 'CODE AGENTS' },
      version: 'attachment-e2e',
      protocolVersion: 1,
      capabilities: ['remote-controller'],
      serverName: this.id,
      address: this.origin,
    };
  }

  async requestTarget(request) {
    const url = new URL(request.path || '/', this.origin);
    const upload = /^\/api\/sessions\/([^/]+)\/chat-attachments$/.exec(url.pathname);
    if (request.method === 'POST' && upload) {
      const sessionId = decodeURIComponent(upload[1]);
      const bytes = await readBytes(request.body);
      const filename = safeName(url.searchParams.get('name'));
      const storedName = `${(++this.sequence).toString(16).padStart(12, '0')}-${filename}`;
      const mime = String(request.headers?.['content-type'] || 'application/octet-stream').split(';')[0];
      this.files.set(`${sessionId}\0${storedName}`, { bytes, mime });
      this.uploads.push({
        sessionId,
        storedName,
        filename,
        mime,
        bytes,
        contentLength: request.headers?.['content-length'],
      });
      return response({
        url: `/api/sessions/${encodeURIComponent(sessionId)}/chat-attachments/${encodeURIComponent(storedName)}`,
        mime,
        name: filename,
        size: bytes.length,
      });
    }

    const download = /^\/api\/sessions\/([^/]+)\/chat-attachments\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'GET' && download) {
      const sessionId = decodeURIComponent(download[1]);
      const storedName = decodeURIComponent(download[2]);
      const stored = this.files.get(`${sessionId}\0${storedName}`);
      if (!stored) return response({ error: 'not_found' }, { statusCode: 404 });
      this.downloads.push({ sessionId, storedName, bytes: stored.bytes });
      return response(stored.bytes, { contentType: stored.mime });
    }

    return response({ error: 'not_found' }, { statusCode: 404 });
  }

  connectTargetWebSocket() {
    return new TargetSocket(this);
  }

  transport(remote = false) {
    return {
      ...(remote ? { verifyTarget: async () => this.identity() } : {}),
      requestTarget: (request) => this.requestTarget(request),
      connectTargetWebSocket: () => this.connectTargetWebSocket(),
    };
  }
}

function electronSessions() {
  return {
    forServer() {
      return {
        cookieProvider: async () => [],
        cookieSink: async () => {},
        clearServerData: async () => {},
      };
    },
  };
}

function writeRenderer(publicDir) {
  esbuild.buildSync({
    entryPoints: [path.join(__dirname, 'renderer.tsx')],
    outfile: path.join(publicDir, 'app.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome132'],
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  });
  fs.writeFileSync(path.join(publicDir, 'index.html'), `<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"
 content="default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self' ws:">
<style>:root{color-scheme:dark;--card:#111;--border:#444;--ring:#58a6ff;--foreground:#eee;--muted:#222;--muted-foreground:#aaa;--destructive:#f66;--font-sans:sans-serif;--font-mono:monospace;--radius:6px;--space-1:4px;--space-1-5:6px;--space-2:8px;--space-2-5:10px;--space-3:12px;--text-ui:14px;--text-2xs:11px;--leading-normal:1.5;--duration-base:120ms;--duration-instant:0ms;--ease-standard:ease;--ease-out:ease-out;--ease-in-out:ease-in-out}body{margin:0;background:#080808}</style>
</head><body><div id="root"></div><script src="/app.js"></script></body></html>`);
}

async function waitFor(label, predicate, win, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    if (win && !win.isDestroyed()) {
      const errors = await win.webContents.executeJavaScript(
        'globalThis.__attachmentProbe?.errors || []',
        true,
      ).catch(() => []);
      if (errors.length) throw new Error(`${label}: ${errors.join('\n')}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label} timed out after ${timeoutMs} ms`);
}

function deadline(label, promise, timeoutMs = TIMEOUT_MS) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function queryNode(debuggerApi, selector) {
  const document = await debuggerApi.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
  const result = await debuggerApi.sendCommand('DOM.querySelector', {
    nodeId: document.root.nodeId,
    selector,
  });
  if (!result.nodeId) throw new Error(`Renderer element not found: ${selector}`);
  return result.nodeId;
}

async function chooseFile(debuggerApi, filename) {
  const nodeId = await queryNode(debuggerApi, 'input[type=file]');
  await debuggerApi.sendCommand('DOM.setFileInputFiles', { nodeId, files: [filename] });
}

async function dropFile(debuggerApi, filename, win) {
  const point = await win.webContents.executeJavaScript(`(() => {
    const rect = document.querySelector('textarea[aria-label="Message"]').getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`, true);
  const data = {
    items: [{ mimeType: 'text/plain', data: '' }],
    files: [filename],
    dragOperationsMask: 1,
  };
  for (const type of ['dragEnter', 'dragOver', 'drop']) {
    await debuggerApi.sendCommand('Input.dispatchDragEvent', { type, ...point, data });
  }
}

async function pasteImage(win) {
  const image = nativeImage.createFromBuffer(PNG);
  assert.strictEqual(image.isEmpty(), false, 'the clipboard PNG fixture must decode');
  clipboard.clear();
  clipboard.writeImage(image);
  await win.webContents.executeJavaScript(
    'document.querySelector(\'textarea[aria-label="Message"]\').focus()',
    true,
  );
  win.webContents.paste();
}

function captureClipboard() {
  let bookmark = { title: '', url: '' };
  try { bookmark = clipboard.readBookmark(); } catch { /* Unsupported on this platform. */ }
  return {
    text: clipboard.readText(),
    html: clipboard.readHTML(),
    rtf: clipboard.readRTF(),
    image: clipboard.readImage(),
    bookmark,
  };
}

function restoreClipboard(saved) {
  clipboard.clear();
  const data = {};
  if (saved.text) data.text = saved.text;
  if (saved.html) data.html = saved.html;
  if (saved.rtf) data.rtf = saved.rtf;
  if (saved.image && !saved.image.isEmpty()) data.image = saved.image;
  if (saved.bookmark?.url) {
    data.text = saved.bookmark.url;
    data.bookmark = saved.bookmark.title || saved.bookmark.url;
  }
  if (Object.keys(data).length > 0) clipboard.write(data);
}

async function probe(win) {
  return win.webContents.executeJavaScript('globalThis.__attachmentProbe', true);
}

async function exerciseCase({ gatewayOrigin, debuggerApi, win, target, targetId, mode, filename }) {
  const rawSessionId = `${mode}/${targetId}`;
  const qualifiedSessionId = qualifySessionId(targetId, rawSessionId);
  const beforeMessages = target.messages.length;
  const beforeUploads = target.uploads.length;
  const beforeDownloads = target.downloads.length;

  console.log(`ELECTRON_ATTACHMENT_E2E_PHASE ${mode}/${targetId}:load`);
  await deadline(`${mode}/${targetId} navigation`, win.loadURL(
    `${gatewayOrigin}/?sessionId=${encodeURIComponent(qualifiedSessionId)}&case=${mode}-${targetId}`,
  ));
  await waitFor(`${mode}/${targetId} renderer bootstrap`, async () => {
    const state = await probe(win);
    return state?.ready && state?.socketReady;
  }, win);

  if (mode === 'picker') await chooseFile(debuggerApi, filename);
  else if (mode === 'drop') await dropFile(debuggerApi, filename, win);
  else await pasteImage(win);
  console.log(`ELECTRON_ATTACHMENT_E2E_PHASE ${mode}/${targetId}:gesture`);

  const state = await waitFor(`${mode}/${targetId} upload and download`, async () => {
    const current = await probe(win);
    return current?.uploadResults?.length === 1 && current?.downloads?.length === 1
      ? current : null;
  }, win);

  assert.deepStrictEqual(state.errors, []);
  assert.strictEqual(state.downloads[0].status, 200);
  const downloadControl = await win.webContents.executeJavaScript(`(() => {
    const link = document.querySelector('a[aria-label^="Download "]');
    return link ? {
      path: new URL(link.href).pathname,
      filename: link.getAttribute('download'),
    } : null;
  })()`, true);
  assert.ok(downloadControl, 'the completed composer chip offers a real download link');
  assert.strictEqual(downloadControl.path, state.uploadResults[0].url);
  assert.strictEqual(downloadControl.filename, state.uploadResults[0].name);
  assert.strictEqual(target.uploads.length, beforeUploads + 1);
  assert.strictEqual(target.downloads.length, beforeDownloads + 1);
  const upload = target.uploads.at(-1);
  const download = target.downloads.at(-1);
  assert.strictEqual(upload.sessionId, rawSessionId);
  assert.strictEqual(download.sessionId, rawSessionId);
  assert.deepStrictEqual(download.bytes, upload.bytes, 'target download changed uploaded bytes');
  assert.deepStrictEqual(
    Buffer.from(state.downloads[0].bytes),
    upload.bytes,
    'renderer download changed uploaded bytes',
  );
  assert.deepStrictEqual(
    Buffer.from(state.uploadFiles[0].bytes),
    upload.bytes,
    'the gateway or selected transport changed the File bytes',
  );
  if (mode !== 'clipboard') assert.deepStrictEqual(upload.bytes, PNG);
  assert.strictEqual(upload.contentLength, String(upload.bytes.length));

  const qualifiedAttachment = state.uploadResults[0];
  const qualifiedMatch = /^\/api\/sessions\/([^/]+)\/chat-attachments\//.exec(qualifiedAttachment.url);
  assert.ok(qualifiedMatch, 'the renderer receives a canonical attachment URL');
  assert.deepStrictEqual(parseQualifiedSessionId(decodeURIComponent(qualifiedMatch[1])), {
    serverId: targetId,
    sessionId: rawSessionId,
  });

  const clicked = await win.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('button[aria-label="Send message"]');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`, true);
  assert.strictEqual(clicked, true, 'send stays available after the upload finishes');
  await waitFor(`${mode}/${targetId} chat turn`, () =>
    Promise.resolve(target.messages.length === beforeMessages + 1), win);

  const sent = target.messages.at(-1);
  assert.strictEqual(sent.type, 'chat_send');
  assert.strictEqual(sent.sessionId, rawSessionId);
  assert.strictEqual(sent.attachments.length, 1);
  assert.strictEqual(
    sent.attachments[0].url,
    `/api/sessions/${encodeURIComponent(rawSessionId)}/chat-attachments/${encodeURIComponent(upload.storedName)}`,
    'the gateway restores the owner-local URL before the WebSocket turn',
  );
  assert.strictEqual((await probe(win)).sent.length, 1);
  console.log(`ELECTRON_ATTACHMENT_E2E_PHASE ${mode}/${targetId}:ok`);
}

async function run() {
  console.log('ELECTRON_ATTACHMENT_E2E_PHASE setup:start');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-electron-attachment-'));
  const publicDir = path.join(directory, 'public');
  fs.mkdirSync(publicDir, { recursive: true });
  writeRenderer(publicDir);
  console.log('ELECTRON_ATTACHMENT_E2E_PHASE setup:renderer');

  const catalog = new ControllerCatalog({
    filename: path.join(directory, 'servers.json'),
    randomUUID: () => 'remote',
  });
  const remoteRecord = catalog.add({ name: 'Remote mock', origin: 'https://remote.invalid' });
  catalog.setAuthMarker(remoteRecord.id, true);
  const local = new AttachmentTarget('local', 'http://127.0.0.1:1');
  const remote = new AttachmentTarget(remoteRecord.id, remoteRecord.origin);
  const runtime = createControllerRuntime({
    catalog,
    electronSessions: electronSessions(),
    createLocalTransport: () => local.transport(false),
    createRemoteTransport: () => remote.transport(true),
  });
  runtime.attachLocal({ origin: local.origin, auth: { name: 'test', value: 'test' } });
  await deadline('controller reconnect', runtime.reconnect());
  console.log('ELECTRON_ATTACHMENT_E2E_PHASE setup:runtime');

  const gateway = createControllerGateway({ publicDir, controller: runtime });
  const { origin } = await gateway.listen();
  console.log(`ELECTRON_ATTACHMENT_E2E_PHASE setup:gateway ${origin}`);
  const authentication = gateway.authentication();
  const urls = [`${origin}/*`, `${origin.replace('http:', 'ws:')}/*`];
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls }, (details, callback) => {
    const headers = Object.fromEntries(Object.entries(details.requestHeaders || {}).filter(
      ([name]) => name.toLowerCase() !== CONTROLLER_AUTH_HEADER,
    ));
    headers[CONTROLLER_AUTH_HEADER] = authentication.value;
    callback({ requestHeaders: headers });
  });
  installRendererSessionPolicy(session.defaultSession, origin);

  const preferences = {
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    navigateOnDragDrop: false,
  };
  // BrowserWindow annotates the object it receives with internal defaults;
  // retain the caller's security contract separately for the assertion.
  const expectedPreferences = { ...preferences };
  const win = new BrowserWindow({ width: 800, height: 500, show: false, webPreferences: preferences });
  console.log('ELECTRON_ATTACHMENT_E2E_PHASE setup:window');
  const actualPreferences = win.webContents.getLastWebPreferences();
  for (const [name, expected] of Object.entries(expectedPreferences)) {
    if (expected === false) {
      assert.notStrictEqual(actualPreferences[name], true, `${name} must stay hardened`);
    } else {
      assert.strictEqual(actualPreferences[name], expected, `${name} must stay hardened`);
    }
  }

  const debuggerApi = win.webContents.debugger;
  debuggerApi.attach('1.3');
  const savedClipboard = captureClipboard();
  const files = {};
  for (const mode of ['picker', 'drop']) {
    for (const targetId of ['local', 'remote']) {
      const filename = path.join(directory, `${mode}-${targetId}.png`);
      fs.writeFileSync(filename, PNG);
      files[`${mode}-${targetId}`] = filename;
    }
  }

  try {
    for (const targetId of ['local', 'remote']) {
      const target = targetId === 'local' ? local : remote;
      for (const mode of ['picker', 'drop', 'clipboard']) {
        await exerciseCase({
          gatewayOrigin: origin,
          debuggerApi,
          win,
          target,
          targetId,
          mode,
          filename: files[`${mode}-${targetId}`],
        });
      }
    }
    assert.strictEqual(local.uploads.length, 3);
    assert.strictEqual(remote.uploads.length, 3);
    console.log('ELECTRON_ATTACHMENT_E2E_OK picker=2 drop=2 clipboard=2 local=3 remote=3 ui-download=6');
  } finally {
    restoreClipboard(savedClipboard);
    if (debuggerApi.isAttached()) debuggerApi.detach();
    if (!win.isDestroyed()) win.destroy();
    runtime.stop();
    await gateway.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(run).then(
  () => app.exit(0),
  (error) => {
    console.error('ELECTRON_ATTACHMENT_E2E_FAILED', error?.stack || error);
    app.exit(1);
  },
);
