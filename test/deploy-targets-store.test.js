const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AppDatabase } = require('../dist/server/services/database.js');
const { EncryptionKeyRing } = require('../dist/server/services/encryption.js');
const {
  DeployTargetStore,
  caveatsFor,
  secretsPathFor,
} = require('../dist/server/services/deploy-targets.js');
const { createContainerConfig } = require('../dist/server/services/environments/index.js');

const KEY = Buffer.alloc(32, 7).toString('base64');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cawc-targets-'));
}

function harness() {
  const dataDir = tmpRoot();
  const database = new AppDatabase({ dataDir });
  const keyRing = new EncryptionKeyRing({ settings: database, key: KEY, warn: () => {} });
  const store = new DeployTargetStore({ database, keyRing, dataDir });
  return { dataDir, database, keyRing, store };
}

const KUBECONFIG = 'apiVersion: v1\nclusters: []\n# PLAINTEXT-KUBECONFIG-MARKER';
const HOST = 'tcp://docker.example.com:2376';
const TLS = { ca: 'PLAINTEXT-CA', cert: 'PLAINTEXT-CERT', key: 'PLAINTEXT-KEY' };

describe('deploy target store', function () {
  describe('CRUD', function () {
    it('creates, reads, updates and deletes a target', function () {
      const { store } = harness();
      const { id } = store.createTarget({
        name: 'laptop-docker',
        engine: 'docker',
        image: 'example/image:1',
        cpus: '2',
        memory: '4g',
        idleTimeoutMinutes: 30,
      });

      const listed = store.listTargets();
      assert.strictEqual(listed.length, 1);
      assert.strictEqual(listed[0].id, id);
      assert.strictEqual(listed[0].name, 'laptop-docker');
      assert.strictEqual(listed[0].hasHost, false);
      assert.strictEqual(listed[0].hasKubernetesConfig, false);

      const full = store.getTarget(id);
      assert.strictEqual(full.image, 'example/image:1');
      assert.strictEqual(full.cpus, '2');
      assert.strictEqual(full.idleTimeoutMinutes, 30);

      store.updateTarget(id, { name: 'renamed', memory: '8g' });
      const updated = store.getTarget(id);
      assert.strictEqual(updated.name, 'renamed');
      assert.strictEqual(updated.memory, '8g');
      assert.strictEqual(updated.cpus, '2');

      store.deleteTarget(id);
      assert.strictEqual(store.getTarget(id), null);
      assert.strictEqual(store.listTargets().length, 0);
    });

    it('refuses a duplicate name, on create and on rename', function () {
      const { store } = harness();
      store.createTarget({ name: 'one', engine: 'docker' });
      assert.throws(() => store.createTarget({ name: 'one', engine: 'podman' }), /already exists/);
      const { id } = store.createTarget({ name: 'two', engine: 'podman' });
      assert.throws(() => store.updateTarget(id, { name: 'one' }), /already exists/);
    });

    it('refuses an engine it does not know', function () {
      const { store } = harness();
      assert.throws(() => store.createTarget({ name: 'x', engine: 'lxc' }), /unsupported engine/);
    });

    it('computes kubernetes caveats and states the runtime image contract for docker', function () {
      const { store } = harness();
      const { id } = store.createTarget({ name: 'k', engine: 'kubernetes' });
      const caveats = store.getTarget(id).caveats;
      assert.ok(caveats.some((c) => c.includes('bypassPermissions')));
      assert.ok(caveats.some((c) => c.includes('metrics-server')));
      const dockerCaveats = caveatsFor('docker');
      assert.strictEqual(dockerCaveats.length, 2);
      assert.match(dockerCaveats[0], /Linux.*sh.*\/proc.*setsid/);
      assert.match(dockerCaveats[1], /remote engine.*questions.*still work/i);
    });
  });

  describe('secrets at rest', function () {
    it('stores no plaintext secret material in the table', function () {
      const { database, store } = harness();
      const { id } = store.createTarget({
        name: 'prod-k8s',
        engine: 'kubernetes',
        kubernetesSecret: { kubeconfig: KUBECONFIG, namespace: 'ws' },
        hostSecret: { host: HOST, tls: TLS },
      });

      const row = database.raw
        .prepare('SELECT host_secret, kubernetes_secret FROM deploy_targets WHERE id = ?')
        .get(id);
      assert.ok(row.host_secret);
      assert.ok(row.kubernetes_secret);
      for (const marker of ['PLAINTEXT', HOST, 'docker.example.com']) {
        assert.ok(!row.host_secret.includes(marker), `host_secret leaks ${marker}`);
        assert.ok(!row.kubernetes_secret.includes(marker), `kubernetes_secret leaks ${marker}`);
      }

      // …but the store reads them back.
      const full = store.getTarget(id);
      assert.strictEqual(full.kubernetesSecret.kubeconfig, KUBECONFIG);
      assert.strictEqual(full.hostSecret.host, HOST);
      assert.strictEqual(full.hostSecret.tls.cert, 'PLAINTEXT-CERT');
    });

    it('keeps a stored secret on update unless a new value is sent', function () {
      const { store } = harness();
      const { id } = store.createTarget({
        name: 'remote',
        engine: 'docker',
        hostSecret: { host: HOST, tls: TLS },
      });

      // Absent field: keep.
      store.updateTarget(id, { image: 'example/image:2' });
      assert.strictEqual(store.getTarget(id).hostSecret.host, HOST);

      // A partial edit merges: the host moves, the stored TLS stays.
      store.updateTarget(id, { hostSecret: { host: 'tcp://other:2376' } });
      const replaced = store.getTarget(id);
      assert.strictEqual(replaced.hostSecret.host, 'tcp://other:2376');
      assert.deepStrictEqual(replaced.hostSecret.tls, TLS, 'an edit that says nothing about TLS keeps it');

      // Explicit null on a subfield clears just that subfield.
      store.updateTarget(id, { hostSecret: { host: 'tcp://other:2376', tls: null } });
      assert.strictEqual(store.getTarget(id).hostSecret.tls, null);

      // Explicit null on the whole secret: clear.
      store.updateTarget(id, { hostSecret: null });
      assert.strictEqual(store.getTarget(id).hostSecret, null);
      assert.strictEqual(store.listTargets()[0].hasHost, false);
    });

    it('merges a partial kubernetes edit without wiping the kubeconfig', function () {
      const { store } = harness();
      const { id } = store.createTarget({
        name: 'k8s-merge',
        engine: 'kubernetes',
        kubernetesSecret: { kubeconfig: KUBECONFIG, context: 'ctx', namespace: 'ws' },
      });

      store.updateTarget(id, { kubernetesSecret: { namespace: 'other' } });
      const merged = store.getTarget(id).kubernetesSecret;
      assert.strictEqual(merged.namespace, 'other');
      assert.strictEqual(merged.kubeconfig, KUBECONFIG, 'a namespace-only edit keeps the stored kubeconfig');
      assert.strictEqual(merged.context, 'ctx');
    });
  });

  describe('configForTarget', function () {
    it('builds a ContainerConfig with engine connection details', function () {
      const { dataDir, store } = harness();
      const { id } = store.createTarget({
        name: 'remote-docker',
        engine: 'docker',
        hostSecret: { host: HOST, tls: TLS },
        tiers: [{ id: 'only', label: 'Only', cpus: '1', memory: '1g' }],
        defaultTier: 'only',
        allowUserTierChoice: false,
      });

      const config = store.configForTarget(id, dataDir, [
        { hostPath: '/srv/app', containerPath: '/opt/app', readOnly: true },
      ]);
      assert.strictEqual(config.enabled, true);
      assert.strictEqual(config.engine, 'docker');
      assert.strictEqual(config.rootDir, path.join(dataDir, 'environments'));
      assert.strictEqual(config.namePrefix, 'cawc');
      assert.deepStrictEqual(config.hostArgs, [
        '-H', HOST,
        '--tlscacert', path.join(secretsPathFor(id, dataDir), 'ca.pem'),
        '--tlscert', path.join(secretsPathFor(id, dataDir), 'cert.pem'),
        '--tlskey', path.join(secretsPathFor(id, dataDir), 'key.pem'),
        '--tlsverify',
      ]);
      assert.strictEqual(config.extraMounts.length, 1);
      assert.strictEqual(config.defaultTier, 'only');
      assert.strictEqual(config.allowUserTierChoice, false);
    });

    it('materializes kubeconfig and TLS material with strict permissions', function () {
      const { dataDir, store } = harness();
      const { id } = store.createTarget({
        name: 'k8s',
        engine: 'kubernetes',
        kubernetesSecret: { kubeconfig: KUBECONFIG, namespace: 'ws' },
        hostSecret: { host: HOST, tls: TLS },
      });

      const config = store.configForTarget(id, dataDir);
      const dir = secretsPathFor(id, dataDir);
      const kubeconfigPath = path.join(dir, 'kubeconfig');
      assert.strictEqual(config.kubeconfigPath, kubeconfigPath);
      assert.strictEqual(fs.readFileSync(kubeconfigPath, 'utf8'), KUBECONFIG);
      assert.strictEqual(fs.readFileSync(path.join(dir, 'ca.pem'), 'utf8'), 'PLAINTEXT-CA');
      assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700);
      assert.strictEqual(fs.statSync(kubeconfigPath).mode & 0o777, 0o600);
      assert.strictEqual(fs.statSync(path.join(dir, 'key.pem')).mode & 0o777, 0o600);
    });

    it('removes materialized secrets when the target is deleted', function () {
      const { dataDir, store } = harness();
      const { id } = store.createTarget({
        name: 'k8s',
        engine: 'kubernetes',
        kubernetesSecret: { kubeconfig: KUBECONFIG },
      });
      store.materializeSecrets(id);
      assert.ok(fs.existsSync(secretsPathFor(id, dataDir)));
      store.deleteTarget(id);
      assert.ok(!fs.existsSync(secretsPathFor(id, dataDir)));
    });

    it('removes materialized files when a secret is cleared', function () {
      const { dataDir, store } = harness();
      const { id } = store.createTarget({
        name: 'k8s-clear',
        engine: 'kubernetes',
        kubernetesSecret: { kubeconfig: KUBECONFIG },
        hostSecret: { host: HOST, tls: TLS },
      });
      const dir = secretsPathFor(id, dataDir);
      assert.ok(fs.existsSync(path.join(dir, 'kubeconfig')));
      assert.ok(fs.existsSync(path.join(dir, 'ca.pem')));
      assert.ok(fs.existsSync(path.join(dir, 'key.pem')));

      // Clearing the secrets must not leave their plaintext on disk next to
      // — or instead of — whatever comes next.
      store.updateTarget(id, { kubernetesSecret: null, hostSecret: null });
      assert.ok(!fs.existsSync(path.join(dir, 'kubeconfig')), 'cleared kubeconfig must leave no file');
      assert.ok(!fs.existsSync(path.join(dir, 'ca.pem')), 'cleared TLS must leave no files');
      assert.ok(!fs.existsSync(path.join(dir, 'cert.pem')));
      assert.ok(!fs.existsSync(path.join(dir, 'key.pem')));

      // Replacing a secret sweeps the old material too: the TLS files of the
      // previous host must not survive the host that has none.
      store.updateTarget(id, { hostSecret: { host: 'tcp://plain:2375' } });
      assert.ok(!fs.existsSync(path.join(dir, 'ca.pem')));
    });
  });

  describe('the active target', function () {
    it('sets, reads and clears the active target', function () {
      const { store } = harness();
      assert.strictEqual(store.getActiveTargetId(), null);
      const { id } = store.createTarget({ name: 'one', engine: 'docker' });
      store.setActiveTargetId(id);
      assert.strictEqual(store.getActiveTargetId(), id);
      store.setActiveTargetId(null);
      assert.strictEqual(store.getActiveTargetId(), null);
    });

    it('refuses to activate a target that does not exist', function () {
      const { store } = harness();
      assert.throws(() => store.setActiveTargetId('no-such-target'), /does not exist/);
    });

    it('records health check outcomes without touching the row’s edit time', function () {
      const { store } = harness();
      const { id } = store.createTarget({ name: 'one', engine: 'docker' });
      assert.strictEqual(store.getTarget(id).lastCheck, null);
      store.recordCheck(id, { ok: false, error: 'connection refused' });
      const check = store.getTarget(id).lastCheck;
      assert.strictEqual(check.ok, false);
      assert.strictEqual(check.error, 'connection refused');
      assert.ok(check.at);
      assert.throws(() => store.recordCheck('nope', { ok: true }), /not found/);
    });
  });

  describe('the legacy seed', function () {
    it('seeds a default target from an enabled legacy config and activates it', function () {
      const { database, store } = harness();
      const legacy = createContainerConfig({
        containers: true,
        containerEngine: 'podman',
        containerImage: 'example/base:1',
        containerIdleMinutes: 45,
      }, {});

      const seeded = store.seedLegacyTarget(legacy);
      assert.ok(seeded);
      const target = store.getTarget(seeded.id);
      assert.strictEqual(target.name, 'default');
      assert.strictEqual(target.engine, 'podman');
      assert.strictEqual(target.image, 'example/base:1');
      assert.strictEqual(target.idleTimeoutMinutes, 45);
      assert.strictEqual(store.getActiveTargetId(), seeded.id);
      assert.strictEqual(database.getSetting('deploy.targets.legacySeeded'), 'true');
    });

    it('seeds nothing when the legacy config is disabled, not even the flag', function () {
      const { database, store } = harness();
      const legacy = createContainerConfig({}, {});
      assert.strictEqual(legacy.enabled, false);
      assert.strictEqual(store.seedLegacyTarget(legacy), null);
      assert.strictEqual(store.listTargets().length, 0);
      // The flag stays unset: an installation that turns containers on later
      // still gets that config captured on the boot that enables it.
      assert.strictEqual(database.getSetting('deploy.targets.legacySeeded'), null);
    });

    it('never seeds twice', function () {
      const { store } = harness();
      const legacy = createContainerConfig({ containers: true }, {});
      assert.ok(store.seedLegacyTarget(legacy));
      assert.strictEqual(store.seedLegacyTarget(legacy), null);
      assert.strictEqual(store.listTargets().length, 1);
    });

    it('rolls the seed back entirely when any of its writes fails', function () {
      const { database, store } = harness();
      const legacy = createContainerConfig({ containers: true }, {});

      // Force the activation write to fail: without a transaction the row
      // would stay behind, an unactivated 'default' target that makes every
      // later boot see "targets exist, none active".
      const original = database.setSetting.bind(database);
      database.setSetting = (key, value) => {
        if (key === 'deploy.targets.activeTargetId') {
          throw new Error('disk full');
        }
        return original(key, value);
      };

      assert.throws(() => store.seedLegacyTarget(legacy), /disk full/);
      assert.strictEqual(store.listTargets().length, 0, 'the inserted row must roll back with the transaction');
      assert.strictEqual(database.getSetting('deploy.targets.legacySeeded'), null);

      // …and a later, healthy boot still gets its seed.
      database.setSetting = original;
      assert.ok(store.seedLegacyTarget(legacy));
      assert.strictEqual(store.listTargets().length, 1);
    });

    it('does not seed over an installation that already has targets', function () {
      const { database, store } = harness();
      store.createTarget({ name: 'existing', engine: 'docker' });
      const legacy = createContainerConfig({ containers: true }, {});
      assert.strictEqual(store.seedLegacyTarget(legacy), null);
      assert.strictEqual(store.listTargets().length, 1);
      assert.strictEqual(store.listTargets()[0].name, 'existing');
      assert.strictEqual(database.getSetting('deploy.targets.legacySeeded'), 'true');
    });

    it('captures a legacy kubeconfig file as encrypted content', function () {
      const { dataDir, database, store } = harness();
      const kubeconfigFile = path.join(tmpRoot(), 'kubeconfig');
      fs.writeFileSync(kubeconfigFile, KUBECONFIG);
      const legacy = {
        ...createContainerConfig({
          containers: true,
          containerEngine: 'kubernetes',
          kubeNamespace: 'ws',
        }, {}),
        kubeconfigPath: kubeconfigFile,
      };

      const seeded = store.seedLegacyTarget(legacy);
      const target = store.getTarget(seeded.id);
      assert.strictEqual(target.kubernetesSecret.kubeconfig, KUBECONFIG);
      assert.strictEqual(target.kubernetesSecret.namespace, 'ws');
      const row = database.raw
        .prepare('SELECT kubernetes_secret FROM deploy_targets WHERE id = ?')
        .get(seeded.id);
      assert.ok(!row.kubernetes_secret.includes('PLAINTEXT'));
      assert.ok(fs.existsSync(path.join(dataDir, 'deploy-targets', seeded.id, 'kubeconfig')));
    });
  });
});
