const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const registry = require('../dist/server/chat/registry.js');
const { ChatSession } = require('../dist/server/chat/session.js');
const {
  ASK_QUESTION_TOOL_NAME,
  SUBMIT_PLAN_TOOL_NAME,
} = require('../dist/shared/chat-events.js');

const ROOT = path.join(__dirname, '..');
const ASK_SERVER = path.join(ROOT, 'dist', 'server', 'chat', 'ask-mcp.js');

function storeFor(runtime) {
  const events = [];
  return {
    append(_ref, batch) { events.push(...batch); },
    async stat() { return { firstSeq: 1, cursor: events.length }; },
    async read() { return { events: [], firstSeq: 1, from: 1, cursor: events.length }; },
    async snapshot() {
      return {
        sessionId: `remote-${runtime}`, runtime, messages: [], state: 'idle',
        capabilities: {}, pendingPermissions: [], pendingQuestions: [],
        firstSeq: 1, replayFrom: 1, cursor: events.length, live: true,
        bypassPermissions: true,
      };
    },
    async planDocument() { return null; },
    async setPlanDocument() {},
    async clearPlanDocument() {},
  };
}

function containerEnvironment(home) {
  const containerHome = '/home/remote-user';
  const translate = (hostPath) => {
    const relative = path.relative(home, path.resolve(hostPath));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('outside test home');
    return relative ? `${containerHome}/${relative.split(path.sep).join('/')}` : containerHome;
  };
  return {
    kind: 'container', name: 'remote-user', identity: 'container-1',
    homeDir: home, containerHome, nodePath: 'node', shells: ['/bin/sh'],
    mounts: [{ hostPath: home, containerPath: containerHome }],
    toContainerPath: translate,
    toHostPath(containerPath) {
      return path.join(home, path.posix.relative(containerHome, containerPath));
    },
    wrap(command, args, options = {}) { return { command, args, env: options.env || {} }; },
  };
}

describe('the shared-home tools in remote Web-chat runtimes', function () {
  it('wires questions and Plan submission through every supported launch shape', async function () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-chat-tools-'));
    const socketDir = path.join(root, 'sockets');
    const realFactory = registry.createChatAdapter;
    const created = [];
    registry.createChatAdapter = (runtime, options) => {
      const adapter = {
        runtime,
        options,
        alive: true,
        readyForTurn: true,
        capabilities: {
          streaming: true, thinking: true, toolCalls: true, diffs: false,
          permissions: false, questions: false, planMode: false, interrupt: true,
          resume: false, fork: false, attachments: false, usage: false,
          cost: false, plan: false,
        },
        async start() {},
        sent: [],
        async send(turn) { this.sent.push(turn.text); },
        async interrupt() {},
        async stop() { this.alive = false; },
        respondPermission() {},
      };
      created.push(adapter);
      return adapter;
    };

    try {
      for (const runtime of ['claude', 'codex', 'grok', 'pi', 'kimi', 'omp', 'antigravity']) {
        const home = path.join(root, runtime);
        fs.mkdirSync(home, { recursive: true });
        const session = new ChatSession(
          { id: `remote-${runtime}`, ownerUserId: 7 },
          {
            store: storeFor(runtime),
            socketDir,
            hookScript: path.join(ROOT, 'does-not-exist-hook.js'),
            askScript: ASK_SERVER,
            broadcast: () => {},
            resolveCommand: () => path.join(ROOT, 'does-not-exist-runtime'),
          },
        );
        await session.start({
          runtime,
          workingDir: home,
          environment: containerEnvironment(home),
          bypassPermissions: true,
          planMode: false,
        });

        const adapter = created[created.length - 1];
        assert.strictEqual(session.currentCapabilities.questions, true, `${runtime} questions`);
        assert.strictEqual(session.currentCapabilities.planMode, true, `${runtime} Plan mode`);

        if (runtime === 'antigravity') {
          assert.strictEqual(session.questionFallbackEnabled, true);
          assert.strictEqual(adapter.options.env.CCWEB_CALLBACK_DIR, undefined);
        } else {
          assert.match(adapter.options.env.CCWEB_CALLBACK_DIR, /^\/home\/remote-user\/\.ccweb-callback\//);
          assert.ok(adapter.options.env.CCWEB_CALLBACK_TOKEN);
        }

        if (runtime === 'claude') {
          const at = adapter.options.extraArgs.indexOf('--mcp-config');
          assert.ok(at >= 0);
          const config = JSON.parse(adapter.options.extraArgs[at + 1]).mcpServers.ccweb;
          assert.match(config.args[0], /^\/home\/remote-user\/\.ccweb-callback\/.+\/ccweb-mcp\.mjs$/);
          assert.ok(adapter.options.extraArgs.includes(ASK_QUESTION_TOOL_NAME));
          assert.ok(adapter.options.extraArgs.includes(SUBMIT_PLAN_TOOL_NAME));
        } else if (runtime === 'codex') {
          assert.ok(adapter.options.extraArgs.some((arg) => String(arg).startsWith('mcp_servers.ccweb.command=')));
          assert.ok(adapter.options.extraArgs.some((arg) => String(arg).includes('ccweb-mcp.mjs')));
        } else if (['grok', 'kimi', 'omp'].includes(runtime)) {
          assert.strictEqual(adapter.options.askMcpServer.name, 'ccweb');
          assert.match(adapter.options.askMcpServer.args[0], /^\/home\/remote-user\/\.ccweb-callback\/.+\/ccweb-mcp\.mjs$/);
        } else if (runtime === 'pi') {
          const at = adapter.options.extraArgs.indexOf('-e');
          assert.ok(at >= 0);
          assert.match(adapter.options.extraArgs[at + 1], /^\/home\/remote-user\/\.ccweb-callback\/.+\/\.pi\/ccweb\/ask-user\.ts$/);
        }

        await session.send({ text: 'Choose the safest approach.' });
        if (runtime === 'antigravity') {
          assert.match(adapter.sent[0], /Interactive-question fallback/);
        } else {
          assert.match(adapter.sent[0], /both Default and Plan mode/);
          assert.match(adapter.sent[0], /ask_user_question tool/);
        }

        await session.stop();
      }
    } finally {
      registry.createChatAdapter = realFactory;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
