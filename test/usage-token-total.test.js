/**
 * What a piece of work's token figure is, when the runtime did not say.
 *
 * The rule this pins down is the one thing issue #80 turns on: the historical
 * dashboard used to file the runtime's own pre-summed total and nothing else,
 * so every job from a runtime that never sends one — Claude, the agent used
 * most here — read "not reported" beside a cost that reported fine.
 *
 * Which parts may be added is not a matter of taste. The numbers in
 * `test/fixtures/chat` settle it by arithmetic, and the last describe below
 * re-derives it from those fixtures rather than restating it.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { tokenTotal } = require('../dist/shared/usage-records.js');

function fixtureText(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', 'chat', name), 'utf8');
}

describe('a job’s token figure', function () {
  it('is the total the runtime gave, whenever it gave one', function () {
    assert.strictEqual(
      tokenTotal({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, totalTokens: 150 }),
      150,
      'codex counts its cached input inside its input; its own total is the only right answer',
    );
  });

  it('adds the parts up when the runtime gave no total', function () {
    // Claude's four buckets, from claude-oneshot.jsonl's last usage.
    assert.strictEqual(
      tokenTotal({
        inputTokens: 4,
        outputTokens: 97,
        cacheWriteTokens: 16402,
        cacheReadTokens: 47287,
      }),
      63790,
    );
  });

  it('counts the cache buckets, which is most of a cached agent’s bill', function () {
    assert.strictEqual(tokenTotal({ inputTokens: 4, outputTokens: 97 }), 101);
    assert.strictEqual(
      tokenTotal({ inputTokens: 4, outputTokens: 97, cacheReadTokens: 47287 }),
      47388,
      'leaving the cache out is what the composer used to do, and it under-reported by 47k',
    );
  });

  it('does not count reasoning twice, because it is a slice of the output', function () {
    assert.strictEqual(
      tokenTotal({ inputTokens: 7210, outputTokens: 1893, cacheReadTokens: 41000, reasoningTokens: 412 }),
      50103,
      'grok reports exactly this total for exactly these parts',
    );
  });

  it('still answers when reasoning is the only thing reported', function () {
    // Not a number anyone should have to defend, but a null here would say the
    // runtime reported nothing about a runtime that plainly reported something.
    assert.strictEqual(tokenTotal({ reasoningTokens: 40 }), 40);
  });

  it('is null when nothing at all was reported, and zero when zero was', function () {
    assert.strictEqual(tokenTotal({}), null);
    assert.strictEqual(tokenTotal(undefined), null);
    assert.strictEqual(tokenTotal(null), null);
    assert.strictEqual(tokenTotal({ costUsd: 0.4 }), null, 'a cost is not a token count');
    assert.strictEqual(tokenTotal({ inputTokens: 0, outputTokens: 0 }), 0, 'a measured zero survives');
  });

  it('reads a null the way the store hands one back', function () {
    // The dashboard's rows carry nulls, not undefineds. Both mean "not said".
    assert.strictEqual(tokenTotal({ inputTokens: null, outputTokens: null, totalTokens: null }), null);
    assert.strictEqual(tokenTotal({ inputTokens: 10, outputTokens: null, totalTokens: null }), 10);
  });
});

describe('the sum rule, re-derived from what the agents actually send', function () {
  // Each of these is one usage payload lifted out of a captured wire log, with
  // a total the agent computed itself. If the rule were wrong about which parts
  // compose, these would not add up — and the point of reading them out of the
  // fixture rather than typing them here is that the day an agent changes its
  // mind, this fails instead of agreeing with a stale memory of it.

  const usagePayload = (file, keys) => {
    const raw = fixtureText(file);
    const found = {};
    for (const key of keys) {
      const match = raw.match(new RegExp(`"${key}":(\\d+)`));
      if (match) found[key] = Number(match[1]);
    }
    return found;
  };

  it('grok: input + output + cache read is its own total, reasoning excluded', function () {
    const u = usagePayload('grok-stream.jsonl', [
      'input_tokens',
      'output_tokens',
      'cache_read_input_tokens',
      'reasoning_tokens',
      'total_tokens',
    ]);
    assert.ok(u.total_tokens > 0, 'fixture no longer carries a grok total');
    assert.strictEqual(
      tokenTotal({
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
        cacheReadTokens: u.cache_read_input_tokens,
        reasoningTokens: u.reasoning_tokens,
      }),
      u.total_tokens,
    );
  });

  it('an ACP agent: the same composition, from a different vendor', function () {
    const u = usagePayload('acp-omp.jsonl', [
      'inputTokens',
      'outputTokens',
      'cachedReadTokens',
      'totalTokens',
    ]);
    assert.ok(u.totalTokens > 0, 'fixture no longer carries an ACP total');
    assert.strictEqual(
      tokenTotal({
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheReadTokens: u.cachedReadTokens,
      }),
      u.totalTokens,
    );
  });

  it('codex: its cached input is inside its input, so only its own total is right', function () {
    const u = usagePayload('codex-appserver-text-turn.jsonl', [
      'inputTokens',
      'outputTokens',
      'cachedInputTokens',
      'totalTokens',
    ]);
    assert.strictEqual(u.inputTokens + u.outputTokens, u.totalTokens);
    assert.ok(u.cachedInputTokens > 0, 'fixture no longer exercises the overlap');
    // Which is exactly why a reported total always wins over the sum: adding
    // codex's parts would bill its cached input a second time.
    assert.strictEqual(
      tokenTotal({
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheReadTokens: u.cachedInputTokens,
        totalTokens: u.totalTokens,
      }),
      u.totalTokens,
    );
  });
});
