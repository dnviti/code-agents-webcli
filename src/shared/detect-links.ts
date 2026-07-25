/**
 * Servers the agent started, pulled out of what it printed.
 *
 * When an agent runs `npm run dev` the useful result is a URL, and in a browser
 * terminal that URL is unreachable text: it names `localhost` on the *server's*
 * machine, and this app is routinely opened from a phone or another laptop on
 * the LAN. So the address is not just detected, it is re-pointed at the host the
 * page was actually loaded from — which is the machine running the agent, since
 * that is where this server runs too.
 *
 * Scoped to things that look like a local development server. A general URL
 * scraper would turn every documentation link an agent quotes into a button
 * claiming an app is running there, which is worse than showing nothing.
 */

export interface DetectedLink {
  /** Ready to open from the browser: loopback rewritten to the page's host. */
  url: string;
  /** The address as it was printed, when that differs from `url`. */
  original: string;
  port: number;
  /** A short label, e.g. "localhost:5173". */
  label: string;
}

/**
 * Hosts that mean "this machine" from the server's point of view and nothing
 * useful from the browser's. `0.0.0.0` and `::` are bind-any addresses that are
 * not routable as destinations at all.
 */
const LOCAL_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '[::]',
  '[::1]',
  '::',
  '::1',
]);

/**
 * Ports that are a local app often enough to be worth a button, plus anything
 * above 1024 that a dev server would pick. Below that we would be offering to
 * open ssh and smtp.
 */
const MIN_PORT = 1024;
const MAX_PORT = 65535;

const URL_PATTERN = /\bhttps?:\/\/(\[[0-9a-fA-F:]+\]|[A-Za-z0-9._-]+)(?::(\d{2,5}))?(\/[^\s"'`)<>\]]*)?/g;

function isLocalHost(host: string): boolean {
  const lowered = host.toLowerCase();
  if (LOCAL_HOSTS.has(lowered)) return true;
  // A private-range address is the other common shape: a dev server told to
  // bind the LAN interface prints the machine's own 192.168/10./172.16-31 IP.
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(lowered);
}

/**
 * Rewrite a server-local address so the browser looking at this page can reach
 * it: same host we were served from, the port the agent announced.
 *
 * `pageHost` is a hostname without a port — the caller passes
 * `location.hostname`. Left alone when it is itself loopback, because then the
 * browser and the server really are the same machine and the printed address
 * was already right.
 */
export function rewriteForBrowser(url: string, pageHost: string): string {
  if (!pageHost) return url;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  const host = parsed.hostname.toLowerCase();
  const bindAny = host === '0.0.0.0' || host === '::' || host === '[::]';
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';

  // A bind-any address is never reachable as written, so it is rewritten even
  // when the page is on localhost. A loopback address only needs rewriting when
  // the browser is somewhere else.
  const pageIsLocal = pageHost === 'localhost' || pageHost === '127.0.0.1' || pageHost === '::1';
  if (!bindAny && (!loopback || pageIsLocal)) return url;

  parsed.hostname = pageHost;
  // The dev server is plain http far more often than not, and inheriting this
  // page's https would produce a link that fails the handshake. The scheme the
  // agent printed is the one it meant.
  return parsed.toString();
}

/**
 * Every distinct local server address in a block of text, most recent last.
 *
 * `pageHost` should be `location.hostname`; pass an empty string to skip the
 * rewrite (useful on the server, or in a test).
 */
export function detectServerLinks(text: string, pageHost = ''): DetectedLink[] {
  if (!text) return [];

  const found = new Map<string, DetectedLink>();
  URL_PATTERN.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = URL_PATTERN.exec(text)) !== null) {
    const [whole, host, portText] = match;
    if (!isLocalHost(host)) continue;

    const port = portText ? Number(portText) : whole.startsWith('https') ? 443 : 80;
    if (portText && (port < MIN_PORT || port > MAX_PORT)) continue;
    // No port at all only counts for a private-range host: a bare
    // "http://localhost" in prose is far more likely to be an example.
    if (!portText && LOCAL_HOSTS.has(host.toLowerCase())) continue;

    // Trailing punctuation from the surrounding text is not part of a URL.
    // The emphasis marks matter as much as the sentence punctuation: an agent
    // writing **http://localhost:5173/** is the common case, and carrying the
    // asterisks through produced a link to a path that does not exist.
    const cleaned = whole.replace(/[.,;:!?)\]}>'"*_`]+$/, '');
    const url = rewriteForBrowser(cleaned, pageHost);
    if (found.has(url)) continue;

    found.set(url, {
      url,
      original: cleaned,
      port,
      label: `${host}:${port}`,
    });
  }

  return Array.from(found.values());
}
