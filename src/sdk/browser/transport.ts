import { CONTROLLER_PROTOCOL_VERSION, parseQualifiedSessionId } from '../contracts/controller.js';
import type { DiscoveredServerCandidate, PhoneAccessStatus, ServerTarget } from './types.js';

export { parseQualifiedSessionId };

const TARGET_HEADER = 'x-controller-server-id';
const LAST_SERVER_KEY = 'code-agents-controller-last-server';
const LAST_NEW_SESSION_SERVER_KEY = 'code-agents-controller-last-new-session-server';

interface PublicControllerTarget {
  id: string;
  type?: 'local' | 'remote';
  name: string;
  origin?: string;
  status?: string;
  insecure?: boolean;
  signedIn?: boolean;
  version?: string;
  protocolVersion?: number;
  capabilities?: string[];
  certificateFingerprint?: string;
  runningWorkCount?: number;
  stagedAddition?: boolean;
  lastSuccessfulContact?: string | number;
  error?: {
    code?: string;
    message?: string;
    category?: string;
    fingerprint256?: string;
    requiresRenewedApproval?: boolean;
    certificate?: { fingerprint256?: string };
  };
}

interface ControllerBootstrap {
  desktopController?: boolean;
  targets?: PublicControllerTarget[];
}

export interface ControllerSnapshot {
  enabled: boolean;
  targets: ServerTarget[];
  selectedServerId: string | null;
  candidates: DiscoveredServerCandidate[];
}

const listeners = new Set<() => void>();
let snapshot: ControllerSnapshot = {
  enabled: false,
  targets: [],
  selectedServerId: null,
  candidates: [],
};

function publish(next: ControllerSnapshot): void {
  if (JSON.stringify(snapshot) === JSON.stringify(next)) return;
  snapshot = next;
  for (const listener of listeners) listener();
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('cc-controller-changed'));
}

function connectionStatus(value: string | undefined): ServerTarget['connection'] {
  if (value === 'connected' || value === 'ready') return 'connected';
  if (value === 'connecting' || value === 'disconnected') return 'connecting';
  if (value === 'offline' || value === 'authentication-required' || value === 'certificate-error') return 'offline';
  if (value === 'error') return 'error';
  return 'unknown';
}

export function mapControllerTarget(value: PublicControllerTarget): ServerTarget {
  const certificateChanged = value.error?.code === 'TLS_CERTIFICATE_CHANGED'
    || value.error?.requiresRenewedApproval === true;
  const certificateError = value.error?.code === 'TLS_CERTIFICATE';
  const authenticated = value.id === 'local' || value.signedIn === true;
  const connected = connectionStatus(value.status) === 'connected';
  const pendingAddition = value.stagedAddition === true;
  return {
    id: value.id,
    name: value.name,
    kind: value.type === 'remote' ? 'remote' : 'local',
    ...(value.origin ? { origin: value.origin } : {}),
    connection: connectionStatus(value.status),
    auth: value.status === 'authentication-required' ? 'required'
      : authenticated ? 'authenticated' : 'signed-out',
    compatibility: value.error?.code === 'UNSUPPORTED_PROTOCOL' || value.error?.code === 'INCOMPATIBLE_RESPONSE'
      ? 'incompatible'
      : value.protocolVersion === CONTROLLER_PROTOCOL_VERSION || connected ? 'compatible' : 'unknown',
    certificate: certificateChanged ? 'changed'
      : certificateError ? 'untrusted'
        : value.insecure ? 'overridden'
          : connected ? 'trusted' : 'unknown',
    certificateFingerprint: certificateChanged || certificateError
      ? value.error?.fingerprint256 || value.error?.certificate?.fingerprint256
      : value.certificateFingerprint
        || value.error?.fingerprint256
        || value.error?.certificate?.fingerprint256,
    lastContact: value.lastSuccessfulContact,
    capabilities: value.capabilities,
    statusDetail: value.error?.message,
    insecure: value.insecure === true,
    canRetry: value.id !== 'local' && !connected,
    canTest: value.id !== 'local' && !pendingAddition,
    canSignIn: value.id !== 'local' && !authenticated,
    canSignOut: value.id !== 'local' && authenticated,
    canEdit: value.id !== 'local' && !pendingAddition,
    canRemove: value.id !== 'local',
    pendingAddition,
    runningWorkCount: value.runningWorkCount,
  };
}

