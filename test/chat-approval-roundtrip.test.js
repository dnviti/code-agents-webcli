const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ChatSession } = require('../dist/server/chat/session.js');

// The approval round trip, end to end through the real ChatSession.
//
// This is the path that hung every Claude chat that touched a tool: the hook
// asked, the card appeared, the user answered — and the answer went nowhere,
// because emitting the `permission` event replaced the pending entry and threw
// away the resolver the broker was waiting on. The tool never ran, and the
// surface kept its stop button and its "Working" indicator for good.
//
// Driven through the session rather than the broker alone, because the broker
// on its own always worked; the defect lived in the hand-off between them.

const ROOT = path.join(__dirname, '..');

function fakeAdapter(emit) {
  return {
    runtime: 'claude',
    capabilities: { permissions: false, streaming: true },
    alive: true,
    respondPermissionCalls: [],
    async start() {},
    async send() {},
    async interrupt() {},
    respondPermission(requestId, optionId) {
      this.respondPermissionCalls.push({ requestId, optionId });
    },
    async stop() {
      this.alive = false;
    },
    emit,
  };
}

function memoryStore() {
  const events = [];
  return {
    events,
    append(_ref, batch) {
      events.push(...batch);
    },
    async stat() {
      return { firstSeq: 1, cursor: events.length };
    },
    async read() {
      return { events: [], firstSeq: 1, from: 1, cursor: events.length };
    },
    async snapshot() {
      return {
        sessionId: 's1', runtime: 'claude', messages: [], state: 'idle',
        capabilities: {}, pendingPermissions: [], firstSeq: 1, replayFrom: 1,
        cursor: events.length, live: true, bypassPermissions: false,
      };
    },
  };
}

/** A session with its adapter and its broker stubbed at the seams they own. */
function session({ bypass = false } = {}) {
  const store = memoryStore();
  const broadcasts = [];
  const s = new ChatSession(
    { id: 's1', ownerUserId: 7 },
    {
      store,
      socketDir: fs.mkdtempSync(path.join(os.tmpdir(), 'approval-')),
      // Absent, so ChatSession does not stand up a real broker; askUser is
      // exercised directly below, which is the function under test.
      hookScript: path.join(ROOT, 'does-not-exist.js'),
      broadcast: (id, m) => broadcasts.push(m),
      resolveCommand: () => 'claude',
    },
  );
  s.bypass = bypass;
  return { s, store, broadcasts };
}

describe('answering an approval', function () {
  it('resolves the question the hook is blocked on', async function () {
    const { s, store } = session();

    // What the broker does when the hook dials in.
    const answer = s.askUser({ toolName: 'Bash', toolInput: { command: 'echo hi' } });

    const asked = store.events.find((e) => e.t === 'permission');
    assert.ok(asked, 'the question should reach the transcript');

    s.respondPermission(asked.request.requestId, 'allow_once');

    // The regression: this promise never settled, so the hook never printed a
    // decision and the CLI waited on it forever.
    const decision = await Promise.race([
      answer,
      new Promise((_, reject) => setTimeout(() => reject(new Error('the approval was never answered')), 1000)),
    ]);

    assert.strictEqual(decision.allow, true);
    assert.match(decision.reason, /approved/i);
    assert.ok(store.events.some((e) => e.t === 'permission_resolved' && e.allowed === true));
  });

  it('carries a refusal back with the same round trip', async function () {
    const { s, store } = session();
    const answer = s.askUser({ toolName: 'Bash', toolInput: { command: 'rm -rf /' } });
    const asked = store.events.find((e) => e.t === 'permission');

    s.respondPermission(asked.request.requestId, 'reject_once');

    const decision = await Promise.race([
      answer,
      new Promise((_, reject) => setTimeout(() => reject(new Error('the refusal was never answered')), 1000)),
    ]);
    assert.strictEqual(decision.allow, false);
  });

  it('releases anything still waiting when the turn is interrupted', async function () {
    const { s, store } = session();
    s.adapter = fakeAdapter(() => {});
    const answer = s.askUser({ toolName: 'Bash', toolInput: {} });
    store.events.find((e) => e.t === 'permission');

    await s.interrupt();

    const decision = await Promise.race([
      answer,
      new Promise((_, reject) => setTimeout(() => reject(new Error('interrupt left the hook hanging')), 1000)),
    ]);
    assert.strictEqual(decision.allow, false);
  });

  it('releases anything still waiting when the session stops', async function () {
    const { s } = session();
    const answer = s.askUser({ toolName: 'Bash', toolInput: {} });

    await s.stop();

    const decision = await Promise.race([
      answer,
      new Promise((_, reject) => setTimeout(() => reject(new Error('stop left the hook hanging')), 1000)),
    ]);
    assert.strictEqual(decision.allow, false);
  });

  it('answers immediately, without asking, when approvals are bypassed', async function () {
    const { s, store } = session({ bypass: true });
    const decision = await s.askUser({ toolName: 'Bash', toolInput: {} });
    assert.strictEqual(decision.allow, true);
    assert.ok(!store.events.some((e) => e.t === 'permission'), 'nothing should be asked');
  });
});
