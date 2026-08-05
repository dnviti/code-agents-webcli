/** Public, deliberately secret-free description of a server a desktop controller can use. */
export type ServerConnectionStatus = 'connected' | 'connecting' | 'offline' | 'error' | 'unknown';
export type ServerAuthStatus = 'authenticated' | 'signed-out' | 'required' | 'unknown';
export type ServerCompatibilityStatus = 'compatible' | 'incompatible' | 'unknown';
export type ServerCertificateStatus = 'trusted' | 'untrusted' | 'overridden' | 'changed' | 'unknown';

export interface ServerTarget {
  id: string;
  name: string;
  /** Local targets have no user-editable remote address. */
  kind: 'local' | 'remote';
  /** HTTPS origin only; credentials, tokens and cookies are never part of this type. */
  origin?: string;
  connection: ServerConnectionStatus;
  auth: ServerAuthStatus;
  compatibility: ServerCompatibilityStatus;
  certificate: ServerCertificateStatus;
  certificateFingerprint?: string;
  lastContact?: string | number | null;
  capabilities?: string[];
  /** Human-safe status text suitable for an aria description. */
  statusDetail?: string;
  insecure?: boolean;
  canRetry?: boolean;
  canTest?: boolean;
  canSignIn?: boolean;
  canSignOut?: boolean;
  canEdit?: boolean;
  canRemove?: boolean;
  /** Unsaved certificate-blocked addition awaiting an explicit trust decision. */
  pendingAddition?: boolean;
  runningWorkCount?: number;
}

/** One shared fail-closed decision for every controller action surface. */
export function controllerTargetAvailability(
  target: Pick<ServerTarget, 'connection' | 'auth' | 'compatibility' | 'certificate'>,
): string | null {
  if (target.compatibility === 'incompatible') return 'Incompatible server';
  if (target.certificate === 'changed') return 'Certificate changed';
  if (target.certificate === 'untrusted') return 'Certificate not approved';
  if (target.connection === 'offline' || target.connection === 'error') return 'Server offline';
  if (target.connection === 'connecting') return 'Connecting';
  if (target.connection !== 'connected') return 'Availability unknown';
  if (target.auth === 'signed-out' || target.auth === 'required') return 'Sign-in required';
  if (target.auth !== 'authenticated') return 'Authentication status unknown';
  if (target.compatibility !== 'compatible') return 'Compatibility not verified';
  return null;
}

export interface DiscoveredServerCandidate {
  id: string;
  name: string;
  origin: string;
  certificateFingerprint?: string;
  statusDetail?: string;
  version?: string;
  protocolVersion?: number;
  capabilities?: string[];
  compatibility?: ServerCompatibilityStatus;
}
