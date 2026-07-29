const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { applyChatEvent, createTranscript } = require('../dist/shared/chat-reducer.js');
const { looksLikeAskCall } = require('../dist/shared/chat-events.js');
const {
  blockDraws,
  drawsQuestion,
  foldRows,
  hasVisibleContent,
} = require('../dist/shared/chat-visibility.js');

/**
 * Issue #132: a row appears only when there is something to read in it.
 *
 * #46 established the rule — a step that produced only tool activity and no
 * written reply gets no row of its own, its work is counted on the next reply
 * that does say something, and the detail stays on the trace. What it missed is
 * that it decided from the *kind* of a step's blocks rather than from whether
 * anything would actually appear: a `text` block meant "this one spoke", even
 * when the text was a single space.
 *
 * Oh My Pi sends exactly that on almost every step. In the recording sliced
 * into `omp-empty-rows.jsonl` — the maintainer's own session, the one in which
 * the agent filed issue #129 — five consecutive steps each carry a blank reply
 * beside their tool call, and each of them drew a bordered strip holding a model
 * name, a clock and a work counter with no sentence anywhere in it. The full
 * conversation is 29 rows, 22 of them empty.
 *
 * Claude has a second trigger, in `claude-fake-ask.jsonl`: a `Bash` call that
 * greps for the string `ask_user_question` matches the loose test used to spot
 * a question the agent asked, gets promoted out of the trace into the
 * conversation, and then draws nothing — there is no question in it to draw.
 *
 * Both fixtures are contiguous selections of real recorded conversations, taken
 * message by message with nothing rewritten.
 */

