import type express from 'express';
import { CONTROLLER_PRODUCT_ID, CONTROLLER_PROTOCOL_VERSION } from '../../../sdk/contracts/controller.js';

export const SERVER_PRODUCT_ID = CONTROLLER_PRODUCT_ID;
export const SERVER_PRODUCT_NAME = 'CODE AGENTS';
export const SERVER_PROTOCOL_VERSION = CONTROLLER_PROTOCOL_VERSION;
/**
 * Public before authentication and repeated in a small UDP datagram. Keeping
 * this bounded leaves ample room beneath the 1024-byte discovery packet cap.
 */
export const SERVER_NAME_MAX_LENGTH = 120;

/**
 * The deliberately small public contract used before a client signs in.
 * Keep this separate from /api/config: that endpoint grows with the product,
 * whereas discovery must never grow into an inventory of a server's users or
 * work.
 */
export interface ServerIdentity {
  product: { id: typeof SERVER_PRODUCT_ID; name: typeof SERVER_PRODUCT_NAME };
  version: string;
  protocolVersion: typeof SERVER_PROTOCOL_VERSION;
  capabilities: readonly string[];
  serverName: string;
  address: string;
}

export interface ServerIdentityOptions {
  serverName: string;
  address: string;
  version: string;
}

/** Remove terminal/control characters and reject a name that has no visible text. */
export function normalizeServerName(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, '')
    .trim();
  if (!normalized) {
    throw new Error('Server name must contain at least one visible character.');
  }
  return normalized.slice(0, SERVER_NAME_MAX_LENGTH);
}

export function createServerIdentity(options: ServerIdentityOptions): ServerIdentity {
  return {
    product: { id: SERVER_PRODUCT_ID, name: SERVER_PRODUCT_NAME },
    version: options.version,
    protocolVersion: SERVER_PROTOCOL_VERSION,
    capabilities: ['remote-controller', 'lan-discovery'],
    serverName: normalizeServerName(options.serverName),
    address: options.address,
  };
}

/** Identity is intentionally unauthenticated so a controller can verify a URL before OAuth. */
export function registerServerIdentityRoute(app: express.Express, identity: ServerIdentity): void {
  app.get('/api/identity', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(identity);
  });
}

/** Return an origin-only HTTPS address suitable for another device to dial. */
export function normalizeDiscoverableAddress(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:'
      || url.username
      || url.password
      || url.pathname !== '/'
      || url.search
      || url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}
