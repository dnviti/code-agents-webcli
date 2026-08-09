'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const directory = process.argv[2];
if (!directory) throw new Error('Usage: node scripts/validate-release-assets.js DIRECTORY [VERSION]');
const version = process.argv[3] || require('../package.json').version;
const fail = (message) => { throw new Error(`Release asset validation failed: ${message}`); };
const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function regularFiles() {
  return fs.readdirSync(directory).filter((name) => {
    const filename = path.join(directory, name);
    return fs.lstatSync(filename).isFile() && !fs.lstatSync(filename).isSymbolicLink();
  });
}

const files = regularFiles();
const one = (pattern, label) => {
  const matches = files.filter((name) => pattern.test(name));
  if (matches.length !== 1) fail(`expected one ${label}; found ${matches.length} (${matches.join(', ') || 'none'})`);
  return matches[0];
};

const artifacts = {
  appImage: one(new RegExp(`^Code-Agents-Web-CLI-${escapedVersion}-linux-x64\\.AppImage$`), 'AppImage'),
  deb: one(new RegExp(`^Code-Agents-Web-CLI-${escapedVersion}-linux-x64\\.deb$`), 'Debian package'),
  rpm: one(new RegExp(`^Code-Agents-Web-CLI-${escapedVersion}-linux-x64\\.rpm$`), 'RPM package'),
  flatpak: one(new RegExp(`^Code-Agents-Web-CLI-${escapedVersion}-linux-x64\\.flatpak$`), 'Flatpak bundle'),
  flatpakRef: one(new RegExp(`^Code-Agents-Web-CLI-${escapedVersion}-linux-x64\\.flatpakref$`), 'Flatpak reference'),
  flatpakRepo: one(new RegExp(`^Code-Agents-Web-CLI-${escapedVersion}-linux-x64\\.flatpakrepo$`), 'Flatpak repository descriptor'),
  windows: one(new RegExp(`^Code-Agents-Web-CLI-${escapedVersion}-win-x64\\.exe$`), 'Windows installer'),
  windowsBlockmap: one(new RegExp(`^Code-Agents-Web-CLI-${escapedVersion}-win-x64\\.exe\\.blockmap$`), 'Windows blockmap'),
  macX64Dmg: one(new RegExp(`^Code-Agents-Web-CLI-${escapedVersion}-mac-x64\\.dmg$`), 'macOS x64 DMG'),
  macArm64Dmg: one(new RegExp(`^Code-Agents-Web-CLI-${escapedVersion}-mac-arm64\\.dmg$`), 'macOS arm64 DMG'),
  macX64Zip: one(new RegExp(`^Code-Agents-Web-CLI-${escapedVersion}-mac-x64\\.zip$`), 'macOS x64 updater ZIP'),
  macArm64Zip: one(new RegExp(`^Code-Agents-Web-CLI-${escapedVersion}-mac-arm64\\.zip$`), 'macOS arm64 updater ZIP'),
  macX64Blockmap: one(new RegExp(`^Code-Agents-Web-CLI-${escapedVersion}-mac-x64\\.zip\\.blockmap$`), 'macOS x64 ZIP blockmap'),
  macArm64Blockmap: one(new RegExp(`^Code-Agents-Web-CLI-${escapedVersion}-mac-arm64\\.zip\\.blockmap$`), 'macOS arm64 ZIP blockmap'),
};
one(/^latest\.yml$/, 'Windows update manifest');
one(/^latest-linux\.yml$/, 'Linux update manifest');
one(/^latest-x64-mac\.yml$/, 'macOS x64 update manifest');
one(/^latest-arm64-mac\.yml$/, 'macOS arm64 update manifest');
one(/^SHA256SUMS$/, 'checksum file');
if (files.some((name) => name.endsWith('.AppImage.blockmap'))) {
  fail('AppImage differential metadata must be embedded, not published as a sibling blockmap');
}

async function sha512(filename) {
  const hash = crypto.createHash('sha512');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest('base64');
}

function parseManifest(name) {
  const contents = fs.readFileSync(path.join(directory, name), 'utf8');
  let manifest;
  try {
    manifest = YAML.parse(contents, {
      maxAliasCount: 0,
      prettyErrors: false,
      schema: 'core',
      strict: true,
      uniqueKeys: true,
    });
  } catch (error) {
    fail(`${name} is not safe, valid YAML: ${error.message}`);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail(`${name} is not a mapping`);
  if (manifest.version !== version) fail(`${name} does not declare version ${version}`);
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) fail(`${name} has no files array`);
  return manifest;
}

async function validateManifest(name, expectedPrimary, { embeddedBlockmap = false } = {}) {
  const manifest = parseManifest(name);
  const seen = new Set();
  for (const [index, entry] of manifest.files.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`${name} files[${index}] is not a mapping`);
    const basename = entry.url;
    if (typeof basename !== 'string'
      || basename.length === 0
      || basename !== path.basename(basename)
      || basename.includes('\\')
      || basename.includes('%')) {
      fail(`${name} files[${index}].url must be an exact release-asset basename`);
    }
    if (seen.has(basename)) fail(`${name} references ${basename} more than once`);
    seen.add(basename);
    if (!files.includes(basename)) fail(`${name} references missing release asset ${basename}`);

    const filename = path.join(directory, basename);
    const actualSize = fs.statSync(filename).size;
    if (!Number.isSafeInteger(entry.size) || entry.size !== actualSize) {
      fail(`${name} declares size ${entry.size} for ${basename}; actual size is ${actualSize}`);
    }
    if (typeof entry.sha512 !== 'string' || entry.sha512.length === 0) fail(`${name} has no sha512 for ${basename}`);
    const actualHash = await sha512(filename);
    if (entry.sha512 !== actualHash) fail(`${name} sha512 does not match ${basename}`);
  }

  const primary = manifest.files[0];
  if (primary.url !== expectedPrimary) fail(`${name} must use ${expectedPrimary} as its primary update artifact`);
  if (manifest.path !== expectedPrimary || manifest.sha512 !== primary.sha512) {
    fail(`${name} legacy path/sha512 fields do not match its primary artifact`);
  }
  if (embeddedBlockmap) {
    if (!Number.isSafeInteger(primary.blockMapSize)
      || primary.blockMapSize <= 0
      || primary.blockMapSize >= primary.size) {
      fail(`${name} must declare a positive embedded blockMapSize smaller than the AppImage`);
    }
  }
}

async function main() {
  await validateManifest('latest.yml', artifacts.windows);
  await validateManifest('latest-linux.yml', artifacts.appImage, { embeddedBlockmap: true });
  await validateManifest('latest-x64-mac.yml', artifacts.macX64Zip);
  await validateManifest('latest-arm64-mac.yml', artifacts.macArm64Zip);

  const humanPackages = [
    artifacts.appImage,
    artifacts.deb,
    artifacts.rpm,
    artifacts.flatpak,
    artifacts.flatpakRef,
    artifacts.flatpakRepo,
    artifacts.windows,
    artifacts.macX64Dmg,
    artifacts.macArm64Dmg,
  ];
  const checksums = fs.readFileSync(path.join(directory, 'SHA256SUMS'), 'utf8');
  for (const filename of humanPackages) {
    if (!new RegExp(`\\s\\*?\\.?/?${filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').test(checksums)) {
      fail(`SHA256SUMS does not cover ${filename}`);
    }
  }

  console.log(`Validated ${humanPackages.length} human-facing packages and exact updater metadata for ${version}.`);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
