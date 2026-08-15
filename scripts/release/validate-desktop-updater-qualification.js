'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');

const filename = process.argv[2];
const expectedTag = process.argv[3];
const expectedCommit = process.argv[4];
const assetDirectory = process.argv[5] || null;
const feedDirectory = process.argv[6] || null;
if (!filename || !expectedTag || !expectedCommit) {
  throw new Error('Usage: node scripts/release/validate-desktop-updater-qualification.js FILE TAG COMMIT');
}

const fail = (message) => {
  throw new Error(`Desktop updater qualification is invalid: ${message}`);
};
const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
const packages = ['windows-nsis', 'linux-appimage', 'linux-flatpak', 'macos-x64', 'macos-arm64'];
const evidencePattern = /^https:\/\/github\.com\/dnviti\/code-agents-webcli\/actions\/runs\/([1-9]\d*)\/?$/;

if (value.schemaVersion !== 2) fail('unexpected schema');
if (value.tag !== expectedTag || value.commit !== expectedCommit) fail('tag or commit mismatch');
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(String(value.baseVersion || ''))) {
  fail('baseVersion must be a stable updater-capable version');
}
if (`v${value.targetVersion}` !== expectedTag
  || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(String(value.targetVersion || ''))) {
  fail('targetVersion does not match the release tag');
}
const numeric = (version) => version.split('.').map((part) => BigInt(part));
const base = numeric(value.baseVersion);
const target = numeric(value.targetVersion);
if (!target.some((part, index) => part > base[index]
  && target.slice(0, index).every((earlier, earlierIndex) => earlier === base[earlierIndex]))) {
  fail('targetVersion must be newer than baseVersion');
}
if (!Number.isFinite(Date.parse(String(value.completedAt || '')))) fail('completedAt is invalid');
if (!value.results || typeof value.results !== 'object' || Array.isArray(value.results)) {
  fail('results must be a mapping');
}
if (Object.keys(value.results).sort().join('\n') !== [...packages].sort().join('\n')) {
  fail('results must cover exactly every current desktop package');
}
const expectedAssets = {
  'windows-nsis': `Code-Agents-Web-CLI-${value.targetVersion}-win-x64.exe`,
  'linux-appimage': `Code-Agents-Web-CLI-${value.targetVersion}-linux-x64.AppImage`,
  'macos-x64': `Code-Agents-Web-CLI-${value.targetVersion}-mac-x64.zip`,
  'macos-arm64': `Code-Agents-Web-CLI-${value.targetVersion}-mac-arm64.zip`,
};
const flatpakFiles = [
  'code-agents-webcli.gpg', 'summary', 'summary.sig', 'update-info.json', 'update-info.json.asc',
];
const evidenceRuns = new Set();
for (const name of packages) {
  const result = value.results[name];
  if (!result || result.passed !== true || !evidencePattern.test(String(result.evidence || ''))) {
    fail(`${name} has no successful same-repository evidence run`);
  }
  if (evidenceRuns.has(result.evidence)) fail('each package must have its own installed-trial evidence run');
  evidenceRuns.add(result.evidence);
  if (name === 'linux-flatpak') {
    if (result.payload?.kind !== 'flatpak-repository'
      || !/^[0-9a-f]{64}$/.test(String(result.payload.commit || ''))
      || !result.payload.files || Object.keys(result.payload.files).sort().join('\n') !== [...flatpakFiles].sort().join('\n')
      || flatpakFiles.some((filename) => !/^[0-9a-f]{64}$/.test(String(result.payload.files[filename] || '')))) {
      fail('linux-flatpak is not bound to the exact signed repository payload');
    }
  } else if (result.payload?.kind !== 'asset'
    || result.payload.name !== expectedAssets[name]
    || !/^[0-9a-f]{64}$/.test(String(result.payload.sha256 || ''))) {
    fail(`${name} is not bound to the exact updater payload`);
  }
}

if (!value.releaseAssets || typeof value.releaseAssets !== 'object' || Array.isArray(value.releaseAssets)) {
  fail('releaseAssets must bind the complete private draft');
}
for (const [name, digest] of Object.entries(value.releaseAssets)) {
  if (name !== path.basename(name) || name.includes('\\') || !/^[0-9a-f]{64}$/.test(String(digest))) {
    fail('releaseAssets contains an unsafe name or digest');
  }
}

function sha256(filename) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(filename, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let length;
    do {
      length = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (length > 0) hash.update(buffer.subarray(0, length));
    } while (length > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

if (assetDirectory) {
  const actualNames = fs.readdirSync(assetDirectory).filter((name) => {
    const stat = fs.lstatSync(path.join(assetDirectory, name));
    return stat.isFile() && !stat.isSymbolicLink();
  }).sort();
  if (actualNames.join('\n') !== Object.keys(value.releaseAssets).sort().join('\n')) {
    fail('the private draft asset set changed after qualification');
  }
  for (const name of actualNames) {
    const filename = path.join(assetDirectory, name);
    let stat;
    try { stat = fs.lstatSync(filename); } catch { fail(`staged asset ${name} is missing`); }
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`staged asset ${name} is not a regular file`);
    if (sha256(filename) !== value.releaseAssets[name]) fail(`staged asset ${name} changed after qualification`);
  }
  for (const name of packages.filter((entry) => entry !== 'linux-flatpak')) {
    const payload = value.results[name].payload;
    if (value.releaseAssets[payload.name] !== payload.sha256) fail(`${name} payload is not in the bound draft`);
  }
}

if (feedDirectory) {
  const payload = value.results['linux-flatpak'].payload;
  for (const name of flatpakFiles) {
    const filename = path.join(feedDirectory, name);
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || sha256(filename) !== payload.files[name]) {
      fail(`Flatpak candidate file ${name} changed after qualification`);
    }
  }
  const info = JSON.parse(fs.readFileSync(path.join(feedDirectory, 'update-info.json'), 'utf8'));
  if (info.version !== value.targetVersion || info.commit !== payload.commit) {
    fail('Flatpak candidate commit/version changed after qualification');
  }
}

console.log(`Validated installed old-to-new qualification for ${expectedTag}.`);
