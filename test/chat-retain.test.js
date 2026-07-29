const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Which folded turns the transcript keeps prepared. Pure policy, so it is
// tested on its own rather than through a render — the browser suite covers
// what the list actually mounts. Lives under src/client, which only reaches
// Node through esbuild.

const ROOT = path.join(__dirname, '..');
const CHAT_DIR = path.join(ROOT, 'src', 'client', 'chat');

let bundle;
let mod;

before(function () {
  this.timeout(60000);

  const contents = [`export * from ${JSON.stringify(path.join(CHAT_DIR, 'retain'))};`].join('\n');

  bundle = path.join(os.tmpdir(), `chat-retain-${process.pid}.js`);
  require('esbuild').buildSync({
    stdin: { contents, resolveDir: ROOT, loader: 'ts', sourcefile: 'chat-retain.ts' },
    bundle: true,
    outfile: bundle,
    format: 'cjs',
    platform: 'node',
    target: ['node20'],
    logLevel: 'silent',
  });

  mod = require(bundle);
});

after(function () {
  if (bundle) fs.rmSync(bundle, { force: true });
});

/** Ten turns, t1..t10, all weighing the same unless told otherwise. */
function order(count = 10) {
  return Array.from({ length: count }, (_, i) => `t${i + 1}`);
}

function flat(weight) {
  return () => weight;
}

describe('which turns stay prepared', function () {
  it('prepares the open turns and the live one, and nothing else', function () {
    const kept = mod.retain([], {
      order: order(),
      open: new Set(['t4']),
      liveId: 't10',
      weightOf: flat(1_000_000),
      budget: 0,
      floor: 0,
    });
    assert.deepStrictEqual(new Set(kept), new Set(['t4', 't10']));
  });

  it('prepares the live turn even while it is folded', function () {
    const kept = mod.retain([], {
      order: order(),
      open: new Set(),
      liveId: 't10',
      weightOf: flat(1_000_000),
      budget: 0,
      floor: 0,
    });
    assert.deepStrictEqual(kept, ['t10']);
  });

  it('keeps a folded turn that was open, so re-opening it is instant', function () {
    const opened = mod.retain([], {
      order: order(),
      open: new Set(['t4']),
      liveId: 't10',
      weightOf: flat(10),
    });
    assert.ok(opened.includes('t4'));

    const folded = mod.retain(opened, {
      order: order(),
      open: new Set(),
      liveId: 't10',
      weightOf: flat(10),
    });
    assert.ok(folded.includes('t4'), 'a turn just folded is still prepared');
  });

  it('releases the least recently opened once the budget is spent', function () {
    let kept = [];
    for (const id of ['t1', 't2', 't3', 't4', 't5']) {
      kept = mod.retain(kept, {
        order: order(),
        open: new Set([id]),
        liveId: 't10',
        weightOf: flat(100),
        budget: 250,
        floor: 0,
      });
    }
    // t5 is open and t10 is live, so both are outside the budget. Of the four
    // released turns behind them, 250/100 leaves room for two — the two most
    // recently opened.
    assert.deepStrictEqual(kept, ['t10', 't5', 't4', 't3']);
  });

  it('measures the budget in content, not in turns', function () {
    const heavy = (id) => (id === 't2' ? 10_000 : 10);
    let kept = mod.retain([], {
      order: order(),
      open: new Set(['t2']),
      liveId: 't10',
      weightOf: heavy,
    });
    for (const id of ['t3', 't4', 't5']) {
      kept = mod.retain(kept, {
        order: order(),
        open: new Set([id]),
        liveId: 't10',
        weightOf: heavy,
        budget: 1000,
        floor: 0,
      });
    }
    // Four light turns cost 40 against a budget of 1000 and all survive; the
    // one heavy turn does not, though it is no older than they are.
    assert.ok(!kept.includes('t2'), 'the heavy turn is released');
    for (const id of ['t3', 't4', 't5']) assert.ok(kept.includes(id), `${id} is kept`);
  });

  it('keeps a floor of turns however heavy they are', function () {
    let kept = [];
    for (const id of ['t1', 't2', 't3', 't4']) {
      kept = mod.retain(kept, {
        order: order(),
        open: new Set([id]),
        liveId: 't10',
        weightOf: flat(10_000_000),
        budget: 100,
        floor: 2,
      });
    }
    const released = kept.filter((id) => id !== 't4' && id !== 't10');
    assert.strictEqual(released.length, 2, 'the floor is kept whatever it weighs');
    assert.deepStrictEqual(released, ['t3', 't2']);
  });

  it('does not let a turn open across several calls drift down the order', function () {
    const budget = { budget: 200, floor: 0, weightOf: flat(100), liveId: 't10', order: order() };
    let kept = mod.retain([], { ...budget, open: new Set(['t1']) });
    // t1 stays open while three others are opened and folded around it.
    for (const id of ['t2', 't3', 't4']) {
      kept = mod.retain(kept, { ...budget, open: new Set(['t1', id]) });
    }
    kept = mod.retain(kept, { ...budget, open: new Set() });
    // Room for two released turns. t1 and t4 were open until this last call;
    // t2 and t3 were folded before it, however recently they were opened.
    assert.ok(kept.includes('t1'), 'the turn open until now did not drift down the order');
    assert.ok(kept.includes('t4'), 'nor did the other one');
    assert.ok(!kept.includes('t3'), 'the one folded a call earlier ranks below them');
    assert.ok(!kept.includes('t2'), 'and so does the one folded before that');
  });

  it('forgets turns that have left the conversation', function () {
    const kept = mod.retain(['t1', 'gone', 't10'], {
      order: order(),
      open: new Set(['t1']),
      liveId: 't10',
      weightOf: flat(10),
    });
    assert.ok(!kept.includes('gone'));
  });

  it('returns the previous answer unchanged when nothing moved', function () {
    const first = mod.retain([], {
      order: order(),
      open: new Set(['t4']),
      liveId: 't10',
      weightOf: flat(10),
    });
    const again = mod.retain(first, {
      order: order(),
      open: new Set(['t4']),
      liveId: 't10',
      weightOf: flat(10),
    });
    assert.strictEqual(again, first, 'same identity, so the list re-renders nothing');
  });
});

