const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { AcpChatAdapter } = require('../dist/server/chat/adapters/acp.js');
const { ClaudeChatAdapter } = require('../dist/server/chat/adapters/claude.js');
const { applyChatEvent, createTranscript } = require('../dist/shared/chat-reducer.js');
const { collectAgentActivity, countRunning } = require('../dist/shared/agent-activity.js');
const { feed, repoint, wire } = require('./acp-fixture-harness.js');

/**
 * Issue #139: nothing reads as running once nothing can report on it.
 *
 * After a chat turn finished and the agent had delivered its answer, a
 * delegation started during that turn could still be shown as running — a
 * spinning badge on its row, a non-zero count on the Agents panel, and a trace
 * showing no waits and no activity at all. The conversation said the work was
 * over and the panel said it was not, with nothing on screen to say which.
 *
 * Nothing in the pipeline ever closed a tool block on a turn-level event. The
 * `turn_end` case stamps the outcome onto every message in the turn and never
 * looks inside their blocks; the `state` case, for a runtime that died, does
 * not either. And the runtimes routinely stop reporting on a call before the
 * turn is over: an ACP agent that backgrounds a task sends no terminal update
 * at all, and Claude ends a turn with an unresolved block whenever a tool
 * errors during execution. So the block sat non-terminal for ever while the
 * turn around it was marked done.
 *
 * `unknown` is the word for it. Nobody stopped the call, which is what
 * `canceled` says, and nothing is known to have broken, which is what `failed`
 * says — the runtime went quiet and its turn is over. A spinner that will never
 * stop is a worse answer than an honest one.
 *
 * Driven off the real recordings, truncated at real points: the truncations
 * reproduce the shapes found in recorded conversations on disk, where a block
 * was left open with no report to close it.
 *
 * One of these tests is a guard rather than a control and says so: a background
 * run that is still reporting about *itself* outlives its turn by design and
 * must be left alone.
 */

const FIXTURES = path.join(__dirname, 'fixtures', 'chat');

