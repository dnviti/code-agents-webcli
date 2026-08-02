const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let temp;
let bundledModule;

beforeEach(function () {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'builtin-workflow-'));
  bundledModule = path.join(temp, 'dist', 'server', 'chat', 'builtin-workflows.js');
  fs.mkdirSync(path.dirname(bundledModule), { recursive: true });
  require('esbuild').buildSync({
    entryPoints: [path.join(ROOT, 'src', 'server', 'chat', 'builtin-workflows.ts')],
    bundle: true,
    outfile: bundledModule,
    format: 'cjs',
    platform: 'node',
    target: ['node20'],
    logLevel: 'silent',
  });
});

afterEach(function () {
  if (bundledModule) delete require.cache[require.resolve(bundledModule)];
  if (temp) fs.rmSync(temp, { recursive: true, force: true });
});

describe('app-owned built-in workflows', function () {
  it('fails visibly when an installed application is missing its required asset', function () {
    const { builtInWorkflowInstructions } = require(bundledModule);
    assert.throws(
      () => builtInWorkflowInstructions('gh-issue'),
      /bundled gh-issue workflow is unavailable/i,
    );
  });

  it('loads only the application copy, even when the guest has a same-named skill', function () {
    const installed = path.join(temp, 'dist', 'server', 'chat', 'builtin-workflows', 'gh-issue', 'SKILL.md');
    fs.mkdirSync(path.dirname(installed), { recursive: true });
    fs.writeFileSync(installed, '# APP-OWNED-GH-ISSUE');

    const guest = path.join(temp, 'guest');
    const shadow = path.join(guest, '.agents', 'skills', 'gh-issue', 'SKILL.md');
    fs.mkdirSync(path.dirname(shadow), { recursive: true });
    fs.writeFileSync(shadow, '# GUEST-SHADOW');

    const previous = process.cwd();
    try {
      process.chdir(guest);
      const { builtInWorkflowInstructions } = require(bundledModule);
      assert.strictEqual(builtInWorkflowInstructions('gh-issue'), '# APP-OWNED-GH-ISSUE');
    } finally {
      process.chdir(previous);
    }
  });

  it('refreshes the copied asset in watch builds', function () {
    const buildScript = fs.readFileSync(path.join(ROOT, 'scripts', 'build.js'), 'utf8');
    assert.match(buildScript, /copyBuiltinWorkflowAssets\(\{ watch: isWatch \}\)/);
    assert.match(buildScript, /fs\.watch\(ghIssueSource/);
    assert.match(buildScript, /copy\(\);\s*console\.log\('\[workflows\] Updated bundled gh-issue workflow\.'/);
  });
});
