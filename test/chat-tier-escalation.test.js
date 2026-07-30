const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ChatSession } = require('../dist/server/chat/session.js');

// The agent asking to answer from a stronger model than its rung (#171).
//
// Driven through the real ChatSession, because the whole claim is about the
// hand-off between three things that each work on their own: the escalation is
// put to the user as an ordinary approval, the grant reaches the adapter as a
// model change, and the turn ending puts it back.

const ROOT = path.join(__dirname, '..');

function fakeAdapter() {
  return {
    runtime: 'pi',
    capabilities: { permissions: false, streaming: true },
    alive: true,
    models: [],
    async start() {},
    async send() {},
    async interrupt() {},
    async setModel(model) {
      this.models.push(model);
    },
    respondPermission() {},
    async stop() {
      this.alive = false;
    },
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
        sessionId: 's1', runtime: 'pi', messages: [], state: 'idle',
        capabilities: {}, pendingPermissions: [], firstSeq: 1, replayFrom: 1,
        cursor: events.length, live: true, bypassPermissions: false,
      };
    },
  };
}

const LADDER = { floor: 'f-model', mid: 'm-model', high: 'h-model', top: 't-model' };

function session({ bypass = false, tier = 'mid', tiers = LADDER, ladder = true } = {}) {
  const store = memoryStore();
  const broadcasts = [];
  const s = new ChatSession(
    { id: 's1', ownerUserId: 7 },
    {
      store,
      socketDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tier-')),
      hookScript: path.join(ROOT, 'does-not-exist.js'),
      broadcast: (id, m) => broadcasts.push(m),
      resolveCommand: () => 'pi',
    },
  );
  s.bypass = bypass;
  s.ladder = ladder ? { tier, tiers } : null;
  s.adapter = fakeAdapter();
  return { s, store, broadcasts };
}

/** The pending escalation the browser would draw a card for. */
const askedFor = (store) =>
  store.events.filter((e) => e.t === 'permission').pop();

const markers = (store) =>
  store.events.filter((e) => e.t === 'marker' && e.kind === 'model').map((e) => e.detail);

