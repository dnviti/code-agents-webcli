const assert = require('assert');
const { ClaudeBridge } = require('../dist/server/bridges/claude.js');

describe('ClaudeBridge', function() {
  let bridge;

  beforeEach(function() {
    bridge = new ClaudeBridge();
  });

  describe('constructor', function() {
    it('should initialize with a Map for sessions', function() {
      assert(bridge.sessions instanceof Map);
      assert.strictEqual(bridge.sessions.size, 0);
    });

    it('should find a claude command on initialization', function() {
      assert(typeof bridge.resolvedCommand === 'string');
      assert(bridge.resolvedCommand.length > 0);
    });

    it('uses where.exe and retains the real Windows npm shim path', function() {
      const calls = [];
      const windows = new ClaudeBridge({
        platform: 'win32',
        env: { USERPROFILE: 'C:\\Users\\alice' },
        existsSync() { return false; },
        execFileSync(file, args) {
          calls.push([file, ...args]);
          if (args[0] === 'claude') return [
            'C:\\Users\\alice\\AppData\\Roaming\\npm\\claude',
            'C:\\Users\\alice\\AppData\\Roaming\\npm\\claude.cmd',
            '',
          ].join('\r\n');
          throw new Error('missing');
        },
      });
      assert.strictEqual(
        windows.resolvedCommand,
        'C:\\Users\\alice\\AppData\\Roaming\\npm\\claude.cmd',
      );
      assert.ok(calls.every(([file]) => file === 'where.exe'));
    });
  });

  describe('commandExists', function() {
    it('should return true for an existing command', function() {
      const result = bridge.commandExists(process.platform === 'win32' ? 'node' : 'ls');
      assert.strictEqual(result, true);
    });

    it('should return false for non-existent commands', function() {
      const result = bridge.commandExists('nonexistentcommand12345');
      assert.strictEqual(result, false);
    });

    it('should handle command names with special characters safely', function() {
      // This tests the security fix - commands with shell metacharacters should not break
      const result = bridge.commandExists('ls; echo "injected"');
      assert.strictEqual(result, false);
    });
  });

  describe('getSession', function() {
    it('should return undefined for non-existent session', function() {
      const result = bridge.getSession('nonexistent');
      assert.strictEqual(result, undefined);
    });
  });

  describe('getAllSessions', function() {
    it('should return empty array when no sessions exist', function() {
      const result = bridge.getAllSessions();
      assert(Array.isArray(result));
      assert.strictEqual(result.length, 0);
    });
  });

  it('fails closed when a container wrapper omits process control', async function() {
    const environment = {
      kind: 'container',
      wrap(command, args) { return { command, args, env: process.env }; },
    };
    await assert.rejects(
      bridge.startSession('missing-control', { environment }),
      /verified process control/,
    );
    assert.strictEqual(bridge.getSession('missing-control'), undefined);
  });
});
