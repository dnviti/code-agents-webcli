'use strict';

const assert = require('node:assert');

const {
  DEFAULT_PHONE_ACCESS_PORT,
  listPhoneAccessInterfaces,
  phoneAccessOrigin,
  validatePhoneAccessAddress,
} = require('../desktop/phone-access-network.js');

describe('desktop phone access network', function () {
  const interfaces = {
    lo: [
      { address: '127.0.0.1', family: 'IPv4', internal: true },
      { address: '::1', family: 'IPv6', internal: true },
    ],
    wifi: [
      { address: '192.168.4.12', family: 'IPv4', internal: false },
      { address: 'fe80::1234', family: 'IPv6', internal: false },
      { address: '2001:0db8:0:0::12', family: 'IPv6', internal: false },
      { address: 'fd12:3456:789a::12', family: 'IPv6', internal: false },
    ],
    tail: [
      { address: '100.96.4.2', family: 4, internal: false },
      { address: 'fd7a:115c:a1e0::2', family: 6, internal: false },
    ],
    invalid: [
      { address: '0.0.0.0', family: 'IPv4', internal: false },
      { address: '224.0.0.1', family: 'IPv4', internal: false },
      { address: 'ff02::1', family: 'IPv6', internal: false },
      { address: 'not-an-ip', family: 'IPv4', internal: false },
    ],
  };

  it('lists only current non-internal unicast addresses', function () {
    assert.deepStrictEqual(listPhoneAccessInterfaces({ networkInterfaces: () => interfaces }), [
      { name: 'wifi', address: '192.168.4.12', family: 'IPv4' },
      { name: 'wifi', address: 'fd12:3456:789a::12', family: 'IPv6' },
      { name: 'tail', address: '100.96.4.2', family: 'IPv4' },
      { name: 'tail', address: 'fd7a:115c:a1e0::2', family: 'IPv6' },
    ]);
  });

  it('offers no LAN address when interface inspection is capability-denied', function () {
    for (const denied of [
      Object.assign(new Error('network interfaces are unavailable'), {
        code: 'ERR_ACCESS_DENIED', permission: 'os.networkInterfaces',
      }),
      Object.assign(new Error('uv_interface_addresses returned Unknown system error 1'), {
        code: 'ERR_SYSTEM_ERROR', syscall: 'uv_interface_addresses', errno: 1,
      }),
    ]) {
      assert.deepStrictEqual(
        listPhoneAccessInterfaces({ networkInterfaces: () => { throw denied; } }),
        [],
      );
    }
    assert.throws(
      () => listPhoneAccessInterfaces({ networkInterfaces: () => { throw Object.assign(new Error('interface probe broke'), { code: 'EIO' }); } }),
      /interface probe broke/,
    );
  });

  it('accepts an exact current address and rejects stale or unsafe addresses', function () {
    assert.deepStrictEqual(validatePhoneAccessAddress('fd12:3456:789a::12', interfaces), {
      name: 'wifi', address: 'fd12:3456:789a::12', family: 'IPv6',
    });
    for (const address of [
      '192.168.4.99', '127.9.8.7', '169.254.1.2', '0.0.0.0',
      '224.0.0.1', '8.8.8.8', '203.0.113.8', '2001:db8::12', '2606:4700:4700::1111',
      '::', '::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1',
    ]) {
      assert.throws(() => validatePhoneAccessAddress(address, interfaces), /private|current/);
    }
  });

  it('formats exact HTTPS origins for IPv4 and IPv6', function () {
    assert.strictEqual(DEFAULT_PHONE_ACCESS_PORT, 32354);
    assert.strictEqual(phoneAccessOrigin('192.168.4.12'), 'https://192.168.4.12:32354');
    assert.strictEqual(phoneAccessOrigin('fd12:3456:789a::12', 443), 'https://[fd12:3456:789a::12]');
    assert.throws(() => phoneAccessOrigin('192.168.4.12', 0), /port/);
    assert.throws(() => phoneAccessOrigin('192.168.4.12', 32354, 'http:'), /HTTPS/);
  });
});
