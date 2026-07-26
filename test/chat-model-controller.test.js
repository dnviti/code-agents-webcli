const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A `chat_model_result` of 'pending'/'sent' means the switch is not actually
// running yet — only 'live'/'cleared' confirm the session is on the named
// model. The label the UI shows must track only the confirmed state: adopting
// it on 'pending' would tell the user a model is active before it ever ran,
// and possibly forever if the conversation is never relaunched.

const ROOT = path.join(__dirname, '..');

let mod;
let bundle;

before(function () {
  this.timeout(60000);
  const contents = [
    `export { ChatController } from ${JSON.stringify(path.join(ROOT, 'src/client/chat/controller'))};`,
  ].join('\n');

  bundle = path.join(os.tmpdir(), `chat-model-controller-${process.pid}.js`);
  require('esbuild').buildSync({
    stdin: { contents, resolveDir: ROOT, loader: 'ts', sourcefile: 'chat-model-controller.ts' },
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

function controller() {
  return new mod.ChatController('s1', { send: () => {} });
}

describe('the model override label', function () {
  it('adopts the switched model once the server confirms it is live', function () {
    const c = controller();
    c.handle({ type: 'chat_model_result', sessionId: 's1', model: 'grok-3-fast', applied: 'live', message: 'ok' });
    assert.strictEqual(c.modelOverrideValue, 'grok-3-fast');
  });

  it('does not adopt the label while a switch is only pending the next session', function () {
    const c = controller();
    c.handle({ type: 'chat_model_result', sessionId: 's1', model: 'some-model', applied: 'pending', message: 'saved' });
    assert.strictEqual(c.modelOverrideValue, null, 'not running this model yet, so the label must not claim it is');
    assert.strictEqual(c.modelFeedback.applied, 'pending', 'the banner still reports what happened');
  });

  it('does not adopt the label for a best-effort slash command still awaiting confirmation', function () {
    const c = controller();
    c.handle({ type: 'chat_model_result', sessionId: 's1', model: 'claude-opus', applied: 'sent', message: 'sent' });
    assert.strictEqual(c.modelOverrideValue, null);
  });

  it('adopts null immediately when the override is cleared', function () {
    const c = controller();
    c.handle({ type: 'chat_model_result', sessionId: 's1', model: 'grok-3-fast', applied: 'live', message: 'ok' });
    c.handle({ type: 'chat_model_result', sessionId: 's1', model: null, applied: 'cleared', message: 'cleared' });
    assert.strictEqual(c.modelOverrideValue, null);
  });
});
