import type { DiscoveredServerCandidate, ServerTarget } from './types';

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
      : value.protocolVersion === 1 || connected ? 'compatible' : 'unknown',
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

function storedServerId(): string | null {
  try { return localStorage.getItem(LAST_SERVER_KEY); } catch { return null; }
}

function rememberServerId(serverId: string): void {
  try { localStorage.setItem(LAST_SERVER_KEY, serverId); } catch { /* private storage can be unavailable */ }
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
  const remembered = storedServerId();
  const selected = targets.some((target) => target.id === remembered)
    ? remembered
    : targets.find((target) => target.connection === 'connected')?.id
      || targets[0]?.id
      || null;
  publish({ enabled: true, targets, selectedServerId: selected, candidates: snapshot.candidates });
  if (selected) rememberServerId(selected);
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
  rememberServerId(serverId);
  publish({ ...snapshot, selectedServerId: serverId });
}

export function lastNewSessionServerId(): string | null {
  try {
    const serverId = localStorage.getItem(LAST_NEW_SESSION_SERVER_KEY);
    return serverId && snapshot.targets.some((target) => target.id === serverId) ? serverId : null;
  } catch {
    return null;
  }
}

export function rememberNewSessionServer(serverId: string): void {
  if (!snapshot.targets.some((target) => target.id === serverId)) return;
  try { localStorage.setItem(LAST_NEW_SESSION_SERVER_KEY, serverId); } catch { /* private storage can be unavailable */ }
}

export function parseQualifiedSessionId(value: string): { serverId: string; sessionId: string } | null {
  if (!value.startsWith('ccs1.')) return null;
  try {
    const encoded = value.slice(5).replaceAll('-', '+').replaceAll('_', '/');
    const padding = '='.repeat((4 - encoded.length % 4) % 4);
    const bytes = Uint8Array.from(atob(encoded + padding), (character) => character.charCodeAt(0));
    const decoded = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (
      !Array.isArray(decoded)
      || decoded.length !== 2
      || typeof decoded[0] !== 'string'
      || !decoded[0]
      || typeof decoded[1] !== 'string'
      || !decoded[1]
    ) return null;
    return { serverId: decoded[0], sessionId: decoded[1] };
  } catch {
    return null;
  }
}

function serverFromUrl(input: RequestInfo | URL): string | null {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  let url;
  try { url = new URL(raw, location.origin); } catch { return null; }
  const match = /^\/api\/(?:sessions|workspace)\/([^/]+)/.exec(url.pathname);
  if (!match) return null;
  let id;
  try { id = decodeURIComponent(match[1]); } catch { return null; }
  return parseQualifiedSessionId(id)?.serverId || null;
}

function routeNeedsTarget(input: RequestInfo | URL): boolean {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  let pathname;
  try { pathname = new URL(raw, location.origin).pathname; } catch { return false; }
  return pathname.startsWith('/api/')
    && !pathname.startsWith('/api/controller/')
    && pathname !== '/api/sessions/list';
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

export const controllerActions = {
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
          : protocolVersion === 1 ? 'compatible'
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
