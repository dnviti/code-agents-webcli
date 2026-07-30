const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin', 'cc-web.js');

function run(args, env = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, ...env },
  });
}

// Adding the `env` subcommands once stopped `cc-web` from starting at all:
// commander answers a bare invocation with the help text as soon as a program
// has subcommands and the root has no action of its own. Nothing in the type
// system or the unit tests noticed, because the failure is in how the binary is
// *invoked* rather than in what it contains — so this exercises the binary.

describe('the command line', function () {
  this.timeout(40000);

  it('starts the server when given no subcommand', function () {
    // `--port 0` is refused by the server's own validation, which is inside
    // main(). Reaching that message proves the root action ran; the help text
    // proves it did not.
    const result = run(['--port', '0']);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /Port must be a number between 1 and 65535/,
      `expected the server to start and validate its port, got:\n${result.stdout}${result.stderr}`,
    );
    assert.doesNotMatch(
      result.stdout,
      /Usage: code-agents-webcli/,
      'a bare invocation must start the server, not print the help text',
    );
  });

  it('still runs the operator subcommands', function () {
    const result = run(['env', '--help']);
    assert.match(result.stdout, /list and remove per-user container environments/);
    // And they are not confused with a server start.
    assert.doesNotMatch(result.stdout, /Starting Code Agents Web CLI/);
  });

  it('says which engine is missing rather than reporting a spawn errno', function () {
    // No engine on PATH is the ordinary case for an operator who has not set
    // one up, and `spawn docker ENOENT` tells them nothing about what to do.
    const result = run(['env', 'ls'], { PATH: '/nonexistent' });
    assert.match(
      `${result.stdout}${result.stderr}`,
      /is not installed on this machine|is not on PATH/,
      `${result.stdout}${result.stderr}`,
    );
  });
});
