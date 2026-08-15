import dgram from 'node:dgram';

import { CONTROLLER_PRODUCT_ID, CONTROLLER_PROTOCOL_VERSION } from '../../../sdk/contracts/controller.js';
import type { ServerIdentity } from './server-identity.js';

export const LAN_DISCOVERY_PORT = 32353;
export const LAN_DISCOVERY_PROBE = 'CODE_AGENTS_DISCOVERY/1';
export const LAN_DISCOVERY_MAX_PACKET_BYTES = 1024;

export interface UdpSocketLike {
  bind(port: number, address: string, callback?: () => void): void;
  close(callback?: () => void): void;
  on: {
    (event: 'message', listener: (message: Buffer, remote: dgram.RemoteInfo) => void): UdpSocketLike;
    (event: 'error', listener: (error: Error) => void): UdpSocketLike;
  };
  send(message: string | Buffer, port: number, address: string): void;
}

export interface LanDiscoveryResponderOptions {
  enabled: boolean;
  identity: ServerIdentity;
  port?: number;
  bindAddress?: string;
  createSocket?: () => UdpSocketLike;
  onError?: (error: Error) => void;
}

/** A responder, never a scanner: it creates no traffic until it receives the exact probe. */
export class LanDiscoveryResponder {
  private socket: UdpSocketLike | null = null;
  private readonly options: LanDiscoveryResponderOptions;

  constructor(options: LanDiscoveryResponderOptions) {
    this.options = options;
  }

  get started(): boolean {
    return this.socket !== null;
  }

  start(): void {
    if (!this.options.enabled || this.socket) return;
    const socket: UdpSocketLike = this.options.createSocket
      ? this.options.createSocket()
      : dgram.createSocket('udp4');
    socket.on('error', (error) => this.options.onError?.(error));
    socket.on('message', (message, remote) => {
      if (!isLanDiscoveryProbe(message)) return;
      socket.send(JSON.stringify({ type: 'CODE_AGENTS_IDENTITY/1', identity: this.options.identity }), remote.port, remote.address);
    });
    socket.bind(this.options.port ?? LAN_DISCOVERY_PORT, this.options.bindAddress ?? '0.0.0.0');
    this.socket = socket;
  }

  stop(): void {
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }
}

/** Strict parsing avoids turning this unauthenticated port into a general UDP reflector. */
export function isLanDiscoveryProbe(message: Buffer): boolean {
  return message.length === Buffer.byteLength(LAN_DISCOVERY_PROBE)
    && message.length <= LAN_DISCOVERY_MAX_PACKET_BYTES
    && message.toString('utf8') === LAN_DISCOVERY_PROBE;
}

export function parseLanDiscoveryResponse(message: Buffer): ServerIdentity | null {
  if (message.length > LAN_DISCOVERY_MAX_PACKET_BYTES) return null;
  try {
    const parsed = JSON.parse(message.toString('utf8')) as { type?: unknown; identity?: unknown };
    return parsed.type === 'CODE_AGENTS_IDENTITY/1' && isServerIdentity(parsed.identity)
      ? parsed.identity
      : null;
  } catch {
    return null;
  }
}

function isServerIdentity(value: unknown): value is ServerIdentity {
  if (!value || typeof value !== 'object') return false;
  const identity = value as Record<string, unknown>;
  const product = identity.product as Record<string, unknown> | null;
  return product?.id === CONTROLLER_PRODUCT_ID
    && product.name === 'CODE AGENTS'
    && typeof identity.version === 'string'
    && identity.protocolVersion === CONTROLLER_PROTOCOL_VERSION
    && Array.isArray(identity.capabilities) && identity.capabilities.every((capability) => typeof capability === 'string')
    && typeof identity.serverName === 'string'
    && typeof identity.address === 'string';
}
