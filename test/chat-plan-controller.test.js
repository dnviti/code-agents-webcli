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
