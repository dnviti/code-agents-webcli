const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ChatSessionManager } = require('../dist/server/chat/manager.js');

// The filesystem an ACP agent is allowed to see.
//
// Agents delegate file reads and writes to this server over a socket, so the
// confinement check is the whole boundary between "what this user may reach"
// and "the rest of the host". It must hold against `..` escapes and absolute
// paths — but it must also leave the OS temp dir open, because an agent's write
// tool and its own shell share the real filesystem and hand files to each other
// through it (`gh issue create --body-file /tmp/x.md` only works if the write
// lands where the shell will look).
//
// And it must reach past the session's own directory to the rest of the user's
// browsable area (#174). A conversation started in a repository could not read
// a git worktree of that same repository one directory over — which the folder
// picker in this app would have let the user choose outright — so every read
// was refused while the agent's own shell read the file freely and then wrote
// it back through a script. The boundary now matches the one the file browser
// draws, and nothing outside it moved.

function manager(workingDir, baseFolder) {
  const m = new ChatSessionManager({
    store: {},
    storageDir: fs.mkdtempSync(path.join(os.tmpdir(), 'confine-store-')),
    broadcast: () => {},
    resolveCommand: () => 'claude',
    ...(baseFolder ? { userBaseFolder: () => baseFolder } : {}),
  });
  // A bare stand-in for the live session: readFile/writeFile only ever ask it
  // where it runs.
  m.sessions.set('s1', { workingDir });
  return m;
}

describe('chat file confinement', function () {
  let workingDir;
  // Deliberately NOT under the OS temp dir, which is a permitted root in its
  // own right: a base-folder fixture built there is allowed by the temp rule
  // before the base folder is ever consulted, and every assertion below would
  // pass against code that had no idea what a base folder was.
  let outside;
  before(function () {
    workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'confine-project-'));
    outside = fs.mkdtempSync(path.join(os.homedir(), '.ccweb-confine-test-'));
  });
  after(function () {
    if (outside) fs.rmSync(outside, { recursive: true, force: true });
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
    await assert.rejects(m.readFile('s1', '/etc/hostname'), /outside the folders/);
    await assert.rejects(
      m.writeFile('s1', path.join(os.homedir(), 'confine-should-not-exist.tmp'), 'x'),
      /outside the folders/,
    );
  });

  it('refuses .. escapes that only start out looking like the temp dir', async function () {
    const m = manager(workingDir);
    await assert.rejects(
      m.readFile('s1', path.join(os.tmpdir(), '..', 'etc', 'hostname')),
      /outside the folders/,
    );
  });

  // The defect in #174, at the layer that caused it: the agent was working in a
  // sibling git worktree of the session's own repository, well inside the area
  // its user can browse, and every read of it came back refused.
  it('reads and writes a sibling directory inside the user’s browsable area', async function () {
    const base = fs.mkdtempSync(path.join(outside, 'base-'));
    const project = path.join(base, 'project');
    const worktree = path.join(base, 'project-wt166');
    fs.mkdirSync(path.join(worktree, 'src'), { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(worktree, 'src', 'store.ts'), 'export const x = 1;\n');

    // The control, in the same test: without a base folder to consult, this is
    // the refusal the user actually saw, on the very same path.
    await assert.rejects(
      manager(project).readFile('s1', path.join(worktree, 'src', 'store.ts'), 7),
      /outside the folders/,
      'the session directory alone is what refused it before',
    );

    const m = manager(project, base);
    assert.strictEqual(
      await m.readFile('s1', path.join(worktree, 'src', 'store.ts'), 7),
      'export const x = 1;\n',
    );
    // Writes too, and this is the half that mattered. A refused read was only
    // noisy — omp falls back to reading the file itself — but a refused write
    // genuinely failed, and the agent answered it by writing the same path
    // through a python script instead.
    await m.writeFile('s1', path.join(worktree, 'src', 'db.ts'), 'ok', 7);
    assert.strictEqual(fs.readFileSync(path.join(worktree, 'src', 'db.ts'), 'utf8'), 'ok');
  });

  it('still refuses a path outside that area', async function () {
    const base = fs.mkdtempSync(path.join(outside, 'base-'));
    const project = path.join(base, 'project');
    fs.mkdirSync(project, { recursive: true });
    const m = manager(project, base);
    await assert.rejects(m.readFile('s1', '/etc/hostname', 7), /outside the folders/);
    await assert.rejects(
      m.writeFile('s1', path.join(outside, 'not-in-the-base.txt'), 'x', 7),
      /outside the folders/,
    );
  });

  it('does not let a neighbour of the base folder pass as part of it', async function () {
    const base = fs.mkdtempSync(path.join(outside, 'base-'));
    const project = path.join(base, 'project');
    fs.mkdirSync(project, { recursive: true });
    // `<base>-other` is not a child of `<base>`, and the separator on the
    // prefix test is the whole of what stops it reading like one.
    fs.mkdirSync(`${base}-other`, { recursive: true });
    fs.writeFileSync(path.join(`${base}-other`, 'secret.txt'), 'not yours');

    await assert.rejects(
      manager(project, base).readFile('s1', path.join(`${base}-other`, 'secret.txt'), 7),
      /outside the folders/,
    );
  });

  it('applies the wider rule to nobody when the session has no owner', async function () {
    const base = fs.mkdtempSync(path.join(outside, 'base-'));
    const project = path.join(base, 'project');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(base, 'notes.md'), 'hello');
    const m = manager(project, base);

    assert.strictEqual(await m.readFile('s1', path.join(base, 'notes.md'), 7), 'hello');
    await assert.rejects(
      m.readFile('s1', path.join(base, 'notes.md')),
      /outside the folders/,
      'with nobody to resolve a base folder for, the older and tighter rule stands',
    );
  });

  it('keeps the session directory alone when no base folder is configured', async function () {
    const m = manager(workingDir);
    await m.writeFile('s1', 'inside.txt', 'yes');
    assert.strictEqual(await m.readFile('s1', 'inside.txt', 7), 'yes');
    await assert.rejects(m.readFile('s1', '/etc/hostname', 7), /outside the folders/);
  });
});
