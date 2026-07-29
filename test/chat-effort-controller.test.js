const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A `chat_effort_result` says what actually became of the request, and only
// 'live'/'cleared' mean the conversation is thinking at that level now. 'sent'
// is still waiting on the runtime's own word, 'pending' will not be true until
// a relaunch that may never happen, and 'refused' was never stored at all —
// the server keeps the record untouched on that one, so a chip that adopted it
// would be the only thing in the system claiming a level nothing runs at.

const ROOT = path.join(__dirname, '..');

let mod;
let bundle;

before(function () {
  this.timeout(60000);
  const contents = [
    `export { ChatController } from ${JSON.stringify(path.join(ROOT, 'src/client/chat/controller'))};`,
  ].join('\n');

  bundle = path.join(os.tmpdir(), `chat-effort-controller-${process.pid}.js`);
  require('esbuild').buildSync({
    stdin: { contents, resolveDir: ROOT, loader: 'ts', sourcefile: 'chat-effort-controller.ts' },
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
  const sent = [];
  const c = new mod.ChatController('s1', { send: (message) => sent.push(message) });
  return { c, sent };
}

/** The shape a server snapshot arrives in, with nothing interesting in it. */
function snapshot() {
  return {
    sessionId: 's1',
    runtime: 'claude',
    messages: [],
    state: 'idle',
    capabilities: {},
    pendingPermissions: [],
    firstSeq: 1,
    replayFrom: 1,
    cursor: 0,
    live: true,
    bypassPermissions: false,
  };
}

describe('the effort level label', function () {
  it('adopts the level once the server confirms the session is thinking at it', function () {
    const { c } = controller();
    c.handle({ type: 'chat_effort_result', sessionId: 's1', effort: 'xhigh', applied: 'live', message: 'Now thinking at xhigh.' });
    assert.strictEqual(c.effortOverrideValue, 'xhigh');
  });

  it('does not adopt the level while it is only saved for the next session', function () {
    const { c } = controller();
    c.handle({ type: 'chat_effort_result', sessionId: 's1', effort: 'high', applied: 'pending', message: 'Saved. This conversation will run at high from its next session.' });
    assert.strictEqual(c.effortOverrideValue, null, 'nothing is thinking at high yet, so the chip must not say so');
    assert.strictEqual(c.effortFeedback.applied, 'pending', 'the banner still reports what happened');
  });

  it('does not adopt the level for a slash command still awaiting the runtime’s answer', function () {
    const { c } = controller();
    c.handle({ type: 'chat_effort_result', sessionId: 's1', effort: 'low', applied: 'sent', message: 'Sent "/effort low" to the session — the transcript will show whether it took.' });
    assert.strictEqual(c.effortOverrideValue, null);
    assert.strictEqual(c.effortFeedback.applied, 'sent');
  });

  it('leaves the level already in force alone when a request is refused', function () {
    const { c } = controller();
    c.handle({ type: 'chat_effort_result', sessionId: 's1', effort: 'medium', applied: 'live', message: 'Now thinking at medium.' });
    // The server stores nothing on a refusal, so the conversation is still on
    // medium. This is the whole reason the level and the feedback are separate
    // fields: the banner has to report the refusal without the chip forgetting
    // what the session is actually running at.
    c.handle({ type: 'chat_effort_result', sessionId: 's1', effort: null, applied: 'refused', message: 'claude does not offer "ludicrous". It accepts: low, medium, high, xhigh, max.' });
    assert.strictEqual(c.effortOverrideValue, 'medium');
    assert.strictEqual(c.effortFeedback.applied, 'refused');
  });

  it('adopts null immediately when the choice is cleared', function () {
    const { c } = controller();
    c.handle({ type: 'chat_effort_result', sessionId: 's1', effort: 'max', applied: 'live', message: 'Now thinking at max.' });
    c.handle({ type: 'chat_effort_result', sessionId: 's1', effort: null, applied: 'cleared', message: 'Back to the runtime’s own default.' });
    assert.strictEqual(c.effortOverrideValue, null);
  });
});

describe('the effort level a conversation arrives holding', function () {
  it('takes the record’s level from the snapshot it opens with', function () {
    const { c } = controller();
    c.handle({ type: 'chat_snapshot', sessionId: 's1', snapshot: snapshot(), effortOverride: 'high' });
    assert.strictEqual(c.effortOverrideValue, 'high');
  });

  it('takes the record’s level from the launch that announces the session', function () {
    const { c } = controller();
    c.handle({ type: 'chat_started', sessionId: 's1', effortOverride: 'minimal' });
    assert.strictEqual(c.effortOverrideValue, 'minimal');
  });

  it('reads a session with no chosen level as having none', function () {
    const { c } = controller();
    c.handle({ type: 'chat_effort_result', sessionId: 's1', effort: 'max', applied: 'live', message: 'Now thinking at max.' });
    // A record with no override sends no level at all rather than an empty
    // string, so the absent field has to read as "none" — carrying the old one
    // over would show a level on a conversation that never chose one.
    c.handle({ type: 'chat_started', sessionId: 's1' });
    assert.strictEqual(c.effortOverrideValue, null);
  });
});

describe('asking the server to change the effort level', function () {
  it('names the session and the level it wants', function () {
    const { c, sent } = controller();
    c.setEffort('xhigh');
    assert.deepStrictEqual(sent, [{ type: 'chat_set_effort', effort: 'xhigh', sessionId: 's1' }]);
  });

  it('sends the empty string through as the request to go back to the default', function () {
    const { c, sent } = controller();
    // The empty string is the clear signal, not a missing value: dropping the
    // message as "nothing to send" would leave the chip's own "use the default
    // for this runtime" row doing nothing at all.
    c.setEffort('');
    assert.deepStrictEqual(sent, [{ type: 'chat_set_effort', effort: '', sessionId: 's1' }]);
  });
});

describe('restarting a conversation', function () {
  it('forgets both the level and what happened to the last request for one', function () {
    const { c } = controller();
    c.handle({ type: 'chat_effort_result', sessionId: 's1', effort: 'high', applied: 'live', message: 'Now thinking at high.' });
    c.reset();
    assert.strictEqual(c.effortOverrideValue, null, 'the record’s real level is on its way; a stale one would claim the wrong thing');
    assert.strictEqual(c.effortFeedback, null);
  });
});

describe('routing an effort reply to the conversation that asked', function () {
  it('lists chat_effort_result among the types it answers to', function () {
    // The registry routes purely off this set — a chat message whose type is
    // missing from it never reaches a controller at all. It falls through to
    // the terminal's handler, which has no idea what a chat message is and
    // discards it in silence, so the symptom is a chip that never updates and
    // a banner that never appears, with nothing logged anywhere.
    assert.ok(mod.ChatController.MESSAGE_TYPES.has('chat_effort_result'));
  });
});
