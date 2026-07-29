const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ClaudeChatAdapter } = require('../dist/server/chat/adapters/claude.js');

/**
 * Issue #45: a running workflow's popup is a window on the run, not a receipt.
 *
 * The complaint was that the body said "Waiting for the first stage to report
 * in…" from the moment it opened until the moment the run ended — minutes, or
 * tens of them — because the only thing it read was `block.output`, which the
 * adapter writes once, with the tool_result that finishes the call. The
 * runtime reports the whole way through on `task_started`/`task_progress`, and
 * the reducer has always folded those onto the same block as `block.agent`.
 *
 * Driven through the real `ChatTranscript` rather than a hand-made block, so
 * the claim is "given the events the adapter emits, this is what someone sees"
 * rather than "given the object I imagined, this is what my component does".
 * The popup is .tsx and only ever reaches the browser through esbuild, so it
 * is bundled for Node here the way test/chat-view.test.js bundles ChatView.
 */

const ROOT = path.join(__dirname, '..');
const CHAT_DIR = path.join(ROOT, 'src', 'client', 'shell', 'chat');

const SCRIPT_PATH = '/home/dev/.claude/workflows/review-changes.md';

describe('the workflow popup, while the workflow is still running', function () {
  let bundle;
  let mod;

  before(function () {
    this.timeout(60000);

    const contents = [
      `export { renderToStaticMarkup } from 'react-dom/server';`,
      `export * as React from 'react';`,
      `export { WorkflowPopup } from ${JSON.stringify(path.join(CHAT_DIR, 'WorkflowPopup'))};`,
      `export { ChatTranscript } from ${JSON.stringify(path.join(ROOT, 'src', 'client', 'chat', 'transcript'))};`,
      `export { RELAY_ICONS } from ${JSON.stringify(path.join(ROOT, 'src', 'client', 'ui', 'relay', 'Icon'))};`,
    ].join('\n');

    bundle = path.join(os.tmpdir(), `workflow-popup-${process.pid}.js`);
    // stdin rather than a temp entry file: an entry written to /tmp resolves
    // its bare imports relative to /tmp, where there is no node_modules.
    require('esbuild').buildSync({
      stdin: { contents, resolveDir: ROOT, loader: 'tsx', sourcefile: 'workflow-popup.tsx' },
      bundle: true,
      outfile: bundle,
      format: 'cjs',
      platform: 'node',
      jsx: 'automatic',
      target: ['node20'],
      logLevel: 'silent',
    });

    mod = require(bundle);
  });

  after(function () {
    if (bundle) fs.rmSync(bundle, { force: true });
  });

  /** One workflow call, plus whatever the runtime went on to say about it. */
  function paint(events, input = { scriptPath: SCRIPT_PATH }) {
    const { React, renderToStaticMarkup, ChatTranscript, WorkflowPopup } = mod;
    const transcript = new ChatTranscript();
    transcript.apply({ t: 'msg_start', seq: 1, ts: 1, id: 'm1', role: 'assistant', turnId: 't1' });
    transcript.apply({
      t: 'block_start',
      seq: 2,
      ts: 2,
      msgId: 'm1',
      index: 0,
      block: {
        kind: 'tool',
        toolId: 'wf1',
        name: 'Workflow',
        toolKind: 'task',
        status: 'running',
        input,
      },
    });
    let seq = 3;
    for (const event of events) {
      transcript.apply({ ts: seq, ...event, seq: seq++ });
    }
    return renderToStaticMarkup(
      React.createElement(WorkflowPopup, {
        open: true,
        transcript,
        toolId: 'wf1',
        onClose: () => {},
      }),
    );
  }

  const progress = (patch) => ({ t: 'agent_progress', parentToolId: 'wf1', patch });
  const step = (stepPatch) => ({ t: 'agent_step', parentToolId: 'wf1', step: stepPatch });
  const finish = (patch) => ({ t: 'tool', toolId: 'wf1', patch });

  it('says which stage is running instead of waiting for the first one', function () {
    const html = paint([progress({ activity: 'Stage 2 of 5: implement', status: 'running' })]);

    assert.ok(
      html.includes('Stage 2 of 5: implement'),
      'the stage the workflow reported is nowhere in the popup',
    );
    assert.ok(
      !html.includes('Waiting for the first stage'),
      'the popup still claims nothing has reported in',
    );
  });

  // The phase list has no observed producer: `agent_step` comes from the
  // delegated-task path, and a workflow's own structure travels on
  // `task_progress.workflow_progress`, which the adapter does not forward. What
  // these two pin is the rendering, so that wiring it later is a one-sided
  // change — not that a user sees phases today. See the popup's own comment.
  it('renders phases if they ever arrive, before any output exists', function () {
    const html = paint([
      progress({ activity: 'Stage 1 of 5: review', status: 'running' }),
      step({ id: 's1', name: 'Bash', toolKind: 'execute', status: 'running', input: { command: 'npm test' }, ts: 4 }),
    ]);

    assert.ok(html.includes('Bash'), 'the phase the workflow started is not listed');
    assert.ok(html.includes('npm test'), 'the phase does not say what it ran');
  });

  it('keeps the finished log, and anything live that came before it', function () {
    const html = paint([
      progress({ activity: 'Stage 1 of 5: review', status: 'running' }),
      step({ id: 's1', name: 'Bash', toolKind: 'execute', status: 'running', input: { command: 'npm test' }, ts: 4 }),
      step({ id: 's1', status: 'completed', output: '42 passing' }),
      progress({ status: 'completed', durationMs: 612000, activity: undefined }),
      finish({ status: 'completed', output: '▸ Review\nchecking file a\n▸ Verify\nall clear' }),
    ]);

    // The live channel is an addition, not a replacement: the log the run
    // finally reported is still the thing someone comes back to read.
    assert.ok(html.includes('all clear'), 'the completed log is gone');
    assert.ok(html.includes('Verify'), 'the log lost the headings it narrated');
    assert.ok(html.includes('Bash'), 'the phases the run went through were dropped when it ended');
  });

  it('stops drawing a finished run as a live one', function () {
    const spinner = mod.RELAY_ICONS['loader-circle'];
    const events = [
      progress({ activity: 'Stage 5 of 5: verify', status: 'running' }),
      step({ id: 's1', name: 'Bash', toolKind: 'execute', status: 'running', input: { command: 'npm test' }, ts: 4 }),
    ];

    const live = paint(events);
    assert.ok(live.includes(spinner), 'a running workflow has nothing moving in it');

    const done = paint([...events, finish({ status: 'completed', output: '▸ Verify\nall clear' })]);
    assert.ok(
      !done.includes(spinner),
      'the popup still pulses over a result that has already arrived',
    );
    // The closing half of a phase can simply never be sent — a cancelled run,
    // or one whose last tool_result went missing. That phase must not go on
    // reading as in flight underneath a log that plainly ended.
    assert.ok(
      !/color:\s*var\(--info\)/.test(done),
      'a phase left open by the run ending is still painted as running',
    );
    assert.ok(done.includes('all clear'), 'the finished log did not survive the assertion above');
  });

  it('still admits when a workflow has reported nothing at all', function () {
    const silent = paint([]);
    assert.ok(
      silent.includes('Waiting for the first stage'),
      'a workflow that has said nothing yet looks broken rather than quiet',
    );

    const empty = paint([finish({ status: 'completed', output: '' })]);
    assert.ok(
      empty.includes('left no output'),
      'a workflow that finished silently no longer says so',
    );
  });

  it('is titled with the workflow, not with the word Workflow', function () {
    const html = paint([progress({ activity: 'Stage 1 of 5: review' })]);

    // Claude's input for this tool is `{scriptPath}` and nothing else, so a
    // title that only reads `name` is the tool's own name for every run there
    // has ever been.
    assert.ok(html.includes('>review-changes<'), 'the popup is not titled with the workflow name');
    assert.ok(html.includes(SCRIPT_PATH), 'the popup never says which script is running');
  });

  it('leaves a workflow that names itself named that way', function () {
    const html = paint([], { name: 'nightly-audit', scriptPath: SCRIPT_PATH });

    assert.ok(html.includes('>nightly-audit<'), 'an explicit name lost to the script path');
  });

  it('does not read an inline script as though it were a path', function () {
    // The same tool takes `{script}`: the workflow's whole source. Read as a
    // path it titles the dialog with whatever the last slash in the body
    // preceded, and prints the script under it.
    const script = "export const meta = { name: 'x' }\nawait agent('read src/client/shell/chat/WorkflowPopup.tsx')\n";
    const html = paint([progress({ activity: 'Stage 1 of 5: review' })], { script });

    assert.ok(!html.includes('WorkflowPopup'), 'the script body was mistaken for a path');
    assert.ok(!html.includes('export const meta'), 'the whole script was printed into the header');
  });

  /**
   * The same popup, painted from a recording of a real run (#117).
   *
   * The events are not written here: they are whatever the claude adapter makes
   * of test/fixtures/chat/claude-workflow.jsonl, which is a real two-phase,
   * five-agent run captured off the wire. So these assertions are "given what a
   * workflow actually reports, this is what someone sees" — the standard the
   * phase list was held back for in #45, and the reason it is being shipped now.
   */
  describe('painted from a recorded run', function () {
    const FIXTURE = path.join(__dirname, 'fixtures', 'chat', 'claude-workflow.jsonl');

    /** The recording, replayed through the adapter and into the popup. */
    function paintReal(stopAfterProgressReports = Infinity) {
      const { React, renderToStaticMarkup, ChatTranscript, WorkflowPopup } = mod;
      const events = [];
      const adapter = new ClaudeChatAdapter({
        sessionId: 'app-session-1',
        workingDir: '/tmp',
        command: 'claude',
        emit: (event) => events.push(event),
      });
      fs.readFileSync(FIXTURE, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .forEach((message) => adapter.handleMessage(message));

      const transcript = new ChatTranscript();
      let seen = 0;
      let seq = 1;
      for (const event of events) {
        if (event.t === 'workflow_progress' && ++seen > stopAfterProgressReports) break;
        transcript.apply({ ts: seq, ...event, seq: seq++ });
      }

      const block = transcript.messages
        .flatMap((message) => message.blocks)
        .find((entry) => entry.kind === 'tool' && entry.name === 'Workflow');
      assert.ok(block, 'the recording no longer contains a Workflow call');

      return renderToStaticMarkup(
        React.createElement(WorkflowPopup, {
          open: true,
          transcript,
          toolId: block.toolId,
          onClose: () => {},
        }),
      );
    }

    it('lists the phases the run declared, and the agents inside each', function () {
      const html = paintReal();

      assert.ok(html.includes('Collect'), 'the first phase is not listed');
      assert.ok(html.includes('Check'), 'the second phase is not listed');
      for (const label of ['collect:1', 'collect:2', 'collect:3', 'check:ok', 'check:bad']) {
        assert.ok(html.includes(label), `the agent ${label} is nowhere in the popup`);
      }
    });

    it('shows several agents at once, not one line for the whole run', function () {
      const html = paintReal();
      // The complaint behind the issue, as an assertion: the old popup could
      // only ever name the one agent the run last narrated about.
      const named = ['collect:1', 'collect:2', 'collect:3'].filter((label) => html.includes(label));
      assert.strictEqual(named.length, 3, 'a phase with three agents in it named fewer than three');
    });

    it('marks a failed agent without anything being opened', function () {
      const html = paintReal();
      const row = html.slice(html.indexOf('check:bad'));

      assert.ok(row.includes('failed'), 'the failed agent carries no failure on its row');
      assert.ok(
        row.includes('no-such-model-at-all'),
        'the row says something failed without saying what',
      );
      assert.ok(html.includes('1 failed'), 'the phase and the counts do not mention the failure');
    });

    it('counts what is running, done and failed out of how many', function () {
      const html = paintReal();

      assert.ok(html.includes('4 done'), 'the run does not say how many agents finished');
      assert.ok(html.includes('1 failed'), 'the run does not say how many agents failed');
      assert.ok(html.includes('of 5'), 'the run does not say how many agents there are in total');
    });

    it('shows a phase still working, and one not started, while the run runs', function () {
      // Cut at the report where Collect had three agents queued and Check had
      // not begun — the state most of a real run is spent in.
      const html = paintReal(1);

      assert.ok(html.includes('queued'), 'agents waiting to start are not shown as waiting');
      assert.ok(html.includes('not started'), 'a phase the run has not reached is not shown as such');
      assert.ok(!html.includes('4 done'), 'a run that had finished nothing claims finished agents');
    });

    it('keeps each agent to a row until it is opened', function () {
      const html = paintReal();

      // The row shows what the agent came back with; the whole of what it was
      // asked stays folded until someone asks for it.
      assert.ok(html.includes('COLLECT-1'), 'a finished agent does not say what it returned');
      assert.ok(
        !html.includes('Do not use any tools'),
        'every agent\'s full task is printed on the closed row',
      );
    });

    it('is titled with the run, for a call that carries only a script', function () {
      const html = paintReal();

      assert.ok(
        html.includes('>probe-workflow-progress<'),
        'a workflow started from an inline script is still titled "Workflow"',
      );
    });

    it('does not fall back to the waiting line once the run has reported', function () {
      assert.ok(
        !paintReal(1).includes('Waiting for the first stage'),
        'a run that has reported its phases still claims nothing has reported in',
      );
    });
  });

  it('says which script is running, not the script itself', function () {
    // `task_started` carries the workflow's source as its prompt — nine
    // thousand characters in an ordinary run — and this line is one line.
    const html = paint([
      progress({ activity: 'Stage 1 of 5: review', prompt: 'export const meta = { name: "review" }\nphase("Review")\n' }),
    ]);

    assert.ok(html.includes(SCRIPT_PATH), 'the popup never says which script is running');
    assert.ok(!html.includes('export const meta'), 'the whole script was rendered as the source line');
  });
});
