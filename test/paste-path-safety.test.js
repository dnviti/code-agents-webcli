const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  MAX_PASTE_MANIFEST_BYTES,
  PasteStore,
  sniffImageType,
  shellQuote,
  insertTextFor,
} = require('../dist/server/services/paste-store.js');

// A real 1x1 PNG. Every positive case writes actual image bytes, so a test
// cannot pass against a sniffer that accepts anything.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(64)]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'ascii'),
  Buffer.alloc(64),
]);

function bmp() {
  const body = Buffer.alloc(128);
  body.write('BM', 0, 'ascii');
  body.writeUInt32LE(128, 2);
  return body;
}

function listFiles(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

describe('sniffImageType', function () {
  const cases = [
    ['PNG', PNG, 'png'],
    ['JPEG', JPG, 'jpg'],
    ['GIF', GIF, 'gif'],
    ['WebP', WEBP, 'webp'],
    ['BMP', bmp(), 'bmp'],
    ['a shell script', Buffer.from('#!/bin/sh\nrm -rf /\n'), null],
    ['an ELF binary', Buffer.concat([Buffer.from([0x7f]), Buffer.from('ELF'), Buffer.alloc(32)]), null],
    ['HTML', Buffer.from('<!doctype html><script>alert(1)</script>'), null],
    // SVG is refused on purpose: no magic number, and it carries script.
    ['SVG with a script', Buffer.from('<svg xmlns="..."><script>alert(1)</script></svg>'), null],
    ['an empty buffer', Buffer.alloc(0), null],
    ['a truncated header', Buffer.from([0x89, 0x50]), null],
  ];

  cases.forEach(function ([label, bytes, expected]) {
    it(`classifies ${label} as ${expected ?? 'unsupported'}`, function () {
      assert.strictEqual(sniffImageType(bytes), expected);
    });
  });
});

describe('shellQuote', function () {
  const cases = [
    ['/home/u/proj/.cc-web/pasted/a.png', '/home/u/proj/.cc-web/pasted/a.png'],
    ['/home/u/my proj/a.png', "'/home/u/my proj/a.png'"],
    ["/home/u/d'q/a.png", "'/home/u/d'\\''q/a.png'"],
    ['/home/u/$HOME/a.png', "'/home/u/$HOME/a.png'"],
    ['/home/u/`id`/a.png', "'/home/u/`id`/a.png'"],
    ['/home/u/a;rm -rf ~/a.png', "'/home/u/a;rm -rf ~/a.png'"],
    ['/home/u/$(id)/a.png', "'/home/u/$(id)/a.png'"],
  ];

  cases.forEach(function ([input, expected]) {
    it(`quotes ${JSON.stringify(input)}`, function () {
      assert.strictEqual(shellQuote(input), expected);
    });
  });

  it('appends exactly one space and never a newline', function () {
    // A newline would submit the prompt, and in a bare shell it would execute
    // the path as a command.
    const text = insertTextFor('/home/u/a.png');
    assert.strictEqual(text, '/home/u/a.png ');
    assert.ok(!text.includes('\n') && !text.includes('\r'));
  });
});

describe('PasteStore path safety', function () {
  let storageDir;
  let workingDir;
  let store;

  beforeEach(function () {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-paste-store-'));
    workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-paste-wd-'));
    store = new PasteStore({ storageDir });
  });

  afterEach(function () {
    fs.rmSync(storageDir, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
  });

  const hostileIds = ['../../../../tmp/pwned', '..', '.', 'a/b', '/etc/passwd', 'spazio nel mezzo', 'nome' + String.fromCharCode(0)];

  hostileIds.forEach(function (id) {
    it(`refuses the session id ${JSON.stringify(id)}`, async function () {
      await assert.rejects(() => store.save({ id, ownerUserId: 1, workingDir }, PNG));
      // A status code alone would not prove the filesystem was untouched.
      assert.deepStrictEqual(listFiles(workingDir), []);
    });
  });

  it('refuses a non-integer owner id', async function () {
    for (const ownerUserId of [1.5, '1', NaN, null]) {
      await assert.rejects(() => store.save({ id: 'ok', ownerUserId, workingDir }, PNG));
    }
    assert.deepStrictEqual(listFiles(workingDir), []);
  });

  it('refuses to write to a filesystem root', async function () {
    await assert.rejects(() => store.save({ id: 'ok', ownerUserId: 1, workingDir: '/' }, PNG));
  });

  it('writes only inside the working directory', async function () {
    const result = await store.save({ id: 'ok', ownerUserId: 1, workingDir }, PNG);

    const real = fs.realpathSync(workingDir);
    assert.ok(result.absolutePath.startsWith(real + path.sep));
    for (const file of listFiles(workingDir)) {
      assert.ok(fs.realpathSync(file).startsWith(real + path.sep));
    }
  });

  it('stores the bytes verbatim with a restrictive mode', async function () {
    const result = await store.save({ id: 'ok', ownerUserId: 1, workingDir }, PNG);
    assert.deepStrictEqual(fs.readFileSync(result.absolutePath), PNG);
    assert.strictEqual(fs.statSync(result.absolutePath).mode & 0o777, 0o600);
    assert.match(path.basename(result.absolutePath), /^[A-Za-z0-9._-]+$/);
    assert.ok(result.absolutePath.endsWith('.png'));
  });

  // The case HistoryStore never has to handle: its roots are server-owned,
  // while this one writes into the agent's own working directory, where a
  // hostile checkout or the agent itself can plant a symlink.
  it('refuses a symlinked .cc-web and creates nothing through it', async function () {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-outside-'));
    try {
      fs.symlinkSync(outside, path.join(workingDir, '.cc-web'));
      await assert.rejects(
        () => store.save({ id: 'ok', ownerUserId: 1, workingDir }, PNG),
        /symlink/i,
      );
      // mkdir -p would have followed the link and created pasted/ in there.
      assert.deepStrictEqual(fs.readdirSync(outside), []);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses a symlinked pasted directory one level down', async function () {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-outside2-'));
    try {
      fs.mkdirSync(path.join(workingDir, '.cc-web'));
      fs.symlinkSync(outside, path.join(workingDir, '.cc-web', 'pasted'));
      await assert.rejects(
        () => store.save({ id: 'ok', ownerUserId: 1, workingDir }, PNG),
        /symlink/i,
      );
      assert.deepStrictEqual(fs.readdirSync(outside), []);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses when .cc-web exists as a regular file', async function () {
    fs.writeFileSync(path.join(workingDir, '.cc-web'), 'not a directory');
    await assert.rejects(() => store.save({ id: 'ok', ownerUserId: 1, workingDir }, PNG));
  });

  it('rejects an unsupported type without creating a directory', async function () {
    await assert.rejects(
      () => store.save({ id: 'ok', ownerUserId: 1, workingDir }, Buffer.from('#!/bin/sh\n')),
      /Unsupported/,
    );
    // The sniff runs before any mkdir, so a rejected paste leaves no trace.
    assert.ok(!fs.existsSync(path.join(workingDir, '.cc-web')));
  });

  it('rejects an empty body and an oversized image', async function () {
    const small = new PasteStore({ storageDir, maxBytes: 16 });
    await assert.rejects(() => small.save({ id: 'ok', ownerUserId: 1, workingDir }, Buffer.alloc(0)));
    await assert.rejects(
      () => small.save({ id: 'ok', ownerUserId: 1, workingDir }, Buffer.concat([PNG, Buffer.alloc(64)])),
      /too large/i,
    );
    assert.deepStrictEqual(listFiles(workingDir), []);
  });

  it('rejects non-numeric or unsafe configured byte limits', function () {
    for (const sessionQuotaBytes of ['200', NaN, -1, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => new PasteStore({ storageDir, sessionQuotaBytes }), /safe integer/i);
    }
    for (const maxBytes of ['10', NaN, 0, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => new PasteStore({ storageDir, maxBytes }), /safe integer/i);
    }
  });

  it('never clobbers an existing file when names collide', async function () {
    // Freeze the clock and the random suffix so the second save produces
    // exactly the same name as the first.
    const frozen = new PasteStore({
      storageDir,
      now: () => new Date('2026-07-20T11:22:33.456Z'),
      randomId: () => 'a1b2c3d4',
    });

    // Both must be PNGs: the extension is part of the name, so a JPEG would
    // land at a different path and never collide in the first place.
    const otherPng = Buffer.concat([PNG, Buffer.alloc(8, 0x7a)]);

    const first = await frozen.save({ id: 'ok', ownerUserId: 1, workingDir }, PNG);
    await assert.rejects(() => frozen.save({ id: 'ok', ownerUserId: 1, workingDir }, otherPng));
    // wx means the original bytes are still there, untouched.
    assert.deepStrictEqual(fs.readFileSync(first.absolutePath), PNG);
  });

  it('enforces a per-session quota', async function () {
    const tight = new PasteStore({ storageDir, sessionQuotaBytes: PNG.length + 1 });
    await tight.save({ id: 'ok', ownerUserId: 1, workingDir }, PNG);
    await assert.rejects(
      () => tight.save({ id: 'ok', ownerUserId: 1, workingDir }, PNG),
      /quota/i,
    );
  });

  it('rejects an oversized manifest before accepting another paste', async function () {
    const first = await store.save({ id: 'huge-manifest', ownerUserId: 1, workingDir }, PNG);
    const manifest = path.join(storageDir, 'pastes', '1', 'huge-manifest.json');
    fs.writeFileSync(manifest, Buffer.alloc(MAX_PASTE_MANIFEST_BYTES + 1, 0x20));
    const filesBefore = fs.readdirSync(path.dirname(first.absolutePath)).sort();

    await assert.rejects(
      () => store.save({ id: 'huge-manifest', ownerUserId: 1, workingDir }, PNG),
      (error) => error && error.code === 'INVALID_PASTE_MANIFEST',
    );
    assert.deepStrictEqual(fs.readdirSync(path.dirname(first.absolutePath)).sort(), filesBefore);
  });

  it('does not let non-numeric or negative manifest bytes neutralize the quota', async function () {
    const tight = new PasteStore({ storageDir, sessionQuotaBytes: PNG.length });
    const first = await tight.save({ id: 'invalid-quota', ownerUserId: 1, workingDir }, PNG);
    const manifest = path.join(storageDir, 'pastes', '1', 'invalid-quota.json');

    for (const invalidBytes of ['0', -1]) {
      fs.writeFileSync(manifest, JSON.stringify({
        version: 1,
        entries: [{ path: first.absolutePath, root: path.dirname(first.absolutePath), bytes: invalidBytes }],
      }));
      await assert.rejects(
        () => tight.save({ id: 'invalid-quota', ownerUserId: 1, workingDir }, PNG),
        (error) => error && error.code === 'INVALID_PASTE_MANIFEST',
      );
    }

    assert.deepStrictEqual(fs.readFileSync(first.absolutePath), PNG);
    assert.strictEqual(fs.readdirSync(path.dirname(first.absolutePath)).filter((name) => name.endsWith('.png')).length, 1);
  });

  it('accepts the UUIDs the server actually generates', async function () {
    const id = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
    const result = await store.save({ id, ownerUserId: 12, workingDir }, PNG);
    assert.ok(fs.existsSync(result.absolutePath));
  });
});
