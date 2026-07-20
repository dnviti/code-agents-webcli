const assert = require('assert');
const os = require('os');
const path = require('path');
const { PiBridge } = require('../dist/server/bridges/pi.js');
const { GrokBridge } = require('../dist/server/bridges/grok.js');

// getCommandCandidates and getArgs are protected in TypeScript, which is a
// compile-time constraint only; from CommonJS they are ordinary methods.
describe('PiBridge', function () {
  const bridge = new PiBridge();

  it('looks for pi on PATH and in the usual install locations', function () {
    const candidates = bridge.getCommandCandidates();
    assert.ok(candidates.includes('pi'));
    assert.ok(candidates.includes(path.join(os.homedir(), '.local', 'bin', 'pi')));
  });

  it('starts interactively with no arguments', function () {
    // --print would make it process one prompt and exit, which is the opposite
    // of what a terminal session wants.
    assert.deepStrictEqual(bridge.getArgs({}), []);
  });

  it('passes no approval-bypass flag even when asked', function () {
    // pi's --approve only trusts project-local extension and skill files; it is
    // not the tool-approval bypass that Claude's and Codex's flags are, so
    // wiring it to the "dangerous" button would mislabel the consent.
    assert.deepStrictEqual(bridge.getArgs({ dangerouslySkipPermissions: true }), []);
  });
});

describe('GrokBridge', function () {
  const bridge = new GrokBridge();

  it('prefers the installer location, which is often off a service PATH', function () {
    const candidates = bridge.getCommandCandidates();
    assert.strictEqual(candidates[0], path.join(os.homedir(), '.grok', 'bin', 'grok'));
    assert.ok(candidates.includes('grok'));
  });

  it('starts interactively with no arguments by default', function () {
    assert.deepStrictEqual(bridge.getArgs({}), []);
  });

  it('auto-approves tool execution only when explicitly asked', function () {
    assert.deepStrictEqual(
      bridge.getArgs({ dangerouslySkipPermissions: true }),
      ['--always-approve'],
    );
  });
});
