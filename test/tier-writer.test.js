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

describe('tier writer', function () {
  it('knows which runtimes can express tiers', function () {
    assert.ok(supportsTiers('pi'));
    assert.ok(supportsTiers('omp'));
    assert.ok(!supportsTiers('claude'));
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
    const result = applyTiers(profile({ runtime: 'claude', tiers: { mid: 'x' } }), ctx);
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
      assert.strictEqual(result.written.length, 1);
      assert.strictEqual(
        result.written[0],
        path.join(ctx.workingDir, '.pi', 'agents', 'mid.md'),
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
      assert.strictEqual(result.written.length, 2);
      const dir = path.join(ctx.workingDir, '.pi', 'agents');
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
      assert.deepStrictEqual(result.written, [mine]);
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
      assert.strictEqual(result.written.length, 4);
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

    it('maps tiers onto omp model roles', function () {
      const result = applyTiers(ompProfile({ floor: 'f', mid: 'm', high: 'h', top: 't' }), ctx);
      const body = fs.readFileSync(result.written[0], 'utf8');
      assert.ok(body.includes('smol: "f"'), body);
      assert.ok(body.includes('task: "m"'), body);
      assert.ok(body.includes('slow: "h"'), body);
      assert.ok(body.includes('plan: "t"'), body);
    });

    it('quotes model ids so a thinking suffix does not parse as a mapping', function () {
      const result = applyTiers(ompProfile({ mid: 'vendor/model:max' }), ctx);
      const body = fs.readFileSync(result.written[0], 'utf8');
      assert.ok(body.includes('"vendor/model:max"'), body);
    });

    it('falls back between neighbouring tiers rather than emitting an empty role', function () {
      // Only `high` given: `slow` uses it and `plan` falls back to it too.
      const result = applyTiers(ompProfile({ high: 'only' }), ctx);
      const body = fs.readFileSync(result.written[0], 'utf8');
      assert.ok(body.includes('slow: "only"'), body);
      assert.ok(body.includes('plan: "only"'), body);
      assert.ok(!body.includes('smol:'), body);
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
