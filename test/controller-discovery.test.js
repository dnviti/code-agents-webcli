'use strict';

const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const {
  broadcastAddresses,
  findLanServers,
  scanTimeout,
} = require('../desktop/controller-discovery.js');

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.closed = false;
    this.broadcast = false;
  }
  bind(port, address, callback) {
    this.bound = { port, address };
    queueMicrotask(callback);
  }
  setBroadcast(value) { this.broadcast = value; }
  send(message, port, address) { this.sent.push({ message, port, address }); }
  close() { this.closed = true; }
}

describe('desktop controller LAN discovery client', function () {
  it('derives directed IPv4 broadcasts without exposing internal interfaces', function () {
    assert.deepStrictEqual(broadcastAddresses({
      lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1', netmask: '255.0.0.0' }],
      wifi: [{ family: 'IPv4', internal: false, address: '192.168.20.42', netmask: '255.255.255.0' }],
      vpn: [{ family: 'IPv4', internal: false, address: '10.7.3.1', netmask: '255.255.0.0' }],
    }), ['255.255.255.255', '192.168.20.255', '10.7.255.255']);
  });

  it('does nothing until explicitly called, then sends one bounded scan and deduplicates candidates', async function () {
    let created = 0;
    const socket = new FakeSocket();
    const factory = () => { created += 1; return socket; };
    assert.strictEqual(created, 0);

    const scan = findLanServers({
      probe: 'CODE_AGENTS_DISCOVERY/1',
      port: 32353,
      addresses: ['255.255.255.255', '192.168.1.255', '192.168.1.255'],
      timeoutMs: 100,
      createSocket: factory,
      parseResponse(message) {
        const text = message.toString('utf8');
        if (text === 'parser-crash') throw new Error('unexpected parser input');
        try { return JSON.parse(text); } catch { return null; }
      },
    });
    assert.strictEqual(created, 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(socket.bound, { port: 0, address: '0.0.0.0' });
    assert.strictEqual(socket.broadcast, true);
    assert.deepStrictEqual(socket.sent, [
      { message: 'CODE_AGENTS_DISCOVERY/1', port: 32353, address: '255.255.255.255' },
      { message: 'CODE_AGENTS_DISCOVERY/1', port: 32353, address: '192.168.1.255' },
    ]);
    socket.emit('message', Buffer.from('parser-crash'), { address: '192.168.1.7' });
    socket.emit('message', Buffer.from('not-json'), { address: '192.168.1.8' });
    socket.emit('message', Buffer.from(JSON.stringify({ address: 'https://b.example', serverName: 'Beta' })), { address: '192.168.1.9' });
    socket.emit('message', Buffer.from(JSON.stringify({ address: 'https://a.example', serverName: 'Alpha' })), { address: '192.168.1.10' });
    socket.emit('message', Buffer.from(JSON.stringify({ address: 'https://a.example', serverName: 'Renamed Alpha' })), { address: '192.168.1.11' });
    const found = await scan;
    assert.deepStrictEqual(found, [
      { address: 'https://b.example', serverName: 'Beta', discoveredFrom: '192.168.1.9' },
      { address: 'https://a.example', serverName: 'Renamed Alpha', discoveredFrom: '192.168.1.11' },
    ]);
    assert.strictEqual(socket.closed, true);
  });

  it('closes and rejects on socket errors or cancellation', async function () {
    const failed = new FakeSocket();
    const failure = findLanServers({
      probe: 'probe', port: 1, addresses: ['255.255.255.255'], timeoutMs: 100,
      createSocket: () => failed, parseResponse: () => null,
    });
    failed.emit('error', new Error('permission denied'));
    await assert.rejects(failure, /permission denied/);
    assert.strictEqual(failed.closed, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(failed.sent, [], 'a failed bind callback never sends after rejection');

    const controller = new AbortController();
    const cancelled = new FakeSocket();
    const cancellation = findLanServers({
      probe: 'probe', port: 1, addresses: ['255.255.255.255'], timeoutMs: 100,
      signal: controller.signal, createSocket: () => cancelled, parseResponse: () => null,
    });
    controller.abort(new Error('cancelled by user'));
    await assert.rejects(cancellation, /cancelled by user/);
    assert.strictEqual(cancelled.closed, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(cancelled.sent, [], 'an aborted bind callback never sends after rejection');
  });

  it('bounds scan duration and validates its explicit contract', function () {
    assert.strictEqual(scanTimeout(1), 100);
    assert.strictEqual(scanTimeout(99_999), 10_000);
    assert.throws(() => findLanServers({}), /probe/);
    assert.throws(() => findLanServers({ probe: 'x', parseResponse() {}, port: 0 }), /UDP port/);
  });
});
