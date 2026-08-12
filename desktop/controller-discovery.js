'use strict';

const dgram = require('node:dgram');
const os = require('node:os');

const DEFAULT_SCAN_TIMEOUT_MS = 1500;
const MIN_SCAN_TIMEOUT_MS = 100;
const MAX_SCAN_TIMEOUT_MS = 10_000;

function ipv4Number(address) {
  const parts = String(address).split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = ((value << 8) | octet) >>> 0;
  }
  return value;
}

function ipv4String(value) {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.');
}

/** Directed broadcasts reach LANs that discard the all-hosts broadcast. */
/**
 * Sandboxed desktop hosts can deny Node's network-interface capability.  LAN
 * discovery remains useful there: the limited broadcast is still valid, it
 * just cannot add directed broadcasts for interfaces we cannot inspect.
 */
function networkInterfacesOrEmpty(networkInterfaces = os.networkInterfaces) {
  try {
    return typeof networkInterfaces === 'function' ? networkInterfaces() : networkInterfaces;
  } catch (error) {
    if (isNetworkInterfacesCapabilityDenied(error)) return {};
    throw error;
  }
}

function isNetworkInterfacesCapabilityDenied(error) {
  return error?.code === 'ERR_ACCESS_DENIED'
    // Node's managed sandbox currently exposes the same denied capability as
    // libuv's EPERM-shaped system error rather than ERR_ACCESS_DENIED.
    || (error?.code === 'ERR_SYSTEM_ERROR'
      && error?.syscall === 'uv_interface_addresses'
      && Number(error?.errno) === 1);
}

function broadcastAddresses(interfaces = os.networkInterfaces) {
  const snapshot = networkInterfacesOrEmpty(interfaces);
  const addresses = new Set(['255.255.255.255']);
  for (const entries of Object.values(snapshot || {})) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      const address = ipv4Number(entry.address);
      const mask = ipv4Number(entry.netmask);
      if (address === null || mask === null) continue;
      addresses.add(ipv4String((address | (~mask >>> 0)) >>> 0));
    }
  }
  return [...addresses];
}

function scanTimeout(value) {
  if (value === undefined) return DEFAULT_SCAN_TIMEOUT_MS;
  if (!Number.isFinite(value)) throw new TypeError('Discovery timeout must be finite');
  return Math.max(MIN_SCAN_TIMEOUT_MS, Math.min(MAX_SCAN_TIMEOUT_MS, Math.round(value)));
}

/**
 * Perform one user-requested scan.
 *
 * Merely constructing/importing this module creates no socket and sends no
 * traffic.  Callers wire this function only to the Settings "Find servers"
 * action; every returned identity is still untrusted until normal HTTPS
 * verification succeeds.
 */
function findLanServers(options = {}) {
  const {
    probe,
    parseResponse,
    port,
    createSocket = () => dgram.createSocket({ type: 'udp4', reuseAddr: true }),
    addresses = broadcastAddresses(),
    timeoutMs = DEFAULT_SCAN_TIMEOUT_MS,
    signal,
  } = options;
  if (typeof probe !== 'string' || !probe) throw new TypeError('A discovery probe is required');
  if (typeof parseResponse !== 'function') throw new TypeError('A discovery parser is required');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError('A valid discovery UDP port is required');
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new TypeError('At least one discovery broadcast address is required');
  }
  const duration = scanTimeout(timeoutMs);

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new Error('Discovery was cancelled'));
      return;
    }

    const socket = createSocket();
    const found = new Map();
    let settled = false;
    let timer = null;

    const close = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      try { socket.close(); } catch { /* already closed */ }
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      close();
      resolve([...found.values()].sort((left, right) =>
        String(left.serverName).localeCompare(String(right.serverName))));
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      close();
      reject(error);
    };
    const onAbort = () => fail(signal.reason || new Error('Discovery was cancelled'));

    socket.on('error', fail);
    socket.on('message', (message, remote) => {
      let identity;
      try {
        identity = parseResponse(message);
      } catch {
        return;
      }
      if (!identity || typeof identity.address !== 'string') return;
      // The datagram is only a candidate, never authority. Keep the sender for
      // a useful review hint, but HTTPS verification trusts only identity.address.
      found.set(identity.address, { ...identity, discoveredFrom: remote.address });
    });
    socket.bind(0, '0.0.0.0', () => {
      if (settled) return;
      try {
        socket.setBroadcast(true);
        for (const address of new Set(addresses)) socket.send(probe, port, address);
        timer = setTimeout(finish, duration);
      } catch (error) {
        fail(error);
      }
    });
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

module.exports = {
  DEFAULT_SCAN_TIMEOUT_MS,
  MAX_SCAN_TIMEOUT_MS,
  MIN_SCAN_TIMEOUT_MS,
  broadcastAddresses,
  findLanServers,
  ipv4Number,
  ipv4String,
  networkInterfacesOrEmpty,
  scanTimeout,
};
