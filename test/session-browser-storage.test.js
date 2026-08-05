const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function storage(entries) {
  const values = new Map(Object.entries(entries));
  return {
    values,
    get length() { return values.size; },
    key(index) { return Array.from(values.keys())[index] ?? null; },
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

describe('legacy browser session-storage cleanup', function () {
  let mod;
  let output;
  const originals = {};

  before(function () {
    for (const name of ['localStorage', 'sessionStorage']) originals[name] = global[name];
    output = path.join(os.tmpdir(), `session-browser-storage-${process.pid}.js`);
    require('esbuild').buildSync({
      entryPoints: [path.join(ROOT, 'src/client/session-browser-storage.ts')],
      bundle: true,
      outfile: output,
      format: 'cjs',
      platform: 'node',
      target: ['node20'],
      logLevel: 'silent',
    });
    mod = require(output);
  });

  after(function () {
    fs.rmSync(output, { force: true });
    for (const name of ['localStorage', 'sessionStorage']) {
      if (originals[name] === undefined) delete global[name];
      else global[name] = originals[name];
    }
  });

  it('purges session ids/content while retaining presentation-only preferences', function () {
    global.sessionStorage = storage({
      'cc-web-chat-draft:chat-a': JSON.stringify({ text: 'private draft' }),
      'cc-web-chat-terminals': JSON.stringify({ 'chat-a': ['child-a'] }),
      'cc-web-active-tab': 'chat-a',
      unrelated: 'keep',
    });
    global.localStorage = storage({
      'cc-web-active-tab': 'chat-a',
      'cc-web-closed-conversations': JSON.stringify(['chat-b']),
      'cc-web-splits': JSON.stringify({
        dividerPosition: 43,
        sessions: ['chat-a', 'chat-b'],
        activeSplitIndex: 1,
      }),
      'cc-agent-maintenance-operation:chat-a': 'operation-private',
      'cc-agent-maintenance-operation:local:launcher': 'operation-device',
      'cc-web-relay-theme': 'dark',
    });

    mod.purgeLegacySessionBrowserState();

    assert.deepStrictEqual(Object.fromEntries(global.sessionStorage.values), { unrelated: 'keep' });
    assert.strictEqual(global.localStorage.getItem('cc-web-active-tab'), null);
    assert.strictEqual(global.localStorage.getItem('cc-web-closed-conversations'), null);
    assert.strictEqual(global.localStorage.getItem('cc-agent-maintenance-operation:chat-a'), null);
    assert.strictEqual(global.localStorage.getItem('cc-agent-maintenance-operation:local:launcher'), null);
    assert.deepStrictEqual(
      JSON.parse(global.localStorage.getItem('cc-web-splits')),
      { dividerPosition: 43 },
    );
    assert.strictEqual(global.localStorage.getItem('cc-web-relay-theme'), 'dark');
  });

  it('drops malformed split state instead of preserving embedded ids', function () {
    global.sessionStorage = storage({});
    global.localStorage = storage({ 'cc-web-splits': '{not-json' });
    mod.purgeLegacySessionBrowserState();
    assert.strictEqual(global.localStorage.getItem('cc-web-splits'), null);
  });
});
