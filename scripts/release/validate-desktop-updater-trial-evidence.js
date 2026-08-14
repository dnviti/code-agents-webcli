'use strict';

const fs = require('node:fs');
const { isDeepStrictEqual } = require('node:util');

const filename = process.argv[2];
const packageName = process.argv[3];
const qualificationFilename = process.argv[4];
if (!filename || !packageName || !qualificationFilename) {
  throw new Error('Usage: validate-desktop-updater-trial-evidence.js FILE PACKAGE QUALIFICATION');
}

const fail = (message) => {
  throw new Error(`Desktop updater installed-trial evidence is invalid: ${message}`);
};
const evidence = JSON.parse(fs.readFileSync(filename, 'utf8'));
const qualification = JSON.parse(fs.readFileSync(qualificationFilename, 'utf8'));
const expected = qualification.results?.[packageName];

if (!expected) fail('unexpected package');
if (evidence.schemaVersion !== 1 || evidence.package !== packageName || evidence.passed !== true) {
  fail('schema, package, or result mismatch');
}
for (const key of ['tag', 'commit', 'baseVersion', 'targetVersion']) {
  if (evidence[key] !== qualification[key]) fail(`${key} mismatch`);
}
if (!Number.isFinite(Date.parse(String(evidence.completedAt || '')))) fail('completedAt is invalid');
if (!isDeepStrictEqual(evidence.payload, expected.payload)) {
  fail('the tested updater payload does not match the staged candidate');
}

console.log(`Validated ${packageName} installed-trial evidence for ${qualification.tag}.`);
