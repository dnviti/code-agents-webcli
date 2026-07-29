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

function readFixture() {
  return fs
    .readFileSync(FIXTURE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Replay the recording through the adapter, stopping after `lines` of it. */
function replay(lines = Infinity) {
  const events = [];
  const adapter = new ClaudeChatAdapter({
    sessionId: 'app-session-1',
    workingDir: '/tmp',
    command: 'claude',
    emit: (event) => events.push(event),
  });
  readFixture()
    .slice(0, lines === Infinity ? undefined : lines)
    .forEach((message) => adapter.handleMessage(message));
  return events;
}

function transcriptOf(events) {
  const state = createTranscript({});
  events.forEach((event, index) => applyChatEvent(state, { ...event, seq: index + 1 }));
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
