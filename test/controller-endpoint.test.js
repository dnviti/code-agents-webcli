'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  readControllerPort,
  writeControllerPort,
} = require('../desktop/controller-endpoint.js');

describe('desktop controller endpoint', function () {
  let directory;
  let filename;

  beforeEach(function () {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'controller-endpoint-'));
    filename = path.join(directory, 'private', 'gateway.json');
  });

  afterEach(function () {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('persists a stable private gateway port across launches', function () {
    assert.strictEqual(readControllerPort(filename), 0);
    writeControllerPort(filename, 43127);
    assert.strictEqual(readControllerPort(filename), 43127);
    assert.strictEqual(fs.statSync(filename).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(path.dirname(filename)).mode & 0o777, 0o700);
  });

  it('ignores corrupt, privileged, and out-of-range endpoint state', function () {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    for (const value of ['{', JSON.stringify({ version: 1, port: 80 }), JSON.stringify({ version: 2, port: 43127 })]) {
      fs.writeFileSync(filename, value);
      assert.strictEqual(readControllerPort(filename), 0);
    }
    assert.throws(() => writeControllerPort(filename, 80), /port is invalid/);
  });
});
