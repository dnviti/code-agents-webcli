const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  WorkspaceCatalog,
  canonicalExistingRoot,
} = require('../dist/server/services/workspace-catalog.js');

describe('workspace root catalog', function () {
  let root;
  let values;
  let catalog;
  const ownerKey = 'a'.repeat(64);

  beforeEach(function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-catalog-'));
    values = new Map();
    catalog = new WorkspaceCatalog({
      getSetting: (key) => values.get(key) ?? null,
      setSetting: (key, value) => values.set(key, value),
    });
  });

  afterEach(function () {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('stores only owner-scoped canonical folder roots', function () {
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    assert.strictEqual(catalog.register(ownerKey, workspace), workspace);
    catalog.register(ownerKey, workspace);
    assert.deepStrictEqual(catalog.roots(ownerKey), [workspace]);
    assert.ok(!values.values().next().value.includes('sessionId'));
  });

  it('never silently evicts an older workspace from cold-start discovery', function () {
    const older = Array.from({ length: 520 }, (_unused, index) =>
      path.join(root, `remembered-${index}`));
    values.set('session_workspace_roots.v1', JSON.stringify([{ ownerKey, roots: older }]));
    const newest = path.join(root, 'new-workspace');
    fs.mkdirSync(newest);

    catalog.register(ownerKey, newest);

    assert.strictEqual(catalog.roots(ownerKey).length, 521);
    assert.strictEqual(catalog.roots(ownerKey)[0], older[0]);
    assert.strictEqual(catalog.roots(ownerKey).at(-1), newest);
  });

  it('does not admit filesystem roots or symlink aliases', function () {
    assert.throws(() => canonicalExistingRoot(path.parse(root).root), /filesystem root/);
    const workspace = path.join(root, 'workspace');
    const alias = path.join(root, 'alias');
    fs.mkdirSync(workspace);
    fs.symlinkSync(workspace, alias, 'dir');
    assert.throws(() => catalog.register(ownerKey, alias), /real directory|symlink/);
    assert.deepStrictEqual(catalog.roots(ownerKey), []);
  });

  it('isolates roots belonging to different opaque owners', function () {
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    fs.mkdirSync(first);
    fs.mkdirSync(second);
    catalog.register(ownerKey, first);
    catalog.register('b'.repeat(64), second);
    assert.deepStrictEqual(catalog.roots(ownerKey), [first]);
    assert.deepStrictEqual(catalog.roots('b'.repeat(64)), [second]);
  });

  it('never assigns one plaintext workspace archive to two web accounts', function () {
    const workspace = path.join(root, 'shared');
    const otherOwner = 'b'.repeat(64);
    fs.mkdirSync(workspace);
    catalog.register(ownerKey, workspace);

    assert.throws(
      () => catalog.register(otherOwner, workspace),
      (error) => error.code === 'WORKSPACE_OWNER_CONFLICT',
    );
    assert.deepStrictEqual(catalog.roots(ownerKey), [workspace]);
    assert.deepStrictEqual(catalog.roots(otherOwner), []);
  });

  it('rejects cross-owner ancestor and descendant workspace claims', function () {
    const parent = path.join(root, 'tree');
    const child = path.join(parent, 'nested');
    const otherOwner = 'b'.repeat(64);
    fs.mkdirSync(child, { recursive: true });

    catalog.register(ownerKey, parent);
    assert.throws(
      () => catalog.register(otherOwner, child),
      (error) => error.code === 'WORKSPACE_OWNER_CONFLICT',
    );

    catalog.unregister(ownerKey, parent);
    catalog.register(ownerKey, child);
    assert.throws(
      () => catalog.register(otherOwner, parent),
      (error) => error.code === 'WORKSPACE_OWNER_CONFLICT',
    );
  });

  it('uses path components rather than string prefixes for owner conflicts', function () {
    const first = path.join(root, 'work');
    const siblingPrefix = path.join(root, 'workspace');
    fs.mkdirSync(first);
    fs.mkdirSync(siblingPrefix);

    catalog.register(ownerKey, first);
    assert.doesNotThrow(() => catalog.register('b'.repeat(64), siblingPrefix));
  });

  it('quarantines a legacy root listed for more than one owner', function () {
    const workspace = path.join(root, 'legacy-shared');
    const otherOwner = 'b'.repeat(64);
    fs.mkdirSync(workspace);
    values.set('session_workspace_roots.v1', JSON.stringify([
      { ownerKey, roots: [workspace] },
      { ownerKey: otherOwner, roots: [workspace] },
    ]));

    assert.deepStrictEqual(catalog.roots(ownerKey), []);
    assert.deepStrictEqual(catalog.roots(otherOwner), []);
  });

  it('quarantines legacy cross-owner ancestor and descendant roots', function () {
    const parent = path.join(root, 'legacy-tree');
    const child = path.join(parent, 'nested');
    const otherOwner = 'b'.repeat(64);
    fs.mkdirSync(child, { recursive: true });
    values.set('session_workspace_roots.v1', JSON.stringify([
      { ownerKey, roots: [parent] },
      { ownerKey: otherOwner, roots: [child] },
    ]));

    assert.deepStrictEqual(catalog.roots(ownerKey), []);
    assert.deepStrictEqual(catalog.roots(otherOwner), []);
  });

  it('quarantines legacy cross-owner aliases by their canonical target', function () {
    const workspace = path.join(root, 'legacy-target');
    const alias = path.join(root, 'legacy-alias');
    const otherOwner = 'b'.repeat(64);
    fs.mkdirSync(workspace);
    fs.symlinkSync(workspace, alias, 'dir');
    values.set('session_workspace_roots.v1', JSON.stringify([
      { ownerKey, roots: [workspace] },
      { ownerKey: otherOwner, roots: [alias] },
    ]));

    assert.deepStrictEqual(catalog.roots(ownerKey), []);
    assert.deepStrictEqual(catalog.roots(otherOwner), []);
    assert.throws(
      () => catalog.register('c'.repeat(64), workspace),
      (error) => error.code === 'WORKSPACE_OWNER_CONFLICT',
    );
  });
});
