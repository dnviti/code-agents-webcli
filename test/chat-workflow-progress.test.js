const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ClaudeChatAdapter } = require('../dist/server/chat/adapters/claude.js');
const { createTranscript, applyChatEvent } = require('../dist/shared/chat-reducer.js');
const { collectAgentActivity, summarizeWorkflow } = require('../dist/shared/agent-activity.js');

/**
 * Issue #117: what a workflow reports about itself reaches the transcript.
 *
 * Every assertion here is driven by test/fixtures/chat/claude-workflow.jsonl,
 * which is a recording of a real run — `.work/probes/workflow-probe.mjs` drove
 * the CLI with the chat adapter's own argv and wrote down every line it
 * printed. That matters more than usual for this feature: the shape of
 * `workflow_progress` was invisible to the app until it was captured, and a
 * hand-written example of it would have agreed with this code rather than with
 * the runtime. Two details in the recording would not have been guessed —
 * `workflow_progress` is missing from four of the ten progress reports, and the
 * run's name appears nowhere in the tool call that started it.
 *
 * The recorded run: two phases, `Collect` (three agents) and `Check` (two, one
 * of which fails on a model that does not exist).
 */

const FIXTURE = path.join(__dirname, 'fixtures', 'chat', 'claude-workflow.jsonl');

/**
 * A second recording, of a run that failed outright (#140).
 *
 * Captured the same way, by `.work/probes/workflow-failure-probe.mjs`: two
 * agents on a model that does not exist, and then a `throw` in the script
 * itself, so one run holds both "everything inside it broke" and "it broke".
 * The run it records reported `task_updated {status:"failed"}` — and its
 * launching tool call still reported success, which is the bug.
 */
const FAILED_FIXTURE = path.join(__dirname, 'fixtures', 'chat', 'claude-workflow-failed.jsonl');

function readFixture(file = FIXTURE) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Replay the recording through the adapter, stopping after `lines` of it. */
function replay(lines = Infinity, file = FIXTURE) {
  const events = [];
  const adapter = new ClaudeChatAdapter({
    sessionId: 'app-session-1',
    workingDir: '/tmp',
    command: 'claude',
    emit: (event) => events.push(event),
  });
  readFixture(file)
    .slice(0, lines === Infinity ? undefined : lines)
    .forEach((message) => adapter.handleMessage(message));
  return events;
}

function transcriptOf(events) {
  const state = createTranscript({});
  events.forEach((event, index) =>
    applyChatEvent(state, { ts: 1_000 + index, ...event, seq: index + 1 }),
  );
  return state;
}

/** The workflow's tool block, whichever message it ended up in. */
function workflowBlock(state) {
  for (const message of state.messages) {
    for (const block of message.blocks) {
      if (block.kind === 'tool' && block.name === 'Workflow') return block;
    }
  }
  return null;
}

