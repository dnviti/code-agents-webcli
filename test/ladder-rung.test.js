const assert = require('assert');
const {
  DEFAULT_CONVERSATION_TIER,
  normalizeProfilesConfig,
  nextRungUp,
  resolveConversationRung,
} = require('../dist/shared/runtime-profiles.js');

/**
 * The rung a conversation runs on.
 *
 * Before #171 a ladder only ever configured helpers the agent delegated to, and
 * the conversation itself answered from the runtime's default. These are the
 * rules that make the ladder decide.
 */
describe('conversation rung resolution', function () {
  const full = { tiers: { floor: 'f', mid: 'm', high: 'h', top: 't' } };

  it('takes the rung the profile chose', function () {
    const rung = resolveConversationRung({ ...full, conversationTier: 'high' });
    assert.deepStrictEqual(rung, { tier: 'high', model: 'h' });
  });

  it('defaults to mid when the profile does not say', function () {
    assert.strictEqual(DEFAULT_CONVERSATION_TIER, 'mid');
    // The upgrade case: a ladder saved before the rung existed carries no
    // conversationTier at all, and has to start deciding without being re-saved.
    assert.deepStrictEqual(resolveConversationRung(full), { tier: 'mid', model: 'm' });
  });

  it('falls to the nearest filled rung when the chosen one is blank', function () {
    const rung = resolveConversationRung({ tiers: { floor: 'f', top: 't' }, conversationTier: 'high' });
    // high is blank; top is one step away, floor is two.
    assert.deepStrictEqual(rung, { tier: 'top', model: 't', requested: 'high' });
  });

  it('goes down rather than up when two rungs are equally near', function () {
    // Ladders exist to control spend, so the tie-break must not be the
    // expensive one.
    const rung = resolveConversationRung({ tiers: { floor: 'f', high: 'h' }, conversationTier: 'mid' });
    assert.deepStrictEqual(rung, { tier: 'floor', model: 'f', requested: 'mid' });
  });

  it('has no answer for a profile with no ladder', function () {
    assert.strictEqual(resolveConversationRung({ conversationTier: 'top' }), null);
    assert.strictEqual(resolveConversationRung({ tiers: {} }), null);
  });

  it('names the rung actually used, not the one asked for', function () {
    const rung = resolveConversationRung({ tiers: { top: 't' }, conversationTier: 'floor' });
    assert.strictEqual(rung.tier, 'top');
    assert.strictEqual(rung.requested, 'floor');
  });
});

describe('escalating a rung', function () {
  it('finds the next rung up', function () {
    const rung = nextRungUp({ tiers: { floor: 'f', mid: 'm', high: 'h' } }, 'mid');
    assert.deepStrictEqual(rung, { tier: 'high', model: 'h' });
  });

  it('skips a blank rung rather than stopping at it', function () {
    // "There is nothing above me" and "the box above me is empty" are not the
    // same answer to the agent asking to move up.
    const rung = nextRungUp({ tiers: { mid: 'm', top: 't' } }, 'mid');
    assert.deepStrictEqual(rung, { tier: 'top', model: 't' });
  });

  it('has no answer at the ceiling', function () {
    assert.strictEqual(nextRungUp({ tiers: { mid: 'm', top: 't' } }, 'top'), null);
    assert.strictEqual(nextRungUp({ tiers: { floor: 'f' } }, 'floor'), null);
  });
});

describe('conversationTier normalization', function () {
  function config(conversationTier) {
    return normalizeProfilesConfig({
      profiles: [{ id: 'p1', name: 'Cheap', runtime: 'pi', tiers: { mid: 'm' }, conversationTier }],
    });
  }

  it('keeps a real rung', function () {
    assert.strictEqual(config('top').profiles[0].conversationTier, 'top');
  });

  it('drops anything that is not one', function () {
    for (const bad of ['TOP', 'middle', 3, null, {}]) {
      assert.strictEqual(config(bad).profiles[0].conversationTier, undefined);
    }
  });

  it('survives a round trip through the store', function () {
    const once = config('floor');
    const twice = normalizeProfilesConfig(JSON.parse(JSON.stringify(once)));
    assert.strictEqual(twice.profiles[0].conversationTier, 'floor');
  });

  it('is kept on a profile with no ladder yet', function () {
    // Clearing the four boxes to retype them must not silently reset the rung.
    const c = normalizeProfilesConfig({
      profiles: [{ id: 'p1', name: 'n', runtime: 'pi', conversationTier: 'high' }],
    });
    assert.strictEqual(c.profiles[0].conversationTier, 'high');
  });
});
