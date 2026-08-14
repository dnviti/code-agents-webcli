'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const contracts = require('code-agents-webcli/sdk/contracts');
const controller = require('code-agents-webcli/sdk/contracts/controller');
const browser = require('code-agents-webcli/sdk/browser');

describe('public controller SDK', function () {
  it('keeps canonical ids byte-compatible across contracts and browser entry points', function () {
    assert.strictEqual(contracts.CONTROLLER_PRODUCT_ID, 'code-agents-webcli');
    assert.strictEqual(contracts.CONTROLLER_PROTOCOL_VERSION, 1);
    const canonical = 'ccs1.WyJzw6lydmVy8J-YgCIsIuS8muipsS_wn6eqIl0';
    const expected = { serverId: 'sérver😀', sessionId: '会話/🧪' };
    assert.strictEqual(contracts.qualifySessionId(expected.serverId, expected.sessionId), canonical);
    assert.deepStrictEqual(controller.parseQualifiedSessionId(canonical), expected);
    assert.deepStrictEqual(browser.parseQualifiedSessionId(canonical), expected);
  });

  it('rejects an alternate base64url spelling that decodes to the same bytes', function () {
    const alternate = 'ccs1.WyJzw6lydmVy8J-YgCIsIuS8muipsS_wn6eqIl1';
    assert.deepStrictEqual(
      Buffer.from(alternate.slice(5), 'base64url'),
      Buffer.from(contracts.qualifySessionId('sérver😀', '会話/🧪').slice(5), 'base64url'),
    );
    assert.strictEqual(browser.parseQualifiedSessionId(alternate), null);
  });

  it('publishes CommonJS subpaths while retaining deep-import compatibility', function () {
    assert.strictEqual(browser.parseQualifiedSessionId, contracts.parseQualifiedSessionId);
    assert.strictEqual(
      require('code-agents-webcli/dist/sdk/contracts/controller.js').qualifySessionId,
      controller.qualifySessionId,
    );
    for (const legacyPath of [
      'code-agents-webcli/dist/server',
      'code-agents-webcli/dist/server/types',
      'code-agents-webcli/dist/server/types.js',
      'code-agents-webcli/dist/shared/chat-events',
      'code-agents-webcli/dist/shared/chat-events.js',
    ]) assert.ok(require.resolve(legacyPath), `${legacyPath} must remain resolvable`);
  });

  it('publishes extensionless SDK subpaths to native ESM consumers', async function () {
    const imported = await import('code-agents-webcli/sdk/contracts');
    assert.strictEqual(imported.qualifySessionId, contracts.qualifySessionId);
  });

  it('publishes TypeScript declarations for all three SDK entry points', function () {
    execFileSync(process.execPath, [
      require.resolve('typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--target', 'ES2020',
      '--module', 'Node16',
      '--moduleResolution', 'Node16',
      '--lib', 'ES2020,DOM',
      '--ignoreConfig',
      path.join(__dirname, 'fixtures/sdk-consumer.ts'),
    ]);
  });

  it('keeps the contracts source free of runtime-specific dependencies', function () {
    const source = fs.readFileSync(path.join(__dirname, '../src/sdk/contracts/controller.ts'), 'utf8');
    assert.doesNotMatch(source, /\b(?:Buffer|document|window)\b|^\s*import\s/m);
  });

  it('keeps the browser SDK free of Node, server, Electron, and React code', async function () {
    const result = await esbuild.build({
      entryPoints: [path.join(__dirname, '../src/sdk/browser/index.ts')],
      bundle: true,
      platform: 'browser',
      write: false,
      metafile: true,
      logLevel: 'silent',
    });
    const inputs = Object.keys(result.metafile.inputs).join('\n');
    assert.doesNotMatch(inputs, /(?:^|[\\/])(?:server|desktop)(?:[\\/])|node:|node_modules[\\/](?:electron|express|react)(?:[\\/]|$)/);
  });

  it('keeps DOM types out of the server and Node SDK compiler boundary', function () {
    const serverConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '../tsconfig.json'), 'utf8'));
    assert.deepStrictEqual(serverConfig.compilerOptions.lib, ['ES2020']);
    assert.equal(serverConfig.include.some((value) => value.includes('sdk/browser')), false);
  });

  it('keeps each new SDK module review-sized and the desktop root below 1,000 lines', function () {
    const sdkRoot = path.join(__dirname, '../src/sdk');
    for (const file of fs.readdirSync(sdkRoot, { recursive: true })) {
      if (!file.endsWith('.ts')) continue;
      const lines = fs.readFileSync(path.join(sdkRoot, file), 'utf8').split(/\r?\n/).length;
      assert.ok(lines <= 500, `${file} has ${lines} lines`);
    }
    const desktopLines = fs.readFileSync(path.join(__dirname, '../desktop/main.js'), 'utf8').split(/\r?\n/).length;
    assert.ok(desktopLines <= 1_000, `desktop/main.js has ${desktopLines} lines`);
  });
});