function readStorage(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writeStorage(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* private storage can be unavailable */ }
}

async function readBootstrap(): Promise<ControllerBootstrap | null> {
  try {
    const response = await fetch('/api/controller/bootstrap', {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return null;
    return await response.json() as ControllerBootstrap;
  } catch {
    return null;
  }
}

export async function initializeController(): Promise<ControllerSnapshot> {
  const bootstrap = await readBootstrap();
  if (bootstrap?.desktopController !== true || !Array.isArray(bootstrap.targets)) return snapshot;
  const targets = bootstrap.targets.map(mapControllerTarget);
  const remembered = readStorage(LAST_SERVER_KEY);
  const selected = targets.some((target) => target.id === remembered)
    ? remembered
    : targets.find((target) => target.connection === 'connected')?.id
      || targets[0]?.id
      || null;
  publish({ enabled: true, targets, selectedServerId: selected, candidates: snapshot.candidates });
  if (selected) writeStorage(LAST_SERVER_KEY, selected);
  return snapshot;
}

export function getControllerSnapshot(): ControllerSnapshot {
  return snapshot;
}

export function subscribeController(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function selectControllerServer(serverId: string): void {
  if (!snapshot.enabled || !snapshot.targets.some((target) => target.id === serverId)) {
    throw new RangeError(`Unknown controller server: ${serverId}`);
  }
  if (snapshot.selectedServerId === serverId) return;
  writeStorage(LAST_SERVER_KEY, serverId);
  publish({ ...snapshot, selectedServerId: serverId });
}

export function lastNewSessionServerId(): string | null {
  const serverId = readStorage(LAST_NEW_SESSION_SERVER_KEY);
  return serverId && snapshot.targets.some((target) => target.id === serverId) ? serverId : null;
}

export function rememberNewSessionServer(serverId: string): void {
  if (!snapshot.targets.some((target) => target.id === serverId)) return;
  writeStorage(LAST_NEW_SESSION_SERVER_KEY, serverId);
}

function requestPath(input: RequestInfo | URL): string | null {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  try { return new URL(raw, location.origin).pathname; } catch { return null; }
}

function serverFromUrl(input: RequestInfo | URL): string | null {
  const match = /^\/api\/(?:sessions|workspace)\/([^/]+)/.exec(requestPath(input) || '');
  if (!match) return null;
  let id;
  try { id = decodeURIComponent(match[1]); } catch { return null; }
  return parseQualifiedSessionId(id)?.serverId || null;
}

function routeNeedsTarget(input: RequestInfo | URL): boolean {
  const pathname = requestPath(input);
  return Boolean(pathname?.startsWith('/api/')
    && !pathname.startsWith('/api/controller/')
    && pathname !== '/api/sessions/list');
}

export async function controllerFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  explicitServerId?: string | null,
): Promise<Response> {
  if (!snapshot.enabled || !routeNeedsTarget(input)) return fetch(input, init);
  const serverId = explicitServerId || serverFromUrl(input) || snapshot.selectedServerId;
  if (!serverId) throw new Error('Choose a server before using this feature.');
  const headers = new Headers(init.headers);
  const existing = headers.get(TARGET_HEADER);
  if (existing && existing !== serverId) throw new Error('The request names conflicting target servers.');
  headers.set(TARGET_HEADER, serverId);
  const response = await fetch(input, { ...init, headers, credentials: init.credentials || 'same-origin' });
  if (response.status === 401) await initializeController();
  return response;
}

async function controllerAction(
  path: string,
  method: 'POST' | 'PATCH' | 'DELETE' = 'POST',
  body: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof result.message === 'string' ? result.message : 'The controller action failed.');
  await initializeController();
  return result;
}

function string(value: unknown): string | undefined { return typeof value === 'string' && value ? value : undefined; }
function phoneAccessStatus(value: unknown): PhoneAccessStatus {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const state = source.state;
  const interfaces = Array.isArray(source.interfaces) ? source.interfaces.flatMap((item) => {
    const row = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const name = string(row.name); const address = string(row.address);
    return name && address ? [{ name, address, family: string(row.family), origin: string(row.origin) }] : [];
  }) : [];
  const devices = Array.isArray(source.devices) ? source.devices.flatMap((item) => {
    const row = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const id = string(row.id); return id ? [{ id, label: string(row.label), origin: string(row.origin), lastSeen: typeof row.lastSeen === 'string' || typeof row.lastSeen === 'number' ? row.lastSeen : undefined }] : [];
  }) : [];
  const originsValue = source.origins && typeof source.origins === 'object' ? source.origins as Record<string, unknown> : {};
  const pairingValue = source.pairing && typeof source.pairing === 'object' ? source.pairing as Record<string, unknown> : {};
  const caValue = source.ca && typeof source.ca === 'object' ? source.ca as Record<string, unknown> : {};
  const tailscaleValue = source.tailscale && typeof source.tailscale === 'object' ? source.tailscale as Record<string, unknown> : {};
  return {
    state: state === 'off' || state === 'starting' || state === 'running' || state === 'error' ? state : 'unavailable',
    available: source.available === true,
    mode: source.mode === 'lan' || source.mode === 'tailscale' || source.mode === 'both' ? source.mode : undefined,
    port: typeof source.port === 'number' && Number.isInteger(source.port) && source.port > 0 && source.port < 65536 ? source.port : undefined,
    interfaces, origins: { lan: string(originsValue.lan), tailscale: string(originsValue.tailscale) },
    pairing: string(pairingValue.url) ? { url: string(pairingValue.url)!, expiresAt: typeof pairingValue.expiresAt === 'string' || typeof pairingValue.expiresAt === 'number' ? pairingValue.expiresAt : undefined, origin: string(pairingValue.origin) } : undefined,
    devices, ca: string(caValue.downloadUrl) || string(caValue.fingerprint) ? { downloadUrl: string(caValue.downloadUrl), fingerprint: string(caValue.fingerprint) } : undefined,
    tailscale: Object.keys(tailscaleValue).length ? { installed: tailscaleValue.installed === true, online: tailscaleValue.online === true, serve: tailscaleValue.serve === true, funnel: tailscaleValue.funnel === true, origin: string(tailscaleValue.origin), message: string(tailscaleValue.message) } : undefined,
    error: string(source.error) || string((source.error as Record<string, unknown> | undefined)?.message),
  };
}

async function phoneAction(path: string, method: 'POST' | 'DELETE' = 'POST', body: Record<string, unknown> = {}): Promise<PhoneAccessStatus> {
  const result = await controllerAction(path, method, body);
  // New controller builds return the whole status here. Older builds return a
  // small acknowledgement (for example `{ revoked: true }`), so refresh rather
  // than replacing a useful running view with an invented unavailable state.
  if (result.phoneAccess || typeof result.state === 'string') return phoneAccessStatus(result.phoneAccess ?? result);
  return readPhoneAccessStatus();
}

async function readPhoneAccessStatus(): Promise<PhoneAccessStatus> {
  const response = await fetch('/api/controller/phone-access', { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error('Phone access status could not be read.');
  return phoneAccessStatus(result);
}

async function exportPhoneAccessCa(): Promise<void> {
  const response = await fetch('/api/controller/phone-access/ca', {
    credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/x-x509-ca-cert' },
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({})) as Record<string, unknown>;
    throw new Error(typeof result.message === 'string' ? result.message : 'The CA certificate could not be exported.');
  }
  const href = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = href;
  link.download = 'code-agents-webcli-ca.crt';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 0);
}

export const controllerActions = {
  phoneAccessStatus: readPhoneAccessStatus,
  startPhoneAccess: (value: { mode: 'lan' | 'tailscale' | 'both'; address?: string; port: number }) => phoneAction('/api/controller/phone-access/start', 'POST', value),
  createPhonePairing: (origin?: string) => phoneAction('/api/controller/phone-access/pairing', 'POST', origin ? { origin } : {}),
  revokePhoneDevice: (id: string) => phoneAction(`/api/controller/phone-access/devices/${encodeURIComponent(id)}`, 'DELETE'),
  stopPhoneAccess: () => phoneAction('/api/controller/phone-access', 'DELETE'),
  exportPhoneAccessCa,
  checkTailscale: () => phoneAction('/api/controller/phone-access/tailscale/check'),
  setTailscaleOrigin: (origin: string) => phoneAction('/api/controller/phone-access/tailscale-origin', 'POST', { origin }),
  test: (value: { name?: string; origin?: string; serverId?: string }) => controllerAction('/api/controller/targets/test', 'POST', value),
  add: (value: { name: string; origin: string }) => controllerAction('/api/controller/targets', 'POST', value),
  update: (serverId: string, value: { name: string; origin?: string }) => controllerAction(`/api/controller/targets/${encodeURIComponent(serverId)}`, 'PATCH', value),
  retry: (serverId: string) => controllerAction(`/api/controller/targets/${encodeURIComponent(serverId)}/retry`),
  signIn: (serverId: string) => controllerAction(`/api/controller/targets/${encodeURIComponent(serverId)}/sign-in`),
  signOut: (serverId: string) => controllerAction(`/api/controller/targets/${encodeURIComponent(serverId)}/sign-out`),
  remove: (serverId: string, confirmRunning = false) => controllerAction(`/api/controller/targets/${encodeURIComponent(serverId)}`, 'DELETE', { confirmRunning }),
  approveCertificate: (serverId: string, fingerprint: string) => controllerAction(`/api/controller/targets/${encodeURIComponent(serverId)}/certificate`, 'POST', { fingerprint }),
  requireValidCertificate: (serverId: string) => controllerAction(`/api/controller/targets/${encodeURIComponent(serverId)}/certificate`, 'DELETE'),
  discover: async (): Promise<Record<string, unknown>> => {
    const result = await controllerAction('/api/controller/discover');
    const values = Array.isArray(result.candidates) ? result.candidates : [];
    const candidates = values.flatMap((candidate): DiscoveredServerCandidate[] => {
      if (!candidate || typeof candidate !== 'object') return [];
      const value = candidate as Record<string, unknown>;
      const name = typeof value.serverName === 'string' ? value.serverName
        : typeof value.name === 'string' ? value.name : '';
      const origin = typeof value.address === 'string' ? value.address
        : typeof value.origin === 'string' ? value.origin : '';
      if (!name || !origin) return [];
      const protocolVersion = Number.isInteger(value.protocolVersion) ? value.protocolVersion as number : undefined;
      return [{
        id: origin,
        name,
        origin,
        ...(typeof value.version === 'string' ? { version: value.version } : {}),
        ...(protocolVersion !== undefined ? { protocolVersion } : {}),
        ...(Array.isArray(value.capabilities)
          ? { capabilities: value.capabilities.filter((item): item is string => typeof item === 'string') }
          : {}),
        compatibility: typeof value.compatible === 'boolean'
          ? value.compatible ? 'compatible' : 'incompatible'
          : protocolVersion === CONTROLLER_PROTOCOL_VERSION ? 'compatible'
            : protocolVersion === undefined ? 'unknown' : 'incompatible',
        ...(typeof value.status === 'string' ? { statusDetail: value.status } : {}),
      }];
    });
    publish({ ...snapshot, candidates });
    return result;
  },
};

export function updateControllerStatus(
  serverId: string,
  status: string,
  message?: string,
  insecure?: boolean,
  lastSuccessfulContact?: string | number,
): void {
  if (!snapshot.enabled) return;
  const targets = snapshot.targets.map((target) => target.id === serverId ? {
    ...target,
    connection: connectionStatus(status),
    statusDetail: message || (status === 'connected' ? undefined : target.statusDetail),
    lastContact: lastSuccessfulContact
      ?? (status === 'connected' ? Date.now() : target.lastContact),
    insecure: insecure ?? target.insecure,
  } : target);
  publish({ ...snapshot, targets });
}
