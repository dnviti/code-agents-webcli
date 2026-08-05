'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  clearLegacyRendererStorage,
  completeLegacyRendererPreferences,
  extractFilePreferences,
  migrateLegacyRendererStorage,
  prepareLegacyRendererPreferences,
  readLegacyRendererPreferences,
  rendererPreferenceArgument,
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

  it('uses the newest readable LevelDB file and stages a one-time migration', function () {
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
      const prepared = prepareLegacyRendererPreferences(root);
      assert.strictEqual(prepared.pending, true);
      assert.deepStrictEqual(prepared.preferences, { 'cc-web-relay-theme': 'light' });
      assert.strictEqual(completeLegacyRendererPreferences(root), true);
      assert.deepStrictEqual(prepareLegacyRendererPreferences(root), { pending: false, preferences: {} });
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
      assert.strictEqual(completeLegacyRendererPreferences(root), true);
      assert.deepStrictEqual(prepareLegacyRendererPreferences(root), { pending: false, preferences: {} });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not mistake the old preference-only marker for completed storage cleanup', function () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-legacy-v1-marker-'));
    const controller = path.join(root, 'controller');
    fs.mkdirSync(controller, { recursive: true });
    fs.writeFileSync(
      path.join(controller, 'legacy-renderer-preferences-v1.json'),
      `${JSON.stringify({ completedAt: new Date().toISOString() })}\n`,
    );
    try {
      assert.deepStrictEqual(prepareLegacyRendererPreferences(root), { pending: true, preferences: {} });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('passes only validated values to the isolated preload', function () {
    const argument = rendererPreferenceArgument({
      'cc-web-relay-theme': 'dark',
      'cc-web-settings': JSON.stringify({ theme: 'github-dark', accessToken: 'must-not-cross' }),
      token: 'must-not-cross',
    });
    assert.ok(argument);
    const encoded = argument.slice('--cc-web-legacy-preferences='.length);
    assert.deepStrictEqual(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')), {
      'cc-web-relay-theme': 'dark',
      'cc-web-settings': JSON.stringify({ theme: 'github-dark' }),
    });
  });

  it('clears only non-auth data from the supplied Electron session', async function () {
    const calls = [];
    const defaultSession = {
      async clearData(options) { calls.push(['data', options]); },
      async clearStorageData(options) { calls.push(['storage', options]); },
      async clearCache() { calls.push(['cache']); },
      async clearAuthCache() { throw new Error('auth cache must be preserved'); },
      cookies: { async remove() { throw new Error('cookies must be preserved'); } },
    };

    await clearLegacyRendererStorage(defaultSession);
    assert.deepStrictEqual(calls.map(([name]) => name), ['data', 'storage', 'cache']);
    assert.ok(calls[0][1].dataTypes.includes('localStorage'));
    assert.ok(calls[0][1].dataTypes.includes('cache'));
    assert.ok(calls[0][1].dataTypes.includes('indexedDB'));
    assert.ok(calls[0][1].dataTypes.includes('serviceWorkers'));
    assert.ok(calls[0][1].dataTypes.includes('downloads'));
    assert.ok(!calls[0][1].dataTypes.includes('cookies'));
    assert.ok(calls[1][1].storages.includes('localstorage'));
    assert.ok(calls[1][1].storages.includes('cachestorage'));
    assert.ok(!calls[1][1].storages.includes('cookies'));
  });

  it('stages the whitelist, clears defaultSession before load, and leaves remote partitions untouched', async function () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-legacy-cleanup-'));
    const leveldb = path.join(root, 'Local Storage', 'leveldb');
    fs.mkdirSync(leveldb, { recursive: true });
    fs.writeFileSync(path.join(leveldb, '000001.ldb'), Buffer.concat([
      legacyRecord('cc-web-relay-theme', 'dark'),
      legacyRecord('cc-web-settings', JSON.stringify({ theme: 'github-dark', accessToken: 'secret' })),
      legacyRecord('authorization', 'never-copy-this'),
    ]));
    const order = [];
    const defaultSession = {
      async clearData() { order.push('clear-data'); },
      async clearStorageData() {
        order.push('clear-storage');
        fs.rmSync(path.join(root, 'Local Storage'), { recursive: true, force: true });
      },
      async clearCache() { order.push('clear-cache'); },
    };
    const remoteSession = {
      calls: 0,
      async clearData() { this.calls += 1; },
      async clearStorageData() { this.calls += 1; },
      async clearCache() { this.calls += 1; },
    };

    try {
      await migrateLegacyRendererStorage(root, {
        defaultSession,
        fromPartition() {
          remoteSession.calls += 1;
          return remoteSession;
        },
      }, async (preferences) => {
        order.push('load');
        assert.deepStrictEqual(preferences, {
          'cc-web-relay-theme': 'dark',
          'cc-web-settings': JSON.stringify({ theme: 'github-dark' }),
        });
        assert.strictEqual(fs.existsSync(path.join(root, 'Local Storage')), false);
      });
      assert.deepStrictEqual(order, ['clear-data', 'clear-storage', 'clear-cache', 'load']);
      assert.strictEqual(remoteSession.calls, 0);
      assert.deepStrictEqual(prepareLegacyRendererPreferences(root), { pending: false, preferences: {} });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not mark complete when Electron cleanup fails', async function () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-legacy-cleanup-fail-'));
    const leveldb = path.join(root, 'Local Storage', 'leveldb');
    fs.mkdirSync(leveldb, { recursive: true });
    fs.writeFileSync(path.join(leveldb, '000001.ldb'), legacyRecord('cc-web-relay-theme', 'light'));
    let loaded = false;
    const failingSession = {
      async clearData() {},
      async clearStorageData() { throw new Error('cleanup failed'); },
      async clearCache() {},
    };
    try {
      await assert.rejects(
        migrateLegacyRendererStorage(
          root,
          { defaultSession: failingSession },
          async () => { loaded = true; },
        ),
        /cleanup failed/,
      );
      assert.strictEqual(loaded, false);
      assert.deepStrictEqual(prepareLegacyRendererPreferences(root), {
        pending: true,
        preferences: { 'cc-web-relay-theme': 'light' },
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('retains staged preferences and retries when renderer loading fails after cleanup', async function () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-legacy-load-fail-'));
    const leveldb = path.join(root, 'Local Storage', 'leveldb');
    fs.mkdirSync(leveldb, { recursive: true });
    fs.writeFileSync(path.join(leveldb, '000001.ldb'), legacyRecord('cc-web-relay-theme', 'dark'));
    const electronSession = {
      async clearData() {},
      async clearStorageData() {
        fs.rmSync(path.join(root, 'Local Storage'), { recursive: true, force: true });
      },
      async clearCache() {},
    };
    try {
      await assert.rejects(
        migrateLegacyRendererStorage(root, { defaultSession: electronSession }, async () => {
          throw new Error('renderer load failed');
        }),
        /renderer load failed/,
      );
      assert.deepStrictEqual(prepareLegacyRendererPreferences(root), {
        pending: true,
        preferences: { 'cc-web-relay-theme': 'dark' },
      });

      let retriedPreferences = null;
      await migrateLegacyRendererStorage(root, { defaultSession: electronSession }, async (preferences) => {
        retriedPreferences = preferences;
      });
      assert.deepStrictEqual(retriedPreferences, { 'cc-web-relay-theme': 'dark' });
      assert.deepStrictEqual(prepareLegacyRendererPreferences(root), { pending: false, preferences: {} });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