describe('what a turn costs to prepare', function () {
  function message(blocks) {
    return { id: 'm1', seq: 1, turnId: 't1', role: 'assistant', ts: 0, blocks };
  }

  it('counts the text a turn would render', function () {
    const short = mod.messageWeight(message([{ kind: 'text', text: 'hi' }]));
    const long = mod.messageWeight(message([{ kind: 'text', text: 'x'.repeat(5000) }]));
    assert.ok(long - short >= 4990, `${long} vs ${short}`);
  });

  it('charges for a block even when it renders nothing', function () {
    const one = mod.messageWeight(message([{ kind: 'text', text: '' }]));
    const many = mod.messageWeight(
      message(Array.from({ length: 300 }, () => ({ kind: 'text', text: '' }))),
    );
    assert.strictEqual(one, mod.BLOCK_COST);
    assert.strictEqual(many, mod.BLOCK_COST * 300, '300 empty cards are not free');
  });

  it('counts a tool call by its output and its diffs, not by its name', function () {
    const weight = mod.messageWeight(
      message([
        {
          kind: 'tool',
          toolId: 'c1',
          name: 'Edit',
          toolKind: 'edit',
          status: 'completed',
          input: { path: 'a.ts' },
          output: 'y'.repeat(2000),
          diffs: [
            {
              path: 'a.ts',
              kind: 'update',
              added: 1,
              removed: 0,
              hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['+' + 'z'.repeat(500)] }],
            },
          ],
        },
      ]),
    );
    assert.ok(weight > 2500, `${weight} covers the output and the hunk`);
  });

  it('gives an image a fixed cost rather than the length of its URL', function () {
    const weight = mod.messageWeight(
      message([{ kind: 'image', mime: 'image/png', url: '/a.png' }]),
    );
    assert.strictEqual(weight, mod.BLOCK_COST + mod.IMAGE_COST);
  });

  it('survives a cyclic tool input', function () {
    const input = { path: 'a.ts' };
    input.self = input;
    assert.doesNotThrow(() =>
      mod.messageWeight(
        message([{ kind: 'tool', toolId: 'c1', name: 'X', toolKind: 'other', status: 'completed', input }]),
      ),
    );
  });
});
