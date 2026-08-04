const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AppDatabase } = require('../dist/server/services/database.js');
const { EncryptionKeyRing } = require('../dist/server/services/encryption.js');
const {
  EnvironmentManager,
  createContainerConfig,
} = require('../dist/server/services/environments/index.js');
const {
  CloneSourceChangedError,
  cloneRepository,
} = require('../dist/server/services/projects/clone.js');
const { ProjectManager } = require('../dist/server/services/projects/manager.js');
const { ProjectStore } = require('../dist/server/services/projects/store.js');

const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);

function inspection(sourceOid = OID_A) {
  return {
    catalogVersion: 'v1',
    sourceOid,
    sourceRef: 'refs/heads/main',
    forgeHint: null,
    detectedRuntimes: [{
      runtimeId: 'node',
      sources: ['package.json'],
      versionHints: [{ path: 'package.json', version: '22.14.0' }],
      selectedVersion: '22.14.0',
      versionSource: 'marker',
    }],
  };
}

function fakeEngine(timeline = []) {
  const known = new Map();
  const result = {
    kind: 'docker',
    binary: 'docker',
    timeline,
    onExec: null,
    async ensureIdentity(spec) {
      const existing = known.get(spec.name);
      timeline.push({ op: 'ensure', name: spec.name, spec });
      const description = {
        name: spec.name,
        identity: existing?.identity || `${spec.name}-identity`,
        status: 'running',
        image: spec.image,
        labels: spec.labels,
      };
      known.set(spec.name, description);
      return { created: !existing, identity: description.identity };
    },
    async describeStrict(name) {
      timeline.push({ op: 'describe', name });
      return known.get(name) || null;
    },
    async describe(name) { return this.describeStrict(name); },
    async stopIdentity(description) {
      timeline.push({ op: 'stop', name: description.name });
      const current = known.get(description.name);
      if (current) current.status = 'stopped';
    },
    async removeIdentity(description) {
      timeline.push({ op: 'remove', name: description.name });
      known.delete(description.name);
    },
    async exec(spec, command, args) {
      timeline.push({ op: 'exec', command, args: [...args], spec });
      if (result.onExec) return result.onExec(spec, command, args);
      return { stdout: '', stderr: '' };
    },
    async list() { timeline.push({ op: 'list' }); return []; },
    async available() { timeline.push({ op: 'available' }); return true; },
    execArgs() { return []; },
    async resize() { return true; },
    async usage() { return null; },
  };
  return result;
}