function readFixture(name) {
  return fs
    .readFileSync(path.join(FIXTURES, name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function fold(events) {
  const state = createTranscript({});
  events.forEach((event, index) => applyChatEvent(state, { ts: 1_000 + index, ...event, seq: index + 1 }));
  return state;
}

function toolBlocks(state) {
  const found = [];
  for (const message of state.messages) {
    for (const block of message.blocks || []) {
      if (block.kind === 'tool') found.push(block);
    }
  }
  return found;
}

/** The claude recording, with chosen message shapes left out of the replay. */
function claudeEvents(drop) {
  const events = [];
  const adapter = new ClaudeChatAdapter({
    sessionId: 'stale-check',
    workingDir: '/tmp',
    command: 'claude',
    emit: (event) => events.push(event),
  });
  readFixture('claude-workflow.jsonl')
    .filter((message) => !drop(message))
    .forEach((message) => adapter.handleMessage(message));
  return events;
}

describe('a delegation nothing will report on again (#139)', function () {
  it('stops reading as running when the turn it belonged to ends', function () {
    // The shape found on disk: the call was opened, the runtime never said
    // another word about it, and the turn ended anyway. Reproduced by dropping
    // the tool result that closes it *and* every report the run made about
    // itself — which is exactly what a runtime going quiet looks like.
    const events = claudeEvents(
      (message) => message.type === 'user' || message.type === 'system',
    );
    const state = fold(events);

    const open = toolBlocks(state).filter((block) => block.name === 'Workflow');
    assert.ok(open.length > 0, 'the recording should contain a delegation');
    assert.ok(
      open.every((block) => block.status === 'unknown'),
      `a call nothing will report on again is not still running: ${JSON.stringify(open.map((b) => b.status))}`,
    );

    const activity = collectAgentActivity(state.messages);
    assert.ok(
      activity.every((entry) => !entry.running),
      'and the Agents panel must not keep it in the running group',
    );
    assert.strictEqual(countRunning(activity), 0, 'nor in the running count');
  });

  it('is true of an ACP agent that simply never sends a terminal update', async function () {
    // Not a Claude-specific fix. Oh My Pi backgrounds a task and never sends a
    // terminal `tool_call_update` for it; the turn's own `stopReason` still
    // arrives. Reproduced by dropping that one update from the real capture.
    const events = [];
    const adapter = new AcpChatAdapter({
      sessionId: 'stale-check',
      workingDir: '/tmp',
      command: '/nonexistent',
      runtime: 'omp',
      acpArgs: ['acp'],
      emit: (event) => events.push(event),
    });
    const sent = [];
    wire(adapter, sent);
    const lines = readFixture('acp-omp.jsonl');
    const done = adapter.handshake();
    await feed(adapter, lines.slice(0, 2), sent);
    await done;
    const sending = adapter.send({ text: 'what is the magic word' });
    for (const line of lines.slice(2)) {
      const update = line?.params?.update;
      const backgrounded =
        update?.sessionUpdate === 'tool_call_update'
        && (update.status === 'completed' || update.status === 'failed');
      if (backgrounded) continue;
      adapter.handleMessage(repoint(sent, line));
      await flush();
    }
    await sending;

    const state = fold(events);
    const open = toolBlocks(state);
    assert.ok(open.length > 0, 'the recording should contain a tool call');
    assert.ok(
      open.every((block) => block.status === 'unknown'),
      `an agent that went quiet leaves no spinner behind: ${JSON.stringify(open.map((b) => b.status))}`,
    );
  });

  it('leaves alone a run that is still reporting about itself', function () {
    // GUARD, not a control — this passes before the fix as well as after, and
    // it is the interlock that keeps a background workflow landable. A run
    // whose own report says it is running outlives the turn that started it by
    // design, and settling it here would be the opposite defect.
    const events = claudeEvents((message) => message.type === 'user');
    const upToFirstTurnEnd = [];
    for (const event of events) {
      upToFirstTurnEnd.push(event);
      if (event.t === 'turn_end') break;
    }
    const state = fold(upToFirstTurnEnd);
    const workflow = toolBlocks(state).find((block) => block.name === 'Workflow');
    assert.ok(workflow, 'the recording should contain the workflow');
    assert.strictEqual(workflow.agent?.status, 'running', 'the run says it is still going');
    assert.notStrictEqual(
      workflow.status,
      'unknown',
      'a run that is still reporting has not gone quiet, and the turn ending is not its ending',
    );
  });

  it('still catches up when the ending arrives after the turn has gone', function () {
    const events = claudeEvents(
      (message) => message.type === 'user' || message.type === 'system',
    );
    const state = fold(events);
    const workflow = toolBlocks(state).find((block) => block.name === 'Workflow');
    assert.strictEqual(workflow.status, 'unknown', 'it settled as unknown first');

    applyChatEvent(state, {
      t: 'tool', seq: 9_000, ts: 9_000, toolId: workflow.toolId,
      patch: { status: 'completed', output: 'it finished after all' },
    });
    assert.strictEqual(
      workflow.status,
      'completed',
      'a real ending that turns up late is still the answer',
    );
  });

  it('does not let a late progress report restart a spinner nothing will stop', function () {
    const events = claudeEvents(
      (message) => message.type === 'user' || message.type === 'system',
    );
    const state = fold(events);
    const workflow = toolBlocks(state).find((block) => block.name === 'Workflow');
    assert.strictEqual(workflow.status, 'unknown');

    applyChatEvent(state, {
      t: 'tool', seq: 9_001, ts: 9_001, toolId: workflow.toolId,
      patch: { status: 'running' },
    });
    assert.strictEqual(
      workflow.status,
      'unknown',
      'a runtime that has already gone quiet once does not get to start the spinner again',
    );
  });

  it('settles everything open when the runtime is gone, reporting or not', function () {
    // Nothing can report once the child is dead, so the exemption above does
    // not apply. This is also the answer to "the app restarted and the run can
    // no longer be observed".
    const events = claudeEvents((message) => message.type === 'user');
    const upToFirstTurnEnd = [];
    for (const event of events) {
      upToFirstTurnEnd.push(event);
      if (event.t === 'turn_end') break;
    }
    const state = fold(upToFirstTurnEnd);
    const workflow = toolBlocks(state).find((block) => block.name === 'Workflow');
    assert.notStrictEqual(workflow.status, 'unknown', 'still exempt while the runtime lives');

    // The turn is closed by now, so the exit has to reconcile the turn it just
    // closed — which is what the reducer does with the id it held.
    const reopened = fold([
      ...upToFirstTurnEnd.filter((event) => event.t !== 'turn_end'),
      { t: 'state', state: 'exited' },
    ]);
    const orphan = toolBlocks(reopened).find((block) => block.name === 'Workflow');
    // A workflow launch is the one call #116 settled first: a run the app can
    // no longer watch is interrupted — `canceled`, saying in its own words
    // that it is our observation that ended — rather than merely quiet. Either
    // way it is terminal: a run left behind by a dead runtime does not sit as
    // running indefinitely.
    assert.strictEqual(
      orphan.status,
      'canceled',
      'a run left behind by a dead runtime does not sit as running indefinitely',
    );
    assert.match(
      orphan.error,
      /stopped watching/i,
      'and it says it is our observation that ended, not necessarily the run',
    );
  });

  it('does not touch a turn that was only interrupted to redirect it', function () {
    // A `turn_end` marked stale is the runtime letting go of the half it was
    // told to abandon; the turn is running again on the correction. Settling
    // its calls there would close work that is still going.
    const events = claudeEvents((message) => message.type === 'user' || message.type === 'system');
    const upTo = [];
    for (const event of events) {
      if (event.t === 'turn_end') break;
      upTo.push(event);
    }
    const state = fold([...upTo, { t: 'turn_end', turnId: 't1', stale: true }]);
    const workflow = toolBlocks(state).find((block) => block.name === 'Workflow');
    assert.notStrictEqual(workflow.status, 'unknown', 'an interrupted turn has not ended');
  });
});
