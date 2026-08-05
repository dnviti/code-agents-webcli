const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const { ContainerEngine } = require('../dist/server/services/environments/engine.js');
const { KubernetesEngine } = require('../dist/server/services/environments/kubernetes.js');
const {
  FORGE_SCRATCH,
  PROJECT_OVERLAY,
  ProjectEnvironmentManager,
  projectContainerEnvironment,
} = require('../dist/server/services/projects/environment.js');

describe('composition container foundations', function () {
  it('uses an owner-only tmpfs for Docker and Podman', function () {
    const createArgs = (kind, memoryMounts) => new ContainerEngine({
      kind, runner: async () => ({ stdout: '', stderr: '' }), relabelMounts: false, uid: 1234, gid: 2345,
    }).createArgs({
      name: 'project', image: 'image', mounts: [], memoryMounts,
      containerHome: '/home/owner', cpus: null, memory: null, labels: {}, env: {},
    });

    const dockerArgs = createArgs('docker', [{ containerPath: FORGE_SCRATCH }]);
    const dockerIndex = dockerArgs.indexOf('--tmpfs');
    assert.strictEqual(dockerArgs[dockerIndex + 1], `${FORGE_SCRATCH}:rw,noexec,nosuid,nodev,uid=1234,gid=2345,mode=0700`);

    const podmanArgs = createArgs('podman', [{ containerPath: FORGE_SCRATCH }]);
    const podmanIndex = podmanArgs.indexOf('--mount');
    assert.strictEqual(podmanArgs[podmanIndex + 1], `type=tmpfs,destination=${FORGE_SCRATCH},rw,noexec,nosuid,nodev,U=true,tmpfs-mode=0700`);

    for (const kind of ['docker', 'podman']) {
      assert.throws(() => createArgs(kind, [{ containerPath: '/run/x', mode: 0o770 }]), /only to its owner/);
    }
  });

  it('aligns Kubernetes identity and mounts only a 0700 child of memory emptyDir', function () {
    const engine = new KubernetesEngine({
      runner: async () => ({ stdout: '', stderr: '' }), namespace: 'workspaces', storageClaim: 'shared',
      rootDir: '/srv/environments', uid: 1234, gid: 2345,
    });
    const manifest = engine.podManifest({
      name: 'project', image: 'image', mounts: [{ hostPath: '/srv/environments/home', containerPath: '/home/owner' }],
      memoryMounts: [{ containerPath: FORGE_SCRATCH, mode: 0o700 }], containerHome: '/home/owner',
      cpus: null, memory: null, labels: {}, env: {},
    });
    assert.deepStrictEqual(manifest.spec.securityContext, {
      runAsNonRoot: true, runAsUser: 1234, runAsGroup: 2345, fsGroup: 2345, fsGroupChangePolicy: 'OnRootMismatch',
    });
    assert.ok(manifest.spec.volumes.some((volume) => volume.name === 'memory-0' && volume.emptyDir.medium === 'Memory'));
    assert.ok(manifest.spec.containers[0].volumeMounts.some((mount) => mount.mountPath === FORGE_SCRATCH && mount.subPath === 'owner'));
    const init = manifest.spec.initContainers[0];
    assert.strictEqual(init.securityContext.runAsUser, 1234);
    assert.ok(init.command.includes('set -eu; while test "$#" -gt 0; do mode=$1; directory=$2; shift 2; mkdir -m "$mode" "$directory/owner"; done'));
    assert.ok(init.command.includes('0700'));
  });

  it('mounts one project overlay only into its own container with secret-free path metadata', async function () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-overlays-'));
    const descriptions = new Map();
    const specs = [];
    const engine = {
      kind: 'docker', binary: 'docker',
      async describeStrict(name) { return descriptions.get(name) || null; },
      async ensureIdentity(spec) {
        specs.push(spec);
        const description = { name: spec.name, identity: `${spec.name}-id`, status: 'running', image: spec.image, labels: spec.labels };
        descriptions.set(spec.name, description);
        return { created: true, identity: description.identity };
      },
    };
    const target = { key: 'legacy', config: {
      rootDir: root, namePrefix: 'cawc', image: 'image', cpus: null, memory: null,
      tiers: [], extraMounts: [],
    }, engine };
    const environments = {
      projectTarget: () => target,
      projectStorageRoot: () => path.join(root, 'projects'),
      ownerHomeOnTarget: (owner) => ({ hostPath: path.join(root, `owner-${owner.id}`), containerPath: `/home/${owner.githubLogin}` }),
      intendedTierOnTarget: () => null,
    };
    const manager = new ProjectEnvironmentManager(environments);
    const owner = { id: 7, githubLogin: 'ada' };
    const project = (id) => ({ id, ownerUserId: 7, name: id, repoUrl: null, repoHost: null, targetId: null, tierId: null, state: 'building', stateDetail: null, container: null, rebuildRequired: false, buildLog: [], lastActivityAt: new Date().toISOString(), lastPreservedCommit: null, lastPreservedBranch: null, compositionRevision: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const one = project('one');
    const two = project('two');
    const first = await manager.ensure(one, owner);
    await manager.ensure(two, owner);
    assert.deepStrictEqual(first.environment.shells, ['bash']);
    const firstOverlay = specs[0].mounts.find((mount) => mount.containerPath === PROJECT_OVERLAY);
    assert.strictEqual(firstOverlay.hostPath, path.join(root, 'project-overlays', 'one'));
    assert.ok(!specs[0].mounts.some((mount) => mount.hostPath === path.join(root, 'project-overlays', 'two')));
    assert.deepStrictEqual(specs[0].memoryMounts, [{ containerPath: FORGE_SCRATCH, mode: 0o700 }]);
    assert.strictEqual(specs[0].containerHome, '/home/ada');
    assert.strictEqual(fs.statSync(firstOverlay.hostPath).mode & 0o777, 0o700);
    const env = projectContainerEnvironment('/home/ada', 'ada');
    assert.strictEqual(env.MISE_CONFIG_FILE, `${PROJECT_OVERLAY}/mise.toml`);
    assert.ok(env.PATH.startsWith('/home/ada/.local/share/code-agents/mise/shims:'));
    assert.ok(env.PATH.includes(':/home/ada/.local/bin:'));
    assert.strictEqual(JSON.stringify(env).includes('secret'), false);
    assert.ok([env.GH_CONFIG_DIR, env.GLAB_CONFIG_DIR, env.TEA_CONFIG].every((value) => value.startsWith(FORGE_SCRATCH)));
    one.container = { name: specs[0].name, shells: ['sh'] };
    const beforeExisting = specs.length;
    const existing = await manager.existing(one, owner);
    assert.strictEqual(existing.created, false);
    assert.strictEqual(existing.containerAccess.containerIdentity, `${specs[0].name}-id`);
    assert.deepStrictEqual(existing.environment.shells, ['bash'], 'legacy project metadata cannot downgrade the terminal');
    assert.strictEqual(specs.length, beforeExisting, 'existing access never ensures or creates');
    await manager.removeOverlay(one);
    assert.ok(!fs.existsSync(firstOverlay.hostPath));
    assert.ok(fs.existsSync(specs[1].mounts.find((mount) => mount.containerPath === PROJECT_OVERLAY).hostPath));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('retains workspace-local session storage in place across checkout and workspace replacement', async function () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-session-lifecycle-'));
    const environments = {
      projectStorageRoot: () => path.join(root, 'projects'),
      projectTarget: () => ({ config: { rootDir: root } }),
    };
    const manager = new ProjectEnvironmentManager(environments);
    const owner = { id: 7, githubLogin: 'ada' };
    const now = new Date().toISOString();
    const project = {
      id: 'one', ownerUserId: owner.id, name: 'one', repoUrl: 'https://example.test/repository.git',
      repoHost: 'example.test', targetId: null, tierId: null, executionKind: 'container', state: 'building',
      stateDetail: null, container: null, rebuildRequired: true, buildLog: [], lastActivityAt: now,
      lastPreservedCommit: null, lastPreservedBranch: null, compositionRevision: null, createdAt: now, updatedAt: now,
    };
    const workspace = manager.worktreePath(project, owner);
    const checkout = manager.checkoutPath(project, owner);
    const storage = manager.workspaceSessionStoragePath(project, owner);
    assert.strictEqual(storage, path.join(workspace, '.cc-web'));
    fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
    fs.mkdirSync(path.join(storage, 'sessions', 'owner', 'session-one'), { recursive: true });
    fs.writeFileSync(path.join(storage, 'session-state.sqlite'), Buffer.from([0, 1, 2, 255]));
    fs.writeFileSync(path.join(storage, 'sessions', 'owner', 'session-one', 'chat.jsonl'), '{"seq":1}\n');
    const storageIdentity = fs.statSync(storage);

    await manager.clearCheckout(project, owner);
    assert.ok(!fs.existsSync(checkout));
    assert.strictEqual(fs.statSync(storage).mode & 0o777, 0o700);
    assert.deepStrictEqual(fs.readFileSync(path.join(storage, 'session-state.sqlite')), Buffer.from([0, 1, 2, 255]));

    // A repository may contain its own tracked `.cc-web`. It is disposable
    // checkout content and cannot collide with the archive beside the checkout.
    fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
    const checkoutStorage = path.join(checkout, '.cc-web');
    fs.mkdirSync(checkoutStorage);
    fs.writeFileSync(path.join(checkoutStorage, 'session-state.sqlite'), 'repository bytes');
    await manager.clearCheckout(project, owner);
    assert.ok(!fs.existsSync(checkoutStorage));
    assert.deepStrictEqual(fs.readFileSync(path.join(storage, 'session-state.sqlite')), Buffer.from([0, 1, 2, 255]));

    // A full rebuild removes every other project byte but leaves the archive
    // on the same inode path; no installation-global or overlay copy exists.
    fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'scratch.txt'), 'discard me');
    await manager.clearWorkspaceForRebuild(project, owner);
    assert.ok(!fs.existsSync(checkout));
    assert.ok(!fs.existsSync(path.join(workspace, 'scratch.txt')));
    const retainedIdentity = fs.statSync(storage);
    assert.strictEqual(retainedIdentity.dev, storageIdentity.dev);
    assert.strictEqual(retainedIdentity.ino, storageIdentity.ino, 'the archive remains in place instead of being copied back');
    assert.strictEqual(await manager.restoreWorkspaceSessionStorage(project, owner), true);
    assert.strictEqual(fs.statSync(storage).mode & 0o777, 0o700);
    assert.deepStrictEqual(fs.readFileSync(path.join(storage, 'session-state.sqlite')), Buffer.from([0, 1, 2, 255]));
    assert.strictEqual(fs.readFileSync(path.join(storage, 'sessions', 'owner', 'session-one', 'chat.jsonl'), 'utf8'), '{"seq":1}\n');
    assert.ok(!fs.existsSync(path.join(root, 'project-overlays', project.id, 'workspace-session-storage')));

    // Once the composition root has suspended an open database, losing the
    // retained archive is a hard preservation failure.  The rebuild must not
    // continue and make the missing state look like a successful empty reset.
    fs.rmSync(storage, { recursive: true, force: true });
    fs.writeFileSync(path.join(workspace, 'keep-on-failure.txt'), 'still here');
    await assert.rejects(
      () => manager.clearWorkspaceForRebuild(project, owner, true),
      /session storage disappeared before project rebuild/,
    );
    assert.strictEqual(fs.readFileSync(path.join(workspace, 'keep-on-failure.txt'), 'utf8'), 'still here');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps a durable bigint inode intent until the restored database lease is confirmed', async function () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-session-intent-'));
    const environments = {
      projectStorageRoot: () => path.join(root, 'projects'),
      projectTarget: () => ({ config: { rootDir: root } }),
    };
    const manager = new ProjectEnvironmentManager(environments);
    const owner = { id: 7, githubLogin: 'ada' };
    const now = new Date().toISOString();
    const project = {
      id: 'one', ownerUserId: owner.id, name: 'one', repoUrl: null,
      repoHost: null, targetId: null, tierId: null, executionKind: 'container', state: 'building',
      stateDetail: null, container: null, rebuildRequired: true, buildLog: [], lastActivityAt: now,
      lastPreservedCommit: null, lastPreservedBranch: null, compositionRevision: null, createdAt: now, updatedAt: now,
    };
    const storage = manager.workspaceSessionStoragePath(project, owner);
    fs.mkdirSync(storage, { recursive: true });
    fs.writeFileSync(path.join(storage, 'session-state.sqlite'), 'authoritative archive');

    const identity = await manager.workspaceSessionStorageIdentity(project, owner);
    assert.strictEqual(typeof identity.dev, 'bigint');
    assert.strictEqual(typeof identity.ino, 'bigint');
    await manager.recordWorkspaceSessionStorageIntent(project, owner, identity);

    const coldManager = new ProjectEnvironmentManager(environments);
    assert.strictEqual(
      await coldManager.restoreWorkspaceSessionStorage(project, owner, identity),
      true,
      'an already-canonical archive accepts the bigint lease identity',
    );
    assert.strictEqual(
      await coldManager.hasStagedWorkspaceSessionStorage(project, owner),
      true,
      'restore retains the intent until integration reopens SQLite',
    );
    const recovery = await coldManager.workspaceSessionStorageRecoveryIdentity(project, owner);
    assert.deepStrictEqual(recovery, identity);
    await coldManager.completeWorkspaceSessionStorageRestore(project, owner, recovery);
    assert.strictEqual(await coldManager.hasStagedWorkspaceSessionStorage(project, owner), false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('stages the admitted archive outside child-rm rename swaps and recovers it without overwriting', async function () {
    for (const operation of ['clearWorkspaceForRebuild', 'clearCheckout']) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `project-session-child-swap-${operation}-`));
      const environments = {
        projectStorageRoot: () => path.join(root, 'projects'),
        projectTarget: () => ({ config: { rootDir: root } }),
      };
      const manager = new ProjectEnvironmentManager(environments);
      const owner = { id: 7, githubLogin: 'ada' };
      const now = new Date().toISOString();
      const project = {
        id: 'one', ownerUserId: owner.id, name: 'one', repoUrl: 'https://example.test/repository.git',
        repoHost: 'example.test', targetId: null, tierId: null, executionKind: 'container', state: 'building',
        stateDetail: null, container: null, rebuildRequired: true, buildLog: [], lastActivityAt: now,
        lastPreservedCommit: null, lastPreservedBranch: null, compositionRevision: null, createdAt: now, updatedAt: now,
      };
      const workspace = manager.worktreePath(project, owner);
      const checkout = manager.checkoutPath(project, owner);
      const storage = manager.workspaceSessionStoragePath(project, owner);
      const staging = path.join(path.dirname(workspace), '.one.ccweb-session-storage-retained');
      const attackerStorage = path.join(root, `attacker-storage-${operation}`);
      fs.mkdirSync(path.join(storage, 'sessions'), { recursive: true });
      fs.writeFileSync(path.join(storage, 'session-state.sqlite'), 'authoritative archive');
      fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
      fs.writeFileSync(path.join(workspace, 'scratch.txt'), 'discardable');
      fs.mkdirSync(attackerStorage, { recursive: true });
      fs.writeFileSync(path.join(attackerStorage, 'attacker.txt'), 'must not be deleted');

      const originalRm = fsp.rm;
      let swapped = false;
      fsp.rm = async (target, options) => {
        if (!swapped) {
          swapped = true;
          assert.strictEqual(fs.existsSync(storage), false, 'the authoritative inode is already outside the mutable workspace');
          assert.strictEqual(fs.readFileSync(path.join(staging, 'session-state.sqlite'), 'utf8'), 'authoritative archive');
          fs.renameSync(attackerStorage, storage);
        }
        return originalRm(target, options);
      };
      try {
        await assert.rejects(
          () => manager[operation](project, owner, true),
          /session storage name was occupied before restoration/,
        );
      } finally {
        fsp.rm = originalRm;
      }

      assert.strictEqual(swapped, true);
      assert.strictEqual(fs.readFileSync(path.join(storage, 'attacker.txt'), 'utf8'), 'must not be deleted');
      assert.strictEqual(fs.readFileSync(path.join(staging, 'session-state.sqlite'), 'utf8'), 'authoritative archive');
      fs.rmSync(storage, { recursive: true, force: true });
      assert.strictEqual(await manager.restoreWorkspaceSessionStorage(project, owner), true);
      assert.strictEqual(fs.readFileSync(path.join(storage, 'session-state.sqlite'), 'utf8'), 'authoritative archive');
      assert.strictEqual(fs.existsSync(staging), false);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses fchmod on a pinned session archive when its final component is swapped', async function () {
    if (process.platform === 'win32') this.skip();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-session-chmod-race-'));
    const environments = {
      projectStorageRoot: () => path.join(root, 'projects'),
      projectTarget: () => ({ config: { rootDir: root } }),
    };
    const manager = new ProjectEnvironmentManager(environments);
    const owner = { id: 7, githubLogin: 'ada' };
    const now = new Date().toISOString();
    const project = {
      id: 'one', ownerUserId: owner.id, name: 'one', repoUrl: null,
      repoHost: null, targetId: null, tierId: null, executionKind: 'container', state: 'building',
      stateDetail: null, container: null, rebuildRequired: true, buildLog: [], lastActivityAt: now,
      lastPreservedCommit: null, lastPreservedBranch: null, compositionRevision: null, createdAt: now, updatedAt: now,
    };
    const workspace = manager.worktreePath(project, owner);
    const storage = manager.workspaceSessionStoragePath(project, owner);
    const movedStorage = `${storage}-opened`;
    const victim = path.join(root, 'outside-victim');
    fs.mkdirSync(path.join(storage, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(storage, 'session-state.sqlite'), 'owned archive');
    fs.writeFileSync(path.join(workspace, 'scratch.txt'), 'must remain');
    fs.mkdirSync(victim, { recursive: true });
    fs.writeFileSync(path.join(victim, 'canary.txt'), 'outside bytes');
    fs.chmodSync(victim, 0o755);

    const originalOpen = fsp.open;
    let swapped = false;
    fsp.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (!swapped && path.basename(String(args[0])) === '.cc-web') {
        const originalHandleChmod = handle.chmod.bind(handle);
        handle.chmod = async (mode) => {
          swapped = true;
          fs.renameSync(storage, movedStorage);
          fs.symlinkSync(victim, storage, 'dir');
          return originalHandleChmod(mode);
        };
      }
      return handle;
    };
    try {
      await assert.rejects(
        () => manager.clearWorkspaceForRebuild(project, owner, true),
        /workspace session storage changed during lifecycle cleanup/,
      );
    } finally {
      fsp.open = originalOpen;
    }
    assert.strictEqual(swapped, true);
    assert.strictEqual(fs.statSync(victim).mode & 0o777, 0o755, 'an external symlink target is never chmodded');
    assert.strictEqual(fs.readFileSync(path.join(victim, 'canary.txt'), 'utf8'), 'outside bytes');
    assert.strictEqual(fs.statSync(movedStorage).mode & 0o777, 0o700, 'fchmod applies to the admitted archive inode');
    assert.strictEqual(fs.readFileSync(path.join(movedStorage, 'session-state.sqlite'), 'utf8'), 'owned archive');
    assert.strictEqual(fs.readFileSync(path.join(workspace, 'scratch.txt'), 'utf8'), 'must remain');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('pins rebuild and checkout deletion to the opened workspace inode on Linux', async function () {
    if (process.platform !== 'linux' || !fs.existsSync('/proc/self/fd')) this.skip();

    for (const operation of ['clearWorkspaceForRebuild', 'clearCheckout']) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `project-pinned-${operation}-`));
      const environments = {
        projectStorageRoot: () => path.join(root, 'projects'),
        projectTarget: () => ({ config: { rootDir: root } }),
      };
      const manager = new ProjectEnvironmentManager(environments, undefined, '/proc/self/fd');
      const owner = { id: 7, githubLogin: 'ada' };
      const now = new Date().toISOString();
      const project = {
        id: 'one', ownerUserId: owner.id, name: 'one', repoUrl: 'https://example.test/repository.git',
        repoHost: 'example.test', targetId: null, tierId: null, executionKind: 'container', state: 'building',
        stateDetail: null, container: null, rebuildRequired: true, buildLog: [], lastActivityAt: now,
        lastPreservedCommit: null, lastPreservedBranch: null, compositionRevision: null, createdAt: now, updatedAt: now,
      };
      const workspace = manager.worktreePath(project, owner);
      const movedWorkspace = `${workspace}-opened`;
      const checkout = manager.checkoutPath(project, owner);
      const storage = manager.workspaceSessionStoragePath(project, owner);
      const victim = path.join(root, 'outside-victim');
      const victimCheckoutCanary = path.join(victim, path.basename(checkout), 'canary.txt');
      const victimScratchCanary = path.join(victim, 'scratch.txt');
      fs.mkdirSync(path.join(storage, 'sessions'), { recursive: true });
      fs.writeFileSync(path.join(storage, 'session-state.sqlite'), 'archive');
      fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
      fs.writeFileSync(path.join(workspace, 'scratch.txt'), 'discardable');
      fs.mkdirSync(path.dirname(victimCheckoutCanary), { recursive: true });
      fs.writeFileSync(victimCheckoutCanary, 'outside checkout');
      fs.writeFileSync(victimScratchCanary, 'outside scratch');

      const originalRm = fsp.rm;
      let swapped = false;
      fsp.rm = async (target, options) => {
        if (!swapped && typeof target === 'string' && target.startsWith('/proc/self/fd/')) {
          swapped = true;
          fs.renameSync(workspace, movedWorkspace);
          fs.symlinkSync(victim, workspace, 'dir');
        }
        return originalRm(target, options);
      };
      try {
        await assert.rejects(
          () => manager[operation](project, owner),
          /changed during lifecycle cleanup/,
        );
      } finally {
        fsp.rm = originalRm;
      }
      assert.strictEqual(swapped, true, `${operation} must remove through the pinned descriptor`);
      assert.strictEqual(fs.readFileSync(victimCheckoutCanary, 'utf8'), 'outside checkout');
      assert.strictEqual(fs.readFileSync(victimScratchCanary, 'utf8'), 'outside scratch');
      assert.strictEqual(
        fs.readFileSync(path.join(path.dirname(workspace), '.one.ccweb-session-storage-retained', 'session-state.sqlite'), 'utf8'),
        'archive',
      );
      assert.strictEqual(fs.existsSync(path.join(movedWorkspace, '.cc-web')), false);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('revalidates the workspace inode before every portable path-based deletion', async function () {
    for (const operation of ['clearWorkspaceForRebuild', 'clearCheckout']) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `project-portable-${operation}-`));
      const environments = {
        projectStorageRoot: () => path.join(root, 'projects'),
        projectTarget: () => ({ config: { rootDir: root } }),
      };
      // A null descriptor directory forces the non-/proc implementation even
      // on Linux, keeping the portable fail-closed path under deterministic test.
      const manager = new ProjectEnvironmentManager(environments, undefined, null, false);
      const owner = { id: 7, githubLogin: 'ada' };
      const now = new Date().toISOString();
      const project = {
        id: 'one', ownerUserId: owner.id, name: 'one', repoUrl: 'https://example.test/repository.git',
        repoHost: 'example.test', targetId: null, tierId: null, executionKind: 'container', state: 'building',
        stateDetail: null, container: null, rebuildRequired: true, buildLog: [], lastActivityAt: now,
        lastPreservedCommit: null, lastPreservedBranch: null, compositionRevision: null, createdAt: now, updatedAt: now,
      };
      const workspace = manager.worktreePath(project, owner);
      const movedWorkspace = `${workspace}-opened`;
      const checkout = manager.checkoutPath(project, owner);
      const storage = manager.workspaceSessionStoragePath(project, owner);
      const victim = path.join(root, 'outside-victim');
      const victimCheckoutCanary = path.join(victim, path.basename(checkout), 'canary.txt');
      const victimScratchCanary = path.join(victim, 'scratch.txt');
      fs.mkdirSync(path.join(storage, 'sessions'), { recursive: true });
      fs.writeFileSync(path.join(storage, 'session-state.sqlite'), 'archive');
      fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
      fs.writeFileSync(path.join(workspace, 'scratch.txt'), 'discardable');
      fs.mkdirSync(path.dirname(victimCheckoutCanary), { recursive: true });
      fs.writeFileSync(victimCheckoutCanary, 'outside checkout');
      fs.writeFileSync(victimScratchCanary, 'outside scratch');

      const originalChmod = fsp.chmod;
      let swapped = false;
      fsp.chmod = async (target, mode) => {
        const result = await originalChmod(target, mode);
        if (!swapped && target === storage) {
          swapped = true;
          fs.renameSync(workspace, movedWorkspace);
          fs.symlinkSync(victim, workspace, 'dir');
        }
        return result;
      };
      try {
        await assert.rejects(
          () => manager[operation](project, owner),
          /changed during lifecycle cleanup/,
        );
      } finally {
        fsp.chmod = originalChmod;
      }
      assert.strictEqual(swapped, true, `${operation} must reach the pre-delete revalidation`);
      assert.strictEqual(fs.readFileSync(victimCheckoutCanary, 'utf8'), 'outside checkout');
      assert.strictEqual(fs.readFileSync(victimScratchCanary, 'utf8'), 'outside scratch');
      assert.strictEqual(fs.readFileSync(path.join(movedWorkspace, '.cc-web', 'session-state.sqlite'), 'utf8'), 'archive');
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('never recursively deletes a real-directory replacement during explicit project removal', async function () {
    const modes = process.platform === 'linux' && fs.existsSync('/proc/self/fd')
      ? ['/proc/self/fd', null]
      : [null];
    for (const descriptorDirectory of modes) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-explicit-delete-race-'));
      const environments = {
        projectStorageRoot: () => path.join(root, 'projects'),
        projectTarget: () => ({ config: { rootDir: root } }),
      };
      const manager = new ProjectEnvironmentManager(
        environments,
        undefined,
        descriptorDirectory,
        descriptorDirectory !== null,
      );
      const owner = { id: 7, githubLogin: 'ada' };
      const now = new Date().toISOString();
      const project = {
        id: 'one', ownerUserId: owner.id, name: 'one', repoUrl: null,
        repoHost: null, targetId: null, tierId: null, executionKind: 'container', state: 'stopped',
        stateDetail: null, container: null, rebuildRequired: false, buildLog: [], lastActivityAt: now,
        lastPreservedCommit: null, lastPreservedBranch: null, compositionRevision: null, createdAt: now, updatedAt: now,
      };
      const workspace = manager.worktreePath(project, owner);
      const movedWorkspace = `${workspace}-opened`;
      const victim = path.join(root, 'outside-victim');
      fs.mkdirSync(path.join(workspace, '.cc-web', 'sessions'), { recursive: true });
      fs.writeFileSync(path.join(workspace, '.cc-web', 'session-state.sqlite'), 'owned archive');
      fs.writeFileSync(path.join(workspace, 'owned.txt'), 'owned bytes');
      fs.mkdirSync(path.join(victim, '.cc-web'), { recursive: true });
      fs.writeFileSync(path.join(victim, '.cc-web', 'session-state.sqlite'), 'outside archive');
      fs.writeFileSync(path.join(victim, 'canary.txt'), 'outside bytes');

      const originalRmdir = fsp.rmdir;
      let swapped = false;
      fsp.rmdir = async (target, options) => {
        if (!swapped) {
          swapped = true;
          fs.renameSync(workspace, movedWorkspace);
          fs.renameSync(victim, workspace);
        }
        return originalRmdir(target, options);
      };
      try {
        await assert.rejects(
          () => manager.removeWorkspace(project, owner),
          (error) => ['ENOTEMPTY', 'EEXIST'].includes(error.code),
        );
      } finally {
        fsp.rmdir = originalRmdir;
      }
      assert.strictEqual(swapped, true);
      assert.strictEqual(fs.readFileSync(path.join(workspace, 'canary.txt'), 'utf8'), 'outside bytes');
      assert.strictEqual(
        fs.readFileSync(path.join(workspace, '.cc-web', 'session-state.sqlite'), 'utf8'),
        'outside archive',
      );
      assert.ok(fs.existsSync(movedWorkspace), 'the originally pinned root was not confused with its replacement');
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
