const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const serverModule = require('../dist/server/index.js');
const {
  ClaudeCodeWebServer,
  applyChatLifecycle,
  probeLaunchedAgentVersion,
  startServer,
} = serverModule;

describe('Server Aliases', function() {
  const fixtures = [];
  const makeServer = (options) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-alias-'));
    const server = new ClaudeCodeWebServer({ ...options, dataDir });
    fixtures.push({ server, dataDir });
    return server;
  };
  afterEach(async function () {
    for (const fixture of fixtures.splice(0)) {
      await fixture.server.shutdown();
      fs.rmSync(fixture.dataDir, { recursive: true, force: true });
    }
  });

  it('keeps the split implementation transparent to the public prototype', function() {
    assert.deepStrictEqual(Object.keys(serverModule), [
      'ClaudeCodeWebServer',
      'probeLaunchedAgentVersion',
      'applyChatLifecycle',
      'startServer',
    ]);
    assert.strictEqual(ClaudeCodeWebServer.length, 0);
    assert.strictEqual(probeLaunchedAgentVersion.length, 3);
    assert.strictEqual(applyChatLifecycle.length, 3);
    assert.strictEqual(startServer.length, 1);
    const prototype = ClaudeCodeWebServer.prototype;
    assert.strictEqual(Object.getPrototypeOf(prototype), Object.prototype);
    for (const member of ['localUrl', 'desktopAuthCookie', 'shutdown', 'runSetupIfNeeded', 'start', 'close']) {
      assert.ok(Object.hasOwn(prototype, member), `${member} must remain on the public prototype`);
    }
    for (const specifier of [
      'code-agents-webcli/dist/server/server-core.js',
      'code-agents-webcli/dist/server/server-core',
      'code-agents-webcli/dist/server/Server-core.js',
      'code-agents-webcli/Dist/server/server-core.js',
      'code-agents-webcli/dist/Server/server-functions',
    ]) {
      assert.throws(
        () => require(specifier),
        (error) => error?.code === 'MODULE_NOT_FOUND',
      );
    }
  });

  it('should set aliases from options', function() {
    const server = makeServer({
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
    const server = makeServer({ noAuth: true });
    for (const kind of ['claude', 'codex', 'agent', 'pi', 'grok', 'qwen', 'kimi', 'omp', 'antigravity']) {
      assert.ok(
        server.aliases[kind] && server.aliases[kind].length > 0,
        `${kind} must have a default alias`,
      );
    }
  });

  it('resolves a bridge for every agent kind', function() {
    const server = makeServer({ noAuth: true });
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
    const server = makeServer({ noAuth: true });
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
    return makeServer({
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
