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
      ompAlias: 'OhMy',
      antigravityAlias: 'Gravity',
      noAuth: true // avoid auth middleware complexity
    });

    assert.strictEqual(server.aliases.claude, 'Buddy');
    assert.strictEqual(server.aliases.codex, 'Robo');
    assert.strictEqual(server.aliases.agent, 'Helper');
    assert.strictEqual(server.aliases.pi, 'Greco');
    assert.strictEqual(server.aliases.grok, 'Xai');
    assert.strictEqual(server.aliases.qwen, 'Tongyi');
    assert.strictEqual(server.aliases.kimi, 'Moonshot');
    assert.strictEqual(server.aliases.omp, 'OhMy');
    assert.strictEqual(server.aliases.antigravity, 'Gravity');
  });

  it('should default aliases when not provided', function() {
    const server = new ClaudeCodeWebServer({ noAuth: true });
    for (const kind of ['claude', 'codex', 'agent', 'pi', 'grok', 'qwen', 'kimi', 'omp', 'antigravity']) {
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
    for (const kind of ['claude', 'codex', 'agent', 'pi', 'grok', 'qwen', 'kimi', 'omp', 'antigravity', 'terminal']) {
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
    const kinds = ['claude', 'codex', 'agent', 'pi', 'grok', 'qwen', 'kimi', 'omp', 'antigravity', 'terminal'];
    const seen = new Map();
    for (const kind of kinds) {
      const bridge = server.getRuntimeBridge(kind);
      const clash = seen.get(bridge);
      assert.ok(!clash, `${kind} shares a bridge instance with ${clash}`);
      seen.set(bridge, kind);
    }
  });

  // The label lookups are where the fall-through actually bites. Both
  // getRuntimeLabel and getRuntimeErrorLabel end in `case 'claude': default:`,
  // so a kind that reached the AgentKind union but never got a case compiles,
  // runs, starts its session — and reports itself as Claude throughout.
  //
  // Aliases are passed explicitly for every runtime rather than relying on the
  // defaults: createConfig resolves each one as
  // `options.xAlias || process.env.X_ALIAS || 'X'`, so an ambient CLAUDE_ALIAS
  // or QWEN_ALIAS in the environment could otherwise collide two labels and
  // fail this run for reasons that have nothing to do with the code.
  const EXPLICIT = {
    claude: 'Alias-claude',
    codex: 'Alias-codex',
    agent: 'Alias-agent',
    pi: 'Alias-pi',
    grok: 'Alias-grok',
    qwen: 'Alias-qwen',
    kimi: 'Alias-kimi',
    omp: 'Alias-omp',
    antigravity: 'Alias-antigravity',
  };

  function serverWithExplicitAliases() {
    return new ClaudeCodeWebServer({
      noAuth: true,
      claudeAlias: EXPLICIT.claude,
      codexAlias: EXPLICIT.codex,
      agentAlias: EXPLICIT.agent,
      piAlias: EXPLICIT.pi,
      grokAlias: EXPLICIT.grok,
      qwenAlias: EXPLICIT.qwen,
      kimiAlias: EXPLICIT.kimi,
      ompAlias: EXPLICIT.omp,
      antigravityAlias: EXPLICIT.antigravity,
    });
  }

  it('getRuntimeLabel returns each runtime own alias, never Claude\'s', function() {
    const processor = serverWithExplicitAliases().messageProcessor;
    // `private` in TypeScript is erased at runtime, so this is callable here.
    for (const [kind, expected] of Object.entries(EXPLICIT)) {
      assert.strictEqual(
        processor.getRuntimeLabel(kind),
        expected,
        `getRuntimeLabel('${kind}') fell through — it is missing a case`,
      );
    }
  });

  it('getRuntimeErrorLabel names each runtime distinctly', function() {
    const processor = serverWithExplicitAliases().messageProcessor;
    // These are product names rather than aliases, so they are checked for
    // distinctness instead of exact values.
    const kinds = Object.keys(EXPLICIT);
    const seen = new Map();
    for (const kind of kinds) {
      const label = processor.getRuntimeErrorLabel(kind);
      assert.ok(label, `getRuntimeErrorLabel('${kind}') returned nothing`);
      const clash = seen.get(label);
      assert.ok(
        !clash,
        `getRuntimeErrorLabel('${kind}') returned '${label}', same as '${clash}' — a missing case falls through to Claude`,
      );
      seen.set(label, kind);
    }
  });
});
