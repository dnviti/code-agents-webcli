'use strict';

const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// The pre-controller desktop server listened on a random loopback port. Chromium
// therefore kept its renderer preferences under a different origin on every
// launch. We deliberately read only these presentation keys: server data,
// credentials, conversations, and arbitrary localStorage entries never cross
// the origin boundary during this one-time upgrade bridge.
const PREFERENCE_KEYS = new Set([
  'cc-web-settings',
  'cc-web-relay-theme',
  'cc-web-chat-view',
  'cc-web-chat-effort',
  'cc-web-splits',
  'cc-web-selection-hint',
]);
const JSON_PREFERENCE_KEYS = new Set([
  'cc-web-settings',
  'cc-web-chat-view',
  'cc-web-chat-effort',
  'cc-web-splits',
]);
const MAX_FILE_SCAN_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_VALUE_BYTES = 16 * 1024;
const MAX_STATE_BYTES = 128 * 1024;
// v1 only copied preferences. v2 additionally proves that the persistent
// defaultSession storage and HTTP cache were cleared before the new renderer
// was allowed to load.
const COMPLETE_MARKER = 'legacy-renderer-storage-v2.json';
const PENDING_STATE = 'legacy-renderer-storage-v2.pending.json';
const MIGRATION_SCHEMA_VERSION = 2;
const LEGACY_STORAGE_TYPES = Object.freeze([
  'filesystem',
  'indexdb',
  'localstorage',
  'shadercache',
  'serviceworkers',
  'cachestorage',
]);
const LEGACY_DATA_TYPES = Object.freeze([
  'backgroundFetch',
  'cache',
  'downloads',
  'fileSystems',
  'indexedDB',
  'localStorage',
  'serviceWorkers',
  'webSQL',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parsedJsonObject(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) return null;
  try {
    const parsed = JSON.parse(value);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function copyScalar(result, source, key, type) {
  if (typeof source[key] === type) result[key] = source[key];
}

function sanitizedJsonPreference(key, raw) {
  const parsed = parsedJsonObject(raw);
  if (!parsed) return null;

  if (key === 'cc-web-settings') {
    const safe = {};
    if (Number.isFinite(parsed.fontSize)) safe.fontSize = parsed.fontSize;
    if (typeof parsed.theme === 'string' && parsed.theme.length <= 64) safe.theme = parsed.theme;
    if (typeof parsed.terminalTheme === 'string' && parsed.terminalTheme.length <= 64) {
      safe.terminalTheme = parsed.terminalTheme;
    }
    if (typeof parsed.terminalFontFamily === 'string' && parsed.terminalFontFamily.length <= 64) {
      safe.terminalFontFamily = parsed.terminalFontFamily;
    }
    if (isObject(parsed.notifications)) {
      const notifications = {};
      for (const field of ['enabled', 'finished', 'failed', 'approval', 'question', 'details']) {
        copyScalar(notifications, parsed.notifications, field, 'boolean');
      }
      safe.notifications = notifications;
    }
    // In old builds this grant lived in the renderer. It is server-owned now
    // and must never be revived or copied through a process argument.
    return JSON.stringify(safe);
  }

  if (key === 'cc-web-chat-effort') {
    const safe = {};
    for (const [runtime, level] of Object.entries(parsed)) {
      if (Object.keys(safe).length >= 32) break;
      if (!/^[a-z][a-z0-9_-]{0,31}$/.test(runtime)) continue;
      if (typeof level !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(level)) continue;
      safe[runtime] = level;
    }
    return JSON.stringify(safe);
  }

  if (key === 'cc-web-splits') {
    const safe = {};
    if (Number.isFinite(parsed.dividerPosition)) safe.dividerPosition = parsed.dividerPosition;
    // Session assignments are data, not a display setting, and the current
    // split restorer intentionally does not reuse them across controller IDs.
    return JSON.stringify(safe);
  }

  const safe = {};
  for (const field of [
    'panelOpen', 'indexOpen', 'terminalOpen', 'showThinking', 'showToolCalls',
    'showUsage', 'showPlan',
  ]) copyScalar(safe, parsed, field, 'boolean');
  for (const field of ['panelWidth', 'terminalHeight']) {
    if (Number.isFinite(parsed[field])) safe[field] = parsed[field];
  }
  for (const field of ['panelTab', 'proseWidth', 'density', 'activityFilter']) {
    if (typeof parsed[field] === 'string' && parsed[field].length <= 64) safe[field] = parsed[field];
  }
  if (isObject(parsed.panels)) {
    const panels = {};
    for (const [panel, enabled] of Object.entries(parsed.panels)) {
      if (/^[a-z][a-z0-9_-]{0,31}$/.test(panel) && typeof enabled === 'boolean') panels[panel] = enabled;
    }
    safe.panels = panels;
  }
  return JSON.stringify(safe);
}

function normalizedPreference(key, raw) {
  if (!PREFERENCE_KEYS.has(key) || typeof raw !== 'string') return null;
  if (key === 'cc-web-relay-theme') return raw === 'dark' || raw === 'light' ? raw : null;
  if (key === 'cc-web-selection-hint') return raw === '1' ? raw : null;
  return sanitizedJsonPreference(key, raw);
}

function sanitizedPreferences(preferences) {
  const safe = {};
  if (!isObject(preferences)) return safe;
  for (const [key, value] of Object.entries(preferences)) {
    const normalized = normalizedPreference(key, value);
    if (normalized !== null) safe[key] = normalized;
  }
  return safe;
}

function legacyOriginPrecedes(bytes, offset) {
  const start = Math.max(0, offset - 512);
  return /http:\/\/127\.0\.0\.1:\d{1,5}(?:\0|[^\w])/i.test(
    bytes.subarray(start, offset).toString('latin1'),
  );
}

function jsonObjectAfter(bytes, offset) {
  const end = Math.min(bytes.length, offset + MAX_VALUE_BYTES);
  let start = -1;
  for (let index = offset; index < end; index += 1) {
    if (bytes[index] === 0x7b) { start = index; break; } // {
  }
  if (start < 0) return null;

  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < end; index += 1) {
    const byte = bytes[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (byte === 0x5c) escaped = true;
      else if (byte === 0x22) quoted = false;
      continue;
    }
    if (byte === 0x22) quoted = true;
    else if (byte === 0x7b) depth += 1;
    else if (byte === 0x7d && --depth === 0) return bytes.subarray(start, index + 1).toString('utf8');
  }
  return null;
}

function literalAfter(bytes, offset, key) {
  const end = Math.min(bytes.length, offset + 64);
  const tail = bytes.subarray(offset, end).toString('latin1');
  const allowed = key === 'cc-web-selection-hint' ? '(1)' : '(dark|light)';
  const match = new RegExp(`(?:\\0|\\x01)*${allowed}(?:\\0|[^a-z0-9])`, 'i').exec(tail);
  return match ? match[1].toLowerCase() : null;
}

function extractFilePreferences(bytes) {
  const result = {};
  for (const key of PREFERENCE_KEYS) {
    const needle = Buffer.from(key, 'utf8');
    let offset = 0;
    while (offset < bytes.length) {
      const found = bytes.indexOf(needle, offset);
      if (found < 0) break;
      offset = found + needle.length;
      if (!legacyOriginPrecedes(bytes, found)) continue;
      const raw = !JSON_PREFERENCE_KEYS.has(key)
        ? literalAfter(bytes, offset, key)
        : jsonObjectAfter(bytes, offset);
      const value = normalizedPreference(key, raw);
      if (value !== null) result[key] = value;
    }
  }
  return result;
}

function readLegacyRendererPreferences(userData, options = {}) {
  const filesystem = options.fs || fs;
  const leveldb = path.join(userData, 'Local Storage', 'leveldb');
  let files;
  try {
    files = filesystem.readdirSync(leveldb, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(?:ldb|log)$/i.test(entry.name))
      .map((entry) => {
        const filename = path.join(leveldb, entry.name);
        let mtimeMs = 0;
        let size = 0;
        try {
          const stat = filesystem.statSync(filename);
          mtimeMs = stat.mtimeMs;
          size = stat.size;
        } catch { /* ignore unreadable file */ }
        return { filename, mtimeMs, size };
      })
      .sort((left, right) => left.mtimeMs - right.mtimeMs);
  } catch {
    return {};
  }

  let remaining = MAX_TOTAL_SCAN_BYTES;
  const selected = [];
  for (let index = files.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const file = files[index];
    const scanBytes = Math.min(file.size, MAX_FILE_SCAN_BYTES, remaining);
    if (scanBytes <= 0) continue;
    selected.unshift({ ...file, scanBytes });
    remaining -= scanBytes;
  }

  const result = {};
  for (const file of selected) {
    let bytes;
    try {
      if (file.size <= file.scanBytes) {
        bytes = filesystem.readFileSync(file.filename);
      } else {
        // Do not discard a compacted store just because it grew past the
        // bound. Sample both ends within one aggregate budget; current LevelDB
        // records normally land at the tail while origin metadata also occurs
        // near the beginning.
        const firstSize = Math.floor(file.scanBytes / 2);
        const lastSize = file.scanBytes - firstSize;
        const first = Buffer.alloc(firstSize);
        const last = Buffer.alloc(lastSize);
        const descriptor = filesystem.openSync(file.filename, 'r');
        try {
          filesystem.readSync(descriptor, first, 0, first.length, 0);
          filesystem.readSync(descriptor, last, 0, last.length, file.size - last.length);
        } finally {
          filesystem.closeSync(descriptor);
        }
        bytes = Buffer.concat([first, last]);
      }
    } catch {
      continue;
    }
    Object.assign(result, extractFilePreferences(bytes));
  }
  return result;
}

function migrationFiles(userData) {
  const directory = path.join(userData, 'controller');
  return {
    directory,
    complete: path.join(directory, COMPLETE_MARKER),
    pending: path.join(directory, PENDING_STATE),
  };
}

function readMigrationState(filename, filesystem) {
  let stat;
  try {
    stat = filesystem.lstatSync(filename);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > MAX_STATE_BYTES) {
    const error = new Error(`Unsafe legacy renderer migration state: ${filename}`);
    error.code = 'LEGACY_RENDERER_MIGRATION_STATE_INVALID';
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(filesystem.readFileSync(filename, 'utf8'));
  } catch (cause) {
    const error = new Error(`Invalid legacy renderer migration state: ${filename}`, { cause });
    error.code = 'LEGACY_RENDERER_MIGRATION_STATE_INVALID';
    throw error;
  }
  if (!isObject(parsed) || parsed.schemaVersion !== MIGRATION_SCHEMA_VERSION) {
    const error = new Error(`Unsupported legacy renderer migration state: ${filename}`);
    error.code = 'LEGACY_RENDERER_MIGRATION_STATE_INVALID';
    throw error;
  }
  return parsed;
}

function syncDirectory(directory, filesystem) {
  if (typeof filesystem.fsyncSync !== 'function' || typeof filesystem.openSync !== 'function') return;
  let descriptor = null;
  try {
    descriptor = filesystem.openSync(directory, 'r');
    filesystem.fsyncSync(descriptor);
  } catch {
    // Directory fsync is not available on every Electron platform. The file
    // itself is still fsynced before the atomic rename.
  } finally {
    if (descriptor !== null) {
      try { filesystem.closeSync(descriptor); } catch { /* best effort */ }
    }
  }
}

function writeMigrationState(filename, value, filesystem) {
  const directory = path.dirname(filename);
  filesystem.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let descriptor = null;
  try {
    descriptor = filesystem.openSync(temporary, 'wx', 0o600);
    filesystem.writeFileSync(descriptor, `${JSON.stringify(value)}\n`, 'utf8');
    filesystem.fsyncSync?.(descriptor);
    filesystem.closeSync(descriptor);
    descriptor = null;
    filesystem.renameSync(temporary, filename);
    filesystem.chmodSync(filename, 0o600);
    syncDirectory(directory, filesystem);
  } finally {
    if (descriptor !== null) {
      try { filesystem.closeSync(descriptor); } catch { /* best effort */ }
    }
    try { filesystem.unlinkSync(temporary); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function prepareLegacyRendererPreferences(userData, options = {}) {
  const filesystem = options.fs || fs;
  const files = migrationFiles(userData);
  const complete = readMigrationState(files.complete, filesystem);
  if (complete) {
    if (complete.status !== 'complete') {
      const error = new Error('Legacy renderer completion marker is not complete.');
      error.code = 'LEGACY_RENDERER_MIGRATION_STATE_INVALID';
      throw error;
    }
    return { pending: false, preferences: {} };
  }

  const staged = readMigrationState(files.pending, filesystem);
  if (staged) {
    if (staged.status !== 'pending' || !isObject(staged.preferences)) {
      const error = new Error('Legacy renderer pending state is invalid.');
      error.code = 'LEGACY_RENDERER_MIGRATION_STATE_INVALID';
      throw error;
    }
    return { pending: true, preferences: sanitizedPreferences(staged.preferences) };
  }

  const preferences = sanitizedPreferences(readLegacyRendererPreferences(userData, { fs: filesystem }));
  // The source LevelDB is about to be deleted. Persist only the whitelist so a
  // crash or renderer-load failure cannot lose the settings on the retry.
  writeMigrationState(files.pending, {
    schemaVersion: MIGRATION_SCHEMA_VERSION,
    status: 'pending',
    preparedAt: new Date().toISOString(),
    preferences,
  }, filesystem);
  return { pending: true, preferences };
}

function completeLegacyRendererPreferences(userData, options = {}) {
  const filesystem = options.fs || fs;
  const files = migrationFiles(userData);
  try {
    const existing = readMigrationState(files.complete, filesystem);
    if (!existing) {
      writeMigrationState(files.complete, {
        schemaVersion: MIGRATION_SCHEMA_VERSION,
        status: 'complete',
        completedAt: new Date().toISOString(),
      }, filesystem);
    } else if (existing.status !== 'complete') {
      return false;
    }
    try { filesystem.unlinkSync(files.pending); } catch (error) {
      if (error?.code !== 'ENOENT') {
        // The durable complete marker is authoritative; a leftover staged file
        // is ignored next launch and contains only whitelisted preferences.
      }
    }
    return true;
  } catch {
    // A read-only profile retries the idempotent cleanup next launch. Never
    // claim completion unless the marker is durable.
    return false;
  }
}

async function clearLegacyRendererStorage(electronSession) {
  if (!electronSession || typeof electronSession.clearStorageData !== 'function'
    || typeof electronSession.clearCache !== 'function') {
    const error = new TypeError('Electron defaultSession storage cleanup is unavailable.');
    error.code = 'LEGACY_RENDERER_CLEANUP_UNAVAILABLE';
    throw error;
  }

  // This function receives only session.defaultSession. Server OAuth sessions
  // live in their own persist:* partitions and are never enumerated here.
  // Cookies and the HTTP auth cache are intentionally absent from both calls.
  // sessionStorage is process-memory scoped; before the first BrowserWindow is
  // created there is no live renderer storage to retain across this restart.
  if (typeof electronSession.clearData === 'function') {
    await electronSession.clearData({ dataTypes: [...LEGACY_DATA_TYPES] });
  }
  await electronSession.clearStorageData({ storages: [...LEGACY_STORAGE_TYPES] });
  await electronSession.clearCache();
}

async function migrateLegacyRendererStorage(userData, electronSessions, loadRenderer, options = {}) {
  if (typeof loadRenderer !== 'function') throw new TypeError('A renderer loader is required.');
  const prepared = prepareLegacyRendererPreferences(userData, options);
  // Select the default partition here so callers cannot accidentally enumerate
  // or purge the persist:* partitions used for remote-server OAuth.
  if (prepared.pending) await clearLegacyRendererStorage(electronSessions?.defaultSession);
  const result = await loadRenderer(prepared.preferences);
  if (prepared.pending) completeLegacyRendererPreferences(userData, options);
  return result;
}

function rendererPreferenceArgument(preferences) {
  const safe = sanitizedPreferences(preferences);
  if (Object.keys(safe).length === 0) return null;
  return `--cc-web-legacy-preferences=${Buffer.from(JSON.stringify(safe), 'utf8').toString('base64url')}`;
}

module.exports = {
  clearLegacyRendererStorage,
  completeLegacyRendererPreferences,
  extractFilePreferences,
  migrateLegacyRendererStorage,
  prepareLegacyRendererPreferences,
  readLegacyRendererPreferences,
  rendererPreferenceArgument,
};
