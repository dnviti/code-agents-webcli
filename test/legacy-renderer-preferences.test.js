'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  completeLegacyRendererPreferences,
  extractFilePreferences,
  prepareLegacyRendererPreferences,
  readLegacyRendererPreferences,
  rendererPreferenceArgument,
  takeLegacyRendererPreferences,
} = require('../desktop/legacy-renderer-preferences.js');

function legacyRecord(key, value, port = 43123) {
  return Buffer.from(`noisehttp://127.0.0.1:${port}\0\x01${key}\0\x01${value}\0tail`, 'utf8');
}

describe('legacy Electron renderer preference migration', function () {
  it('extracts only whitelisted display preferences from a legacy loopback record', function () {
    const bytes = Buffer.concat([
      legacyRecord('cc-web-settings', JSON.stringify({ theme: 'github-light', fontSize: 17 })),
      legacyRecord('cc-web-chat-view', JSON.stringify({ density: 'compact', showThinking: false })),
      legacyRecord('cc-web-chat-effort', JSON.stringify({ claude: 'max', kimi: 'on' })),
      legacyRecord('cc-web-splits', JSON.stringify({ dividerPosition: 62, sessions: ['private-session-id'] })),
      legacyRecord('cc-web-selection-hint', '1'),
      legacyRecord('cc-web-relay-theme', 'light'),
      legacyRecord('authorization', 'never-copy-this'),
    ]);
    assert.deepStrictEqual(extractFilePreferences(bytes), {
      'cc-web-settings': JSON.stringify({ fontSize: 17, theme: 'github-light' }),
      'cc-web-chat-view': JSON.stringify({ showThinking: false, density: 'compact' }),
      'cc-web-chat-effort': JSON.stringify({ claude: 'max', kimi: 'on' }),
      'cc-web-splits': JSON.stringify({ dividerPosition: 62 }),
      'cc-web-selection-hint': '1',
      'cc-web-relay-theme': 'light',
    });
  });

  it('drops server-owned grants, session assignments, and unknown nested values', function () {
    const bytes = Buffer.concat([
      legacyRecord('cc-web-settings', JSON.stringify({
        theme: 'github-dark',
        chatBypassPermissions: true,
        accessToken: 'must-not-cross',
        notifications: { enabled: false, injected: 'secret' },
      })),
      legacyRecord('cc-web-splits', JSON.stringify({
        dividerPosition: 45,
        sessions: ['session-secret'],
      })),
      legacyRecord('cc-web-chat-effort', JSON.stringify({
        claude: 'xhigh',
        invalid: 'token with spaces',
        'bad runtime': 'max',
      })),
    ]);
    assert.deepStrictEqual(extractFilePreferences(bytes), {
      'cc-web-settings': JSON.stringify({
        theme: 'github-dark',
        notifications: { enabled: false },
      }),
      'cc-web-chat-effort': JSON.stringify({ claude: 'xhigh' }),
      'cc-web-splits': JSON.stringify({ dividerPosition: 45 }),
    });
  });

  it('ignores malformed, non-loopback, and oversized-looking values', function () {
    const bytes = Buffer.concat([
      Buffer.from('http://example.test\0\x01cc-web-relay-theme\0light'),
      legacyRecord('cc-web-settings', '{not-json'),
      legacyRecord('cc-web-relay-theme', 'purple'),
    ]);
    assert.deepStrictEqual(extractFilePreferences(bytes), {});
  });

  it('uses the newest readable LevelDB file and records a one-time migration', function () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-legacy-prefs-'));
    const leveldb = path.join(root, 'Local Storage', 'leveldb');
    fs.mkdirSync(leveldb, { recursive: true });
    const older = path.join(leveldb, '000001.ldb');
    const newer = path.join(leveldb, '000002.ldb');
    fs.writeFileSync(older, legacyRecord('cc-web-relay-theme', 'dark'));
    fs.writeFileSync(newer, legacyRecord('cc-web-relay-theme', 'light'));
    const oldTime = new Date(Date.now() - 1000);
    fs.utimesSync(older, oldTime, oldTime);
    try {
      assert.deepStrictEqual(readLegacyRendererPreferences(root), { 'cc-web-relay-theme': 'light' });
      assert.deepStrictEqual(takeLegacyRendererPreferences(root), { 'cc-web-relay-theme': 'light' });
      assert.deepStrictEqual(takeLegacyRendererPreferences(root), {});
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('samples a legacy store larger than the old four-megabyte cutoff', function () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-legacy-prefs-large-'));
    const leveldb = path.join(root, 'Local Storage', 'leveldb');
    fs.mkdirSync(leveldb, { recursive: true });
    fs.writeFileSync(path.join(leveldb, '000001.ldb'), Buffer.concat([
      Buffer.alloc(5 * 1024 * 1024, 0x78),
      legacyRecord('cc-web-chat-effort', JSON.stringify({ claude: 'high' })),
    ]));
    try {
      assert.deepStrictEqual(readLegacyRendererPreferences(root), {
        'cc-web-chat-effort': JSON.stringify({ claude: 'high' }),
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not mark migration complete until the renderer has loaded', function () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-legacy-prefs-deferred-'));
    const leveldb = path.join(root, 'Local Storage', 'leveldb');
    fs.mkdirSync(leveldb, { recursive: true });
    fs.writeFileSync(path.join(leveldb, '000001.ldb'), legacyRecord('cc-web-relay-theme', 'dark'));
    try {
      const first = prepareLegacyRendererPreferences(root);
      assert.strictEqual(first.pending, true);
      assert.deepStrictEqual(first.preferences, { 'cc-web-relay-theme': 'dark' });
      assert.strictEqual(prepareLegacyRendererPreferences(root).pending, true, 'a failed startup must retry');
      completeLegacyRendererPreferences(root);
      assert.deepStrictEqual(prepareLegacyRendererPreferences(root), { pending: false, preferences: {} });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('passes only validated values to the isolated preload', function () {
    const argument = rendererPreferenceArgument({
      'cc-web-relay-theme': 'dark',
      'cc-web-settings': JSON.stringify({ theme: 'github-dark' }),
      token: 'must-not-cross',
    });
    assert.ok(argument);
    const encoded = argument.slice('--cc-web-legacy-preferences='.length);
    assert.deepStrictEqual(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')), {
      'cc-web-relay-theme': 'dark',
      'cc-web-settings': JSON.stringify({ theme: 'github-dark' }),
    });
  });
});
