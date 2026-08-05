const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let mod;

before(async function () {
  this.timeout(60000);
  const entry = [
    `export { renderToStaticMarkup } from 'react-dom/server';`,
    `export * as React from 'react';`,
    `export { AgentMaintenanceStrip, AgentMaintenancePickerRow, agentMaintenancePresentation } from ${JSON.stringify(path.join(ROOT, 'src/client/shell/AgentMaintenanceStrip'))};`,
    `export { chatLooksAutomaticSafe, shouldShowActiveAgentMaintenance } from ${JSON.stringify(path.join(ROOT, 'src/client/shell/ActiveAgentMaintenance'))};`,
    `export { createAgentMaintenanceApi } from ${JSON.stringify(path.join(ROOT, 'src/client/agent-maintenance/api'))};`,
    `export { agentMaintenanceBusyReason } from ${JSON.stringify(path.join(ROOT, 'src/client/agent-maintenance/useAgentMaintenance'))};`,
    `export { __calls } from './src/client/controller/transport.js';`,
  ].join('\n');
  const outfile = path.join(os.tmpdir(), `agent-maintenance-client-${process.pid}.js`);
  await require('esbuild').build({
    stdin: { contents: entry, resolveDir: ROOT, loader: 'tsx', sourcefile: 'agent-maintenance-client.tsx' },
    bundle: true,
    outfile,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    target: ['node20'],
    logLevel: 'silent',
    plugins: [{
      name: 'captured-controller-transport',
      setup(build) {
        build.onResolve({ filter: /controller\/transport\.js$/ }, () => ({ path: 'transport', namespace: 'maintenance-test' }));
        build.onLoad({ filter: /.*/, namespace: 'maintenance-test' }, () => ({
          loader: 'js',
          contents: `
            export const __calls = [];
            export function parseQualifiedSessionId(value) {
              return value === 'qualified-session' ? { serverId: 'remote-1', sessionId: 'raw-session' } : null;
            }
            export async function controllerFetch(input, init, explicitServerId) {
              __calls.push({ input, init, explicitServerId });
              const body = input.includes('/check')
                ? { check: { targetKey: 'target-key', agentId: 'claude', latestVersion: '2.0.0', state: 'update_available', checkedAt: 1 } }
                : { targetKey: 'target-key', agents: [] };
              return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
            }
          `,
        }));
      },
    }],
  });
  mod = require(outfile);
  mod.__file = outfile;
});

after(function () {
  if (mod?.__file) fs.rmSync(mod.__file, { force: true });
});

function status(overrides = {}) {
  return {
    agentId: 'claude',
    state: 'managed',
    version: '1.4.2',
    managedVersion: '1.4.2',
    check: 'current',
    latestVersion: '1.4.2',
    checkedAt: 1,
    canInstall: true,
    canManageCopy: false,
    requiresConfirmation: false,
    disabledReason: null,
    guidance: null,
    ...overrides,
  };
}

describe('agent maintenance client API', function () {
  beforeEach(function () { mod.__calls.length = 0; });

  it('unwraps the session id and pins every request to its captured owner server', async function () {
    const api = mod.createAgentMaintenanceApi({ targetId: 'qualified-session', serverId: 'remote-1' });
    await api.list();
    await api.check('claude');
    await api.start('claude', 'update', true);
    await api.operation('12345678-1234-1234-1234-123456789abc');

    assert.strictEqual(api.targetId, 'raw-session');
    assert.strictEqual(api.serverId, 'remote-1');
    assert.strictEqual(mod.__calls.length, 4);
    assert.ok(mod.__calls[0].input.includes('targetId=raw-session'));
    assert.strictEqual(mod.__calls[0].explicitServerId, 'remote-1');
    assert.strictEqual(mod.__calls[1].explicitServerId, 'remote-1');
    assert.deepStrictEqual(JSON.parse(mod.__calls[1].init.body), { targetId: 'raw-session', force: false });
    assert.deepStrictEqual(JSON.parse(mod.__calls[2].init.body), { targetId: 'raw-session', confirmed: true });
    assert.match(mod.__calls[3].input, /operations\/12345678-1234-1234-1234-123456789abc\?targetId=raw-session/);
    assert.strictEqual(mod.__calls[3].explicitServerId, 'remote-1');
  });

  it('rejects a qualified session paired with a different controller target', function () {
    assert.throws(
      () => mod.createAgentMaintenanceApi({ targetId: 'qualified-session', serverId: 'remote-2' }),
      /do not match/i,
    );
  });
});

