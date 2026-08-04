const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  discoverInstalledCommands,
  listInstalledCommands,
  describeFrom,
} = require('../dist/server/chat/installed-commands.js');
const { ClaudeChatAdapter } = require('../dist/server/chat/adapters/claude.js');
const { AcpChatAdapter } = require('../dist/server/chat/adapters/acp.js');
const { mergeSlashCommands } = require('../dist/shared/slash-commands.js');

// A session's command menu is meant to show what that conversation can run,
// from the moment it opens. These cover the stand-in it shows until its runtime
// says otherwise: what it finds on disk, and that the runtime's own answer
// replaces it whole rather than being blended into it.
//
// Two layers, and the distinction matters. An *adapter* replaces: what a
// runtime says it accepts is the truth about that runtime, and half of a stale
// guess left mixed into it would be worse than either. The *session* then adds
// back what it found on disk, because a skill installed in `.grok/skills` is
// not the runtime's to forget — see `chat-tool-activity.test.js`, which covers
// the case that made this necessary.

let root;

function write(relative, contents) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

function skill(relative, frontmatter, body = 'Do the thing.\n') {
  write(`${relative}/SKILL.md`, `---\n${frontmatter}\n---\n\n${body}`);
}

function names(commands) {
  return commands.map((command) => command.name);
}

