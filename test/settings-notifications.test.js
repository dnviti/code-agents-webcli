const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// The notification choices, from the dialog to storage and back.
//
// One of these assertions is guarding a trap rather than a feature. `saveSettings`
// does not write the object it is handed: it rebuilds a literal, field by field,
// so that a value the dialog never validated cannot reach storage. A setting
// added to the type, to the defaults and to `loadSettings` but forgotten in that
// literal behaves perfectly — until the first time the user saves anything at
// all, at which point their choice is dropped and cannot be made again. Nothing
// else in the suite would notice.
//
// The rest is about what an existing installation sees. Every browser that has
// ever opened this app has a settings blob with no `notifications` key in it,
// and reading that absence as "switched off" would ship the feature dark to
// exactly the people who have been using it longest.

const ROOT = path.join(__dirname, '..');

let mod;

const STUBBED = ['window', 'document', 'localStorage'];
const originals = {};
let stored;

function installStubs() {
  global.window = { addEventListener() {}, matchMedia: undefined };
  global.document = {
    documentElement: {
      setAttribute() {},
      classList: { toggle() {} },
      style: { setProperty() {} },
    },
    querySelector: () => null,
    addEventListener() {},
  };
  global.localStorage = {
    getItem: (key) => (stored.has(key) ? stored.get(key) : null),
    setItem: (key, value) => { stored.set(key, String(value)); },
    removeItem: (key) => { stored.delete(key); },
  };
}

/** The narrowest App `applySettings` reaches for; none of it is under test. */
function fakeApp() {
  return {
    terminal: null,
    terminalController: null,
    splitContainer: null,
    fitTerminal() {},
  };
}

function write(settings) {
  stored.set('cc-web-settings', JSON.stringify(settings));
}

describe('the notification choices, and whether they survive', function () {
  before(function () {
    this.timeout(60000);
    for (const name of STUBBED) originals[name] = global[name];
    stored = new Map();
    installStubs();

    const contents = [
      `export * from ${JSON.stringify(path.join(ROOT, 'src/client/ui/settings'))};`,
      `export { shellStore } from ${JSON.stringify(path.join(ROOT, 'src/client/shell/store'))};`,
    ].join('\n');

    const out = path.join(os.tmpdir(), `settings-notifications-${process.pid}.js`);
    require('esbuild').buildSync({
      stdin: { contents, resolveDir: ROOT, loader: 'ts', sourcefile: 'settings.ts' },
      bundle: true,
      outfile: out,
      format: 'cjs',
      platform: 'node',
      target: ['node20'],
      logLevel: 'silent',
    });
    mod = require(out);
    mod.__file = out;
  });

  after(function () {
    if (mod && mod.__file) fs.rmSync(mod.__file, { force: true });
    for (const name of STUBBED) {
      if (originals[name] === undefined) delete global[name];
      else global[name] = originals[name];
    }
  });

  beforeEach(function () {
    stored.clear();
    installStubs();
  });

  it('starts with every kind on, so allowing notifications is the only step', function () {
    assert.deepStrictEqual(mod.loadSettings().notifications, {
      enabled: true,
      finished: true,
      failed: true,
      approval: true,
      question: true,
      details: true,
    });
  });

  it('reads a settings blob written before this feature as all on, not as silence', function () {
    write({ fontSize: 16, theme: 'github-light', terminalFontFamily: 'fira-code' });
    const settings = mod.loadSettings();
    assert.strictEqual(settings.fontSize, 16, 'the rest of the blob is untouched');
    assert.deepStrictEqual(settings.notifications, mod.DEFAULT_NOTIFICATIONS);
  });

  it('keeps a switched-off kind across a save of something else entirely', function () {
    const app = fakeApp();
    const chosen = { ...mod.DEFAULT_NOTIFICATIONS, finished: false, details: false };
    mod.saveSettings(app, { ...mod.loadSettings(), notifications: chosen });

    assert.deepStrictEqual(mod.loadSettings().notifications, chosen, 'the choice reached storage');

    // The trap: any later save rebuilds the whole object.
    mod.saveSettings(app, { ...mod.loadSettings(), fontSize: 18 });
    const after = mod.loadSettings();
    assert.strictEqual(after.fontSize, 18);
    assert.deepStrictEqual(after.notifications, chosen, 'and survived a save that was about a font');
  });

  it('takes only a literal false for an answer', function () {
    // Storage is not a trusted input — it survives downgrades and hand edits —
    // and the safe side of a notification toggle is on.
    write({ notifications: { enabled: false, finished: 'no', approval: 0 } });
    const { notifications } = mod.loadSettings();
    assert.strictEqual(notifications.enabled, false);
    assert.strictEqual(notifications.finished, true, 'a string is not a decision');
    assert.strictEqual(notifications.approval, true, 'and neither is a zero');
  });

  it('falls back to every kind on when storage cannot be read at all', function () {
    stored.set('cc-web-settings', '{not json');
    assert.deepStrictEqual(mod.loadSettings().notifications, mod.DEFAULT_NOTIFICATIONS);
  });

  it('publishes the choice to the store the notifier actually reads', function () {
    // The dialog reads storage on every render; the code that decides whether a
    // finished conversation may interrupt somebody runs on a socket message and
    // reads the store. Two readers of one choice is how a switch ends up
    // promising something other than what it does.
    const chosen = { ...mod.DEFAULT_NOTIFICATIONS, question: false };
    mod.saveSettings(fakeApp(), { ...mod.loadSettings(), notifications: chosen });
    assert.deepStrictEqual(mod.shellStore.getSnapshot().notifications, chosen);
  });
});
