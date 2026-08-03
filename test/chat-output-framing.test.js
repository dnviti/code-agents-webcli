const assert = require('assert');

const { BaseChatAdapter } = require('../dist/server/chat/adapter.js');

class FramingAdapter extends BaseChatAdapter {
  runtime = 'framing-test';
  capabilities = {};
  messages = [];

  buildArgs() { return []; }
  handleMessage(message) { this.messages.push(message); }
  async send() {}
  async interrupt() {}
  respondPermission() {}

  /** Expose the adapter's raw stdout seam without spawning a runtime. */
  feed(chunk) { this.feedStdout(chunk); }
  resetWire() { this.resetStdoutFraming(); }
  setLimit(bytes) { this.maxProtocolLineBytes = bytes; }
}

function harness() {
  const events = [];
  const adapter = new FramingAdapter({
    sessionId: 'framing-test',
    workingDir: process.cwd(),
    command: process.execPath,
    emit: (event) => events.push(event),
  });
  return { adapter, events };
}

describe('chat adapter output framing', function () {
  it('accepts a valid JSON record above the former 1 MB ceiling across chunks', function () {
    const h = harness();
    const output = 'x'.repeat(1_100_000);
    const record = JSON.stringify({
      jsonrpc: '2.0',
      method: 'probe',
      params: { output },
    });

    for (let offset = 0; offset < record.length; offset += 64 * 1024) {
      h.adapter.feed(record.slice(offset, offset + 64 * 1024));
    }
    assert.strictEqual(h.adapter.messages.length, 0, 'a record is not complete before its newline');

    h.adapter.feed(`\n${JSON.stringify({ after: true })}\n`);

    assert.strictEqual(h.events.some((event) => event.t === 'error'), false);
    assert.strictEqual(h.adapter.messages.length, 2);
    assert.strictEqual(h.adapter.messages[0].method, 'probe');
    assert.strictEqual(h.adapter.messages[0].params.output.length, 1_100_000);
    assert.deepStrictEqual(h.adapter.messages[1], { after: true });
  });

  it('reports one partial-line overflow and resumes after that line ends', function () {
    const h = harness();
    h.adapter.setLimit(32);

    h.adapter.feed('x'.repeat(33));
    h.adapter.feed('y'.repeat(100));
    h.adapter.feed(`${JSON.stringify({ poison: true })}\n${JSON.stringify({ ok: true })}\n`);

    const errors = h.events.filter((event) => event.t === 'error');
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /oversized line/);
    assert.deepStrictEqual(h.adapter.messages, [{ ok: true }]);
  });

  it('rejects a complete over-limit line regardless of chunk boundaries', function () {
    const h = harness();
    h.adapter.setLimit(32);

    h.adapter.feed(`${'x'.repeat(33)}\n${JSON.stringify({ ok: 'after overflow' })}\n`);

    const errors = h.events.filter((event) => event.t === 'error');
    assert.strictEqual(errors.length, 1);
    assert.deepStrictEqual(h.adapter.messages, [{ ok: 'after overflow' }]);
  });

  it('preserves UTF-8 split across chunks and accepts CRLF records', function () {
    const h = harness();
    const encoded = Buffer.from(`${JSON.stringify({ text: 'A😀B' })}\r\n`, 'utf8');
    const emoji = encoded.indexOf(Buffer.from('😀', 'utf8'));

    h.adapter.feed(encoded.subarray(0, emoji + 2));
    h.adapter.feed(encoded.subarray(emoji + 2));

    assert.deepStrictEqual(h.adapter.messages, [{ text: 'A😀B' }]);
    assert.strictEqual(h.events.some((event) => event.t === 'error'), false);
  });

  it('copies highly fragmented slices instead of retaining their backing store', function () {
    const h = harness();
    const record = Buffer.from(JSON.stringify({ copied: 'before mutation' }), 'utf8');
    const backing = Buffer.alloc(2 * 1024 * 1024, 0x20);
    record.copy(backing, 4096);

    for (let offset = 0; offset < record.length; offset += 1) {
      h.adapter.feed(backing.subarray(4096 + offset, 4096 + offset + 1));
    }
    backing.fill(0x78);
    h.adapter.feed('\n');

    assert.deepStrictEqual(h.adapter.messages, [{ copied: 'before mutation' }]);
  });

  it('accepts a record exactly at the byte ceiling', function () {
    const h = harness();
    h.adapter.setLimit(32);
    const record = JSON.stringify({ x: 'x'.repeat(24) });
    assert.strictEqual(Buffer.byteLength(record), 32);

    h.adapter.feed(`${record}\n`);

    assert.deepStrictEqual(h.adapter.messages, [{ x: 'x'.repeat(24) }]);
    assert.strictEqual(h.events.some((event) => event.t === 'error'), false);
  });

  it('applies the ceiling to UTF-8 bytes rather than JavaScript characters', function () {
    const h = harness();
    const record = JSON.stringify({ text: '😀' });
    h.adapter.setLimit(Buffer.byteLength(record) - 1);

    h.adapter.feed(`${record}\n${JSON.stringify({ ok: true })}\n`);

    assert.strictEqual(h.events.filter((event) => event.t === 'error').length, 1);
    assert.deepStrictEqual(h.adapter.messages, [{ ok: true }]);
  });

  it('clears discard state before a replacement stdout stream starts', function () {
    const h = harness();
    h.adapter.setLimit(32);
    h.adapter.feed('x'.repeat(33));

    h.adapter.resetWire();
    h.adapter.feed(`${JSON.stringify({ fresh: true })}\n`);

    assert.deepStrictEqual(h.adapter.messages, [{ fresh: true }]);
  });

  it('clears a buffered prefix before a replacement stdout stream starts', function () {
    const h = harness();
    h.adapter.feed('{"stale":');

    h.adapter.resetWire();
    h.adapter.feed(`${JSON.stringify({ fresh: true })}\n`);

    assert.deepStrictEqual(h.adapter.messages, [{ fresh: true }]);
  });
});
