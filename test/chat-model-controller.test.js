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

// The other half of the same control: which model a *new* conversation on this
// runtime would open on, and why. A different question from the one above, and
// one nothing on the wire could answer before #135 — a profile-pinned model was
// genuinely in force with nothing anywhere naming it.
describe('where the model default came from', function () {
  const snapshot = (modelDefault) => ({
    type: 'chat_snapshot',
    sessionId: 's1',
    snapshot: {
      sessionId: 's1',
      runtime: 'claude',
      state: 'idle',
      capabilities: {},
      messages: [],
      pendingPermissions: [],
      firstSeq: 0,
      cursor: 0,
      live: true,
      bypassPermissions: false,
    },
    ...(modelDefault === undefined ? {} : { modelDefault }),
  });

  it('is taken from the join', function () {
    const c = controller();
    c.handle(snapshot({ model: 'profile-model', source: 'profile', profileName: 'House' }));
    assert.deepStrictEqual(c.modelDefaultValue, {
      model: 'profile-model',
      source: 'profile',
      profileName: 'House',
    });
  });

  it('is taken from the launch', function () {
    const c = controller();
    c.handle({
      type: 'chat_started',
      sessionId: 's1',
      agent: 'claude',
      modelDefault: { model: 'claude-opus-4-6', source: 'personal' },
    });
    assert.deepStrictEqual(c.modelDefaultValue, {
      model: 'claude-opus-4-6',
      source: 'personal',
    });
  });

  // A pick the running session could not take still changed what the next new
  // conversation opens on, and a clear still forgot the standing choice. Left
  // to the next join, the picker would describe the state before the click for
  // the rest of the conversation.
  it('is refreshed by the answer to a pick, not only by a rejoin', function () {
    const c = controller();
    c.handle(snapshot({ model: null, source: 'runtime' }));
    c.handle({
      type: 'chat_model_result',
      sessionId: 's1',
      model: 'claude-opus-4-6',
      applied: 'pending',
      message: 'saved',
      modelDefault: { model: 'claude-opus-4-6', source: 'personal' },
    });
    assert.deepStrictEqual(c.modelDefaultValue, {
      model: 'claude-opus-4-6',
      source: 'personal',
    });
    assert.strictEqual(c.modelOverrideValue, null, 'and still no claim that it is running');
  });

  it('stays null when the server said nothing, so an older one reads as it always did', function () {
    const c = controller();
    c.handle(snapshot(undefined));
    assert.strictEqual(c.modelDefaultValue, null);
  });

  // Half an answer to "why is this model selected" is worse than none.
  it('refuses a half-answer rather than showing a source it was not told', function () {
    const c = controller();
    c.handle(snapshot({ model: 'claude-opus-4-6' }));
    assert.strictEqual(c.modelDefaultValue, null);
    c.handle(snapshot({ model: 'claude-opus-4-6', source: 'whatever' }));
    assert.strictEqual(c.modelDefaultValue, null);
  });

  // It describes the account and the runtime, not the conversation being
  // restarted, and the picker would otherwise have nothing to say about what
  // the restart will open on.
  it('survives a reset, unlike the conversation’s own override', function () {
    const c = controller();
    c.handle(snapshot({ model: 'profile-model', source: 'profile', profileName: 'House' }));
    c.handle({ type: 'chat_model_result', sessionId: 's1', model: 'x', applied: 'live', message: 'ok' });
    c.reset();
    assert.strictEqual(c.modelOverrideValue, null);
    assert.strictEqual(c.modelDefaultValue?.model, 'profile-model');
  });
});
