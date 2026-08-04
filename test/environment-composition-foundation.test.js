const assert = require('assert');
const fs = require('fs');
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
    fs.rmSync(root, { recursive: true, force: true });
  });
});
