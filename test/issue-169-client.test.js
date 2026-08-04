const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

describe('issue #169 project composition client', function () {
  let bundle;

  before(function () {
    bundle = path.join(os.tmpdir(), `issue-169-client-${process.pid}.cjs`);
    require('esbuild').buildSync({
      stdin: {
        contents: [
          `export { normalizeStorageReport } from ${JSON.stringify(path.join(ROOT, 'src/client/shell/composition-api.ts'))};`,
          `export { initialRuntimeChoices, initialAgentRuntimeChoices, isConservativeRuntimeVersion, runtimeVersionHintLabel, compositionRequiresRebuild, compositionIsFirstBuild, confirmationBaseRevision } from ${JSON.stringify(path.join(ROOT, 'src/client/shell/dialogs/ProjectCompositionPanel.tsx'))};`,
          `export { formatStorageBytes, storageWarningKind } from ${JSON.stringify(path.join(ROOT, 'src/client/shell/dialogs/WorkspaceDataPanel.tsx'))};`,
          `export { warningGiBToBytes } from ${JSON.stringify(path.join(ROOT, 'src/client/shell/dialogs/DeployTargetsDialog.tsx'))};`,
        ].join('\n'),
        resolveDir: ROOT,
        loader: 'ts',
      },
      bundle: true,
      outfile: bundle,
      format: 'cjs',
      platform: 'node',
      target: ['node20'],
      logLevel: 'silent',
    });
  });

  it('distinguishes pending first-build rows from an applied composition', function () {
    const { compositionRequiresRebuild, compositionIsFirstBuild, confirmationBaseRevision } = require(bundle);
    const project = {
      state: 'composition_pending',
      compositionRevision: null,
      appliedCompositionRevision: null,
    };
    const composition = {
      revision: 'draft-1',
      activeRevision: null,
      appliedRevision: null,
      // The server creates pending installation rows with every draft. Their
      // presence must not turn the first build into a rebuild.
      installations: [{ itemId: 'node', status: 'pending' }],
    };
    assert.equal(compositionRequiresRebuild(project, composition), false);
    assert.equal(compositionIsFirstBuild(project, composition), true);
    assert.equal(confirmationBaseRevision(project, composition), null);

    composition.activeRevision = 'active-1';
    composition.appliedRevision = 'active-1';
    assert.equal(compositionRequiresRebuild(project, composition), true);
    assert.equal(compositionIsFirstBuild(project, composition), false);
    assert.equal(confirmationBaseRevision(project, composition), 'active-1');

    composition.revision = 'active-1';
    project.state = 'running';
    assert.equal(compositionRequiresRebuild(project, composition), false);
  });

  it('matches server-side conservative versions and rounds fractional GiB to bytes', function () {
    const { isConservativeRuntimeVersion, runtimeVersionHintLabel, warningGiBToBytes } = require(bundle);
    assert.equal(isConservativeRuntimeVersion('22'), true);
    assert.equal(isConservativeRuntimeVersion('3.13.2'), true);
    assert.equal(isConservativeRuntimeVersion('22-lts'), false);
    assert.equal(isConservativeRuntimeVersion('03.13'), false);
    assert.equal(runtimeVersionHintLabel({ path: '.tool-versions', version: '22.14.0' }), '22.14.0 from .tool-versions');
    assert.equal(runtimeVersionHintLabel('22.14.0'), '22.14.0');
    assert.equal(warningGiBToBytes('0.1'), 107374182);
    assert.equal(warningGiBToBytes(''), null);
    assert.equal(warningGiBToBytes('0'), 0);
    assert.equal(warningGiBToBytes('-1'), undefined);
  });

  after(function () {
    fs.rmSync(bundle, { force: true });
  });

  it('prefers a saved recipe and otherwise seeds only detected runtimes', function () {
    const { initialRuntimeChoices, initialAgentRuntimeChoices } = require(bundle);
    const base = {
      catalog: { version: 'v1', runtimes: [] },
      composition: {
        revision: 'r1',
        detected: {
          catalogVersion: 'v1', sourceOid: 'abc', sourceRef: 'HEAD', forgeHint: 'github',
          detectedRuntimes: [
            { runtimeId: 'node', sources: ['package.json'], versionHints: ['22'], selectedVersion: '22', versionSource: 'manifest' },
            { runtimeId: 'python', sources: ['pyproject.toml'], versionHints: [], selectedVersion: '3.13', versionSource: 'default' },
          ],
        },
        chosen: null,
        installations: [], identity: null, identitySource: 'incomplete', forge: null,
      },
    };
    assert.deepEqual(initialRuntimeChoices(base), [
      { runtimeId: 'node', version: '22' },
      { runtimeId: 'python', version: '3.13' },
    ]);
    base.composition.chosen = { runtimes: [{ runtimeId: 'go', version: '1.24' }] };
    assert.deepEqual(initialRuntimeChoices(base), [{ runtimeId: 'go', version: '1.24' }]);
    assert.deepEqual(initialAgentRuntimeChoices(base), []);
    base.composition.chosen.agents = [{ runtimeId: 'codex', version: '0.146.0' }];
    assert.deepEqual(initialAgentRuntimeChoices(base), [{ runtimeId: 'codex', version: '0.146.0' }]);
  });

  it('normalizes the fixed storage contract and the integration envelope', function () {
    const { normalizeStorageReport, formatStorageBytes } = require(bundle);
    const report = normalizeStorageReport({ report: {
      totalBytes: 1536,
      homeBytes: 1024,
      agentsBytes: 256,
      toolingBytes: 512,
      otherHomeBytes: 256,
      projects: [{ projectId: 'p1', name: 'Relay', workspaceBytes: 400, overlayBytes: 112 }],
      filesystems: [{ freeBytes: 10_000 }],
      warnings: { user: true },
      errors: [{ code: 'timeout', message: 'scan ended early' }],
      complete: false,
      recordedAt: '2026-08-03T12:00:00.000Z',
    } });
    assert.equal(report.home.totalBytes, 1024);
    assert.equal(report.projects[0].totalBytes, 512);
    assert.equal(report.errors[0], 'timeout: scan ended early');
    assert.equal(formatStorageBytes(report.totalBytes), '1.5 KB');
  });

  it('wires the recipe, rebuild acknowledgement, retry, identity, storage, and host-safe status UX', function () {
    const projects = read('src/client/shell/dialogs/ProjectsDialog.tsx');
    const recipe = read('src/client/shell/dialogs/ProjectCompositionPanel.tsx');
    const storage = read('src/client/shell/dialogs/WorkspaceDataPanel.tsx');
    const api = read('src/client/shell/composition-api.ts');

    assert.match(projects, /Inspect repository/);
    assert.match(projects, /Review recipe/);
    assert.match(projects, /composition\/inspect/);
    assert.match(projects, /Repository updated\. Inspection started/);
    assert.match(projects, /token values are never returned to this page/);
    assert.match(projects, /validationStatus === 'invalid'/);
    assert.match(projects, /value: 'forgejo'/);
    assert.match(projects, /requestAnimationFrame[\s\S]*\.focus\(\)/);
    assert.match(recipe, /Detected → Selected → Installed/);
    assert.match(recipe, /Setup pending/);
    assert.match(recipe, /No runtime markers were found\. The full supported catalog is available below/);
    assert.match(recipe, /Every repository needs its matching forge choice/);
    assert.match(recipe, /Retry failed setup/);
    assert.match(recipe, /Choose the agent CLIs this container must be able to launch/);
    assert.match(recipe, /including the agent CLIs to install/);
    assert.match(recipe, /I reviewed the repository evidence, selected runtimes and versions, and forge choice for this first build/);
    assert.match(recipe, /preserves repository work, keeps user home and project setup, and rebuilds the workspace/);
    assert.match(recipe, /permanently discards this project workspace/);
    assert.match(recipe, /Save override/);
    assert.match(recipe, /Save or revert identity changes before building/);
    assert.match(storage, /Global Git identity/);
    assert.match(storage, /Measured and reported, never used as a quota/);
    assert.match(storage, /Clear download cache/);
    assert.match(storage, /Remove unused runtime versions/);
    assert.match(api, /unusedToolVersions/);
    assert.match(storage, /Installation storage/);
    assert.match(storage, /This is informational; running and building remain available/);
    assert.match(api, /\/api\/projects\/\$\{encodeURIComponent\(projectId\)\}\/composition\/confirm/);
    assert.match(api, /\/api\/projects\/\$\{encodeURIComponent\(projectId\)\}\/composition\/retry/);
    assert.match(api, /\/api\/usage\/storage\$\{refresh \? '\?refresh=1' : ''\}/);
    assert.doesNotMatch(api, /token/);

    const targets = read('src/client/shell/dialogs/DeployTargetsDialog.tsx');
    assert.match(targets, /Math\.round\(value \* \(1024 \*\* 3\)\)/);
    assert.match(targets, /value >= 0/);
    assert.match(targets, /leave it blank to disable that warning/);
    assert.match(targets, /aria-invalid/);
  });
});