function loadFixture(name) {
  return fs
    .readFileSync(path.join(__dirname, 'fixtures', 'chat', name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function replay(name) {
  const state = createTranscript({});
  for (const event of loadFixture(name)) applyChatEvent(state, event);
  return state;
}

describe('a row is drawn only when it would say something (#132)', function () {
  describe('a real Oh My Pi conversation', function () {
    let state;
    let rows;

    beforeEach(function () {
      state = replay('omp-empty-rows.jsonl');
      rows = foldRows(state.messages);
    });

    it('draws no row for a step whose whole reply was a space', function () {
      const empty = rows.filter(
        (row) => row.message.role !== 'user' && !row.message.blocks.some(blockDraws),
      );
      assert.deepStrictEqual(
        empty.map((row) => row.message.id),
        [],
        'every row in the conversation must have something readable in it',
      );
    });

    it('leaves the conversation with the reply that actually spoke', function () {
      // Six assistant steps in this slice; one of them wrote a sentence.
      const assistants = state.messages.filter((message) => message.role === 'assistant');
      const drawn = rows.filter((row) => row.message.role === 'assistant');
      assert.strictEqual(assistants.length, 6, 'the recording holds six assistant steps');
      assert.strictEqual(drawn.length, 1, 'exactly one of them said anything');
      assert.ok(
        drawn[0].message.blocks.some(
          (block) => block.kind === 'text' && block.text.includes('Aperta la issue'),
        ),
        'and it is the one that reported what it had done',
      );
    });

    it('hands the whole folded stretch to the reply that finally speaks, oldest first', function () {
      const drawn = rows.filter((row) => row.message.role === 'assistant')[0];
      const folded = state.messages
        .filter((message) => message.role === 'assistant' && !hasVisibleContent(message))
        .map((message) => message.id);
      assert.deepStrictEqual(
        drawn.carriedIds,
        folded,
        'the counter and the trace entry point belong to the reply, not to an empty strip',
      );
      assert.strictEqual(
        drawn.carriedIds[0],
        folded[0],
        'and the trace opens at the earliest of them, in the order they happened',
      );
    });
  });

  describe('a real Claude conversation', function () {
    it('reads a command that merely mentions the question tool as a command', function () {
      const state = replay('claude-fake-ask.jsonl');
      const suspect = state.messages.find((message) =>
        message.blocks.some(
          (block) => block.kind === 'tool' && looksLikeAskCall(block.name, block.input),
        ),
      );
      assert.ok(suspect, 'the recording should contain the grep that started this');

      const block = suspect.blocks.find(
        (candidate) => candidate.kind === 'tool' && looksLikeAskCall(candidate.name, candidate.input),
      );
      // The split is deliberate and both halves are pinned here. The loose test
      // stays loose because the session needs it that way — it pairs a live
      // question with a call whose arguments have not finished streaming (#42).
      assert.strictEqual(looksLikeAskCall(block.name, block.input), true, 'it still looks like one');
      assert.strictEqual(drawsQuestion(block), false, 'but there is no question in it to draw');
      assert.strictEqual(
        hasVisibleContent(suspect),
        false,
        'so the step it is in gets no row of its own',
      );
      assert.deepStrictEqual(
        foldRows(state.messages).map((row) => row.message.role),
        ['user', 'assistant'],
        'the conversation is the ask and the answer, with no blank card between them',
      );
    });
  });

  describe('block by block', function () {
    const ASK = {
      kind: 'tool',
      toolId: 't1',
      name: 'mcp__ccweb__ask_user_question',
      toolKind: 'task',
      status: 'completed',
      input: { question: 'Which one?', options: [{ optionId: 'a', label: 'A' }] },
    };
    const cases = [
      ['a reply with words in it', { kind: 'text', text: 'hi' }, true],
      ['a reply that is only spaces', { kind: 'text', text: '   ' }, false],
      ['a reply that is only newlines', { kind: 'text', text: '\n\n' }, false],
      ['reasoning, which lives on the trace', { kind: 'thinking', text: 'a long thought' }, false],
      ['an ordinary tool call', { kind: 'tool', toolId: 't', name: 'Bash', toolKind: 'execute', status: 'completed', input: {} }, false],
      ['a command that merely names the question tool', { kind: 'tool', toolId: 't', name: 'Bash', toolKind: 'execute', status: 'completed', input: { command: 'grep -r ask_user_question .' } }, false],
      ['a question the agent really asked', ASK, true],
      ['a plan with nothing in it', { kind: 'plan', items: [] }, false],
      ['a plan whose only step is blank', { kind: 'plan', items: [{ text: '  ', status: 'pending' }] }, false],
      ['a plan with a step in it', { kind: 'plan', items: [{ text: 'do the thing', status: 'pending' }] }, true],
      ['an image', { kind: 'image', mime: 'image/png', url: '/x.png' }, true],
      ['an error', { kind: 'error', text: 'it broke' }, true],
      ['a notice', { kind: 'notice', text: 'the workflow failed' }, true],
      ['a notice with nothing in it', { kind: 'notice', text: ' ' }, false],
    ];

    for (const [what, block, expected] of cases) {
      it(`${expected ? 'draws' : 'does not draw'} ${what}`, function () {
        assert.strictEqual(blockDraws(block), expected);
      });
    }
  });

  describe('the caret', function () {
    const message = (blocks, extra) =>
      Object.assign({ id: 'm1', seq: 1, turnId: 't1', role: 'assistant', ts: 1, blocks }, extra);

    it('keeps a row for a reply that has opened and written nothing yet', function () {
      // Claude and pi both open an empty text block before the first delta, so
      // a pure paint test would make a live answer blink out of existence for
      // that window and back in a moment later.
      assert.strictEqual(hasVisibleContent(message([], { streaming: true })), true);
      assert.strictEqual(
        hasVisibleContent(message([{ kind: 'text', text: '' }], { streaming: true })),
        true,
      );
    });

    it('does not extend that to a step that is already doing work', function () {
      // Otherwise every Oh My Pi step gets its empty row back for as long as it
      // runs, which is the whole defect, merely narrowed to the live case.
      const working = message(
        [
          { kind: 'thinking', text: 'considering' },
          { kind: 'text', text: ' ' },
          { kind: 'tool', toolId: 't', name: 'Bash', toolKind: 'execute', status: 'running', input: {} },
        ],
        { streaming: true },
      );
      assert.strictEqual(hasVisibleContent(working), false);
    });

    it('never folds away what the user typed', function () {
      const asked = message([{ kind: 'text', text: '   ' }], { role: 'user' });
      assert.strictEqual(hasVisibleContent(asked), true);
    });
  });

  describe('folding', function () {
    const step = (id, blocks) => ({ id, seq: 1, turnId: 't1', role: 'assistant', ts: 1, blocks });
    const blank = (id) => step(id, [{ kind: 'text', text: ' ' }, { kind: 'tool', toolId: id, name: 'Bash', toolKind: 'execute', status: 'completed', input: {} }]);

    it('carries folded steps across a rule to the next reply that can hold them', function () {
      // A rule has no action row to put a counter in, so anything handed to it
      // would be dropped and its tool calls would leave the transcript (#140).
      const rows = foldRows([
        blank('s1'),
        { id: 'r1', seq: 2, turnId: 't1', role: 'system', ts: 2, blocks: [{ kind: 'notice', text: 'the workflow failed' }] },
        blank('s2'),
        step('a1', [{ kind: 'text', text: 'done' }]),
      ]);
      assert.deepStrictEqual(rows.map((row) => row.message.id), ['r1', 'a1']);
      assert.deepStrictEqual(rows[0].carriedIds, [], 'a rule speaks for nothing but itself');
      assert.deepStrictEqual(rows[1].carriedIds, ['s1', 's2'], 'both stretches reach the reply');
    });

    it('drops silent steps with no reply after them rather than inventing a row', function () {
      const rows = foldRows([blank('s1'), blank('s2')]);
      assert.deepStrictEqual(rows, [], 'the turn strip still counts them and the rail still holds them');
    });
  });
});