describe('AgentMaintenanceStrip', function () {
  function render(props) {
    return mod.renderToStaticMarkup(mod.React.createElement(mod.AgentMaintenanceStrip, {
      agentId: 'claude',
      targetName: 'Build host · private',
      ...props,
    }));
  }

  it('always names the running version, target, and a non-color state', function () {
    const known = render({ status: status({ check: 'update_available', latestVersion: '2.0.0' }), onUpdate() {} });
    assert.match(known, /Version 1\.4\.2/);
    assert.match(known, /Build host · private/);
    assert.match(known, /Update available/);
    assert.match(known, /role="status"/);
    assert.match(known, /aria-live="polite"/);

    const unknown = render({ status: null, checking: true });
    assert.match(unknown, /Version unknown/);
    assert.match(unknown, /Checking/);
  });

  it('is persistent and exposes install, retry, and restart as separate native controls', function () {
    const install = render({
      status: status({ state: 'external', canInstall: false, canManageCopy: true, check: 'unable_to_check' }),
      error: 'Publisher did not answer.',
      restartMode: 'confirmation_required',
      onInstall() {},
      onRetry() {},
      onConfirm() {},
    });
    assert.match(install, />Install managed copy</);
    assert.match(install, />Retry</);
    assert.match(install, />Restart…</);
    assert.doesNotMatch(install, /dismiss|close/i);
    assert.match(install, /role="group" aria-label="Agent maintenance actions"/);
    assert.match(install, /href="https:\/\/code\.claude\.com\/docs\/en\/getting-started"/);
    assert.match(install, /target="_blank"/);
    assert.match(install, /rel="noopener noreferrer"/);
    assert.match(install, />Official install guide</);
  });

  it('disables a second install with a visible, described reason while the target is busy', function () {
    const reason = 'Update for codex is installing. Wait for it to finish before starting another.';
    const html = mod.renderToStaticMarkup(mod.React.createElement(mod.AgentMaintenancePickerRow, {
      status: status({ state: 'missing', version: null, managedVersion: null }),
      targetName: 'Build host',
      blockedReason: reason,
      onInstall() {},
    }));
    assert.match(html, /<button[^>]*disabled=""/);
    assert.match(html, /aria-describedby="[^"]+"/);
    assert.match(html, /Update for codex is installing/);
  });

  it('renders durable operation phases and cancelability in the picker row', function () {
    const operation = {
      id: 'op-1', targetKey: 'target', agentId: 'claude', kind: 'update', phase: 'verifying',
      createdAt: 1, updatedAt: 2, version: '2.0.0', error: null, retryable: false,
      canCancel: true, cancelReason: null,
    };
    const html = mod.renderToStaticMarkup(mod.React.createElement(mod.AgentMaintenancePickerRow, {
      status: status(),
      targetName: 'Build host',
      operation,
      onCancel() {},
    }));
    assert.match(html, /Verifying/);
    assert.match(html, />Cancel</);
    assert.match(html, /Version 1\.4\.2/);
  });

  it('distinguishes a missing install from an external managed-copy action', function () {
    const missing = render({ status: status({ state: 'missing', version: null, managedVersion: null, canInstall: true }) , onInstall() {} });
    assert.match(missing, /Not installed/);
    assert.match(missing, />Install</);
    assert.doesNotMatch(missing, /Install managed copy/);
    const project = render({ status: status({ state: 'project_managed', canInstall: false, check: 'current' }) });
    assert.match(project, /Project managed/);
  });

  it('keeps the update notice as Restart to use until the running version changes', function () {
    const pending = render({
      status: status({ version: '1.4.2', managedVersion: '2.0.0', latestVersion: '2.0.0' }),
      restartMode: 'safe',
      onRestart() {},
    });
    assert.match(pending, /Target 2\.0\.0/);
    assert.match(pending, /Restart to use/);
    assert.match(pending, />Restart agent</);
  });
});

