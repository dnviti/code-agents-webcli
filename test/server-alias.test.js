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
      qwenAlias: 'Tongyi',
      kimiAlias: 'Moonshot',
      noAuth: true // avoid auth middleware complexity
    });

    assert.strictEqual(server.aliases.claude, 'Buddy');
    assert.strictEqual(server.aliases.codex, 'Robo');
    assert.strictEqual(server.aliases.agent, 'Helper');
    assert.strictEqual(server.aliases.pi, 'Greco');
    assert.strictEqual(server.aliases.grok, 'Xai');
    assert.strictEqual(server.aliases.qwen, 'Tongyi');
    assert.strictEqual(server.aliases.kimi, 'Moonshot');
  });

  it('should default aliases when not provided', function() {
    const server = new ClaudeCodeWebServer({ noAuth: true });
    for (const kind of ['claude', 'codex', 'agent', 'pi', 'grok', 'qwen', 'kimi']) {
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
    for (const kind of ['claude', 'codex', 'agent', 'pi', 'grok', 'qwen', 'kimi', 'terminal']) {
      assert.ok(server.getRuntimeBridge(kind), `${kind} must resolve to a bridge`);
    }
    assert.strictEqual(server.getRuntimeBridge('nonesuch'), null);
  });

  it('gives every runtime its own bridge instance', function() {
    // getRuntimeBridge's switch ends in `default: return null`, but the label
    // lookups it sits beside fall through to Claude. A kind wired into the
    // union but forgotten in one of those switches is invisible: the runtime
    // starts and simply reports itself as Claude. Asserting the bridges are
    // distinct objects catches a case that was pasted but not re-pointed.
    const server = new ClaudeCodeWebServer({ noAuth: true });
    const kinds = ['claude', 'codex', 'agent', 'pi', 'grok', 'qwen', 'kimi', 'terminal'];
    const seen = new Map();
    for (const kind of kinds) {
      const bridge = server.getRuntimeBridge(kind);
      const clash = seen.get(bridge);
      assert.ok(!clash, `${kind} shares a bridge instance with ${clash}`);
      seen.set(bridge, kind);
    }
  });

  it('labels every runtime distinctly rather than falling back to Claude', function() {
    const server = new ClaudeCodeWebServer({ noAuth: true });
    // Same trap, on the user-visible side: the alias map is what the tab title
    // and the "Starting ..." line are built from.
    const labels = ['claude', 'codex', 'agent', 'pi', 'grok', 'qwen', 'kimi']
      .map((kind) => server.aliases[kind]);
    assert.strictEqual(
      new Set(labels).size,
      labels.length,
      `runtime aliases must be distinct, got: ${labels.join(', ')}`,
    );
  });
});
