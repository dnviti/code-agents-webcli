'use strict';

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
const COMPLETE_MARKER = 'legacy-renderer-preferences-v1.json';

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

function prepareLegacyRendererPreferences(userData, options = {}) {
  const filesystem = options.fs || fs;
  const marker = path.join(userData, 'controller', COMPLETE_MARKER);
  try {
    if (filesystem.existsSync(marker)) return { pending: false, preferences: {} };
  } catch {
    return { pending: false, preferences: {} };
  }

  return { pending: true, preferences: readLegacyRendererPreferences(userData, { fs: filesystem }) };
}

function completeLegacyRendererPreferences(userData, options = {}) {
  const filesystem = options.fs || fs;
  const marker = path.join(userData, 'controller', COMPLETE_MARKER);
  // The old origin is no longer addressable. Mark even an empty attempt so a
  // deliberately cleared new preference cannot be silently resurrected later.
  try {
    filesystem.mkdirSync(path.dirname(marker), { recursive: true, mode: 0o700 });
    filesystem.writeFileSync(marker, `${JSON.stringify({ completedAt: new Date().toISOString() })}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    filesystem.chmodSync(marker, 0o600);
  } catch {
    // A read-only profile may scan again next launch; it is still bounded and
    // cannot alter existing values because the preload fills only absent keys.
  }
}

function takeLegacyRendererPreferences(userData, options = {}) {
  const prepared = prepareLegacyRendererPreferences(userData, options);
  if (prepared.pending) completeLegacyRendererPreferences(userData, options);
  const preferences = prepared.preferences;
  return preferences;
}

function rendererPreferenceArgument(preferences) {
  const safe = {};
  for (const [key, value] of Object.entries(preferences || {})) {
    if (normalizedPreference(key, value) !== null) safe[key] = value;
  }
  if (Object.keys(safe).length === 0) return null;
  return `--cc-web-legacy-preferences=${Buffer.from(JSON.stringify(safe), 'utf8').toString('base64url')}`;
}

module.exports = {
  completeLegacyRendererPreferences,
  extractFilePreferences,
  prepareLegacyRendererPreferences,
  readLegacyRendererPreferences,
  rendererPreferenceArgument,
  takeLegacyRendererPreferences,
};
