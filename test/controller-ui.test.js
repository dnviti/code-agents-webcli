const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Focused guards for the controller UI's safety boundaries. These components
// are rendered through React's browser-compatible markup path; pure URL and
// warning helpers are exported from the same bundle so the tests exercise the
// code shipped to the renderer rather than copies of its rules.

const ROOT = path.join(__dirname, '..');
let mod;

before(function () {
  this.timeout(60000);
  const contents = [
    `export { renderToStaticMarkup } from 'react-dom/server';`,
    `export * as React from 'react';`,
    `export { controllerFetch, getControllerSnapshot, initializeController, mapControllerTarget, selectControllerServer } from ${JSON.stringify(path.join(ROOT, 'src/client/controller/transport'))};`,
    `export { loadEffortPreferences, rememberEffort } from ${JSON.stringify(path.join(ROOT, 'src/client/chat/effort-preference'))};`,
    `export { NewSessionDialog } from ${JSON.stringify(path.join(ROOT, 'src/client/shell/dialogs/NewSessionDialog'))};`,
    `export { SessionsDialog } from ${JSON.stringify(path.join(ROOT, 'src/client/shell/dialogs/SessionsDialog'))};`,
    `export { SettingsDialog } from ${JSON.stringify(path.join(ROOT, 'src/client/shell/dialogs/SettingsDialog'))};`,
    `export { PlanDialog } from ${JSON.stringify(path.join(ROOT, 'src/client/shell/dialogs/PlanDialog'))};`,
    `export { PlanDocDialog } from ${JSON.stringify(path.join(ROOT, 'src/client/shell/chat/PlanDocDialog'))};`,
    `export { ServerManagerDialog, validateHttpsOrigin, certificateWarningText, removalDescription } from ${JSON.stringify(path.join(ROOT, 'src/client/shell/dialogs/ServerManagerDialog'))};`,
  ].join('\n');

  const out = path.join(os.tmpdir(), `controller-ui-${process.pid}.js`);
  require('esbuild').buildSync({
    stdin: { contents, resolveDir: ROOT, loader: 'tsx', sourcefile: 'controller-ui.tsx' },
    bundle: true,
    outfile: out,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    target: ['node20'],
    logLevel: 'silent',
  });
  mod = require(out);
  mod.__file = out;
});

after(function () {
  if (mod?.__file) fs.rmSync(mod.__file, { force: true });
});

function target(overrides = {}) {
  return {
    id: 'local',
    name: 'Local computer',
    kind: 'local',
    connection: 'connected',
    auth: 'authenticated',
    compatibility: 'compatible',
    certificate: 'trusted',
    ...overrides,
  };
}

function session(overrides = {}) {
  return {
    id: 'session-1',
    name: 'Session one',
    active: false,
    workingDir: '/work/project-one',
    connectedClients: 1,
    created: '2026-08-04T08:00:00.000Z',
    projectId: 'project-1',
    projectName: 'Project one',
    ...overrides,
  };
}

function render(Component, props) {
  return mod.renderToStaticMarkup(mod.React.createElement(Component, props));
}

function buttonTag(html, ariaLabel) {
  const escaped = ariaLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return html.match(new RegExp(`<button[^>]*aria-label="${escaped}"[^>]*>`))?.[0] ?? '';
}

