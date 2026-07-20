const assert = require('assert');
const { ClaudeCodeWebServer } = require('../dist/server/index.js');

describe('Server Aliases', function() {
  it('should set aliases from options', function() {
    const server = new ClaudeCodeWebServer({
      claudeAlias: 'Buddy',
      codexAlias: 'Robo',
      agentAlias: 'Helper',
      piAlias: 'Greco',
      grokAlias: 'Xai',
      noAuth: true // avoid auth middleware complexity
    });

    assert.strictEqual(server.aliases.claude, 'Buddy');
    assert.strictEqual(server.aliases.codex, 'Robo');
    assert.strictEqual(server.aliases.agent, 'Helper');
    assert.strictEqual(server.aliases.pi, 'Greco');
    assert.strictEqual(server.aliases.grok, 'Xai');
  });

  it('should default aliases when not provided', function() {
    const server = new ClaudeCodeWebServer({ noAuth: true });
    for (const kind of ['claude', 'codex', 'agent', 'pi', 'grok']) {
      assert.ok(
        server.aliases[kind] && server.aliases[kind].length > 0,
        `${kind} must have a default alias`,
      );
    }
  });

  it('resolves a bridge for every agent kind', function() {
    const server = new ClaudeCodeWebServer({ noAuth: true });
    // A kind with no bridge fails at start time with a confusing message
    // rather than here, so the mapping is asserted directly.
    for (const kind of ['claude', 'codex', 'agent', 'pi', 'grok', 'terminal']) {
      assert.ok(server.getRuntimeBridge(kind), `${kind} must resolve to a bridge`);
    }
    assert.strictEqual(server.getRuntimeBridge('nonesuch'), null);
  });
});