describe('installed skills and commands', function () {
  beforeEach(function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccweb-installed-'));
  });

  afterEach(function () {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const home = () => path.join(root, 'home');
  const cwd = () => path.join(root, 'project');
  const scan = (runtime = 'claude') =>
    listInstalledCommands(runtime, { home: home(), workingDir: cwd() });

  it('lists user skills with the description their author wrote', function () {
    skill('home/.claude/skills/deploy', 'name: deploy\ndescription: Ship the current branch');
    assert.deepStrictEqual(scan(), [
      { name: 'deploy', description: 'Ship the current branch' },
    ]);
  });

  it('reads a folded description, which is how long ones are written', function () {
    skill(
      'home/.claude/skills/review',
      'name: review\ndescription: >-\n  Review a change for correctness,\n  then say what would break.',
    );
    assert.strictEqual(
      scan()[0].description,
      'Review a change for correctness, then say what would break.',
    );
  });

  it('leaves an undescribed skill undescribed rather than inventing one', function () {
    skill('home/.claude/skills/mystery', 'name: mystery');
    assert.deepStrictEqual(scan(), [{ name: 'mystery' }]);
  });

  it('follows a symlinked skill directory, which is how skills are usually installed', function () {
    skill('elsewhere/tidy', 'name: tidy\ndescription: Tidy up');
    fs.mkdirSync(path.join(home(), '.claude/skills'), { recursive: true });
    fs.symlinkSync(path.join(root, 'elsewhere/tidy'), path.join(home(), '.claude/skills/tidy'));
    assert.deepStrictEqual(names(scan()), ['tidy']);
  });

  it('takes the name from the frontmatter when it differs from the directory', function () {
    skill('home/.claude/skills/folder-name', 'name: real-name\ndescription: One');
    assert.deepStrictEqual(names(scan()), ['real-name']);
  });

  it('lists project commands, namespaced by the folder they sit in', function () {
    write('project/.claude/commands/ship.md', '---\ndescription: Ship it\n---\nbody');
    write('project/.claude/commands/db/migrate.md', '# Migrate\n');
    assert.deepStrictEqual(names(scan()).sort(), ['db:migrate', 'ship']);
  });

  it('prefers the project copy when a name exists in both places', function () {
    skill('project/.claude/skills/audit', 'name: audit\ndescription: Project audit');
    skill('home/.claude/skills/audit', 'name: audit\ndescription: Personal audit');
    assert.deepStrictEqual(scan(), [{ name: 'audit', description: 'Project audit' }]);
  });

  it('lists an enabled plugin’s skills under the plugin’s name', function () {
    skill('plugins/tools/skills/lint', 'name: lint\ndescription: Lint everything');
    write(
      'home/.claude/plugins/installed_plugins.json',
      JSON.stringify({
        plugins: { 'tools@market': [{ installPath: path.join(root, 'plugins/tools') }] },
      }),
    );
    write('home/.claude/settings.json', JSON.stringify({ enabledPlugins: { 'tools@market': true } }));
    assert.deepStrictEqual(names(scan()), ['tools:lint']);
  });

  it('skips a plugin that is installed but switched off', function () {
    skill('plugins/tools/skills/lint', 'name: lint\ndescription: Lint everything');
    write(
      'home/.claude/plugins/installed_plugins.json',
      JSON.stringify({
        plugins: { 'tools@market': [{ installPath: path.join(root, 'plugins/tools') }] },
      }),
    );
    write('home/.claude/settings.json', JSON.stringify({ enabledPlugins: { 'tools@market': false } }));
    assert.deepStrictEqual(scan(), []);
  });

  it('takes the newest install path when a plugin has several cached versions', function () {
    skill('plugins/tools-1/skills/old', 'name: old');
    skill('plugins/tools-2/skills/new', 'name: new');
    write(
      'home/.claude/plugins/installed_plugins.json',
      JSON.stringify({
        plugins: {
          'tools@market': [
            { installPath: path.join(root, 'plugins/tools-1') },
            { installPath: path.join(root, 'plugins/tools-2') },
          ],
        },
      }),
    );
    assert.deepStrictEqual(names(scan()), ['tools:new']);
  });

  it('reads each runtime’s own locations, and nobody else’s', function () {
    skill('home/.pi/agent/skills/pi-only', 'name: pi-only');
    skill('home/.grok/skills/grok-only', 'name: grok-only');
    skill('home/.claude/skills/claude-only', 'name: claude-only');
    assert.deepStrictEqual(names(scan('pi')), ['pi-only']);
    // grok reads Claude's directories too, by default, and says so in its docs.
    assert.deepStrictEqual(names(scan('grok')).sort(), ['claude-only', 'grok-only']);
    assert.deepStrictEqual(names(scan('claude')), ['claude-only']);
  });

  it('uses Codex’s shared and system skill roots as a fallback for older builds', function () {
    skill('project/.agents/skills/project-shared', 'name: project-shared');
    skill('home/.agents/skills/user-shared', 'name: user-shared');
    skill('home/.codex/skills/.system/system-skill', 'name: system-skill');
    assert.deepStrictEqual(
      names(scan('codex')),
      ['project-shared', 'user-shared', 'system-skill'],
    );
  });

  it('keeps skill paths in private discovery metadata, not public menu entries', function () {
    skill('home/.codex/skills/release', 'name: release\ndescription: Prepare a release');
    const found = discoverInstalledCommands('codex', { home: home(), workingDir: cwd() });
    assert.deepStrictEqual(found.commands, [{ name: 'release', description: 'Prepare a release' }]);
    assert.deepStrictEqual(found.skills, [{
      name: 'release',
      path: path.join(home(), '.codex/skills/release/SKILL.md'),
    }]);
    assert.ok(!JSON.stringify(found.commands).includes(home()), 'the browser-facing list has no absolute path');
  });

  it('reads all four of agy’s workspace root spellings', function () {
    // agy's own docs name `.agents/` "or `.agent/`, `_agents/`, `_agent/`", and
    // all four were probed against 1.1.8 by planting a skill in each and asking
    // the agent which were available to it: all four came back AVAILABLE. A
    // monorepo using `_agents/` had an empty menu until they were all here.
    skill('project/.agents/skills/dot-agents', 'name: dot-agents');
    skill('project/_agents/skills/under-agents', 'name: under-agents');
    skill('project/.agent/skills/dot-agent', 'name: dot-agent');
    skill('project/_agent/skills/under-agent', 'name: under-agent');
    assert.deepStrictEqual(
      names(scan('antigravity')).sort(),
      ['dot-agent', 'dot-agents', 'under-agent', 'under-agents'],
    );
  });

  it('reads agy’s global root as well as the project’s', function () {
    skill('project/.agents/skills/project-one', 'name: project-one');
    skill('home/.gemini/config/skills/global-one', 'name: global-one');
    assert.deepStrictEqual(names(scan('antigravity')).sort(), ['global-one', 'project-one']);
  });

  it('reads a skill a plugin brought with it, under its own name', function () {
    // `<root>/plugins/<plugin>/skills/<skill>/SKILL.md`, two levels below the
    // directory the table names. Probed: available, and *not* namespaced — agy
    // offers it as `plug-check`, not `toolkit:plug-check`.
    write('project/.agents/plugins/toolkit/plugin.json', '{"name":"toolkit"}');
    skill('project/.agents/plugins/toolkit/skills/plug-check', 'name: plug-check');
    write('home/.gemini/config/plugins/globaltoolkit/plugin.json', '{"name":"globaltoolkit"}');
    skill('home/.gemini/config/plugins/globaltoolkit/skills/gplug-check', 'name: gplug-check');
    assert.deepStrictEqual(names(scan('antigravity')).sort(), ['gplug-check', 'plug-check']);
  });

  it('does not offer a skill nested deeper than agy will load one', function () {
    // Probed: `skills/outer/inner/SKILL.md` came back MISSING. The default scan
    // recurses three levels, which for agy would put a name on the menu the
    // agent has no skill for.
    skill('project/.agents/skills/outer/inner', 'name: nested-inner');
    assert.deepStrictEqual(names(scan('antigravity')), []);
  });

  it('offers none of agy’s built-in skills, because two of the three are dead', function () {
    // `/antigravity_guide` answers from the skill; `/permissioned-github`
    // answers "no such skill" and `/agy-customizations` quietly opens the wrong
    // file. Two undeliverable entries to gain one documentation skill is the
    // trade #71 was filed over, so the directory has no row.
    skill('home/.gemini/antigravity-cli/builtin/skills/antigravity_guide', 'name: antigravity-guide');
    skill('home/.gemini/antigravity-cli/builtin/skills/permissioned-github', 'name: permissioned-github');
    assert.deepStrictEqual(names(scan('antigravity')), []);
  });

  it('leaves the shared .agents skills of other runtimes off agy’s menu', function () {
    // `~/.agents/skills` is a *user-scoped* root for pi and grok. It is not one
    // for agy, whose user-scoped root is `~/.gemini/config/`. Probed: a skill
    // placed there was not found from an unrelated working directory.
    //
    // The precise claim matters. agy treats `.agents` as a *workspace* root, so
    // a home directory that is itself a git repository, with the session opened
    // under it, does put those skills on the menu — and correctly, because agy
    // loads them there too. This asserts the ordinary case, where `home/` is
    // nowhere near the working directory's walk.
    skill('home/.agents/skills/pi-shared', 'name: pi-shared');
    assert.deepStrictEqual(names(scan('antigravity')), []);
    // And the same directory really is read for the runtime that does read it,
    // so this is a difference between runtimes rather than a broken scan.
    assert.deepStrictEqual(names(scan('pi')), ['pi-shared']);
  });

  it('walks up to the repository root for agy, the way agy does', function () {
    // agy's own docs: "the agent walks from your current working directory up to
    // the repository root (e.g. the folder containing `.git`)". Watched working
    // — a skill in `<repo>/.agents/skills/` was invoked by name from a session
    // opened in `<repo>/packages/web`, and agy read it. Without this the menu
    // silently omits every skill a monorepo keeps at its root.
    skill('project/.agents/skills/at-the-root', 'name: at-the-root');
    fs.mkdirSync(path.join(cwd(), '.git'), { recursive: true });
    const deep = path.join(cwd(), 'packages', 'web');
    fs.mkdirSync(deep, { recursive: true });
    assert.deepStrictEqual(
      names(listInstalledCommands('antigravity', { home: home(), workingDir: deep })),
      ['at-the-root'],
    );
  });

  it('lets a nearer skill shadow the ancestor’s of the same name', function () {
    skill('project/.agents/skills/audit', 'name: audit\ndescription: Repo audit');
    fs.mkdirSync(path.join(cwd(), '.git'), { recursive: true });
    skill('project/packages/web/.agents/skills/audit', 'name: audit\ndescription: Package audit');
    const deep = path.join(cwd(), 'packages', 'web');
    assert.deepStrictEqual(
      listInstalledCommands('antigravity', { home: home(), workingDir: deep }),
      [{ name: 'audit', description: 'Package audit' }],
    );
  });

  it('does not wander above a working directory with no repository over it', function () {
    // No `.git` anywhere above: only the working directory is searched. Climbing
    // to the filesystem root on the off chance would offer skills from whatever
    // project happens to own `/tmp`, which the session has nothing to do with.
    skill('project/.agents/skills/mine', 'name: mine');
    skill('.agents/skills/stranger', 'name: stranger');
    assert.deepStrictEqual(names(scan('antigravity')), ['mine']);
  });

  it('keeps enough directory budget for the personal roots after a deep walk', function () {
    // Eight workspace rows against a deep tree is a hundred directory opens that
    // find nothing, and the walk's budget is shared with everything after it. If
    // a miss cost a unit, the global root at the end of the table would be
    // starved and the menu would silently lose half its entries.
    fs.mkdirSync(path.join(cwd(), '.git'), { recursive: true });
    const deep = path.join(cwd(), ...Array.from({ length: 12 }, (_, i) => `level${i}`));
    fs.mkdirSync(deep, { recursive: true });
    skill('home/.gemini/config/skills/still-here', 'name: still-here');
    assert.deepStrictEqual(
      names(listInstalledCommands('antigravity', { home: home(), workingDir: deep })),
      ['still-here'],
    );
  });

  it('offers nothing for a runtime that reports its own list at session start', function () {
    skill('home/.claude/skills/anything', 'name: anything');
    assert.deepStrictEqual(scan('kimi'), []);
    assert.deepStrictEqual(scan('omp'), []);
  });

  it('says nothing at all on a machine with no skills installed', function () {
    assert.deepStrictEqual(scan(), []);
  });

  it('survives an unreadable home rather than failing the session', function () {
    assert.deepStrictEqual(
      listInstalledCommands('claude', { home: '/nonexistent-home', workingDir: '/nonexistent' }),
      [],
    );
    assert.deepStrictEqual(listInstalledCommands('claude', { workingDir: cwd() }), []);
  });

  it('ignores a skill directory with no SKILL.md in it', function () {
    write('home/.claude/skills/not-a-skill/readme.md', 'nothing here');
    assert.deepStrictEqual(scan(), []);
  });
});

describe('the stand-in menu and the runtime’s own answer', function () {
  const installed = [
    { name: 'deploy', description: 'Ship the current branch' },
    { name: 'plugin:lint', description: 'Lint everything' },
  ];

  function claude() {
    const events = [];
    const adapter = new ClaudeChatAdapter({
      sessionId: 'app-session-1',
      workingDir: '/tmp',
      command: 'claude',
      installedCommands: installed,
      emit: (event) => events.push(event),
    });
    return { adapter, events };
  }

  it('offers built-ins and installed skills before a single message is sent', function () {
    const { adapter } = claude();
    const offered = names(adapter.capabilities.commands);
    assert.ok(offered.includes('clear'), 'built-in commands are still there');
    assert.ok(offered.includes('deploy'), 'an installed skill is offered up front');
    assert.ok(offered.includes('plugin:lint'), 'so is a plugin skill');
  });

  it('replaces the stand-in with the runtime’s list, keeping nothing left over', function () {
    const { adapter, events } = claude();
    adapter.handleMessage({
      type: 'system',
      subtype: 'init',
      session_id: 'native-1',
      slash_commands: ['clear', 'deploy'],
    });
    const session = events.find((event) => event.t === 'session');
    assert.deepStrictEqual(names(session.capabilities.commands), ['clear', 'deploy']);
    assert.deepStrictEqual(names(adapter.capabilities.commands), ['clear', 'deploy']);
  });

  it('fills the descriptions Claude reports bare from what is on disk', function () {
    const { adapter, events } = claude();
    adapter.handleMessage({
      type: 'system',
      subtype: 'init',
      session_id: 'native-1',
      slash_commands: ['deploy', 'plugin:lint', 'nothing-known'],
    });
    const commands = events.find((event) => event.t === 'session').capabilities.commands;
    assert.strictEqual(commands[0].description, 'Ship the current branch');
    assert.strictEqual(commands[1].description, 'Lint everything');
    assert.strictEqual(commands[2].description, undefined);
  });

  it('lets an ACP agent’s own list replace the stand-in outright', function () {
    const events = [];
    const adapter = new AcpChatAdapter({
      sessionId: 'app-session-1',
      workingDir: '/tmp',
      command: 'kimi',
      runtime: 'kimi',
      acpArgs: ['acp'],
      installedCommands: installed,
      emit: (event) => events.push(event),
    });
    adapter.capabilities.commands = mergeSlashCommands(adapter.capabilities.commands, installed);
    adapter.handleCommands({
      availableCommands: [{ name: 'compact', description: 'Compact the conversation context' }],
    });
    assert.deepStrictEqual(names(adapter.capabilities.commands), ['compact']);
    const reported = events.find((event) => event.t === 'capabilities');
    assert.deepStrictEqual(names(reported.capabilities.commands), ['compact']);
  });

  it('describes by name, ignoring a leading slash and letter case', function () {
    const describe = describeFrom(installed);
    assert.strictEqual(describe('/Deploy'), 'Ship the current branch');
    assert.strictEqual(describe('unheard-of'), undefined);
  });
});

/**
 * The wiring, end to end through a real session.
 *
 * The pieces above are each correct in isolation and were still capable of
 * leaving the menu empty: what matters is that a session, starting a runtime
 * that never reports a command list of its own, ends up advertising what is
 * installed. `/bin/cat` stands in for the CLI — it stays alive on an open pipe
 * and says nothing, which is exactly the runtime this has to work for.
 *
 * Driven on pi rather than grok since #73: grok moved onto ACP, and an ACP
 * adapter opens with a handshake that `/bin/cat` can only echo back, so it is
 * no longer a runtime that says nothing. It is also no longer a runtime that
 * never reports a command list — what happens to what is installed when a
 * runtime *does* report one is covered in `chat-tool-activity.test.js`.
 */
describe('a session advertises what is installed for it', function () {
  let dir;

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccweb-session-commands-'));
    const skillDir = path.join(dir, 'home/.pi/agent/skills/commit');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: commit\ndescription: Write the commit message\n---\n',
    );
  });

  afterEach(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function startedSession(env, runtime = 'pi') {
    const { ChatSession } = require('../dist/server/chat/session.js');
    const events = [];
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
        broadcast: () => {},
        resolveCommand: () => '/bin/cat',
      },
    );
    await session.start({ runtime, workingDir: path.join(dir, 'project'), env });
    return session;
  }

  it('offers an installed skill before the first message, on a runtime that never reports one', async function () {
    const session = await startedSession({ HOME: path.join(dir, 'home') });
    const offered = session.capabilities;
    await session.stop();
    assert.deepStrictEqual(names(offered.commands || []), ['commit']);
    assert.strictEqual((offered.commands || [])[0].description, 'Write the commit message');
  });

  it('offers agy the app’s own commands and the user’s skills together', async function () {
    // Two halves from two places, and the whole point is that neither eats the
    // other: the adapter declares `/clear`, `/new` and `/reset` statically
    // because agy interprets no command of its own, and the session merges the
    // disk scan on top before the process starts. A regression in either
    // direction — an adapter list that replaces the scan, or a scan that
    // replaces the adapter list — leaves half the menu missing, and the empty
    // half is invisible rather than wrong-looking.
    const skillDir = path.join(dir, 'home/.gemini/config/skills/release-check');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: release-check\ndescription: Run the release check\n---\n',
    );

    const session = await startedSession({ HOME: path.join(dir, 'home') }, 'antigravity');
    const offered = session.capabilities;
    await session.stop();

    const offeredNames = names(offered.commands || []);
    assert.deepStrictEqual(offeredNames, ['clear', 'new', 'reset', 'release-check']);
    assert.strictEqual(
      (offered.commands || []).find((c) => c.name === 'release-check').description,
      'Run the release check',
    );
  });

  it('reads the home of the session, never the server’s own', async function () {
    const session = await startedSession({ HOME: path.join(dir, 'nobody-lives-here') });
    const offered = session.capabilities;
    await session.stop();
    assert.deepStrictEqual(offered.commands || [], []);
  });
});
