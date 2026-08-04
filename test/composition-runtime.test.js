const assert = require('assert');

const {
  DefaultCompositionRuntime,
  compositionInstallationItems,
} = require('../dist/server/services/composition/runtime.js');
const {
  FORGE_SCRATCH_ROOT,
} = require('../dist/server/services/composition/forge.js');

const SCRATCH_PATHS = [
  `${FORGE_SCRATCH_ROOT}/home`,
  `${FORGE_SCRATCH_ROOT}/xdg`,
  `${FORGE_SCRATCH_ROOT}/gh`,
  `${FORGE_SCRATCH_ROOT}/glab`,
  `${FORGE_SCRATCH_ROOT}/tea`,
];

function fixture(options = {}) {
  const timeline = [];
  const installationUpdates = [];
  const validationUpdates = [];
  const record = options.record === undefined
    ? { token: 'current-token', kind: 'token', revision: 7 }
    : options.record;
  const installations = options.installations || [{ itemId: 'gh', status: 'installed' }];
  const store = {
    credentialRecordFor(userId, host) {
      timeline.push({ op: 'credential', userId, host });
      return record;
    },
    listCompositionInstallations(compositionId, userId) {
      timeline.push({ op: 'installations', compositionId, userId });
      return installations;
    },
    updateCompositionInstallationForUser(input) {
      installationUpdates.push(input);
      return null;
    },
    setConnectedHostValidation(input) {
      validationUpdates.push(input);
      return true;
    },
  };
  const engine = {
    async exec(spec, command, args) {
      timeline.push({ op: 'exec', spec, command, args: [...args] });
      if (options.onExec) return options.onExec(spec, command, args);
      return { stdout: '', stderr: '' };
    },
  };
  const context = {
    project: { ownerUserId: 42 },
    composition: { id: 'composition-1', forgeHost: 'github.com' },
    chosen: { forgeKind: 'github', runtimes: [] },
    containerName: 'project-box',
    containerIdentity: 'immutable-container-id',
    engine,
    ownerHomeHost: '/srv/owners/42',
    ownerHomeContainer: '/home/owner',
    projectOverlayHost: '/srv/projects/project-1/composition',
    checkoutContainerPath: '/workspace/project-1',
    credential: 'current-token',
    credentialKind: 'token',
    credentialRevision: 7,
    identity: { name: 'Owner', email: 'owner@example.test' },
    globalIdentity: { name: 'Owner', email: 'owner@example.test' },
    projectIdentity: null,
    ...options.context,
  };
  return {
    runtime: new DefaultCompositionRuntime(store),
    context,
    timeline,
    installationUpdates,
    validationUpdates,
  };
}

function execCalls(fixtureValue) {
  return fixtureValue.timeline.filter((entry) => entry.op === 'exec');
}

describe('default composition runtime credential refresh', function () {
  it('turns selected agents into pinned installer items with only the missing language foundations', function () {
    const h = fixture({
      context: {
        chosen: {
          forgeKind: null,
          runtimes: [
            { runtimeId: 'python', version: '3.13.2' },
            { runtimeId: 'php', version: '8.4.22' },
          ],
          agents: [
            { runtimeId: 'codex', version: '0.146.0' },
            { runtimeId: 'kimi', version: '1.49.0' },
          ],
        },
      },
    });

    assert.deepStrictEqual(compositionInstallationItems(h.context), [
      { id: 'python', tool: 'python', version: '3.13.2' },
      { id: 'php', tool: 'php', version: '8.4.22' },
      { id: 'agent-foundation-node', tool: 'node', version: '22.14.0' },
      { id: 'agent-codex', tool: 'agent-codex', version: '0.146.0' },
      { id: 'agent-kimi', tool: 'agent-kimi', version: '1.49.0' },
    ]);
  });

  it('scrubs every fixed tmpfs client path before authenticating', async function () {
    const h = fixture();

    await h.runtime.refreshForgeCredential(h.context);

    const calls = execCalls(h);
    assert.deepStrictEqual(calls.map((call) => call.command), ['rm', 'gh']);
    assert.deepStrictEqual(calls[0].args, ['-rf', '--', ...SCRATCH_PATHS]);
    assert.strictEqual(calls[0].spec.cwd, FORGE_SCRATCH_ROOT);
    assert.deepStrictEqual(calls[1].args, [
      'auth', 'login', '--hostname', 'github.com', '--with-token',
    ]);
    assert.strictEqual(calls[1].spec.input, 'current-token\n');
    assert.strictEqual(calls[1].args.includes('current-token'), false);
  });

  it('rejects a stale credential revision after scrubbing without materializing it', async function () {
    const h = fixture({
      record: { token: 'replacement-token', kind: 'token', revision: 8 },
    });

    await assert.rejects(
      h.runtime.refreshForgeCredential(h.context),
      /Forge credential changed while the project was being prepared/,
    );

    const calls = execCalls(h);
    assert.deepStrictEqual(calls.map((call) => call.command), ['rm']);
    assert.deepStrictEqual(calls[0].args, ['-rf', '--', ...SCRATCH_PATHS]);
    assert.strictEqual(h.timeline.some((entry) => entry.op === 'installations'), false);
    assert.deepStrictEqual(h.installationUpdates, []);
    assert.deepStrictEqual(h.validationUpdates, []);
  });

  it('throws strictly when live credential rematerialization fails', async function () {
    const h = fixture({
      onExec: async (_spec, command) => {
        if (command === 'gh') throw new Error('secret remote diagnostic');
        return { stdout: '', stderr: '' };
      },
    });

    await assert.rejects(
      h.runtime.refreshForgeCredential(h.context),
      (error) => {
        assert.strictEqual(error.message, 'Could not authenticate gh for github.com');
        assert.strictEqual(error.message.includes('secret remote diagnostic'), false);
        return true;
      },
    );

    assert.deepStrictEqual(execCalls(h).map((call) => call.command), ['rm', 'gh']);
    assert.deepStrictEqual(h.installationUpdates, [{
      compositionId: 'composition-1',
      userId: 42,
      itemId: 'gh',
      patch: {
        status: 'failed',
        errorCode: 'FORGE_AUTH_FAILED',
        errorMessage: 'Could not authenticate gh for github.com',
      },
    }]);
    assert.deepStrictEqual(h.validationUpdates, [{
      userId: 42,
      host: 'github.com',
      kind: 'token',
      expectedCredentialRevision: 7,
      forgeKind: 'github',
      status: 'invalid',
      errorCode: 'credential_rejected',
      errorMessage: 'Credential was rejected when the forge client was prepared',
    }]);
  });

  it('scrubs successfully when the current invalid credential resolves to null', async function () {
    const h = fixture({
      record: null,
      context: {
        credential: null,
        credentialKind: null,
        credentialRevision: null,
      },
    });

    await h.runtime.refreshForgeCredential(h.context);

    const calls = execCalls(h);
    assert.deepStrictEqual(calls.map((call) => call.command), ['rm']);
    assert.deepStrictEqual(calls[0].args, ['-rf', '--', ...SCRATCH_PATHS]);
    assert.strictEqual(h.timeline.some((entry) => entry.op === 'installations'), false);
    assert.deepStrictEqual(h.installationUpdates, []);
    assert.deepStrictEqual(h.validationUpdates, []);
  });
});
