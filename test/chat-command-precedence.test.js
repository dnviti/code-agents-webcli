const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ChatSession } = require('../dist/server/chat/session.js');

// Which list wins when the runtime finally names its own commands (#71).
//
// The scan of what is installed on disk is a stand-in for the answer, and #73
// added a merge so that a runtime which reports only its built-ins — grok, over
// ACP — could not take a user's `.grok/skills` off the menu by introducing
// itself. The merge went on every runtime, so it also went on the one that
// reports everything it accepts: Claude's `init` names its skills, its project
// commands and its plugins', and putting the scan back on top of that added
// entries Claude has no command for. On this machine that was `shadcn`: on the
// menu, and delivered as ordinary prompt text to an agent with nothing to run
// it.
//
// So both halves are pinned here, on the two runtimes that behave differently.

let dir;

function skill(relative, frontmatter) {
  const file = path.join(dir, relative, 'SKILL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\n${frontmatter}\n---\n\nDo the thing.\n`);
}

function harness() {
  const events = [];
  const broadcasts = [];
  const session = new ChatSession(
    { id: 's1', ownerUserId: 7 },
    {
      store: {
        append(_ref, batch) { events.push(...batch); },
        async stat() { return { firstSeq: 1, cursor: events.length }; },
        async read() { return { events: [], firstSeq: 1, from: 1, cursor: events.length }; },
      },
      socketDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ccweb-sock-')),
      hookScript: path.join(dir, 'no-such-hook.js'),
      broadcast: (_id, message) => broadcasts.push(message),
      // `/bin/cat` holds a pipe open and says nothing, which is every runtime
      // before it has spoken — and lets the runtime's own list arrive here, in
      // the test, at the moment the test chooses.
      resolveCommand: () => '/bin/cat',
    },
  );
  return { session, events, broadcasts };
}

/**
 * A scratch home for the disk scan, per test.
 *
 * Both suites set it up for themselves. `dir` used to be arranged by the first
 * suite alone and read by the second, so the grok half — the one guarding #73 —
 * threw on any `--grep`, any `.only`, and any reordering.
 */
function useScratchDir() {
  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccweb-menu-'));
    skill('home/.claude/skills/shadcn', 'name: shadcn\ndescription: Manage shadcn components');
  });

  afterEach(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

const names = (commands) => (commands || []).map((command) => command.name);
const reported = (events, kind) => events.filter((event) => event.t === kind).pop();

describe('a runtime that names everything it accepts', function () {
  useScratchDir();

  it('offers what is installed until it has spoken', async function () {
    const { session } = harness();
    await session.start({
      runtime: 'claude',
      workingDir: path.join(dir, 'project'),
      env: { HOME: path.join(dir, 'home') },
    });
    const offered = names(session.capabilities.commands);
    await session.stop();

    assert.ok(offered.includes('shadcn'), 'the stand-in is the whole point of the scan');
    assert.ok(offered.includes('clear'), 'alongside the built-ins this app knows about');
  });

  it('replaces the stand-in with its own list, keeping nothing left over', async function () {
    const { session, events, broadcasts } = harness();
    await session.start({
      runtime: 'claude',
      workingDir: path.join(dir, 'project'),
      env: { HOME: path.join(dir, 'home') },
    });

    // Claude's first turn introducing itself, through its own adapter: the
    // list is bare names, and it is the whole of what this conversation can
    // run.
    session.adapter.handleMessage({
      type: 'system',
      subtype: 'init',
      session_id: 'native-1',
      slash_commands: ['clear', 'model', 'plugin:figma:figma-use'],
    });
    await session.stop();

    assert.deepStrictEqual(
      names(session.capabilities.commands),
      ['clear', 'model', 'plugin:figma:figma-use'],
      'a menu entry the runtime never mentioned is a message, not a command',
    );
    // And on the event, because the browser builds its menu from the log rather
    // than from anything held here.
    assert.deepStrictEqual(
      names(reported(events, 'session').capabilities.commands),
      ['clear', 'model', 'plugin:figma:figma-use'],
    );
    const sent = broadcasts
      .map((message) => message.event)
      .filter((event) => event && event.t === 'session')
      .pop();
    assert.deepStrictEqual(names(sent.capabilities.commands), ['clear', 'model', 'plugin:figma:figma-use']);
  });
});

/**
 * The runtime the merge exists for, and it is not driven through a real
 * adapter: grok speaks ACP, whose handshake needs an agent on the other end
 * rather than a pipe that echoes. What is under test is the session anyway, so
 * it is given exactly what `start()` gives it — the runtime it launched and
 * what the scan found for that runtime — and then told what grok says about
 * itself over ACP.
 */
describe('a runtime that names only its built-ins', function () {
  useScratchDir();

  it('does not take the user’s own skills off the menu by introducing itself', function () {
    const { session, events } = harness();
    session.runtime = 'grok';
    session.installedCommands = [{ name: 'commit', description: 'Write the commit message' }];
    session.capabilities = { commands: [{ name: 'commit', description: 'Write the commit message' }] };

    session.ingest({
      t: 'capabilities',
      capabilities: { commands: [{ name: 'compact', description: 'Compact the conversation context' }] },
    });

    assert.deepStrictEqual(
      names(reported(events, 'capabilities').capabilities.commands),
      ['compact', 'commit'],
      'grok says nothing about .grok/skills, so replacing its list wholesale empties the menu (#73)',
    );
    assert.deepStrictEqual(names(session.capabilities.commands), ['compact', 'commit']);
  });
});
