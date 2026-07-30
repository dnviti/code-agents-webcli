const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// This file remembers what to open the *next* conversation at, per runtime, and
// it reads that back out of localStorage — which is not a trusted input. It
// survives downgrades, hand edits, and a tab that died halfway through a write,
// so every assertion here is really about one of two rules: two runtimes never
// share a level, and nothing that comes out of storage is believed on sight.

const ROOT = path.join(__dirname, '..');
const STORAGE_KEY = 'cc-web-chat-effort';

let mod;
let bundle;

/** The backing map of the fake localStorage, cleared before every test. */
let stored;
/** Flipped on to make `setItem` fail the way a full quota or private mode does. */
let writesFail;
let originalStorage;

function installStorage() {
  global.localStorage = {
    getItem: (key) => (stored.has(key) ? stored.get(key) : null),
    setItem: (key, value) => {
      if (writesFail) throw new Error('QuotaExceededError');
      stored.set(key, String(value));
    },
    removeItem: (key) => { stored.delete(key); },
  };
}

/** Put a literal string in storage, the way a downgrade or a hand edit would. */
function seedRaw(raw) {
  stored.set(STORAGE_KEY, raw);
}

function seed(value) {
  seedRaw(JSON.stringify(value));
}

/** What actually made it to disk, as opposed to what the call answered with. */
function readBack() {
  return JSON.parse(stored.get(STORAGE_KEY));
}

before(function () {
  this.timeout(60000);
  const contents = [
    `export { loadEffortPreferences, rememberEffort, normalizeEffortPreferences } from ${JSON.stringify(path.join(ROOT, 'src/client/chat/effort-preference'))};`,
  ].join('\n');

  bundle = path.join(os.tmpdir(), `chat-effort-preference-${process.pid}.js`);
  require('esbuild').buildSync({
    stdin: { contents, resolveDir: ROOT, loader: 'ts', sourcefile: 'chat-effort-preference.ts' },
    bundle: true,
    outfile: bundle,
    format: 'cjs',
    platform: 'node',
    target: ['node20'],
    logLevel: 'silent',
  });
  originalStorage = global.localStorage;
  mod = require(bundle);
});

after(function () {
  if (bundle) fs.rmSync(bundle, { force: true });
  // Mocha runs every file in one process, so a fake storage left behind would
  // tell anything loaded later that this is a browser.
  if (originalStorage === undefined) delete global.localStorage;
  else global.localStorage = originalStorage;
});

// Re-stubbed per test, not just once in `before`: another suite in this run
// deletes `global.localStorage` in a ROOT afterEach, which mocha runs after
// every test in the whole process — including these ones.
beforeEach(function () {
  stored = new Map();
  writesFail = false;
  installStorage();
});

describe('the remembered effort level', function () {
  it('comes back for the runtime it was chosen for and for no other', function () {
    mod.rememberEffort('claude', 'xhigh');
    const prefs = mod.loadEffortPreferences();
    assert.strictEqual(prefs.claude, 'xhigh');
    assert.strictEqual(prefs.kimi, undefined, 'kimi was never asked about and must not inherit a level');
  });

  // The reason the whole thing is keyed by runtime: `xhigh` is a rung on
  // claude's ladder and means nothing on kimi's, whose ladder is off and on.
  // Somebody who runs claude hard and kimi cheaply must get both back.
  it('keeps two runtimes apart, because their ladders are not the same ladder', function () {
    mod.rememberEffort('claude', 'xhigh');
    mod.rememberEffort('kimi', 'on');
    assert.deepStrictEqual(mod.loadEffortPreferences(), { claude: 'xhigh', kimi: 'on' });
  });

  it('keeps them apart in whichever order they were chosen', function () {
    mod.rememberEffort('kimi', 'on');
    mod.rememberEffort('claude', 'xhigh');
    const prefs = mod.loadEffortPreferences();
    assert.strictEqual(prefs.claude, 'xhigh');
    assert.strictEqual(prefs.kimi, 'on');
  });

  it('changes one runtime in place instead of adding a second entry for it', function () {
    mod.rememberEffort('claude', 'low');
    mod.rememberEffort('claude', 'max');
    assert.deepStrictEqual(mod.loadEffortPreferences(), { claude: 'max' });
  });

  it('is forgotten for one runtime alone when that runtime goes back to the default', function () {
    mod.rememberEffort('claude', 'xhigh');
    mod.rememberEffort('kimi', 'on');

    assert.deepStrictEqual(mod.rememberEffort('claude', null), { kimi: 'on' });
    assert.deepStrictEqual(mod.loadEffortPreferences(), { kimi: 'on' }, 'kimi was not the one cleared');
  });

  it('shrugs at being told to forget a runtime it never remembered', function () {
    mod.rememberEffort('claude', 'xhigh');
    assert.deepStrictEqual(mod.rememberEffort('grok', null), { claude: 'xhigh' });
  });

  it('starts empty, which is the state every browser opens in', function () {
    assert.deepStrictEqual(mod.loadEffortPreferences(), {});
  });
});

