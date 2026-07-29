const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ChatSessionManager } = require('../dist/server/chat/manager.js');

// The filesystem an ACP agent is allowed to see.
//
// Agents delegate file reads and writes to this server over a socket, so the
// confinement check is the whole boundary between "the project the session is
// about" and "the rest of the host". It must hold against `..` escapes and
// absolute paths — but it must also leave the OS temp dir open, because an
// agent's write tool and its own shell share the real filesystem and hand
// files to each other through it (`gh issue create --body-file /tmp/x.md`
// only works if the write lands where the shell will look).

function manager(workingDir) {
  const m = new ChatSessionManager({
    store: {},
    storageDir: fs.mkdtempSync(path.join(os.tmpdir(), 'confine-store-')),
    broadcast: () => {},
    resolveCommand: () => 'claude',
  });
  // A bare stand-in for the live session: readFile/writeFile only ever ask it
  // where it runs.
  m.sessions.set('s1', { workingDir });
  return m;
}

describe('chat file confinement', function () {
  let workingDir;
  before(function () {
    workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'confine-project-'));
  });

  it('reads and writes inside the session directory', async function () {
    const m = manager(workingDir);
    await m.writeFile('s1', 'notes/todo.md', 'hello');
    assert.strictEqual(await m.readFile('s1', 'notes/todo.md'), 'hello');
    assert.strictEqual(fs.readFileSync(path.join(workingDir, 'notes/todo.md'), 'utf8'), 'hello');
  });

  it('writes into the OS temp dir, where the agent shell will look for it', async function () {
    const m = manager(workingDir);
    const target = path.join(os.tmpdir(), `confine-${process.pid}-issue-body.md`);
    try {
      await m.writeFile('s1', target, 'issue body');
      assert.strictEqual(fs.readFileSync(target, 'utf8'), 'issue body');
      assert.strictEqual(await m.readFile('s1', target), 'issue body');
    } finally {
      fs.rmSync(target, { force: true });
    }
  });

  it('refuses absolute paths that are neither the project nor scratch space', async function () {
    const m = manager(workingDir);
    await assert.rejects(m.readFile('s1', '/etc/hostname'), /outside the session directory/);
    await assert.rejects(
      m.writeFile('s1', path.join(os.homedir(), 'confine-should-not-exist.tmp'), 'x'),
      /outside the session directory/,
    );
  });

  it('refuses .. escapes that only start out looking like the temp dir', async function () {
    const m = manager(workingDir);
    await assert.rejects(
      m.readFile('s1', path.join(os.tmpdir(), '..', 'etc', 'hostname')),
      /outside the session directory/,
    );
  });
});