describe('useAgentMaintenance lifecycle source', function () {
  const source = fs.readFileSync(path.join(ROOT, 'src/client/agent-maintenance/useAgentMaintenance.ts'), 'utf8');

  it('captures the initial binding, checks immediately, refreshes daily, and aborts on unmount', function () {
    assert.match(source, /captured = React\.useRef/);
    assert.match(source, /createAgentMaintenanceApi\(\{ targetId: options\.targetId, serverId: options\.serverId \}\)/);
    assert.match(source, /24 \* 60 \* 60 \* 1_000/);
    assert.match(source, /void refresh\(\);\s*void check\(\);/);
    assert.match(source, /abortRef\.current\?\.abort\(\)/);
  });

  it('restores and polls a durable operation and offers retry', function () {
    assert.match(source, /config\.api\.operation\(config\.operationId/);
    assert.match(source, /config\.api\.operation\(operation\.id/);
    assert.match(source, /operation\?\.retryable/);
    assert.match(source, /start\(operation\.agentId, operation\.kind\)/);
  });

  it('settles Checking from the bounded POST response without a second status probe', function () {
    const checkBody = source.slice(source.indexOf('const check ='), source.indexOf('const start ='));
    assert.match(checkBody, /const checked = await config\.api\.check/);
    assert.doesNotMatch(checkBody, /config\.api\.status/);
    assert.match(checkBody, /check: checked\.state/);
  });

  it('locks starts during restore and across same-render concurrent clicks', function () {
    assert.match(source, /operationGateRef = React\.useRef/);
    assert.match(source, /config\.enabled && config\.operationId \? 'restoring' : null/);
    assert.match(source, /if \(operationGateRef\.current\)/);
    assert.match(source, /operationGateRef\.current = 'starting'/);
    assert.match(mod.agentMaintenanceBusyReason({ restoring: true }), /Restoring the existing agent operation/);
    assert.match(mod.agentMaintenanceBusyReason({ startingAgentId: 'claude' }), /Starting maintenance for claude/);
    assert.match(mod.agentMaintenanceBusyReason({
      operation: {
        id: 'op-2', targetKey: 'target', agentId: 'codex', kind: 'update', phase: 'installing',
        createdAt: 1, updatedAt: 2, version: '2.0.0', error: null, retryable: false,
        canCancel: true, cancelReason: null,
      },
    }), /Update for codex is installing/);
  });
});

describe('launcher maintenance binding source', function () {
  const source = fs.readFileSync(path.join(ROOT, 'src/client/shell/mount.tsx'), 'utf8');

  it('mounts the capturing hook only for a real target and remounts it for either binding coordinate', function () {
    assert.match(source, /function MaintenanceBoundLauncher/);
    assert.match(source, /if \(!targetId\) return launcher/);
    assert.match(source, /key=\{JSON\.stringify\(\[serverId, targetId\]\)\}/);
    assert.doesNotMatch(source, /targetId: targetId \|\| 'unavailable'/);
  });

  it('keys the in-memory operation handle by both server and target and surfaces the global operation lock', function () {
    assert.match(source, /const operationKey = JSON\.stringify\(\[serverId, targetId\]\)/);
    assert.match(source, /launcherMaintenanceOperations\.set\(operationKey, id\)/);
    assert.match(source, /launcherMaintenanceOperations\.delete\(operationKey\)/);
    assert.doesNotMatch(source, /localStorage\.setItem/);
    assert.match(source, /operationBusyReason: maintenance\.operationBusyReason/);
  });
});

describe('active-session automatic restart gate', function () {
  const source = fs.readFileSync(path.join(ROOT, 'src/client/shell/ActiveAgentMaintenance.tsx'), 'utf8');

  it('clears durable operation ids after completion or cancellation, but restarts only on completion', function () {
    assert.match(source, /\['complete', 'cancelled'\]\.includes\(operation\.phase\)/);
    assert.match(source, /removeItem\(operationKey\)[\s\S]*operation\.phase !== 'complete'/);
  });

  function controller(overrides = {}) {
    return {
      transcript: {
        chatState: 'idle',
        capabilities: { resume: true },
        pendingPermissions: [],
        pendingQuestions: [],
        queuedTurns: [],
        ...overrides,
      },
    };
  }

  it('offers automatic restart only for a visibly idle resumable current chat', function () {
    assert.equal(mod.chatLooksAutomaticSafe(controller()), true);
    assert.equal(mod.chatLooksAutomaticSafe(controller({ chatState: 'running' })), false);
    assert.equal(mod.chatLooksAutomaticSafe(controller({ capabilities: { resume: false } })), false);
    assert.equal(mod.chatLooksAutomaticSafe(controller({ pendingQuestions: [{}] })), false);
    assert.equal(mod.chatLooksAutomaticSafe(controller({ queuedTurns: [{}] })), false);
  });
});

describe('active-session maintenance visibility', function () {
  const operation = (phase) => ({
    id: 'op-visibility', targetKey: 'target', agentId: 'claude', kind: 'update', phase,
    createdAt: 1, updatedAt: 2, version: '2.0.0', error: phase === 'failed' ? 'failed' : null,
    retryable: phase === 'failed', canCancel: !['complete', 'failed', 'cancelled'].includes(phase),
    cancelReason: null,
  });

  it('renders no banner while status is unknown or confirmed healthy', function () {
    assert.equal(mod.shouldShowActiveAgentMaintenance({}), false);
    assert.equal(mod.shouldShowActiveAgentMaintenance({ status: status() }), false);
    assert.equal(mod.shouldShowActiveAgentMaintenance({
      status: status({ check: 'unable_to_check', checkedAt: null }),
    }), false);
    assert.equal(mod.shouldShowActiveAgentMaintenance({
      status: status(),
      operation: operation('complete'),
    }), false);
    assert.equal(mod.shouldShowActiveAgentMaintenance({
      status: status(),
      operation: operation('cancelled'),
    }), false);
  });

  it('renders only for required work, progress, or an actual failure', function () {
    assert.equal(mod.shouldShowActiveAgentMaintenance({
      status: status({ state: 'missing', version: null, managedVersion: null }),
    }), true);
    assert.equal(mod.shouldShowActiveAgentMaintenance({
      status: status({ check: 'update_available', latestVersion: '2.0.0' }),
    }), true);
    assert.equal(mod.shouldShowActiveAgentMaintenance({
      status: status({ managedVersion: '2.0.0' }),
    }), true);
    assert.equal(mod.shouldShowActiveAgentMaintenance({
      status: status({ check: 'unable_to_check', checkedAt: 2 }),
    }), true);
    assert.equal(mod.shouldShowActiveAgentMaintenance({ status: status(), operation: operation('installing') }), true);
    assert.equal(mod.shouldShowActiveAgentMaintenance({ status: status(), operation: operation('failed') }), true);
    assert.equal(mod.shouldShowActiveAgentMaintenance({ status: status(), error: 'Target offline.' }), true);
  });
});