describe('a workflow reports its phases and its agents (#117)', function () {
  describe('the adapter, against a recorded run', function () {
    it('forwards the phases and agents the run reports', function () {
      const emitted = replay().filter((event) => event.t === 'workflow_progress');

      assert.ok(emitted.length > 0, 'nothing at all was forwarded from workflow_progress');
      const last = emitted[emitted.length - 1];
      assert.deepStrictEqual(
        last.phases.map((phase) => [phase.index, phase.title]),
        [[1, 'Collect'], [2, 'Check']],
        'the phases the run declared did not arrive in order',
      );
      assert.deepStrictEqual(
        last.agents.map((agent) => agent.label),
        ['collect:1', 'collect:2', 'collect:3', 'check:ok', 'check:bad'],
        'the agents the run started did not arrive',
      );
    });

    it('says nothing at all when a report carries no structure', function () {
      // Four of the ten progress reports in the recording have no
      // `workflow_progress` key. Forwarded as an empty list they would empty
      // the panel every other event; this is the assertion that they are not.
      const raw = readFixture().filter(
        (line) => line.type === 'system' && line.subtype === 'task_progress',
      );
      const silent = raw.filter((line) => !('workflow_progress' in line));
      assert.ok(
        silent.length > 0,
        'the recording no longer contains a progress report without structure',
      );

      const emitted = replay().filter((event) => event.t === 'workflow_progress');
      assert.strictEqual(
        emitted.length,
        raw.length - silent.length,
        'a report carrying no structure was forwarded as though it carried some',
      );
    });

    it('carries an agent that failed, and what it failed with', function () {
      const emitted = replay().filter((event) => event.t === 'workflow_progress');
      const bad = emitted[emitted.length - 1].agents.find((agent) => agent.label === 'check:bad');

      assert.strictEqual(bad.state, 'failed', 'the failed agent is not reported as failed');
      assert.match(
        bad.error,
        /no-such-model-at-all/,
        'the failure the run reported was dropped on the way through',
      );
    });

    it('maps the run\'s own words for a state onto this app\'s', function () {
      // `start` is the runtime's word for both "queued" and "just spawned",
      // `progress` for working. Both appear in the recording.
      const seen = new Set();
      for (const event of replay()) {
        if (event.t !== 'workflow_progress') continue;
        for (const agent of event.agents) seen.add(agent.state);
      }
      assert.deepStrictEqual(
        [...seen].sort(),
        ['done', 'failed', 'queued', 'running'],
        'the recorded run went through states this adapter does not name',
      );
    });

    it('learns the run\'s name, which its own tool call never carries', function () {
      const state = transcriptOf(replay());
      const block = workflowBlock(state);

      assert.ok(block, 'the workflow call is not in the transcript');
      assert.strictEqual(
        block.agent.workflowName,
        'probe-workflow-progress',
        'the name the run gave itself never reached the transcript',
      );
      // The whole reason it has to come from the run: the call is an inline
      // script and names the workflow nowhere.
      assert.ok(
        !('name' in block.input) && !('scriptPath' in block.input),
        'the recorded call now carries a name of its own, so this proves nothing',
      );
    });
  });

  describe('the transcript, folding the reports together', function () {
    it('holds every phase and agent once, however often they were reported', function () {
      const block = workflowBlock(transcriptOf(replay()));

      assert.strictEqual(block.agent.workflow.phases.length, 2, 'phases were duplicated or lost');
      assert.strictEqual(block.agent.workflow.agents.length, 5, 'agents were duplicated or lost');
      assert.deepStrictEqual(
        block.agent.workflow.agents.map((agent) => agent.state),
        ['done', 'done', 'done', 'done', 'failed'],
        'the agents did not settle where the run left them',
      );
    });

    it('keeps what is known when a later report mentions nothing', function () {
      const events = replay();
      const state = transcriptOf(events);
      const block = workflowBlock(state);
      const before = block.agent.workflow.agents.length;

      // The recording's own silent report, replayed once more after the end.
      applyChatEvent(state, {
        t: 'agent_progress',
        seq: events.length + 1,
        ts: 1,
        parentToolId: block.toolId,
        patch: { activity: 'still going' },
      });

      assert.strictEqual(
        block.agent.workflow.agents.length,
        before,
        'a progress report with no structure emptied the structure',
      );
    });

    it('replaces a row rather than merging into it, so a retry is not still failed', function () {
      const events = replay();
      const state = transcriptOf(events);
      const block = workflowBlock(state);
      let seq = events.length + 1;

      // What a retry looks like: the same agent index, reported again without
      // the `error` its first attempt carried. Merged, the row would keep the
      // old failure and read as broken while its second try worked.
      applyChatEvent(state, {
        t: 'workflow_progress',
        seq: seq++,
        ts: 1,
        parentToolId: block.toolId,
        agents: [{ index: 5, label: 'check:bad', state: 'running', attempt: 2 }],
      });

      const retried = block.agent.workflow.agents.find((agent) => agent.index === 5);
      assert.strictEqual(retried.state, 'running', 'the retried agent is still marked failed');
      assert.strictEqual(retried.error, undefined, 'the first attempt\'s failure survived the retry');
      assert.strictEqual(retried.attempt, 2, 'the retry did not record which attempt it is');
      assert.strictEqual(
        block.agent.workflow.agents.length,
        5,
        'the retry was appended as a sixth agent instead of replacing the row',
      );
    });

    it('appends an agent the run had not mentioned before', function () {
      const events = replay();
      const state = transcriptOf(events);
      const block = workflowBlock(state);

      applyChatEvent(state, {
        t: 'workflow_progress',
        seq: events.length + 1,
        ts: 1,
        parentToolId: block.toolId,
        phases: [{ index: 3, title: 'Report' }],
        agents: [{ index: 6, label: 'report:1', state: 'queued', phaseIndex: 3 }],
      });

      assert.strictEqual(block.agent.workflow.phases.length, 3, 'a new phase was not added');
      assert.strictEqual(block.agent.workflow.agents.length, 6, 'a new agent was not added');
    });
  });

  describe('the summary the views are drawn from', function () {
    it('groups the recorded run into its phases, in order', function () {
      const summary = summarizeWorkflow(workflowBlock(transcriptOf(replay())).agent);

      assert.deepStrictEqual(
        summary.phases.map((view) => [view.phase.title, view.state, view.agents.length]),
        [['Collect', 'finished', 3], ['Check', 'finished', 2]],
        'the phases were not grouped the way the run ran them',
      );
      assert.deepStrictEqual(
        { total: summary.total, done: summary.done, failed: summary.failed },
        { total: 5, done: 4, failed: 1 },
        'the counts do not add up to the run that was recorded',
      );
      assert.strictEqual(summary.phases[1].failed, 1, 'the phase holding the failure does not say so');
    });

    it('says which phase a half-finished run is in', function () {
      // Replayed one event at a time until the recording reaches the moment
      // Collect had finished and Check had just started — the state the whole
      // view exists to describe, taken from the run rather than composed.
      const events = replay();
      const upto = [];
      for (const event of events) {
        upto.push(event);
        const summary = summarizeWorkflow(workflowBlock(transcriptOf(upto))?.agent);
        if (summary.phases.length !== 2) continue;
        if (summary.phases[0].state !== 'finished' || summary.phases[1].state !== 'running') continue;

        assert.strictEqual(
          summary.current.phase.title,
          'Check',
          'a run with an earlier phase done and a later one working named the wrong one as current',
        );
        assert.ok(summary.queued + summary.running > 0, 'the phase in flight has nothing in flight');
        assert.strictEqual(summary.done, 3, 'the finished phase lost the agents it finished');
        return;
      }
      assert.fail('the recording never had one phase finished while another worked');
    });

    it('names the phase furthest along when two are working at once', function () {
      // A pipeline keeps an earlier phase open while a later one starts, and
      // the run is further along than the earliest thing still in it.
      const summary = summarizeWorkflow({
        steps: [],
        workflow: {
          phases: [{ index: 1, title: 'Review' }, { index: 2, title: 'Verify' }],
          agents: [
            { index: 1, label: 'review:b', state: 'running', phaseIndex: 1 },
            { index: 2, label: 'verify:a', state: 'running', phaseIndex: 2 },
          ],
        },
      });

      assert.strictEqual(summary.current.phase.title, 'Verify');
    });

    it('shows a declared phase that has not started anything', function () {
      const summary = summarizeWorkflow({
        steps: [],
        workflow: {
          phases: [{ index: 1, title: 'Find' }, { index: 2, title: 'Verify' }],
          agents: [{ index: 1, label: 'find:1', state: 'running', phaseIndex: 1 }],
        },
      });

      assert.deepStrictEqual(
        summary.phases.map((view) => view.state),
        ['running', 'waiting'],
        'a phase the run has not reached is not shown as still to come',
      );
    });

    it('gives an agent a row even when its phase heading has not arrived', function () {
      const summary = summarizeWorkflow({
        steps: [],
        workflow: {
          phases: [],
          agents: [
            { index: 1, label: 'a', state: 'running', phaseIndex: 4, phaseTitle: 'Late' },
            { index: 2, label: 'b', state: 'running' },
          ],
        },
      });

      assert.deepStrictEqual(
        summary.phases.map((view) => [view.phase && view.phase.title, view.agents.length]),
        [['Late', 1], [null, 1]],
        'an agent was dropped because its phase was reported late or not at all',
      );
    });

    it('is empty for a delegation that is not a workflow at all', function () {
      assert.strictEqual(summarizeWorkflow({ steps: [] }).empty, true);
      assert.strictEqual(summarizeWorkflow(null).empty, true);
    });
  });

  describe('the agents list', function () {
    it('says how many agents the workflow holds', function () {
      const [entry] = collectAgentActivity(transcriptOf(replay()).messages);

      assert.strictEqual(entry.kind, 'workflow', 'the recorded call is not read as a workflow');
      assert.strictEqual(entry.agentCount, 5, 'the row does not know what the workflow holds');
      assert.strictEqual(entry.agentsRunning, 0, 'a finished run still has agents working');
      assert.strictEqual(entry.name, 'probe-workflow-progress', 'the row is not named after the run');
    });

    it('counts what is still going while the run is going', function () {
      const events = replay();
      // The first report of the run: three agents queued, none finished.
      const first = events.findIndex((event) => event.t === 'workflow_progress');
      const [entry] = collectAgentActivity(transcriptOf(events.slice(0, first + 1)).messages);

      assert.strictEqual(entry.agentCount, 3, 'the row does not count the agents that had started');
      assert.strictEqual(entry.agentsRunning, 3, 'agents that had not finished were not counted as going');
    });

    it('leaves a plain sub-agent without a count of things it does not contain', function () {
      const state = createTranscript({});
      applyChatEvent(state, { t: 'msg_start', seq: 1, ts: 1, id: 'm1', role: 'assistant', turnId: 't1' });
      applyChatEvent(state, {
        t: 'block_start',
        seq: 2,
        ts: 2,
        msgId: 'm1',
        index: 0,
        block: {
          kind: 'tool',
          toolId: 'a1',
          name: 'Agent',
          toolKind: 'task',
          status: 'running',
          input: { subagent_type: 'Explore', description: 'look around' },
        },
      });

      const [entry] = collectAgentActivity(state.messages);
      assert.strictEqual(entry.agentCount, undefined, 'a sub-agent was given a count of its contents');
      assert.strictEqual(entry.agentsRunning, undefined, 'a sub-agent was given a running count');
    });
  });
});

