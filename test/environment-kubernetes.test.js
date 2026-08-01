const assert = require('assert');

const {
  KubernetesEngine,
  WORKSPACE_CONTAINER,
  createContainerConfig,
  createEngine,
} = require('../dist/server/services/environments/index.js');

/** A kubectl that records argv and stdin instead of running anything. */
function fakeKubectl(responses = {}) {
  const calls = [];
  const runner = async (file, args, input) => {
    calls.push({ file, args, input });
    // Keyed on the verb, which is the first argument after context/namespace.
    const verb = args.find((a, i) => i > 0 && !a.startsWith('-') && args[i - 1] !== '--context' && args[i - 1] !== '--namespace');
    const handler = responses[verb];
    if (typeof handler === 'function') {
      const result = await handler(args, input);
      const output = args[args.indexOf('-o') + 1];
      if (output === 'json' && result.stdout.trim() && !result.stdout.trim().startsWith('{')) {
        const raw = result.stdout.trim();
        const fields = raw.split('\t');
        const podIndex = args.indexOf('pod');
        const name = podIndex >= 0 ? args[podIndex + 1] : 'pod';
        const [identity, phase, image, labelsJson] = fields.length === 4
          ? fields
          : [`${name}-uid`, raw, 'example/image:1', '{}'];
        return {
          ...result,
          stdout: JSON.stringify({
            status: { phase },
            spec: { containers: [{ image }] },
            metadata: { uid: identity, labels: JSON.parse(labelsJson || '{}') },
          }),
        };
      }
      return result;
    }
    return { stdout: '', stderr: '' };
  };
  return { runner, calls };
}

function engineWith(responses, options = {}) {
  const { runner, calls } = fakeKubectl(responses);
  const engine = new KubernetesEngine({
    runner,
    context: 'kind-test',
    namespace: 'workspaces',
    storageClaim: 'cawc-environments',
    rootDir: '/data/environments',
    pollIntervalMs: 1,
    readyTimeoutSeconds: 1,
    ...options,
  });
  return { engine, calls };
}

const SPEC = {
  name: 'cawc-alice-1',
  image: 'example/image:1',
  containerHome: '/home/alice-1',
  cpus: '2',
  memory: '2g',
  labels: { 'com.code-agents-webcli.managed': 'true', 'com.code-agents-webcli.login': 'alice' },
  env: { HOME: '/home/alice-1' },
  mounts: [
    { hostPath: '/data/environments/cawc-alice-1', containerPath: '/home/alice-1' },
  ],
};

