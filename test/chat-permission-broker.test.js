const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  PermissionBroker,
  permissionHookSettings,
  windowsPermissionPipePath,
} = require('../dist/server/chat/permission-broker.js');

// This exercises the real pair: the broker listening on a unix socket and the
// actual hook script the CLI spawns, talking to each other over that socket
// with the payload shape the CLI really sends (captured from Claude Code
// 2.1.220 — see .work/probes). Testing the broker alone would prove nothing,
// because the contract that matters is the one the hook has to satisfy.
//
// The security property under test is fail-closed: every path that cannot put
// the question in front of a person must deny. Those cases are the ones a
// refactor breaks silently, because the happy path keeps working.

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(ROOT, 'dist', 'server', 'chat', 'permission-hook.js');

const PAYLOAD = {
  session_id: 'aa526345-c802-47ae-913f-6ad51bb5ccec',
  transcript_path: '/home/u/.claude/projects/x/y.jsonl',
  cwd: '/home/u/project',
  prompt_id: 'p1',
  permission_mode: 'bypassPermissions',
  effort: 'high',
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'rm -rf /tmp/x', description: 'Remove it' },
  tool_use_id: 'toolu_01EaYEk7bykuwhCC86fZeTcC',
};

/**
 * A question handler for the approval tests, which never ask one.
 *
 * The broker takes both handlers because one socket carries both kinds of
 * caller; these tests are about the approval half, so this stands in for the
 * other and would fail loudly if an approval were ever routed to it.
 */
const NO_QUESTIONS = async () => {
  throw new Error('these tests never ask a question');
};

/** Run the hook exactly as the CLI does: payload on stdin, JSON on stdout. */
function runHook(socketPath, payload = PAYLOAD) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      env: socketPath
        ? { ...process.env, CCWEB_PERMISSION_SOCKET: socketPath }
        : { ...process.env, CCWEB_PERMISSION_SOCKET: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let out = '';
    child.stdout.on('data', (c) => {
      out += c.toString();
    });
    child.on('close', (code) => {
      let parsed = null;
      try {
        parsed = JSON.parse(out.trim());
      } catch {
        /* left null so the assertion reports the raw output */
      }
      resolve({ code, out, decision: parsed?.hookSpecificOutput });
    });

    child.stdin.end(JSON.stringify(payload));
  });
}

let root;
let broker;

beforeEach(function () {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-broker-'));
});

