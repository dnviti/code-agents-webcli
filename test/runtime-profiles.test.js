const assert = require('assert');
const {
  normalizeProfilesConfig,
  resolveActiveProfile,
  profilesForRuntime,
  isBlockedEnvKey,
  LIMITS,
} = require('../dist/shared/runtime-profiles.js');

function profile(extra) {
  return Object.assign({ id: 'p1', name: 'Cheap', runtime: 'pi' }, extra);
}

describe('runtime profile normalization', function () {
  it('keeps a well-formed profile intact', function () {
    const config = normalizeProfilesConfig({
      profiles: [profile({ model: 'vendor/model-x', args: ['--think'], tiers: { floor: 'a', top: 'b' } })],
      active: { pi: 'p1' },
    });
    assert.strictEqual(config.profiles.length, 1);
    assert.strictEqual(config.profiles[0].model, 'vendor/model-x');
    assert.deepStrictEqual(config.profiles[0].args, ['--think']);
    assert.deepStrictEqual(config.profiles[0].tiers, { floor: 'a', top: 'b' });
    assert.strictEqual(config.active.pi, 'p1');
  });

  it('drops a profile missing the fields that identify it', function () {
    const config = normalizeProfilesConfig({
      profiles: [{ name: 'no id', runtime: 'pi' }, { id: 'x', runtime: 'pi' }, profile()],
    });
    assert.deepStrictEqual(config.profiles.map((p) => p.id), ['p1']);
  });

  it('rejects an id that is not filename-safe', function () {
    // Ids reach the tier writer, where they name a generated file.
    const config = normalizeProfilesConfig({
      profiles: [profile({ id: '../../etc/passwd' })],
    });
    assert.strictEqual(config.profiles.length, 0);
  });

  it('drops one bad profile without discarding the good ones', function () {
    // A single malformed row must not make the whole Settings page unsaveable.
    const config = normalizeProfilesConfig({
      profiles: [null, profile(), 'nonsense', profile({ id: 'p2', name: 'Other' })],
    });
    assert.deepStrictEqual(config.profiles.map((p) => p.id), ['p1', 'p2']);
  });

  it('de-duplicates ids, keeping the first', function () {
    const config = normalizeProfilesConfig({
      profiles: [profile({ name: 'First' }), profile({ name: 'Second' })],
    });
    assert.strictEqual(config.profiles.length, 1);
    assert.strictEqual(config.profiles[0].name, 'First');
  });

  it('strips control characters from every string that reaches spawn', function () {
    // A newline or escape in an argument is interpreted by the PTY, not the CLI.
    const ESC = String.fromCharCode(27);
    const NUL = String.fromCharCode(0);
    const config = normalizeProfilesConfig({
      profiles: [profile({ model: `good${NUL}bad`, args: [`--flag${ESC}[31m`] })],
    });
    assert.strictEqual(config.profiles[0].model, 'goodbad');
    assert.deepStrictEqual(config.profiles[0].args, ['--flag[31m']);
  });

  it('strips control characters from environment values too', function () {
    const config = normalizeProfilesConfig({
      profiles: [profile({ env: { TOKEN: `abc${String.fromCharCode(10)}injected` } })],
    });
    assert.strictEqual(config.profiles[0].env.TOKEN, 'abcinjected');
  });

  it('refuses environment variables that change which code runs', function () {
    const config = normalizeProfilesConfig({
      profiles: [
        profile({
          env: {
            LD_PRELOAD: '/tmp/evil.so',
            PATH: '/tmp/bin',
            NODE_OPTIONS: '--require /tmp/x',
            MY_API_KEY: 'sk-test',
          },
        }),
      ],
    });
    assert.deepStrictEqual(config.profiles[0].env, { MY_API_KEY: 'sk-test' });
  });

  it('blocks those names case-insensitively', function () {
    assert.ok(isBlockedEnvKey('ld_preload'));
    assert.ok(isBlockedEnvKey('Path'));
    assert.ok(!isBlockedEnvKey('ANTHROPIC_API_KEY'));
  });

  it('rejects environment names that are not identifiers', function () {
    // A name containing '=' or a space cannot be expressed in a real environment.
    const config = normalizeProfilesConfig({
      profiles: [profile({ env: { 'A=B': 'x', 'has space': 'x', '9leading': 'x', OK_ONE: 'y' } })],
    });
    assert.deepStrictEqual(config.profiles[0].env, { OK_ONE: 'y' });
  });

  it('keeps an empty environment value', function () {
    // Unlike the other fields, "" is meaningful: many CLIs treat it as unset.
    const config = normalizeProfilesConfig({ profiles: [profile({ env: { FOO: '' } })] });
    assert.deepStrictEqual(config.profiles[0].env, { FOO: '' });
  });

  it('caps the number of profiles, args and env vars', function () {
    const many = {};
    for (let i = 0; i < LIMITS.envVars + 20; i++) many[`VAR_${i}`] = 'v';
    const config = normalizeProfilesConfig({
      profiles: Array.from({ length: LIMITS.profiles + 10 }, (_, i) => profile({ id: `p${i}` })),
    });
    assert.strictEqual(config.profiles.length, LIMITS.profiles);

    const one = normalizeProfilesConfig({
      profiles: [profile({ args: Array.from({ length: LIMITS.args + 10 }, () => '--x'), env: many })],
    });
    assert.strictEqual(one.profiles[0].args.length, LIMITS.args);
    assert.strictEqual(Object.keys(one.profiles[0].env).length, LIMITS.envVars);
  });

  it('truncates over-long values rather than dropping them', function () {
    const config = normalizeProfilesConfig({
      profiles: [profile({ model: 'm'.repeat(LIMITS.modelLength + 500) })],
    });
    assert.strictEqual(config.profiles[0].model.length, LIMITS.modelLength);
  });

  it('drops an active id that names no profile', function () {
    // A dangling selection would apply nothing while the UI showed a choice.
    const config = normalizeProfilesConfig({
      profiles: [profile()],
      active: { pi: 'does-not-exist', omp: 'p1' },
    });
    assert.deepStrictEqual(config.active, {});
  });

  it('drops an active id whose profile targets another runtime', function () {
    const config = normalizeProfilesConfig({
      profiles: [profile({ runtime: 'pi' })],
      active: { omp: 'p1' },
    });
    assert.deepStrictEqual(config.active, {});
  });

  it('survives junk input', function () {
    for (const input of [null, undefined, 42, 'string', [], { profiles: 'no' }]) {
      const config = normalizeProfilesConfig(input);
      assert.deepStrictEqual(config, { profiles: [], active: {} });
    }
  });
});

describe('runtime profile lookup', function () {
  const config = normalizeProfilesConfig({
    profiles: [profile(), profile({ id: 'p2', name: 'Rich', runtime: 'omp' })],
    active: { pi: 'p1' },
  });

  it('resolves the active profile for a runtime', function () {
    assert.strictEqual(resolveActiveProfile(config, 'pi').name, 'Cheap');
  });

  it('returns null when a runtime has no active profile', function () {
    assert.strictEqual(resolveActiveProfile(config, 'omp'), null);
    assert.strictEqual(resolveActiveProfile(config, 'claude'), null);
  });

  it('lists the profiles defined for a runtime', function () {
    assert.deepStrictEqual(profilesForRuntime(config, 'omp').map((p) => p.id), ['p2']);
    assert.deepStrictEqual(profilesForRuntime(config, 'claude'), []);
  });
});
