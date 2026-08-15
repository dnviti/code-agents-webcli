'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  ROOT_SERVICE_FORWARDERS,
  SERVICE_DIRECTORY_FORWARDERS,
  listLegacyServiceForwarders,
} = require('../scripts/service-compatibility.js');

const ROOT = path.join(__dirname, '..');
const SOURCE_SERVICES = path.join(ROOT, 'src', 'server', 'services');
const DIST_SERVICES = path.join(ROOT, 'dist', 'server', 'services');

function sourcePath(relative) {
  return path.join(SOURCE_SERVICES, ...relative.split('/'));
}

function distPath(relative, extension) {
  return path.join(DIST_SERVICES, ...relative.split('/')) + extension;
}

describe('service domain organization', function () {
  it('keeps implementations in domain directories rather than the service root', function () {
    const rootTypeScript = fs.readdirSync(SOURCE_SERVICES, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'));
    assert.deepEqual(rootTypeScript, []);

    for (const canonical of Object.values(ROOT_SERVICE_FORWARDERS)) {
      assert.ok(fs.existsSync(sourcePath(`${canonical}.ts`)), `missing canonical service ${canonical}.ts`);
    }
    for (const [legacy, canonical] of Object.entries(SERVICE_DIRECTORY_FORWARDERS)) {
      assert.equal(fs.existsSync(sourcePath(legacy)), false, `legacy source directory remains: ${legacy}`);
      assert.ok(fs.existsSync(sourcePath(canonical)), `missing canonical directory ${canonical}`);
    }
  });

  it('emits every legacy compiled module as an exact canonical forwarder', function () {
    const entries = listLegacyServiceForwarders(DIST_SERVICES);
    assert.equal(entries.length, 91);

    for (const { legacy, canonical } of entries) {
      const legacyJavaScript = distPath(legacy, '.js');
      const canonicalJavaScript = distPath(canonical, '.js');
      const legacyDeclaration = distPath(legacy, '.d.ts');
      assert.ok(fs.existsSync(legacyJavaScript), `missing legacy JavaScript path ${legacy}.js`);
      assert.ok(fs.existsSync(legacyDeclaration), `missing legacy declaration path ${legacy}.d.ts`);
      assert.ok(fs.existsSync(`${legacyJavaScript}.map`), `missing legacy source map ${legacy}.js.map`);
      assert.ok(fs.existsSync(`${legacyDeclaration}.map`), `missing legacy declaration map ${legacy}.d.ts.map`);
      for (const mapFile of [`${legacyJavaScript}.map`, `${legacyDeclaration}.map`]) {
        const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
        assert.ok(map.mappings, `${path.basename(mapFile)} has no usable mappings`);
        assert.ok(map.sources?.length, `${path.basename(mapFile)} has no canonical source`);
        assert.ok(
          fs.existsSync(path.resolve(path.dirname(mapFile), map.sourceRoot || '', map.sources[0])),
          `${path.basename(mapFile)} does not point to the relocated source`,
        );
      }
      assert.equal(
        path.normalize(require.resolve(`code-agents-webcli/dist/server/services/${legacy}.js`)),
        path.normalize(legacyJavaScript),
        `package self-reference cannot resolve ${legacy}.js`,
      );

      const source = fs.readFileSync(legacyJavaScript, 'utf8');
      const match = source.match(/module\.exports = require\('([^']+)'\)/);
      assert.ok(match, `${legacy}.js is not a CommonJS forwarder`);
      assert.equal(
        path.normalize(path.resolve(path.dirname(legacyJavaScript), match[1])),
        path.normalize(canonicalJavaScript),
        `${legacy}.js forwards to the wrong canonical module`,
      );
      assert.match(fs.readFileSync(legacyDeclaration, 'utf8'), /^export \* from /);
    }
  });

  it('preserves runtime export identity for representative legacy modules', function () {
    for (const legacy of ['ansi', 'codex-pricing', 'server-identity', 'workspace-private-path']) {
      const canonical = ROOT_SERVICE_FORWARDERS[legacy];
      assert.strictEqual(require(distPath(legacy, '.js')), require(distPath(canonical, '.js')));
    }
  });

  it('preserves named-export discovery for ESM consumers', async function () {
    for (const legacy of ['ansi', 'codex-pricing', 'server-identity', 'workspace-private-path']) {
      const canonical = ROOT_SERVICE_FORWARDERS[legacy];
      const legacyExports = await import(pathToFileURL(distPath(legacy, '.js')));
      const canonicalExports = await import(pathToFileURL(distPath(canonical, '.js')));
      assert.deepEqual(Object.keys(legacyExports).sort(), Object.keys(canonicalExports).sort());
    }
  });

  it('keeps location-sensitive build metadata pointed at the package output', function () {
    const buildInfo = require(distPath('build-info', '.js'));
    const pkg = require('../package.json');
    assert.equal(
      path.normalize(buildInfo.DEFAULT_BUILD_INFO_PATH),
      path.normalize(path.join(ROOT, 'dist', 'build-info.json')),
    );
    assert.equal(buildInfo.readBuildInfo(path.join(ROOT, 'dist', 'missing-build-info.json')).version, pkg.version);
  });

  it('preserves default exports in legacy declarations', function () {
    const defaultExports = [
      'history-store',
      'scrollback',
      'session-store',
      'session-store/session-store',
      'transcript-store',
      'usage-analytics',
      'usage-reader',
      'workspace-session-migrator',
      'workspace-session-migrator/migrator-class',
    ];
    for (const legacy of defaultExports) {
      assert.match(
        fs.readFileSync(distPath(legacy, '.d.ts'), 'utf8'),
        /export \{ default \} from/,
        `${legacy}.d.ts lost its default export`,
      );
    }
  });
});
