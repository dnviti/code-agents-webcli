const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { HistoryStore } = require('../dist/server/services/history-store.js');

describe('HistoryStore path safety', function () {
  let dir;
  let store;

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-path-'));
    store = new HistoryStore({ storageDir: dir });
  });

  afterEach(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const hostile = ['../../../../tmp/pwned', '..', '.', 'a/b', '/etc/passwd', 'spazio nel mezzo'];

  hostile.forEach(function (id) {
    it(`refuses the session id ${JSON.stringify(id)}`, async function () {
      await assert.rejects(() => store.stat({ id, ownerUserId: 1 }));
      await assert.rejects(() => store.read({ id, ownerUserId: 1 }, 0, 10));
    });
  });

  it('refuses a non-integer owner id', async function () {
    await assert.rejects(() => store.stat({ id: 'ok', ownerUserId: '../root' }));
  });

  it('accepts the UUIDs the server actually generates', async function () {
    const id = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
    store.append({ id, ownerUserId: 12 }, ['va bene']);
    const page = await store.read({ id, ownerUserId: 12 }, 0, 5);
    assert.deepStrictEqual(page.lines, ['va bene']);
  });

  it('writes nothing outside the history directory', async function () {
    // append() is fire-and-forget, so the guard has to hold with nobody
    // awaiting it.
    store.append({ id: '../../escaped', ownerUserId: 1 }, ['segreto']);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const outside = path.join(path.dirname(dir), 'escaped.log');
    assert.ok(!fs.existsSync(outside), `nothing should have been written to ${outside}`);
    assert.ok(!fs.existsSync(path.join(dir, 'escaped.log')));
  });
});
