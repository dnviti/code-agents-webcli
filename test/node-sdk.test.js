'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sdk = require('code-agents-webcli/sdk/node');
const qualification = require('../dist/sdk/node/qualification.js');

describe('Node SDK server facade', function () {
  this.timeout(30_000);

  it('owns its public option declarations without raw server type leakage', function () {
    const sdkDir = path.join(__dirname, '../dist/sdk/node');
    const declarations = ['index.d.ts', 'contract.d.ts', 'options.d.ts']
      .map((file) => fs.readFileSync(path.join(sdkDir, file), 'utf8'))
      .join('\n');
    assert.match(declarations, /interface ServerOptions/);
    assert.match(declarations, /interface DesktopServerOptions/);
    assert.doesNotMatch(declarations, /server\/types|from ['"](?:ws|node:https?)['"]/);

    const serverTypes = fs.readFileSync(path.join(__dirname, '../src/server/types.ts'), 'utf8');
    assert.match(serverTypes, /export type \{ DesktopServerOptions, ServerOptions \} from '..\/sdk\/node\/options\.js'/);
    assert.doesNotMatch(serverTypes, /export interface (?:DesktopServerOptions|ServerOptions)/);
  });

  it('exports a narrow host that owns and closes the server lifecycle', async function () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-node-sdk-'));
    const host = sdk.createCodeAgentsServer({
      dataDir: path.join(root, 'data'),
      baseFolder: root,
      port: 0,
      host: '127.0.0.1',
      desktop: { authToken: 'node-sdk-test-token', username: 'node-sdk-test' },
    });

    try {
      assert.deepEqual(Object.keys(sdk), ['createCodeAgentsServer']);
      assert.equal('ClaudeCodeWebServer' in sdk, false);
      assert.deepEqual(Object.keys(host), []);
      assert.deepEqual(
        Object.getOwnPropertyNames(Object.getPrototypeOf(host)).sort(),
        [
          'constructor',
          'desktopAuthCookie',
          'localUrl',
          'runSetupIfNeeded',
          'shutdown',
          'start',
        ],
      );
      for (const internal of ['database', 'getRuntimeBridge', 'messageProcessor']) {
        assert.equal(internal in host, false, `${internal} must stay behind the facade`);
      }

      assert.equal(await host.runSetupIfNeeded(), true);
      const listener = await host.start();
      assert.match(host.localUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.deepEqual(host.desktopAuthCookie, {
        name: 'code_agents_webcli_desktop_auth',
        value: 'node-sdk-test-token',
        httpOnly: true,
        sameSite: 'strict',
      });
      assert.equal(listener.listening, true);
      await host.shutdown();
      assert.equal(listener.listening, false);
    } finally {
      await host.shutdown().catch(() => undefined);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps qualification internals off the public entry point', async function () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-node-sdk-qualification-'));
    const host = sdk.createCodeAgentsServer({ dataDir: root });
    try {
      const implementation = qualification.implementationForQualification(host);
      assert.notEqual(implementation, host);
      assert.equal(qualification.implementationForQualification(host), implementation);
      assert.throws(
        () => qualification.implementationForQualification({}),
        /not created by createCodeAgentsServer/,
      );

      const tools = qualification.qualificationTools();
      assert.deepEqual(
        Object.keys(tools).sort(),
        ['BaseBridge', 'PermissionBroker', 'TerminalBridge', 'ptySource'],
      );
      for (const tool of Object.values(tools)) assert.equal(typeof tool, 'function');
      assert.equal('qualificationTools' in sdk, false);
      assert.equal('implementationForQualification' in sdk, false);
    } finally {
      await host.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('loads qualification tools only when each tool is accessed', function () {
    const qualificationPath = require.resolve('../dist/sdk/node/qualification.js');
    const script = `
      const Module = require('node:module');
      const loaded = [];
      const original = Module._load;
      Module._load = function (request) {
        if (request.includes('server/')) loaded.push(request);
        return original.apply(this, arguments);
      };
      const qualification = require(${JSON.stringify(qualificationPath)});
      qualification.qualificationTools();
      if (loaded.length) throw new Error('qualification entry eagerly loaded: ' + loaded.join(','));
      qualification.qualificationTools().ptySource;
      if (!loaded.includes('../../server/services/runtime/terminal/pty.js')) throw new Error('PTY was not loaded');
      if (loaded.some((request) => request.includes('server/index'))) throw new Error('server loaded before desktop setup');
    `;
    execFileSync(process.execPath, ['-e', script]);
  });
});
