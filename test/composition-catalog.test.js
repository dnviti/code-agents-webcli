const assert = require('assert');

const {
  COMPOSITION_CATALOG,
  COMPOSITION_CATALOG_VERSION,
  getCompositionCatalog,
  getAgentRuntimeCatalogEntry,
  getRuntimeCatalogEntry,
  isConservativeRuntimeVersion,
} = require('../dist/server/services/composition/catalog.js');

describe('composition runtime catalog', function () {
  it('is a versioned, immutable and finite installer allowlist', function () {
    assert.strictEqual(COMPOSITION_CATALOG_VERSION, 'v1');
    assert.strictEqual(getCompositionCatalog(), COMPOSITION_CATALOG);
    assert.deepStrictEqual(
      COMPOSITION_CATALOG.runtimes.map((runtime) => runtime.id),
      ['node', 'python', 'php', 'go', 'rust', 'java', 'dotnet'],
    );
    assert.deepStrictEqual(
      COMPOSITION_CATALOG.agents.map((runtime) => runtime.id),
      ['claude', 'codex', 'pi', 'grok', 'qwen', 'kimi', 'omp'],
    );
    assert.ok(Object.isFrozen(COMPOSITION_CATALOG));
    assert.ok(Object.isFrozen(COMPOSITION_CATALOG.runtimes));
    assert.ok(COMPOSITION_CATALOG.runtimes.every(Object.isFrozen));
    assert.ok(Object.isFrozen(COMPOSITION_CATALOG.agents));
    assert.ok(COMPOSITION_CATALOG.agents.every(Object.isFrozen));
    assert.strictEqual(getRuntimeCatalogEntry('node').tool, 'node');
    assert.deepStrictEqual(
      {
        tool: getRuntimeCatalogEntry('php').tool,
        version: getRuntimeCatalogEntry('php').defaultVersion,
        executable: getRuntimeCatalogEntry('php').executable,
      },
      { tool: 'php', version: '8.4.22', executable: 'php' },
    );
    assert.throws(() => getRuntimeCatalogEntry('ruby'), /Unknown composition runtime/);
    assert.deepStrictEqual(
      {
        tool: getAgentRuntimeCatalogEntry('codex').tool,
        executable: getAgentRuntimeCatalogEntry('codex').executable,
        requires: getAgentRuntimeCatalogEntry('codex').requires,
      },
      { tool: 'agent-codex', executable: 'codex', requires: 'node' },
    );
    assert.throws(() => getAgentRuntimeCatalogEntry('agent'), /Unknown agent runtime/);
  });

  it('accepts only conservative numeric version literals', function () {
    for (const value of ['22', '22.14', '22.14.0', '1.85.1', '9.0.203.1']) {
      assert.strictEqual(isConservativeRuntimeVersion(value), true, value);
    }
    for (const value of ['', 'latest', '>=22', '22.x', 'v22.1', '${VERSION}', '1.2; id', '01.2']) {
      assert.strictEqual(isConservativeRuntimeVersion(value), false, value);
    }
  });
});
