'use strict';

const net = require('node:net');
const os = require('node:os');

const DEFAULT_PHONE_ACCESS_PORT = 32354;

function canonicalIpAddress(address) {
  const value = String(address || '').trim().toLowerCase();
  const family = net.isIP(value);
  if (!family || value.includes('%')) return null;
  if (family === 4) return { address: value, family: 'IPv4' };
  try {
    return {
      address: new URL(`https://[${value}]`).hostname.replace(/^\[|\]$/g, ''),
      family: 'IPv6',
    };
  } catch {
    return null;
  }
}

function ipv4Octets(address) {
  return address.split('.').map(Number);
}

function mappedIpv4(address) {
  const match = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!match) return null;
  const high = Number.parseInt(match[1], 16);
  const low = Number.parseInt(match[2], 16);
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}

/**
 * True only for an address that is both host-specific and non-public. LAN
 * sharing must never turn a globally routed interface into an Internet-facing
 * command endpoint; outside-LAN access belongs behind Tailscale Serve.
 */
function isPhoneAccessUnicastAddress(address) {
  const parsed = canonicalIpAddress(address);
  if (!parsed) return false;

  if (parsed.family === 'IPv4') {
    const [first, second] = ipv4Octets(parsed.address);
    return first === 10
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      // RFC 6598 shared space, including Tailscale's IPv4 range. It is not
      // globally routable, though the guided Serve route remains preferred.
      || (first === 100 && second >= 64 && second <= 127);
  }

  const mapped = mappedIpv4(parsed.address);
  if (mapped) return isPhoneAccessUnicastAddress(mapped);
  const firstGroup = Number.parseInt(parsed.address.split(':')[0] || '0', 16);
  return (firstGroup & 0xfe00) === 0xfc00;
}

function interfaceFamily(entry) {
  if (entry?.family === 'IPv4' || entry?.family === 4) return 'IPv4';
  if (entry?.family === 'IPv6' || entry?.family === 6) return 'IPv6';
  return null;
}

/** Enumerate addresses currently assigned to non-internal interfaces. */
function listPhoneAccessInterfaces({ networkInterfaces = os.networkInterfaces } = {}) {
  const interfaces = typeof networkInterfaces === 'function'
    ? networkInterfaces() : networkInterfaces;
  const result = [];

  for (const [name, entries] of Object.entries(interfaces || {})) {
    for (const entry of entries || []) {
      if (!entry || entry.internal) continue;
      const parsed = canonicalIpAddress(entry.address);
      const family = interfaceFamily(entry);
      if (!parsed || !family || parsed.family !== family) continue;
      if (!isPhoneAccessUnicastAddress(parsed.address)) continue;
      result.push({ name, address: parsed.address, family });
    }
  }

  return result;
}

function entriesFromInterfaces(interfaces) {
  if (Array.isArray(interfaces)) return interfaces;
  if (interfaces === undefined) return listPhoneAccessInterfaces();
  return listPhoneAccessInterfaces({ networkInterfaces: interfaces });
}

/**
 * Resolve an address against the current interface snapshot. Supplying a stale,
 * wildcard, loopback, globally-routable, or otherwise unsafe address is
 * always an error.
 */
function validatePhoneAccessAddress(address, interfaces) {
  const wanted = canonicalIpAddress(address);
  if (!wanted || !isPhoneAccessUnicastAddress(wanted.address)) {
    throw new TypeError('LAN phone access requires a private, non-loopback IP address');
  }

  const found = entriesFromInterfaces(interfaces).find((entry) => {
    const candidate = canonicalIpAddress(entry?.address);
    const declaredFamily = interfaceFamily(entry);
    return candidate
      && entry?.internal !== true
      && (!declaredFamily || declaredFamily === candidate.family)
      && candidate.address === wanted.address
      && isPhoneAccessUnicastAddress(candidate.address);
  });
  if (!found) throw new TypeError('The phone access address is not assigned to a current network interface');
  return { ...found, address: wanted.address, family: wanted.family };
}

function phoneAccessOrigin(address, port = DEFAULT_PHONE_ACCESS_PORT, protocol = 'https:') {
  const parsed = canonicalIpAddress(address);
  if (!parsed || !isPhoneAccessUnicastAddress(parsed.address)) {
    throw new TypeError('LAN phone access requires a private, non-loopback IP address');
  }
  if (protocol !== 'https:') throw new TypeError('Phone access origins must use HTTPS');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError('The phone access port is invalid');
  }
  const host = parsed.family === 'IPv6' ? `[${parsed.address}]` : parsed.address;
  return `${protocol}//${host}${port === 443 ? '' : `:${port}`}`;
}

module.exports = {
  DEFAULT_PHONE_ACCESS_PORT,
  canonicalIpAddress,
  isPhoneAccessUnicastAddress,
  listPhoneAccessInterfaces,
  phoneAccessOrigin,
  validatePhoneAccessAddress,
};