/**
 * Issue #140: a workflow that failed reads as failed, and says so in the chat.
 *
 * Driven by the two recordings together, because the bug is only visible in the
 * difference between them. Both runs end with the *same* launching tool result
 * — "Workflow launched in background", no error, four seconds before anything
 * happened — so nothing about the call that started them can tell them apart.
 * One went on to report `task_updated {status:"failed"}` and one did not, and
 * that is the only place the outcome is written down.
 *
 * The second recording is also the control the first one needs: a run that
 * *succeeded* with one of its five agents dead. Agents inside a workflow fail
 * by design — `parallel()` resolves a thrown agent to `null` rather than
 * rejecting — so that run must still read as done, or the fix has traded a
 * missed failure for an invented one.
 */
describe('a workflow that failed reads as failed (#140)', function () {
  const failedEvents = () => replay(Infinity, FAILED_FIXTURE);

  describe('the adapter, against a recorded failure', function () {
    it('announces the failure the run reported', function () {
      const announced = failedEvents().filter((event) => event.t === 'workflow_failed');

      assert.strictEqual(announced.length, 1, 'the run failing was announced once, or not at all');
      assert.strictEqual(
        announced[0].name,
        'probe-workflow-failure',
        'the failure does not name the run it belongs to',
      );
      assert.match(
        announced[0].reason || '',
        /forced workflow failure/,
        'the runtime’s own reason did not survive',
      );
      // The frames are dropped: what this becomes is a line in a conversation,
      // read on a phone. The whole thing stays on the run for the popup.
      assert.doesNotMatch(
        announced[0].reason || '',
        /\n\s+at /,
        'a stack trace was sent to the chat',
      );
    });

    it('keeps the whole error, frames and all, on the run itself', function () {
      const run = workflowBlock(transcriptOf(failedEvents())).agent;

      assert.match(
        run.error || '',
        /\n\s+at /,
        'the popup lost the frames the chat line does not want',
      );
    });

    it('announces it once, though the runtime says it twice', function () {
      // The capture carries the verdict on both `task_updated` (with the raw
      // error) and `task_notification` (with a sentence). One failure.
      const raw = readFixture(FAILED_FIXTURE);
      const said = raw.filter(
        (line) =>
          (line.subtype === 'task_updated' && line.patch && line.patch.status === 'failed')
          || (line.subtype === 'task_notification' && line.status === 'failed'),
      );

      assert.strictEqual(said.length, 2, 'the recording no longer reports the failure twice');
      assert.strictEqual(
        failedEvents().filter((event) => event.t === 'workflow_failed').length,
        1,
        'two reports of one failure became two failures',
      );
    });

    it('says nothing about a run that finished, whatever happened inside it', function () {
      assert.deepStrictEqual(
        replay().filter((event) => event.t === 'workflow_failed'),
        [],
        'a run that reported success was announced as failed',
      );
    });

    it('announces the error the run reported, not the sentence wrapped round it', function () {
      // Two texts describe this failure: `task_updated.patch.error` (the error)
      // and `task_notification.summary` ('Dynamic workflow "<the run's own
      // description>" failed: …'). Whichever lands first wins, and in the
      // capture that is the error. Pinned because /forced workflow failure/
      // matches both, so every other assertion here is blind to which arrived.
      const [announced] = failedEvents().filter((event) => event.t === 'workflow_failed');

      assert.doesNotMatch(
        announced.reason || '',
        /^Dynamic workflow/,
        'the runtime’s framing was announced instead of the error itself',
      );
      assert.match(announced.reason || '', /^Error: probe/);
    });

    it('counts a failure per workflow, not per session', function () {
      // The guard has to be keyed on the call that launched the run. A session
      // -wide "already announced" flag passes every single-run test there is.
      const events = [];
      const adapter = new ClaudeChatAdapter({
        sessionId: 'app-session-1',
        workingDir: '/tmp',
        command: 'claude',
        emit: (event) => events.push(event),
      });
      for (const [taskId, toolId] of [['k1', 'toolu_a'], ['k2', 'toolu_b']]) {
        adapter.handleMessage({
          type: 'system',
          subtype: 'task_started',
          task_id: taskId,
          tool_use_id: toolId,
          task_type: 'local_workflow',
          workflow_name: `run-${taskId}`,
        });
        adapter.handleMessage({
          type: 'system',
          subtype: 'task_updated',
          task_id: taskId,
          patch: { status: 'failed', error: `${taskId} broke` },
        });
      }

      assert.deepStrictEqual(
        events.filter((event) => event.t === 'workflow_failed').map((event) => event.parentToolId),
        ['toolu_a', 'toolu_b'],
        'the second workflow’s failure was swallowed as a duplicate of the first',
      );
    });

    it('leaves an ordinary delegation alone', function () {
      // A plain sub-agent reports on the same channel and can fail the same
      // way. How it reports is #140's explicit non-goal, so nothing here may
      // reach it — the guard is `task_type`, said once at `task_started`.
      const events = [];
      const adapter = new ClaudeChatAdapter({
        sessionId: 'app-session-1',
        workingDir: '/tmp',
        command: 'claude',
        emit: (event) => events.push(event),
      });
      adapter.handleMessage({
        type: 'system',
        subtype: 'task_started',
        task_id: 'k1',
        tool_use_id: 'toolu_sub',
        task_type: 'local_agent',
        prompt: 'look around',
      });
      adapter.handleMessage({
        type: 'system',
        subtype: 'task_updated',
        task_id: 'k1',
        patch: { status: 'failed', error: 'the sub-agent broke' },
      });

      assert.deepStrictEqual(
        events.filter((event) => event.t === 'workflow_failed'),
        [],
        'a sub-agent failing was announced as a workflow failure',
      );
      const progress = events.filter((event) => event.t === 'agent_progress');
      assert.strictEqual(
        progress[progress.length - 1].patch.status,
        'failed',
        'the sub-agent’s own run no longer records that it failed',
      );
    });

    it('leaves an ordinary delegation alone on the notification channel too', function () {
      // The other half of the new routing. `task_notification` carries a status
      // and a `tool_use_id` and says nothing about what kind of task it was, so
      // the guard is the only thing keeping a sub-agent's failure out.
      const events = [];
      const adapter = new ClaudeChatAdapter({
        sessionId: 'app-session-1',
        workingDir: '/tmp',
        command: 'claude',
        emit: (event) => events.push(event),
      });
      adapter.handleMessage({
        type: 'system',
        subtype: 'task_started',
        task_id: 'k1',
        tool_use_id: 'toolu_sub',
        task_type: 'local_agent',
      });
      adapter.handleMessage({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'k1',
        tool_use_id: 'toolu_sub',
        status: 'failed',
        summary: 'Agent "Explore" failed: it broke',
      });

      assert.deepStrictEqual(
        events.filter((event) => event.t === 'workflow_failed'),
        [],
        'a sub-agent’s notification was announced as a workflow failure',
      );
    });
  });

  describe('the transcript', function () {
    it('stops the launching call claiming success', function () {
      const block = workflowBlock(transcriptOf(failedEvents()));

      assert.strictEqual(block.status, 'failed', 'the failed run’s tool call still reads as done');
      assert.match(
        block.error || '',
        /forced workflow failure/,
        'the tool call does not carry the reason it failed',
      );
      assert.match(
        block.output || '',
        /launched in background/,
        'the launch acknowledgement was overwritten; the popup tells them apart',
      );
    });

    it('tells the conversation, in a message of its own', function () {
      const state = transcriptOf(failedEvents());
      const notices = state.messages.filter(
        (message) =>
          message.role === 'system' && message.blocks.some((block) => block.kind === 'error'),
      );

      assert.strictEqual(notices.length, 1, 'the chat was not told the workflow failed');
      const [notice] = notices;
      assert.match(
        notice.blocks[0].text,
        /Workflow "probe-workflow-failure" failed/,
        'the notice does not say which workflow failed',
      );
      assert.match(
        notice.blocks[0].text,
        /forced workflow failure/,
        'the notice does not say why it failed',
      );
      // Filed under a real turn rather than one of its own: only the newest
      // turn is open, so a synthetic turn would fold itself shut behind the
      // next thing anybody said.
      assert.ok(
        state.messages.some((message) => message !== notice && message.turnId === notice.turnId),
        'the failure was filed under a turn of its own, which folds itself shut',
      );
    });

    it('lands even when no message is streaming', function () {
      // The case the issue is actually about: a long background workflow that
      // fails after its turn is over. Nothing is open to append to.
      const state = createTranscript({});
      applyChatEvent(state, { t: 'msg_start', seq: 1, ts: 1, id: 'm1', role: 'assistant', turnId: 't1' });
      applyChatEvent(state, {
        t: 'block_start',
        seq: 2,
        ts: 2,
        msgId: 'm1',
        index: 0,
        block: { kind: 'tool', toolId: 'w1', name: 'Workflow', toolKind: 'task', status: 'completed' },
      });
      applyChatEvent(state, { t: 'msg_end', seq: 3, ts: 3, msgId: 'm1' });
      applyChatEvent(state, { t: 'turn_end', seq: 4, ts: 4, turnId: 't1', stopReason: 'end_turn' });
      applyChatEvent(state, {
        t: 'workflow_failed',
        seq: 5,
        ts: 5,
        parentToolId: 'w1',
        name: 'nightly-audit',
        reason: 'usage limit reached',
      });

      const last = state.messages[state.messages.length - 1];
      assert.strictEqual(last.role, 'system', 'nothing was added to the transcript');
      assert.strictEqual(
        last.blocks[0].text,
        'Workflow "nightly-audit" failed: usage limit reached',
        'the failure reason did not reach the conversation',
      );
      // Under the turn that has ended, which is the one still open on screen —
      // a turn of its own would fold itself shut.
      assert.strictEqual(
        last.turnId,
        't1',
        'the failure was not filed under the last turn, so nothing shows it',
      );
      assert.strictEqual(
        workflowBlock(state).status,
        'failed',
        'the tool call was left reading as done',
      );
    });
  });

  describe('the Agents list', function () {
    it('shows a failed run as failed', function () {
      const [entry] = collectAgentActivity(transcriptOf(failedEvents()).messages);

      assert.strictEqual(entry.status, 'failed', 'the row still reads done');
      assert.strictEqual(entry.running, false, 'a finished run is still counted as work in flight');
      assert.strictEqual(entry.agentsFailed, 2, 'the row does not say how many agents failed');
    });

    it('still shows a run that finished as done, and counts what died inside it', function () {
      const [entry] = collectAgentActivity(transcriptOf(replay()).messages);

      assert.strictEqual(entry.status, 'completed', 'a run that succeeded was marked failed');
      assert.strictEqual(entry.agentsFailed, 1, 'the agent that failed inside it was not counted');
    });

    it('puts the reason on the row, not only in the popup', function () {
      const [entry] = collectAgentActivity(transcriptOf(failedEvents()).messages);

      assert.match(
        entry.error || '',
        /forced workflow failure/,
        'the row knows it failed and not why, which is half an answer',
      );
    });

    it('un-fails a row when the run retries the agent that died', function () {
      // The runtime replaces an agent's whole entry on a retry rather than
      // merging into it, so a second attempt clears the first one's error. The
      // count has to follow it back down or a run that recovered stays red.
      const events = failedEvents();
      const state = transcriptOf(events);
      const parentToolId = events.find((event) => event.t === 'workflow_progress').parentToolId;
      applyChatEvent(state, {
        t: 'workflow_progress',
        seq: 9_000,
        ts: 9_000,
        parentToolId,
        phases: [],
        agents: [
          { index: 1, label: 'fail:a', state: 'running', phaseIndex: 1, attempt: 2 },
          { index: 2, label: 'fail:b', state: 'done', phaseIndex: 1, attempt: 2 },
        ],
      });

      const [entry] = collectAgentActivity(state.messages);
      assert.strictEqual(entry.agentsFailed, 0, 'a retried agent is still counted as failed');
      assert.strictEqual(entry.agentsRunning, 1, 'the retry is not counted as work in flight');
    });

    it('leaves a plain sub-agent without a failure count', function () {
      const state = createTranscript({});
      applyChatEvent(state, { t: 'msg_start', seq: 1, ts: 1, id: 'm1', role: 'assistant', turnId: 't1' });
      applyChatEvent(state, {
        t: 'block_start',
        seq: 2,
        ts: 2,
        msgId: 'm1',
        index: 0,
        block: {
          kind: 'tool',
          toolId: 'a1',
          name: 'Agent',
          toolKind: 'task',
          status: 'failed',
          input: { subagent_type: 'Explore' },
        },
      });

      const [entry] = collectAgentActivity(state.messages);
      assert.strictEqual(entry.agentsFailed, undefined, 'a sub-agent was given a count of failures');
    });
  });

  describe('the awkward arrivals', function () {
    it('holds the failure for a launching call the snapshot no longer carries', function () {
      // A snapshot replays only the tail of the log, and a workflow that runs
      // for half an hour outlives its own tool call's place in that window.
      const state = createTranscript({});
      applyChatEvent(state, {
        t: 'workflow_failed',
        seq: 1,
        ts: 1,
        parentToolId: 'w-late',
        name: 'nightly-audit',
        reason: 'usage limit reached',
      });
      applyChatEvent(state, { t: 'msg_start', seq: 2, ts: 2, id: 'm1', role: 'assistant', turnId: 't1' });
      applyChatEvent(state, {
        t: 'block_start',
        seq: 3,
        ts: 3,
        msgId: 'm1',
        index: 0,
        block: { kind: 'tool', toolId: 'w-late', name: 'Workflow', toolKind: 'task', status: 'completed' },
      });

      assert.strictEqual(
        workflowBlock(state).status,
        'failed',
        'the failure was dropped because its tool call had not arrived yet',
      );
    });

    it('does not swallow the errors that come after it', function () {
      // The failure's message is pushed onto the end of the transcript while a
      // reply is still arriving, so it becomes the last message without being
      // the open one. An `error` that asked only "is the last message
      // streaming?" was dropped for the rest of the turn.
      const state = createTranscript({});
      applyChatEvent(state, { t: 'msg_start', seq: 1, ts: 1, id: 'm1', role: 'assistant', turnId: 't1' });
      applyChatEvent(state, {
        t: 'block_start',
        seq: 2,
        ts: 2,
        msgId: 'm1',
        index: 0,
        block: { kind: 'tool', toolId: 'w1', name: 'Workflow', toolKind: 'task', status: 'completed' },
      });
      applyChatEvent(state, {
        t: 'workflow_failed',
        seq: 3,
        ts: 3,
        parentToolId: 'w1',
        name: 'audit',
        reason: 'boom',
      });
      applyChatEvent(state, {
        t: 'error',
        seq: 4,
        ts: 4,
        message: 'could not read /etc/hosts',
        fatal: false,
      });

      const reply = state.messages.find((message) => message.id === 'm1');
      assert.ok(
        reply.blocks.some(
          (block) => block.kind === 'error' && block.text.includes('/etc/hosts'),
        ),
        'an error after the failure never reached the transcript',
      );
    });

    it('survives a reconnect redelivering the same events', function () {
      // A rejoining browser is handed a snapshot and then the tail, and the two
      // legitimately overlap.
      const events = failedEvents().map((event, index) => ({
        ts: 1_000 + index,
        ...event,
        seq: index + 1,
      }));
      const state = createTranscript({});
      events.forEach((event) => applyChatEvent(state, event));
      const noticesFirst = state.messages.filter((message) => message.role === 'system').length;
      events.forEach((event) => applyChatEvent(state, event));

      assert.strictEqual(noticesFirst, 1, 'the failure was not announced at all');
      assert.strictEqual(
        state.messages.filter((message) => message.role === 'system').length,
        1,
        'a redelivered failure was announced twice',
      );
    });
  });

  describe('the phases inside it', function () {
    it('marks a phase nothing came out of as failed', function () {
      const summary = summarizeWorkflow(workflowBlock(transcriptOf(failedEvents())).agent);

      assert.deepStrictEqual(
        summary.phases.map((view) => [view.phase && view.phase.title, view.state, view.failed]),
        [['Fail', 'failed', 2]],
        'a phase whose every agent failed did not read as failed',
      );
    });

    it('leaves a phase that lost one of two as finished', function () {
      const summary = summarizeWorkflow(workflowBlock(transcriptOf(replay())).agent);

      assert.deepStrictEqual(
        summary.phases.map((view) => [view.phase && view.phase.title, view.state, view.failed]),
        [['Collect', 'finished', 0], ['Check', 'finished', 1]],
        'a phase that produced a result was marked failed for losing an agent',
      );
    });
  });
});
