const assert = require('assert');

const { RuntimeProfileStore } = require('../dist/server/services/runtime-profiles.js');
const {
  DEFAULT_PROFILES,
  DEFAULT_PROFILES_VERSION,
} = require('../dist/shared/default-profiles.js');
const { normalizeProfilesConfig, MODEL_TIERS } = require('../dist/shared/runtime-profiles.js');
const { supportsTiers } = require('../dist/server/services/tier-writer.js');

/** The app_settings key/value pair the store is built on, in memory. */
function fakeDatabase(seed = {}) {
  const rows = { ...seed };
  return {
    rows,
    writes: 0,
    getSetting(key) {
      return Object.prototype.hasOwnProperty.call(rows, key) ? rows[key] : null;
    },
    setSetting(key, value) {
      this.writes++;
      rows[key] = value;
    },
  };
}

describe('shipped default profiles', function () {
  it('survives the same validation as anything sent over the wire', function () {
    // Being ours buys no trust: the defaults go through the normalizer, so a
    // malformed one would be silently dropped rather than shipped. This test is
    // what makes that dropping loud.
    const config = normalizeProfilesConfig({ profiles: DEFAULT_PROFILES, active: {} });
    assert.strictEqual(
      config.profiles.length,
      DEFAULT_PROFILES.length,
      `${DEFAULT_PROFILES.length - config.profiles.length} default(s) failed validation`,
    );
  });

  it('gives every default a stable, unique id', function () {
    // A generated id would make a default indistinguishable from a user's own
    // profile, so a later build could never recognise its own entries.
    const ids = DEFAULT_PROFILES.map((p) => p.id);
    assert.strictEqual(new Set(ids).size, ids.length, 'duplicate default id');
    for (const id of ids) {
      assert.match(id, /^default-/, `${id} should be namespaced`);
    }
  });

  it('only defines tiers for runtimes that can express them', function () {
    // A tier set on a runtime with no tier concept is written nowhere and does
    // nothing — the UI says as much, and a default must not contradict it.
    for (const profile of DEFAULT_PROFILES) {
      if (!profile.tiers) continue;
      assert.ok(
        supportsTiers(profile.runtime),
        `${profile.id} sets tiers but ${profile.runtime} cannot apply them`,
      );
    }
  });

  it('fills every tier of a ladder', function () {
    // A half-filled ladder silently leaves a role on the runtime's own default,
    // which is the confusing case: some work routed, some not.
    for (const profile of DEFAULT_PROFILES) {
      if (!profile.tiers) continue;
      for (const tier of MODEL_TIERS) {
        assert.ok(profile.tiers[tier], `${profile.id} has no ${tier} model`);
      }
    }
  });

  it('names a model only where the CLI has a flag to carry it', function () {
    // Runtimes without a model flag ignore `model` entirely; shipping one would
    // promise a pin that never happens.
    const withModelFlag = new Set(['claude', 'codex', 'grok', 'kimi', 'pi', 'omp']);
    for (const profile of DEFAULT_PROFILES) {
      if (!profile.model) continue;
      assert.ok(
        withModelFlag.has(profile.runtime),
        `${profile.id} pins a model but ${profile.runtime} has no model flag`,
      );
    }
  });
});

describe('seeding the default profiles', function () {
  it('seeds a fresh install', function () {
    const database = fakeDatabase();
    const config = new RuntimeProfileStore({ database }).get();

    assert.strictEqual(config.profiles.length, DEFAULT_PROFILES.length);
    assert.strictEqual(database.getSetting('runtime_profiles.seeded'), DEFAULT_PROFILES_VERSION);
  });

  it('activates none of them', function () {
    // Profiles are server-wide. A seeded *active* profile would change how
    // every user's agents launch on an install where nobody chose it.
    const config = new RuntimeProfileStore({ database: fakeDatabase() }).get();
    assert.deepStrictEqual(config.active, {});
  });

  it('leaves every runtime launching unmodified until one is picked', function () {
    const store = new RuntimeProfileStore({ database: fakeDatabase() });
    for (const runtime of ['claude', 'codex', 'agent', 'pi', 'grok', 'qwen', 'kimi', 'omp']) {
      assert.strictEqual(store.activeFor(runtime), null, runtime);
    }
  });

  it('writes once, not on every read', function () {
    const database = fakeDatabase();
    const store = new RuntimeProfileStore({ database });
    store.get();
    const afterSeed = database.writes;
    store.get();
    store.get();
    assert.strictEqual(database.writes, afterSeed);
  });

  it('does not seed over a config that already exists', function () {
    const database = fakeDatabase({
      runtime_profiles: JSON.stringify({
        profiles: [{ id: 'mine', name: 'Mine', runtime: 'pi' }],
        active: {},
      }),
    });
    const config = new RuntimeProfileStore({ database }).get();
    assert.deepStrictEqual(config.profiles.map((p) => p.id), ['mine']);
  });

  it('keeps deleted defaults deleted', function () {
    // The whole point of the separate marker: emptying the list is a choice,
    // and handing the defaults back on the next restart would override it.
    const database = fakeDatabase();
    new RuntimeProfileStore({ database }).get();
    new RuntimeProfileStore({ database }).save({ profiles: [], active: {} });

    const after = new RuntimeProfileStore({ database }).get();
    assert.deepStrictEqual(after.profiles, []);

    // ...even if the stored row itself goes missing afterwards.
    delete database.rows.runtime_profiles;
    assert.deepStrictEqual(new RuntimeProfileStore({ database }).get().profiles, []);
  });

  it('does not seed after the first save, even without a prior read', function () {
    const database = fakeDatabase();
    new RuntimeProfileStore({ database }).save({
      profiles: [{ id: 'mine', name: 'Mine', runtime: 'pi' }],
      active: {},
    });
    delete database.rows.runtime_profiles;
    assert.deepStrictEqual(new RuntimeProfileStore({ database }).get().profiles, []);
  });

  it('does not replace a config it failed to parse', function () {
    // Overwriting an unreadable row with different content would read as the
    // app having thrown the user's profiles away.
    const database = fakeDatabase({ runtime_profiles: '{not json' });
    const warn = console.warn;
    console.warn = () => {};
    try {
      assert.deepStrictEqual(new RuntimeProfileStore({ database }).get().profiles, []);
    } finally {
      console.warn = warn;
    }
    assert.strictEqual(database.getSetting('runtime_profiles'), '{not json');
  });
});