describe('the kubernetes engine', function () {
  describe('targeting', function () {
    it('names the context and namespace on every call', async function () {
      const { engine, calls } = engineWith({ get: async (args) => {
        if (args.includes('pods')) return { stdout: '', stderr: '' };
        throw new Error('Error from server (NotFound): pods "x" not found');
      } });
      await engine.status('x');
      await engine.list('a=b');
      await engine.remove('x');

      // Not a nicety: without this each call would land on whatever cluster
      // kubectl is currently pointed at, which is how a test creates pods in
      // production.
      for (const call of calls) {
        assert.ok(call.args.includes('--context'), call.args.join(' '));
        assert.strictEqual(call.args[call.args.indexOf('--context') + 1], 'kind-test');
        assert.strictEqual(call.args[call.args.indexOf('--namespace') + 1], 'workspaces');
      }
    });

    it('is chosen by configuration, not by guesswork', function () {
      const config = createContainerConfig({
        containers: true,
        containerEngine: 'kubernetes',
        kubeNamespace: 'ws',
      }, {});
      assert.strictEqual(config.engine, 'kubernetes');
      assert.strictEqual(createEngine(config).kind, 'kubernetes');
      // The spellings people actually type.
      assert.strictEqual(createContainerConfig({ containerEngine: 'k8s' }, {}).engine, 'kubernetes');
      assert.strictEqual(createContainerConfig({ containerEngine: 'kube' }, {}).engine, 'kubernetes');
    });

    it('checks availability with namespace-scoped pod access', async function () {
      const { engine, calls } = engineWith({});

      assert.strictEqual(await engine.available(), true);
      const probe = calls.find((call) => call.args.includes('--limit=1'));
      assert.ok(probe.args.includes('pods'));
      assert.strictEqual(probe.args.includes('namespace'), false);
    });
  });

  describe('the pod manifest', function () {
    it('asks for the limits as Kubernetes quantities', function () {
      const { engine } = engineWith({});
      const pod = engine.podManifest(SPEC);
      const container = pod.spec.containers[0];

      assert.strictEqual(container.resources.limits.memory, '2Gi');
      assert.strictEqual(container.resources.limits.cpu, '2');
      // Half the CPU is requested, all the memory: one is compressible and the
      // other gets you evicted.
      assert.strictEqual(container.resources.requests.cpu, '1');
      assert.strictEqual(container.resources.requests.memory, '2Gi');
    });

    it('mounts the home as a subPath of the shared claim', function () {
      const { engine } = engineWith({});
      const pod = engine.podManifest(SPEC);

      assert.deepStrictEqual(pod.spec.volumes, [
        { name: 'home', persistentVolumeClaim: { claimName: 'cawc-environments' } },
      ]);
      assert.deepStrictEqual(pod.spec.containers[0].volumeMounts, [
        { name: 'home', mountPath: '/home/alice-1', subPath: 'cawc-alice-1' },
      ]);
    });

    it('drops a mount the claim cannot express, rather than faking one', function () {
      const { engine } = engineWith({});
      const pod = engine.podManifest({
        ...SPEC,
        mounts: [
          ...SPEC.mounts,
          // The chat socket directory lives outside the claim. An emptyDir
          // standing in for it would mount fine and be empty, failing later and
          // somewhere else.
          { hostPath: '/var/lib/cawc/cs', containerPath: '/run/cawc' },
        ],
      });
      assert.strictEqual(pod.spec.containers[0].volumeMounts.length, 1);
      assert.strictEqual(pod.spec.volumes.length, 1);
    });

    it('does not restart, so a dead environment stays dead visibly', function () {
      const { engine } = engineWith({});
      assert.strictEqual(engine.podManifest(SPEC).spec.restartPolicy, 'Never');
    });

    it('omits resources entirely when nothing is limited', function () {
      const { engine } = engineWith({});
      const pod = engine.podManifest({ ...SPEC, cpus: null, memory: null });
      assert.strictEqual(pod.spec.containers[0].resources, undefined);
    });

    it('is fed to kubectl on stdin rather than through a file', async function () {
      const { engine, calls } = engineWith({});
      await engine.create(SPEC);
      const create = calls.find((c) => c.args.includes('create'));
      assert.ok(create.args.includes('-f') && create.args.includes('-'));
      assert.ok(create.args.includes('jsonpath={.metadata.uid}'));
      assert.strictEqual(JSON.parse(create.input).metadata.name, 'cawc-alice-1');
      assert.strictEqual(calls.some((c) => c.args.includes('apply')), false);
    });
  });

  describe('exec', function () {
    it('applies the working directory and variables without a shell string', function () {
      const { engine } = engineWith({});
      const args = engine.execArgs(
        { name: 'pod-1', cwd: '/home/alice-1/proj', env: { FOO: 'bar' }, tty: true },
        'bash',
        ['-l'],
      );

      assert.deepStrictEqual(args, [
        '--context', 'kind-test', '--namespace', 'workspaces',
        'exec', 'pod-1', '--container', WORKSPACE_CONTAINER, '--stdin', '--tty', '--',
        'sh', '-c', 'cd "$1" || exit 1; shift; exec "$@"', 'sh', '/home/alice-1/proj',
        'env', 'FOO=bar',
        'bash', '-l',
      ]);
    });

    it('passes metacharacters as data, never as syntax', function () {
      const { engine } = engineWith({});
      const args = engine.execArgs(
        { name: 'pod-1', cwd: '/home/a; rm -rf /', env: { X: '$(whoami)' } },
        'echo',
        ['; reboot'],
      );
      // Each one is its own argv entry, and the shell string is a constant that
      // reads them out of "$@" — so none of them can be re-read as syntax.
      assert.ok(args.includes('/home/a; rm -rf /'));
      assert.ok(args.includes('X=$(whoami)'));
      assert.ok(args.includes('; reboot'));
      assert.strictEqual(args.filter((a) => a === '-c').length, 1);
      assert.strictEqual(args[args.indexOf('-c') + 1], 'cd "$1" || exit 1; shift; exec "$@"');
    });

    it('leaves out the shell hop when there is no working directory', function () {
      const { engine } = engineWith({});
      const args = engine.execArgs({ name: 'pod-1' }, 'ls', []);
      assert.deepStrictEqual(args.slice(-2), ['--', 'ls']);
    });

    it('sends exec stdin through kubectl without putting it in argv', async function () {
      const { engine, calls } = engineWith({});
      await engine.exec({ name: 'pod-1', input: 'bearer-token\n' }, 'cat', []);
      const call = calls.find((entry) => entry.args.includes('exec'));
      assert.strictEqual(call.input, 'bearer-token\n');
      assert.ok(!call.args.some((arg) => arg.includes('bearer-token')));
    });
  });

  describe('lifecycle', function () {
    it('replaces a pod that exists but is not running', async function () {
      let phase = 'Failed';
      const { engine, calls } = engineWith({
        get: async () => ({ stdout: phase, stderr: '' }),
        delete: async () => { phase = 'Running'; return { stdout: '', stderr: '' }; },
      });

      const result = await engine.ensure(SPEC);
      assert.strictEqual(result.created, true);
      // A Pod cannot be started; the only way back is a new one.
      assert.ok(calls.some((c) => c.args.includes('delete')));
      assert.ok(calls.some((c) => c.args.includes('create')));
    });

    it('reuses a running pod without touching it', async function () {
      const { engine, calls } = engineWith({
        get: async () => ({ stdout: 'Running', stderr: '' }),
      });
      assert.deepStrictEqual(await engine.ensure(SPEC), { created: false });
      assert.strictEqual(calls.some((c) => c.args.includes('create')), false);
      assert.strictEqual(calls.some((c) => c.args.includes('delete')), false);
    });

    it('refuses to adopt a running pod with incompatible identity labels', async function () {
      const { engine, calls } = engineWith({
        get: async () => ({
          stdout: JSON.stringify({
            status: { phase: 'Running' },
            spec: { containers: [{ image: 'img' }] },
            metadata: {
              uid: 'pod-uid',
              labels: { 'com.code-agents-webcli.managed': 'false' },
            },
          }),
          stderr: '',
        }),
      });
      await assert.rejects(
        engine.ensure({ ...SPEC, identityLabels: ['com.code-agents-webcli.managed'] }),
        /incompatible ownership label/,
      );
      assert.strictEqual(calls.some((c) => c.args.includes('apply')), false);
      assert.strictEqual(calls.some((c) => c.args.includes('delete')), false);
    });

    it('waits for a new pod instead of racing the scheduler', async function () {
      const phases = ['Pending', 'Pending', 'Running'];
      let index = 0;
      const { engine } = engineWith({
        get: async () => ({ stdout: phases[Math.min(index++, phases.length - 1)], stderr: '' }),
      });
      await engine.ensure(SPEC);
      assert.ok(index >= 3, 'it must have polled until the pod was running');
    });

    it('gives up with a readable reason when the pod will not start', async function () {
      const { engine } = engineWith({
        get: async () => ({ stdout: 'Pending', stderr: '' }),
      });
      await assert.rejects(() => engine.ensure(SPEC), /was not running after 1s.*pending/i);
    });

    it('reports a failed pod rather than waiting out the timeout', async function () {
      let created = false;
      const { engine } = engineWith({
        get: async () => { if (!created) throw new Error('Error from server (NotFound): pods "cawc-alice-1" not found'); return { stdout: 'Failed', stderr: '' }; },
        create: async () => { created = true; return { stdout: '', stderr: '' }; },
      });
      await assert.rejects(() => engine.ensure(SPEC), /did not start: pod is failed/);
    });

    it('stops by deleting, because the data is on the claim', async function () {
      const { engine, calls } = engineWith({});
      await engine.stop('pod-1');
      const call = calls[0];
      assert.ok(call.args.includes('delete'));
      assert.ok(call.args.includes('--ignore-not-found'));
    });
  });

  describe('reading state', function () {
    it('maps pod phases onto the vocabulary the rest of the code uses', async function () {
      const phases = { Running: 'running', Pending: 'pending', Failed: 'failed' };
      for (const [phase, expected] of Object.entries(phases)) {
        const { engine } = engineWith({ get: async () => ({ stdout: phase, stderr: '' }) });
        assert.strictEqual(await engine.status('pod-1'), expected);
      }
    });

    it('reports no pod as null rather than throwing', async function () {
      const { engine } = engineWith({ get: async () => { throw new Error('Error from server (NotFound): pods "gone" not found'); } });
      assert.strictEqual(await engine.status('gone'), null);
      assert.strictEqual(await engine.describe('gone'), null);
    });

    it('does not turn a strict kubectl failure into absence', async function () {
      const { engine } = engineWith({
        get: async () => { throw new Error('Forbidden'); },
      });
      await assert.rejects(engine.describeStrict('pod-1'), /Forbidden/);
      assert.strictEqual(await engine.describe('pod-1'), null);
    });

    it('does not turn malformed pod JSON into strict absence', async function () {
      const { engine } = engineWith({
        get: async () => ({ stdout: '{broken', stderr: '' }),
      });
      await assert.rejects(engine.describeStrict('pod-1'), /invalid JSON/);
      assert.strictEqual(await engine.describe('pod-1'), null);
    });

    it('propagates transport and malformed pod inspection uncertainty on the strict path', async function () {
      const transport = engineWith({ get: async () => { throw new Error('TLS timeout'); } }).engine;
      await assert.rejects(() => transport.describeStrict('pod-1'), /timeout/i);
      assert.strictEqual(await transport.describe('pod-1'), null);
      const malformed = engineWith({ get: async () => ({ stdout: '{}', stderr: '' }) }).engine;
      await assert.rejects(() => malformed.describeStrict('pod-1'));
      assert.strictEqual(await malformed.describe('pod-1'), null);
    });

    it('uses a Kubernetes UID precondition for identity-bound deletion', async function () {
      let removed = false;
      const { engine, calls } = engineWith({
        delete: async () => { removed = true; return { stdout: '', stderr: '' }; },
        get: async () => { if (removed) throw new Error('Error from server (NotFound): pods "pod-1" not found'); return { stdout: 'uid-1\tRunning\timg\t{}', stderr: '' }; },
      });
      await engine.removeIdentity({ name: 'pod-1', identity: 'uid-1', status: 'running', image: 'img', labels: {} });
      const deletion = calls.find((call) => call.args.includes('--raw'));
      assert.match(deletion.input, /"uid":"uid-1"/);
    });

    it('waits through asynchronous same-UID termination until the pod is absent', async function () {
      let inspections = 0;
      const { engine } = engineWith({
        delete: async () => ({ stdout: '', stderr: '' }),
        get: async () => {
          inspections += 1;
          if (inspections > 3) throw new Error('Error from server (NotFound): pods "pod-1" not found');
          return { stdout: 'uid-1\tRunning\timg\t{}\n', stderr: '' };
        },
      });
      await engine.removeIdentity({ name: 'pod-1', identity: 'uid-1', status: 'running', image: 'img', labels: {} });
      assert.strictEqual(inspections, 4);
    });

    it('fails closed if deletion reveals a replacement UID or never completes', async function () {
      const replaced = engineWith({
        delete: async () => ({ stdout: '', stderr: '' }),
        get: async () => ({ stdout: 'replacement-uid\tRunning\timg\t{}\n', stderr: '' }),
      }).engine;
      await assert.rejects(
        () => replaced.removeIdentity({ name: 'pod-1', identity: 'uid-1', status: 'running', image: 'img', labels: {} }),
        /replaced during removal/i,
      );

      const timedOut = engineWith({
        delete: async () => ({ stdout: '', stderr: '' }),
        get: async () => ({ stdout: 'uid-1\tRunning\timg\t{}\n', stderr: '' }),
      }, { readyTimeoutSeconds: 0 }).engine;
      await assert.rejects(
        () => timedOut.removeIdentity({ name: 'pod-1', identity: 'uid-1', status: 'running', image: 'img', labels: {} }),
        /removal timeout/i,
      );
    });

    it('never deletes a non-running same-name replacement during identity-safe ensure', async function () {
      const { engine, calls } = engineWith({ get: async () => ({ stdout: 'replacement-uid\tFailed\timg\t{}', stderr: '' }) });
      await assert.rejects(() => engine.ensureIdentity(SPEC, { name: SPEC.name, identity: 'original-uid', status: 'failed', image: 'img', labels: {} }), /replaced before ensure/);
      assert.strictEqual(calls.some((call) => call.args.includes('delete')), false);
    });

    it('returns and waits for the new UID when replacing an expected failed pod', async function () {
      let present = true; let identity = 'old-uid'; let phase = 'Failed';
      const { engine, calls } = engineWith({
        get: async (args) => {
          if (!present) throw new Error(`Error from server (NotFound): pods "${SPEC.name}" not found`);
          if (args[args.indexOf('-o') + 1] === 'json') {
            return { stdout: `${identity}\t${phase}\timg\t{}\n`, stderr: '' };
          }
          return { stdout: phase, stderr: '' };
        },
        delete: async () => { present = false; return { stdout: '', stderr: '' }; },
        create: async () => {
          present = true; identity = 'new-uid'; phase = 'Running';
          return { stdout: `${identity}\n`, stderr: '' };
        },
      });

      assert.deepStrictEqual(await engine.ensureIdentity(SPEC, {
        name: SPEC.name, identity: 'old-uid', status: 'failed', image: 'img', labels: {},
      }), { created: true, identity: 'new-uid' });
      assert.ok(calls.some((call) => call.args.includes('create')));
      assert.strictEqual(calls.some((call) => call.args.includes('apply')), false);
    });

    it('does not adopt a pod that wins the absent-to-create race', async function () {
      let present = false;
      const { engine, calls } = engineWith({
        get: async () => {
          if (!present) throw new Error(`Error from server (NotFound): pods "${SPEC.name}" not found`);
          return { stdout: 'replacement-uid\tRunning\timg\t{}\n', stderr: '' };
        },
        create: async () => {
          present = true;
          throw new Error(`Error from server (AlreadyExists): pods "${SPEC.name}" already exists`);
        },
      });

      await assert.rejects(() => engine.ensureIdentity(SPEC, null), /already exists/i);
      assert.strictEqual(calls.some((call) => call.args.includes('delete')), false);
      assert.strictEqual(calls.some((call) => call.args.includes('apply')), false);
    });

    it('rejects a same-name replacement while the created pod is becoming ready', async function () {
      let inspected = false;
      const { engine } = engineWith({
        get: async () => {
          if (!inspected) { inspected = true; throw new Error(`Error from server (NotFound): pods "${SPEC.name}" not found`); }
          return { stdout: 'replacement-uid\tRunning\timg\t{}\n', stderr: '' };
        },
        create: async () => ({ stdout: 'created-uid\n', stderr: '' }),
      });

      await assert.rejects(() => engine.ensureIdentity(SPEC, null), /changed identity while waiting/i);
    });

    it('reads usage from kubectl top, in cores and bytes', async function () {
      const { engine } = engineWith({
        top: async () => ({ stdout: 'cawc-alice-1   workspace   250m   512Mi\n', stderr: '' }),
      });
      assert.deepStrictEqual(await engine.usage('cawc-alice-1'), {
        cpuCores: 0.25,
        memoryBytes: 512 * 1024 * 1024,
      });
    });

    it('reports no metrics as unknown, so nothing is scaled on a guess', async function () {
      const { engine } = engineWith({
        top: async () => { throw new Error('Metrics API not available'); },
      });
      // A cluster without metrics-server is the common case, and reading it as
      // "idle" would shrink every environment on it.
      assert.strictEqual(await engine.usage('cawc-alice-1'), null);
    });
  });

  describe('resizing', function () {
    it('patches the resize subresource', async function () {
      const { engine, calls } = engineWith({});
      assert.strictEqual(await engine.resize('pod-1', '4', '4g'), true);

      const patch = calls.find((c) => c.args.includes('patch'));
      assert.strictEqual(patch.args[patch.args.indexOf('--subresource') + 1], 'resize');
      const body = JSON.parse(patch.args[patch.args.indexOf('--patch') + 1]);
      assert.strictEqual(body.spec.containers[0].name, WORKSPACE_CONTAINER);
      assert.strictEqual(body.spec.containers[0].resources.limits.memory, '4Gi');
    });

    it('reports failure instead of throwing on a cluster too old for it', async function () {
      const { engine } = engineWith({
        patch: async () => { throw new Error('the server could not find the requested resource'); },
      });
      // The caller's fallback is a rebuild, which every cluster supports.
      assert.strictEqual(await engine.resize('pod-1', '4', '4g'), false);
    });
  });
});