describe('desktop controller UI', function () {
  it('accepts exactly bare HTTPS origins and preserves non-default ports', function () {
    assert.deepStrictEqual(mod.validateHttpsOrigin('https://agents.example:8443'), {
      origin: 'https://agents.example:8443',
      error: null,
    });
    assert.deepStrictEqual(mod.validateHttpsOrigin('https://agents.example/'), {
      origin: 'https://agents.example',
      error: null,
    });

    for (const value of [
      'http://agents.example',
      'https://agents.example/workspace',
      'https://agents.example?server=one',
      'https://agents.example#status',
      'https://user:secret@agents.example',
      'agents.example',
    ]) {
      const result = mod.validateHttpsOrigin(value);
      assert.strictEqual(result.origin, null, `${value} must not be accepted as a server origin`);
      assert.ok(result.error, `${value} must have a useful inline error`);
    }
  });

  it('offers the newly presented fingerprint when an approved certificate changes', function () {
    const mapped = mod.mapControllerTarget({
      id: 'remote', type: 'remote', name: 'Office', origin: 'https://office.example',
      status: 'certificate-error', signedIn: true, protocolVersion: 1,
      certificateFingerprint: '11:OLD',
      error: { code: 'TLS_CERTIFICATE_CHANGED', fingerprint256: '22:NEW', requiresRenewedApproval: true },
    });
    assert.strictEqual(mapped.certificate, 'changed');
    assert.strictEqual(mapped.certificateFingerprint, '22:NEW');

    const staged = mod.mapControllerTarget({
      id: 'remote', type: 'remote', name: 'New office', origin: 'https://new.example',
      status: 'certificate-error', signedIn: true, protocolVersion: 1,
      certificateFingerprint: '11:OLD',
      error: { code: 'TLS_CERTIFICATE', fingerprint256: '33:STAGED' },
    });
    assert.strictEqual(staged.certificate, 'untrusted');
    assert.strictEqual(staged.certificateFingerprint, '33:STAGED');
  });

  it('offers only valid recovery controls for an unsaved certificate-blocked addition', function () {
    const pending = mod.mapControllerTarget({
      id: 'pending-add', type: 'remote', name: 'Pending lab', origin: 'https://pending.example',
      status: 'certificate-error', signedIn: false, stagedAddition: true,
      error: { code: 'TLS_CERTIFICATE', fingerprint256: '33:STAGED' },
    });
    assert.strictEqual(pending.pendingAddition, true);
    assert.strictEqual(pending.canRetry, true);
    assert.strictEqual(pending.canTest, false);
    assert.strictEqual(pending.canEdit, false);
    assert.strictEqual(pending.canRemove, true);

    const html = render(mod.ServerManagerDialog, {
      open: true,
      targets: [pending],
      onClose() {},
      onTest() {},
      onRetry() {},
      onEdit() {},
      onRemove() {},
      onOverrideCertificate() {},
    });
    assert.doesNotMatch(html, />Test<|aria-label="Edit Pending lab"/);
    assert.match(html, />Retry</);
    assert.match(html, /aria-label="Remove Pending lab"/);
    assert.match(html, />Certificate warning</);
  });

  it('makes the server chooser mandatory, remembers the previous target, and disables unavailable options', function () {
    const local = target();
    const remote = target({
      id: 'remote',
      name: 'Office',
      kind: 'remote',
      origin: 'https://office.example:8443',
      connection: 'offline',
      canRetry: true,
    });
    const html = render(mod.NewSessionDialog, {
      open: true,
      defaultWorkingDir: '/work',
      serverTargets: [local, remote],
      lastUsedServerId: 'local',
      onCreate() {},
      onClose() {},
    });

    assert.match(html, /<select[^>]*required=""[^>]*aria-describedby=/, 'server choice must be required and described');
    assert.match(html, /<option value="local" selected="">Local computer<\/option>/, 'last-used target must be selected');
    assert.match(html, /<option value="remote" disabled="">Office — Server offline<\/option>/, 'offline target must stay visible but disabled');
    assert.match(html, /Local computer · Ready/, 'the chosen server and status must be visible');
    assert.match(html, /min-height:44px/, 'the server selector must keep a 44px touch target');
  });

  it('shares renderer preferences while routing server-owned settings to the explicit target', async function () {
    const previousFetch = global.fetch;
    const previousLocation = global.location;
    const previousLocalStorage = global.localStorage;
    const stored = new Map();
    const requests = [];
    global.location = { origin: 'http://127.0.0.1:32123' };
    global.localStorage = {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, String(value)),
      removeItem: (key) => stored.delete(key),
    };
    global.fetch = async (input, init = {}) => {
      const pathname = new URL(String(input), global.location.origin).pathname;
      if (pathname === '/api/controller/bootstrap') {
        return new Response(JSON.stringify({
          desktopController: true,
          targets: [
            { id: 'alpha', type: 'remote', name: 'Alpha', status: 'connected', signedIn: true, protocolVersion: 1 },
            { id: 'beta', type: 'remote', name: 'Beta', status: 'connected', signedIn: true, protocolVersion: 1 },
          ],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      requests.push({ pathname, serverId: new Headers(init.headers).get('x-controller-server-id') });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };

    try {
      await mod.initializeController();
      mod.selectControllerServer('alpha');
      mod.rememberEffort('claude', 'high');
      mod.selectControllerServer('beta');
      assert.deepStrictEqual(mod.loadEffortPreferences(), { claude: 'high' }, 'display preference is desktop-wide');
      await mod.controllerFetch('/api/preferences');
      mod.selectControllerServer('alpha');
      await mod.controllerFetch('/api/preferences');
      assert.deepStrictEqual(requests, [
        { pathname: '/api/preferences', serverId: 'beta' },
        { pathname: '/api/preferences', serverId: 'alpha' },
      ]);
    } finally {
      global.fetch = previousFetch;
      global.location = previousLocation;
      global.localStorage = previousLocalStorage;
    }
  });

  it('leaves only Retry and Edit actionable on an offline session', function () {
    const remote = target({
      id: 'remote',
      name: 'Office',
      kind: 'remote',
      origin: 'https://office.example',
      connection: 'offline',
      canRetry: true,
      canEdit: true,
    });
    const html = render(mod.SessionsDialog, {
      open: true,
      sessions: [session({ serverId: 'remote', serverName: 'Office', serverStatus: 'offline' })],
      activeId: null,
      serverTargets: [remote],
      onJoin() {},
      onLeave() {},
      onDelete() {},
      onRetryServer() {},
      onEditServer() {},
      onNew() {},
      onClose() {},
    });

    assert.match(buttonTag(html, 'Join session'), /disabled=""/, 'Join must be disabled offline');
    assert.match(buttonTag(html, 'Delete Session one'), /disabled=""/, 'Delete must be disabled offline');
    assert.doesNotMatch(buttonTag(html, 'Retry Office'), /disabled=""/, 'Retry must remain available');
    assert.doesNotMatch(buttonTag(html, 'Edit Office'), /disabled=""/, 'Edit must remain available');
    assert.match(html, /Project: Project one/, 'project detail must survive the controller layout');
    assert.match(html, /project-one/, 'folder detail must survive the controller layout');
    assert.match(html, /Office · Server offline/, 'server and status must be visible in words');
  });

  it('locks the permanent local entry while keeping offline recovery actions available', function () {
    const localHtml = render(mod.ServerManagerDialog, {
      open: true,
      targets: [target({ canSignOut: true, canEdit: true, canRemove: true })],
      onClose() {},
      onSignOut() {},
      onEdit() {},
      onRemove() {},
    });
    assert.match(localHtml, /Permanent/, 'Local computer must be identified as permanent');
    assert.ok(!localHtml.includes('aria-label="Edit Local computer"'), 'Local computer cannot be edited');
    assert.ok(!localHtml.includes('aria-label="Remove Local computer"'), 'Local computer cannot be removed');
    assert.ok(!/>Sign out<\/button>/.test(localHtml), 'Local computer cannot be signed out');

    const remoteHtml = render(mod.ServerManagerDialog, {
      open: true,
      targets: [target({
        id: 'remote', name: 'Office', kind: 'remote', origin: 'https://office.example',
        connection: 'offline', canRetry: true, canSignIn: true, canSignOut: true,
        canEdit: true, canRemove: true,
      })],
      onClose() {}, onRetry() {}, onTest() {}, onSignIn() {}, onSignOut() {}, onEdit() {}, onRemove() {},
    });
    assert.match(remoteHtml, /<button[^>]*>Retry<\/button>/, 'Retry must remain actionable offline');
    assert.doesNotMatch(remoteHtml.match(/<button[^>]*>Test<\/button>/)?.[0] || '', /disabled=""/, 'Test must remain available offline');
    assert.doesNotMatch(remoteHtml.match(/<button[^>]*>Sign in<\/button>/)?.[0] || '', /disabled=""/, 'Sign in must remain available offline');
    assert.doesNotMatch(buttonTag(remoteHtml, 'Edit Office'), /disabled=""/, 'Edit must remain actionable offline');
    assert.doesNotMatch(buttonTag(remoteHtml, 'Remove Office'), /disabled=""/, 'Remove must remain available offline');
  });

  it('hides PWA installation only in Electron controller mode', function () {
    const settings = {
      fontSize: 14,
      theme: 'github-dark',
      terminalFontFamily: 'jetbrains-mono',
      chatBypassPermissions: false,
      notifications: {
        enabled: true, finished: true, failed: true,
        approval: true, question: true, details: true,
      },
    };
    const common = {
      open: true,
      settings,
      install: 'available',
      controllerTargets: [target()],
      onPreview() {}, onSave() {}, onClose() {}, onInstall() {},
      onOpenRuntimeProfiles() {}, onOpenDeployTargets() {},
      deployTargetsEnabled: false, environmentsEnabled: false,
      onOpenEnvironment() {}, onOpenProjects() {}, onOpenServerManager() {},
    };
    const browser = render(mod.SettingsDialog, { ...common, isElectronController: false });
    const electron = render(mod.SettingsDialog, { ...common, isElectronController: true });

    assert.match(browser, /Install app/, 'browser and PWA use must retain the install surface');
    assert.match(browser, /Servers/, 'server management does not itself imply Electron');
    assert.doesNotMatch(electron, /Install app/, 'Electron must not offer a PWA install');
    assert.match(electron, /Servers/, 'Electron must retain server management');
  });

  it('states the full certificate and running-session consequences', function () {
    const warning = mod.certificateWarningText({
      name: 'Office',
      origin: 'https://office.example:8443',
    });
    for (const sensitive of ['commands', 'files', 'credentials', 'approvals', 'session content']) {
      assert.match(warning, new RegExp(sensitive), `warning must name intercepted ${sensitive}`);
    }
    assert.match(warning, /replacement certificate/);
    assert.match(warning, /renewed approval/);
    assert.match(warning, /https:\/\/office\.example:8443/);

    const removal = mod.removalDescription({ name: 'Office', runningWorkCount: 2 });
    assert.match(removal, /2 running sessions will keep running remotely/);
    assert.match(removal, /lose visibility/);
    assert.match(removal, /Nothing on the remote server will be stopped or deleted/);
  });

  it('names and disables the owning server in plan confirmations while offline', function () {
    const terminal = render(mod.PlanDialog, {
      open: true,
      content: 'Do the work',
      serverName: 'Office',
      disabled: true,
      onAccept() {}, onReject() {}, onClose() {},
    });
    assert.match(terminal, /Plan mode active · Server: Office/);
    assert.match(terminal, /server is unavailable/i);
    assert.match(terminal.match(/<button[^>]*>Accept plan<\/button>/)?.[0] || '', /disabled=""/);

    const structured = render(mod.PlanDocDialog, {
      plan: { markdown: '# Work', revision: 1, ts: 1 },
      planMode: true,
      serverName: 'Office',
      disabled: true,
      onAccept() {}, onReject() {}, onClose() {},
    });
    assert.match(structured, /Server: Office/);
    assert.match(structured.match(/<button[^>]*>Accept plan<\/button>/)?.[0] || '', /disabled=""/);
  });

  it('blocks the active work surface and routes recovery to its owning server', function () {
    const shell = fs.readFileSync(path.join(ROOT, 'src/client/shell/AppShell.tsx'), 'utf8');
    assert.match(shell, /serverTargetAvailability\(activeControllerTarget\)/);
    assert.match(shell, /Cached session history remains visible, but commands, files, approvals/);
    assert.match(shell, /controllerActions\.retry\(activeControllerTarget\.id\)/);
    assert.match(shell, /serverId: target\.id/);
  });
});