/** Fail loudly rather than hanging the suite on a promise that never settles. */
function settles(promise, what) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${what} never settled`)), 1000),
    ),
  ]);
}

describe('asking to move up a rung', function () {
  it('puts the request to the user and waits', async function () {
    const { s, store } = session();

    const decided = s.requestTier({ reason: 'this refactor spans four subsystems' });

    const asked = askedFor(store);
    assert.ok(asked, 'the request should reach the transcript as an approval');
    assert.match(asked.request.title, /high/);
    assert.match(asked.request.reason, /four subsystems/);
    // Nothing has moved yet: the whole point is that it waits.
    assert.deepStrictEqual(s.adapter.models, []);

    s.respondPermission(asked.request.requestId, 'allow_once');
    const decision = await settles(decided, 'the escalation');

    assert.strictEqual(decision.granted, true);
    assert.strictEqual(decision.tier, 'high');
    assert.strictEqual(decision.model, 'h-model');
  });

  it('answers from the stronger model once approved', async function () {
    const { s, store } = session();
    const decided = s.requestTier({ reason: 'hard' });
    s.respondPermission(askedFor(store).request.requestId, 'allow_once');
    await settles(decided, 'the escalation');

    assert.deepStrictEqual(s.adapter.models, ['h-model']);
    assert.deepStrictEqual(markers(store), ['moved up to the high rung — h-model']);
  });

  it('does not move when the request is refused', async function () {
    const { s, store } = session();
    const decided = s.requestTier({ reason: 'hard' });
    s.respondPermission(askedFor(store).request.requestId, 'reject_once');
    const decision = await settles(decided, 'the refusal');

    assert.strictEqual(decision.granted, false);
    assert.match(decision.detail, /did not approve/);
    assert.deepStrictEqual(s.adapter.models, []);
    assert.deepStrictEqual(markers(store), []);
  });

  it('proceeds without asking when approvals are bypassed', async function () {
    // The issue is explicit: a conversation running with approvals bypassed
    // gives this up along with everything else it gives up.
    const { s, store } = session({ bypass: true });

    const decision = await settles(s.requestTier({ reason: 'hard' }), 'the bypassed escalation');

    assert.strictEqual(decision.granted, true);
    assert.strictEqual(askedFor(store), undefined, 'nobody should have been asked');
    assert.deepStrictEqual(s.adapter.models, ['h-model']);
  });

  it('skips a blank rung rather than stopping at it', async function () {
    const { s, store } = session({ tier: 'mid', tiers: { mid: 'm-model', top: 't-model' } });
    const decided = s.requestTier({ reason: 'hard' });
    s.respondPermission(askedFor(store).request.requestId, 'allow_once');
    const decision = await settles(decided, 'the escalation');

    assert.strictEqual(decision.tier, 'top');
  });

  it('refuses at the ceiling without asking anyone', async function () {
    const { s, store } = session({ tier: 'top' });

    const decision = await settles(s.requestTier({ reason: 'hard' }), 'the ceiling refusal');

    assert.strictEqual(decision.granted, false);
    assert.match(decision.detail, /already on the top rung/);
    assert.strictEqual(askedFor(store), undefined);
  });

  it('has nothing to offer a conversation that is not on a ladder', async function () {
    const { s } = session({ ladder: false });

    const decision = await settles(s.requestTier({ reason: 'hard' }), 'the ladderless refusal');

    assert.strictEqual(decision.granted, false);
    assert.match(decision.detail, /not running on a capability ladder/);
  });

  it('offers the next step up from where it already is', async function () {
    // Two grants in one turn must not both offer mid → high; the second would
    // look to the user like a request already approved.
    const { s, store } = session();
    const first = s.requestTier({ reason: 'hard' });
    s.respondPermission(askedFor(store).request.requestId, 'allow_once');
    await settles(first, 'the first escalation');

    const second = s.requestTier({ reason: 'harder' });
    const asked = askedFor(store);
    assert.match(asked.request.title, /top/);
    s.respondPermission(asked.request.requestId, 'allow_once');
    assert.strictEqual((await settles(second, 'the second escalation')).tier, 'top');
  });
});

describe('coming back down', function () {
  it('returns to its usual rung once the turn ends', async function () {
    const { s, store } = session();
    const decided = s.requestTier({ reason: 'hard' });
    s.respondPermission(askedFor(store).request.requestId, 'allow_once');
    await settles(decided, 'the escalation');

    s.ingest({ t: 'turn_end' });
    // `endEscalation` is deliberately not awaited by `ingest`; one tick is
    // enough for the switch back and the marker it emits.
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepStrictEqual(s.adapter.models, ['h-model', 'm-model']);
    assert.deepStrictEqual(markers(store), [
      'moved up to the high rung — h-model',
      'back on the mid rung — m-model',
    ]);
  });

  it('leaves an unescalated conversation alone at the end of a turn', async function () {
    const { s, store } = session();

    s.ingest({ t: 'turn_end' });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepStrictEqual(s.adapter.models, []);
    assert.deepStrictEqual(markers(store), []);
  });

  it('asks again on the next turn rather than staying up', async function () {
    // The grant is per turn, and that is the only control on what this spends.
    const { s, store } = session();
    const first = s.requestTier({ reason: 'hard' });
    s.respondPermission(askedFor(store).request.requestId, 'allow_once');
    await settles(first, 'the first escalation');
    s.ingest({ t: 'turn_end' });
    await new Promise((resolve) => setImmediate(resolve));

    const second = s.requestTier({ reason: 'still hard' });
    const asked = askedFor(store);
    assert.ok(asked, 'the next turn has to ask again');
    assert.match(asked.request.title, /high/, 'and from the rung it came back to');
    s.respondPermission(asked.request.requestId, 'reject_once');
    await settles(second, 'the second escalation');
  });
});

describe('what the model is told', function () {
  it('says the switch is live when the adapter took it', async function () {
    const { s, store } = session();
    const decided = s.requestTier({ reason: 'hard' });
    s.respondPermission(askedFor(store).request.requestId, 'allow_once');

    assert.match((await settles(decided, 'the escalation')).detail, /You are now answering/);
  });

  it('says it lands on the next turn when the adapter could not', async function () {
    // pi is one process per turn, so a switch cannot reach the process already
    // running. A model told it is on a stronger model when it is not would
    // attempt work it cannot do.
    const { s, store } = session();
    delete s.adapter.setModel;

    const decided = s.requestTier({ reason: 'hard' });
    s.respondPermission(askedFor(store).request.requestId, 'allow_once');
    const decision = await settles(decided, 'the escalation');

    assert.strictEqual(decision.granted, true);
    assert.match(decision.detail, /takes effect on your next turn/);
  });
});

describe('a profile edited under a running conversation', function () {
  it('moves it onto the new rung, interrupting the turn in progress', async function () {
    const { s, store } = session();
    let interrupted = false;
    s.adapter.interrupt = async () => { interrupted = true; };
    // Mid-turn, which is the case the issue names outright.
    s.setState('thinking');

    const moved = await s.reapplyLadder({ tier: 'top', tiers: LADDER });

    assert.strictEqual(moved, true);
    assert.ok(interrupted, 'the turn in progress has to be cut short');
    assert.deepStrictEqual(s.adapter.models, ['t-model']);
    assert.deepStrictEqual(markers(store), [
      'the profile changed — now on the top rung, t-model',
    ]);
  });

  it('interrupts nobody when the rung it is already on has not changed', async function () {
    // An unrelated save rewrites the whole configuration, so every laddered
    // session is offered the ladder. Cutting a turn short to change nothing is
    // the worst possible reading of "takes effect immediately".
    const { s, store } = session();
    let interrupted = false;
    s.adapter.interrupt = async () => { interrupted = true; };
    s.setState('thinking');

    const moved = await s.reapplyLadder({ tier: 'mid', tiers: LADDER });

    assert.strictEqual(moved, false);
    assert.ok(!interrupted);
    assert.deepStrictEqual(s.adapter.models, []);
    assert.deepStrictEqual(markers(store), []);
  });

  it('leaves a conversation that is not on the ladder alone', async function () {
    // One pinned by a model somebody typed, or by an account's standing choice,
    // was never the ladder's to decide.
    const { s, store } = session({ ladder: false });

    const moved = await s.reapplyLadder({ tier: 'top', tiers: LADDER });

    assert.strictEqual(moved, false);
    assert.deepStrictEqual(s.adapter.models, []);
    assert.deepStrictEqual(markers(store), []);
  });

  it('says so when the ladder is taken away entirely', async function () {
    const { s, store } = session();

    const moved = await s.reapplyLadder(null);

    assert.strictEqual(moved, true);
    assert.deepStrictEqual(s.adapter.models, [], 'there is nothing to switch to');
    assert.match(markers(store)[0], /the ladder this conversation was on is gone/);
  });

  it('drops an escalation that belonged to the ladder it replaced', async function () {
    const { s, store } = session();
    const decided = s.requestTier({ reason: 'hard' });
    s.respondPermission(askedFor(store).request.requestId, 'allow_once');
    await settles(decided, 'the escalation');

    await s.reapplyLadder({ tier: 'floor', tiers: LADDER });

    // And the turn ending now puts nothing back: the grant went with its ladder.
    s.ingest({ t: 'turn_end' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(s.adapter.models, ['h-model', 'f-model']);
  });
});