afterEach(function () {
  if (broker) broker.close();
  broker = null;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('chat permission broker', function () {
  this.timeout(20000);

  before(function () {
    if (!fs.existsSync(HOOK)) {
      throw new Error('run `npm run build` first: the hook script is not in dist/');
    }
  });

  it('carries an approval from the hook to a decider and back', async function () {
    broker = new PermissionBroker(path.join(root, 'sockets'));
    const seen = [];
    const socketPath = await broker.listen({
      permission: async (ask) => {
        seen.push(ask);
        return { allow: true, reason: 'approved in the browser' };
      },
      question: NO_QUESTIONS,
    });

    const { decision } = await runHook(socketPath);

    assert.strictEqual(decision.permissionDecision, 'allow');
    assert.strictEqual(decision.hookEventName, 'PreToolUse');
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].toolName, 'Bash');
    assert.deepStrictEqual(seen[0].toolInput, PAYLOAD.tool_input);
    assert.strictEqual(seen[0].toolUseId, PAYLOAD.tool_use_id);
    assert.strictEqual(seen[0].cwd, PAYLOAD.cwd);
  });

  it('passes a refusal through with the reason the user gave', async function () {
    broker = new PermissionBroker(path.join(root, 'sockets'));
    const socketPath = await broker.listen({ permission: async () => ({
      allow: false,
      reason: 'not this time',
    }), question: NO_QUESTIONS });

    const { decision } = await runHook(socketPath);

    assert.strictEqual(decision.permissionDecision, 'deny');
    assert.match(decision.permissionDecisionReason, /not this time/);
  });

  it('never answers "ask", which would hang the agent', async function () {
    // There is no terminal to prompt on, so an "ask" decision would block the
    // turn against a prompt nobody can see.
    broker = new PermissionBroker(path.join(root, 'sockets'));
    const socketPath = await broker.listen({ permission: async () => ({ allow: true }), question: NO_QUESTIONS });
    const { decision } = await runHook(socketPath);
    assert.ok(['allow', 'deny'].includes(decision.permissionDecision));
  });

  describe('fails closed', function () {
    it('denies when no socket is configured', async function () {
      const { decision } = await runHook('');
      assert.strictEqual(decision.permissionDecision, 'deny');
    });

    it('denies when the socket path does not exist', async function () {
      const { decision } = await runHook(path.join(root, 'missing.sock'));
      assert.strictEqual(decision.permissionDecision, 'deny');
    });

    it('denies when the session goes away mid-question', async function () {
      broker = new PermissionBroker(path.join(root, 'sockets'));
      const socketPath = await broker.listen({
        permission: () =>
          new Promise(() => {
            // Never resolves: stands in for a user who never answers while the
            // session is torn down underneath them.
          }),
        question: NO_QUESTIONS,
      });

      const pending = runHook(socketPath);
      await new Promise((r) => setTimeout(r, 400));
      broker.close();
      broker = null;

      const { decision } = await pending;
      assert.strictEqual(decision.permissionDecision, 'deny');
    });

    it('denies when the decider throws', async function () {
      broker = new PermissionBroker(path.join(root, 'sockets'));
      const socketPath = await broker.listen({
        permission: async () => {
          throw new Error('decider exploded');
        },
        question: NO_QUESTIONS,
      });

      const { decision } = await runHook(socketPath);
      assert.strictEqual(decision.permissionDecision, 'deny');
      assert.match(decision.permissionDecisionReason, /exploded/);
    });

    it('denies when the payload is not valid JSON', async function () {
      broker = new PermissionBroker(path.join(root, 'sockets'));
      const socketPath = await broker.listen({ permission: async () => ({ allow: true }), question: NO_QUESTIONS });

      const result = await new Promise((resolve) => {
        const child = spawn(process.execPath, [HOOK], {
          env: { ...process.env, CCWEB_PERMISSION_SOCKET: socketPath },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let out = '';
        child.stdout.on('data', (c) => {
          out += c.toString();
        });
        child.on('close', () => resolve(JSON.parse(out.trim()).hookSpecificOutput));
        child.stdin.end('not json at all');
      });

      assert.strictEqual(result.permissionDecision, 'deny');
    });
  });

  describe('socket hygiene', function () {
    it('uses the Windows named-pipe namespace instead of a filesystem socket', function () {
      const pipe = windowsPermissionPipePath('00112233445566778899aabbccddeeff');
      assert.strictEqual(
        pipe,
        '\\\\.\\pipe\\code-agents-webcli-00112233445566778899aabbccddeeff',
      );
      assert.ok(!pipe.endsWith('.sock'));

      const settings = JSON.parse(permissionHookSettings('C:\\app\\hook.js', pipe));
      assert.strictEqual(settings.env.CCWEB_PERMISSION_SOCKET, pipe);
    });

    it('creates the socket private to this user and removes it on close', async function () {
      broker = new PermissionBroker(path.join(root, 'sockets'));
      const socketPath = await broker.listen({ permission: async () => ({ allow: true }), question: NO_QUESTIONS });

      assert.strictEqual(fs.statSync(socketPath).mode & 0o777, 0o600);
      assert.strictEqual(fs.statSync(path.join(root, 'sockets')).mode & 0o777, 0o700);

      broker.close();
      broker = null;
      assert.strictEqual(fs.existsSync(socketPath), false);
    });

    it('listens even when the data directory is too deep for a socket path', async function () {
      // The reported failure, reproduced by arithmetic rather than by guessing:
      // sockaddr_un.sun_path is 108 bytes on Linux and 104 on macOS, and the
      // old layout spent 37 of them on a directory named after the session
      // UUID. bind() rejects the address, and Node reports that as EINVAL —
      // which reads like a bad argument, not a length limit.
      const deep = path.join(root, 'x'.repeat(80), 'chat-sockets');
      broker = new PermissionBroker(deep);

      const socketPath = await broker.listen({ permission: async () => ({ allow: true }), question: NO_QUESTIONS });

      assert.ok(
        Buffer.byteLength(socketPath, 'utf8') <= 103,
        `socket path is ${Buffer.byteLength(socketPath, 'utf8')} bytes: ${socketPath}`,
      );
      // Still usable, not merely short: the fallback location has to be one the
      // hook can actually dial.
      const { decision } = await runHook(socketPath);
      assert.strictEqual(decision.permissionDecision, 'allow');

      const dir = path.dirname(socketPath);
      assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700);
      assert.strictEqual(fs.statSync(socketPath).mode & 0o777, 0o600);

      broker.close();
      broker = null;
      // The fallback directory is this broker's alone, so it goes with it.
      assert.strictEqual(fs.existsSync(dir), false);
    });

    it('keeps the preferred directory when the path does fit', async function () {
      broker = new PermissionBroker(path.join(root, 'sockets'));
      const socketPath = await broker.listen({ permission: async () => ({ allow: true }), question: NO_QUESTIONS });
      assert.strictEqual(path.dirname(socketPath), path.join(root, 'sockets'));
    });

    it('does not put the session id in the socket name', async function () {
      broker = new PermissionBroker(path.join(root, 'sockets'));
      const socketPath = await broker.listen({ permission: async () => ({ allow: true }), question: NO_QUESTIONS });
      assert.ok(!socketPath.includes(PAYLOAD.session_id));
    });

    it('handles several questions on one session socket', async function () {
      broker = new PermissionBroker(path.join(root, 'sockets'));
      let n = 0;
      const socketPath = await broker.listen({
        permission: async () => {
          n += 1;
          return { allow: n % 2 === 1, reason: `call ${n}` };
        },
        question: NO_QUESTIONS,
      });

      const decisions = await Promise.all([
        runHook(socketPath),
        runHook(socketPath),
        runHook(socketPath),
      ]);

      const outcomes = decisions.map((d) => d.decision.permissionDecision).sort();
      assert.deepStrictEqual(outcomes, ['allow', 'allow', 'deny']);
    });
  });

  describe('session settings', function () {
    it('installs the hook without touching the user’s own configuration', function () {
      const settings = JSON.parse(permissionHookSettings('/x/hook.js', '/tmp/a.sock'));
      const entry = settings.hooks.PreToolUse[0];

      assert.strictEqual(entry.matcher, '*');
      assert.ok(entry.hooks[0].command.includes('/x/hook.js'));
      assert.strictEqual(settings.env.CCWEB_PERMISSION_SOCKET, '/tmp/a.sock');
      // A short timeout would turn "the user stepped away" into a refusal.
      assert.ok(entry.hooks[0].timeout >= 600);
      // Nothing here may write to the user's settings file.
      assert.deepStrictEqual(Object.keys(settings).sort(), ['env', 'hooks']);
    });
  });
});
