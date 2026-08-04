const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let mod;
let bundle;

before(function () {
  this.timeout(60000);
  bundle = path.join(os.tmpdir(), `chat-plan-controller-${process.pid}.js`);
  require('esbuild').buildSync({
    stdin: {
      contents: `export { ChatController } from ${JSON.stringify(path.join(ROOT, 'src/client/chat/controller'))};`,
      resolveDir: ROOT, loader: 'ts', sourcefile: 'chat-plan-controller.ts',
    },
    bundle: true, outfile: bundle, format: 'cjs', platform: 'node', target: ['node20'], logLevel: 'silent',
  });
  mod = require(bundle);
});

after(function () { if (bundle) fs.rmSync(bundle, { force: true }); });

function buildController() {
  const sent = [];
  return { controller: new mod.ChatController('s1', { send: (message) => sent.push(message) }), sent };
}

describe('the durable plan controls', function () {
  it('waits for the correlated built-in workflow admission before resolving', async function () {
    const { controller, sent } = buildController();
    const started = controller.startBuiltInWorkflow('gh-issue', 'The search page loses filters.');

    assert.strictEqual(sent.length, 1);
    const request = sent[0];
    assert.deepStrictEqual(
      { type: request.type, workflow: request.workflow, text: request.text, sessionId: request.sessionId },
      {
        type: 'chat_start_builtin_workflow', workflow: 'gh-issue',
        text: 'The search page loses filters.', sessionId: 's1',
      },
    );
    assert.ok(request.requestId, 'the result must be correlated to this popup submission');

    controller.handle({
      type: 'chat_builtin_workflow_result', sessionId: 's1', requestId: request.requestId,
      workflow: 'gh-issue', accepted: true, status: 'queued', message: 'Queued.',
    });
    assert.strictEqual(await started, 'queued');
  });

  it('keeps a caller-supplied workflow id stable for acknowledgement recovery', async function () {
    const { controller, sent } = buildController();
    const started = controller.startBuiltInWorkflow(
      'gh-issue',
      'The search page loses filters.',
      'workflow-stable-retry',
    );
    assert.strictEqual(sent[0].requestId, 'workflow-stable-retry');
    controller.handle({
      type: 'chat_builtin_workflow_result', sessionId: 's1', requestId: 'workflow-stable-retry',
      workflow: 'gh-issue', accepted: true, status: 'accepted', message: 'Started.',
    });
    assert.strictEqual(await started, 'accepted');
    controller.acknowledgeBuiltInWorkflow('gh-issue', 'workflow-stable-retry');
    assert.deepStrictEqual(sent.at(-1), {
      type: 'chat_builtin_workflow_ack', requestId: 'workflow-stable-retry',
      workflow: 'gh-issue', sessionId: 's1',
    });
  });

  it('does not speak the workflow protocol to a server that did not advertise it', async function () {
    const sent = [];
    const controller = new mod.ChatController('s1', {
      send: (message) => sent.push(message),
      builtInWorkflows: false,
    });
    assert.strictEqual(controller.builtInWorkflowsAvailable, false);
    await assert.rejects(
      controller.startBuiltInWorkflow('gh-issue', 'Create an issue.'),
      /does not support guided workflows/,
    );
    assert.deepStrictEqual(sent, []);
  });

  it('does not resolve an admission with a result for another workflow', async function () {
    const { controller } = buildController();
    const started = controller.startBuiltInWorkflow(
      'gh-issue', 'Create an issue.', 'workflow-kind-check',
    );
    controller.handle({
      type: 'chat_builtin_workflow_result', sessionId: 's1', requestId: 'workflow-kind-check',
      workflow: 'different-workflow', accepted: true, status: 'accepted', message: 'Started.',
    });
    await assert.rejects(started, /different guided workflow/);
  });

  it('rejects a built-in workflow admission without changing the ordinary draft', async function () {
    const { controller, sent } = buildController();
    controller.handle({
      type: 'chat_snapshot', sessionId: 's1',
      snapshot: {
        sessionId: 's1', runtime: 'claude', state: 'idle', capabilities: {}, messages: [],
        pendingPermissions: [], queued: [], firstSeq: 0, replayFrom: 0, cursor: 0,
        live: true, bypassPermissions: false,
      },
      draft: { text: 'Keep this composer draft.', attachments: [], revision: 3 },
    });
    const started = controller.startBuiltInWorkflow('gh-issue', 'Create an issue.');
    const request = sent.find((message) => message.type === 'chat_start_builtin_workflow');

    controller.handle({
      type: 'chat_builtin_workflow_result', sessionId: 's1', requestId: request.requestId,
      workflow: 'gh-issue', accepted: false, message: 'Plan mode is active.',
    });
    await assert.rejects(started, /Plan mode is active/);
    assert.strictEqual(
      controller.draftValue.text,
      'Keep this composer draft.',
      'workflow starts never clear or overwrite the synchronized composer',
    );
  });

  it('clears a previously rendered document when the server broadcasts null', function () {
    const { controller } = buildController();
    controller.handle({ type: 'chat_plan_document', sessionId: 's1', plan: { markdown: '# First', revision: 1, ts: 1 } });
    assert.strictEqual(controller.planDocumentValue.markdown, '# First');
    controller.handle({ type: 'chat_plan_document', sessionId: 's1', plan: null });
    assert.strictEqual(controller.planDocumentValue, null, 'a new conversation must not retain the last conversation’s plan');
  });

  it('sends accept and reject for the revision the user reviewed', function () {
    const { controller, sent } = buildController();
    controller.acceptPlan(4);
    controller.rejectPlan(5);
    assert.deepStrictEqual(sent, [
      { type: 'chat_accept_plan', revision: 4, sessionId: 's1' },
      { type: 'chat_reject_plan', revision: 5, sessionId: 's1' },
    ]);
  });

  it('keeps the latest document while action replies update mode and feedback', function () {
    const { controller } = buildController();
    controller.handle({ type: 'chat_plan_document', sessionId: 's1', plan: { markdown: '# Revision two', revision: 2, ts: 2 } });
    controller.handle({
      type: 'chat_plan_action', sessionId: 's1', action: 'reject', accepted: true,
      planMode: true, revision: 2, message: 'Add feedback in the composer.',
    });
    assert.strictEqual(controller.planDocumentValue.revision, 2);
    assert.strictEqual(controller.planModeValue, true);
    assert.deepStrictEqual(controller.planFeedback, {
      action: 'reject', accepted: true, revision: 2, message: 'Add feedback in the composer.',
    });
  });
});
