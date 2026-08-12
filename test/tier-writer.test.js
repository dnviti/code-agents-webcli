const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  applyTiers,
  supportsTiers,
  tierCapableRuntimes,
  MANAGED_MARKER,
} = require('../dist/server/services/tier-writer.js');

let root;
let ctx;

beforeEach(function () {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-writer-'));
  ctx = {
    generatedDir: path.join(root, 'generated'),
    homeDir: path.join(root, 'home'),
    workingDir: path.join(root, 'project'),
  };
  fs.mkdirSync(ctx.workingDir, { recursive: true });
});

afterEach(function () {
  fs.rmSync(root, { recursive: true, force: true });
});

function profile(extra) {
  return Object.assign({ id: 'p1', name: 'Cheap', runtime: 'pi' }, extra);
}

/** The agent files in a directory, ignoring .gitignore and any .bak sidecars. */
function agentFiles(dir) {
  return fs.readdirSync(dir).filter((name) => name.endsWith('.md'));
}

describe('tier writer', function () {
  it('knows which runtimes can express tiers', function () {
    assert.ok(supportsTiers('pi'));
    assert.ok(supportsTiers('omp'));
    assert.ok(supportsTiers('claude'));
    assert.ok(supportsTiers('grok'));
    // codex's per-role agent system has not shipped in a stable build yet, so
    // its conversation model keeps flowing through the ordinary model plumbing
    // rather than through a ladder that would land nowhere.
    assert.ok(!supportsTiers('codex'));
    assert.ok(!supportsTiers('kimi'));
    assert.ok(!supportsTiers('qwen'));
    assert.ok(!supportsTiers('terminal'));
    assert.ok(tierCapableRuntimes().includes('pi'));
  });

  it('does nothing when a profile defines no tiers', function () {
    const result = applyTiers(profile(), ctx);
    assert.deepStrictEqual(result.written, []);
    assert.strictEqual(result.unsupported, undefined);
  });

  it('reports unsupported rather than silently discarding tiers', function () {
    // A user who typed four model names deserves to be told they went nowhere.
    const result = applyTiers(profile({ runtime: 'kimi', tiers: { mid: 'x' } }), ctx);
    assert.strictEqual(result.unsupported, true);
    assert.deepStrictEqual(result.written, []);
  });

  describe('pi', function () {
    it('never touches the user’s global agent directory', function () {
      // The whole point of writing into the session's project instead. pi
      // resolves ~/.claude/agents, then ~/.pi/agent/agents, then project
      // .claude/agents, then project .pi/agents — later wins on name conflicts
      // — so the project copy overrides a hand-written ladder without the app
      // ever opening it for writing. Anything that moves this back to the home
      // directory turns "override" into "your files or ours".
      const home = path.join(ctx.homeDir, '.pi', 'agent', 'agents');
      fs.mkdirSync(home, { recursive: true });
      const mine = path.join(home, 'floor.md');
      fs.writeFileSync(mine, 'my own ladder\n');

      applyTiers(profile({ tiers: { floor: 'a', mid: 'b', high: 'c', top: 'd' } }), ctx);

      assert.strictEqual(fs.readFileSync(mine, 'utf8'), 'my own ladder\n');
      assert.deepStrictEqual(fs.readdirSync(home), ['floor.md']);
    });

    it('writes into the session’s project, where pi looks last', function () {
      const result = applyTiers(profile({ tiers: { mid: 'm' } }), ctx);
      assert.ok(
        result.written.includes(path.join(ctx.workingDir, '.pi', 'agents', 'mid.md')),
      );
    });

    it('marks the generated directory as ignored by git', function () {
      // It sits inside the user's repository, so without this every session
      // start adds untracked files to their `git status`.
      applyTiers(profile({ tiers: { mid: 'm' } }), ctx);
      const ignore = path.join(ctx.workingDir, '.pi', 'agents', '.gitignore');
      assert.ok(fs.existsSync(ignore));
      assert.ok(fs.readFileSync(ignore, 'utf8').includes('*'));
    });

    it('leaves a .gitignore the user put there alone', function () {
      const dir = path.join(ctx.workingDir, '.pi', 'agents');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '.gitignore'), '!keep-mine\n');

      applyTiers(profile({ tiers: { mid: 'm' } }), ctx);
      assert.strictEqual(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), '!keep-mine\n');
    });

    it('defers instead of guessing when no session directory is known', function () {
      // Saving from Settings happens before any session exists. Writing to some
      // fallback path would put the agents where pi will not look for them.
      const { workingDir, ...noSession } = ctx;
      const result = applyTiers(profile({ tiers: { mid: 'm' } }), noSession);
      assert.deepStrictEqual(result.written, []);
      assert.deepStrictEqual(result.replaced, []);
      assert.match(result.deferred, /per session/i);
      assert.ok(!fs.existsSync(path.join(ctx.homeDir, '.pi')));
      assert.ok(!fs.existsSync(path.join(ctx.workingDir, '.pi')));
    });

    it('writes one agent file per named tier', function () {
      const result = applyTiers(
        profile({ tiers: { floor: 'vendor/small', top: 'vendor/large' } }),
        ctx,
      );
      const dir = path.join(ctx.workingDir, '.pi', 'agents');
      assert.strictEqual(agentFiles(dir).length, 2);
      assert.ok(fs.existsSync(path.join(dir, 'floor.md')));
      assert.ok(fs.existsSync(path.join(dir, 'top.md')));
      // Tiers left blank must not produce a file.
      assert.ok(!fs.existsSync(path.join(dir, 'mid.md')));
    });

    it('passes the model through untouched', function () {
      // Provider-agnostic: the app must not "helpfully" qualify the id, because
      // which prefix is correct depends on how that install is authenticated.
      applyTiers(profile({ tiers: { mid: 'some-gateway/vendor/model:high' } }), ctx);
      const body = fs.readFileSync(
        path.join(ctx.workingDir, '.pi', 'agents', 'mid.md'),
        'utf8',
      );
      assert.ok(body.includes('model: some-gateway/vendor/model:high'));
    });

    it('quotes the description so a colon cannot break the frontmatter', function () {
      // An unquoted colon makes pi's YAML parse fail, and the agent then
      // vanishes from the agent list with no error at all.
      applyTiers(profile({ tiers: { top: 'm' } }), ctx);
      const body = fs.readFileSync(
        path.join(ctx.workingDir, '.pi', 'agents', 'top.md'),
        'utf8',
      );
      const line = body.split('\n').find((l) => l.startsWith('description:'));
      assert.ok(line.startsWith('description: "'), `description must be quoted, got: ${line}`);
    });

    it('gives cheap tiers less thinking than expensive ones', function () {
      applyTiers(profile({ tiers: { floor: 'a', top: 'b' } }), ctx);
      const dir = path.join(ctx.workingDir, '.pi', 'agents');
      assert.ok(fs.readFileSync(path.join(dir, 'floor.md'), 'utf8').includes('effort: low'));
      assert.ok(fs.readFileSync(path.join(dir, 'top.md'), 'utf8').includes('effort: max'));
    });

    it('replaces an agent file the user wrote', function () {
      // #171 reverses the rule this used to assert. A ladder that decides which
      // model answers every turn, silently doing nothing because of a file left
      // in a project a year ago, is a worse failure than an overwrite — so the
      // profile is the source of truth and the file goes.
      const dir = path.join(ctx.workingDir, '.pi', 'agents');
      fs.mkdirSync(dir, { recursive: true });
      const mine = path.join(dir, 'mid.md');
      fs.writeFileSync(mine, 'hand written, do not touch\n');

      const result = applyTiers(profile({ tiers: { mid: 'x' } }), ctx);

      assert.ok(fs.readFileSync(mine, 'utf8').includes('model: x'));
      assert.ok(result.written.includes(mine));
      assert.strictEqual(result.replaced.length, 1);
      assert.strictEqual(result.replaced[0].file, mine);
    });

    it('keeps what it replaced in a .bak beside it', function () {
      const dir = path.join(ctx.workingDir, '.pi', 'agents');
      fs.mkdirSync(dir, { recursive: true });
      const mine = path.join(dir, 'mid.md');
      fs.writeFileSync(mine, 'hand written, do not touch\n');

      applyTiers(profile({ tiers: { mid: 'x' } }), ctx);
      assert.strictEqual(
        fs.readFileSync(`${mine}.bak`, 'utf8'),
        'hand written, do not touch\n',
      );
    });

    it('never lets a second pass overwrite the backup', function () {
      // The dangerous case: the .bak now holds the user's original, and a
      // refresh would replace it with the generated file we are about to
      // replace — leaving them nothing at all.
      const dir = path.join(ctx.workingDir, '.pi', 'agents');
      fs.mkdirSync(dir, { recursive: true });
      const mine = path.join(dir, 'mid.md');
      fs.writeFileSync(mine, 'hand written, do not touch\n');

      applyTiers(profile({ tiers: { mid: 'x' } }), ctx);
      applyTiers(profile({ tiers: { mid: 'y' } }), ctx);

      assert.strictEqual(
        fs.readFileSync(`${mine}.bak`, 'utf8'),
        'hand written, do not touch\n',
      );
    });

    it('says what it did to the file, not just that it wrote one', function () {
      const dir = path.join(ctx.workingDir, '.pi', 'agents');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'mid.md'), 'hand written\n');

      const result = applyTiers(profile({ tiers: { mid: 'x' } }), ctx);
      assert.match(result.replaced[0].reason, /source of truth/);
      assert.match(result.replaced[0].reason, /\.bak/);
    });

    it('reports every tier it replaced, not just the first', function () {
      // All four is the realistic case for anyone who already keeps a
      // hand-written ladder, and it is the case that destroys the most.
      const dir = path.join(ctx.workingDir, '.pi', 'agents');
      fs.mkdirSync(dir, { recursive: true });
      for (const tier of ['floor', 'mid', 'high', 'top']) {
        fs.writeFileSync(path.join(dir, `${tier}.md`), 'hand written\n');
      }

      const result = applyTiers(
        profile({ tiers: { floor: 'a', mid: 'b', high: 'c', top: 'd' } }),
        ctx,
      );
      assert.strictEqual(agentFiles(path.join(ctx.workingDir, '.pi', 'agents')).length, 4);
      assert.deepStrictEqual(
        result.replaced.map((s) => path.basename(s.file)).sort(),
        ['floor.md', 'high.md', 'mid.md', 'top.md'],
      );
    });

    it('does not report a file it generated earlier as one of the user’s', function () {
      applyTiers(profile({ tiers: { mid: 'first' } }), ctx);
      const result = applyTiers(profile({ tiers: { mid: 'second' } }), ctx);
      const body = fs.readFileSync(
        path.join(ctx.workingDir, '.pi', 'agents', 'mid.md'),
        'utf8',
      );
      assert.ok(body.includes('model: second'));
      assert.ok(body.includes(MANAGED_MARKER));
      assert.strictEqual(result.replaced.length, 0);
      // And no backup, which is the tell: a .bak here would mean the marker
      // check had stopped recognising our own output.
      assert.ok(!fs.existsSync(path.join(ctx.workingDir, '.pi', 'agents', 'mid.md.bak')));
    });
  });

  describe('grok', function () {
    function grokProfile(tiers) {
      return { id: 'p8', name: 'Role files', runtime: 'grok', tiers };
    }

    function roleDir() {
      return path.join(ctx.workingDir, '.grok', 'roles');
    }

    it('writes one role file per named rung into the session project', function () {
      const result = applyTiers(
        grokProfile({ floor: 'vendor/small', top: 'vendor/large' }),
        ctx,
      );
      const dir = roleDir();
      assert.strictEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.toml')).length, 2);
      assert.ok(fs.existsSync(path.join(dir, 'floor.toml')));
      assert.ok(fs.existsSync(path.join(dir, 'top.toml')));
      assert.ok(!fs.existsSync(path.join(dir, 'mid.toml')));
      assert.ok(result.written.length === 2);
    });

    it('gives the read-only rungs a capability mode and passes the model through', function () {
      applyTiers(grokProfile({ floor: 'vendor/model:high', mid: 'm' }), ctx);
      const floor = fs.readFileSync(path.join(roleDir(), 'floor.toml'), 'utf8');
      assert.ok(floor.includes('model = "vendor/model:high"'), floor);
      assert.ok(floor.includes('default_capability_mode = "read-only"'), floor);
      const mid = fs.readFileSync(path.join(roleDir(), 'mid.toml'), 'utf8');
      assert.ok(mid.includes('model = "m"'), mid);
      assert.ok(!mid.includes('default_capability_mode'), mid);
    });

    it('marks the generated directory as ignored by git', function () {
      applyTiers(grokProfile({ mid: 'm' }), ctx);
      const ignore = path.join(roleDir(), '.gitignore');
      assert.ok(fs.existsSync(ignore));
      assert.ok(fs.readFileSync(ignore, 'utf8').includes('*'));
    });

    it('defers instead of guessing when no session directory is known', function () {
      const { workingDir, ...noSession } = ctx;
      const result = applyTiers(grokProfile({ mid: 'm' }), noSession);
      assert.deepStrictEqual(result.written, []);
      assert.match(result.deferred, /per session/i);
      assert.ok(!fs.existsSync(path.join(ctx.homeDir, '.grok')));
    });

    it('replaces a role file the user wrote, keeping a .bak beside it', function () {
      const dir = roleDir();
      fs.mkdirSync(dir, { recursive: true });
      const mine = path.join(dir, 'mid.toml');
      fs.writeFileSync(mine, 'hand written\n');

      applyTiers(grokProfile({ mid: 'x' }), ctx);
      assert.ok(fs.readFileSync(mine, 'utf8').includes('model = "x"'));
      assert.strictEqual(fs.readFileSync(`${mine}.bak`, 'utf8'), 'hand written\n');
    });
  });

  describe('claude', function () {
    function claudeProfile(tiers) {
      return { id: 'p7', name: 'Session agents', runtime: 'claude', tiers };
    }

    function parsedAgents(result) {
      assert.strictEqual(result.args[0], '--agents');
      return JSON.parse(result.args[1]);
    }

    it('carries the ladder as session agents on the command line', function () {
      const result = applyTiers(
        claudeProfile({ floor: 'cheap', mid: 'work', high: 'sharp', top: 'best' }),
        ctx,
      );
      assert.deepStrictEqual(result.written, []);
      assert.deepStrictEqual(result.replaced, []);
      const agents = parsedAgents(result);
      assert.deepStrictEqual(Object.keys(agents), ['floor', 'mid', 'high', 'top']);
      assert.strictEqual(agents.floor.model, 'cheap');
      assert.strictEqual(agents.mid.model, 'work');
      assert.strictEqual(agents.high.model, 'sharp');
      assert.strictEqual(agents.top.model, 'best');
    });

    it('restricts the read-only rungs to inspection tools and cheap thinking', function () {
      const result = applyTiers(claudeProfile({ floor: 'a', top: 'b' }), ctx);
      const agents = parsedAgents(result);
      assert.deepStrictEqual(agents.floor.tools, ['Read', 'Grep', 'Glob', 'Bash']);
      assert.deepStrictEqual(agents.top.tools, ['Read', 'Grep', 'Glob', 'Bash']);
      assert.strictEqual(agents.floor.effort, 'low');
      assert.strictEqual(agents.top.effort, 'max');
    });

    it('leaves the workhorse rungs with every tool', function () {
      const result = applyTiers(claudeProfile({ mid: 'm' }), ctx);
      const agents = parsedAgents(result);
      assert.deepStrictEqual(Object.keys(agents), ['mid']);
      assert.strictEqual(agents.mid.tools, undefined);
      assert.strictEqual(agents.mid.model, 'm');
      assert.strictEqual(agents.mid.effort, 'medium');
    });

    it('passes the model through untouched', function () {
      const result = applyTiers(claudeProfile({ mid: 'some-gateway/vendor/model:high' }), ctx);
      assert.strictEqual(parsedAgents(result).mid.model, 'some-gateway/vendor/model:high');
    });

    it('writes nothing into the project or home directory', function () {
      applyTiers(claudeProfile({ mid: 'm' }), ctx);
      assert.ok(!fs.existsSync(path.join(ctx.workingDir, '.claude')));
      assert.ok(!fs.existsSync(path.join(ctx.homeDir, '.claude')));
    });
  });

  describe('omp', function () {
    function ompProfile(tiers) {
      return { id: 'p9', name: 'Mixed', runtime: 'omp', tiers };
    }

    it('writes an overlay in the app data dir, not the user config', function () {
      // ~/.omp/agent/config.yml is the user's own file; --config overlays it.
      const result = applyTiers(ompProfile({ floor: 'small', high: 'big' }), ctx);
      assert.strictEqual(result.written.length, 1);
      assert.ok(result.written[0].startsWith(ctx.generatedDir));
      assert.ok(!fs.existsSync(path.join(ctx.homeDir, '.omp')));
    });

    it('returns the --config argument pointing at what it wrote', function () {
      const result = applyTiers(ompProfile({ mid: 'm' }), ctx);
      assert.strictEqual(result.args[0], '--config');
      assert.strictEqual(result.args[1], result.written[0]);
    });

    it('maps every one of the ten roles onto the tier rungs', function () {
      const result = applyTiers(ompProfile({ floor: 'f', mid: 'm', high: 'h', top: 't' }), ctx);
      const body = fs.readFileSync(result.written[0], 'utf8');
      // Cheap utility roles take the floor, the workhorse roles take mid, and
      // reasoning and judgment roles take high and top. Order is omp's own.
      assert.ok(body.includes('default: "m"'), body);
      assert.ok(body.includes('smol: "f"'), body);
      assert.ok(body.includes('slow: "h"'), body);
      assert.ok(body.includes('vision: "f"'), body);
      assert.ok(body.includes('plan: "t"'), body);
      assert.ok(body.includes('designer: "m"'), body);
      assert.ok(body.includes('commit: "f"'), body);
      assert.ok(body.includes('tiny: "f"'), body);
      assert.ok(body.includes('task: "m"'), body);
      assert.ok(body.includes('advisor: "t"'), body);
    });

    it('quotes model ids so a thinking suffix does not parse as a mapping', function () {
      const result = applyTiers(ompProfile({ mid: 'vendor/model:max' }), ctx);
      const body = fs.readFileSync(result.written[0], 'utf8');
      assert.ok(body.includes('"vendor/model:max"'), body);
    });

    it('falls back between neighbouring tiers rather than emitting an empty role', function () {
      // Only `high` given: every role with it in its chain answers from it
      // (`slow`, `plan`, `default`, `designer`, `task`, `advisor`), and the
      // floor-bound utility roles stay empty rather than climbing up.
      const result = applyTiers(ompProfile({ high: 'only' }), ctx);
      const body = fs.readFileSync(result.written[0], 'utf8');
      for (const role of ['slow', 'plan', 'default', 'designer', 'task', 'advisor']) {
        assert.ok(body.includes(`${role}: "only"`), body);
      }
      for (const role of ['smol', 'vision', 'commit', 'tiny']) {
        assert.ok(!body.includes(`${role}:`), body);
      }
    });
  });

  it('degrades to no tiers rather than throwing when the write fails', function () {
    // A failure here must still let the user launch the runtime.
    const blocked = { generatedDir: path.join(root, 'file-not-dir'), homeDir: ctx.homeDir };
    fs.writeFileSync(blocked.generatedDir, 'not a directory');
    const result = applyTiers({ id: 'p1', name: 'x', runtime: 'omp', tiers: { mid: 'm' } }, blocked);
    assert.deepStrictEqual(result.written, []);
    assert.deepStrictEqual(result.args, []);
  });
});
