'use strict';

const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SMOKE_PAYLOAD_BYTES = 1024 * 1024 + 257;

/**
 * Hosts whose attachments must be stored inside the workspace.
 *
 * Every supported packaged desktop host must persist project conversations
 * entirely inside `.cc-web`. Linux uses descriptor-relative mutation; Windows
 * and macOS use the verified cwd helper.
 */
const WORKSPACE_LOCAL_PERSISTENCE_PLATFORMS = new Set(['linux', 'win32', 'darwin']);

/**
 * Windows spells one directory two ways. `fs.realpathSync` is implemented in
 * JavaScript and resolves symlinks while preserving an 8.3 short component such
 * as `RUNNER~1`, whereas the server resolves the same directory to its long
 * form. Comparing those two spellings makes a path that is inside the workspace
 * look like an escape, so every path this smoke compares is resolved through
 * the OS, which expands short components. The injected filesystem used by the
 * unit test has no `native` variant, so fall back to the JavaScript one.
 */
function canonicalPath(target, filesystem) {
  const native = filesystem.realpathSync?.native;
  return typeof native === 'function' ? native(target) : filesystem.realpathSync(target);
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function jsonResponse(response, operation) {
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* reported below */ }
  if (!response.ok || !body || typeof body !== 'object') {
    throw new Error(`${operation} failed with HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  return body;
}

async function waitFor(check, description, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${description}`, { cause: lastError });
}

function walk(root, filesystem = fs) {
  const entries = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    let children;
    try {
      children = filesystem.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    for (const child of children) {
      const absolute = path.join(current, child.name);
      entries.push({ absolute, name: child.name, directory: child.isDirectory(), file: child.isFile() });
      // Never let a smoke assertion turn a profile symlink into a filesystem scan.
      if (child.isDirectory() && !child.isSymbolicLink()) pending.push(absolute);
    }
  }
  return entries;
}

function fileContains(filename, needle, filesystem = fs) {
  if (!Buffer.isBuffer(needle) || needle.length === 0) return false;
  const chunk = Buffer.alloc(64 * 1024 + needle.length - 1);
  let descriptor = null;
  let offset = 0;
  let carry = 0;
  try {
    descriptor = filesystem.openSync(filename, 'r');
    for (;;) {
      const bytesRead = filesystem.readSync(descriptor, chunk, carry, 64 * 1024, offset);
      if (bytesRead === 0) return false;
      const length = carry + bytesRead;
      if (chunk.subarray(0, length).includes(needle)) return true;
      carry = Math.min(needle.length - 1, length);
      if (carry > 0) chunk.copy(chunk, 0, length - carry, length);
      offset += bytesRead;
    }
  } finally {
    if (descriptor !== null) filesystem.closeSync(descriptor);
  }
}

/**
 * A workspace-local conversation must never gain an installation-global row,
 * whatever storage its attachments ended up in. This half of the check stays
 * valid when attachments alone fall back, because it never reads `dataDir`.
 */
function assertNoInstallationSessionRows(server) {
  for (const table of ['runtime_sessions', 'usage_jobs', 'usage_job_models', 'usage_job_tools']) {
    const row = server.database.raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
    assert.equal(row.count, 0, `${table} received a new installation-global row`);
  }
}

function assertNoInstallationSessionCopy(server, dataDir, sessionId, payloads, filesystem = fs) {
  assertNoInstallationSessionRows(server);

  const idNeedle = Buffer.from(sessionId, 'utf8');
  const payloadNeedles = (Array.isArray(payloads) ? payloads : [payloads])
    .map((payload) => payload.subarray(0, 64));
  for (const entry of walk(dataDir, filesystem)) {
    assert.ok(!entry.name.includes(sessionId), `session id leaked into ${entry.absolute}`);
    if (!entry.file) continue;
    assert.equal(fileContains(entry.absolute, idNeedle, filesystem), false,
      `session id leaked into installation file ${entry.absolute}`);
    for (const payloadNeedle of payloadNeedles) {
      assert.equal(fileContains(entry.absolute, payloadNeedle, filesystem), false,
        `workspace payload leaked into installation file ${entry.absolute}`);
    }
  }
}

async function runPackagedWorkspacePersistenceSmoke(options) {
  const started = options?.started;
  if (typeof options?.workspaceRoot !== 'string' || !options.workspaceRoot.trim()
    || typeof options?.dataDir !== 'string' || !options.dataDir.trim()) {
    throw new TypeError('Absolute workspaceRoot and dataDir paths are required for the packaged persistence smoke.');
  }
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const dataDir = path.resolve(options.dataDir);
  const filesystem = options?.fs || fs;
  const fetchImpl = options?.fetch || globalThis.fetch;
  if (!started?.url || !started?.auth || !started?.server) {
    throw new TypeError('A started embedded server is required for the packaged persistence smoke.');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required for the packaged persistence smoke.');
  if (workspaceRoot === path.parse(workspaceRoot).root || dataDir === path.parse(dataDir).root) {
    throw new Error('Packaged persistence smoke refuses filesystem roots.');
  }
  filesystem.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
  // The request below must keep this spelling: the server validates a working
  // directory against its own base folder, and rejects the OS-resolved long
  // form as outside the allowed area. Comparisons use `resolvedInside`.
  const canonicalWorkspace = filesystem.realpathSync(workspaceRoot);
  const canonicalDataDir = filesystem.realpathSync(dataDir);
  const resolvedInside = (root, candidate) => isInside(
    canonicalPath(root, filesystem),
    canonicalPath(candidate, filesystem),
  );
  assert.equal(resolvedInside(canonicalWorkspace, canonicalDataDir), false, 'dataDir must not be inside the workspace');
  assert.equal(resolvedInside(canonicalDataDir, canonicalWorkspace), false, 'workspace must not be inside dataDir');

  const workspaceLocalExpected = WORKSPACE_LOCAL_PERSISTENCE_PLATFORMS.has(process.platform);
  const cookie = `${started.auth.name}=${encodeURIComponent(started.auth.value)}`;
  const commonHeaders = { Cookie: cookie, Origin: started.url };
  const createSession = (body) => fetchImpl(`${started.url}/api/sessions/create`, {
    method: 'POST',
    headers: { ...commonHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const readSession = async (response) => {
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* reported by the caller */ }
    return { body, text };
  };

  // The renderer smoke waits for this exact name to appear in the page, so
  // every path here must create the session under it. A retry that renamed the
  // conversation would hydrate a page the renderer stage never recognises.
  const sessionName = 'Packaged workspace persistence smoke';
  const createdResponse = await createSession({
    name: sessionName,
    workingDir: canonicalWorkspace,
  });
  const { body: created, text: createdText } = await readSession(createdResponse);
  if (createdResponse.status === 409 && created?.error === 'workspace_persistence_unavailable') {
    // There is no installation storage to retry into. The create route derives
    // its storage root from the working directory, defaulting to the base
    // folder when none is supplied, and loads workspace sessions for whichever
    // root it picked (`src/server/routes/sessions.ts`). A host that cannot bind
    // a workspace root therefore cannot create any conversation at all, so this
    // is reported as the outright failure it is rather than as a fallback.
    throw new Error(
      'Workspace-local persistence is unavailable on this host, so no session can be created: '
      + createdText.slice(0, 500),
    );
  }
  if (!createdResponse.ok || !created || typeof created !== 'object') {
    throw new Error(
      `desktop smoke session creation failed with HTTP ${createdResponse.status}: ${createdText.slice(0, 500)}`,
    );
  }
  const sessionId = created.sessionId;
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('Desktop smoke did not receive a session id.');
  assert.equal(created.session?.workingDir, canonicalWorkspace);

  const ccWeb = path.join(canonicalWorkspace, '.cc-web');
  const sessionDatabase = path.join(ccWeb, 'session-state.sqlite');
  const findWorkspaceSessionDirectory = () => {
    if (!filesystem.existsSync(sessionDatabase)) return null;
    const sessionsRoot = path.join(ccWeb, 'sessions');
    const matches = walk(sessionsRoot, filesystem)
      .filter((entry) => entry.directory && entry.name === sessionId)
      .map((entry) => entry.absolute);
    return matches.length === 1 && filesystem.existsSync(path.join(matches[0], 'transcript.md'))
      ? matches[0]
      : null;
  };
  // The session was accepted against this workspace root, so its database,
  // history and transcript must all be here.
  const sessionDirectory = await waitFor(
    findWorkspaceSessionDirectory,
    'workspace-local session database and transcript',
  );
  assert.ok(resolvedInside(ccWeb, sessionDirectory));

  const sessions = started.server.claudeSessions;
  const historyStore = started.server.historyStore;
  const chatStore = started.server.chatStore;
  const session = sessions?.get?.(sessionId);
  if (!session || !historyStore?.append || !historyStore?.flush || !chatStore?.append || !chatStore?.flush) {
    throw new Error('Desktop smoke cannot reach the session history or chat store.');
  }
  historyStore.append(session, ['packaged workspace persistence smoke history']);
  await historyStore.flush(session);
  for (const name of ['history.log', 'history.idx']) {
    const filename = path.join(sessionDirectory, name);
    assert.ok(filesystem.existsSync(filename), `workspace history file is missing: ${filename}`);
    assert.ok(resolvedInside(ccWeb, filename));
  }

  // This is intentionally a direct store write rather than a session-create
  // side effect: it exercises the durable chat log and index as packaged code
  // does, and gives the installation-data scan a distinctive payload to find.
  const chatPayload = 'packaged workspace persistence smoke chat payload';
  const chatTimestamp = Date.now();
  const chatMessageId = 'packaged-workspace-persistence-smoke-message';
  await chatStore.append(session, [
    {
      t: 'msg_start', seq: 1, ts: chatTimestamp, id: chatMessageId,
      role: 'user', turnId: 'packaged-workspace-persistence-smoke-turn',
    },
    {
      t: 'block_start', seq: 2, ts: chatTimestamp, msgId: chatMessageId, index: 0,
      block: { kind: 'text', text: chatPayload },
    },
  ]);
  await chatStore.flush(session);
  const chatLogPath = path.join(sessionDirectory, 'chat.jsonl');
  const chatIndexPath = path.join(sessionDirectory, 'chat.idx');
  for (const filename of [chatLogPath, chatIndexPath]) {
    assert.ok(filesystem.existsSync(filename), `workspace chat file is missing: ${filename}`);
    assert.ok(resolvedInside(ccWeb, filename));
  }
  assert.ok(
    String(filesystem.readFileSync(chatLogPath, 'utf8')).includes(chatPayload),
    'workspace chat log did not retain the smoke payload',
  );

  const pastePayload = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
  ]);
  const pasteResponse = await fetchImpl(
    `${started.url}/api/sessions/${encodeURIComponent(sessionId)}/paste-image`,
    { method: 'POST', headers: commonHeaders, body: pastePayload },
  );
  const paste = await jsonResponse(pasteResponse, 'desktop smoke pasted image upload');
  assert.equal(paste.bytes, pastePayload.length);
  assert.equal(typeof paste.path, 'string');
  const pastePath = path.resolve(paste.path);
  assert.ok(resolvedInside(ccWeb, pastePath), `paste was stored outside workspace .cc-web: ${pastePath}`);
  assert.deepEqual(filesystem.readFileSync(pastePath), pastePayload);
  assert.ok(filesystem.existsSync(path.join(sessionDirectory, 'paste-manifest.json')),
    'workspace paste metadata is missing');

  const payload = randomBytes(SMOKE_PAYLOAD_BYTES);
  const uploadResponse = await fetchImpl(
    `${started.url}/api/sessions/${encodeURIComponent(sessionId)}/chat-attachments?name=packaged-smoke.bin`,
    {
      method: 'POST',
      headers: {
        ...commonHeaders,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(payload.length),
      },
      body: payload,
    },
  );
  const attachment = await jsonResponse(uploadResponse, 'desktop smoke attachment upload');
  assert.equal(attachment.size, payload.length);
  assert.equal(attachment.mime, 'application/octet-stream');
  assert.equal(typeof attachment.url, 'string');
  assert.equal(typeof attachment.path, 'string');
  assert.equal(typeof attachment.relativePath, 'string');
  const storedPath = path.resolve(attachment.path);
  const attachmentWorkspaceLocal = resolvedInside(ccWeb, storedPath);
  assert.ok(workspaceLocalExpected, `Unsupported packaged smoke platform: ${process.platform}`);
  assert.ok(attachmentWorkspaceLocal,
    `attachment was stored outside workspace .cc-web (${ccWeb}): ${storedPath}`);
  if (attachmentWorkspaceLocal) {
    assert.equal(
      canonicalPath(path.resolve(canonicalWorkspace, attachment.relativePath), filesystem),
      canonicalPath(storedPath, filesystem),
    );
  }
  assert.deepEqual(filesystem.readFileSync(storedPath), payload);

  const downloadResponse = await fetchImpl(new URL(attachment.url, started.url), {
    headers: commonHeaders,
  });
  if (!downloadResponse.ok) {
    throw new Error(`desktop smoke attachment download failed with HTTP ${downloadResponse.status}`);
  }
  assert.equal(downloadResponse.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await downloadResponse.arrayBuffer()), payload);

  assertNoInstallationSessionCopy(
    started.server,
    canonicalDataDir,
    sessionId,
    [payload, pastePayload, Buffer.from(chatPayload, 'utf8')],
    filesystem,
  );
  return {
    sessionId,
    bytes: payload.length,
    mode: 'workspace-only',
    workspaceOnly: true,
    sessionName,
    sessionDatabase,
    sessionDirectory,
    attachmentPath: storedPath,
    pastePath,
    chatLogPath,
    chatIndexPath,
    chatPayload,
  };
}

module.exports = {
  SMOKE_PAYLOAD_BYTES,
  assertNoInstallationSessionCopy,
  assertNoInstallationSessionRows,
  runPackagedWorkspacePersistenceSmoke,
};
