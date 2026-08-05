'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ENDPOINT_SCHEMA_VERSION = 1;
const MIN_PERSISTED_PORT = 1024;
const MAX_PORT = 65535;

function validPersistedPort(value) {
  return Number.isInteger(value) && value >= MIN_PERSISTED_PORT && value <= MAX_PORT;
}

function readControllerPort(filename, fileSystem = fs) {
  try {
    const value = JSON.parse(fileSystem.readFileSync(filename, 'utf8'));
    return value?.version === ENDPOINT_SCHEMA_VERSION && validPersistedPort(value.port)
      ? value.port : 0;
  } catch {
    return 0;
  }
}

function writeControllerPort(filename, port, fileSystem = fs) {
  if (!validPersistedPort(port)) throw new TypeError('The controller gateway port is invalid');
  const directory = path.dirname(filename);
  fileSystem.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.${path.basename(filename)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  const body = `${JSON.stringify({ version: ENDPOINT_SCHEMA_VERSION, port }, null, 2)}\n`;
  try {
    fileSystem.writeFileSync(temporary, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fileSystem.chmodSync(temporary, 0o600);
    fileSystem.renameSync(temporary, filename);
    fileSystem.chmodSync(filename, 0o600);
  } finally {
    try { fileSystem.unlinkSync(temporary); } catch { /* renamed or never created */ }
  }
}

module.exports = {
  ENDPOINT_SCHEMA_VERSION,
  MAX_PORT,
  MIN_PERSISTED_PORT,
  readControllerPort,
  validPersistedPort,
  writeControllerPort,
};
