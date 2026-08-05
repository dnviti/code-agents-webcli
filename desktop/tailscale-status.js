'use strict';

const { execFile } = require('node:child_process');

const DEFAULT_TAILSCALE_TIMEOUT_MS = 3000;
const DEFAULT_TAILSCALE_MAX_BYTES = 128 * 1024;
const MAX_TAILSCALE_TIMEOUT_MS = 10_000;
const MAX_TAILSCALE_BYTES = 1024 * 1024;

function boundedInteger(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new TypeError('Tailscale command limits must be positive');
  return Math.min(maximum, Math.max(1, Math.round(value)));
}

function runTailscale(execFileImpl, args, options) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, stdout = '') => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else {
        resolve(typeof stdout === 'string' ? stdout : stdout.toString('utf8'));
      }
    };

    try {
      const returned = execFileImpl('tailscale', args, options, finish);
      if (returned && typeof returned.then === 'function') {
        returned.then(
          (value) => finish(null, value?.stdout ?? value ?? ''),
          (error) => finish(error, error?.stdout || ''),
        );
      }
    } catch (error) {
      finish(error);
    }
  });
}

function parseJsonObject(text) {
  const value = JSON.parse(String(text));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Expected a JSON object');
  }
  return value;
}

function normalizeTailscaleDnsName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().toLowerCase().replace(/\.$/, '');
  if (name.length > 253 || !name.endsWith('.ts.net')) return null;
  const labels = name.split('.');
  if (labels.length < 3) return null;
  if (!labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  return name;
}

function serveProxyMatches(value, port) {
  const comparePort = Number.isInteger(port) && port >= 1 && port <= 65535;
  if (port !== undefined && !comparePort) return false;
  const handler = value?.Handlers && typeof value.Handlers === 'object'
    ? value.Handlers['/'] : null;
  if (!handler || typeof handler !== 'object' || typeof handler.Proxy !== 'string') return false;
  try {
    const target = new URL(handler.Proxy);
    return target.protocol === 'http:'
      && target.hostname === '127.0.0.1'
      && (!comparePort || Number(target.port || 80) === port)
      && target.pathname === '/'
      && !target.search
      && !target.hash
      && !target.username
      && !target.password;
  } catch {
    return false;
  }
}

function exactServeState(status, dnsName, port) {
  if (!status || typeof status !== 'object') return { serve: false, funnel: false, configured: false };
  const endpoint = `${dnsName}:443`;
  // `tailscale serve <port>` is foreground by default. Tailscale reports those
  // ephemeral configurations under ServeConfig.Foreground, while `--bg`
  // configurations remain at the top level. Inspect every active configuration
  // so the recommended foreground command works and a Funnel in either scope
  // can never be overlooked.
  const foreground = status.Foreground
    && typeof status.Foreground === 'object'
    && !Array.isArray(status.Foreground)
    ? Object.values(status.Foreground).filter((value) => (
      value && typeof value === 'object' && !Array.isArray(value)
    ))
    : [];
  const configs = [status, ...foreground];
  let configured = false;
  let serve = false;
  let funnel = false;
  for (const config of configs) {
    const web = config.Web && typeof config.Web === 'object' && !Array.isArray(config.Web)
      ? config.Web : {};
    const allowFunnel = config.AllowFunnel
      && typeof config.AllowFunnel === 'object'
      && !Array.isArray(config.AllowFunnel)
      ? config.AllowFunnel : {};
    configured ||= Object.prototype.hasOwnProperty.call(web, endpoint);
    serve ||= serveProxyMatches(web[endpoint], port);
    funnel ||= allowFunnel[endpoint] === true || allowFunnel[dnsName] === true;
  }
  return { serve, funnel, configured };
}

function absentError(error) {
  return error?.code === 'ENOENT' || error?.cause?.code === 'ENOENT';
}

/**
 * Inspect Tailscale without changing its state. Only the two documented JSON
 * status commands are executed, with a fixed executable and fixed arguments.
 */
async function inspectTailscale({
  execFileImpl = execFile,
  timeoutMs,
  maxBytes,
  port,
} = {}) {
  if (typeof execFileImpl !== 'function') throw new TypeError('A Tailscale command runner is required');
  const timeout = boundedInteger(timeoutMs, DEFAULT_TAILSCALE_TIMEOUT_MS, MAX_TAILSCALE_TIMEOUT_MS);
  const maxBuffer = boundedInteger(maxBytes, DEFAULT_TAILSCALE_MAX_BYTES, MAX_TAILSCALE_BYTES);
  const commandOptions = {
    encoding: 'utf8',
    maxBuffer,
    timeout,
    windowsHide: true,
    shell: false,
  };

  let status;
  try {
    status = parseJsonObject(await runTailscale(execFileImpl, ['status', '--json'], commandOptions));
  } catch (error) {
    if (absentError(error)) {
      return {
        installed: false,
        online: false,
        serve: false,
        funnel: false,
        origin: null,
        message: 'Tailscale is not installed.',
      };
    }
    return {
      installed: true,
      online: false,
      serve: false,
      funnel: false,
      origin: null,
      message: 'Tailscale is unavailable or offline.',
    };
  }

  const self = status.Self && typeof status.Self === 'object' ? status.Self : {};
  const online = status.BackendState === 'Running' && self.Online !== false;
  if (!online) {
    return {
      installed: true,
      online: false,
      serve: false,
      funnel: false,
      origin: null,
      message: 'Tailscale is installed but offline.',
    };
  }

  const dnsName = normalizeTailscaleDnsName(self.DNSName);
  if (!dnsName) {
    return {
      installed: true,
      online: true,
      serve: false,
      funnel: false,
      origin: null,
      message: 'Tailscale did not report a valid ts.net device name.',
    };
  }

  let serveStatus = null;
  try {
    serveStatus = parseJsonObject(await runTailscale(
      execFileImpl,
      ['serve', 'status', '--json'],
      commandOptions,
    ));
  } catch {
    // An absent Serve configuration commonly exits non-zero. Tailscale itself
    // is still online, so keep the useful device origin and report Serve off.
  }

  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new TypeError('The Tailscale backend port is invalid');
  }
  const { serve, funnel, configured } = exactServeState(serveStatus, dnsName, port);
  return {
    installed: true,
    online: true,
    serve,
    funnel,
    origin: `https://${dnsName}`,
    ...(!serve ? {
      message: configured && port
        ? `Tailscale Serve is not proxying to 127.0.0.1:${port}.`
        : 'Tailscale Serve is not configured for this device.',
    } : {}),
  };
}

module.exports = {
  DEFAULT_TAILSCALE_MAX_BYTES,
  DEFAULT_TAILSCALE_TIMEOUT_MS,
  MAX_TAILSCALE_BYTES,
  MAX_TAILSCALE_TIMEOUT_MS,
  exactServeState,
  inspectTailscale,
  normalizeTailscaleDnsName,
  parseJsonObject,
  runTailscale,
  serveProxyMatches,
};
