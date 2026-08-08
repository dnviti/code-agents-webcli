'use strict';

const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SMOKE_PAYLOAD_BYTES = 1024 * 1024 + 257;

/**
 * Hosts whose attachments must be stored inside the workspace.
 *
 * Workspace-local storage needs an openat-like descriptor namespace to prove
 * race-safe directory binding. Linux has one in `/proc/self/fd`, so both the
 * session and its attachments always land in `.cc-web`. Windows has none, but
 * `workspace-session-storage` accepts a pathname fallback per volume once it
 * has proven that an open descendant handle blocks an ancestor rename; the
 * attachment store resolves that policy separately, against the session working
 * directory, so a Windows host can keep the workspace session layout and still
 * store attachments in installation storage.
 *
 * Listing only the platform that guarantees the workspace-only outcome keeps
 * a Linux regression failing here, while a host that does achieve it is still
 * held to the complete contract below.
 */
const WORKSPACE_LOCAL_PERSISTENCE_PLATFORMS = new Set(['linux']);

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

function assertNoInstallationSessionCopy(server, dataDir, sessionId, payload, filesystem = fs) {
  assertNoInstallationSessionRows(server);

  const idNeedle = Buffer.from(sessionId, 'utf8');
  // A random prefix proves that attachment bytes were not duplicated without
  // reading a second full MiB from every installation file.
  const payloadNeedle = payload.subarray(0, 64);
  for (const entry of walk(dataDir, filesystem)) {
    assert.ok(!entry.name.includes(sessionId), `session id leaked into ${entry.absolute}`);
    if (!entry.file) continue;
    assert.equal(fileContains(entry.absolute, idNeedle, filesystem), false,
      `session id leaked into installation file ${entry.absolute}`);
    assert.equal(fileContains(entry.absolute, payloadNeedle, filesystem), false,
      `attachment bytes leaked into installation file ${entry.absolute}`);
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
  const canonicalWorkspace = filesystem.realpathSync(workspaceRoot);
  const canonicalDataDir = filesystem.realpathSync(dataDir);
  assert.equal(isInside(canonicalWorkspace, canonicalDataDir), false, 'dataDir must not be inside the workspace');
  assert.equal(isInside(canonicalDataDir, canonicalWorkspace), false, 'workspace must not be inside dataDir');

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
  // The session was accepted against this workspace root, so its history must
  // be here. Only the attachment store resolves a separate policy and can still
  // fall back on its own.
  const sessionDirectory = await waitFor(
    findWorkspaceSessionDirectory,
    'workspace-local session database and transcript',
  );
  assert.ok(isInside(ccWeb, sessionDirectory));

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
  const attachmentWorkspaceLocal = isInside(ccWeb, storedPath);
  if (workspaceLocalExpected) {
    assert.ok(attachmentWorkspaceLocal, 'attachment was stored outside workspace .cc-web');
  } else if (!attachmentWorkspaceLocal) {
    // Attachments resolve their own mutation policy against the session
    // working directory, so a host can keep the workspace session layout and
    // still fall back for attachments. Wherever they land it must be one of
    // the two storage locations this smoke owns, never somewhere else.
    assert.ok(isInside(canonicalDataDir, storedPath),
      `attachment left both the workspace and installation storage: ${storedPath}`);
  }
  if (attachmentWorkspaceLocal) {
    assert.equal(path.resolve(canonicalWorkspace, attachment.relativePath), storedPath);
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

  const workspaceOnly = attachmentWorkspaceLocal;
  if (workspaceOnly) {
    assertNoInstallationSessionCopy(
      started.server,
      canonicalDataDir,
      sessionId,
      payload,
      filesystem,
    );
  } else {
    // Attachments resolve their own policy, so they can fall back while the
    // conversation stays workspace-local. Their bytes and their owner/session
    // namespace are then legitimately inside `dataDir`, which rules out the
    // filesystem sweep -- but the conversation itself must still own no
    // installation-global row, and that half of the check remains exact.
    assertNoInstallationSessionRows(started.server);
  }
  return {
    sessionId,
    bytes: payload.length,
    mode: workspaceOnly ? 'workspace-only' : 'installation-fallback',
    workspaceOnly,
    sessionName,
    sessionDatabase,
    sessionDirectory,
    attachmentPath: storedPath,
  };
}

module.exports = {
  SMOKE_PAYLOAD_BYTES,
  assertNoInstallationSessionCopy,
  assertNoInstallationSessionRows,
  runPackagedWorkspacePersistenceSmoke,
};
