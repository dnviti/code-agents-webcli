'use strict';

const fs = require('node:fs');

const [previousPath, currentPath, releaseTag, updaterBridgeTag] = process.argv.slice(2);
if (!previousPath || !currentPath || !releaseTag) {
  throw new Error('Usage: node scripts/validate-flatpak-permissions.js PREVIOUS CURRENT RELEASE_TAG [UPDATER_BRIDGE_TAG]');
}

function finishArgs(filename) {
  const lines = fs.readFileSync(filename, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((line) => /^flatpak:\s*$/.test(line));
  if (start < 0) throw new Error(`${filename} has no flatpak section`);
  const args = new Set();
  let reading = false;
  for (const line of lines.slice(start + 1)) {
    if (/^[A-Za-z][A-Za-z0-9]*:\s*$/.test(line)) break;
    if (/^\s+finishArgs:\s*$/.test(line)) {
      reading = true;
      continue;
    }
    if (reading && /^\s+-\s+/.test(line)) args.add(line.replace(/^\s+-\s+/, '').trim());
    if (reading && /^\s+[A-Za-z][A-Za-z0-9]*:\s*$/.test(line)) reading = false;
  }
  return args;
}

const previous = finishArgs(previousPath);
const current = finishArgs(currentPath);
const added = [...current].filter((permission) => !previous.has(permission));
if (added.length === 0) {
  console.log('Flatpak finish-args have not expanded.');
  process.exit(0);
}

const updaterPortalPermission = '--talk-name=org.freedesktop.portal.Flatpak';
const hostProcessBridgePermission = '--talk-name=org.freedesktop.Flatpak';
const updaterBridge = updaterBridgeTag === releaseTag && added[0] === updaterPortalPermission;
// This immutable version check makes the new host-process permission a true
// one-release migration. The workflow's automatically populated updater tag
// must not turn into a standing exception for this broader D-Bus interface.
const hostProcessBridge = releaseTag === 'v6.1.1' && added[0] === hostProcessBridgePermission;
if (added.length === 1 && (updaterBridge || hostProcessBridge)) {
  console.warn(`Allowing only the one-time reviewed Flatpak bridge in ${releaseTag}: ${added[0]}`);
  process.exit(0);
}
throw new Error(
  `Flatpak finish-args expanded: ${added.join(', ')}. `
  + 'Do not promote this automatic-update channel. Future permission changes require a separate documented manual migration path; the bridge exception accepts only one exact reviewed Flatpak bridge permission.',
);