describe('storage is never trusted', function () {
  it('reads a stored string as nothing remembered rather than throwing', function () {
    seed('xhigh');
    assert.deepStrictEqual(mod.loadEffortPreferences(), {});
  });

  it('reads a stored array as nothing remembered rather than throwing', function () {
    seed(['claude', 'xhigh']);
    assert.deepStrictEqual(mod.loadEffortPreferences(), {});
  });

  it('reads a stored null as nothing remembered rather than throwing', function () {
    seed(null);
    assert.deepStrictEqual(mod.loadEffortPreferences(), {});
  });

  it('reads a stored number as nothing remembered rather than throwing', function () {
    seed(7);
    assert.deepStrictEqual(mod.loadEffortPreferences(), {});
  });

  it('reads unparseable storage as nothing remembered rather than throwing', function () {
    seedRaw('{"claude": "xhigh"'); // a tab that died mid-write
    assert.deepStrictEqual(mod.loadEffortPreferences(), {});
  });

  it('writes over unparseable storage instead of being stuck behind it forever', function () {
    seedRaw('not json at all');
    assert.deepStrictEqual(mod.rememberEffort('claude', 'max'), { claude: 'max' });
    assert.deepStrictEqual(mod.loadEffortPreferences(), { claude: 'max' });
  });

  // The rule the normaliser is written around: entries are judged one at a
  // time, never wholesale. A single junk key is exactly what a downgrade or a
  // hand edit leaves behind, and losing the other five runtimes over it would
  // be a far bigger loss than the one bad entry it was meant to fix.
  it('drops one bad entry without costing the good ones', function () {
    seed({ claude: 'xhigh', kimi: 42, 'BAD KEY': 'on', omp: 'max' });
    assert.deepStrictEqual(mod.loadEffortPreferences(), { claude: 'xhigh', omp: 'max' });
  });

  it('drops a runtime key that is not a short lower-case token', function () {
    seed({ 'BAD KEY': 'on', '9lives': 'on', '': 'on', 'ok-runtime': 'on' });
    assert.deepStrictEqual(mod.loadEffortPreferences(), { 'ok-runtime': 'on' });
  });

  // The same shape is enforced on the server before it will store a level. It
  // is restated here because a stale storage entry must not be able to put a
  // value into the picker that the server would then turn around and refuse —
  // that reads as a control that does nothing, rather than as the bad data it
  // is.
  it('drops a value that is not a short lower-case token', function () {
    seed({
      newline: 'high\nlow',
      trailing: 'high\n',
      spaced: 'very high',
      punctuated: 'high;rm -rf /',
      long: 'a'.repeat(200),
      shouty: 'XHIGH',
      numeric: '3',
      claude: 'xhigh',
    });
    assert.deepStrictEqual(mod.loadEffortPreferences(), { claude: 'xhigh' });
  });

  it('drops a value that is not a string at all', function () {
    seed({ a: 42, b: null, c: true, d: ['high'], e: { level: 'high' }, claude: 'xhigh' });
    assert.deepStrictEqual(mod.loadEffortPreferences(), { claude: 'xhigh' });
  });

  it('keeps the levels the ladders actually use', function () {
    const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'on'];
    const raw = {};
    levels.forEach((level, i) => { raw[`r${i}`] = level; });
    assert.deepStrictEqual(Object.values(mod.normalizeEffortPreferences(raw)), levels);
  });

  it('stops at thirty-two runtimes rather than growing without bound', function () {
    const raw = {};
    for (let i = 0; i < 40; i += 1) raw[`r${i}`] = 'high';
    seed(raw);

    assert.strictEqual(Object.keys(mod.loadEffortPreferences()).length, 32);
    mod.rememberEffort('claude', 'max');
    assert.strictEqual(Object.keys(readBack()).length, 32, 'the oversized set is trimmed on the way back to disk');
  });

  it('normalises anything at all without throwing', function () {
    for (const raw of [undefined, null, 0, '', 'x', [], [1, 2], true, () => {}]) {
      assert.deepStrictEqual(mod.normalizeEffortPreferences(raw), {}, `normalising ${String(raw)}`);
    }
  });
});

describe('remembering a level', function () {
  it('answers with what would survive a reload, not with what it was handed', function () {
    seed({ claude: 'xhigh', kimi: 42 });
    // The junk `kimi` entry came out of storage and must not come back out of
    // the call either: a caller that publishes the answer would otherwise hold
    // a preference that vanishes on the next load.
    assert.deepStrictEqual(mod.rememberEffort('omp', 'max'), { claude: 'xhigh', omp: 'max' });
    assert.deepStrictEqual(readBack(), { claude: 'xhigh', omp: 'max' });
  });

  it('does not answer with a level of its own that would not survive a reload', function () {
    assert.deepStrictEqual(mod.rememberEffort('claude', 'NOT A LEVEL'), {});
    assert.deepStrictEqual(mod.loadEffortPreferences(), {});
  });

  it('does not answer with a runtime of its own that would not survive a reload', function () {
    assert.deepStrictEqual(mod.rememberEffort('BAD RUNTIME', 'max'), {});
    assert.deepStrictEqual(mod.loadEffortPreferences(), {});
  });

  // Quota, private browsing, a storage-blocking extension. The choice has
  // already been made and already applies to this conversation; refusing it
  // over a write that failed would help nobody. It simply will not be there
  // after a reload.
  it('applies to this session even when the write fails', function () {
    writesFail = true;
    let answer;
    assert.doesNotThrow(() => { answer = mod.rememberEffort('claude', 'xhigh'); });
    assert.deepStrictEqual(answer, { claude: 'xhigh' }, 'this session still gets the level it chose');
    assert.strictEqual(stored.has(STORAGE_KEY), false, 'and nothing reached storage to survive a reload');
  });

  it('does not throw when clearing fails to write either', function () {
    mod.rememberEffort('claude', 'xhigh');
    writesFail = true;
    assert.doesNotThrow(() => { mod.rememberEffort('claude', null); });
  });

  it('stores under the one key the rest of the app reads', function () {
    mod.rememberEffort('claude', 'xhigh');
    assert.deepStrictEqual([...stored.keys()], [STORAGE_KEY]);
  });
});