function harness(options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-composition-lifecycle-'));
  const database = new AppDatabase({ dataDir });
  const keyRing = new EncryptionKeyRing({
    settings: database,
    key: Buffer.alloc(32, 19).toString('base64'),
    warn: () => {},
  });
  const store = new ProjectStore({ database, keyRing });
  const user = database.upsertGitHubUser({ githubId: 'composition-lifecycle', githubLogin: 'ada' });
  const timeline = [];
  const engine = fakeEngine(timeline);
  const config = {
    ...createContainerConfig({ containers: true }, {}),
    rootDir: dataDir,
    extraMounts: [],
  };
  const environments = new EnvironmentManager({
    config,
    engine,
    hostHome: dataDir,
    engines: new Map([['legacy', engine]]),
    configs: new Map([['legacy', config]]),
    activeKey: 'legacy',
  });
  const manager = new ProjectManager({
    store,
    environments,
    deployTargets: {},
    authorFor: () => ({ name: 'Ada Lovelace', email: 'ada@example.test' }),
    ownerFor: () => ({ id: user.id, githubLogin: 'ada' }),
    broadcast: () => {},
    deleteProjectSessions: () => {},
    fetch: options.fetch || (async () => ({ status: 200 })),
    repositoryInspector: options.repositoryInspector,
    compositionRuntime: options.compositionRuntimeFactory
      ? options.compositionRuntimeFactory(store)
      : options.compositionRuntime,
    localWorkspaceRoot: path.join(dataDir, '.cc-web', 'workspaces'),
  });
  return {
    dataDir, database, store, user, timeline, engine, environments, manager,
    async close() {
      await manager.shutdown();
      database.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function installedRuntime(store) {
  return {
    async prepare(context) {
      for (const item of store.listCompositionInstallations(context.composition.id, context.project.ownerUserId)) {
        store.upsertCompositionInstallation(context.composition.id, item.itemId, {
          status: 'installed',
          installedVersion: context.chosen.runtimes.find((runtime) => runtime.runtimeId === item.itemId)?.version || '1.0.0',
          incrementAttempts: true,
        });
      }
      return { installations: store.listCompositionInstallations(context.composition.id, context.project.ownerUserId) };
    },
    async configureGit() {},
    async retryFailed() { throw new Error('nothing should require retry'); },
  };
}

describe('composition project lifecycle contracts', function () {
  this.timeout(10_000);

  it('clones and verifies the exact inspected OID, and classifies a mismatch as source drift', async function () {
    const calls = [];
    const engine = {
      async exec(spec, command, args) {
        calls.push({ spec, command, args: [...args] });
        if (command === '/bin/sh' && args.includes('rev-parse') && args.includes('--verify')) {
          return { stdout: `${OID_A}\n`, stderr: '' };
        }
        return { stdout: '', stderr: '' };
      },
    };
    await cloneRepository({
      engine,
      containerName: 'project-box',
      containerIdentity: 'immutable-container-id',
      repoUrl: 'https://example.test/team/repo.git',
      destination: '/workspace/repo',
      expectedOid: OID_A,
    });

    const commands = calls.map((call) => call.args.join(' '));
    const cloneAt = commands.findIndex((command) => / clone --no-checkout -- /.test(command));
    const fetchAt = commands.findIndex((command) => command.includes(`fetch --no-tags --no-recurse-submodules --depth=1 https://example.test/team/repo.git ${OID_A}`));
    const checkoutAt = commands.findIndex((command) => command.includes(`checkout --detach --force ${OID_A}`));
    const verifyAt = commands.findIndex((command) => command.includes('rev-parse --verify HEAD'));
    assert.ok(cloneAt >= 0 && cloneAt < fetchAt && fetchAt < checkoutAt && checkoutAt < verifyAt);
    assert.ok(calls.every((call) => call.spec.identity === 'immutable-container-id'));
    assert.ok(calls.some((call) => call.command === 'rm'
      && call.args[0] === '-rf' && call.args[1] === '--'
      && call.args[2].startsWith('/tmp/cawc-clone-')));

    const changedEngine = {
      async exec(_spec, command, args) {
        if (command === '/bin/sh' && args.includes('rev-parse') && args.includes('--verify')) {
          return { stdout: `${OID_B}\n`, stderr: '' };
        }
        return { stdout: '', stderr: '' };
      },
    };
    await assert.rejects(
      cloneRepository({
        engine: changedEngine,
        containerName: 'project-box',
        containerIdentity: 'immutable-container-id',
        repoUrl: 'https://example.test/team/repo.git',
        destination: '/workspace/repo',
        expectedOid: OID_A,
      }),
      (error) => error instanceof CloneSourceChangedError && /changed.*reviewed/i.test(error.message),
    );
  });

  it('stages repository and empty projects for review without invoking an engine', async function () {
    let releaseInspection;
    const inspectionGate = new Promise((resolve) => { releaseInspection = resolve; });
    const h = harness({
      repositoryInspector: { inspect: async () => inspectionGate },
    });
    try {
      const repository = await h.manager.createForComposition(h.user.id, {
        name: 'repository project',
        repoUrl: 'https://example.test/team/repo.git',
      });
      assert.strictEqual(repository.ok, true);
      assert.strictEqual(repository.project.state, 'inspecting');
      assert.deepStrictEqual(h.timeline, [], 'inspection review creates or starts no runtime');

      releaseInspection(inspection(OID_A));
      await h.manager.waitForInspection(repository.project.id);
      assert.strictEqual(h.store.getProject(repository.project.id).state, 'composition_pending');
      assert.strictEqual(h.store.countRunning(h.user.id), 0);
      assert.deepStrictEqual(h.timeline, []);

      const empty = await h.manager.createForComposition(h.user.id, { name: 'empty project' });
      assert.strictEqual(empty.ok, true);
      assert.strictEqual(empty.project.state, 'composition_pending');
      assert.strictEqual(h.store.countRunning(h.user.id), 0);
      const view = h.manager.getComposition(h.user.id, empty.project.id);
      assert.strictEqual(view.ok, true);
      assert.ok(view.composition.revision, 'a no-repository project still receives a reviewable draft');
      assert.strictEqual(view.composition.activeRevision, null);
      assert.deepStrictEqual(view.composition.chosen.runtimes, []);
      assert.deepStrictEqual(h.timeline, []);

      const local = await h.manager.createForComposition(h.user.id, {
        name: 'local project',
        local: true,
      });
      assert.strictEqual(local.ok, true);
      assert.strictEqual(local.project.executionKind, 'host');
      assert.strictEqual(local.project.targetId, null);
      assert.strictEqual(local.project.tierId, null);
      assert.deepStrictEqual(h.timeline, [], 'a local override never contacts the active target');
    } finally {
      await h.close();
    }
  });

  it('refreshes a changed source before confirmation and never admits an engine build', async function () {
    let inspections = 0;
    const h = harness({
      repositoryInspector: { inspect: async () => inspection(inspections++ === 0 ? OID_A : OID_B) },
    });
    try {
      const created = await h.manager.createForComposition(h.user.id, {
        name: 'moving source',
        repoUrl: 'https://example.test/team/repo.git',
      });
      await h.manager.waitForInspection(created.project.id);
      const before = h.manager.getComposition(h.user.id, created.project.id);
      await new Promise((resolve) => setTimeout(resolve, 2));
      const confirmed = await h.manager.confirmComposition(h.user.id, created.project.id, {
        revision: before.composition.revision,
        expectedRevision: null,
        acknowledgeRebuild: false,
      });
      assert.strictEqual(confirmed.ok, false);
      assert.strictEqual(confirmed.reason, 'source_changed');
      assert.strictEqual(confirmed.composition.detected.sourceOid, OID_B);
      const project = h.store.getProject(created.project.id);
      assert.strictEqual(project.state, 'composition_pending');
      assert.strictEqual(project.compositionRevision, null);
      assert.strictEqual(project.appliedCompositionRevision, null);
      assert.deepStrictEqual(h.timeline, []);
    } finally {
      await h.close();
    }
  });

  it('preserves and removes the old runtime before activating and building a replacement recipe', async function () {
    const h = harness({
      repositoryInspector: { inspect: async () => inspection(OID_A) },
      compositionRuntimeFactory: installedRuntime,
    });
    try {
      const created = await h.manager.createForComposition(h.user.id, {
        name: 'rebuild ordering',
        repoUrl: 'https://example.test/team/repo.git',
      });
      await h.manager.waitForInspection(created.project.id);
      const initial = h.manager.getComposition(h.user.id, created.project.id).composition;
      const checkout = path.join(h.dataDir, 'projects', created.project.id, 'repo');
      h.engine.onExec = (_spec, command, args) => {
        if (command === '/bin/sh' && args.includes('clone')) {
          fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
        }
        if (command === '/bin/sh' && args.includes('rev-parse') && args.includes('--verify')) {
          return { stdout: `${OID_A}\n`, stderr: '' };
        }
        return { stdout: '', stderr: '' };
      };
      assert.deepStrictEqual(await h.manager.confirmComposition(h.user.id, created.project.id, {
        revision: initial.revision,
        expectedRevision: null,
        acknowledgeRebuild: false,
      }), { ok: true, state: 'building' });
      await h.manager.waitForBuild(created.project.id);
      assert.strictEqual(h.store.getProject(created.project.id).state, 'running');

      await new Promise((resolve) => setTimeout(resolve, 2));
      const rejectedAgent = await h.manager.saveComposition(h.user.id, created.project.id, {
        expectedRevision: initial.revision,
        runtimes: [{ runtimeId: 'node', version: '22.15.0' }],
        agents: [{ runtimeId: 'codex', version: 'latest' }],
        forgeKind: 'gitea',
      });
      assert.deepStrictEqual(rejectedAgent, {
        ok: false,
        reason: 'validation',
        detail: 'Agent runtime versions must match the catalog pin',
      });
      const saved = await h.manager.saveComposition(h.user.id, created.project.id, {
        expectedRevision: initial.revision,
        runtimes: [{ runtimeId: 'node', version: '22.15.0' }],
        agents: [{ runtimeId: 'codex', version: '0.146.0' }],
        forgeKind: 'gitea',
      });
      assert.strictEqual(saved.ok, true, JSON.stringify(saved));
      assert.deepStrictEqual(saved.composition.chosen.agents, [
        { runtimeId: 'codex', version: '0.146.0' },
      ]);
      assert.ok(saved.composition.installations.some((item) => item.itemId === 'agent-codex'));
      const replacement = saved.composition.revision;
      assert.notStrictEqual(replacement, initial.revision);

      h.timeline.length = 0;
      const originalTryStart = h.store.tryStartCounted.bind(h.store);
      h.store.tryStartCounted = (input) => {
        h.timeline.push({
          op: 'activate',
          activeBefore: h.store.getProject(created.project.id).compositionRevision,
        });
        return originalTryStart(input);
      };
      const rebuilt = await h.manager.confirmComposition(h.user.id, created.project.id, {
        revision: replacement,
        expectedRevision: initial.revision,
        acknowledgeRebuild: true,
      });
      assert.deepStrictEqual(rebuilt, { ok: true, state: 'building' });
      await h.manager.waitForBuild(created.project.id);

      const preserveAt = h.timeline.findIndex((event) => event.op === 'exec'
        && event.command === 'git' && event.args.includes('status'));
      const removeAt = h.timeline.findIndex((event) => event.op === 'remove');
      const activateAt = h.timeline.findIndex((event) => event.op === 'activate');
      const ensureAfterActivation = h.timeline.findIndex((event, index) => index > activateAt && event.op === 'ensure');
      assert.ok(preserveAt >= 0 && preserveAt < removeAt && removeAt < activateAt && activateAt < ensureAfterActivation,
        JSON.stringify(h.timeline));
      assert.strictEqual(h.timeline[activateAt].activeBefore, initial.revision);
      const project = h.store.getProject(created.project.id);
      assert.strictEqual(project.state, 'running');
      assert.strictEqual(project.compositionRevision, replacement);
      assert.strictEqual(project.appliedCompositionRevision, replacement);
    } finally {
      await h.close();
    }
  });

  it('does not activate a confirmed recipe when admission fails and treats an applied running confirmation as idempotent', async function () {
    const h = harness({ compositionRuntimeFactory: installedRuntime });
    try {
      const created = await h.manager.createForComposition(h.user.id, { name: 'atomic confirmation' });
      const composition = h.manager.getComposition(h.user.id, created.project.id).composition;
      h.store.runLimitPerUser = () => 0;

      const rejected = await h.manager.confirmComposition(h.user.id, created.project.id, {
        revision: composition.revision,
        expectedRevision: null,
        acknowledgeRebuild: false,
      });
      assert.strictEqual(rejected.ok, false);
      assert.strictEqual(rejected.reason, 'run_limit');
      let project = h.store.getProject(created.project.id);
      assert.strictEqual(project.state, 'composition_pending');
      assert.strictEqual(project.compositionRevision, null);
      assert.strictEqual(project.appliedCompositionRevision, null);
      assert.deepStrictEqual(h.timeline, []);

      h.store.runLimitPerUser = () => 1;
      assert.deepStrictEqual(await h.manager.confirmComposition(h.user.id, created.project.id, {
        revision: composition.revision,
        expectedRevision: null,
        acknowledgeRebuild: false,
      }), { ok: true, state: 'building' });
      await h.manager.waitForBuild(created.project.id);
      project = h.store.getProject(created.project.id);
      assert.strictEqual(project.state, 'running');
      assert.strictEqual(project.compositionRevision, composition.revision);
      assert.strictEqual(project.appliedCompositionRevision, composition.revision);

      h.timeline.length = 0;
      assert.deepStrictEqual(await h.manager.confirmComposition(h.user.id, created.project.id, {
        revision: composition.revision,
        expectedRevision: composition.revision,
        acknowledgeRebuild: false,
      }), { ok: true, state: 'running' });
      assert.deepStrictEqual(h.timeline, [], 'idempotent confirmation does not stop, recreate, or rebuild');
    } finally {
      await h.close();
    }
  });

  it('revalidates a queued reinspection after confirmation and never exposes a pre-build runtime', async function () {
    let inspectionCalls = 0;
    let releaseConfirmationInspection;
    let confirmationInspectionStarted;
    const confirmationStarted = new Promise((resolve) => { confirmationInspectionStarted = resolve; });
    const confirmationGate = new Promise((resolve) => { releaseConfirmationInspection = resolve; });
    let releaseBuild;
    let buildStarted;
    const building = new Promise((resolve) => { buildStarted = resolve; });
    const buildGate = new Promise((resolve) => { releaseBuild = resolve; });
    const h = harness({
      repositoryInspector: {
        inspect: async () => {
          inspectionCalls += 1;
          if (inspectionCalls === 2) {
            confirmationInspectionStarted();
            await confirmationGate;
          }
          return inspection(OID_A);
        },
      },
      compositionRuntime: {
        async prepare(context) {
          buildStarted();
          await buildGate;
          return { installations: h.store.listCompositionInstallations(context.composition.id, h.user.id) };
        },
        async configureGit() {},
        async retryFailed() { return { installations: [] }; },
      },
    });
    try {
      const created = await h.manager.createForComposition(h.user.id, {
        name: 'serialized inspection',
        repoUrl: 'https://example.test/team/repo.git',
      });
      await h.manager.waitForInspection(created.project.id);
      const recipe = h.manager.getComposition(h.user.id, created.project.id).composition;
      const checkout = path.join(h.dataDir, 'projects', created.project.id, 'repo');
      h.engine.onExec = (_spec, command, args) => {
        if (command === '/bin/sh' && args.includes('clone')) {
          fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
        }
        if (command === '/bin/sh' && args.includes('rev-parse') && args.includes('--verify')) {
          return { stdout: `${OID_A}\n`, stderr: '' };
        }
        return { stdout: '', stderr: '' };
      };

      const confirmation = h.manager.confirmComposition(h.user.id, created.project.id, {
        revision: recipe.revision,
        expectedRevision: null,
        acknowledgeRebuild: false,
      });
      await confirmationStarted;
      const reinspection = h.manager.reinspectComposition(h.user.id, created.project.id);
      releaseConfirmationInspection();

      assert.deepStrictEqual(await confirmation, { ok: true, state: 'building' });
      const reinspected = await reinspection;
      assert.strictEqual(reinspected.ok, false);
      assert.strictEqual(reinspected.reason, 'not_found');
      await building;
      assert.strictEqual(h.store.getProject(created.project.id).state, 'building');
      assert.strictEqual(inspectionCalls, 2, 'queued reinspection must not run against stale running state');

      releaseBuild();
      await h.manager.waitForBuild(created.project.id);
      assert.strictEqual(h.store.getProject(created.project.id).state, 'running');
    } finally {
      releaseConfirmationInspection?.();
      releaseBuild?.();
      await h.close();
    }
  });

  it('forces an interrupted partial checkout to be wiped and rebuilt at the inspected OID', async function () {
    const h = harness({
      repositoryInspector: { inspect: async () => inspection(OID_A) },
      compositionRuntimeFactory: installedRuntime,
    });
    try {
      const created = await h.manager.createForComposition(h.user.id, {
        name: 'interrupted checkout',
        repoUrl: 'https://example.test/team/repo.git',
      });
      await h.manager.waitForInspection(created.project.id);
      const recipe = h.manager.getComposition(h.user.id, created.project.id).composition;
      assert.strictEqual(h.store.activateComposition({
        projectId: created.project.id,
        userId: h.user.id,
        expectedCurrentRevision: null,
        revision: recipe.revision,
      }), true);
      h.store.setState(created.project.id, 'building');
      const checkout = path.join(h.dataDir, 'projects', created.project.id, 'repo');
      fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
      fs.writeFileSync(path.join(checkout, 'partial-clone-marker'), 'must disappear');

      await h.manager.reconcileOnBoot();
      let project = h.store.getProject(created.project.id);
      assert.strictEqual(project.state, 'stopped');
      assert.strictEqual(project.rebuildRequired, true);

      h.engine.onExec = (_spec, command, args) => {
        if (command === '/bin/sh' && args.includes('clone')) {
          fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
        }
        if (command === '/bin/sh' && args.includes('rev-parse') && args.includes('--verify')) {
          return { stdout: `${OID_A}\n`, stderr: '' };
        }
        return { stdout: '', stderr: '' };
      };
      assert.deepStrictEqual(await h.manager.start(h.user.id, created.project.id), { ok: true, state: 'building' });
      await h.manager.waitForBuild(created.project.id);
      project = h.store.getProject(created.project.id);
      assert.strictEqual(project.state, 'running');
      assert.strictEqual(project.rebuildRequired, false);
      assert.strictEqual(fs.existsSync(path.join(checkout, 'partial-clone-marker')), false);
      assert.ok(h.timeline.some((entry) => entry.op === 'exec'
        && entry.command === '/bin/sh'
        && entry.args.join(' ').includes(`checkout --detach --force ${OID_A}`)));
    } finally {
      await h.close();
    }
  });

  it('orders credential replacement after an in-flight build and refreshes without recreating it', async function () {
    let h;
    let prepareStarted;
    let releasePrepare;
    const preparing = new Promise((resolve) => { prepareStarted = resolve; });
    const prepareGate = new Promise((resolve) => { releasePrepare = resolve; });
    const credentials = [];
    const runtime = {
      async prepare(context) {
        credentials.push(`prepare:${context.credential}`);
        h.store.upsertCompositionInstallation(context.composition.id, 'gh', {
          status: 'installed', installedVersion: '2.97.0', incrementAttempts: true,
        });
        prepareStarted();
        await prepareGate;
        return { installations: h.store.listCompositionInstallations(context.composition.id, h.user.id) };
      },
      async configureGit() {},
      async retryFailed() { return { installations: [] }; },
      async refreshForgeCredential(context) {
        credentials.push(`refresh:${context.credential}`);
      },
    };
    h = harness({
      compositionRuntime: runtime,
      repositoryInspector: { inspect: async () => inspection(OID_A) },
    });
    try {
      const oldHost = h.store.upsertConnectedHostToken(h.user.id, 'github.com', 'old-token');
      assert.strictEqual(h.store.setConnectedHostValidation({
        userId: h.user.id,
        host: 'github.com',
        kind: 'token',
        expectedCredentialRevision: oldHost.credentialRevision,
        forgeKind: 'github',
        status: 'valid',
      }), true);
      const created = await h.manager.createForComposition(h.user.id, {
        name: 'credential generation',
        repoUrl: 'https://github.com/team/repo.git',
      });
      await h.manager.waitForInspection(created.project.id);
      const draft = h.manager.getComposition(h.user.id, created.project.id).composition;
      const checkout = path.join(h.dataDir, 'projects', created.project.id, 'repo');
      h.engine.onExec = (_spec, command, args) => {
        if (command === '/bin/sh' && args.includes('clone')) {
          fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
        }
        if (command === '/bin/sh' && args.includes('rev-parse') && args.includes('--verify')) {
          return { stdout: `${OID_A}\n`, stderr: '' };
        }
        return { stdout: '', stderr: '' };
      };
      await new Promise((resolve) => setTimeout(resolve, 2));
      const saved = await h.manager.saveComposition(h.user.id, created.project.id, {
        expectedRevision: draft.revision,
        runtimes: [],
        forgeKind: 'github',
      });
      assert.strictEqual(saved.ok, true);
      assert.deepStrictEqual(await h.manager.confirmComposition(h.user.id, created.project.id, {
        revision: saved.composition.revision,
        expectedRevision: null,
        acknowledgeRebuild: false,
      }), { ok: true, state: 'building' });
      await preparing;

      let mutationRan = false;
      const replacement = h.manager.synchronizeHostCredentialReplacement(
        h.user.id,
        'github.com',
        () => {
          mutationRan = true;
          const host = h.store.upsertConnectedHostToken(h.user.id, 'github.com', 'new-token');
          h.store.setConnectedHostValidation({
            userId: h.user.id,
            host: 'github.com',
            kind: 'token',
            expectedCredentialRevision: host.credentialRevision,
            forgeKind: 'github',
            status: 'valid',
          });
        },
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.strictEqual(mutationRan, false, 'replacement waits for the project lifecycle owner');
      releasePrepare();
      await h.manager.waitForBuild(created.project.id);
      const engineOperationsBeforeRefresh = h.timeline.filter((entry) => entry.op === 'ensure').length;
      await replacement;

      assert.deepStrictEqual(credentials, ['prepare:old-token', 'refresh:new-token']);
      assert.strictEqual(h.timeline.filter((entry) => entry.op === 'ensure').length, engineOperationsBeforeRefresh,
        'credential replacement reuses the exact running container');
      const disconnected = await h.manager.disconnectHostCredentials(h.user.id, 'github.com');
      assert.deepStrictEqual(disconnected, { ok: true });
      assert.strictEqual(h.store.listConnectedHosts(h.user.id).length, 0);
      assert.ok(h.timeline.some((entry) => entry.op === 'exec' && entry.command === 'rm'
        && entry.args.includes('/run/code-agents-forge/gh')));
    } finally {
      releasePrepare?.();
      await h.close();
    }
  });

  it('scrubs a project that authenticated with the old generation while replacement waited', async function () {
    let h;
    let firstPrepareStarted;
    let releaseFirstPrepare;
    const firstPreparing = new Promise((resolve) => { firstPrepareStarted = resolve; });
    const firstGate = new Promise((resolve) => { releaseFirstPrepare = resolve; });
    let prepareCalls = 0;
    const credentialEvents = [];
    const runtime = {
      async prepare(context) {
        prepareCalls += 1;
        credentialEvents.push(`prepare:${context.project.id}:${context.credential}`);
        h.store.upsertCompositionInstallation(context.composition.id, 'gh', {
          status: 'installed', installedVersion: '2.97.0', incrementAttempts: true,
        });
        if (prepareCalls === 1) {
          firstPrepareStarted();
          await firstGate;
        }
        return { installations: h.store.listCompositionInstallations(context.composition.id, h.user.id) };
      },
      async configureGit() {},
      async retryFailed() { return { installations: [] }; },
      async refreshForgeCredential(context) {
        credentialEvents.push(`refresh:${context.project.id}:${context.credential}`);
      },
    };
    h = harness({ compositionRuntime: runtime });
    try {
      const oldHost = h.store.upsertConnectedHostToken(h.user.id, 'github.com', 'old-token');
      h.store.setConnectedHostValidation({
        userId: h.user.id,
        host: 'github.com',
        kind: 'token',
        expectedCredentialRevision: oldHost.credentialRevision,
        forgeKind: 'github',
        status: 'valid',
      });

      const checkoutByName = new Map();
      h.engine.onExec = (_spec, command, args) => {
        if (command === '/bin/sh' && args.includes('clone')) {
          const checkoutName = path.posix.basename(args.at(-1));
          const checkout = checkoutByName.get(checkoutName);
          if (checkout) fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
        }
        return { stdout: '', stderr: '' };
      };

      const stage = (name) => {
        const project = h.store.createProject({
          ownerUserId: h.user.id,
          name,
          repoUrl: `https://github.com/team/${name}.git`,
          repoHost: 'github.com',
          initialState: 'composition_pending',
        });
        checkoutByName.set(name, path.join(h.dataDir, 'projects', project.id, name));
        const draft = h.store.saveCompositionDraft({
          projectId: project.id,
          userId: h.user.id,
          catalogVersion: 'v1',
          detected: {},
          chosen: { runtimes: [], forgeKind: 'github' },
          forgeKind: 'github',
          forgeHost: 'github.com',
          installations: [{ itemId: 'gh' }],
        });
        return { project, draft };
      };
      const confirm = async ({ project, draft }) => {
        const result = await h.manager.confirmComposition(h.user.id, project.id, {
          revision: draft.id,
          expectedRevision: null,
          acknowledgeRebuild: false,
        });
        assert.deepStrictEqual(result, { ok: true, state: 'building' });
      };

      const first = stage('first-generation');
      await confirm(first);
      await firstPreparing;

      let mutationRan = false;
      const replacement = h.manager.synchronizeHostCredentialReplacement(
        h.user.id,
        'github.com',
        () => {
          mutationRan = true;
          const next = h.store.upsertConnectedHostToken(h.user.id, 'github.com', 'new-token');
          h.store.setConnectedHostValidation({
            userId: h.user.id,
            host: 'github.com',
            kind: 'token',
            expectedCredentialRevision: next.credentialRevision,
            forgeKind: 'github',
            status: 'valid',
          });
        },
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.strictEqual(mutationRan, false);

      // This project did not exist when replacement took its lifecycle
      // snapshot. It reaches the host queue first and legitimately uses the old
      // token before replacement obtains the owner/host generation lock.
      const late = stage('late-generation');
      await confirm(late);
      while (!h.timeline.some((entry) => entry.op === 'ensure'
        && Object.values(entry.spec.labels).includes(late.project.id))) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      await new Promise((resolve) => setImmediate(resolve));

      releaseFirstPrepare();
      await Promise.all([
        h.manager.waitForBuild(first.project.id),
        h.manager.waitForBuild(late.project.id),
        replacement,
      ]);

      assert.ok(credentialEvents.includes(`prepare:${first.project.id}:old-token`));
      assert.ok(credentialEvents.includes(`prepare:${late.project.id}:old-token`));
      assert.ok(credentialEvents.includes(`refresh:${first.project.id}:new-token`));
      assert.ok(credentialEvents.includes(`refresh:${late.project.id}:new-token`));
      const lateContainer = h.timeline.find((entry) => entry.op === 'ensure'
        && Object.values(entry.spec.labels).includes(late.project.id)).name;
      assert.ok(h.timeline.some((entry) => entry.op === 'exec'
        && entry.spec.name === lateContainer
        && entry.command === 'rm'
        && entry.args.includes('/run/code-agents-forge/gh')),
      'the post-snapshot runtime has its old tmpfs credential scrubbed');
    } finally {
      releaseFirstPrepare?.();
      await h.close();
    }
  });

  it('scrubs every affected live project before reporting a replacement refresh failure', async function () {
    let h;
    const runtime = {
      ...installedRuntime({
        listCompositionInstallations(...args) {
          return h.store.listCompositionInstallations(...args);
        },
        upsertCompositionInstallation(...args) {
          return h.store.upsertCompositionInstallation(...args);
        },
      }),
      async refreshForgeCredential(context) {
        h.timeline.push({ op: 'refresh-credential', projectId: context.project.id });
        throw new Error('simulated client login failure');
      },
    };
    h = harness({
      compositionRuntime: runtime,
      repositoryInspector: { inspect: async () => inspection(OID_A) },
    });
    try {
      const oldHost = h.store.upsertConnectedHostToken(h.user.id, 'github.com', 'old-token');
      h.store.setConnectedHostValidation({
        userId: h.user.id,
        host: 'github.com',
        kind: 'token',
        expectedCredentialRevision: oldHost.credentialRevision,
        forgeKind: 'github',
        status: 'valid',
      });

      let checkout = '';
      h.engine.onExec = (_spec, command, args) => {
        if (command === '/bin/sh' && args.includes('clone')) {
          fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
        }
        if (command === '/bin/sh' && args.includes('rev-parse') && args.includes('--verify')) {
          return { stdout: `${OID_A}\n`, stderr: '' };
        }
        return { stdout: '', stderr: '' };
      };

      const buildProject = async (name) => {
        const created = await h.manager.createForComposition(h.user.id, {
          name,
          repoUrl: `https://github.com/team/${name}.git`,
        });
        await h.manager.waitForInspection(created.project.id);
        const draft = h.manager.getComposition(h.user.id, created.project.id).composition;
        await new Promise((resolve) => setTimeout(resolve, 2));
        const saved = await h.manager.saveComposition(h.user.id, created.project.id, {
          expectedRevision: draft.revision,
          runtimes: [],
          forgeKind: 'github',
        });
        checkout = path.join(h.dataDir, 'projects', created.project.id, name);
        const confirmed = await h.manager.confirmComposition(h.user.id, created.project.id, {
          revision: saved.composition.revision,
          expectedRevision: null,
          acknowledgeRebuild: false,
        });
        assert.deepStrictEqual(confirmed, { ok: true, state: 'building' });
        await h.manager.waitForBuild(created.project.id);
        assert.strictEqual(h.store.getProject(created.project.id).state, 'running');
        return created.project.id;
      };

      const projectIds = [await buildProject('first'), await buildProject('second')];
      h.timeline.length = 0;
      await assert.rejects(
        h.manager.synchronizeHostCredentialReplacement(h.user.id, 'github.com', () => {
          const replacement = h.store.upsertConnectedHostToken(h.user.id, 'github.com', 'new-token');
          h.store.setConnectedHostValidation({
            userId: h.user.id,
            host: 'github.com',
            kind: 'token',
            expectedCredentialRevision: replacement.credentialRevision,
            forgeKind: 'github',
            status: 'valid',
          });
        }),
        /Could not refresh every live forge credential/,
      );

      const scrubIndexes = h.timeline
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => entry.op === 'exec' && entry.command === 'rm')
        .map(({ index }) => index);
      const refreshIndexes = h.timeline
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => entry.op === 'refresh-credential')
        .map(({ index }) => index);
      assert.strictEqual(scrubIndexes.length, 2);
      assert.deepStrictEqual(
        h.timeline.filter((entry) => entry.op === 'refresh-credential').map((entry) => entry.projectId).sort(),
        [...projectIds].sort(),
        'a failed client login does not prevent the other project from receiving the replacement attempt',
      );
      assert.ok(Math.max(...scrubIndexes) < Math.min(...refreshIndexes),
        'all old live credentials are scrubbed before any new login is attempted');
    } finally {
      await h.close();
    }
  });

  it('keeps partial installations runnable and retries failed items in the existing container only', async function () {
    let retryCalls = 0;
    let h;
    const runtime = {
      async prepare(context) {
        h.store.upsertCompositionInstallation(context.composition.id, 'node', {
          status: 'installed', installedVersion: '22.14.0', incrementAttempts: true,
        });
        h.store.upsertCompositionInstallation(context.composition.id, 'python', {
          status: 'failed', errorCode: 'download_failed', errorMessage: 'try again', incrementAttempts: true,
        });
        return { installations: h.store.listCompositionInstallations(context.composition.id, context.project.ownerUserId) };
      },
      async configureGit() {},
      async retryFailed(context) {
        retryCalls += 1;
        const before = h.store.listCompositionInstallations(context.composition.id, context.project.ownerUserId);
        assert.deepStrictEqual(before.map((item) => [item.itemId, item.status]).sort(), [
          ['node', 'installed'],
          ['python', 'failed'],
        ]);
        h.store.upsertCompositionInstallation(context.composition.id, 'python', {
          status: 'installed', installedVersion: '3.13.2', incrementAttempts: true,
        });
        return { installations: h.store.listCompositionInstallations(context.composition.id, context.project.ownerUserId) };
      },
    };
    h = harness({ compositionRuntime: runtime });
    try {
      const created = await h.manager.createForComposition(h.user.id, { name: 'partial tools' });
      const original = h.manager.getComposition(h.user.id, created.project.id).composition;
      await new Promise((resolve) => setTimeout(resolve, 2));
      const saved = await h.manager.saveComposition(h.user.id, created.project.id, {
        expectedRevision: original.revision,
        runtimes: [
          { runtimeId: 'node', version: '22.14.0' },
          { runtimeId: 'python', version: '3.13.2' },
        ],
      });
      assert.strictEqual(saved.ok, true);
      assert.deepStrictEqual(await h.manager.confirmComposition(h.user.id, created.project.id, {
        revision: saved.composition.revision,
        expectedRevision: null,
        acknowledgeRebuild: false,
      }), { ok: true, state: 'building' });
      await h.manager.waitForBuild(created.project.id);

      let project = h.store.getProject(created.project.id);
      assert.strictEqual(project.state, 'running');
      assert.match(project.stateDetail, /python/);
      assert.ok(project.buildLog.some((event) => event.t === 'partial_install'));
      assert.strictEqual(project.appliedCompositionRevision, saved.composition.revision);
      const beforeRetry = h.store.listCompositionInstallations(saved.composition.revision, h.user.id);
      assert.deepStrictEqual(beforeRetry.map((item) => [item.itemId, item.status, item.attempts]).sort(), [
        ['node', 'installed', 1],
        ['python', 'failed', 1],
      ]);

      h.timeline.length = 0;
      const retried = await h.manager.retryComposition(h.user.id, created.project.id);
      assert.strictEqual(retried.ok, true);
      assert.strictEqual(retryCalls, 1);
      assert.ok(!h.timeline.some((event) => ['ensure', 'remove', 'stop', 'exec'].includes(event.op)),
        'retry may describe the existing runtime but cannot recreate, preserve, wipe, clone, or stop it');
      const afterRetry = h.store.listCompositionInstallations(saved.composition.revision, h.user.id);
      assert.deepStrictEqual(afterRetry.map((item) => [item.itemId, item.status, item.attempts]).sort(), [
        ['node', 'installed', 1],
        ['python', 'installed', 2],
      ]);
      project = h.store.getProject(created.project.id);
      assert.strictEqual(project.state, 'running');
      assert.strictEqual(project.stateDetail, null);

      const noOp = await h.manager.retryComposition(h.user.id, created.project.id);
      assert.deepStrictEqual(noOp, { ok: true, installations: [] });
      assert.strictEqual(retryCalls, 1, 'an all-installed recipe never calls the retry adapter');
    } finally {
      await h.close();
    }
  });
});
