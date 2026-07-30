const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Turn grouping is what the index, the sticky strip and "jump to turn 12" all
// read. It is pure, so it is tested directly rather than through a render —
// but it lives under src/client, which only ever reaches Node through esbuild.

const ROOT = path.join(__dirname, '..');
const CHAT_DIR = path.join(ROOT, 'src', 'client', 'chat');

let bundle;
let mod;

before(function () {
  this.timeout(60000);

  const contents = [
    `export * from ${JSON.stringify(path.join(CHAT_DIR, 'turns'))};`,
  ].join('\n');

  bundle = path.join(os.tmpdir(), `chat-turns-${process.pid}.js`);
  require('esbuild').buildSync({
    stdin: { contents, resolveDir: ROOT, loader: 'ts', sourcefile: 'chat-turns.ts' },
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

let seq = 0;
let turn = 0;

// Turn ids the way an adapter actually stamps them: a user message opens a turn
// and everything the agent says about it carries the same id. Numbering every
// message separately — which this helper used to do — is a shape no runtime
// produces, and it hid the fact that grouping is by turn id (#86). Pass an
// explicit `turnId` for the two cases that matter: a steer, which shares the
// running turn, and a runtime echoing the prompt back under an id of its own.
function msg(role, blocks, extra = {}) {
  seq += 1;
  if (role === 'user' && extra.turnId === undefined) turn += 1;
  return {
    id: `m${seq}`,
    seq,
    turnId: `t${turn}`,
    role,
    ts: seq * 1000,
    blocks,
    ...extra,
  };
}

function text(value) {
  return { kind: 'text', text: value };
}

function tool(status, extra = {}) {
  return {
    kind: 'tool',
    toolId: `tool-${Math.random().toString(36).slice(2)}`,
    name: 'bash',
    toolKind: 'execute',
    status,
    ...extra,
  };
}

function thinking(value = 'weighing it up') {
  return { kind: 'thinking', text: value };
}

beforeEach(function () {
  seq = 0;
  turn = 0;
});

describe('groupTurns', function () {
  it('starts a turn at every user message and ends it before the next', function () {
    const messages = [
      msg('user', [text('run the tests')]),
      msg('assistant', [text('all green')]),
      msg('user', [text('now deploy')]),
      msg('assistant', [text('deployed')]),
    ];

    const turns = mod.groupTurns(messages, 'idle');

    assert.strictEqual(turns.length, 2);
    assert.deepStrictEqual(turns.map((t) => t.label), ['run the tests', 'now deploy']);
    assert.deepStrictEqual(turns.map((t) => t.index), [1, 2]);
    assert.deepStrictEqual(turns[0].messageIds, ['m1', 'm2']);
    assert.deepStrictEqual(turns[1].messageIds, ['m3', 'm4']);
  });

  it('does not drop messages that arrive before the first user turn', function () {
    // A resumed transcript's tail, or a compaction marker replayed on join.
    // They are on screen, so they need a strip and an index row like anything
    // else — silently omitting them would leave the transcript with a
    // headerless region nothing in the index points at.
    const messages = [
      msg('system', [{ kind: 'notice', notice: 'compacted', text: 'Context compacted' }]),
      msg('user', [text('carry on')]),
    ];

    const turns = mod.groupTurns(messages, 'idle');

    assert.strictEqual(turns.length, 2);
    assert.strictEqual(turns[0].label, 'Context compacted');
    assert.deepStrictEqual(turns[0].messageIds, ['m1']);
  });

  it('takes only the first line of a multi-line ask as the label', function () {
    const messages = [msg('user', [text('fix the pty test\n\nit times out on the second write')])];
    assert.strictEqual(mod.groupTurns(messages, 'idle')[0].label, 'fix the pty test');
  });

  it('names an attachments-only turn rather than leaving it blank', function () {
    const messages = [msg('user', [{ kind: 'image', mime: 'image/png', url: '/a.png' }])];
    assert.strictEqual(mod.groupTurns(messages, 'idle')[0].label, 'attachment');
  });

  it('returns nothing for an empty transcript', function () {
    assert.deepStrictEqual(mod.groupTurns([], 'idle'), []);
  });

  describe('status', function () {
    it('marks only the last turn as running, never the earlier ones', function () {
      // Session state is session-wide; reading it onto every turn is how every
      // row in the index ends up spinning at once.
      const messages = [
        msg('user', [text('first')]),
        msg('assistant', [text('done')]),
        msg('user', [text('second')]),
        msg('assistant', [text('working')], { streaming: true }),
      ];

      const turns = mod.groupTurns(messages, 'running');

      assert.strictEqual(turns[0].status, 'done');
      assert.strictEqual(turns[1].status, 'running');
    });

    it('reports waiting when the session is blocked on an approval', function () {
      const messages = [msg('user', [text('rm the build dir')]), msg('assistant', [tool('pending')])];
      assert.strictEqual(mod.groupTurns(messages, 'awaiting_permission')[0].status, 'waiting');
    });

    it('reports done for a long turn that failed steps along the way', function () {
      // The complaint in issue #74, in one case: a turn that ran a dozen steps,
      // had a couple of them go wrong, and finished. A grep with no match and a
      // test run that reported failures are what this work is made of; neither
      // is a verdict on the turn.
      const messages = [
        msg('user', [text('make the suite pass')]),
        msg('assistant', [tool('completed'), tool('failed'), tool('completed'), tool('failed')]),
        msg('assistant', [text('all green now')], { turnOutcome: 'done' }),
        msg('user', [text('and again')]),
      ];

      const turn = mod.groupTurns(messages, 'idle')[0];

      assert.strictEqual(turn.status, 'done');
      // Not hidden — still counted, so the steps stay findable from the turn.
      assert.strictEqual(turn.failedStepCount, 2);
    });

    it('reports done for a turn that read an error and carried on', function () {
      const messages = [
        msg('user', [text('go')]),
        msg('assistant', [{ kind: 'error', text: 'could not read notes.txt' }, text('used the other file')], {
          turnOutcome: 'done',
        }),
      ];
      assert.strictEqual(mod.groupTurns(messages, 'idle')[0].status, 'done');
    });

    it('reports failed for a turn the runtime ended as failed', function () {
      const messages = [
        msg('user', [text('go')]),
        msg('assistant', [text('starting')], { turnOutcome: 'failed' }),
        msg('user', [text('again')]),
      ];
      assert.strictEqual(mod.groupTurns(messages, 'idle')[0].status, 'failed');
    });

    it('reports failed for a turn cut short by an error it could not get past', function () {
      // No turn_end ever arrives for this one: the process went away, so the
      // only thing that says how the turn ended is the fatal error itself.
      const messages = [
        msg('user', [text('go')]),
        msg('assistant', [{ kind: 'error', text: 'grok exited (code 1)', fatal: true }]),
      ];
      assert.strictEqual(mod.groupTurns(messages, 'idle')[0].status, 'failed');
    });

    it('reports failed for the open turn when the session died under it', function () {
      const messages = [msg('user', [text('go')]), msg('assistant', [tool('running')])];
      assert.strictEqual(mod.groupTurns(messages, 'exited')[0].status, 'failed');
      assert.strictEqual(mod.groupTurns(messages, 'error')[0].status, 'failed');
    });

    it('keeps the outcome a turn ended with when the session dies afterwards', function () {
      // A one-shot CLI exits the moment it has answered. What the runtime said
      // when it closed the turn outranks the process going away after it.
      const messages = [
        msg('user', [text('go')]),
        msg('assistant', [text('here you are')], { turnOutcome: 'done' }),
      ];
      assert.strictEqual(mod.groupTurns(messages, 'exited')[0].status, 'done');
    });

    it('reports running for a turn still in flight, never failed', function () {
      const messages = [
        msg('user', [text('go')]),
        msg('assistant', [tool('failed'), tool('running')], { streaming: true }),
      ];
      assert.strictEqual(mod.groupTurns(messages, 'running')[0].status, 'running');
    });

    it('does not spin on a message left flagged streaming once the session is idle', function () {
      // What the user saw: a turn that had finished, still showing the working
      // spinner. A `streaming` flag is only ever cleared by an event, and the
      // events that clear it go missing in ordinary ways — a window cut before
      // `msg_end`, a runtime that dropped it, a reconnect. The session's own
      // state is the authority on whether anything is running, and idle is the
      // word every adapter ends a turn with.
      const messages = [
        msg('user', [text('go')]),
        msg('assistant', [text('all done')], { streaming: true }),
      ];
      assert.strictEqual(mod.groupTurns(messages, 'idle')[0].status, 'done');
    });

    it('does not treat a denied call as a failure', function () {
      // "You refused this" is not "this broke", and the index must not paint
      // the user's own decision red.
      const messages = [msg('user', [text('go')]), msg('assistant', [tool('denied')])];
      assert.strictEqual(mod.groupTurns(messages, 'idle')[0].status, 'done');
    });
  });

  it('counts tools and reasoning across every message in the turn', function () {
    const messages = [
      msg('user', [text('investigate')]),
      msg('assistant', [thinking(), tool('completed'), tool('completed')]),
      msg('assistant', [thinking(), text('here is what I found')]),
    ];

    const turn = mod.groupTurns(messages, 'idle')[0];
    assert.strictEqual(turn.toolCount, 2);
    assert.strictEqual(turn.reasoningCount, 2);
  });

  it('sums usage over the turn rather than reporting the last message only', function () {
    const messages = [
      msg('user', [text('go')]),
      msg('assistant', [text('a')], { usage: { outputTokens: 100, costUsd: 0.01 } }),
      msg('assistant', [text('b')], { usage: { outputTokens: 50, costUsd: 0.02 } }),
    ];

    const turn = mod.groupTurns(messages, 'idle')[0];
    assert.strictEqual(turn.usage.outputTokens, 150);
    assert.ok(Math.abs(turn.usage.costUsd - 0.03) < 1e-9);
  });

  it('leaves a running turn without a duration', function () {
    // A "duration so far" frozen at whatever the last event stamped reads as a
    // finished number, and is not one.
    const messages = [msg('user', [text('go')]), msg('assistant', [text('…')], { streaming: true })];
    assert.strictEqual(mod.groupTurns(messages, 'running')[0].durationMs, undefined);
  });

  it('measures a finished turn from its opening message', function () {
    const messages = [msg('user', [text('go')]), msg('assistant', [text('done')])];
    assert.strictEqual(mod.groupTurns(messages, 'idle')[0].durationMs, 1000);
  });
});

describe('reconcileTurns', function () {
  // The defect from the screenshot: reload a 49-turn conversation, the browser
  // holds the tail, and the strip says "Turn 1". The number is a fact about the
  // conversation, not about the window a browser happens to be looking through.
  const recorded = (count) =>
    Array.from({ length: count }, (_, i) => ({
      id: `u${i + 1}`,
      turnId: `t${i + 1}`,
      index: i + 1,
      label: `ask ${i + 1}`,
      outcome: 'done',
    }));

  it('numbers a loaded turn by where it sits in the conversation', function () {
    // One turn loaded out of forty-nine, and it is the forty-ninth.
    const messages = [
      msg('user', [text('the last thing')], { turnId: 't49' }),
      msg('assistant', [text('done')], { turnId: 't49' }),
    ];
    const turns = mod.reconcileTurns(mod.groupTurns(messages, 'idle'), recorded(49));
    assert.strictEqual(turns.length, 1);
    assert.strictEqual(turns[0].index, 49, 'the strip must say 49, not 1');
  });

  it('counts back as older turns are paged in', function () {
    const messages = [
      msg('user', [text('the one before')], { turnId: 't48' }),
      msg('user', [text('the last thing')], { turnId: 't49' }),
    ];
    const turns = mod.reconcileTurns(mod.groupTurns(messages, 'idle'), recorded(49));
    assert.deepStrictEqual(turns.map((t) => t.index), [48, 49]);
  });

  it('names a half-loaded turn from the recording, not "no prompt"', function () {
    // The replay landed inside the turn, so the ask is not in the window — but
    // it is on file, and the index is scanned for exactly that ask.
    const messages = [msg('assistant', [text('picking up where we left off')], { turnId: 't49' })];
    const turns = mod.reconcileTurns(mod.groupTurns(messages, 'idle'), recorded(49));
    assert.strictEqual(turns[0].label, 'ask 49');
  });

  it('continues past the end for a turn newer than the index', function () {
    // The turn being typed into is not in a list fetched before it existed.
    const messages = [
      msg('user', [text('the last thing')], { turnId: 't49' }),
      msg('user', [text('and one more')], { turnId: 't50' }),
    ];
    const turns = mod.reconcileTurns(mod.groupTurns(messages, 'idle'), recorded(49));
    assert.deepStrictEqual(turns.map((t) => t.index), [49, 50]);
  });

  it('numbers a turn the recording has not heard of *above* the ones it has', function () {
    // What a trimmed log looks like from here: the recorded index starts at
    // 4,001 because everything older was dropped, and the window holds one turn
    // above the first the recording names — a page that began inside it, under
    // the runtime's own id. Numbering that turn 1 put "Turn 01" directly above
    // "Turn 4001" in the index, which is the position of a row in an array and
    // not a fact about the conversation.
    const recorded = [
      { id: 'u4001', turnId: 't4001', index: 4001, label: 'ask 4001', outcome: 'done' },
      { id: 'u4002', turnId: 't4002', index: 4002, label: 'ask 4002', outcome: 'done' },
    ];
    const messages = [
      msg('assistant', [text('…finishing the one before')], { turnId: 'runtime-7' }),
      msg('user', [text('ask 4001')], { turnId: 't4001' }),
      msg('user', [text('ask 4002')], { turnId: 't4002' }),
    ];
    const turns = mod.reconcileTurns(mod.groupTurns(messages, 'idle'), recorded);
    assert.deepStrictEqual(turns.map((t) => t.index), [4000, 4001, 4002]);
  });

  it('numbers unrecorded turns above the first recorded one without repeating it', function () {
    // Three turns the recording has not reached sitting above turn 2: counting
    // back would put one at 0 and one at -1. The clamp keeps them at 1, and
    // what matters then is that the list stays readable — no number used twice
    // and no number out of order — rather than merely "all at least 1", which
    // is true of the numbering this replaced as well.
    const recorded = [{ id: 'u2', turnId: 't2', index: 2, label: 'ask 2', outcome: 'done' }];
    const messages = [
      msg('user', [text('older a')], { turnId: 'told-a' }),
      msg('user', [text('older b')], { turnId: 'told-b' }),
      msg('user', [text('older c')], { turnId: 'told-c' }),
      msg('user', [text('ask 2')], { turnId: 't2' }),
    ];
    const turns = mod.reconcileTurns(mod.groupTurns(messages, 'idle'), recorded);
    const numbers = turns.map((t) => t.index);

    assert.ok(numbers.every((index) => index >= 1), numbers.join(','));
    assert.deepStrictEqual(
      [...numbers].sort((a, b) => a - b),
      numbers,
      `the index runs backwards somewhere: ${numbers.join(',')}`,
    );
    // The index reverses this list to draw newest-first, so the rows have to
    // leave here oldest-first: a turn the recording never named, appended at
    // the end, was drawn as the newest turn of the conversation.
    const rows = mod.turnIndexRows(recorded, turns).map((row) => row.index);
    assert.deepStrictEqual(
      rows,
      [...rows].sort((a, b) => a - b),
      `the rows are not in the order their numbers claim: ${rows.join(',')}`,
    );
  });

  it('leaves the turns alone when no recording has arrived', function () {
    const messages = [msg('user', [text('one')]), msg('user', [text('two')])];
    const grouped = mod.groupTurns(messages, 'idle');
    assert.deepStrictEqual(
      mod.reconcileTurns(grouped, null).map((t) => t.index),
      [1, 2],
    );
    assert.deepStrictEqual(
      mod.reconcileTurns(grouped, []).map((t) => t.index),
      [1, 2],
    );
  });
});

describe('turnIndexRows', function () {
  it('lists every recorded turn, marking which are held', function () {
    const recorded = [
      { id: 'u1', turnId: 't1', index: 1, label: 'first', outcome: 'done' },
      { id: 'u2', turnId: 't2', index: 2, label: 'second', outcome: 'failed' },
    ];
    const live = mod.groupTurns([msg('user', [text('second')], { turnId: 't2' })], 'idle');
    const rows = mod.turnIndexRows(recorded, live);

    assert.deepStrictEqual(rows.map((r) => r.index), [1, 2]);
    assert.deepStrictEqual(rows.map((r) => r.loaded), [false, true]);
    assert.deepStrictEqual(rows.map((r) => r.label), ['first', 'second']);
    assert.strictEqual(rows[1].status, 'done', 'a loaded turn’s live status wins');
  });

  it('puts a turn the recording never named where its number says, not last', function () {
    // Live turns are appended after the recorded spine, which is right for the
    // turn being typed into and wrong for one held *above* the recording's
    // first — and the list is drawn newest-first, so a row tacked onto the end
    // is drawn at the top, as the newest turn in the conversation.
    const recorded = [
      { id: 'u4001', turnId: 't4001', index: 4001, label: 'ask 4001', outcome: 'done' },
    ];
    const messages = [
      msg('assistant', [text('…finishing the one before')], { turnId: 'runtime-7' }),
      msg('user', [text('ask 4001')], { turnId: 't4001' }),
    ];
    const live = mod.reconcileTurns(mod.groupTurns(messages, 'idle'), recorded);
    const rows = mod.turnIndexRows(recorded, live);
    assert.deepStrictEqual(rows.map((r) => r.index), [4000, 4001]);
  });

  it('falls back to the loaded turns when nothing was recorded', function () {
    const live = mod.groupTurns([msg('user', [text('only this')])], 'idle');
    const rows = mod.turnIndexRows(null, live);
    assert.deepStrictEqual(rows.map((r) => r.label), ['only this']);
    assert.strictEqual(rows[0].loaded, true);
  });
});

describe('turnOf', function () {
  it('finds the turn a message belongs to', function () {
    const messages = [
      msg('user', [text('one')]),
      msg('assistant', [text('a')]),
      msg('user', [text('two')]),
      msg('assistant', [text('b')]),
    ];
    const turns = mod.groupTurns(messages, 'idle');

    assert.strictEqual(mod.turnOf('m4', turns).label, 'two');
    assert.strictEqual(mod.turnOf('nope', turns), undefined);
  });
});

describe('isTurnOpen', function () {
  it('reads an untouched turn as open exactly when it is the newest', function () {
    const overrides = new Map();
    assert.strictEqual(mod.isTurnOpen('t2', 't2', overrides), true);
    assert.strictEqual(mod.isTurnOpen('t1', 't2', overrides), false);
  });

  it('lets an explicit override win regardless of which turn is newest', function () {
    // A turn the user deliberately opened must not be slammed shut by the
    // next turn starting, and one they closed must not spring back open.
    const overrides = new Map([['t1', true], ['t2', false]]);
    assert.strictEqual(mod.isTurnOpen('t1', 't2', overrides), true);
    assert.strictEqual(mod.isTurnOpen('t2', 't2', overrides), false);
  });
});

describe('what each turn cost', function () {
  // The figure comes from the accounting, keyed by turn id, and is laid over
  // the turns a browser holds. It cannot be added up from the messages: the
  // money only exists once a turn has ended, and on half the runtimes it has to
  // be differenced against a running total to mean "this turn".
  const recorded = [
    { id: 'm1', turnId: 't1', index: 1, label: 'run the tests', outcome: 'done' },
    { id: 'm3', turnId: 't2', index: 2, label: 'now deploy', outcome: 'done' },
  ];
  const spend = new Map([['t1', { costUsd: 0.42 }]]);

  function twoTurns() {
    return [
      msg('user', [text('run the tests')]),
      msg('assistant', [text('all green')], { usage: { outputTokens: 12 } }),
      msg('user', [text('now deploy')]),
      msg('assistant', [text('deployed')]),
    ];
  }

  it('puts the recorded bill on the turn without losing its live tokens', function () {
    const turns = mod.reconcileTurns(mod.groupTurns(twoTurns(), 'idle'), recorded, spend);
    assert.strictEqual(turns[0].usage.costUsd, 0.42);
    assert.strictEqual(turns[0].usage.outputTokens, 12, 'the live tokens survive the merge');
    assert.strictEqual(mod.formatTurnMeta(turns[0]).cost, '$0.42');
  });

  it('carries it onto the index rows, and says nothing where nothing was filed', function () {
    const turns = mod.reconcileTurns(mod.groupTurns(twoTurns(), 'idle'), recorded, spend);
    const rows = mod.turnIndexRows(recorded, turns, spend);
    assert.strictEqual(rows[0].costUsd, 0.42);
    assert.strictEqual(rows[1].costUsd, undefined, 'a turn nobody priced shows no figure');
  });

  it('works with no accounting at all, which is an older server', function () {
    const turns = mod.reconcileTurns(mod.groupTurns(twoTurns(), 'idle'), recorded);
    assert.strictEqual(turns[0].usage.costUsd, undefined);
    assert.strictEqual(mod.turnIndexRows(recorded, turns)[0].costUsd, undefined);
  });
});

describe('formatTurnMeta', function () {
  it('says nothing rather than zero for a turn that did nothing', function () {
    const messages = [msg('user', [text('hello')]), msg('assistant', [text('hi')])];
    const meta = mod.formatTurnMeta(mod.groupTurns(messages, 'idle')[0]);

    assert.strictEqual(meta.tools, '');
    assert.strictEqual(meta.reasoning, '');
    assert.strictEqual(meta.cost, '');
  });

  it('pluralises tools and rounds money to the cent once there is one', function () {
    const messages = [
      msg('user', [text('go')]),
      msg('assistant', [tool('completed')], { usage: { costUsd: 0.4212 } }),
    ];
    const meta = mod.formatTurnMeta(mod.groupTurns(messages, 'idle')[0]);

    assert.strictEqual(meta.tools, '1 tool');
    assert.strictEqual(meta.cost, '$0.42');
  });

  it('keeps four places below a cent, where rounding would say "nothing"', function () {
    // A turn that cost $0.0031 did not cost nothing, and a column of "$0.00"
    // beside real work is worse than no column at all.
    const messages = [
      msg('user', [text('go')]),
      msg('assistant', [tool('completed')], { usage: { costUsd: 0.0031 } }),
    ];
    assert.strictEqual(mod.formatTurnMeta(mod.groupTurns(messages, 'idle')[0]).cost, '$0.0031');
    assert.strictEqual(mod.formatTurnCost(0), '$0', 'a measured zero is still a figure');
  });
});
