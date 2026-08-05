const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let mod;

before(function () {
  this.timeout(60000);
  const out = path.join(os.tmpdir(), `phone-access-ui-${process.pid}.js`);
  require('esbuild').buildSync({
    stdin: { contents: [
      `export { renderToStaticMarkup } from 'react-dom/server';`,
      `export * as React from 'react';`,
      `export { PhoneAccessDialog } from ${JSON.stringify(path.join(ROOT, 'src/client/shell/dialogs/PhoneAccessDialog'))};`,
      `export { ServerManagerDialog } from ${JSON.stringify(path.join(ROOT, 'src/client/shell/dialogs/ServerManagerDialog'))};`,
    ].join('\n'), resolveDir: ROOT, loader: 'tsx', sourcefile: 'phone-access-ui.tsx' },
    bundle: true, outfile: out, format: 'cjs', platform: 'node', jsx: 'automatic', target: ['node20'], logLevel: 'silent',
  });
  mod = require(out); mod.__file = out;
});

after(function () { if (mod?.__file) fs.rmSync(mod.__file, { force: true }); });

const noop = async () => {};
const running = {
  state: 'running', available: true, mode: 'both', port: 32354,
  interfaces: [], origins: { lan: 'https://192.168.1.9:32354', tailscale: 'https://desk.tailnet.ts.net' },
  pairing: { url: 'https://192.168.1.9:32354/auth/pair#token=short-lived', expiresAt: '2026-08-05T12:00:00Z', origin: 'https://192.168.1.9:32354' },
  devices: [{ id: 'phone-1', label: 'Daniele’s phone' }], ca: { fingerprint: 'AA:BB', downloadUrl: '/ca.pem' },
  tailscale: { installed: true, online: true, serve: true },
};

function render(Component, props) { return mod.renderToStaticMarkup(mod.React.createElement(Component, props)); }

describe('phone access UI', function () {
  it('keeps start controls and explicit risk copy in the off state', function () {
    const html = render(mod.PhoneAccessDialog, { open: true, status: { ...running, state: 'off', devices: [] }, onClose() {}, onRefresh: noop, onStart: noop, onPair: noop, onRevoke: noop, onStop: noop, onCheckTailscale: noop, onSetTailscaleOrigin: noop, onExportCa: noop });
    assert.match(html, /Start phone access/);
    assert.match(html, /Only pair devices you control/);
    assert.match(html, /Network interface/);
  });

  it('renders a QR, selectable link, CA guidance, and revocation for running access', function () {
    const html = render(mod.PhoneAccessDialog, { open: true, status: running, onClose() {}, onRefresh: noop, onStart: noop, onPair: noop, onRevoke: noop, onStop: noop, onCheckTailscale: noop, onSetTailscaleOrigin: noop, onExportCa: noop });
    assert.match(html, /QR code for phone access/);
    assert.match(html, /auth\/pair#token=short-lived/);
    assert.match(html, /Export CA from this desktop/);
    assert.match(html, /Copy link/);
    assert.match(html, /Revoke/);
    assert.match(html, /Stop phone access/);
  });

  it('offers Open on phone solely through the local-computer card callback', function () {
    const target = { id: 'local', name: 'Local computer', kind: 'local', connection: 'connected', auth: 'authenticated', compatibility: 'compatible', certificate: 'trusted' };
    const local = render(mod.ServerManagerDialog, { open: true, targets: [target], onClose() {}, onOpenPhoneAccess() {} });
    const remote = render(mod.ServerManagerDialog, { open: true, targets: [{ ...target, id: 'remote', kind: 'remote', origin: 'https://remote.example' }], onClose() {}, onOpenPhoneAccess() {} });
    assert.match(local, /Open on phone/);
    assert.doesNotMatch(remote, /Open on phone/);
  });
});
